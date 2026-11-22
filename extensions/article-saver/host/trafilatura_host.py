#!/usr/bin/env python3
"""Chrome Native Messaging: fetch article, save Markdown + HTML."""
import ipaddress
import copy
import json
import os
from pathlib import Path
import re
import socket
import struct
import sys
from datetime import datetime
from urllib.parse import urlsplit

MAX_HTML = 8 * 1024 * 1024
# Správa obsahuje HTML už načítané v karte. Nechávame rezervu na JSON/UTF-8.
MAX_MESSAGE = MAX_HTML + 1024 * 1024


def receive():
    header = sys.stdin.buffer.read(4)
    if len(header) != 4:
        return None
    length = struct.unpack("=I", header)[0]
    if not 0 < length <= MAX_MESSAGE:
        raise ValueError("Neplatná veľkosť správy.")
    data = sys.stdin.buffer.read(length)
    if len(data) != length:
        raise ValueError("Neúplná správa.")
    return json.loads(data)


def send(payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def check_url(url):
    if not isinstance(url, str) or len(url) > 4096:
        raise ValueError("Neplatná URL.")
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("Povolené sú iba HTTP/HTTPS stránky.")
    host = parsed.hostname.lower()
    if host == "localhost" or host.endswith(".localhost") or host.endswith(".local"):
        raise ValueError("Lokálne adresy nie sú podporované.")
    try:
        ip = ipaddress.ip_address(host)
        if not ip.is_global:
            raise ValueError("Privátne IP adresy nie sú podporované.")
    except ValueError as ex:
        if "nie sú podporované" in str(ex):
            raise
    return url


def filename(title):
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", title)
    return (value.strip(" .")[:100].strip(" .") or "article")


def md_to_html(md_content, title, url):
    """Render Markdown → HTML s pekným štýlom. Vráti None ak markdown chýba."""
    try:
        import markdown
    except ImportError:
        return None

    md = markdown.Markdown(extensions=['extra', 'tables', 'toc'])
    html_body = md.convert(md_content)

    return f"""<!DOCTYPE html>
<html lang="sk">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
:root {{ --bg: #fafafa; --fg: #222; --meta: #666;
         --accent: #6366f1; --border: #ddd; --code-bg: #f4f4f4; }}
@media (prefers-color-scheme: dark) {{
  :root {{ --bg: #1a1a1a; --fg: #e8e8e8; --meta: #999;
           --accent: #8b5cf6; --border: #333; --code-bg: #252525; }}
}}
* {{ box-sizing: border-box; }}
body {{ max-width: 720px; margin: 40px auto; padding: 0 20px 80px;
       font-family: Georgia, "Times New Roman", serif; font-size: 18px;
       line-height: 1.7; color: var(--fg); background: var(--bg); }}
h1 {{ font-size: 32px; line-height: 1.3; margin-bottom: 8px;
     font-family: -apple-system, sans-serif; font-weight: 700; }}
h2 {{ font-size: 24px; margin-top: 40px; margin-bottom: 16px;
     font-family: -apple-system, sans-serif; font-weight: 600;
     border-bottom: 1px solid var(--border); padding-bottom: 8px; }}
h3 {{ font-size: 20px; margin-top: 32px; margin-bottom: 12px;
     font-family: -apple-system, sans-serif; font-weight: 600; }}
p {{ margin-bottom: 16px; }}
a {{ color: var(--accent); text-decoration: none; }}
a:hover {{ text-decoration: underline; }}
img {{ max-width: 100%; height: auto; margin: 16px 0; border-radius: 8px; }}
blockquote {{ border-left: 4px solid var(--accent); padding-left: 16px;
             margin: 16px 0; color: var(--meta); font-style: italic; }}
code {{ background: var(--code-bg); padding: 2px 6px; border-radius: 4px;
       font-size: 0.9em; font-family: "SF Mono", Monaco, monospace; }}
pre {{ background: var(--code-bg); padding: 16px; border-radius: 8px;
      overflow-x: auto; margin: 16px 0; }}
pre code {{ background: none; padding: 0; }}
ul, ol {{ margin: 16px 0; padding-left: 32px; }}
li {{ margin-bottom: 8px; }}
hr {{ border: none; border-top: 1px solid var(--border); margin: 40px 0; }}
.meta {{ font-size: 14px; color: var(--meta); margin-bottom: 32px;
        padding-bottom: 16px; border-bottom: 1px solid var(--border);
        font-family: -apple-system, sans-serif; }}
table {{ border-collapse: collapse; width: 100%; margin: 16px 0; }}
th, td {{ border: 1px solid var(--border); padding: 8px 12px; text-align: left; }}
th {{ background: var(--code-bg); font-weight: 600; }}
</style>
</head>
<body>
<div class="meta">
  Zdroj: <a href="{url}" target="_blank">{url}</a> ·
  Uložené: {datetime.now().strftime('%d.%m.%Y %H:%M')}
</div>
{html_body}
</body>
</html>"""


def focused_article_html(raw_html):
    """Return the main article without CSS/id hints that can hide valid text.

    Some publishers put the continuation of an article inside a node whose
    class contains words such as ``paywall`` or ``premium``.  Trafilatura's
    generic heuristics correctly treat those names as negative boilerplate
    hints, but on these pages that also discards real article paragraphs.
    Selecting the semantic article body first and then removing presentation
    attributes lets Trafilatura process the complete article structure.
    """
    try:
        from lxml import html as lxml_html

        document = lxml_html.fromstring(raw_html)
        candidates = document.xpath('//*[@itemprop="articleBody"]')
        if not candidates:
            candidates = document.xpath("//article")
        if not candidates:
            return None

        # Niektoré weby rozdelia telo článku na viac blokov (napr. pred a za
        # reklamou/paywallom). Zoberieme všetky nevnorené bloky v poradí.
        candidate_ids = {id(element) for element in candidates}
        top_level = [
            element for element in candidates
            if not any(id(ancestor) in candidate_ids for ancestor in element.iterancestors())
        ]
        if document.xpath('//*[@itemprop="articleBody"]'):
            parts = top_level
        else:
            parts = [max(top_level, key=lambda element: len(" ".join(element.itertext())))]

        bodies = []
        for part in parts:
            article = copy.deepcopy(part)
            # <template> v tele článku môže obsahovať skrytý pokračujúci text.
            for template in article.xpath(".//template"):
                template.tag = "div"

            for unwanted in article.xpath(
                ".//script | .//style | .//noscript | .//iframe | "
                './/section[contains(concat(" ", normalize-space(@class), " "), " ads ")]'
            ):
                parent = unwanted.getparent()
                if parent is not None:
                    parent.remove(unwanted)

            for element in article.iter():
                for attribute in (
                    "class",
                    "id",
                    "style",
                    "hidden",
                    "aria-hidden",
                    "data-rendered-percent",
                ):
                    element.attrib.pop(attribute, None)

            bodies.append(lxml_html.tostring(article, encoding="unicode", method="html"))

        body = "".join(bodies)
        return f"<!doctype html><html><body><article>{body}</article></body></html>"
    except Exception:
        # The unmodified document remains a valid fallback for unusual HTML.
        return None


def extract_markdown(raw_html, url):
    import trafilatura

    candidates = [raw_html]
    focused = focused_article_html(raw_html)
    if focused:
        candidates.append(focused)

    extracted = []
    for candidate in candidates:
        result = trafilatura.extract(
            candidate,
            url=url,
            output_format="markdown",
            include_comments=False,
            include_tables=True,
            favor_recall=True,
        )
        if result and result.strip():
            extracted.append(result.strip())

    return max(extracted, key=len) if extracted else None


def fetch_remote_html(url):
    import requests
    from urllib.parse import urljoin

    current = url
    for _ in range(6):
        check_url(current)
        response = requests.get(
            current,
            timeout=(8, 20),
            allow_redirects=False,
            headers={"User-Agent": "ArticleSaver/1.0 (reader)"},
        )
        if response.status_code in (301, 302, 303, 307, 308):
            redirect = response.headers.get("Location")
            if not redirect:
                raise ValueError("Presmerovanie bez Location.")
            current = urljoin(current, redirect)
            continue
        response.raise_for_status()
        if "html" not in response.headers.get("content-type", "").lower():
            raise ValueError("Odkaz nevrátil HTML.")
        if len(response.content) > MAX_HTML:
            raise ValueError("Stránka je priveľká (>8 MB).")
        return current, response.text

    raise ValueError("Príliš veľa presmerovaní.")


def is_paywalled(raw_html):
    """Zistí, či stránka obsahuje zamknutý (platený) článok."""
    if not raw_html:
        return False
    return bool(re.search(
        r'"isAccessibleForFree"\s*:\s*"?false|data-lock-type="hard"|sme-promobox-teaser',
        raw_html,
        re.IGNORECASE,
    ))


def save_article(url, raw_html=None):
    import trafilatura

    sources = []
    if raw_html is not None:
        if not isinstance(raw_html, str) or not raw_html.strip():
            raise ValueError("Prehliadač neposlal obsah stránky.")
        if len(raw_html.encode("utf-8")) > MAX_HTML:
            raise ValueError("Stránka je priveľká (>8 MB).")
        sources.append((url, raw_html))
        # Diagnostika: posledné HTML z prehliadača, ak by extrakcia bola neúplná.
        try:
            debug_dir = Path.home() / "Documents" / "clanky" / ".debug"
            debug_dir.mkdir(parents=True, exist_ok=True)
            (debug_dir / "posledna_stranka.html").write_text(raw_html, encoding="utf-8")
        except OSError:
            pass

    # A rendered page can remove text that was present in the original server
    # response.  Always try both inputs and keep the more complete extraction.
    try:
        sources.append(fetch_remote_html(url))
    except Exception:
        if not sources:
            raise

    extracted = []
    for source_url, source_html in sources:
        markdown = extract_markdown(source_html, source_url)
        if markdown and markdown.strip():
            extracted.append((len(markdown), source_url, source_html, markdown.strip()))

    if not extracted:
        raise ValueError("Článok sa nepodarilo extrahovať.")

    _, current, selected_html, markdown = max(extracted, key=lambda item: item[0])
    metadata = trafilatura.extract_metadata(selected_html)

    title = (getattr(metadata, "title", None) or urlsplit(current).hostname or "article").strip()
    output_dir = Path.home() / "Documents" / "clanky"
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = filename(title)

    # Priprav plný markdown obsah (s hlavičkou)
    full_md = f"# {title}\n\nZdroj: {current}\n\n---\n\n{markdown.strip()}\n"

    for index in range(10000):
        suffix = f"_{index}" if index else ""
        md_path = output_dir / (stem + suffix + ".md")
        if md_path.exists():
            continue

        # Ulož .md
        with md_path.open("x", encoding="utf-8") as f:
            f.write(full_md)

        # Ulož .html (ak markdown modul existuje)
        html_path = None
        html_content = md_to_html(full_md, title, current)
        if html_content:
            html_path = md_path.with_suffix(".html")
            with html_path.open("w", encoding="utf-8") as f:
                f.write(html_content)

        return {
            "success": True,
            "md_path": str(md_path),
            "html_path": str(html_path) if html_path else None,
            "path": str(md_path),  # spätná kompatibilita
            "title": title,
            "size": len(markdown),
            "paywall": is_paywalled(selected_html),
        }

    raise ValueError("Nedá sa vytvoriť jedinečný názov súboru.")


def main():
    try:
        request = receive()
        if not isinstance(request, dict):
            raise ValueError("Chýba správa.")
        url = check_url(request.get("url"))
        send(save_article(url, request.get("html")))
    except Exception as exc:
        send({"error": str(exc)})


if __name__ == "__main__":
    main()
