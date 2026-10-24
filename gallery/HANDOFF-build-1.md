# Gallery Thing — Build 1 Handoff: Migrate into `gallery/` (parity only)
**Written:** 2026-10-24 (Cowork, from the planning session with Josh)
**For:** Claude Code on the AI Workshop
**Read first:** `gallery/PROJECT_BRIEF.md` (committed in step 1)

---

## Goal

Move the NYC Photo Shows page from a Python-generated single file (`Gallery_Brief.html` at the repo root) to plain static files under `gallery/` that load JSON data at runtime. **The page must look and behave exactly as it does today.** No new features, no redesign, no data edits.

## Before starting (Josh, by hand)

- [ ] Add `joshseiden/photography-portfolio` to the `agent` account's existing fine-grained GitHub token (contents + pull requests: read/write). Step-by-step: `START-BUILD-1.md`
- [ ] Clone the repo on the mini under the `agent` account (`~/Projects/photography-portfolio`)
- [ ] In the Netlify dashboard, confirm deploy previews are on for pull requests on this site
- [ ] Smoke test: a trivial branch + PR produces a deploy preview
- [ ] Send the inputs below with `sendasset` (they land in `/tmp/design-reference/`)

## Inputs (from Josh's Dropbox: `Gallery Thing/migration/`)

| File | Goes to | Notes |
|---|---|---|
| `PROJECT_BRIEF.md` | `gallery/PROJECT_BRIEF.md` | The authoritative brief from now on |
| `HANDOFF-build-1.md` | `gallery/HANDOFF-build-1.md` | This file |
| `data/galleries.json`, `data/shows.json` | `gallery/data/` | Seed data. Do not edit values |
| `scripts/hunt_images.py` | `gallery/scripts/` | Already ported to JSON; commit as-is |
| `reference-generate_brief-v3.py` | **do not commit** | Reference only: the page template, `load_entries()` logic, `NEIGHBORHOOD_COLORS`, `_FALLBACK_COLORS` |

The live page itself (root `Gallery_Brief.html` on `main`) is the visual reference.

## Steps (branch `build/gallery-migration`; one PR; don't merge)

1. **Scaffold.** Create `gallery/` with the brief, this handoff, `data/`, `scripts/`. Commit.
2. **Extract the page.** From the generator template, produce `gallery/index.html`, `gallery/style.css`, `gallery/app.js`:
   - Un-double the f-string braces (`{{` → `{`).
   - Replace the embedded `const NEIGHBORHOODS = …` / `const SHOWS = …` with: fetch both JSON files, join shows to galleries (`galleryId`), keep only `status: "open"` galleries, and build the same SHOWS objects the page already expects (`id, gallery, artist, title, neighborhood, address, hours, website, closing, daysLeft, isOngoing, isMuseum, thumb, lat, lng`). Mapping: `artist` = `artists` or "Group Exhibition"; `closing` = ISO date or null; `isOngoing` = `closes === "ongoing"`; `thumb` = `image`.
   - Compute `daysLeft`, the "Current exhibitions — <Month Year>" label and the neighborhood colors in the browser (they used to be computed in Python at build time). Use the generator's color table + fallback palette.
   - Keep localStorage keys `gallery-savedIds` / `gallery-seenIds` exactly.
   - Map: Esri Dark Gray Base + Reference layers as specified in the brief (the generator already contains this).
   - Show a plain error message if the data files fail to load.
3. **Redirect + remove.** Add root `_redirects`:
   ```
   /Gallery_Brief.html  /gallery/  301
   /Gallery_Brief       /gallery/  301
   ```
   Delete root `Gallery_Brief.html` (git history keeps it).
4. **Verify in the deploy preview** (`<preview-url>/gallery/`), side by side with the live page:
   - [ ] Same number of cards as the live page, same order and grouping
   - [ ] Filters: All, Closing Soon, My Visit, each neighborhood chip
   - [ ] Closing-soon stripes/badges; seen and saved styling; placeholder cards for shows without images
   - [ ] Save + Mark Seen persist across reloads (localStorage)
   - [ ] Walk mode: map tiles + street labels load, markers for saved shows only, bottom sheet order (unseen first)
   - [ ] Detail overlay: hours, website link, image
   - [ ] `<preview-url>/Gallery_Brief.html` redirects to `/gallery/`
   - [ ] No console errors; mobile width (375px) and desktop (480px centered) both correct
   - [ ] Portfolio pages (`/`, `/about.html`, `/contact.html`) unchanged
5. **PR.** Describe what moved, the verification results (with screenshots), and anything that didn't match. Update the brief's Current State. Notify Josh (Pushover). **Do not merge.**

## Rules

- Touch only `gallery/` and the root `_redirects`. Never edit portfolio files (`index.html`, `about.html`, `contact.html`, `style.css`, `images/`).
- Never force-push. Josh merges.
- No new features (cross-device state is Build 2). No data edits, no id changes.
- A weekend refresh may push to `main` during the build (it still regenerates root `Gallery_Brief.html` until cutover). Rebase on `main` before opening the PR; if root `Gallery_Brief.html` changed, still delete it.

## After the PR (not part of this build: Josh + Cowork)

Cutover in one sitting: pause the weekend task → Cowork regenerates `galleries.json`/`shows.json` from the latest spreadsheet if it changed since the seed (committed to the PR branch) → Josh merges → Cowork rewrites the weekend task to edit `gallery/data/*.json` in a fresh clone (Josh approves) → resume the task → check the first run.
