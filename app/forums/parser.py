"""XenForo HTML -> threads, posts, and links with post-scoped metadata.

The metadata rule that matters: everything we say about a link comes from the
post it was found in, and preferentially from the *block* it sits in. Priority
for each field is documented on the extractor below.
"""
from __future__ import annotations

import base64
import re
from datetime import datetime, timezone
from typing import Any, Iterable, Optional
from urllib.parse import parse_qs, urljoin, urlparse

from bs4 import BeautifulSoup, Tag

# ─── Supported platforms ──────────────────────────────────────────────────────
# (platform, host substrings, {link_type: url regex})
# Only video/album/folder/archive kinds reach the gallery; images are ignored.

_PLATFORM_RULES: list[tuple[str, tuple[str, ...], list[tuple[str, str]]]] = [
    ("bunkr", ("bunkr.", "bunkrr.", "bunkr-albums.io", "balbums.st"), [
        ("album", r"/a/([A-Za-z0-9_-]+)"),
        ("video", r"/(?:v|f|d)/([^/?#]+)"),
    ]),
    ("gofile", ("gofile.io",), [("archive", r"/d/([A-Za-z0-9_-]+)")]),
    ("pixeldrain", ("pixeldrain.com",), [
        ("album", r"/l/([A-Za-z0-9_-]+)"),
        ("file", r"/u/([A-Za-z0-9_-]+)"),
    ]),
    ("turbo", ("turbo.cr", "turboviplay.com", "turbovid."), [("video", r"/(?:embed|e|v|f|d)/([A-Za-z0-9_-]+)")]),
    ("filester", ("filester.", "fileditchfiles."), [
        ("folder", r"/f/([A-Za-z0-9_-]+)"),
        ("video", r"/d/([A-Za-z0-9_-]+)"),
    ]),
    ("cyberdrop", ("cyberdrop.me", "cyberdrop.to", "cyberdrop.cc"), [
        ("album", r"/a/([A-Za-z0-9_-]+)"),
        ("video", r"/f/([A-Za-z0-9_-]+)"),
    ]),
    ("mega", ("mega.nz", "mega.io"), [("archive", r"(?:folder|file)/([^\s#?]+)")]),
    ("erome", ("erome.com",), [("album", r"/a/([A-Za-z0-9_-]+)")]),
    ("krakenfiles", ("krakenfiles.com",), [("video", r"/view/([A-Za-z0-9_-]+)")]),
    ("redgifs", ("redgifs.com",), [("video", r"/watch/([A-Za-z0-9_-]+)")]),
    ("saint", ("saint2.su", "saint2.cr", "saint.to"), [
        ("album", r"/a/([A-Za-z0-9_-]+)"),
        ("video", r"/(?:embed|d)/([A-Za-z0-9_-]+)"),
    ]),
]

#: Kinds we surface as "links na videa". Everything else is dropped.
VIDEO_LINK_TYPES = frozenset({"video", "album", "folder", "archive", "file"})

#: A "/f/"-style single-file path is host-generic — Bunkr and Cyberdrop serve
#: both videos and plain images through it, so the path alone can't tell them
#: apart. A URL ending in one of these is a picture no matter what the path
#: segment says, and must not be classified as "video" (seen live: a bunkr
#: "/f/…jpg-orig-…jpg" card carried link_type=video and, worse, resolved to a
#: stream_url for a completely unrelated file — the extractor has no sane
#: video to return for a JPEG, so the whole card was garbage in the grid).
_IMAGE_EXT_RE = re.compile(r"\.(jpe?g|png|gif|webp|bmp|avif|heic)(?:[?#]|$)", re.I)

#: Same host-generic-path problem, but caught in the TITLE instead of the URL:
#: uploaders split a video into a multi-part archive and the slug is random,
#: so the only tell is the poster's own filename ("...1080p.mp4.7z") — seen
#: live on Bunkr "/f/" cards that were really a .7z part, not a playable file.
_ARCHIVE_TITLE_RE = re.compile(r"\.(7z|zip|rar|r\d{2,3})(?:[?#]|$)", re.I)

