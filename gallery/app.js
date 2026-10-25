// NYC Photo Shows — app.js
//
// Loads gallery + show data from data/galleries.json and data/shows.json at
// runtime, joins them, and renders the page. Ported from the retired
// generate_brief-v3.py template (which used to bake this into a static HTML
// file at build time) — see ../PROJECT_BRIEF.md for the data model and
// ../HANDOFF-build-1.md for the migration this file is part of.

const TODAY = new Date(new Date().toDateString()); // today at local midnight

// Neighborhood accent colors — ported verbatim from the generator's
// NEIGHBORHOOD_COLORS table (the subset currently present in the data).
// Any neighborhood not listed here falls back to '#444', same as the
// original page did for neighborhoods outside its table.
const NEIGHBORHOODS = {
  "Chelsea": { "color": "#344e8a" },
  "Midtown": { "color": "#1a6a6a" },
  "Upper East Side": { "color": "#5a3a7a" },
  "Lower East Side": { "color": "#2d7a4a" },
  "SoHo": { "color": "#4a4a8a" },
  "West Village": { "color": "#4a5a1a" },
  "Upper West Side": { "color": "#1a5c8a" },
  "Prospect Heights, Brooklyn": { "color": "#6a3a1a" },
  "South Bronx": { "color": "#2a5a4a" },
  "Hell's Kitchen": { "color": "#6a3a1a" },
  "DUMBO, Brooklyn": { "color": "#3a5a2a" }
};

let SHOWS = [];

let currentMode  = 'plan';
let activeFilter = 'all';

// Saved / seen / hidden, keyed per show (not per gallery — see showKeyFor).
// Build 2: cross-device state. Local storage is always the source of truth
// for rendering; when a sync key is set, it's kept in step with the server.
let savedKeys  = new Set();
let seenKeys   = new Set();
let hiddenMap  = new Map(); // showKey -> { key, gallery, title, at }

let walkMap  = null;
let walkMarkers = {};

// Show key = `<galleryId>::<slug(title)>`. Keeps saved/seen/hidden tied to
// a specific show rather than the gallery, so a gallery's next show starts
// clean (see Build 2 handoff, decision 4).
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function showKeyFor(galleryId, title) {
  return `${galleryId}::${slugify(title)}`;
}

function findShow(id) {
  return SHOWS.find(s => s.id === id);
}

function persistLocalState() {
  localStorage.setItem('gallery-state', JSON.stringify({
    saved: [...savedKeys],
    seen: [...seenKeys],
    hidden: [...hiddenMap.values()],
  }));
}

function loadLocalState() {
  try {
    const raw = JSON.parse(localStorage.getItem('gallery-state') || 'null');
    if (!raw) return { saved: new Set(), seen: new Set(), hidden: new Map() };
    return {
      saved: new Set(raw.saved || []),
      seen: new Set(raw.seen || []),
      hidden: new Map((raw.hidden || []).map(h => [h.key, h])),
    };
  } catch {
    return { saved: new Set(), seen: new Set(), hidden: new Map() };
  }
}

// One-time migration from Build 1's gallery-savedIds / gallery-seenIds
// (gallery ids, pre-dating show keys). Old keys are left in place —
// harmless, and a later build can remove them.
function runMigration() {
  if (localStorage.getItem('gallery-migrated-v2')) return;

  const oldSaved = JSON.parse(localStorage.getItem('gallery-savedIds') || '[]');
  const oldSeen  = JSON.parse(localStorage.getItem('gallery-seenIds')  || '[]');

  if (oldSaved.length === 0 && oldSeen.length === 0) {
    localStorage.setItem('gallery-migrated-v2', '1');
    return;
  }

  const byGalleryId = {};
  SHOWS.forEach(s => { byGalleryId[s.galleryId] = s; });

  oldSaved.forEach(galleryId => {
    const s = byGalleryId[galleryId];
    if (!s || savedKeys.has(s.showKey)) return;
    savedKeys.add(s.showKey);
    queueOp({ op: 'save', key: s.showKey });
  });
  oldSeen.forEach(galleryId => {
    const s = byGalleryId[galleryId];
    if (!s || seenKeys.has(s.showKey)) return;
    seenKeys.add(s.showKey);
    queueOp({ op: 'seen', key: s.showKey });
  });

  persistLocalState();
  localStorage.setItem('gallery-migrated-v2', '1');
}

