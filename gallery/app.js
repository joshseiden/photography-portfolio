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
let savedIds = new Set(JSON.parse(localStorage.getItem('gallery-savedIds') || '[]'));
let seenIds  = new Set(JSON.parse(localStorage.getItem('gallery-seenIds')  || '[]'));
let walkMap  = null;
let walkMarkers = {};

function saveState() {
  localStorage.setItem('gallery-savedIds', JSON.stringify([...savedIds]));
  localStorage.setItem('gallery-seenIds',  JSON.stringify([...seenIds]));
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
  bar.innerHTML =
    '<button class="filter-chip active" data-filter="all">All</button>' +
    '<button class="filter-chip closing-chip" data-filter="closing">Closing Soon</button>' +
    '<button class="filter-chip saved-chip" data-filter="saved">My Visit</button>' +
    hoods.map(n => `<button class="filter-chip" data-filter="${n}">${n}</button>`).join('');

  bar.addEventListener('click', e => {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;
    bar.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    activeFilter = chip.dataset.filter;
    renderList();
  });
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
  if (el) el.textContent = savedIds.size > 0 ? `${savedIds.size} saved` : '';
}

// ─── PLAN / LIST ───
function visibleShows() {
  return SHOWS.filter(s => {
    if (s.isOngoing) return true;
    const d = daysUntil(s.closing);
    return d !== null && d >= 0;
  });
}

function getFilteredShows() {
  return visibleShows().filter(s => {
    if (activeFilter === 'all')     return true;
    if (activeFilter === 'closing') return !s.isOngoing && daysUntil(s.closing) <= 7;
    if (activeFilter === 'saved')   return savedIds.has(s.id);
    return s.neighborhood === activeFilter;
  });
}

function renderList() {
  const page  = document.getElementById('listingPage');
  const shows = getFilteredShows();
  page.innerHTML = '';

  if (shows.length === 0) {
    page.innerHTML = '<div class="empty-state">No shows match this filter.</div>';
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
      hoodShows.map(s => renderCard(s)).join('');
    page.appendChild(sec);
  });
}

function renderCard(s) {
  const days   = s.isOngoing ? null : daysUntil(s.closing);
  const urgent = !s.isOngoing && days !== null && days <= 7;
  const saved  = savedIds.has(s.id);
  const seen   = seenIds.has(s.id);

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
      `<button class="save-btn ${saved?'saved':''}"` +
              ` onclick="toggleSave(event,'${s.id}')"` +
              ` title="${saved?'Remove from visit':'Add to visit'}">${saved?'♦':'◇'}</button>` +
    `</div>`
  );
}

function toggleSave(e, id) {
  e.stopPropagation();
  if (savedIds.has(id)) { savedIds.delete(id); } else { savedIds.add(id); }
  saveState(); renderList(); updateSavedCount();
}

function toggleSeen(id) {
  if (seenIds.has(id)) { seenIds.delete(id); } else { seenIds.add(id); }
  saveState();
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

  if (savedIds.size === 0) {
    container.innerHTML = '<div class="walk-no-saves"><strong>No shows saved</strong>Switch to Plan mode and tap ◇ to add shows to your visit.</div>';
    if (countEl) countEl.textContent = '';
    return;
  }

  const saved  = SHOWS.filter(s => savedIds.has(s.id));
  const unseen = saved.filter(s => !seenIds.has(s.id));
  const seen   = saved.filter(s =>  seenIds.has(s.id));
  if (countEl) countEl.textContent = `${unseen.length} remaining`;

  container.innerHTML = [...unseen, ...seen].map(s => {
    const isSeen = seenIds.has(s.id);
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

  const saved = SHOWS.filter(s => savedIds.has(s.id) && s.lat !== null && s.lng !== null);
  if (saved.length === 0) { walkMap.setView([40.740, -74.000], 13); return; }

  saved.forEach(s => {
    const color  = (NEIGHBORHOODS[s.neighborhood] || {}).color || '#444';
    const isSeen = seenIds.has(s.id);
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
  const isSaved = savedIds.has(s.id);
  const isSeen  = seenIds.has(s.id);

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
    `</div>`;

  const page = document.getElementById('detailPage');
  page.classList.add('active');
  page.scrollTop = 0;
  document.body.style.overflow = 'hidden';
}

function detailToggleSave(id) {
  if (savedIds.has(id)) { savedIds.delete(id); } else { savedIds.add(id); }
  saveState(); updateSavedCount();
  const isSaved = savedIds.has(id);
  const btn = document.getElementById('detailSaveBtn');
  if (btn) { btn.className = `detail-save-btn ${isSaved?'saved':''}`; btn.textContent = isSaved?'♦ Saved to Visit':'◇ Add to Visit'; }
  renderList();
}

function detailToggleSeen(id) {
  if (seenIds.has(id)) { seenIds.delete(id); } else { seenIds.add(id); }
  saveState();
  const isSeen = seenIds.has(id);
  const btn = document.getElementById('detailSeenBtn');
  if (btn) { btn.className = `detail-seen-btn ${isSeen?'seen':''}`; btn.textContent = isSeen?'✓ Seen':'Mark Seen'; }
  if (currentMode === 'walk') { renderWalkList(); updateWalkMarkers(); }
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

    const monthYear = TODAY.toLocaleDateString('en-US', {month: 'long', year: 'numeric'});
    const tagline = document.querySelector('.tagline');
    if (tagline) tagline.textContent = `Current exhibitions — ${monthYear}`;
    document.title = `NYC Photo Shows · ${monthYear}`;

    buildFilterBar();
    renderList();
    updateSavedCount();
  } catch (err) {
    console.error('Failed to load gallery data:', err);
    document.getElementById('listingPage').innerHTML =
      '<div class="empty-state">Couldn’t load gallery data. Please reload the page, or try again later.</div>';
  }
}

// ─── INIT ───
loadData();
