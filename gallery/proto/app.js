// NYC Photo Shows — LAYOUT PROTOTYPE v1 (gallery/proto/). Not production.
//
// Forked from ../app.js on 2026-11-07 to try four design changes:
//   1. Desktop layout: filter sidebar + card grid; detail opens as a side
//      drawer; Walk mode puts the list beside the map.
//   2. Filters split into two independent questions: "Show" (All / Closing
//      soon / My visit, plus Hidden and Not photography) and "Where"
//      (borough → neighborhood). They combine, e.g. Closing soon in Chelsea.
//   3. A color for every neighborhood, grouped by borough (no more grey),
//      and neighborhoods listed in geographic order.
//   4. Galleries with several locations (data model sketch: gallery.locations[]
//      + show.locationId). Demo data for Gagosian and Jack Shainman below is
//      ILLUSTRATIVE; which show is at which space isn't verified.
//
// Sync is removed on purpose: the Netlify store is shared by previews and
// production, so the prototype must not write to it. State stays in this
// browser under its own localStorage key.

const TODAY = new Date(new Date().toDateString());

// ─── NEIGHBORHOODS ───
// Order = geographic, roughly south → north within each borough.
// Manhattan: cool blues/violets/teals. Brooklyn: warm rust/brown.
// Queens: golds. Bronx: green-teal. Staten Island: plum.
// Every color passes 4.5:1 against the paper color, for active chips.
const BOROUGHS = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'];
const NEIGHBORHOODS = {
  "Tribeca":                    { b: "Manhattan", color: "#3a4f7a" },
  "SoHo":                       { b: "Manhattan", color: "#4a4a8a" },
  "Lower East Side":            { b: "Manhattan", color: "#2d6e48" },
  "East Village":               { b: "Manhattan", color: "#1f6b5e" },
  "Greenwich Village":          { b: "Manhattan", color: "#3d5c8c" },
  "West Village":               { b: "Manhattan", color: "#4a5a1a" },
  "Meatpacking District":       { b: "Manhattan", color: "#5b4b86" },
  "Chelsea":                    { b: "Manhattan", color: "#344e8a" },
  "NoMad":                      { b: "Manhattan", color: "#2f6a7c" },
  "Hell's Kitchen":             { b: "Manhattan", color: "#46607a" },
  "Midtown":                    { b: "Manhattan", color: "#1a6a6a" },
  "Upper West Side":            { b: "Manhattan", color: "#1a5c8a" },
  "Upper East Side":            { b: "Manhattan", color: "#5a3a7a" },
  "Harlem":                     { b: "Manhattan", color: "#3f4a96" },
  "East Harlem":                { b: "Manhattan", color: "#7a3f6e" },
  "DUMBO, Brooklyn":            { b: "Brooklyn",  color: "#8a4a1a" },
  "Brooklyn Heights, Brooklyn": { b: "Brooklyn",  color: "#7a5a1a" },
  "Red Hook, Brooklyn":         { b: "Brooklyn",  color: "#7d4d36" },
  "Fort Greene, Brooklyn":      { b: "Brooklyn",  color: "#9a3a2a" },
  "Prospect Heights, Brooklyn": { b: "Brooklyn",  color: "#6a3a1a" },
  "Sunset Park, Brooklyn":      { b: "Brooklyn",  color: "#7a2a4a" },
  "Long Island City, Queens":   { b: "Queens",    color: "#6e621a" },
  "Astoria, Queens":            { b: "Queens",    color: "#85651c" },
  "Flushing Meadows, Queens":   { b: "Queens",    color: "#6a5414" },
  "South Bronx":                { b: "Bronx",     color: "#2a5a4a" },
  "Rosebank, Staten Island":    { b: "Staten Island", color: "#6a2a6a" },
};
const HOOD_ORDER = Object.keys(NEIGHBORHOODS);

function boroughFromName(n) {
  if (/Brooklyn/.test(n)) return 'Brooklyn';
  if (/Queens/.test(n)) return 'Queens';
  if (/Bronx/.test(n)) return 'Bronx';
  if (/Staten Island/.test(n)) return 'Staten Island';
  return 'Manhattan';
}
// Unknown neighborhoods get a neutral warm grey and sort last in their borough.
function hoodInfo(n) { return NEIGHBORHOODS[n] || { b: boroughFromName(n), color: '#5c5650' }; }
function hoodRank(n) {
  const i = HOOD_ORDER.indexOf(n);
  return BOROUGHS.indexOf(hoodInfo(n).b) * 100 + (i < 0 ? 99 : i);
}
function shortHood(n) { return n.replace(/, (Brooklyn|Queens|Staten Island)$/, ''); }