// ─── SYNC ───
let pendingOps   = JSON.parse(localStorage.getItem('gallery-pending') || '[]');
let keyRejected  = false;
let syncInFlight = false;
let flushTimer   = null;

function getSyncKey() { return localStorage.getItem('gallery-key'); }

function persistPending() {
  localStorage.setItem('gallery-pending', JSON.stringify(pendingOps));
}

function queueOp(op) {
  pendingOps.push(op);
  persistPending();
  updateSyncStatusUI();
  if (getSyncKey() && !keyRejected) scheduleFlush();
}

function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushPending, 500);
}

function applyLocalOp(op) {
  switch (op.op) {
    case 'save':   savedKeys.add(op.key); break;
    case 'unsave': savedKeys.delete(op.key); break;
    case 'seen':   seenKeys.add(op.key); break;
    case 'unseen': seenKeys.delete(op.key); break;
    case 'hide':   hiddenMap.set(op.key, { key: op.key, gallery: op.gallery, title: op.title, at: new Date().toISOString() }); break;
    case 'unhide': hiddenMap.delete(op.key); break;
  }
}

function adoptServerState(state) {
  savedKeys = new Set(state.saved);
  seenKeys  = new Set(state.seen);
  hiddenMap = new Map(state.hidden.map(h => [h.key, h]));
}

function rerenderCurrent() {
  buildFilterBar();
  if (currentMode === 'plan') renderList();
  else { renderWalkList(); updateWalkMarkers(); }
}

async function flushPending() {
  if (!getSyncKey() || keyRejected || pendingOps.length === 0) { updateSyncStatusUI(); return; }
  const batch = pendingOps.slice(0, 100);
  syncInFlight = true;
  updateSyncStatusUI();
  try {
    const res = await fetch('/gallery/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gallery-Key': getSyncKey() },
      body: JSON.stringify({ ops: batch }),
    });
    if (res.status === 401) {
      keyRejected = true;
      syncInFlight = false;
      updateSyncStatusUI();
      return;
    }
    if (!res.ok) throw new Error('POST failed: ' + res.status);
    const serverState = await res.json();
    pendingOps = pendingOps.slice(batch.length);
    persistPending();
    adoptServerState(serverState);
    persistLocalState();
    syncInFlight = false;
    updateSyncStatusUI();
    rerenderCurrent();
    if (pendingOps.length > 0) scheduleFlush();
  } catch (err) {
    syncInFlight = false;
    updateSyncStatusUI();
  }
}

async function syncNow() {
  if (!getSyncKey() || keyRejected) { updateSyncStatusUI(); return; }
  syncInFlight = true;
  updateSyncStatusUI();
  try {
    const res = await fetch('/gallery/api/state', {
      headers: { 'X-Gallery-Key': getSyncKey() },
    });
    if (res.status === 401) {
      keyRejected = true;
      syncInFlight = false;
      updateSyncStatusUI();
      return;
    }
    if (!res.ok) throw new Error('GET failed: ' + res.status);
    const serverState = await res.json();
    adoptServerState(serverState);
    pendingOps.forEach(applyLocalOp); // reapply not-yet-flushed local ops on top
    persistLocalState();
    syncInFlight = false;
    updateSyncStatusUI();
    rerenderCurrent();
    if (pendingOps.length > 0) flushPending();
  } catch (err) {
    syncInFlight = false;
    updateSyncStatusUI();
  }
}

