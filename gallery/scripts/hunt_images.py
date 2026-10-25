#!/usr/bin/env python3
"""
hunt_images.py — fill and validate show image URLs in gallery/data/shows.json

Ported 2026-10-24 from the spreadsheet version (Gallery Thing/_archive/). The
hunting logic is unchanged; only the data source changed (XLSX -> JSON).

Logic (per project decision, July 2026):
  1. Shows WITH an image URL: HEAD-request it. If the server definitively says
     it's gone (4xx/5xx), clear it so the page falls back to the placeholder
     card. A network failure means "unknown": never clear on that basis.
  2. Shows WITHOUT an image URL:
     a. Find an exhibition-specific page on the gallery site (never trust
        the homepage's imagery). Try common exhibition paths, then links
        whose text/URL matches the show title.
     b. On that page, prefer og:image / twitter:image meta tags.
     c. Fallback: largest plausible <img> ON THE EXHIBITION PAGE ONLY.
     d. If no exhibition page can be reached, leave it blank.

No backup copy is made: the data files are in Git, so history is the backup.

NOTE: needs open network access to gallery websites.
Usage: python3 gallery/scripts/hunt_images.py   (run from anywhere)
"""

import html as htmllib
import json
import re
import ssl
import urllib.parse
import urllib.request
from pathlib import Path

DATA_DIR       = Path(__file__).resolve().parent.parent / "data"
SHOWS_PATH     = DATA_DIR / "shows.json"
GALLERIES_PATH = DATA_DIR / "galleries.json"

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
TIMEOUT = 15

EXHIBITION_PATHS = [
    "/exhibitions", "/exhibitions/current", "/current-exhibitions",
    "/exhibitions-fairs", "/exhibitions-calendar", "/category/exhibitions",
]
# filename fragments that mean "not artwork"
BAD_IMG_WORDS = ("logo", "icon", "favicon", "banner-nav", "header", "footer",
                 "avatar", "social", "instagram", "facebook", "twitter",
                 "arrow", "menu", "cart", "search", "shim", "spacer", "blank")

_ctx = ssl.create_default_context()


def _request(url, method="GET", max_bytes=600_000):
    """Fetch url. Returns (status, final_url, body_text_or_None). Never raises."""
    req = urllib.request.Request(url, method=method, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=_ctx) as r:
            status, final = r.status, r.geturl()
            if method == "HEAD":
                return status, final, None
            raw = r.read(max_bytes)
            charset = r.headers.get_content_charset() or "utf-8"
            return status, final, raw.decode(charset, errors="replace")
    except Exception as e:
        return None, url, None


def link_status(url):
    """Returns 'ok', 'dead', or 'unknown'.

    IMPORTANT: only a definitive HTTP error status (4xx/5xx) means dead.
    A network failure (timeout, DNS, blocked domain) means UNKNOWN — never
    clear a link on that basis. (Lesson learned: running this in a
    network-restricted sandbox once flagged every good link as dead.)
    """
    status, _, _ = _request(url, method="HEAD")
    if status is None:
        # some servers reject HEAD; try a light GET before judging
        status, _, _ = _request(url, method="GET", max_bytes=2048)
    if status is None:
        return "unknown"
    return "ok" if status < 400 else "dead"


def normalize_site(website):
    w = str(website or "").strip()
    if not w:
        return None
    if not w.startswith("http"):
        w = "https://" + w
    return w.rstrip("/")


def meta_image(page_html, base_url):
    """og:image / twitter:image from a page head."""
    for pat in (r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)',
                r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']',
                r'<meta[^>]+name=["\']twitter:image["\'][^>]+content=["\']([^"\']+)'):
        m = re.search(pat, page_html, re.I)
        if m:
            url = htmllib.unescape(m.group(1).strip())
            if url and not url.lower().endswith(".svg"):
                return urllib.parse.urljoin(base_url, url)
    return None


def plausible(url):
    u = url.lower()
    if u.endswith(".svg") or u.startswith("data:"):
        return False
    return not any(w in u for w in BAD_IMG_WORDS)