// ─── MULTI-LOCATION DEMO DATA (illustrative) ───
// Proposed model: a gallery may carry `locations` (first = main space); a show
// may carry `locationId`. A show's neighborhood, address and map pin come from
// its location. Here we patch it in after loading, since the data doesn't
// have it yet.
const DEMO_LOCATIONS = {
  'gagosian-gallery': [
    { id: 'w24',     label: '555 W 24th',   address: '555 West 24th St, NY 10011', neighborhood: 'Chelsea',         lat: 40.749436, lng: -74.005964 },
    { id: 'w21',     label: '522 W 21st',   address: '522 West 21st St, NY 10011', neighborhood: 'Chelsea',         lat: 40.746620, lng: -74.006870 },
    { id: 'madison', label: '980 Madison',  address: '980 Madison Ave, NY 10075',  neighborhood: 'Upper East Side', lat: 40.775690, lng: -73.963150 },
    { id: 'park',    label: '821 Park Ave', address: '821 Park Ave, NY 10021',     neighborhood: 'Upper East Side', lat: 40.773540, lng: -73.961700 },
  ],
  'jack-shainman-gallery': [
    { id: 'w20',       label: '513 W 20th',   address: '513 W 20th St, NY 10011',  neighborhood: 'Chelsea', lat: 40.746259, lng: -74.006298 },
    { id: 'w24',       label: '524 W 24th',   address: '524 W 24th St, NY 10011',  neighborhood: 'Chelsea', lat: 40.748650, lng: -74.005120 },
    { id: 'lafayette', label: '46 Lafayette', address: '46 Lafayette St, NY 10013', neighborhood: 'Tribeca', lat: 40.715830, lng: -74.002700 },
  ],
};
const DEMO_SHOW_LOCATIONS = {
  'gagosian-gallery::i-am-plane-image': 'madison',
  'gagosian-gallery::groomed': 'w21',
};

// ─── STATE ───
let SHOWS = [];
let currentMode  = 'plan';
let activeView   = 'all';   // all | closing | saved | hidden | notphoto
let whereBorough = null;    // null = all of NYC
let whereHood    = null;    // a neighborhood, or null
let layout       = 'mobile';
let forcePhone   = false;

let savedKeys = new Set();
let seenKeys  = new Set();
let hiddenMap = new Map();

let walkMap = null;
let walkMarkers = {};

const STORE_KEY = 'gallery-proto-state';

function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
function showKeyFor(galleryId, title) { return `${galleryId}::${slugify(title)}`; }
function findShow(id) { return SHOWS.find(s => s.id === id); }

function persistLocalState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      saved: [...savedKeys], seen: [...seenKeys], hidden: [...hiddenMap.values()],
    }));
  } catch {}
}
function loadLocalState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (raw) {
      savedKeys = new Set(raw.saved || []);
      seenKeys  = new Set(raw.seen || []);
      hiddenMap = new Map((raw.hidden || []).map(h => [h.key, h]));
    }
  } catch {}
}