function syncStatusText() {
  if (!getSyncKey()) return 'Not syncing';
  if (keyRejected) return 'Key not accepted';
  if (syncInFlight) return 'Syncing…';
  if (pendingOps.length > 0) return `Offline — ${pendingOps.length} change${pendingOps.length === 1 ? '' : 's'} waiting`;
  return 'Synced';
}

function syncStatusClass() {
  if (!getSyncKey()) return '';
  if (keyRejected) return 'is-rejected';
  if (pendingOps.length > 0 && !syncInFlight) return 'is-offline';
  if (!syncInFlight) return 'is-synced';
  return '';
}

function updateSyncStatusUI() {
  const el = document.getElementById('syncStatusText');
  if (el) { el.textContent = syncStatusText(); el.className = `sync-status ${syncStatusClass()}`; }
  const btn = document.getElementById('syncToggleBtn');
  if (btn) btn.classList.toggle('active', !!getSyncKey() && !keyRejected);
}

function toggleSyncPanel() {
  const panel = document.getElementById('syncPanel');
  const opening = !panel.classList.contains('open');
  panel.classList.toggle('open', opening);
  if (opening) {
    const input = document.getElementById('syncKeyInput');
    input.value = getSyncKey() || '';
    input.focus();
  }
}

function saveSyncKey() {
  const val = document.getElementById('syncKeyInput').value.trim();
  if (!val) return;
  localStorage.setItem('gallery-key', val);
  keyRejected = false;
  document.getElementById('syncPanel').classList.remove('open');
  updateSyncStatusUI();
  syncNow();
}

function stopSyncing() {
  localStorage.removeItem('gallery-key');
  keyRejected = false;
  document.getElementById('syncPanel').classList.remove('open');
  updateSyncStatusUI();
}

// ─── HIDE / UNHIDE ───
function hideShowByKey(key, gallery, title) {
  hiddenMap.set(key, { key, gallery, title, at: new Date().toISOString() });
  queueOp({ op: 'hide', key, gallery, title });
  persistLocalState();
}

function unhideByKey(key) {
  hiddenMap.delete(key);
  queueOp({ op: 'unhide', key });
  persistLocalState();
}

function unhideShow(e, key) {
  e.stopPropagation();
  unhideByKey(key);
  buildFilterBar();
  renderList();
}

function daysUntil(d) {
  if (!d) return null;
  return Math.round((new Date(d) - TODAY) / 86400000);
}

function fmtDate(s) {
  return new Date(s + 'T12:00:00').toLocaleDateString('en-US', {month:'short', day:'numeric'});
}

function mapsUrl(address) {
  return 'https://maps.apple.com/?address=' + encodeURIComponent(address);
}

// ─── FILTER BAR ───
function buildFilterBar() {
  const bar = document.getElementById('filterBar');
  const hoods = [];
  SHOWS.forEach(s => { if (!hoods.includes(s.neighborhood)) hoods.push(s.neighborhood); });
  const hiddenCount = SHOWS.filter(s => hiddenMap.has(s.showKey)).length;
  if (activeFilter === 'hidden' && hiddenCount === 0) activeFilter = 'all';

  const chip = (filter, label, cls) =>
    `<button class="filter-chip ${cls || ''} ${activeFilter === filter ? 'active' : ''}" data-filter="${filter}">${label}</button>`;

  bar.innerHTML =
    chip('all', 'All') +
    chip('closing', 'Closing Soon', 'closing-chip') +
    chip('saved', 'My Visit', 'saved-chip') +
    (hiddenCount > 0 ? chip('hidden', `Hidden (${hiddenCount})`, 'hidden-chip') : '') +
    hoods.map(n => chip(n, n)).join('');

  // buildFilterBar() is now called on every filter change (to keep the
  // hidden count current), so only bind the delegated click listener once.
  if (!bar.dataset.bound) {
    bar.dataset.bound = '1';
    bar.addEventListener('click', e => {
      const chipEl = e.target.closest('.filter-chip');
      if (!chipEl) return;
      activeFilter = chipEl.dataset.filter;
      buildFilterBar();
      renderList();
    });
  }
}

