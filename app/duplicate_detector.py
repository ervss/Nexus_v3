"""
Duplicate Detection Module
Uses perceptual hashing to find visually similar thumbnails
"""
import imagehash
from PIL import Image
import os
import logging
from sqlalchemy.orm import Session
from app.database import Video

def compute_phash(image_path: str) -> str:
    """Compute perceptual hash of an image"""
    try:
        if not os.path.exists(image_path):
            return None
        img = Image.open(image_path)
        hash_val = imagehash.phash(img)
        return str(hash_val)
    except Exception as e:
        logging.error(f"Failed to compute phash for {image_path}: {e}")
        return None

def _parse_hashes(hash_str: str) -> list:
    """Parse single or pipe-separated phash string into list of ImageHash objects."""
    if not hash_str:
        return []
    out = []
    for part in str(hash_str).split("|"):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(imagehash.hex_to_hash(part))
        except Exception:
            continue
    return out


def classify_duration_relation(dur_a: float | int | None, dur_b: float | int | None) -> dict:
    """Klasifikuje vzťah dvoch videí podľa dĺžky trvania, aby jeden rovnaký cover pri odlišnej dĺžke nespôsobil falošný merge."""
    a = float(dur_a or 0)
    b = float(dur_b or 0)
    if a <= 0 or b <= 0:
        return {
            "relation": "confirmed_version",
            "is_confirmed": True,
            "compare_only": False,
            "duration_diff": 0.0,
            "duration_ratio": 1.0,
        }
    diff = abs(a - b)
    ratio = min(a, b) / max(a, b)
    if diff <= 3.0 or (diff <= 15.0 and ratio >= 0.95):
        return {
            "relation": "confirmed_version",
            "is_confirmed": True,
            "compare_only": False,
            "duration_diff": round(diff, 1),
            "duration_ratio": round(ratio, 4),
        }
    if ratio >= 0.90 and diff <= 45.0:
        return {
            "relation": "near_duration_version",
            "is_confirmed": True,
            "compare_only": False,
            "duration_diff": round(diff, 1),
            "duration_ratio": round(ratio, 4),
        }
    relation = "probable_cut" if b < a else "full_recording"
    return {
        "relation": relation,
        "is_confirmed": False,
        "compare_only": True,
        "duration_diff": round(diff, 1),
        "duration_ratio": round(ratio, 4),
    }


def hamming_distance(hash1: str, hash2: str) -> int:
    """Calculate minimum hamming distance between two (single or multi-frame) hashes."""
    if not hash1 or not hash2:
        return 999
    try:
        list1 = _parse_hashes(hash1)
        list2 = _parse_hashes(hash2)
        if not list1 or not list2:
            return 999
        return min(h1 - h2 for h1 in list1 for h2 in list2)
    except Exception:
        return 999


def _build_duplicate_entry(original, duplicate, distance: int, dur_info: dict) -> dict:
    orig_h = getattr(original, "height", 0) or 0
    dup_h = getattr(duplicate, "height", 0) or 0
    relation = dur_info.get("relation", "confirmed_version")
    if dur_info.get("is_confirmed") and dup_h > orig_h > 0:
        relation = "upgrade_quality"
    return {
        'original_id': original.id,
        'original_title': original.title,
        'original_duration': getattr(original, 'duration', None),
        'original_height': orig_h,
        'duplicate_id': duplicate.id,
        'duplicate_title': duplicate.title,
        'duplicate_duration': getattr(duplicate, 'duration', None),
        'duplicate_height': dup_h,
        'similarity': round(100 - (distance / 64 * 100), 1) if distance > 0 else 100.0,
        'distance': distance,
        'relation': relation,
        'compare_only': bool(dur_info.get("compare_only", False)),
        'duration_diff': dur_info.get("duration_diff", 0.0),
        'duration_ratio': dur_info.get("duration_ratio", 1.0),
    }


def find_duplicates(db: Session, threshold: int = 5, batch_size: int = 1000, include_compare_candidates: bool = False):
    """
    Find duplicate videos based on perceptual hash similarity and duration consistency.
    Optimized for large datasets using batched processing to prevent OOM.
    Single cover match with mismatched duration is treated as compare_only (not confirmed duplicate).
    """
    duplicates = []
    
    total_count = db.query(Video).filter(
        Video.phash.isnot(None), 
        Video.duplicate_of.is_(None)
    ).count()
    
    if total_count == 0:
        return []
    
    logging.info(f"Processing {total_count} videos for duplicates in batches of {batch_size}")
    
    buckets = {}
    processed = 0
    
    while processed < total_count:
        batch = db.query(Video).filter(
            Video.phash.isnot(None), 
            Video.duplicate_of.is_(None)
        ).offset(processed).limit(batch_size).all()
        
        if not batch:
            break
            
        for video in batch:
            if video.phash not in buckets:
                buckets[video.phash] = []
            buckets[video.phash].append(video)
        
        processed += len(batch)
        logging.info(f"Processed {processed}/{total_count} videos")
        del batch
    
    processed_ids = set()
    
    # 1. Exact Matches (Same phash)
    for h, bucket in buckets.items():
        if len(bucket) > 1:
            bucket.sort(key=lambda v: v.id)
            original = bucket[0]
            for duplicate in bucket[1:]:
                dur_info = classify_duration_relation(
                    getattr(original, "duration", None),
                    getattr(duplicate, "duration", None),
                )
                if not dur_info["is_confirmed"] and not include_compare_candidates:
                    continue
                duplicates.append(_build_duplicate_entry(original, duplicate, 0, dur_info))
                if dur_info["is_confirmed"]:
                    processed_ids.add(duplicate.id)

    # 2. Near Matches (Only if threshold > 0)
    if threshold > 0:
        unique_hashes = list(buckets.keys())
        for i, h1 in enumerate(unique_hashes):
            for h2 in unique_hashes[i+1:]:
                distance = hamming_distance(h1, h2)
                if distance <= threshold:
                    v1 = buckets[h1][0]
                    v2 = buckets[h2][0]
                    
                    original = v1 if v1.id < v2.id else v2
                    other_bucket = buckets[h2] if v1.id < v2.id else buckets[h1]
                    
                    for duplicate in other_bucket:
                        if duplicate.id != original.id and duplicate.id not in processed_ids:
                            dur_info = classify_duration_relation(
                                getattr(original, "duration", None),
                                getattr(duplicate, "duration", None),
                            )
                            if not dur_info["is_confirmed"] and not include_compare_candidates:
                                continue
                            duplicates.append(_build_duplicate_entry(original, duplicate, distance, dur_info))
                            if dur_info["is_confirmed"]:
                                processed_ids.add(duplicate.id)
    
    return duplicates