function daysUntil(d) { if (!d) return null; return Math.round((new Date(d) - TODAY) / 86400000); }
function fmtDate(s) { return new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
function mapsUrl(address) { return 'https://maps.apple.com/?address=' + encodeURIComponent(address); }

// ─── LAYOUT ───
function computeLayout() {
  const next = (!forcePhone && window.innerWidth >= 900) ? 'desktop' : 'mobile';
  document.body.classList.toggle('force-phone', forcePhone);
  const changed = next !== layout;
  layout = next;
  document.body.classList.toggle('layout-desktop', layout === 'desktop');
  const btn = document.getElementById('phoneToggle');
  if (btn) {
    btn.classList.toggle('on', forcePhone);
    btn.style.display = window.innerWidth >= 900 ? '' : 'none';
  }
  return changed;
}
function togglePhoneFrame() {
  forcePhone = !forcePhone;
  computeLayout();
  rerenderCurrent();
  if (walkMap) setTimeout(() => walkMap.invalidateSize(), 50);
}
window.addEventListener('resize', () => {
  if (computeLayout()) rerenderCurrent();
  if (walkMap) walkMap.invalidateSize();
});

// ─── VIEWS × WHERE ───
function isNotPhoto(s) { return s.isPhotography === false; }
function isLive(s) {
  if (s.isOngoing) return true;
  const d = daysUntil(s.closing);
  return d !== null && d >= 0;
}
function poolFor(view) { return view === 'hidden' ? SHOWS : SHOWS.filter(isLive); }
function inView(s, view) {
  const hidden = hiddenMap.has(s.showKey);
  if (view === 'hidden') return hidden;
  if (hidden) return false;
  if (view === 'notphoto') return isNotPhoto(s);
  if (view === 'saved') return savedKeys.has(s.showKey);   // My Visit includes non-photo saves
  if (isNotPhoto(s)) return false;
  if (view === 'closing') return !s.isOngoing && daysUntil(s.closing) <= 7;
  return true;
}
function inWhere(s, b, h) {
  if (h) return s.neighborhood === h;
  if (b) return s.borough === b;
  return true;
}
function countFor(view, b, h) { return poolFor(view).filter(s => inView(s, view) && inWhere(s, b, h)).length; }
function getFilteredShows() { return poolFor(activeView).filter(s => inView(s, activeView) && inWhere(s, whereBorough, whereHood)); }

// ─── FILTER PANEL ───
const VIEW_LABELS = { all: 'All', closing: 'Closing soon', saved: 'My visit', hidden: 'Hidden', notphoto: 'Not photography' };

function renderFilters() {
  const el = document.getElementById('filterPanel');
  const desk = layout === 'desktop';

  // Counts in "Show" respect the current "Where", and vice versa.
  const vc = v => countFor(v, whereBorough, whereHood);
  const hiddenN = countFor('hidden', null, null);
  const notN = countFor('notphoto', null, null);
  if (activeView === 'hidden' && hiddenN === 0) activeView = 'all';
  if (activeView === 'notphoto' && notN === 0) activeView = 'all';

  const n = x => `<span class="f-n">${x}</span>`;
  const viewChip = (v, cls) =>
    `<button class="f-chip ${cls || ''} ${activeView === v ? 'active' : ''}" data-kind="view" data-val="${v}">${VIEW_LABELS[v]}${n(vc(v))}</button>`;

  let html =
    `<div class="f-label">Show</div>` +
    `<div class="f-row f-views">` +
      viewChip('all') + viewChip('closing', 'closing-chip') + viewChip('saved', 'saved-chip') +
      ((hiddenN || notN) ? `<span class="f-sep" aria-hidden="true"></span>` : '') +
      (hiddenN ? viewChip('hidden', 'minor') : '') +
      (notN ? viewChip('notphoto', 'minor') : '') +
    `</div>`;

  // Where: boroughs and neighborhoods that have shows in the current view.
  const pool = poolFor(activeView).filter(s => inView(s, activeView));
  const hoodCounts = {};
  pool.forEach(s => { hoodCounts[s.neighborhood] = (hoodCounts[s.neighborhood] || 0) + 1; });
  const boroughCount = b => pool.filter(s => s.borough === b).length;
  const hoodsIn = b => Object.keys(hoodCounts).filter(h => hoodInfo(h).b === b).sort((a, c) => hoodRank(a) - hoodRank(c));
  // Keep the selected place visible even when the current view empties it.
  if (whereHood && !hoodCounts[whereHood]) hoodCounts[whereHood] = 0;

  const boroughChip = b =>
    `<button class="f-chip borough ${whereBorough === b && !whereHood ? 'active' : ''} ${whereBorough === b ? 'open' : ''}" data-kind="borough" data-val="${b}">${b}${n(boroughCount(b))}</button>`;
  const hoodChip = h =>
    `<button class="f-chip hood ${whereHood === h ? 'active' : ''}" data-kind="hood" data-val="${h}" style="--hood:${hoodInfo(h).color}">` +
      `<span class="dot" aria-hidden="true"></span>${shortHood(h)}${n(hoodCounts[h])}</button>`;
  const allNyc =
    `<button class="f-chip borough ${!whereBorough && !whereHood ? 'active' : ''}" data-kind="all-nyc" data-val="">All NYC${n(pool.length)}</button>`;
  const boroughsShown = BOROUGHS.filter(b => boroughCount(b) > 0 || whereBorough === b);

  html += `<div class="f-label">Where</div>`;
  if (desk) {
    // Sidebar: every borough with its neighborhoods listed under it.
    html += `<div class="f-row f-where">` + allNyc +
      boroughsShown.map(b =>
        `<div class="f-borough-group">${boroughChip(b)}${hoodsIn(b).map(hoodChip).join('')}</div>`
      ).join('') +
    `</div>`;
  } else {
    // Phone: a row of boroughs; picking one opens a row of its neighborhoods.
    html += `<div class="f-row f-where">` + allNyc + boroughsShown.map(boroughChip).join('') + `</div>`;
    if (whereBorough) {
      html += `<div class="f-row f-hoods">` + hoodsIn(whereBorough).map(hoodChip).join('') + `</div>`;
    }
  }
  el.innerHTML = html;

  if (!el.dataset.bound) {
    el.dataset.bound = '1';
    el.addEventListener('click', e => {
      const c = e.target.closest('.f-chip');
      if (!c) return;
      const { kind, val } = c.dataset;
      if (kind === 'view') activeView = val;
      else if (kind === 'all-nyc') { whereBorough = null; whereHood = null; }
      else if (kind === 'borough') {
        if (whereBorough === val && !whereHood) whereBorough = null;
        else { whereBorough = val; whereHood = null; }
      } else if (kind === 'hood') {
        if (whereHood === val) whereHood = null;
        else { whereHood = val; whereBorough = hoodInfo(val).b; }
      }
      renderFilters();
      renderList();
      document.getElementById('listingPage').scrollTop = 0;
    });
  }
}

function filterSummary(count) {
  const parts = [];
  if (activeView !== 'all') parts.push(VIEW_LABELS[activeView]);
  if (whereHood) parts.push(shortHood(whereHood));
  else if (whereBorough) parts.push(whereBorough);
  if (parts.length === 0) return '';
  return `<div class="f-summary">${parts.join(' · ')} — ${count} show${count === 1 ? '' : 's'}` +
    `<button onclick="clearFilters()">Clear</button></div>`;
}
function clearFilters() {
  activeView = 'all'; whereBorough = null; whereHood = null;
  renderFilters(); renderList();
}

// ─── MODE ───
function rerenderCurrent() {
  renderFilters();
  if (currentMode === 'plan') renderList();
  else { renderWalkList(); updateWalkMarkers(); }
}

function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  const modeBar = document.getElementById('modeBar');
  if (mode === 'plan') {
    document.getElementById('planMode').style.display = '';
    document.getElementById('walkMode').classList.remove('active');
    modeBar.innerHTML =
      '<span class="mode-label">Planning</span>' +
      '<span class="mode-hint">— add shows to your visit</span>' +
      '<span class="closing-legend"><span class="pulse-dot"></span>closing within 7 days</span>';
    renderList();
  } else {
    document.getElementById('planMode').style.display = 'none';
    document.getElementById('walkMode').classList.add('active');
    modeBar.innerHTML =
      '<span class="mode-label" style="color:#3d8a5c">Walking</span>' +
      '<span class="mode-hint">— mark shows as seen</span>' +
      '<span class="saved-count" id="savedCount"></span>';
    renderWalkMode();
  }
  updateSavedCount();
}