// ─── MODE ───
function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  const modeBar = document.getElementById('modeBar');
  if (mode === 'plan') {
    document.getElementById('planMode').style.display = 'flex';
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
      '<span class="mode-label" style="color:#5aaa78">Walking</span>' +
      '<span class="mode-hint" style="color:#b0b0b0">— mark shows as seen</span>' +
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

// ─── PLAN / LIST ───
function visibleShows() {
  return SHOWS.filter(s => {
    if (hiddenMap.has(s.showKey)) return false;
    if (s.isOngoing) return true;
    const d = daysUntil(s.closing);
    return d !== null && d >= 0;
  });
}

function getFilteredShows() {
  if (activeFilter === 'hidden') {
    return SHOWS.filter(s => hiddenMap.has(s.showKey));
  }
  return visibleShows().filter(s => {
    if (activeFilter === 'all')     return true;
    if (activeFilter === 'closing') return !s.isOngoing && daysUntil(s.closing) <= 7;
    if (activeFilter === 'saved')   return savedKeys.has(s.showKey);
    return s.neighborhood === activeFilter;
  });
}

function renderList() {
  const page  = document.getElementById('listingPage');
  const shows = getFilteredShows();
  const hiddenView = activeFilter === 'hidden';
  page.innerHTML = '';

  if (shows.length === 0) {
    page.innerHTML = hiddenView
      ? '<div class="empty-state">Nothing hidden.</div>'
      : '<div class="empty-state">No shows match this filter.</div>';
    return;
  }

  const groups = {};
  const hoodOrder = [];
  shows.forEach(s => {
    if (!groups[s.neighborhood]) { groups[s.neighborhood] = []; hoodOrder.push(s.neighborhood); }
    groups[s.neighborhood].push(s);
  });

  hoodOrder.forEach((hood, i) => {
    const nb = NEIGHBORHOODS[hood] || {color:'#444'};
    const hoodShows = groups[hood];
    const sec = document.createElement('section');
    sec.style.cssText = `opacity:0;transform:translateY(12px);animation:fadeIn 0.38s ease ${i * 0.06}s forwards`;
    sec.innerHTML =
      `<div class="neighborhood-header">` +
        `<div class="neighborhood-swatch" style="background:${nb.color}"></div>` +
        `<div class="neighborhood-inner">` +
          `<span class="neighborhood-name">${hood}</span>` +
          `<span class="neighborhood-count">${hoodShows.length} show${hoodShows.length !== 1 ? 's' : ''}</span>` +
        `</div>` +
      `</div>` +
      hoodShows.map(s => renderCard(s, hiddenView)).join('');
    page.appendChild(sec);
  });
}

function renderCard(s, hiddenView) {
  const days   = s.isOngoing ? null : daysUntil(s.closing);
  const urgent = !s.isOngoing && days !== null && days <= 7;
  const saved  = savedKeys.has(s.showKey);
  const seen   = seenKeys.has(s.showKey);

  const topBadge = urgent
    ? '<div class="urgent-badge">Closing Soon</div>'
    : s.isOngoing ? '<div class="ongoing-badge">Ongoing</div>' : '';

  const imgHtml = s.thumb
    ? `<img src="${s.thumb}" alt="${s.artist}" loading="lazy" onerror="this.style.display='none'">`
    : '';

  let closeHtml = '';
  if (!s.isOngoing && s.closing) {
    closeHtml =
      `<div class="card-close-wrap">` +
        `<span class="card-close-label">closes</span>` +
        `<span class="card-close-date">${fmtDate(s.closing)}</span>` +
      `</div>`;
  }

  return (
    `<div class="show-card ${urgent?'closing-soon':''} ${saved?'is-saved':''} ${seen?'is-seen':''}"` +
        ` onclick="openDetail('${s.id}')">` +
      imgHtml +
      `<div class="card-overlay"></div>` +
      `<div class="seen-overlay">✓</div>` +
      `<div class="card-text">` +
        topBadge +
        `<div class="card-artist">${s.artist}</div>` +
        `<div class="card-show-title">${s.title}</div>` +
        `<div class="card-meta">` +
          `<div class="card-gallery">${s.gallery}</div>` +
          closeHtml +
        `</div>` +
      `</div>` +
      (hiddenView
        ? `<button class="unhide-btn" onclick="unhideShow(event,'${s.showKey}')">Unhide</button>`
        : `<button class="save-btn ${saved?'saved':''}"` +
                  ` onclick="toggleSave(event,'${s.id}')"` +
                  ` title="${saved?'Remove from visit':'Add to visit'}">${saved?'♦':'◇'}</button>`) +
    `</div>`
  );
}

function toggleSave(e, id) {
  e.stopPropagation();
  const s = findShow(id);
  if (!s) return;
  const key = s.showKey;
  if (savedKeys.has(key)) { savedKeys.delete(key); queueOp({ op: 'unsave', key }); }
  else { savedKeys.add(key); queueOp({ op: 'save', key }); }
  persistLocalState(); renderList(); updateSavedCount();
}

function toggleSeen(id) {
  const s = findShow(id);
  if (!s) return;
  const key = s.showKey;
  if (seenKeys.has(key)) { seenKeys.delete(key); queueOp({ op: 'unseen', key }); }
  else { seenKeys.add(key); queueOp({ op: 'seen', key }); }
  persistLocalState();
  if (currentMode === 'walk') { renderWalkList(); updateWalkMarkers(); }
  else { renderList(); }
}

// ─── WALK MODE ───
function renderWalkMode() {
  renderWalkList();
  initOrUpdateWalkMap();
}

function renderWalkList() {
  const container = document.getElementById('walkList');
  const countEl   = document.getElementById('walkSheetCount');

  const saved  = SHOWS.filter(s => savedKeys.has(s.showKey) && !hiddenMap.has(s.showKey));

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
    const thumbHtml = s.thumb
      ? `<img src="${s.thumb}" alt="${s.artist}" loading="lazy">`
      : '';
    return (
      `<div class="walk-card ${isSeen?'is-seen':''}" onclick="openDetail('${s.id}')">` +
        `<div class="walk-thumb">${thumbHtml}</div>` +
        `<div class="walk-card-info">` +
          `<div class="walk-artist">${s.artist}</div>` +
          `<div class="walk-meta">${s.gallery} · ${s.neighborhood}</div>` +
        `</div>` +
        `<button class="seen-btn ${isSeen?'is-seen':''}"` +
                ` onclick="event.stopPropagation();toggleSeen('${s.id}')">` +
          `${isSeen?'Seen':'Mark Seen'}` +
        `</button>` +
      `</div>`
    );
  }).join('');
}