#: A poster's own filename saying "Photoset"/"Photo Set" is the same tell as
#: an archive extension — the random /f/ slug can't say it, but the title
#: does (seen live: a bunkr "/f/…" card titled "...XXX.Photoset" carried
#: link_type=video and had nothing playable behind it).
_PHOTOSET_TITLE_RE = re.compile(r"\bphoto\s*set\b", re.I)

SUPPORTED_PLATFORMS = tuple(rule[0] for rule in _PLATFORM_RULES)

#: Also catches the host's own branding, which several file hosts serve as the
#: og:image when a file has no real preview — a pixeldrain/gofile logo is worse
#: than no thumbnail at all, since the card then looks like a valid preview of
#: something it isn't (measured live: 65 cards were showing a host logo).
_JUNK_IMAGE = re.compile(
    r"(emoji|smilie|avatar|/styles/|reaction|sprite|icon|logo|/res/img/|favicon|\.ico(?:[?#]|$))",
    re.I,
)
_HASHTAG = re.compile(r"#([A-Za-z0-9_]{2,60})")
# Not \b: filenames like "clip_1080p_source" put an underscore (a word char) next to
# the token, which would kill the boundary.
_QUALITY = re.compile(r"(?<![A-Za-z0-9])(4K|2160p|1440p|1080p|720p|480p)(?![A-Za-z0-9])", re.I)
_DURATION = re.compile(r"\b(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\b")
_SIZE = re.compile(r"\b(\d+(?:[.,]\d+)?)\s?(KB|MB|GB|TB)\b", re.I)
_SIZE_UNITS = {"KB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4}


# ─── small helpers ────────────────────────────────────────────────────────────

def _absolutize(href: str, base_url: str) -> str:
    if not href:
        return ""
    if href.startswith("//"):
        return "https:" + href
    if href.startswith("http"):
        return href
    return urljoin(base_url + "/", href.lstrip("/"))


def decode_confirmation_link(href: str) -> str:
    """SocialMediaGirls wraps outbound links in /link-confirmation/?url=<base64>."""
    if "link-confirmation" not in href:
        return href
    try:
        qs = parse_qs(urlparse(href).query)
        encoded = qs.get("url", [""])[0]
        if not encoded:
            return href
        encoded += "=" * (-len(encoded) % 4)
        decoded = base64.b64decode(encoded).decode("utf-8", errors="ignore")
        return decoded if decoded.startswith("http") else href
    except Exception:
        return href


def classify_link(url: str) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """url -> (platform, link_type, file_id). (None, None, None) if unsupported."""
    lowered = url.lower()
    for platform, hosts, patterns in _PLATFORM_RULES:
        if not any(host in lowered for host in hosts):
            continue
        for link_type, pattern in patterns:
            match = re.search(pattern, url)
            if match:
                if link_type == "video" and _IMAGE_EXT_RE.search(url):
                    return platform, "image", match.group(1)
                return platform, link_type, match.group(1)
        return platform, "file", None
    return None, None, None


def parse_size_bytes(text: str) -> int:
    match = _SIZE.search(text or "")
    if not match:
        return 0
    value = float(match.group(1).replace(",", "."))
    return int(value * _SIZE_UNITS[match.group(2).upper()])


def parse_duration_seconds(text: str) -> int:
    match = _DURATION.search(text or "")
    if not match:
        return 0
    a, b, c = match.group(1), match.group(2), match.group(3)
    if c is not None:
        return int(a) * 3600 + int(b) * 60 + int(c)
    return int(a) * 60 + int(b)


def parse_quality(text: str) -> str:
    match = _QUALITY.search(text or "")
    if not match:
        return ""
    value = match.group(1).upper()
    return "4K" if value in ("4K", "2160P") else value.lower()


def _parse_xf_datetime(tag: Optional[Tag]) -> Optional[datetime]:
    if tag is None:
        return None
    raw = tag.get("datetime") or ""
    if raw:
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc).replace(tzinfo=None)
        except ValueError:
            pass
    ts = tag.get("data-time")
    if ts and str(ts).isdigit():
        return datetime.utcfromtimestamp(int(ts))
    return None