function updateSavedCount() {
  const el = document.getElementById('savedCount');
  if (!el) return;
  const count = SHOWS.filter(s => savedKeys.has(s.showKey) && !hiddenMap.has(s.showKey)).length;
  el.textContent = count > 0 ? `${count} saved` : '';
}

// ─── LIST ───
function renderList() {
  const page  = document.getElementById('listingPage');
  const shows = getFilteredShows();
  const hiddenView = activeView === 'hidden';

  if (shows.length === 0) {
    page.innerHTML = filterSummary(0) + (hiddenView
      ? '<div class="empty-state">Nothing hidden.</div>'
      : '<div class="empty-state">No shows match these filters.</div>');
    return;
  }

  const groups = {};
  shows.forEach(s => { (groups[s.neighborhood] = groups[s.neighborhood] || []).push(s); });
  const hoods = Object.keys(groups).sort((a, b) => hoodRank(a) - hoodRank(b));

  page.innerHTML = filterSummary(shows.length) + hoods.map((hood, i) => {
    const nb = hoodInfo(hood);
    const list = groups[hood];
    return (
      `<section style="opacity:0;transform:translateY(12px);animation:fadeIn 0.38s ease ${Math.min(i, 8) * 0.05}s forwards">` +
        `<div class="neighborhood-header">` +
          `<div class="neighborhood-swatch" style="background:${nb.color}"></div>` +
          `<div class="neighborhood-inner">` +
            `<span class="neighborhood-name">${shortHood(hood)}</span>` +
            `<span class="neighborhood-borough">${nb.b}</span>` +
            `<span class="neighborhood-count">${list.length} show${list.length !== 1 ? 's' : ''}</span>` +
          `</div>` +
        `</div>` +
        `<div class="card-grid">${list.map(s => renderCard(s, hiddenView)).join('')}</div>` +
      `</section>`
    );
  }).join('');
}