// ─── WALK MAP ───
function initOrUpdateWalkMap() {
  if (!walkMap) {
    walkMap = L.map('walkMap', {zoomControl:false, attributionControl:false});
    // Esri World Dark Gray Base + Reference (replaced CartoDB dark, Oct 24 2026)
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 16,
      maxZoom: 19,
    }).addTo(walkMap);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 16,
      maxZoom: 19,
    }).addTo(walkMap);
    L.control.attribution({prefix:'Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors', position:'bottomright'}).addTo(walkMap);
    L.control.zoom({position:'topright'}).addTo(walkMap);

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => {
        const youIcon = L.divIcon({html:'<div class="you-are-here"></div>', iconSize:[16,16], iconAnchor:[8,8], className:''});
        L.marker([pos.coords.latitude, pos.coords.longitude], {icon:youIcon}).addTo(walkMap)
          .bindPopup('<div class="pin-popup"><div class="pin-popup-body"><div class="pin-popup-artist">You are here</div></div></div>');
      });
    }
  }
  updateWalkMarkers();
}

function makePinIcon(color, faded) {
  const svg =
    `<svg width="28" height="36" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg" style="opacity:${faded?0.3:1}">` +
    `<path d="M14 0C6.268 0 0 6.268 0 14c0 9.333 14 22 14 22S28 23.333 28 14C28 6.268 21.732 0 14 0z" fill="${color}"/>` +
    `<circle cx="14" cy="14" r="6" fill="white" opacity="0.9"/>` +
    `</svg>`;
  return L.divIcon({html:svg, iconSize:[28,36], iconAnchor:[14,36], popupAnchor:[0,-36], className:'map-pin'});
}

