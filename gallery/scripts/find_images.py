#!/usr/bin/env python3
"""
find_images.py — find artwork images for shows in gallery/data/shows.json

Build 4 (2026-10-28). Runs in the GitHub Action `gallery-images.yml` after
each refresh, and by hand for a dry run. Python 3 standard library only.

For each show with no `image` and with a `url` (its own page on the venue's
site):
  1. GET the page. Anything that isn't a 200 HTML page, bot challenges
     included, is skipped and reported. Never try to get past a challenge.
  2. Candidates: og:image / og:image:url / og:image:secure_url /
     twitter:image first, then artwork attributes in the page body
     (data-enlarge, data-enlarge-srcset, data-img, data-src, srcset, inline
     CSS background-image, plain <img src>). Logos, icons, nav/header/footer
     images, SVGs, data URIs and tracking pixels are ignored. Body images in
     the main content area, and ones whose alt or file name mentions the
     artist or title, go first.
  3. GET each candidate (up to 5): it must be a 200 jpeg/png/webp/gif at
     least 400 px on its longer side (read from the header bytes).
  4. Homepages and listing pages are never used, except when the url is a
     listing page and it's the venue's only show: then an image in the same
     block as the show's title is taken (marked "listing"); failing that, the
     page's artwork, links to image files (slideshows) first (marked
     "listing-fallback"). Josh, 2026-10-28: one plausible image beats none.
     Images whose server mislabels them (binary/octet-stream) are accepted
     only when their header bytes are a real jpeg/png/gif/webp.
  5. An existing image is never overwritten or cleared.

Usage (run from anywhere):
  python3 gallery/scripts/find_images.py
  python3 gallery/scripts/find_images.py --dry-run --seed seed.json [--compare]

  --dry-run   change nothing; write gallery/_review/image-review.html
  --seed F    JSON object {show id: url}, used where a show has no `url` yet
  --compare   (dry run only) also run seeded shows that already have an
              image, ignoring it, so the pick can be compared by eye
"""

import argparse
import html as htmllib
import json
import re
import ssl
import struct
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from html.parser import HTMLParser
from pathlib import Path

GALLERY_DIR    = Path(__file__).resolve().parent.parent
SHOWS_PATH     = GALLERY_DIR / "data" / "shows.json"
GALLERIES_PATH = GALLERY_DIR / "data" / "galleries.json"
REVIEW_PATH    = GALLERY_DIR / "_review" / "image-review.html"

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
TIMEOUT = 20
MAX_PAGE_BYTES = 4_000_000
MAX_IMAGE_HEADER_BYTES = 1_000_000
MAX_CANDIDATES = 5
MIN_LONG_SIDE = 400
IMAGE_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"}
# servers that mislabel images; accepted only when the bytes are a real image
GENERIC_TYPES = {"binary/octet-stream", "application/octet-stream"}
# a link straight to an image file (e.g. Soho Photo's slider: <a class="rsImg" href="....jpg">)
IMAGE_LINK_RE = re.compile(r"\.(?:jpe?g|png|webp|gif)(?:[?#].*)?$", re.I)

META_KEYS = ("og:image", "og:image:url", "og:image:secure_url", "twitter:image")
# body attributes, in order of preference
BODY_ATTRS = ("data-enlarge", "data-enlarge-srcset", "data-img", "data-src",
              "srcset", "style", "src")
SRCSET_ATTRS = {"data-enlarge-srcset", "srcset"}
# a word in a file name, class or id that means "not artwork"
BAD_WORDS = ("logo", "icon", "favicon", "header", "footer", "nav", "navbar",
             "avatar", "sprite", "social", "facebook", "instagram", "twitter",
             "pinterest", "linkedin", "youtube", "share", "pixel", "spacer",
             "blank", "placeholder", "loader", "loading", "arrow", "badge")