function renderCard(s, hiddenView) {
  const days   = s.isOngoing ? null : daysUntil(s.closing);
  const urgent = !s.isOngoing && days !== null && days <= 7;
  const saved  = savedKeys.has(s.showKey);
  const seen   = seenKeys.has(s.showKey);

  const topBadge = urgent
    ? `<div class="urgent-badge">${days === 0 ? 'Closes today' : 'Closing Soon'}</div>`
    : s.isOngoing ? '<div class="ongoing-badge">Ongoing</div>' : '';

  const imgHtml = s.thumb
    ? `<img src="${s.thumb}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : '';

  const closeHtml = (!s.isOngoing && s.closing)
    ? `<div class="card-close-wrap"><span class="card-close-label">closes</span><span class="card-close-date">${fmtDate(s.closing)}</span></div>`
    : '';

  return (
    `<div class="show-card ${urgent ? 'closing-soon' : ''} ${saved ? 'is-saved' : ''} ${seen ? 'is-seen' : ''} ${s.thumb ? '' : 'no-image'}"` +
        ` onclick="openDetail('${s.id}')">` +
      imgHtml +
      `<div class="card-overlay"></div>` +
      `<div class="seen-overlay">✓</div>` +
      `<div class="card-text">` +
        topBadge +
        `<div class="card-artist">${s.artist}</div>` +
        `<div class="card-show-title">${s.title}</div>` +
        `<div class="card-meta">` +
          `<div class="card-gallery">${s.galleryLabel}</div>` +
          closeHtml +
        `</div>` +
      `</div>` +
      (hiddenView
        ? `<button class="unhide-btn" onclick="unhideShow(event,'${s.showKey}')">Unhide</button>`
        : `<button class="save-btn ${saved ? 'saved' : ''}" onclick="toggleSave(event,'${s.id}')"` +
            ` aria-label="${saved ? 'Remove from visit' : 'Add to visit'}">${saved ? '♦' : '◇'}</button>`) +
    `</div>`
  );
}

function toggleSave(e, id) {
  e.stopPropagation();
  const s = findShow(id); if (!s) return;
  if (savedKeys.has(s.showKey)) savedKeys.delete(s.showKey); else savedKeys.add(s.showKey);
  persistLocalState(); renderFilters(); renderList(); updateSavedCount();
}
function toggleSeen(id) {
  const s = findShow(id); if (!s) return;
  if (seenKeys.has(s.showKey)) seenKeys.delete(s.showKey); else seenKeys.add(s.showKey);
  persistLocalState();
  if (currentMode === 'walk') { renderWalkList(); updateWalkMarkers(); } else renderList();
}
function unhideShow(e, key) {
  e.stopPropagation();
  hiddenMap.delete(key); persistLocalState();
  renderFilters(); renderList();
}

// ─── WALK MODE ───
function renderWalkMode() { renderWalkList(); initOrUpdateWalkMap(); }

function savedVisible() { return SHOWS.filter(s => savedKeys.has(s.showKey) && !hiddenMap.has(s.showKey)); }

function renderWalkList() {
  const container = document.getElementById('walkList');
  const countEl   = document.getElementById('walkSheetCount');
  const saved = savedVisible();
  if (saved.length === 0) {
    container.innerHTML = '<div class="walk-no-saves"><strong>No shows saved</strong>Switch to Plan mode and tap ◇ to add shows to your visit.</div>';
    if (countEl) countEl.textContent = '';
    return;
  }
  const unseen = saved.filter(s => !seenKeys.has(s.showKey));
  const seen   = saved.filter(s =>  seenKeys.has(s.showKey));
  if (countEl) countEl.textContent = `${unseen.length} remaining`;
  container.innerHTML = [...unseen, ...seen].map(s => {
    const isSeen = seenKeys.has(s.showKey);
    const nb = hoodInfo(s.neighborhood);
    return (
      `<div class="walk-card ${isSeen ? 'is-seen' : ''}" onclick="openDetail('${s.id}')">` +
        `<div class="walk-thumb">${s.thumb ? `<img src="${s.thumb}" alt="" loading="lazy">` : ''}</div>` +
        `<div class="walk-card-info">` +
          `<div class="walk-artist">${s.artist}</div>` +
          `<div class="walk-meta"><span class="walk-dot" style="background:${nb.color}"></span>${s.galleryLabel} · ${shortHood(s.neighborhood)}</div>` +
        `</div>` +
        `<button class="seen-btn ${isSeen ? 'is-seen' : ''}" onclick="event.stopPropagation();toggleSeen('${s.id}')">${isSeen ? 'Seen' : 'Mark Seen'}</button>` +
      `</div>`
    );
  }).join('');
}

function initOrUpdateWalkMap() {
  if (!walkMap) {
    walkMap = L.map('walkMap', { zoomControl: false, attributionControl: false });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 16, maxZoom: 19 }).addTo(walkMap);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 16, maxZoom: 19 }).addTo(walkMap);
    L.control.attribution({ prefix: 'Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors', position: 'bottomright' }).addTo(walkMap);
    L.control.zoom({ position: 'topright' }).addTo(walkMap);
  }
  setTimeout(() => { walkMap.invalidateSize(); updateWalkMarkers(); }, 30);
}

function makePinIcon(color, faded, count) {
  const label = count > 1
    ? `<text x="14" y="17.5" text-anchor="middle" font-family="Bebas Neue, sans-serif" font-size="11" fill="${color}">${count}</text>` : '';
  const svg =
    `<svg width="28" height="36" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg" style="opacity:${faded ? 0.3 : 1}">` +
    `<path d="M14 0C6.268 0 0 6.268 0 14c0 9.333 14 22 14 22S28 23.333 28 14C28 6.268 21.732 0 14 0z" fill="${color}" stroke="rgba(255,255,255,0.55)" stroke-width="1"/>` +
    `<circle cx="14" cy="14" r="${count > 1 ? 7 : 6}" fill="white" opacity="0.9"/>` + label + `</svg>`;
  return L.divIcon({ html: svg, iconSize: [28, 36], iconAnchor: [14, 36], popupAnchor: [0, -36], className: 'map-pin' });
}