function updateWalkMarkers() {
  Object.values(walkMarkers).forEach(m => walkMap.removeLayer(m));
  walkMarkers = {};

  const saved = SHOWS.filter(s => savedKeys.has(s.showKey) && !hiddenMap.has(s.showKey) && s.lat !== null && s.lng !== null);
  if (saved.length === 0) { walkMap.setView([40.740, -74.000], 13); return; }

  saved.forEach(s => {
    const color  = (NEIGHBORHOODS[s.neighborhood] || {}).color || '#444';
    const isSeen = seenKeys.has(s.showKey);
    const days   = s.isOngoing ? null : daysUntil(s.closing);
    const urgent = days !== null && days <= 7;
    const closingLine = s.isOngoing
      ? 'Ongoing'
      : `Closes ${fmtDate(s.closing)}${urgent ? ' — ' + days + (days===1?' day':' days') + ' left' : ''}`;

    const imgHtml = s.thumb
      ? `<img class="pin-popup-img" src="${s.thumb}" alt="${s.artist}">`
      : '';

    const marker = L.marker([s.lat, s.lng], {icon:makePinIcon(color, isSeen)})
      .addTo(walkMap)
      .bindPopup(
        `<div class="pin-popup">` +
          imgHtml +
          `<div class="pin-popup-body">` +
            `<div class="pin-popup-artist">${s.artist}</div>` +
            `<div class="pin-popup-show">${s.title}</div>` +
            `<div class="pin-popup-gallery">${s.gallery}</div>` +
            `<div class="pin-popup-closing ${urgent?'urgent':''}">${closingLine}</div>` +
          `</div>` +
        `</div>`
      );
    marker.on('click', () => marker.openPopup());
    walkMarkers[s.id] = marker;
  });

  const group = L.featureGroup(Object.values(walkMarkers));
  walkMap.fitBounds(group.getBounds().pad(0.25), {maxZoom: 16});
}