TRACKER_HOSTS = ("facebook.com", "facebook.net", "google-analytics.com",
                 "googletagmanager.com", "doubleclick.net", "bat.bing.com",
                 "pinterest.com", "linkedin.com", "twitter.com", "t.co",
                 "scorecardresearch.com", "quantserve.com")
# last path segment of a listing page
LISTING_SEGMENTS = {"", "exhibitions", "exhibits", "exhibition", "current",
                    "current-exhibitions", "whats-on", "on-view", "events",
                    "calendar", "shows", "all-exhibitions", "index.html"}
CHALLENGE_MARKERS = ("<title>just a moment", "cf-chl-", "cf_chl_",
                     "attention required! | cloudflare",
                     "enable javascript and cookies to continue",
                     "vercel security checkpoint", "_vercel_challenge",
                     "px-captcha", "captcha-delivery.com",
                     "please verify you are a human")
STOP_WORDS = {"the", "and", "with", "from", "that", "this", "exhibition",
              "gallery", "works", "work", "recent", "new", "york", "photographs",
              "photography", "selected", "present", "years", "group", "show"}

_ctx = ssl.create_default_context()


# ---------------------------------------------------------------- fetching

def fetch(url, accept, max_bytes):
    """GET url. Returns (status, final_url, headers, body_bytes, error)."""
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Accept": accept, "Accept-Language": "en-US,en;q=0.9"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=_ctx) as r:
            return r.status, r.geturl(), r.headers, r.read(max_bytes), None
    except urllib.error.HTTPError as e:
        try:
            body = e.read(200_000)
        except Exception:
            body = b""
        return e.code, url, e.headers, body, None
    except Exception as e:
        return None, url, None, b"", f"{type(e).__name__}: {e}"


def is_challenge(status, headers, body):
    text = body[:200_000].decode("utf-8", errors="replace").lower()
    if any(m in text for m in CHALLENGE_MARKERS):
        return True
    if status in (403, 429, 503) and headers is not None and (
            headers.get("cf-mitigated") or "cloudflare" in (headers.get("server") or "").lower()
            or headers.get("x-vercel-mitigated")):
        return True
    return False