# ─── thread listings ──────────────────────────────────────────────────────────

def _thread_rows(soup: BeautifulSoup) -> Iterable[Tag]:
    rows = soup.select("div.structItem--thread")
    if rows:
        return rows
    return soup.select("li.block-row, div.contentRow")


def parse_thread_list(html: str, base_url: str) -> list[dict[str, Any]]:
    """Parse /watched/threads, /tags/<tag>/, and search results — all share structItem."""
    soup = BeautifulSoup(html, "html.parser")
    threads: list[dict[str, Any]] = []
    seen: set[str] = set()

    for row in _thread_rows(soup):
        # Rows carry several /threads/ anchors (title, "go to unread", last post).
        # Only the title one has text; tag pages put an empty one first.
        anchors = row.select(".structItem-title a[href*='/threads/']") or row.select("a[href*='/threads/']")
        link = next((a for a in anchors if a.get_text(strip=True)), None) or (anchors[0] if anchors else None)
        if not link:
            continue
        href = link.get("href", "")
        # Strip /post-123, /unread, /page-4 suffixes down to the canonical thread URL.
        match = re.search(r"(/threads/[^/?#]+)", href)
        if not match:
            continue
        url = _absolutize(match.group(1) + "/", base_url)
        if url in seen:
            continue
        seen.add(url)

        unread = bool(row.select_one(".structItem-status--unread")) or "is-unread" in " ".join(row.get("class", []))
        last_post = _parse_xf_datetime(row.select_one(".structItem-latestDate") or row.select_one("time"))

        # Prefix labels ("Request", "OnlyFans", "XXX") live inside the title anchor and
        # would otherwise glue onto the name: "RequestXaya Nox". Lift them out as tags.
        labels = link.select(".label, .labelLink")
        tags = [el.get_text(strip=True).lower() for el in labels]
        for el in labels:
            el.extract()
        tags += [t.get_text(strip=True).lower() for t in row.select("a.tagItem")]

        threads.append({
            "url": url,
            "title": re.sub(r"\s+", " ", link.get_text(" ", strip=True)),
            "slug": match.group(1).rsplit("/", 1)[-1],
            "unread": unread,
            "last_post_at": last_post,
            "tags": tags,
        })
    return threads


def parse_tag_cloud(html: str) -> list[dict[str, Any]]:
    """/tags/ renders a weighted cloud; font size encodes popularity."""
    soup = BeautifulSoup(html, "html.parser")
    tags: list[dict[str, Any]] = []
    seen: set[str] = set()

    for el in soup.select("a.tagCloud-tag, .tagCloud a, a[href*='/tags/']"):
        name = el.get_text(strip=True).lower()
        if not name or name in seen or len(name) > 40:
            continue
        href = el.get("href", "")
        if "/tags/" not in href:
            continue
        seen.add(name)

        weight = 1.0
        classes = " ".join(el.get("class", []))
        level = re.search(r"tagCloud-tagLevel(\d+)", classes)
        if level:
            weight = float(level.group(1))
        else:
            style_size = re.search(r"font-size:\s*([\d.]+)", el.get("style", "") or "")
            if style_size:
                weight = float(style_size.group(1))
        tags.append({"tag": name, "weight": weight})
    return tags


def prev_page_url(html: str, base_url: str) -> str:
    """The 'previous page' nav link, for walking a thread backwards. '' when on page 1."""
    soup = BeautifulSoup(html, "html.parser")
    link = soup.select_one("a.pageNav-jump--prev")
    return _absolutize(link.get("href", ""), base_url) if link else ""


def next_page_url(html: str, base_url: str) -> str:
    """The next page in a XenForo listing, or '' when there is no next page."""
    soup = BeautifulSoup(html, "html.parser")
    link = soup.select_one("a.pageNav-jump--next")
    return _absolutize(link.get("href", ""), base_url) if link else ""


# ─── posts + links ────────────────────────────────────────────────────────────

