"""Inteligentný plánovač dopytov, čistenie technických tagov a rozpoznávanie performerov pre Related Search."""
from __future__ import annotations

import base64
import json
import logging
import os
import re
import threading
import time
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple
from urllib.parse import urlparse

import httpx

from .autotagger import KNOWN_MODELS, auto_tag_video

logger = logging.getLogger(__name__)

# Technické, importné, doménové a formátové reťazce, ktoré NIKDY nesmú byť obsahovým tagom videa
_JUNK_METADATA_TAGS: Set[str] = {
    # Technické / importné značky rozšírení a hubov
    "extension", "selector", "extension selector", "selector extension",
    "discovery-hub", "discovery_hub", "discovery hub",
    "album-viewer", "album_viewer", "album viewer",
    "album-workspace", "album_workspace", "album workspace",
    "fusion-hub", "fusion_hub", "fusion hub",
    "nexus_album", "nexus-album", "nexus album",
    "generic_watch", "generic-watch", "generic watch",
    "linktester", "link-tester", "link tester", "quantum",
    "fast-import", "fast_import", "split-screen", "splitscreen",
    "clipboard", "manual", "import", "imported", "auto", "batch", "default",
    # Domény, úložiská a názvy stránok (patria do source, nie do tagov obsahu)
    "bunkr", "bunkrr", "bunkr.cr", "bunkr.la", "bunkr.si", "bunkr.su", "bunkr.is", "bunkr.pk",
    "balbums", "balbums.st", "filester", "filester.me", "fileditch", "fileditchfiles",
    "pixeldrain", "pixeldrain.com", "gofile", "gofile.io", "cyberdrop", "cyberdrop.me",
    "erome", "erome.com", "simpcity", "simpcity.cr", "simpcity.su", "coomer", "kemono",
    "pornhub", "pornhub.com", "xvideos", "xvideos.com", "xhamster", "xhamster.com",
    "eporner", "eporner.com", "spankbang", "spankbang.com", "porntrex", "porntrex.com",
    "whoreshub", "whoreshub.com", "camwhores", "camwhores.tv", "camwhoresbay",
    "faphouse", "faphouse.com", "pimpbunny", "pimpbunny.com", "noodlemagazine",
    "thothub", "showup", "baddiehub", "drtuber", "fpo", "fpo.xxx", "pornone", "redgifs",
    "onlyfans", "onlytarts", "fansly", "patreon", "manyvids", "chaturbate", "stripchat",
    "myfreecams", "bongacams", "livejasmin", "twitch", "youtube", "vk", "vk.com", "vkvideo",
    "telegram", "t.me", "reddit", "twitter", "instagram", "tiktok", "sxyprn", "leakporner",
    "lulustream", "vidara", "turbo", "turbo.cr", "djav", "hqporner", "beeg", "xnxx",
    # Formáty, rozlíšenia a všeobecné technické slová
    "4k", "2k", "8k", "1080p", "720p", "480p", "360p", "240p", "2160p", "1440p",
    "hd", "fhd", "uhd", "sd", "60fps", "60 fps", "30fps", "mp4", "mkv", "webm", "mov",
    "avi", "flv", "wmv", "m4v", "m3u8", "hls", "hevc", "x264", "x265", "h264", "h265",
    "hd-videos", "hd videos", "4k-porn", "4k porn", "4k4k porn", "4k4k", "hdhd 1080p",
    "free porn", "free porn›", "in-english", "english", "vertical",
    # Všeobecné prázdne slová a bezcenné AI vision štítky
    "video", "videos", "clip", "clips", "scene", "scenes", "movie", "movies",
    "show", "shows", "stream", "watch", "free", "full", "new", "best", "official",
    "part", "episode", "vol", "round", "collection", "album", "folder", "explore",
    "spoiler", "storage", "media", "source", "mythumbnail", "thumbnail", "unknown",
    "untitled", "download", "file", "files", "private", "public", "com", "www",
    "porn", "sex", "tape", "xxx", "nsfw", "sfw", "adult", "tag", "tags", "actor", "model",
    "text", "logo", "watermark", "caption", "font", "screenshot", "photo", "photos",
    "image", "picture", "person", "human", "people", "woman", "man", "female", "male",
    "girl", "boy", "lady", "guy", "clothing", "clothes", "apparel", "indoor", "indoors",
    "interior", "room", "the", "and", "with", "from", "for", "this", "that", "t",
}

_TITLE_STOPWORDS: Set[str] = _JUNK_METADATA_TAGS | {
    "on", "in", "at", "by", "of", "to", "is", "it", "my", "me", "her", "his", "you", "your",
    "dd", "rq", "ppv", "vip", "leaked", "leak", "leaks", "paid", "ver",
}

_NON_NAME_WORDS: Set[str] = {
    "huge", "fake", "tits", "boobs", "big", "small", "tiny", "ass", "butt",
    "dick", "cock", "pussy", "cum", "pov", "vertical", "deep", "sloppy",
    "rough", "extreme", "hot", "sexy", "naked", "nude", "horny", "wet",
    "tight", "young", "old", "mom", "mommy", "step", "sister", "brother",
    "dad", "stepmom", "stepsis", "stepsister", "stepbrother", "stepdad",
    "blonde", "brunette", "redhead", "latina", "argentinian", "italian",
    "british", "aussie", "australian", "russian", "czech", "french", "german",
    "asian", "ebony", "indian", "milf", "teen", "bimbo", "slut", "whore", "babe",
    "amateur", "homemade", "anal", "oral", "facial", "creampie", "blowjob",
    "titfuck", "handjob", "gangbang", "threesome", "foursome", "lesbian", "solo", "squirt",
    "hardcore", "softcore", "tease", "give", "gives", "suck", "fuck", "fucked", "lick",
    "throat", "deepthroat", "bbc", "interracial", "real", "broken", "first",
    "massive", "giant", "busty", "curvy", "petite", "skinny", "chubby",
    "oiled", "inked", "tattoo", "tattooed", "masked", "stunning", "passionate",
    "seduces", "fucks", "rides", "drilling", "army", "truck", "driver", "friend",
    "wife", "husband", "girlfriend", "boyfriend", "strangers", "doll", "natural",
    "las", "vegas", "new", "york", "los", "angeles", "miami", "dubai", "hotel",
    "marriott", "rockefeller", "center", "student", "experience", "talent",
    "your", "help", "sorority", "initiation", "makes", "imitation", "escorts",
    "female", "instagram", "account", "twitter", "profile", "pandesia", "world",
    "virtual", "vixen", "badoink", "badoinkvr", "casting", "couch", "dildo",
    "favourite", "favorite", "favourites", "favorites", "gifs", "gif", "lucky",
    "goth", "babes", "hungry", "toy", "used", "double", "collaboration", "collab",
    "between", "blowjobs", "actress", "actor", "answered", "solved", "daily",
}