def largest_img(page_html, base_url):
    """Largest plausible <img> by declared dimensions, else first plausible
    image that HEAD-checks with a real content-length (>40KB)."""
    best, best_area = None, 0
    candidates = []
    for m in re.finditer(r"<img\b[^>]*>", page_html, re.I):
        tag = m.group(0)
        src = re.search(r'src=["\']([^"\']+)', tag)
        if not src:
            continue
        url = urllib.parse.urljoin(base_url, htmllib.unescape(src.group(1)))
        if not plausible(url):
            continue
        w = re.search(r'width=["\']?(\d+)', tag)
        h = re.search(r'height=["\']?(\d+)', tag)
        if w and h:
            area = int(w.group(1)) * int(h.group(1))
            if int(w.group(1)) >= 400 and area > best_area:
                best, best_area = url, area
        else:
            candidates.append(url)
    if best:
        return best
    for url in candidates[:5]:  # unknown dimensions: probe a few by weight
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT, context=_ctx) as r:
                size = int(r.headers.get("Content-Length") or 0)
                if r.status < 400 and size > 40_000:
                    return url
        except Exception:
            continue
    return None


def title_words(show_title):
    words = re.findall(r"[a-z]{4,}", show_title.lower())
    stop = {"exhibition", "gallery", "with", "from", "that", "this", "curated"}
    return [w for w in words if w not in stop]


def find_exhibition_page(site, show_title):
    """Return (url, html) of an exhibition-specific page, or (None, None)."""
    # 1. common exhibition listing paths — often already show-specific enough
    #    to carry the current show's og:image; also a source of show links.
    listing = None
    for path in EXHIBITION_PATHS:
        status, final, body = _request(site + path)
        if status and status < 400 and body:
            listing = (final, body)
            break
    if not listing:
        status, final, body = _request(site)
        if not (status and status < 400 and body):
            return None, None
        listing = (final, body)

    base, body = listing
    # 2. look for a link matching the show title
    words = title_words(show_title)
    best_link, best_score = None, 0
    for m in re.finditer(r'<a\b[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>',
                         body, re.I | re.S):
        href, text = m.group(1), re.sub(r"<[^>]+>", " ", m.group(2)).lower()
        blob = (href + " " + text).lower()
        score = sum(1 for w in words if w in blob)
        if score > best_score and ("exhibit" in href.lower() or score >= 2):
            best_link, best_score = urllib.parse.urljoin(base, href), score
    if best_link and best_score >= max(1, len(words) // 3):
        status, final, page = _request(best_link)
        if status and status < 400 and page:
            return final, page
    # 3. fall back to the listing page itself ONLY if it is exhibition-themed
    if "exhibit" in base.lower():
        return base, body
    return None, None


def hunt(site_url, show_title):
    site = normalize_site(site_url)
    if not site:
        return None, "no website"
    page_url, page = find_exhibition_page(site, show_title)
    if not page:
        return None, "no exhibition page reachable"
    img = meta_image(page, page_url)
    if img:
        return img, f"og:image on {page_url}"
    img = largest_img(page, page_url)
    if img:
        return img, f"largest img on {page_url}"
    return None, f"no usable image on {page_url}"


def main():
    shows_doc = json.loads(SHOWS_PATH.read_text(encoding="utf-8"))
    galleries = {g["id"]: g for g in json.loads(GALLERIES_PATH.read_text(encoding="utf-8"))}

    filled, cleared, skipped = [], [], []
    for show in shows_doc["shows"]:
        gal = galleries.get(show["galleryId"])
        if not gal or gal.get("status") != "open":
            continue
        name = gal["name"]
        existing = (show.get("image") or "").strip()
        if existing:
            verdict = link_status(existing)
            if verdict == "dead":
                show["image"] = None
                cleared.append(f"{name}: dead link removed ({existing[:70]}...)")
            elif verdict == "unknown":
                skipped.append(f"{name}: link unverifiable (network), kept as-is")
            continue
        img, why = hunt(gal.get("website"), show["title"])
        if img:
            show["image"] = img
            filled.append(f"{name}: {why}")
        else:
            skipped.append(f"{name}: {why}")

    SHOWS_PATH.write_text(json.dumps(shows_doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Updated: {SHOWS_PATH}")
    print(f"\nFILLED ({len(filled)}):");  [print("  +", x) for x in filled]
    print(f"\nCLEARED dead links ({len(cleared)}):"); [print("  -", x) for x in cleared]
    print(f"\nSTILL BLANK ({len(skipped)}):"); [print("  .", x) for x in skipped]


if __name__ == "__main__":
    main()