function pinClosing(s) {
  const days = s.isOngoing ? null : daysUntil(s.closing);
  const urgent = days !== null && days <= 7;
  const closingLine = s.isOngoing ? 'Ongoing'
    : `Closes ${fmtDate(s.closing)}${urgent ? ' — ' + days + (days === 1 ? ' day' : ' days') + ' left' : ''}`;
  return { urgent, closingLine };
}

function updateWalkMarkers() {
  if (!walkMap) return;
  Object.values(walkMarkers).forEach(m => walkMap.removeLayer(m));
  walkMarkers = {};
  const saved = savedVisible().filter(s => s.lat != null && s.lng != null);
  if (saved.length === 0) { walkMap.setView([40.740, -74.000], 13); return; }

  // One pin per LOCATION (not per gallery): two shows at one space share a
  // pin; two spaces of one gallery get two pins.
  const byVenue = new Map();
  saved.forEach(s => { if (!byVenue.has(s.venueKey)) byVenue.set(s.venueKey, []); byVenue.get(s.venueKey).push(s); });

  byVenue.forEach((shows, venueKey) => {
    const first = shows[0];
    const color = hoodInfo(first.neighborhood).color;
    const allSeen = shows.every(s => seenKeys.has(s.showKey));
    const body = shows.length === 1
      ? (() => { const { urgent, closingLine } = pinClosing(first);
          return (first.thumb ? `<img class="pin-popup-img" src="${first.thumb}" alt="">` : '') +
            `<div class="pin-popup-body"><div class="pin-popup-artist">${first.artist}</div>` +
            `<div class="pin-popup-show">${first.title}</div><div class="pin-popup-gallery">${first.galleryLabel}</div>` +
            `<div class="pin-popup-closing ${urgent ? 'urgent' : ''}">${closingLine}</div></div>`; })()
      : `<div class="pin-popup-body"><div class="pin-popup-gallery pin-popup-venue">${first.galleryLabel} · ${shows.length} shows</div>` +
          shows.map(s => { const { urgent, closingLine } = pinClosing(s);
            return `<div class="pin-popup-item ${seenKeys.has(s.showKey) ? 'is-seen' : ''}" onclick="openDetail('${s.id}')">` +
              `<div class="pin-popup-artist">${s.artist}</div><div class="pin-popup-show">${s.title}</div>` +
              `<div class="pin-popup-closing ${urgent ? 'urgent' : ''}">${closingLine}</div></div>`; }).join('') +
        `</div>`;
    const opts = shows.length > 1 ? { maxHeight: Math.max(120, walkMap.getSize().y - 70), autoPanPaddingBottomRight: [5, 30] } : {};
    const marker = L.marker([first.lat, first.lng], { icon: makePinIcon(color, allSeen, shows.length) })
      .addTo(walkMap).bindPopup(`<div class="pin-popup">${body}</div>`, opts);
    walkMarkers[venueKey] = marker;
  });
  walkMap.fitBounds(L.featureGroup(Object.values(walkMarkers)).getBounds().pad(0.25), { maxZoom: 16 });
}