def _post_id(article: Tag) -> str:
    raw = article.get("data-content") or article.get("id") or ""
    match = re.search(r"post-(\d+)", raw)
    return match.group(1) if match else ""


def _image_src(img: Tag) -> str:
    for attr in ("data-src", "data-url", "data-lazy-src", "src"):
        value = (img.get(attr) or "").strip()
        if value and not _JUNK_IMAGE.search(value):
            return value
    return ""


def _block_of(node: Tag, root: Tag) -> Tag:
    """Nearest block-ish ancestor of `node` under `root` — the metadata scope."""
    block_tags = {"div", "blockquote", "li", "p", "td"}
    current = node
    while current is not None and current is not root:
        parent = current.parent
        if parent is root:
            return current if isinstance(current, Tag) else root
        if isinstance(parent, Tag) and parent.name in block_tags:
            return parent
        current = parent
    return root


def _unfurl_meta(anchor: Tag) -> dict[str, str]:
    """XenForo's link preview card: filename, description, favicon. Most reliable source."""
    block = anchor.find_parent(class_=re.compile(r"bbCodeBlock--unfurl"))
    if block is None:
        return {}
    title_el = block.select_one(".js-unfurl-title, .contentRow-title a, .contentRow-title")
    desc_el = block.select_one(".js-unfurl-description, .contentRow-snippet")
    img_el = block.select_one(".contentRow-figure img, .js-unfurl-favicon")
    return {
        "title": title_el.get_text(strip=True) if title_el else "",
        "description": desc_el.get_text(strip=True) if desc_el else "",
        "thumbnail": _image_src(img_el) if img_el else "",
    }


def _assign_thumbnails(wrapper: Tag, anchors: list[Tag]) -> dict[int, str]:
    """Greedy nearest-unclaimed-image assignment in document order.

    The naive `img_idx++` approach mis-assigns whenever a post has more images
    than links (very common: 3 preview shots + 1 download link).
    """
    tokens: list[tuple[str, Tag]] = []
    anchor_set = {id(a) for a in anchors}
    for el in wrapper.descendants:
        if not isinstance(el, Tag):
            continue
        if el.name == "img" and _image_src(el):
            tokens.append(("img", el))
        elif el.name == "a" and id(el) in anchor_set:
            tokens.append(("a", el))

    img_positions = [(i, el) for i, (kind, el) in enumerate(tokens) if kind == "img"]
    claimed: set[int] = set()
    result: dict[int, str] = {}

    for i, (kind, el) in enumerate(tokens):
        if kind != "a":
            continue
        best: Optional[tuple[int, int, Tag]] = None
        for pos, img in img_positions:
            if pos in claimed:
                continue
            # Prefer images that precede the link (the usual "screenshots then link" shape).
            distance = (i - pos) if pos < i else (pos - i) * 2
            if best is None or distance < best[0]:
                best = (distance, pos, img)
        if best is not None:
            claimed.add(best[1])
            result[id(el)] = _image_src(best[2])
    return result


#: Bare URLs, scheme-less hosts, and mega.nz `#<key>` fragments are not titles.
_URLISH = re.compile(r"(https?://|www\.|\S+\.[a-z]{2,6}/|^#?[A-Za-z0-9_-]{20,}$)", re.I)


def _is_urlish(text: str) -> bool:
    return bool(_URLISH.search(text.strip()))


def _strip_urls(text: str) -> str:
    """Drop URLs before hashtag/quality scanning: `mega.nz/file/x#<key>` is not a #tag."""
    return re.sub(r"https?://\S+|\b\S+\.[a-z]{2,6}/\S*", " ", text or "", flags=re.I)


#: Lines that label a group of links rather than name the content.
_NOISE_LINE = re.compile(
    r"^(?:\d{3,4}p|4k|2160p|1080p|720p|480p|hd|sd|mp4|photo\.zip|screens?|preview|mirrors?|"
    r"download|links?|re-?up(?:load)?|enjoy|thanks?|source|part\s*\d+)[:\s]*$",
    re.I,
)