_QUERY_NOISE_WORDS: Set[str] = {
    "love", "loves", "ride", "rides", "riding", "suck", "sucks", "sucking",
    "fuck", "fucks", "fucking", "fucked", "gets", "getting", "takes", "taking",
    "goes", "going", "makes", "making", "gives", "giving", "wants", "want",
    "absolutely", "built", "entitled", "broken", "unbreakable", "contract",
    "screams", "housewives", "central", "bimbo", "girl", "woman", "man",
}

_GENERIC_URL_SEGMENTS: Set[str] = {
    "videos", "video", "watch", "embed", "player", "stream", "media",
    "content", "uploads", "files", "view", "storage", "album", "albums",
    "folder", "gallery", "thumb", "thumbs", "tags", "tag", "categories",
    "category", "c", "f", "v", "a", "s", "d", "get_file", "search",
}

_STRONG_TAGS: Set[str] = {
    "interracial", "bbc", "milf", "anal", "pov", "blowjob", "creampie",
    "cumshot", "amateur", "lesbian", "threesome", "big tits", "busty",
    "asian", "latina", "ebony", "cosplay", "vr", "hardcore", "deepthroat",
    "facial", "redhead", "blonde", "brunette", "petite", "pawg", "bdsm",
    "fake tits", "bimbo", "squirt", "doggystyle", "doggy style", "cowgirl",
    "handjob", "titfuck", "gangbang", "foursome", "orgy", "cuckold", "femdom",
    "joi", "asmr", "lingerie", "tattoos", "big ass",
}

# Krátke dvojice slov, ktoré vyzerajú ako Capitalized, ale nie sú mená modeliek
_NON_NAME_PHRASES: Set[str] = {
    "sex tape", "full video", "real housewives", "bbc addicts", "bbc addict",
    "bimbo central", "contract scene", "unbreakable contract", "step sister",
    "step mom", "step daddy", "big tits", "big ass", "point of view", "home video",
    "my thumbnail", "hardcore teen", "hot girl", "cum inside", "las vegas",
    "your help", "initiation makes", "imitation videos", "female escorts",
    "instagram account", "twitter profile", "pandesia world", "bright idea",
    "truck driver", "british truck", "aussie fucks", "latina doll", "bimbo doll",
    "army drilling", "live show", "bedroom sex", "next door", "no nut",
    "office affairs", "yoga class", "new kind", "hot coffee", "free porn",
    "watch online", "only fans", "cam whores", "life selector", "picnic extension",
    "favourite gifs", "favorite gifs", "lucky guy", "sloppy blowjob", "goth babes",
    "cock hungry", "hungry toy", "double blowjob", "short hair",
}

# Statická mapa známych OnlyFans / Cam / Creator prezývok (handle -> kanonické meno)
_STATIC_HANDLE_TO_PERFORMER: Dict[str, str] = {
    "ssamibaby": "Sami Hayes",
    "ssamihayes": "Sami Hayes",
    "samihayes": "Sami Hayes",
    "sami_hayes": "Sami Hayes",
    "braceybella": "Bracey Bella",
    "bracey_bella": "Bracey Bella",
    "bimbosister": "Bracey Bella",
    "nicolettesheaxxx": "Nicolette Shea",
    "nicoletteshea": "Nicolette Shea",
    "nicollove": "Nicol Love",
    "nicollovee": "Nicol Love",
    "nicol_love": "Nicol Love",
    "selenablaze": "Selena Blaze",
    "selena_blaze": "Selena Blaze",
    "kristenhancher": "Kristen Hancher",
    "kristen_hancher": "Kristen Hancher",
    "tattiroana": "Tatti Roana",
    "tatti_roana": "Tatti Roana",
    "aliciaamira": "Alicia Amira",
    "alicia_amira": "Alicia Amira",
    "nasty_bimbo": "Alicia Amira",
    "nastybimbo": "Alicia Amira",
    "stefanieknight": "Stefanie Knight",
    "stefaniegurzanski": "Stefanie Gurzanski",
    "babygmag": "Stefanie Gurzanski",
    "foxymenagerie": "Foxy Menagerie",
    "bitcoinboobs": "Foxy Menagerie",
    "azulhermosa": "Azul Hermosa",
    "annapolina": "Anna Polina",
    "candikatty": "Candi Katty",
    "candykatty": "Candi Katty",
    "candy_katty": "Candi Katty",
    "rebeccamore": "Rebecca More",
    "rebeccamoore": "Rebecca Moore",
    "daisylee": "Daisy Lee",
    "marinamaya": "Marina Maya",
    "ruthlee": "Ruth Lee",
    "alannapow": "Alanna Pow",
    "aluraluxe": "Alura Luxe",
    "lexisstar": "Lexis Star",
    "reeserobbins": "Reese Robbins",
    "jennyferstone": "Jennyfer Stone",
    "francesbentley": "Frances Bentley",
    "rileyrae": "Riley Rae",
    "imbarbielu": "Barbie Lu",
    "barbielu": "Barbie Lu",
    "sladkislivki": "Sladkislivki",
    "onenympholatina": "Onenympholatina",
    "aliceredlips": "Alice Redlips",
    "chantalhussie": "Chantal Hussie",
    "chantaldanielle": "Chantal Danielle",
    "petrakaroshova": "Petra Karoshova",
    "petra_karoshova": "Petra Karoshova",
    "lisaevans": "Lisa Evans",
    "lisa_evans": "Lisa Evans",
    "kayleegunner": "Kaylee Gunner",
    "sarahjessie": "Sarah Jessie",
    "courtneytillia": "Courtney Tillia",
    "danaemari": "Danae Mari",
    "jakknife": "Jak Knife",
    "lilsyourfav": "Lila Geller",
    "lila_geller": "Lila Geller",
    "lilageller": "Lila Geller",
    "kenziee_jayy": "Kenziee Jayy",
    "kenzieejayy": "Kenziee Jayy",
    "myleloo": "Myleloo",
    "thelatbarbie": "Thelatbarbie",
    "supermolly777": "Supermolly777",
    "supermolly": "Supermolly777",
    "mukydza": "Anna Mukydza",
    "annamukydza": "Anna Mukydza",
    "anna_mukydza": "Anna Mukydza",
    "sukuboverlord": "Sukuboverlord",
    "milanasw": "Milana Sw",
    "milana_sw": "Milana Sw",
    "alexblake": "Alex Blake",
    "jayesummers": "Jaye Summers",
    "myviciouscrush": "Meg Vicious",
    "megvicious": "Meg Vicious",
    "meg_vicious": "Meg Vicious",
    "emmafiore": "Emma Fiore",
    "emma_fiore": "Emma Fiore",
}