// ─── DETAIL ───
function openDetail(id) {
  const s = findShow(id); if (!s) return;
  const nb = hoodInfo(s.neighborhood);
  const days = s.isOngoing ? null : daysUntil(s.closing);
  const urgent = !s.isOngoing && days !== null && days <= 7;
  const isSaved = savedKeys.has(s.showKey);
  const isSeen = seenKeys.has(s.showKey);
  const isHidden = hiddenMap.has(s.showKey);

  let closingBlock = '';
  if (s.isOngoing) {
    closingBlock = `<div class="detail-closing-block ongoing"><div class="closing-info"><span class="label">Closing date</span><div class="date">Ongoing</div></div></div>`;
  } else if (s.closing) {
    const daysLabel = days === 0 ? 'Closes today' : days === 1 ? '1 day left' : `${days} days left`;
    closingBlock =
      `<div class="detail-closing-block ${urgent ? 'urgent' : ''}"><div class="closing-info">` +
      `<span class="label">${urgent ? '⚠ Closing soon' : 'Closing date'}</span><div class="date">${fmtDate(s.closing)}</div></div>` +
      `<div class="days-left">${daysLabel}</div></div>`;
  }

  const row = (label, value) => value ? `<div class="detail-meta-label">${label}</div><div class="detail-meta-value">${value}</div>` : '';
  const addr = s.address ? `<a href="${mapsUrl(s.address + ', New York')}">${s.address}</a>` : '';
  let website = '';
  if (s.website) {
    const url = s.website.startsWith('http') ? s.website : 'https://' + s.website;
    website = `<a href="${url}" target="_blank" rel="noopener">${s.website.replace(/^https?:\/\//, '')}</a>`;
  }
  const showPage = s.url ? `<a href="${s.url}" target="_blank" rel="noopener">Show page ↗</a>` : '';
  // Several locations: name this show's space, then list the others.
  const alsoAt = s.otherLocations.length
    ? `<div class="detail-also">Also at ${s.otherLocations.map(l => `${l.label} <span>(${shortHood(l.neighborhood)})</span>`).join(', ')}</div>` : '';

  let photoNoteHtml = '';
  if (s.photoNote) {
    const note = /^[A-Z][a-z]/.test(s.photoNote) ? s.photoNote[0].toLowerCase() + s.photoNote.slice(1) : s.photoNote;
    const prefix = s.isPhotography === true ? 'Photography: ' : s.isPhotography === false ? 'Not photography: ' : '';
    photoNoteHtml = `<div class="detail-photo-note">${prefix ? prefix + note : s.photoNote}</div>`;
  }

  document.getElementById('detailContent').innerHTML =
    `<div class="detail-hero">${s.thumb ? `<img src="${s.thumb}" alt="">` : ''}</div>` +
    `<div class="detail-content">` +
      `<div class="detail-hood-tag"><span class="swatch" style="background:${nb.color}"></span>${shortHood(s.neighborhood)} · ${nb.b}</div>` +
      `<div class="detail-artist">${s.artist}</div>` +
      `<div class="detail-show-title">${s.title}</div>` +
      `<div class="detail-divider"></div>` +
      `<div class="detail-meta-label">Gallery</div>` +
      `<div class="detail-meta-value gallery">${s.gallery}${s.location ? ` · ${s.location.label}` : ''}</div>` +
      alsoAt +
      row('Address', addr) + row('Hours', s.hours) + row('Website', website) + row('This show', showPage) +
      closingBlock + photoNoteHtml +
      `<div class="detail-actions">` +
        `<button class="detail-save-btn ${isSaved ? 'saved' : ''}" onclick="detailToggle('save','${s.id}')">${isSaved ? '♦ Saved to Visit' : '◇ Add to Visit'}</button>` +
        `<button class="detail-seen-btn ${isSeen ? 'seen' : ''}" onclick="detailToggle('seen','${s.id}')">${isSeen ? '✓ Seen' : 'Mark Seen'}</button>` +
      `</div>` +
      `<button class="detail-hide-btn ${isHidden ? 'is-hidden' : ''}" onclick="detailToggle('hide','${s.id}')">${isHidden ? 'Unhide — mark as photography' : 'Not photography'}</button>` +
    `</div>`;

  const page = document.getElementById('detailPage');
  page.classList.add('active');
  page.scrollTop = 0;
  document.getElementById('detailScrim').classList.add('active');
}