def post_heading(wrapper: Tag) -> str:
    """The post's own title line — what the uploader called the content.

    Posts that dump several bare mirror URLs carry the real name on the first text
    line ("AmazingFilms - Stephanie Love - Stuffing Stephanie's Box"). Quoted text
    belongs to somebody else's post, so it is skipped.
    """
    skip = re.compile(r"bbCodeBlock|bbCodeQuote")
    for node in wrapper.descendants:
        if isinstance(node, Tag):
            continue
        # Skip quotes and unfurl captions. find_parent() only walks ancestors, so the
        # enclosing element itself has to be checked too.
        parent = node.parent
        if parent is not None and (
            skip.search(" ".join(parent.get("class", [])))
            or parent.find_parent(class_=skip) is not None
        ):
            continue
        text = re.sub(r"\s+", " ", str(node)).strip()
        if len(text) < 6 or _is_urlish(text) or _NOISE_LINE.match(text):
            continue
        return text[:140]
    return ""


def _hashtags(text: str) -> list[str]:
    return _HASHTAG.findall(_strip_urls(text))


#: Anchor text that names the HOST or the studio rather than the video. Posters
#: routinely link as "Filester" / "BUNKR" / "PornWorld", which passes every
#: generic "looks like a title" test while telling you nothing — and in a merged
#: feed you end up with a screen of cards all called "Filester". Falling through
#: to the URL filename (or the post heading) is strictly more informative.
_UNINFORMATIVE_TITLE = re.compile(
    r"^(?:filester|bunkr+|bunkrr|pixeldrain|gofile|cyberdrop|mega|erome|saint|turbo|"
    r"krakenfiles|redgifs|fileditch|pornworld|brazzers|evilangel|blacked|tushy|vixen|"
    r"download|link|video|mirror|here|click|watch)\W*$",
    re.I,
)


def _title_from_url(url: str, platform: str, link_type: str) -> str:
    """Last resort: a filename from the URL beats 'Bunkr video'."""
    parsed = urlparse(url)
    tail = parsed.path.rstrip("/").rsplit("/", 1)[-1]
    # fileditchfiles.me/file.php?f=/b68/name.mp4 keeps the real name in the query.
    if tail.endswith(".php") or tail in ("file", "index", "download"):
        param = parse_qs(parsed.query).get("f", [""])[0]
        tail = param.rstrip("/").rsplit("/", 1)[-1] or tail
    tail = re.sub(r"\.[A-Za-z0-9]{2,4}$", "", tail)
    if tail and not tail.isdigit() and len(tail) > 3 and not _is_urlish(tail):
        return re.sub(r"[-_]+", " ", tail).strip()
    return f"{platform.capitalize()} {link_type}"


def _derive_title(anchor: Tag, unfurl: dict[str, str], block_text: str, hashtags: list[str],
                  platform: str, link_type: str, url: str, block_is_shared: bool,
                  heading: str = "") -> str:
    """Priority: unfurl filename > anchor text > hashtag > block text > post heading > URL id.

    `block_is_shared` means several supported links live in this block (a post
    offering the same scene on mega + pixeldrain + filester). Its text describes
    all of them, so it identifies none — skip it rather than stamp it on each,
    and fall back to what the uploader titled the post.
    """
    unfurl_title = (unfurl.get("title") or "").strip()
    if unfurl_title and not _UNINFORMATIVE_TITLE.match(unfurl_title):
        return re.sub(r"\.[A-Za-z0-9]{2,4}$", "", unfurl_title).strip() or unfurl_title

    text = anchor.get_text(strip=True)
    if text and len(text) > 3 and not _is_urlish(text) and not _UNINFORMATIVE_TITLE.match(text):
        return text

    if hashtags:
        return hashtags[0].replace("_", " ").strip()

    if not block_is_shared:
        cleaned = re.sub(r"#[A-Za-z0-9_-]{20,}", " ", _strip_urls(block_text))  # mega keys
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        if len(cleaned) > 3:
            return cleaned[:120]

    if heading:
        return heading

    return _title_from_url(url, platform, link_type)