def mark_as_duplicate(db: Session, duplicate_id: int, original_id: int):
    """Mark a video as duplicate of another"""
    duplicate = db.query(Video).get(duplicate_id)
    if duplicate:
        duplicate.duplicate_of = original_id
        db.commit()
        return True
    return False

def compute_all_phashes(db: Session, batch_size: int = 100):
    """
    Compute phashes for all videos that don't have one.
    Processes in batches and commits periodically to avoid long transactions.
    """
    total_count = db.query(Video).filter(
        Video.phash.is_(None), 
        Video.thumbnail_path.isnot(None)
    ).count()
    
    if total_count == 0:
        logging.info("No videos need phash computation")
        return 0
    
    logging.info(f"Computing phashes for {total_count} videos in batches of {batch_size}")
    
    count = 0
    processed = 0
    
    while processed < total_count:
        # Load batch
        videos = db.query(Video).filter(
            Video.phash.is_(None), 
            Video.thumbnail_path.isnot(None)
        ).limit(batch_size).all()
        
        if not videos:
            break
        
        # Process batch
        for video in videos:
            thumb_path = f"app{video.thumbnail_path.split('?')[0]}"  # Remove query params
            phash = compute_phash(thumb_path)
            if phash:
                video.phash = phash
                count += 1
        
        # Commit batch
        db.commit()
        processed += len(videos)
        logging.info(f"Computed phashes: {processed}/{total_count} ({count} successful)")
    
    logging.info(f"Completed: computed phashes for {count} videos")
    return count


def compute_discovered_video_phash_and_check_duplicate(db: Session, discovered, threshold: int = 5) -> bool:
    """
    Downloads the discovered video thumbnail, calculates its phash,
    updates the DiscoveredVideo row, checks the main videos table for near-duplicates,
    and marks duplicate_of if a match is found.
    """
    if not discovered or not discovered.thumbnail:
        return False
        
    try:
        import requests
        from io import BytesIO
        from PIL import Image
        import imagehash
        from app.database import Video

        # Resolve referer based on source
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        }
        if "camwhores" in (discovered.source or "").lower() or "camwhores" in (discovered.url or "").lower():
            headers["Referer"] = "https://www.camwhores.tv/"
            
        # Download thumbnail in-memory
        resp = requests.get(discovered.thumbnail, headers=headers, timeout=8, verify=False)
        if resp.status_code != 200:
            logging.debug(f"[PHASH_DISCOVERY] HTTP {resp.status_code} fetching thumbnail {discovered.thumbnail}")
            return False
            
        img = Image.open(BytesIO(resp.content))
        hash_val = imagehash.phash(img)
        phash_str = str(hash_val)
        
        discovered.phash = phash_str
        
        # Check against main videos table for near duplicates
        # (excluding duplicates themselves if any)
        h1 = imagehash.hex_to_hash(phash_str)
        
        # Fetch all main videos with a phash
        main_videos = db.query(Video).filter(
            Video.phash.isnot(None),
            Video.duplicate_of.is_(None)
        ).all()
        
        match_id = None
        for v in main_videos:
            try:
                dist = hamming_distance(phash_str, v.phash)
                if dist <= threshold:
                    dur_info = classify_duration_relation(
                        getattr(v, "duration", None),
                        getattr(discovered, "duration", None),
                    )
                    if not dur_info["is_confirmed"]:
                        logging.info(
                            f"[PHASH_DISCOVERY] Cover match for '{discovered.title}' vs video #{v.id}, "
                            f"but duration differs ({getattr(discovered, 'duration', None)}s vs {getattr(v, 'duration', None)}s) -> compare candidate only"
                        )
                        continue
                    match_id = v.id
                    logging.info(f"[PHASH_DISCOVERY] Found visual duplicate for discovered '{discovered.title}': matches main video #{v.id} ('{v.title}') with distance {dist}")
                    break
            except Exception:
                continue
                
        if match_id:
            discovered.duplicate_of = match_id
        else:
            discovered.duplicate_of = None
            
        return True
    except Exception as e:
        logging.warning(f"[PHASH_DISCOVERY] Error computing phash for discovered #{discovered.id}: {e}")
    return False