function detailToggle(what, id) {
  const s = findShow(id); if (!s) return;
  const k = s.showKey;
  if (what === 'save') { if (savedKeys.has(k)) savedKeys.delete(k); else savedKeys.add(k); }
  if (what === 'seen') { if (seenKeys.has(k)) seenKeys.delete(k); else seenKeys.add(k); }
  if (what === 'hide') {
    if (hiddenMap.has(k)) hiddenMap.delete(k);
    else { hiddenMap.set(k, { key: k, gallery: s.gallery, title: s.title, at: new Date().toISOString() }); persistLocalState(); closeDetail(); rerenderCurrent(); return; }
  }
  persistLocalState();
  updateSavedCount();
  rerenderCurrent();
  openDetail(id);
}

function closeDetail() {
  const page = document.getElementById('detailPage');
  page.classList.remove('active');
  document.getElementById('detailScrim').classList.remove('active');
}

// ─── PALETTE (prototype review aid) ───
function togglePalette() {
  const p = document.getElementById('palettePanel');
  if (!p.classList.contains('open')) {
    const present = new Set(SHOWS.map(s => s.neighborhood));
    document.getElementById('paletteBody').innerHTML = BOROUGHS.map(b =>
      `<div class="palette-borough">${b}</div>` +
      HOOD_ORDER.filter(h => NEIGHBORHOODS[h].b === b).map(h =>
        `<div class="palette-item ${present.has(h) ? '' : 'absent'}"><span class="palette-swatch" style="background:${NEIGHBORHOODS[h].color}"></span>` +
        `${shortHood(h)}<code>${NEIGHBORHOODS[h].color}</code></div>`).join('')
    ).join('') + `<p class="palette-note">Faded: no venue with a current show there.</p>`;
  }
  p.classList.toggle('open');
}

// ─── DATA ───
async function loadData() {
  try {
    const [gRes, sRes] = await Promise.all([fetch('../data/galleries.json'), fetch('../data/shows.json')]);
    if (!gRes.ok || !sRes.ok) throw new Error(`data fetch failed (${gRes.status}, ${sRes.status})`);
    const galleries = await gRes.json();
    const showsData = await sRes.json();

    const byId = {};
    galleries.forEach(g => {
      if (!g.locations && DEMO_LOCATIONS[g.id]) g.locations = DEMO_LOCATIONS[g.id];
      byId[g.id] = g;
    });

    const usedIds = new Set();
    SHOWS = showsData.shows.map(sh => {
      const gal = byId[sh.galleryId];
      if (!gal || gal.status !== 'open') return null;
      const multi = Array.isArray(gal.locations) && gal.locations.length > 1;
      const locId = sh.locationId || DEMO_SHOW_LOCATIONS[sh.id];
      const loc = multi ? (gal.locations.find(l => l.id === locId) || gal.locations[0]) : null;
      const neighborhood = loc ? loc.neighborhood : gal.neighborhood;
      const isOngoing = sh.closes === 'ongoing';
      const closing = (!isOngoing && sh.closes) ? sh.closes : null;
      const showKey = showKeyFor(sh.galleryId, sh.title);
      const id = usedIds.has(sh.id) ? showKey : sh.id;
      usedIds.add(id);
      return {
        id, showKey,
        galleryId: sh.galleryId,
        gallery: gal.name,
        galleryLabel: loc ? `${gal.name} · ${loc.label}` : gal.name,
        location: loc,
        otherLocations: multi ? gal.locations.filter(l => l !== loc) : [],
        venueKey: loc ? `${gal.id}::${loc.id}` : gal.id,
        artist: sh.artists || 'Group Exhibition',
        title: sh.title,
        url: sh.url || null,
        neighborhood,
        borough: hoodInfo(neighborhood).b,
        address: loc ? loc.address : gal.address,
        hours: (loc && loc.hours) || gal.hours,
        website: gal.website,
        closing, isOngoing,
        thumb: sh.image,
        isPhotography: sh.isPhotography === undefined ? null : sh.isPhotography,
        photoNote: sh.photoNote || null,
        lat: loc ? loc.lat : gal.lat,
        lng: loc ? loc.lng : gal.lng,
      };
    }).filter(Boolean);

    loadLocalState();
    const monthYear = TODAY.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    document.querySelector('.tagline').textContent = `Current exhibitions — ${monthYear}`;

    computeLayout();
    renderFilters();
    renderList();
  } catch (err) {
    console.error('Failed to load gallery data:', err);
    document.getElementById('listingPage').innerHTML =
      '<div class="empty-state">Couldn’t load gallery data. Please reload the page.</div>';
  }
}

computeLayout();
loadData();