def get_page(url):
    """Returns (html_text, final_url, None) or (None, None, why_skipped)."""
    status, final, headers, body, err = fetch(
        url, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", MAX_PAGE_BYTES)
    if err:
        return None, None, f"page unreachable ({err})"
    if is_challenge(status, headers, body):
        return None, None, f"blocked: bot challenge (HTTP {status})"
    if status != 200:
        return None, None, f"page HTTP {status}"
    ctype = (headers.get_content_type() if headers else "") or ""
    if ctype not in ("text/html", "application/xhtml+xml"):
        return None, None, f"page is not HTML ({ctype})"
    charset = headers.get_content_charset() or "utf-8"
    return body.decode(charset, errors="replace"), final, None


# ------------------------------------------------------------ image checks

def image_size(data):
    """(width, height) from the header bytes of a jpeg/png/gif/webp, or None."""
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        return struct.unpack(">II", data[16:24])
    if data[:6] in (b"GIF87a", b"GIF89a") and len(data) >= 10:
        return struct.unpack("<HH", data[6:10])
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP" and len(data) >= 30:
        chunk = data[12:16]
        if chunk == b"VP8 ":
            w, h = struct.unpack("<HH", data[26:30])
            return w & 0x3FFF, h & 0x3FFF
        if chunk == b"VP8L":
            b = data[21:25]
            w = 1 + (((b[1] & 0x3F) << 8) | b[0])
            h = 1 + (((b[3] & 0x0F) << 10) | (b[2] << 2) | ((b[1] & 0xC0) >> 6))
            return w, h
        if chunk == b"VP8X":
            w = 1 + int.from_bytes(data[24:27], "little")
            h = 1 + int.from_bytes(data[27:30], "little")
            return w, h
        return None
    if data[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7 or marker == 0xFF:
                i += 1 if marker == 0xFF else 2
                continue
            seg_len = struct.unpack(">H", data[i + 2:i + 4])[0]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                h, w = struct.unpack(">HH", data[i + 5:i + 9])
                return w, h
            i += 2 + seg_len
    return None


def check_image(url):
    """Returns (True, "WxH type") or (False, why)."""
    status, _, headers, body, err = fetch(
        url, "image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.5",
        MAX_IMAGE_HEADER_BYTES)
    if err:
        return False, f"unreachable ({err})"
    if status != 200:
        return False, f"HTTP {status}"
    ctype = headers.get_content_type() if headers else ""
    if ctype in GENERIC_TYPES and image_size(body):
        ctype = f"{ctype}, image by its header bytes"   # e.g. S3 serving PNGs as binary/octet-stream
    elif ctype not in IMAGE_TYPES:
        return False, f"type {ctype}"
    size = image_size(body)
    if not size:
        return False, f"can't read size ({ctype})"
    if max(size) < MIN_LONG_SIDE:
        return False, f"too small ({size[0]}x{size[1]})"
    return True, f"{size[0]}x{size[1]} {ctype}"


# ----------------------------------------------------------- page parsing

VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
        "meta", "source", "track", "wbr"}


def tokens(s):
    return re.findall(r"[a-z0-9]+", urllib.parse.unquote(s or "").lower())


BAD_RE = re.compile(r"^(?:%s)(?:s|\d+)?$|(?:logo|icon)s?\d*$" % "|".join(BAD_WORDS))


def has_bad_word(s):
    """True for "logo", "icons", "nav2", "sitelogo"; not for "iconic" or "navy"."""
    return any(BAD_RE.search(t) for t in tokens(s))


class PageParser(HTMLParser):
    """Collects meta images, body image candidates and title positions.

    Each candidate and text run gets a sequence number (`pos`) so listing
    mode can measure how near an image is to the show's title.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []        # (tag, attrs dict, element number)
        self.meta = {}         # key -> [content, ...]
        self.cands = []        # dicts
        self.texts = []        # (pos, text, chain of element numbers)
        self.pos = 0
        self.n = 0
        self.skip_text = 0     # inside script/style

    def _in(self, pred):
        return any(pred(t, a) for t, a, _ in self.stack)

    def _chain(self, own=None):
        return tuple(n for _, _, n in self.stack) + ((own,) if own else ())

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta":
            key = (a.get("property") or a.get("name") or "").strip().lower()
            if key in META_KEYS and a.get("content"):
                self.meta.setdefault(key, []).append(a["content"].strip())
            return
        if tag in ("script", "style", "noscript", "template"):
            self.skip_text += 1
        self.pos += 1
        self.n += 1
        alt = " ".join(a.get(k, "") for k in ("alt", "title", "aria-label"))
        if alt.strip():
            self.texts.append((self.pos, alt, self._chain(self.n)))
        self._collect(tag, a)
        if tag not in VOID:
            self.stack.append((tag, a, self.n))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID and self.stack and self.stack[-1][0] == tag:
            self.stack.pop()

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript", "template") and self.skip_text:
            self.skip_text -= 1
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        if not self.skip_text and data.strip():
            self.pos += 1
            self.texts.append((self.pos, data, self._chain()))

    def _collect(self, tag, a):
        own = " ".join((a.get("class", ""), a.get("id", "")))
        names = lambda x: x.get("id", "") + " " + x.get("class", "")
        # "main-header" is a header, not main content
        in_main = self._in(lambda t, x: t not in ("header", "nav", "footer") and not has_bad_word(names(x))
                           and (t in ("main", "article") or x.get("role") == "main"
                                or any(w in ("main", "content") for w in tokens(names(x)))))
        chrome = (self._in(lambda t, x: t in ("nav", "footer"))
                  or self._in(lambda t, x: any(BAD_RE.search(w) for w in tokens(names(x))
                                              if w.startswith("logo") or w.endswith("logo")))
                  or (not in_main and self._in(lambda t, x: t == "header")))
        try:
            w, h = int(a.get("width") or 0), int(a.get("height") or 0)
        except ValueError:
            w = h = 0
        tiny = (w and w <= 2) or (h and h <= 2)
        for rank, attr in enumerate(BODY_ATTRS):
            val = a.get(attr, "")
            if not val:
                continue
            if attr == "style":
                m = re.search(r"background(?:-image)?\s*:[^;]*url\(\s*['\"]?([^'\")]+)", val, re.I)
                if not m:
                    continue
                url = m.group(1)
            elif attr == "src" and tag != "img":
                continue
            elif attr in SRCSET_ATTRS:
                url = largest_from_srcset(val)
            else:
                url = val.strip()
            if not url:
                continue
            self._add(url, attr, rank, in_main, a, chrome, tiny, own)
        href = a.get("href", "").strip()
        if tag == "a" and href and IMAGE_LINK_RE.search(href):
            self._add(href, "a href (image file)", len(BODY_ATTRS), in_main, a, chrome, tiny, own)

    def _add(self, url, attr, rank, in_main, a, chrome, tiny, own):
        self.cands.append({
            "url": htmllib.unescape(url.strip()), "attr": attr, "rank": rank,
            "pos": self.pos, "chain": self._chain(self.n), "in_main": in_main, "alt": a.get("alt", ""),
            "excluded": bool(chrome or tiny or has_bad_word(own) or has_bad_word(a.get("alt", ""))),
        })


def largest_from_srcset(val):
    """Largest entry of a srcset. URLs may contain commas (Artlogic's
    "w_1200,h_630"), so split the way browsers do: a URL runs to the next
    whitespace, its descriptor to the next comma."""
    best, best_w = None, -1
    i, n = 0, len(val)
    while i < n:
        while i < n and (val[i].isspace() or val[i] == ","):
            i += 1
        j = i
        while j < n and not val[j].isspace():
            j += 1
        url, desc = val[i:j], ""
        if url.endswith(","):
            url, i = url.rstrip(","), j
        else:
            k = val.find(",", j)
            k = n if k < 0 else k
            desc, i = val[j:k].strip(), k + 1
        if not url:
            continue
        w = 0
        d = re.match(r"([\d.]+)([wx])", desc)
        if d:
            w = float(d.group(1)) * (1 if d.group(2) == "w" else 1000)
        if w > best_w:
            best, best_w = url, w
    return best


def absolute(base, url):
    """Resolve url against base, fixing two forms seen in the wild: a
    scheme-less "host.com/path" and unescaped spaces."""
    url = url.strip()
    if re.match(r"^[a-z0-9-]+(\.[a-z0-9-]+)+/", url, re.I):
        url = "https://" + url
    return urllib.parse.quote(urllib.parse.urljoin(base, url), safe=":/?#[]@!$&'()*+,;=%~")


def usable_url(url):
    """Why a candidate URL is ruled out by its form alone, or None."""
    u = url.lower()
    if u.startswith("data:"):
        return "data URI"
    p = urllib.parse.urlparse(u)
    if p.scheme not in ("http", "https"):
        return "not http"
    if p.path.endswith(".svg"):
        return "SVG"
    host = p.hostname or ""
    if any(host == t or host.endswith("." + t) for t in TRACKER_HOSTS):
        return "tracker"
    if has_bad_word(p.path.rsplit("/", 1)[-1]):
        return "logo/icon file name"
    return None


# ------------------------------------------------------------- the finder

def key_words(show):
    words = tokens(show.get("title", "")) + tokens(show.get("artists") or "")
    return {w for w in words if len(w) >= 4 and w not in STOP_WORDS}


def mentions(c, words):
    blob = set(tokens(c["alt"])) | set(tokens(urllib.parse.urlparse(c["url"]).path.rsplit("/", 1)[-1]))
    return bool(words & blob)


def site_key(url):
    p = urllib.parse.urlparse(url if "//" in url else "https://" + url)
    host = (p.hostname or "").lower()
    host = host[4:] if host.startswith("www.") else host
    return host, p.path.rstrip("/").lower()


def is_listing(url, gallery):
    """True when url is the venue's homepage or an exhibitions listing."""
    key = site_key(url)
    for other in (gallery.get("website"), gallery.get("exhibitionsUrl")):
        if other and site_key(other) == key:
            return True
    return key[1].rsplit("/", 1)[-1] in LISTING_SEGMENTS


LISTING_MAX_LEVELS = 3


def title_spots(texts, title):
    """(pos, chain) of every text or alt that contains the whole title."""
    want = " ".join(tokens(title))
    if not want:
        return []
    pat = re.compile(r"(?:^| )" + re.escape(want) + r"(?: |$)")
    return [(pos, chain) for pos, t, chain in texts if pat.search(" ".join(tokens(t)))]


def levels_apart(title_chain, img_chain):
    """How many levels up from the title the image's block starts."""
    common = 0
    for a, b in zip(title_chain, img_chain):
        if a != b:
            break
        common += 1
    return len(title_chain) - common


def is_venue_name(c, gallery):
    """An image whose alt text is just the venue's name is its logo."""
    alt = " ".join(tokens(c["alt"]))
    return bool(alt) and alt in (" ".join(tokens(gallery.get("name", ""))),
                                 " ".join(tokens(gallery.get("name", "")))[:len(alt)])


def find_image(show, url, gallery, venue_show_count):
    """Returns a result dict: image, rule, why, tried."""
    res = {"url": url, "image": None, "rule": None, "why": None, "tried": []}
    listing = is_listing(url, gallery)
    if listing and venue_show_count != 1:
        res["why"] = "url is a homepage or listing page, and the venue has other shows"
        return res
    page, final, err = get_page(url)
    if err:
        res["why"] = err
        return res
    parser = PageParser()
    try:
        parser.feed(page)
        parser.close()
    except Exception as e:
        res["why"] = f"couldn't parse page ({type(e).__name__})"
        return res

    ordered, seen = [], set()

    def add(img_url, rule):
        absu = absolute(final, img_url)
        if absu not in seen and not usable_url(absu):
            seen.add(absu)
            ordered.append((absu, rule))

    if listing:
        # Only images in the same block as the title (a card, a slide), so a
        # neighbouring show's or event's image is never taken.
        spots = title_spots(parser.texts, show.get("title", ""))
        if not spots:
            res["why"] = "listing page: show title not found in the HTML"
            return res
        near = []
        for c in parser.cands:
            d = [abs(c["pos"] - p) for p, ch in spots if levels_apart(ch, c["chain"]) <= LISTING_MAX_LEVELS]
            if d and not c["excluded"] and not is_venue_name(c, gallery):
                near.append((min(d), c["rank"], c))
        if near:
            for _, _, c in sorted(near, key=lambda x: x[:2]):
                add(c["url"], "listing")
        else:
            # Josh (2026-10-28): for a venue's only show, one plausible image
            # beats none. Fall back to the page's artwork, links to image files
            # (slideshows) first, and tag the pick so it's visible in the report.
            rest = [c for c in parser.cands if not c["excluded"] and not is_venue_name(c, gallery)]
            rest.sort(key=lambda c: (c["attr"] != "a href (image file)", not c["in_main"], c["rank"], c["pos"]))
            for c in rest:
                add(c["url"], "listing-fallback")
            if not rest:
                res["why"] = "listing page: no image in the same block as the show's title, and no other artwork"
                return res
    else:
        for key in META_KEYS:
            for v in parser.meta.get(key, []):
                add(v, key)
        words = key_words(show)
        body = [c for c in parser.cands if not c["excluded"] and not is_venue_name(c, gallery)]
        body.sort(key=lambda c: (not c["in_main"], not mentions(c, words), c["rank"], c["pos"]))
        for c in body:
            add(c["url"], c["attr"] + (" (alt/name match)" if mentions(c, words) else ""))

    if not ordered:
        res["why"] = "no candidate images on the page"
        return res
    for img_url, rule in ordered[:MAX_CANDIDATES]:
        ok, info = check_image(img_url)
        res["tried"].append((img_url, rule, info))
        if ok:
            res["image"], res["rule"] = img_url, rule
            return res
    res["why"] = f"none of the first {min(len(ordered), MAX_CANDIDATES)} candidates passed"
    return res


# ----------------------------------------------------------------- output

def report_line(show, gallery, res):
    head = f"{gallery.get('name', show['galleryId'])}: {show['title']}"
    if res["image"]:
        out = [f"  + {head}\n      [{res['rule']}] {res['image']}"]
    else:
        out = [f"  . {head}\n      none: {res['why']}"]
    for u, rule, info in res["tried"]:
        if u != res["image"]:
            out.append(f"      tried [{rule}] {info}: {u}")
    return "\n".join(out)


def write_review(rows, path):
    esc = htmllib.escape
    groups = [("Photography shows with no image", "missing"),
              ("Not yet classified (isPhotography null), no image", "unclassified"),
              ("Comparison: shows that already have an image", "compare")]
    found = sum(1 for r in rows if r["group"] != "compare" and r["res"]["image"])
    blocked = sum(1 for r in rows if r["group"] != "compare" and not r["res"]["image"]
                  and (r["res"]["why"] or "").startswith("blocked"))
    total = sum(1 for r in rows if r["group"] != "compare")
    parts = [f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Image review</title>
<style>
body {{ font: 15px/1.4 -apple-system, system-ui, sans-serif; margin: 0 auto; max-width: 1100px; padding: 16px; background: #f6f4f0; color: #1a1a1e; }}
h1 {{ font-size: 22px; }} h2 {{ margin-top: 40px; font-size: 18px; border-bottom: 1px solid #d8d3ca; }}
.show {{ display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 16px; padding: 16px 0; border-bottom: 1px solid #d8d3ca; }}
.show.single {{ grid-template-columns: minmax(0,1fr); }}
.meta {{ grid-column: 1 / -1; }}
.venue {{ color: #8a8278; text-transform: uppercase; font-size: 12px; letter-spacing: .05em; }}
.title {{ font-weight: 600; }}
figure {{ margin: 0; }} figure img {{ max-width: 100%; max-height: 420px; display: block; background: #ece8e1; }}
figcaption {{ font-size: 12px; color: #8a8278; word-break: break-all; margin-top: 4px; }}
.none {{ padding: 24px; background: #ece8e1; color: #c02818; }}
.rule {{ display: inline-block; background: #1a1a1e; color: #fff; font-size: 11px; padding: 1px 6px; border-radius: 3px; }}
.rule.listing {{ background: #c02818; }}
details {{ font-size: 12px; color: #8a8278; }} details li {{ word-break: break-all; }}
@media (max-width: 640px) {{ .show {{ grid-template-columns: minmax(0,1fr); }} }}
</style></head><body>
<h1>Build 4 image finder: dry run {date.today().isoformat()}</h1>
<p>Found {found} of {total} shows with no image ({blocked} blocked by bot challenges).
Images are loaded straight from the venues' sites; nothing is copied into the repo.
A red <span class="rule listing">listing</span> tag means the pick came from a listing page,
nearest the show's title.</p>
"""]
    for heading, g in groups:
        sel = [r for r in rows if r["group"] == g]
        if not sel:
            continue
        parts.append(f"<h2>{esc(heading)} ({len(sel)})</h2>")
        for r in sel:
            show, res = r["show"], r["res"]
            cls = "show" if g == "compare" else "show single"
            parts.append(f'<div class="{cls}"><div class="meta">'
                         f'<div class="venue">{esc(r["venue"])}</div>'
                         f'<div class="title">{esc(show["title"])}</div>'
                         f'<div>{esc(show.get("artists") or "Group Exhibition")}</div>'
                         f'<div><a href="{esc(res["url"])}">{esc(res["url"])}</a></div></div>')
            if res["image"]:
                rcls = "rule listing" if res["rule"] == "listing" else "rule"
                parts.append(f'<figure><img src="{esc(res["image"])}" loading="lazy" referrerpolicy="no-referrer" alt="">'
                             f'<figcaption>Picked by <span class="{rcls}">{esc(res["rule"])}</span> '
                             f'{esc(res["image"])}</figcaption></figure>')
            else:
                parts.append(f'<div class="none">None: {esc(res["why"] or "")}</div>')
            if g == "compare":
                parts.append(f'<figure><img src="{esc(r["existing"])}" loading="lazy" referrerpolicy="no-referrer" alt="">'
                             f'<figcaption>Existing image (known good): {esc(r["existing"])}</figcaption></figure>')
            tried = [t for t in res["tried"] if t[0] != res["image"]]
            if tried:
                parts.append('<details class="meta"><summary>Rejected candidates</summary><ul>' +
                             "".join(f"<li>[{esc(rule)}] {esc(info)}: {esc(u)}</li>" for u, rule, info in tried) +
                             "</ul></details>")
            parts.append("</div>")
    parts.append("</body></html>\n")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(parts), encoding="utf-8")


# ------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--dry-run", action="store_true", help="change nothing; write the review page")
    ap.add_argument("--seed", type=Path, help="JSON {show id: url} for shows with no url yet")
    ap.add_argument("--compare", action="store_true",
                    help="dry run only: also run seeded shows that already have an image")
    args = ap.parse_args()
    if args.compare and not args.dry_run:
        ap.error("--compare needs --dry-run")

    shows_doc = json.loads(SHOWS_PATH.read_text(encoding="utf-8"))
    galleries = {g["id"]: g for g in json.loads(GALLERIES_PATH.read_text(encoding="utf-8"))}
    seed = json.loads(args.seed.read_text(encoding="utf-8")) if args.seed else {}

    counts = {}
    for s in shows_doc["shows"]:
        counts[s["galleryId"]] = counts.get(s["galleryId"], 0) + 1

    jobs = []
    for show in shows_doc["shows"]:
        url = show.get("url") or seed.get(show["id"])
        if not url:
            continue
        existing = (show.get("image") or "").strip()
        if existing and not (args.compare and show["id"] in seed):
            continue
        group = "compare" if existing else (
            "unclassified" if show.get("isPhotography") is None else "missing")
        jobs.append((show, url, group, existing))

    gal = lambda s: galleries.get(s["galleryId"], {})
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(
            lambda j: find_image(j[0], j[1], gal(j[0]), counts[j[0]["galleryId"]]), jobs))

    rows, changed = [], 0
    for (show, url, group, existing), res in zip(jobs, results):
        rows.append({"show": show, "res": res, "group": group, "existing": existing,
                     "venue": gal(show).get("name", show["galleryId"])})
        if not args.dry_run and res["image"] and not (show.get("image") or "").strip():
            show["image"] = res["image"]
            changed += 1

    for heading, g in (("NO IMAGE", "missing"), ("NO IMAGE, NOT YET CLASSIFIED", "unclassified"),
                       ("COMPARISON (existing image ignored)", "compare")):
        sel = [r for r in rows if r["group"] == g]
        if sel:
            n = sum(1 for r in sel if r["res"]["image"])
            print(f"\n{heading}: found {n} of {len(sel)}")
            for r in sel:
                print(report_line(r["show"], gal(r["show"]), r["res"]))

    if args.dry_run:
        write_review(rows, REVIEW_PATH)
        print(f"\nDry run: shows.json not changed. Review page: {REVIEW_PATH}")
    elif changed:
        SHOWS_PATH.write_text(json.dumps(shows_doc, ensure_ascii=False, indent=2) + "\n",
                              encoding="utf-8")
        print(f"\nAdded {changed} image(s) to {SHOWS_PATH}")
    else:
        print("\nNo images added; shows.json not changed.")


if __name__ == "__main__":
    sys.exit(main())