def parse_posts(html: str, base_url: str) -> list[dict[str, Any]]:
    """Parse one thread page into posts, each carrying its extracted links."""
    soup = BeautifulSoup(html, "html.parser")
    posts: list[dict[str, Any]] = []

    for article in soup.select("article.message--post, article.message, [data-content^='post-']"):
        post_id = _post_id(article)
        if not post_id:
            continue

        wrapper = article.select_one(".message-body .bbWrapper") or article.select_one(".bbWrapper")
        if wrapper is None:
            continue

        author = (article.get("data-author") or "").strip()
        if not author:
            author_el = article.select_one(".message-userDetails .username, a.username")
            author = author_el.get_text(strip=True) if author_el else ""

        posted_at = _parse_xf_datetime(article.select_one(".message-attribution-main time, time.u-dt"))
        permalink_el = article.select_one(".message-attribution-opposite a[href*='post-']")
        permalink = _absolutize(permalink_el.get("href", ""), base_url) if permalink_el else \
            f"{base_url}/posts/{post_id}/"

        body_text = wrapper.get_text(" ", strip=True)
        post_hashtags = _hashtags(body_text)
        heading = post_heading(wrapper)

        # Collect supported anchors first so thumbnail assignment sees only real candidates.
        candidates: list[tuple[Tag, str, str, str, Optional[str]]] = []
        for anchor in wrapper.find_all("a", href=True):
            href = decode_confirmation_link(_absolutize(anchor["href"], base_url))
            platform, link_type, file_id = classify_link(href)
            if not platform or link_type not in VIDEO_LINK_TYPES:
                continue
            candidates.append((anchor, href, platform, link_type, file_id))

        thumbs = _assign_thumbnails(wrapper, [c[0] for c in candidates]) if candidates else {}

        # A block holding several supported links describes all of them at once.
        blocks = [_block_of(c[0], wrapper) for c in candidates]
        block_link_count: dict[int, int] = {}
        for block in blocks:
            block_link_count[id(block)] = block_link_count.get(id(block), 0) + 1

        links: list[dict[str, Any]] = []
        for (anchor, href, platform, link_type, file_id), block in zip(candidates, blocks):
            unfurl = _unfurl_meta(anchor)
            block_text = block.get_text(" ", strip=True) if isinstance(block, Tag) else body_text
            block_hashtags = _hashtags(block_text) or post_hashtags
            block_is_shared = block_link_count[id(block)] > 1

            thumbnail = unfurl.get("thumbnail") or thumbs.get(id(anchor), "")
            if thumbnail:
                thumbnail = _absolutize(thumbnail, base_url)

            # Text that belongs to *this* link wins over the block it sits in. A block
            # holding both a _1080p and a _2160p upload would otherwise stamp the
            # block's first match onto both links.
            own_text = " ".join(filter(None, (
                unfurl.get("title", ""), unfurl.get("description", ""), anchor.get_text(strip=True)
            )))
            title = _derive_title(anchor, unfurl, block_text, block_hashtags,
                                   platform, link_type, href, block_is_shared, heading)
            # The URL slug is random on a host-generic "/f/" path, so a split
            # archive — or a set of photos, not a video at all — only gives
            # itself away in the poster's own filename.
            if link_type == "video" and _ARCHIVE_TITLE_RE.search(title):
                link_type = "archive"
            elif link_type == "video" and _PHOTOSET_TITLE_RE.search(title):
                link_type = "image"
            links.append({
                "url": href,
                "platform": platform,
                "link_type": link_type,
                "file_id": file_id or "",
                "title": title,
                "thumbnail": thumbnail,
                "quality": parse_quality(own_text) or parse_quality(block_text) or parse_quality(body_text),
                "duration": parse_duration_seconds(own_text) or parse_duration_seconds(block_text),
                "size_bytes": parse_size_bytes(own_text) or parse_size_bytes(block_text),
                "tags": [t.lower() for t in block_hashtags][:8],
            })

        posts.append({
            "post_id": post_id,
            "permalink": permalink,
            "author": author,
            "posted_at": posted_at,
            "body_text": body_text[:4000],
            "hashtags": [t.lower() for t in post_hashtags][:12],
            "links": links,
        })

    return posts