# Ďalší známi tvorcovia mimo základného autotagger zoznamu
_EXTRA_KNOWN_PERFORMERS: Set[str] = {
    "sami hayes", "nicol love", "tatti roana", "selena blaze", "bracey bella",
    "kristen hancher", "nicolette shea", "alicia amira", "stefanie knight",
    "stefanie gurzanski", "foxy menagerie", "azul hermosa", "rebecca more",
    "rebecca moore", "riley rae", "jennyfer stone", "frances bentley",
    "anna polina", "candi katty", "daisy lee", "marina maya", "ruth lee",
    "alanna pow", "alura luxe", "lexis star", "reese robbins", "lulu love",
    "holly molly", "irina cage", "josie rae", "nadine kerastas", "damion dayski",
    "maximo garcia", "kenia music", "brian evansx", "jordan millicent",
    "tia maria", "angel luv", "reagan foxx", "amber campisi", "kali roses",
    "bella winters", "chantal hussie", "chantal danielle", "barbie lu",
    "alice redlips", "bella raven", "rebekah umbrafey", "cindy sun",
    "emma starletto", "kim cashian", "danae mari", "yenifer chacon",
    "victoria nova", "dixie lynn", "natalia queen", "maddy black",
    "roxi keogh", "courtney tillia", "evelin stone", "rosie rider",
    "katrin star", "mila amora", "mia kay", "princess jas", "emily walters",
    "kate koss", "sara retali", "isabel moon", "dolly dyson", "nuria millan",
    "meg vicious", "emma fiore", "bastian blanc", "bob big tula",
}

_LEXICON_LOCK = threading.Lock()
_LEXICON_CACHE: Dict[str, Any] = {
    "ts": 0.0,
    "by_phrase": {},     # lowercase spaced -> Canonical Name
    "by_compact": {},    # lowercase alphanumeric -> Canonical Name
    "aliases_for": {},   # lowercase canonical -> List[handle]
}


def split_csv(value: Optional[str]) -> List[str]:
    """Rozdelí zoznam oddelený čiarkou alebo bodkočiarkou bez prázdnych prvkov."""
    if not value:
        return []
    return [item.strip() for item in re.split(r"[,;|]+", str(value)) if item and item.strip()]