// ─── DETAIL ───
function openDetail(id) {
  const s = SHOWS.find(x => x.id === id);
  if (!s) return;
  const nb     = NEIGHBORHOODS[s.neighborhood] || {color:'#444'};
  const days   = s.isOngoing ? null : daysUntil(s.closing);
  const urgent = !s.isOngoing && days !== null && days <= 7;
  const isSaved  = savedKeys.has(s.showKey);
  const isSeen   = seenKeys.has(s.showKey);
  const isHidden = hiddenMap.has(s.showKey);

  let closingBlock = '';
  if (s.isOngoing) {
    closingBlock =
      `<div class="detail-closing-block ongoing">` +
        `<div class="closing-info">` +
          `<span class="label">Closing date</span>` +
          `<div class="date">Ongoing</div>` +
        `</div>` +
      `</div>`;
  } else if (s.closing) {
    const daysLabel = days === 0 ? 'Closes today' : days === 1 ? '1 day left' : `${days} days left`;
    closingBlock =
      `<div class="detail-closing-block ${urgent?'urgent':''}">` +
        `<div class="closing-info">` +
          `<span class="label">${urgent?'⚠ Closing soon':'Closing date'}</span>` +
          `<div class="date">${fmtDate(s.closing)}</div>` +
        `</div>` +
        `<div class="days-left">${daysLabel}</div>` +
      `</div>`;
  }

  const heroHtml = s.thumb
    ? `<div class="detail-hero"><img src="${s.thumb}" alt="${s.artist}"></div>`
    : `<div class="detail-hero"></div>`;

  const hoursHtml = s.hours
    ? `<div class="detail-meta-label">Hours</div><div class="detail-meta-value">${s.hours}</div>`
    : '';

  let websiteHtml = '';
  if (s.website) {
    const url   = s.website.startsWith('http') ? s.website : 'https://' + s.website;
    const label = s.website.replace(/^https?:\/\//, '');
    websiteHtml = `<div class="detail-meta-label">Website</div><div class="detail-meta-value"><a href="${url}" target="_blank">${label}</a></div>`;
  }

  const addrDisplay = (s.address && s.address !== 'Check website')
    ? `<a href="${mapsUrl(s.address + ', New York')}">${s.address}</a>`
    : s.address;

  document.getElementById('detailContent').innerHTML =
    heroHtml +
    `<div class="detail-content">` +
      `<div class="detail-hood-tag">` +
        `<span class="swatch" style="background:${nb.color}"></span>` +
        s.neighborhood +
      `</div>` +
      `<div class="detail-artist">${s.artist}</div>` +
      `<div class="detail-show-title">${s.title}</div>` +
      `<div class="detail-divider"></div>` +
      `<div class="detail-meta-label">Gallery</div>` +
      `<div class="detail-meta-value gallery">${s.gallery}</div>` +
      `<div class="detail-meta-label">Address</div>` +
      `<div class="detail-meta-value">${addrDisplay}</div>` +
      hoursHtml +
      websiteHtml +
      closingBlock +
      `<div class="detail-actions">` +
        `<button class="detail-save-btn ${isSaved?'saved':''}" id="detailSaveBtn" onclick="detailToggleSave('${s.id}')">` +
          `${isSaved?'♦ Saved to Visit':'◇ Add to Visit'}` +
        `</button>` +
        `<button class="detail-seen-btn ${isSeen?'seen':''}" id="detailSeenBtn" onclick="detailToggleSeen('${s.id}')">` +
          `${isSeen?'✓ Seen':'Mark Seen'}` +
        `</button>` +
      `</div>` +
      `<button class="detail-hide-btn ${isHidden?'is-hidden':''}" id="detailHideBtn" onclick="detailToggleHide('${s.id}')">` +
        `${isHidden?'Unhide — mark as photography':'Not photography'}` +
      `</button>` +
    `</div>`;

  const page = document.getElementById('detailPage');
  page.classList.add('active');
  page.scrollTop = 0;
  document.body.style.overflow = 'hidden';
}

function detailToggleSave(id) {
  const s = findShow(id);
  if (!s) return;
  const key = s.showKey;
  if (savedKeys.has(key)) { savedKeys.delete(key); queueOp({ op: 'unsave', key }); }
  else { savedKeys.add(key); queueOp({ op: 'save', key }); }
  persistLocalState(); updateSavedCount();
  const isSaved = savedKeys.has(key);
  const btn = document.getElementById('detailSaveBtn');
  if (btn) { btn.className = `detail-save-btn ${isSaved?'saved':''}`; btn.textContent = isSaved?'♦ Saved to Visit':'◇ Add to Visit'; }
  renderList();
}

function detailToggleSeen(id) {
  const s = findShow(id);
  if (!s) return;
  const key = s.showKey;
  if (seenKeys.has(key)) { seenKeys.delete(key); queueOp({ op: 'unseen', key }); }
  else { seenKeys.add(key); queueOp({ op: 'seen', key }); }
  persistLocalState();
  const isSeen = seenKeys.has(key);
  const btn = document.getElementById('detailSeenBtn');
  if (btn) { btn.className = `detail-seen-btn ${isSeen?'seen':''}`; btn.textContent = isSeen?'✓ Seen':'Mark Seen'; }
  if (currentMode === 'walk') { renderWalkList(); updateWalkMarkers(); }
}

function detailToggleHide(id) {
  const s = findShow(id);
  if (!s) return;
  const key = s.showKey;
  if (hiddenMap.has(key)) {
    unhideByKey(key);
    const btn = document.getElementById('detailHideBtn');
    if (btn) { btn.classList.remove('is-hidden'); btn.textContent = 'Not photography'; }
    rerenderCurrent();
  } else {
    hideShowByKey(key, s.gallery, s.title);
    closeDetail();
    rerenderCurrent();
  }
}

function closeDetail() {
  const page = document.getElementById('detailPage');
  page.style.transition = 'opacity 0.2s, transform 0.2s';
  page.style.opacity = '0';
  page.style.transform = 'translateY(40px)';
  setTimeout(() => {
    page.classList.remove('active');
    page.style.transition = page.style.opacity = page.style.transform = '';
    document.body.style.overflow = '';
  }, 200);
}

// ─── DATA LOADING ───
// Fetches galleries.json + shows.json, joins them into the SHOWS objects the
// rest of this file already expects, and kicks off the first render.
async function loadData() {
  try {
    const [galleriesRes, showsRes] = await Promise.all([
      fetch('data/galleries.json'),
      fetch('data/shows.json'),
    ]);
    if (!galleriesRes.ok || !showsRes.ok) {
      throw new Error(`data fetch failed (${galleriesRes.status}, ${showsRes.status})`);
    }
    const galleries = await galleriesRes.json();
    const showsData  = await showsRes.json();

    const galleryById = {};
    galleries.forEach(g => { galleryById[g.id] = g; });

    SHOWS = showsData.shows
      .map(sh => {
        const gal = galleryById[sh.galleryId];
        if (!gal || gal.status !== 'open') return null;
        const isOngoing = sh.closes === 'ongoing';
        const closing = (!isOngoing && sh.closes) ? sh.closes : null;
        return {
          id: sh.id,
          galleryId: sh.galleryId,
          showKey: showKeyFor(sh.galleryId, sh.title),
          gallery: gal.name,
          artist: sh.artists || 'Group Exhibition',
          title: sh.title,
          neighborhood: gal.neighborhood,
          address: gal.address,
          hours: gal.hours,
          website: gal.website,
          closing: closing,
          daysLeft: closing ? daysUntil(closing) : null,
          isOngoing: isOngoing,
          isMuseum: gal.isMuseum,
          thumb: sh.image,
          lat: gal.lat,
          lng: gal.lng,
        };
      })
      .filter(s => s !== null);

    const local = loadLocalState();
    savedKeys = local.saved;
    seenKeys  = local.seen;
    hiddenMap = local.hidden;
    runMigration();

    const monthYear = TODAY.toLocaleDateString('en-US', {month: 'long', year: 'numeric'});
    const tagline = document.querySelector('.tagline');
    if (tagline) tagline.textContent = `Current exhibitions — ${monthYear}`;
    document.title = `NYC Photo Shows · ${monthYear}`;

    buildFilterBar();
    renderList();
    updateSavedCount();

    if (getSyncKey()) syncNow();
  } catch (err) {
    console.error('Failed to load gallery data:', err);
    document.getElementById('listingPage').innerHTML =
      '<div class="empty-state">Couldn’t load gallery data. Please reload the page, or try again later.</div>';
  }
}

// ─── INIT ───
updateSyncStatusUI();
loadData();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncNow();
});
window.addEventListener('online', flushPending);
setInterval(() => { if (pendingOps.length > 0) flushPending(); }, 30000);