def _compact_alnum(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def split_camel_case_words(text: str) -> str:
    """Rozdelí CamelCase mená (napr. 'DDXSelenaBlazeArmyDrilling' -> 'DDX Selena Blaze Army Drilling')."""
    if not text:
        return ""
    # Medzera medzi malým a veľkým písmenom ("SelenaBlaze" -> "Selena Blaze")
    s = re.sub(r"([a-z]{2,})([A-Z][a-z]{2,})", r"\1 \2", text)
    # Medzera medzi prefixom z veľkých písmen a slovom ("DDXSelena" -> "DDX Selena")
    s = re.sub(r"([A-Z]{2,})([A-Z][a-z]{2,})", r"\1 \2", s)
    return s


def is_junk_or_hash_token(text: str) -> bool:
    """Rozpozná technické ID, UUID, hex/base62 hashe (napr. ZuRLHaMM6OFjA), dátumy a bezcenné tokeny."""
    raw = (text or "").strip()
    if not raw:
        return True
    low = raw.lower()
    if low in _TITLE_STOPWORDS or low in _GENERIC_URL_SEGMENTS or low in _JUNK_METADATA_TAGS:
        return True

    compact = re.sub(r"[_\-\.\s]+", "", raw)
    if len(compact) < 3:
        return True

    # Čisté čísla (napr. Telegram ID "7746555611816")
    if compact.isdigit():
        return True

    # Rozlíšenia a FPS (napr. "1080p", "4k4k", "60fps")
    if re.fullmatch(r"(?:\d{3,4}p|\d+k)+|\d+fps", compact, re.I):
        return True

    # UUID alebo dlhý hex reťazec (napr. "48Fefdf7Cdb6E0Bc", "316c46e0-8ce6-4489-93f3-7a4d81c445a5")
    if re.fullmatch(r"[0-9a-f]{8,}", compact, re.I):
        return True
    if re.search(r"[0-9a-f]{8,}", compact, re.I) and sum(c.isdigit() for c in compact) >= 3:
        return True

    # Jednoslovný token bez medzier: kontrola na base62 / náhodné ID (napr. "ZuRLHaMM6OFjA", "h61prVbD", "0hhpirsk6mua5mleebx0x")
    if " " not in raw:
        digits = sum(c.isdigit() for c in compact)
        if len(compact) >= 6 and digits / len(compact) >= 0.25:
            return True
        if len(compact) >= 9 and digits >= 2 and not raw.isalpha():
            return True
        # Ak má token číslicu uprostred písmen (napr. "ZuRLHaMM6OFjA", "h61prVbD", "5mrmrTXgd9WL1")
        if len(compact) >= 7 and re.search(r"[a-zA-Z]\d+[a-zA-Z]", compact):
            return True
        # Neštandardné striedanie veľkých/malých písmen typické pre base62 ID (končí na veľké písmeno po malom alebo >=3 prechody)
        if len(compact) >= 7 and (
            re.search(r"[a-z][A-Z]{1,3}$", compact)
            or len(re.findall(r"[a-z][A-Z]", compact)) >= 3
            or re.search(r"[A-Z]{2,}[a-z]{1,2}[A-Z]", compact)
        ):
            # Povolíme len čisté CamelCase zložené zo známych slov/mien
            camel_parts = re.findall(r"[A-Z][a-z]{2,}", compact)
            if "".join(camel_parts).lower() != compact.lower():
                return True

    # Šablóny typu "myThumbnail 5 25 2025 6 42 00 PM"
    if re.search(r"\bmy\s*thumbnail\b", raw, re.I):
        return True

    return False


def is_junk_content_tag(raw_tag: str) -> bool:
    """Vráti True, ak reťazec je technický/importný/platformový/rozlíšeniový tag a nie skutočný obsahový tag."""
    if not raw_tag:
        return True
    t = str(raw_tag).strip()
    if t.lower().startswith(("tag:", "actor:", "model:")):
        t = t.split(":", 1)[1].strip()
    t = re.sub(r"\s+", " ", t).strip(" #,-_|›‹")
    if not t or len(t) < 2 or len(t) > 48:
        return True
    low = t.lower()
    if low in _JUNK_METADATA_TAGS or low in _TITLE_STOPWORDS:
        return True
    # Doménové názvy (napr. "filester.me", "eporner.com", "gofile.io")
    if re.search(r"\b[\w-]+\.(?:com|net|org|tv|xxx|to|io|me|cr|st|su|la|si|is|pk|club|ru)\b", low):
        return True
    # Rozlíšenia a kodeky
    if re.fullmatch(r"(?:\d{3,4}p?|\d+k|hd|fhd|uhd|\d+\s*fps|mp4|mkv|webm|mov|avi)+", low):
        return True
    if is_junk_or_hash_token(t):
        return True
    return False


def extract_actors_from_tag_strings(*tag_sources: Optional[str]) -> List[str]:
    """Vytiahne mená performerov zo značiek s prefixom 'actor:' (napr. v ai_tags)."""
    actors: List[str] = []
    seen: Set[str] = set()
    for src in tag_sources:
        for item in split_csv(src):
            raw = item.strip()
            if raw.lower().startswith(("actor:", "model:")):
                val = re.sub(r"\s+", " ", raw.split(":", 1)[1].strip())
                low = val.lower()
                if val and len(val) >= 4 and low not in seen and not is_junk_content_tag(val):
                    seen.add(low)
                    actors.append(val.title() if val.islower() else val)
    return actors


def sanitize_video_tags_list(
    raw_items: Sequence[Any],
    exclude_performers: Sequence[str] = (),
) -> List[str]:
    """Vyčistí zoznam tagov od technického balastu ('extension', 'selector', 'bunkr', 'tag:', atď.)."""
    perf_low = {p.strip().lower() for p in (exclude_performers or []) if p and p.strip()}
    cleaned_list: List[str] = []
    seen: Set[str] = set()

    for raw in raw_items or []:
        for part in split_csv(str(raw or "")):
            s = part.strip()
            if not s:
                continue
            # Ak ide o explicitného herca z ai_tags ('actor:sami hayes'), nepatrí medzi obyčajné tagy
            if s.lower().startswith(("actor:", "model:")):
                continue
            if s.lower().startswith("tag:"):
                s = s[4:].strip()
            s = re.sub(r"\s+", " ", s).strip(" #,-_|›‹")
            low = s.lower()
            if not s or low in seen or low in perf_low:
                continue
            if is_junk_content_tag(s):
                continue
            seen.add(low)
            cleaned_list.append(s)
    return cleaned_list


def sanitize_video_tags_csv(raw_csv: Optional[str], exclude_performers: Sequence[str] = ()) -> str:
    """Vyčistí CSV reťazec tagov a vráti čisté CSV bez technických značiek."""
    items = sanitize_video_tags_list([raw_csv or ""], exclude_performers=exclude_performers)
    return ", ".join(items)


def get_performer_lexicon(force_refresh: bool = False) -> Dict[str, Any]:
    """Vráti kešovaný slovník známych performerov a ich aliasov (zo statického zoznamu + z lokálnej DB)."""
    now = time.monotonic()
    if not force_refresh and _LEXICON_CACHE["by_phrase"] and (now - _LEXICON_CACHE["ts"]) < 180.0:
        return _LEXICON_CACHE

    with _LEXICON_LOCK:
        if not force_refresh and _LEXICON_CACHE["by_phrase"] and (now - _LEXICON_CACHE["ts"]) < 180.0:
            return _LEXICON_CACHE

        by_phrase: Dict[str, str] = {}
        by_compact: Dict[str, str] = {}
        aliases_for: Dict[str, List[str]] = {}

        def _register_name(name: str, alias: str = "") -> None:
            clean = re.sub(r"\s+", " ", (name or "").strip(" -_|·•,:;[]()"))
            if not clean or len(clean) < 4 or is_junk_content_tag(clean):
                return
            low = clean.lower()
            if low in _NON_NAME_PHRASES or low in _TITLE_STOPWORDS or low in _NON_NAME_WORDS:
                return
            words = low.split()
            if any(w in _TITLE_STOPWORDS for w in words):
                return
            canonical = clean.title() if clean.islower() or clean.isupper() else clean
            by_phrase[low] = canonical
            comp = _compact_alnum(canonical)
            if len(comp) >= 6:
                by_compact[comp] = canonical
            if alias:
                al_clean = re.sub(r"^@+", "", alias.strip()).lower()
                al_comp = _compact_alnum(al_clean)
                if len(al_comp) >= 4 and al_comp not in _TITLE_STOPWORDS:
                    by_compact[al_comp] = canonical
                    by_phrase[al_clean] = canonical
                    lst = aliases_for.setdefault(canonical.lower(), [])
                    if al_clean not in lst:
                        lst.append(al_clean)

        for m in KNOWN_MODELS:
            _register_name(m)
        for m in _EXTRA_KNOWN_PERFORMERS:
            _register_name(m)
        for handle, canon in _STATIC_HANDLE_TO_PERFORMER.items():
            _register_name(canon, alias=handle)

        # Doplníme performerov a aliasy priamo z lokálnej databázy používateľa
        try:
            from .database import SessionLocal
            from sqlalchemy import text as sa_text

            db = SessionLocal()
            try:
                rows = db.execute(
                    sa_text(
                        "SELECT title, models, ai_tags, batch_name FROM videos "
                        "WHERE duplicate_of IS NULL LIMIT 12000"
                    )
                ).fetchall()
                dash_counts: Dict[str, int] = {}
                for title, models, ai_tags, batch_name in rows:
                    for m in split_csv(models):
                        if 4 <= len(m) <= 36 and not is_junk_content_tag(m):
                            _register_name(m)
                    for act in extract_actors_from_tag_strings(ai_tags):
                        _register_name(act)
                    t_str = str(title or "").strip()
                    # Vzor: "[OnlyFans] Sami Hayes | SSAMIBABY x Damion Dayski"
                    of_m = re.search(
                        r"\[onlyfans\]\s*([A-Z][a-z]{2,14}\s+[A-Z][a-z]{2,14})\s*\|\s*@?([A-Za-z0-9_]{4,24})",
                        t_str,
                        re.I,
                    )
                    if of_m:
                        _register_name(of_m.group(1), alias=of_m.group(2))
                    # Vzor: "Forum - SAMI / ssamibaby" v batch_name + model
                    b_str = str(batch_name or "").strip()
                    if "/" in b_str and models:
                        first_model = split_csv(models)[0] if split_csv(models) else ""
                        m_al = re.search(r"/\s*@?([A-Za-z0-9_]{4,24})", b_str)
                        if first_model and m_al:
                            _register_name(first_model, alias=m_al.group(1))
                    # Vzor: "Meno Priezvisko - Názov scény"
                    m_dash = re.match(
                        r"^\s*(?:\[[^\]]+\]\s*)?([A-Z][a-z]{2,14}\s+[A-Z][a-z]{2,14})\s*[-|–—:]",
                        t_str,
                    )
                    if m_dash:
                        cand = m_dash.group(1).strip()
                        c_words = [w.lower() for w in cand.split()]
                        if not any(w in (_TITLE_STOPWORDS | _NON_NAME_WORDS | _QUERY_NOISE_WORDS) for w in c_words):
                            dash_counts[cand.lower()] = dash_counts.get(cand.lower(), 0) + 1

                for cand_low, cnt in dash_counts.items():
                    if cnt >= 2:
                        _register_name(cand_low.title())
            finally:
                db.close()
        except Exception as exc:
            logger.debug("[QUERY_PLANNER] DB lexicon load skipped: %s", exc)

        _LEXICON_CACHE["ts"] = now
        _LEXICON_CACHE["by_phrase"] = by_phrase
        _LEXICON_CACHE["by_compact"] = by_compact
        _LEXICON_CACHE["aliases_for"] = aliases_for
        return _LEXICON_CACHE


def get_performer_aliases(name: str) -> List[str]:
    """Vráti známe handle/aliasy pre daného performera (napr. 'Sami Hayes' -> ['ssamibaby', 'ssamihayes'])."""
    lex = get_performer_lexicon()
    low = (name or "").strip().lower()
    canon = lex["by_phrase"].get(low) or lex["by_compact"].get(_compact_alnum(low)) or low
    return list(lex["aliases_for"].get(canon.lower(), []))


def resolve_known_performer(name_or_handle: str) -> Optional[str]:
    """Preloží meno alebo @handle (napr. 'ssamibaby', 'sami hayes', 'SelenaBlaze') na kanonické meno."""
    raw = re.sub(r"^@+", "", (name_or_handle or "").strip())
    if not raw or len(raw) < 4:
        return None
    lex = get_performer_lexicon()
    low = re.sub(r"[_\-\.]+", " ", raw.lower()).strip()
    low = re.sub(r"\s+", " ", low)
    if low in lex["by_phrase"]:
        return lex["by_phrase"][low]
    comp = _compact_alnum(raw)
    if comp in lex["by_compact"]:
        return lex["by_compact"][comp]
    return None


def register_discovered_performer(name: str, alias: str = "") -> Optional[str]:
    """Dynamicky zaregistruje overeného performera (napr. z NameThatPorn alebo OCR) do pamäťového lexikónu."""
    clean = re.sub(r"\s+", " ", (name or "").strip(" -_|·•,:;[]()@#"))
    if not clean or len(clean) < 4 or is_junk_content_tag(clean):
        return None
    low = clean.lower()
    if low in _NON_NAME_PHRASES or low in _TITLE_STOPWORDS or low in _NON_NAME_WORDS:
        return None
    lex = get_performer_lexicon()
    canonical = lex["by_phrase"].get(low) or (clean.title() if clean.islower() or clean.isupper() else clean)
    with _LEXICON_LOCK:
        lex["by_phrase"][low] = canonical
        comp = _compact_alnum(canonical)
        if len(comp) >= 6:
            lex["by_compact"][comp] = canonical
        if alias:
            al_clean = re.sub(r"^@+", "", alias.strip()).lower()
            al_comp = _compact_alnum(al_clean)
            if len(al_comp) >= 4 and al_comp not in _TITLE_STOPWORDS:
                lex["by_compact"][al_comp] = canonical
                lex["by_phrase"][al_clean] = canonical
                lst = lex["aliases_for"].setdefault(canonical.lower(), [])
                if al_clean not in lst:
                    lst.append(al_clean)
    return canonical


def clean_title_for_search(raw_title: str) -> str:
    """Vyčistí surový názov od prípon, dátumov, release prefixov, hashov a technického balastu."""
    t = (raw_title or "").strip()
    if not t:
        return ""

    # Odstránenie URL a webových domén (nie bodkových release názvov končiacich na .mp4)
    t = re.sub(r"https?://\S+", " ", t)
    t = re.sub(r"\b[\w-]+\.(?:com|net|org|tv|xxx|to|io|me|cr|st)\b", " ", t, flags=re.I)

    # Odstránenie prípon videí a release tagov na konci
    t = re.sub(r"\.(mp4|mkv|mov|webm|avi|m4v|flv|wmv)\b", " ", t, flags=re.I)
    t = re.sub(r"\b(myThumbnail|spoiler|source|rq|part\s*\d+|scene\s*\d+|\(\d+\))\b", " ", t, flags=re.I)

    # Rozdelenie CamelCase slov pred čistením tokenov (napr. "DDXSelenaBlazeArmyDrilling4K4K")
    t = split_camel_case_words(t)

    # Odstránenie dátumov a časov (24.10.05, 2026-05-27, 5 25 2025 6 42 00 PM, 08172026)
    t = re.sub(r"\b\d{2,4}[.\-/]\d{1,2}[.\-/]\d{1,4}\b", " ", t)
    t = re.sub(r"\b\d{1,2}\s+\d{1,2}\s+\d{2,4}(?:\s+\d{1,2}\s+\d{2}(?:\s+\d{2})?\s*(?:AM|PM)?)?\b", " ", t, flags=re.I)
    t = re.sub(r"\b\d{6,8}\b", " ", t)

    # Odstránenie hashtagov a znakov rozdeľujúcich release názvy
    t = re.sub(r"[#\[\]{}()|]+", " ", t)
    t = re.sub(r"[_\-\.]+", " ", t)
    t = re.sub(r"\s+", " ", t).strip()

    # Vyhodenie jednotlivých hash/noise tokenov
    kept: List[str] = []
    for tok in t.split():
        # Ak je token známy performer/handle v kompaktnom tvare (napr. "Kristenhancher"), rozdelíme ho na kanonické meno
        known_p = resolve_known_performer(tok)
        if known_p:
            kept.extend(known_p.split())
            continue
        if is_junk_or_hash_token(tok):
            continue
        if tok.lower() in {"and", "the", "with", "for", "from", "in", "on", "at", "by", "of", "dd"} and not kept:
            continue
        if len(tok) <= 2 and tok.lower() in {"dd", "rq", "hd", "vr", "gg", "uk", "us"}:
            continue
        kept.append(tok)

    cleaned = " ".join(kept).strip()
    if len(cleaned) < 4 or is_junk_or_hash_token(cleaned):
        return ""
    return cleaned


def extract_safe_url_hints(url: str) -> List[str]:
    """Vytiahne zmysluplné mená zo štruktúrovaných URL ciest (nikdy nie hash ID súborov)."""
    if not url or not url.startswith("http"):
        return []
    try:
        parsed = urlparse(url)
        parts = [p for p in parsed.path.split("/") if p]
    except Exception:
        return []

    hints: List[str] = []
    for idx, part in enumerate(parts):
        prev = parts[idx - 1].lower() if idx > 0 else ""
        is_explicit_entity = prev in {"pornstar", "pornstars", "model", "models", "performer", "actor"}
        cleaned = re.sub(r"[-_]+", " ", part).strip()
        # Odstránenie koncového " dd" alebo čísel zo slugu (napr. "sami-hayes-dd" -> "sami hayes")
        cleaned = re.sub(r"\s+(?:dd|\d+)$", "", cleaned, flags=re.I).strip()
        if is_junk_or_hash_token(cleaned):
            continue
        known = resolve_known_performer(cleaned)
        if known:
            if known not in hints:
                hints.append(known)
            continue
        if not is_explicit_entity:
            words = cleaned.split()
            if len(words) < 2 or len(words) > 4 or any(any(c.isdigit() for c in w) for w in words):
                continue
        if cleaned.lower() not in _GENERIC_URL_SEGMENTS and len(cleaned) >= 4:
            hints.append(cleaned.title() if cleaned.islower() else cleaned)
    return hints[:2]


def _is_valid_two_word_person_name(w1: str, w2: str) -> bool:
    """Overí, či dvojica slov vyzerá ako skutočné meno osoby/modelky a nie bežná fráza."""
    if not (w1.isalpha() and w2.isalpha()):
        return False
    if not (3 <= len(w1) <= 15 and 3 <= len(w2) <= 15):
        return False
    l1, l2 = w1.lower(), w2.lower()
    phrase = f"{l1} {l2}"
    if phrase in _NON_NAME_PHRASES:
        return False
    blocked = _TITLE_STOPWORDS | _QUERY_NOISE_WORDS | _NON_NAME_WORDS
    if l1 in blocked or l2 in blocked:
        return False
    return True


def extract_performer_candidates(
    clean_title: str,
    explicit_models: Sequence[str] = (),
    raw_title: str = "",
    source_url: str = "",
) -> List[str]:
    """Spoľahlivo extrahuje mená performerov z metadát, lexikónu, názvu (vrátane lowercase/CamelCase) a URL."""
    performers: List[str] = []
    seen: Set[str] = set()
    lex = get_performer_lexicon()

    def _push(name: str) -> None:
        n = re.sub(r"\s+", " ", (name or "").strip(" -_|·•,:;[]()"))
        if not n or len(n) < 4:
            return
        canon = resolve_known_performer(n) or (n.title() if n.islower() or n.isupper() else n)
        lo = canon.lower()
        if lo in seen or lo in _NON_NAME_PHRASES or is_junk_content_tag(canon):
            return
        words = [w.lower() for w in canon.split()]
        if all(w in (_TITLE_STOPWORDS | _QUERY_NOISE_WORDS | _NON_NAME_WORDS) for w in words):
            return
        seen.add(lo)
        performers.append(canon)

    for m in explicit_models or ():
        _push(m)

    combined_text = f"{clean_title or ''} {split_camel_case_words(raw_title or '')}".strip()
    if not combined_text and not source_url:
        return performers[:5]

    # 1. Zoznam známych performerov z autotaggera + databázového lexikónu (frázovo aj kompaktne)
    auto = auto_tag_video(combined_text)
    for m in auto.get("models") or []:
        _push(m)

    norm_low = re.sub(r"[^a-z0-9]+", " ", combined_text.lower()).strip()
    padded_low = f" {norm_low} "
    for phrase_low, canon in lex["by_phrase"].items():
        if len(phrase_low) >= 5 and f" {phrase_low} " in padded_low:
            _push(canon)

    # Kontrola kompaktných tokenov (napr. "kristenhancher", "ssamibaby", "selenablaze")
    for tok in re.findall(r"[a-zA-Z0-9_]{5,28}", combined_text):
        comp = _compact_alnum(tok)
        if comp in lex["by_compact"]:
            _push(lex["by_compact"][comp])

    # 2. Posuvné okno (sliding window) po 2 slovách na Capitalized slová v názve
    # Opravené: "Stepmom Tatti Roana" -> preskočí ("Stepmom", "Tatti") a nájde ("Tatti", "Roana")!
    raw_words = re.findall(r"[A-Za-z]{2,16}", clean_title or combined_text)
    for i in range(len(raw_words) - 1):
        w1, w2 = raw_words[i], raw_words[i + 1]
        if w1[0].isupper() and w2[0].isupper() and _is_valid_two_word_person_name(w1, w2):
            _push(f"{w1.title()} {w2.title()}")

    # 3. Štruktúrované vzory v názve (aj keď je druhé slovo s malým písmenom, napr. "Sami hayes dd", "Nicol love - ...")
    if raw_title:
        # Vzor A: "Meno Priezvisko - Názov" na začiatku titulku
        m_prefix = re.match(r"^\s*(?:\[[^\]]+\]\s*)?([A-Za-z]{3,14})\s+([A-Za-z]{3,14})\s*[-|–—:]", raw_title)
        if m_prefix and _is_valid_two_word_person_name(m_prefix.group(1), m_prefix.group(2)):
            _push(f"{m_prefix.group(1).title()} {m_prefix.group(2).title()}")

        # Vzor B: Bodkovaný release názov ("onlytarts.26.10.16.sami.hayes.bright.idea.4k", "Onlyfans.2026.ruth.lee...")
        m_rel = re.search(
            r"\b(?:onlyfans|onlytarts|vixen|badoinkvr|tushy|blacked|deeper)[\s._-]+(?:\d{2,4}[\s._-]+\d{1,2}[\s._-]+\d{1,2}[\s._-]+|\d{4}[\s._-]+)?([a-zA-Z]{3,14})[\s._-]+([a-zA-Z]{3,14})\b",
            raw_title,
            re.I,
        )
        if m_rel and _is_valid_two_word_person_name(m_rel.group(1), m_rel.group(2)):
            _push(f"{m_rel.group(1).title()} {m_rel.group(2).title()}")

    # 4. Krátky 2-slovný vyčistený názov (napr. "Sami hayes dd" -> clean_title="Sami hayes", alebo "reese robbins")
    clean_tokens = [w for w in (clean_title or "").split() if w.isalpha()]
    if len(clean_tokens) == 2 and _is_valid_two_word_person_name(clean_tokens[0], clean_tokens[1]):
        _push(f"{clean_tokens[0].title()} {clean_tokens[1].title()}")
    elif (
        len(clean_tokens) >= 2
        and clean_tokens[0][0].isupper()
        and _is_valid_two_word_person_name(clean_tokens[0], clean_tokens[1])
        and len(raw_title or "") <= 28
    ):
        _push(f"{clean_tokens[0].title()} {clean_tokens[1].title()}")

    # 5. Oddelenie cez "and" / "x" / "vs" / "&"
    if any(sep in f" {(clean_title or '').lower()} " for sep in (" and ", " x ", " vs ", " & ")):
        segments = re.split(r"\s+(?:and|x|vs|&)\s+", clean_title, flags=re.I)
        for seg in segments:
            words = [
                w for w in seg.strip().split()
                if w.isalpha() and w.lower() not in (_TITLE_STOPWORDS | _QUERY_NOISE_WORDS | _NON_NAME_WORDS)
            ]
            if len(words) == 2 and _is_valid_two_word_person_name(words[0], words[1]):
                _push(f"{words[0].title()} {words[1].title()}")

    # 6. Ak sme zatiaľ nenašli performera, skúsime URL hint (napr. /videos/17534946/sami-hayes-dd/)
    if not performers and source_url:
        for hint in extract_safe_url_hints(source_url):
            h_words = hint.split()
            if len(h_words) == 2 and _is_valid_two_word_person_name(h_words[0], h_words[1]):
                _push(hint)

    return performers[:5]


def plan_related_queries(
    video: Any,
    scraped_meta: Optional[Dict[str, Any]] = None,
    user_keywords: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
    """Vytvorí čistý plán vyhľadávacích dopytov, performerov a príznak chudobných metadát."""
    scraped_meta = scraped_meta or {}
    raw_title = str(getattr(video, "title", "") or "").strip()
    scraped_title = str(scraped_meta.get("title") or "").strip()
    if scraped_title and (not raw_title or is_junk_or_hash_token(raw_title) or len(raw_title) < 8):
        raw_title = scraped_title

    source_url = str(getattr(video, "source_url", "") or getattr(video, "url", "") or "").strip()
    clean_title = clean_title_for_search(raw_title)
    auto = auto_tag_video(clean_title or raw_title)

    # Získame hercov aj z ai_tags ('actor:sami hayes') a prípadne z tagov, kde je uložené meno modelky
    ai_actors = extract_actors_from_tag_strings(
        getattr(video, "ai_tags", "") or "",
        getattr(video, "tags", "") or "",
    )
    explicit_models: List[str] = []
    for src in (
        split_csv(getattr(video, "models", "") or ""),
        ai_actors,
        list(scraped_meta.get("models") or []),
        list(auto.get("models") or []),
    ):
        for item in src:
            if item and not is_junk_content_tag(item) and item not in explicit_models:
                explicit_models.append(item)

    # Ak používateľ/video má v tags alebo user_keywords meno známeho performera (napr. "Nicol Love"), presunieme ho k performerom
    for kw in list(user_keywords or []) + split_csv(getattr(video, "tags", "") or ""):
        known_p = resolve_known_performer(kw)
        if known_p and known_p not in explicit_models:
            explicit_models.append(known_p)

    performers = extract_performer_candidates(
        clean_title,
        explicit_models=explicit_models,
        raw_title=raw_title,
        source_url=source_url,
    )

    # Vyčistíme všetky tagy od technického balastu ('extension', 'selector', 'bunkr', 'filester', 'discovery-hub', ...)
    tags = sanitize_video_tags_list(
        [
            *(user_keywords or []),
            getattr(video, "tags", "") or "",
            getattr(video, "ai_tags", "") or "",
            getattr(video, "categories", "") or "",
            *(scraped_meta.get("tags") or []),
            *(scraped_meta.get("categories") or []),
            *(auto.get("tags") or []),
        ],
        exclude_performers=performers,
    )

    strong_tags = [t for t in tags if t.lower() in _STRONG_TAGS]
    perf_tokens = {w.lower() for p in performers for w in p.split()}
    title_words = [
        w for w in re.findall(r"[a-zA-Z]{3,}", clean_title.lower())
        if w not in _TITLE_STOPWORDS and w not in _QUERY_NOISE_WORDS and not is_junk_or_hash_token(w)
    ]
    scene_title_words = [w for w in title_words if w not in perf_tokens]

    queries: List[str] = []

    def _token_set(q: str) -> Set[str]:
        return {w for w in re.findall(r"[a-z0-9]{3,}", q.lower()) if w not in _TITLE_STOPWORDS}

    def _add_query(q: str) -> None:
        cleaned = re.sub(r"\s+", " ", (q or "").strip())
        if not cleaned or len(cleaned) < 4 or is_junk_or_hash_token(cleaned):
            return
        low = cleaned.lower()
        if any(existing.lower() == low for existing in queries):
            return
        ts = _token_set(cleaned)
        if ts:
            for existing in queries:
                ets = _token_set(existing)
                if ets and len(ts & ets) / max(len(ts), len(ets)) >= 0.85:
                    return
        queries.append(cleaned)

    # Slot 1 (NAJVYŠŠIA PRIORITA): Čisté meno hlavného performera/tvorcu (napr. "Sami Hayes", "Nicol Love")
    # Prečo: Tube vyhľadávače (Eporner, SpankBang, PornTrex, Pornhub, FPO) používajú AND logiku —
    # čisté meno tvorcu vráti najviac presných videí danej modelky bez zbytočného odfiltrovania.
    if performers:
        _add_query(performers[0])

    # Slot 2: Ak má performer známy OnlyFans/Cam handle (napr. "ssamibaby") alebo druhého performera
    if performers:
        aliases = get_performer_aliases(performers[0])
        if aliases:
            _add_query(f"{performers[0]} {aliases[0]}")
        if len(performers) >= 2:
            _add_query(f"{performers[0]} {performers[1]}")
        elif strong_tags:
            _add_query(f"{performers[0]} {strong_tags[0]}")
        elif scene_title_words:
            _add_query(f"{performers[0]} {' '.join(scene_title_words[:2])}")

    # Slot 3: Druhý performer alebo čisto špecifický názov scény
    if len(performers) >= 2:
        _add_query(performers[1])

    # Slot 4: Čisté kľúčové slová z názvu (max 4 slová)
    if title_words:
        _add_query(" ".join(title_words[:4]))

    # Slot 5: Vyčistené používateľské / obsahové tagy (max 2-3 silné tagy, nikdy nie 6-slovný zlepenec)
    clean_user_kw = sanitize_video_tags_list(user_keywords or [], exclude_performers=performers)
    if clean_user_kw:
        if performers:
            _add_query(f"{performers[0]} {clean_user_kw[0]}")
        _add_query(" ".join(clean_user_kw[:2]))
    elif len(strong_tags) >= 2:
        _add_query(f"{strong_tags[0]} {strong_tags[1]}")
    elif len(tags) >= 2:
        _add_query(f"{tags[0]} {tags[1]}")
    elif len(tags) == 1 and not performers:
        _add_query(tags[0])

    # Slot 6: Bezpečné URL hinty (ak stále chýbajú dopyty)
    if not queries:
        for hint in extract_safe_url_hints(source_url):
            _add_query(hint)

    is_meaningless = not clean_title and not performers and len(tags) < 2

    return {
        "clean_title": clean_title,
        "raw_title": raw_title,
        "performers": performers,
        "tags": tags[:16],
        "queries": queries[:6],
        "is_meaningless_title": is_meaningless,
    }


async def ai_analyze_for_related(
    thumb_bytes: bytes,
    raw_title: str = "",
    api_key: Optional[str] = None,
) -> Dict[str, Any]:
    """Vygeneruje čistý názov, performera, tagy a queries z náhľadu (Gemini Vision + Google Vision OCR fallback)."""
    if not thumb_bytes:
        raise RuntimeError("Chýbajú dáta náhľadu pre AI analýzu")

    # Lazy import breaks the module-level cycle with ai_tagger_batch.
    from .ai_tagger_batch import GEMINI_VISION_MODELS, compress_thumbnail_bytes

    key = (api_key or os.getenv("GEMINI_API_KEY") or "").strip()
    fast_bytes = compress_thumbnail_bytes(thumb_bytes, max_dim=640, quality=76)
    b64_img = base64.b64encode(fast_bytes).decode("ascii")

    title_hint = f' Raw title: "{raw_title[:140]}".' if raw_title else ""
    prompt = (
        "Analyze this adult video thumbnail and raw title to build effective external search queries."
        f"{title_hint} "
        "Also read any overlaid watermark/handle text on the image (e.g. OnlyFans handle, @username, performer name). "
        "Return strict JSON: "
        '{"clean_title": "short readable title without hashes/dates/extensions", '
        '"performers": ["recognized performer names or handles if visible/known, else empty list"], '
        '"tags": ["6-10 short lowercase visual/scene keywords"], '
        '"queries": ["2-4 concise search queries (performer + key scene traits)"]}.'
    )

    body = {
        "contents": [{
            "parts": [
                {"inline_data": {"mime_type": "image/jpeg", "data": b64_img}},
                {"text": prompt},
            ]
        }],
        "safetySettings": [
            {"category": c, "threshold": "BLOCK_NONE"} for c in (
                "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                "HARM_CATEGORY_HARASSMENT",
                "HARM_CATEGORY_HATE_SPEECH",
                "HARM_CATEGORY_DANGEROUS_CONTENT",
            )
        ],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": {
                "type": "OBJECT",
                "properties": {
                    "clean_title": {"type": "STRING"},
                    "performers": {"type": "ARRAY", "items": {"type": "STRING"}},
                    "tags": {"type": "ARRAY", "items": {"type": "STRING"}},
                    "queries": {"type": "ARRAY", "items": {"type": "STRING"}},
                },
                "required": ["clean_title", "performers", "tags", "queries"],
            },
            "maxOutputTokens": 260,
            "temperature": 0.15,
        },
    }

    last_err = ""
    if key:
        async with httpx.AsyncClient(timeout=12.0) as cl:
            for model in GEMINI_VISION_MODELS[:2]:
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
                try:
                    resp = await cl.post(
                        url,
                        headers={"Content-Type": "application/json", "X-goog-api-key": key},
                        json=body,
                    )
                    if resp.status_code != 200:
                        last_err = f"{model} HTTP {resp.status_code}"
                        continue
                    data = resp.json() or {}
                    parts = (((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or [])
                    text = "".join(str(p.get("text") or "") for p in parts).strip()
                    if not text:
                        last_err = f"{model} prázdna odpoveď"
                        continue
                    parsed = json.loads(text)
                    perfs = [str(p).strip() for p in (parsed.get("performers") or []) if str(p).strip()][:5]
                    clean_tags = sanitize_video_tags_list(parsed.get("tags") or [], exclude_performers=perfs)[:12]
                    queries_out = [str(q).strip() for q in (parsed.get("queries") or []) if str(q).strip()][:5]
                    clean_t_out = str(parsed.get("clean_title") or "").strip()[:160]
                    if not perfs:
                        try:
                            from .related_creator_discovery import discover_creators_and_tags_fallback
                            fb = await discover_creators_and_tags_fallback(thumb_bytes, raw_title=raw_title)
                            if fb.get("performers"):
                                perfs = list(fb["performers"])[:4]
                                for qp in reversed(fb.get("queries") or []):
                                    if qp.lower() not in {x.lower() for x in queries_out}:
                                        queries_out.insert(0, qp)
                        except Exception:
                            pass
                    return {
                        "clean_title": clean_t_out,
                        "performers": perfs,
                        "tags": [t.lower() for t in clean_tags],
                        "queries": queries_out[:5],
                        "model_used": model,
                    }
                except Exception as exc:
                    last_err = f"{model}: {exc}"
                    continue

    # Fallback: ak Gemini API kľúč nefunguje (napr. HTTP 402/403), použijeme Google Vision OCR + Yandex CBIR + lokálny plánovač
    from .related_creator_discovery import discover_creators_and_tags_fallback
    fallback_res = await discover_creators_and_tags_fallback(thumb_bytes, raw_title=raw_title)
    if fallback_res and (fallback_res.get("performers") or fallback_res.get("queries") or fallback_res.get("tags")):
        return fallback_res

    raise RuntimeError(last_err or "AI analýza náhľadu zlyhala")
