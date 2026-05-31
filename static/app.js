'use strict';

// ── Map init ──────────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true }).setView([39.0, -105.5], 7);

// Custom pane + renderer for city pins.
// circleMarker is an SVG Path — specifying `pane` alone doesn't move it; you
// must also bind a renderer to that pane so the SVG is actually created there.
// z-index 450 sits above overlayPane (400) where county/ZCTA GeoJSON lives.
map.createPane('cityPins');
map.getPane('cityPins').style.zIndex = 450;
const cityPinsRenderer = L.svg({ pane: 'cityPins' });

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 18,
}).addTo(map);

// Layer handles
let countiesLayer   = null;
let placesMarkers   = null;
let zctaLayer       = null;
let selectionLayer  = null;

// Cached GeoJSON data
let zctasGeoJSON    = null;
let placesGeoJSON   = null;
let countiesGeoJSON = null;

// Visible ZCTAs (rebuilt each selection for mousemove PIP performance)
let visibleZctaSet = new Set();

// Currently selected key (for highlighting county fill)
let selectedKey             = null;
let selectedType            = null;
let selectedDisplayName     = null;
let selectedBoundaryFeature = null;   // GeoJSON feature of selected county/place
let currentZipMap           = new Map(); // zip → {zcta_coverage, area_coverage, primary}

// ── Choropleth color scale ────────────────────────────────────────────────────
function coverageColor(c) {
  if (c >= 0.90) return '#084594';
  if (c >= 0.70) return '#2171b5';
  if (c >= 0.50) return '#4292c6';
  if (c >= 0.30) return '#9ecae1';
  return '#deebf7';
}

// ── Color palette (matches search dropdown pills) ─────────────────────────────
const C_COUNTY = '#3949ab';   // indigo
const C_PLACE  = '#2e7d32';   // forest green
const C_ZIP    = '#c62828';   // deep red

// ── Point-in-polygon helpers ──────────────────────────────────────────────────
function ptInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) &&
        pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}
function ptInFeature(pt, feature) {
  const g = feature.geometry;
  if (!g) return false;
  if (g.type === 'Polygon')      return ptInRing(pt, g.coordinates[0]);
  if (g.type === 'MultiPolygon') return g.coordinates.some(p => ptInRing(pt, p[0]));
  return false;
}

// ── County styles ─────────────────────────────────────────────────────────────
const countyStyleDefault  = { color: C_COUNTY, weight: 1.5, fillOpacity: 0.03, fillColor: C_COUNTY };
const countyStyleHover    = { fillColor: C_COUNTY, fillOpacity: 0.15 };
const countyStyleSelected = { color: C_COUNTY, weight: 2.5, fillColor: C_COUNTY, fillOpacity: 0.1, dashArray: '6,4' };

// ── Load county outlines — interactive ───────────────────────────────────────
async function loadCountyLayer() {
  const resp = await fetch('/data/co_counties.geojson');
  countiesGeoJSON = await resp.json();
  countiesLayer = L.geoJSON(countiesGeoJSON, {
    style: countyStyleDefault,
    onEachFeature: (feature, layer) => {
      const name = feature.properties.NAME;
      layer.on('mouseover', () => {
        if (!(selectedType === 'county' && selectedKey === name.toLowerCase()))
          layer.setStyle(countyStyleHover);
        layer.bringToFront();
      });
      layer.on('mouseout', () => {
        if (!(selectedType === 'county' && selectedKey === name.toLowerCase()))
          layer.setStyle(countyStyleDefault);
      });
      layer.on('click', () => {
        searchInput.value = name;
        selectLocation('county', name.toLowerCase(), name);
      });
    },
  }).addTo(map);
}

// ── Place pins ────────────────────────────────────────────────────────────────
async function loadPlaceMarkers() {
  await ensurePlaces();

  const incorporated = placesGeoJSON.features.filter(
    f => f.properties.CLASSFP === 'C1'  // incorporated cities only
  );
  const cdps = placesGeoJSON.features.filter(
    f => f.properties.CLASSFP !== 'C1'
  );

  function makeMarker(feature, radius, color, fillColor) {
    const coords = featureCentroid(feature);
    if (!coords) return null;
    const name = feature.properties.NAME;
    const marker = L.circleMarker([coords[1], coords[0]], {
      pane: 'cityPins',
      renderer: cityPinsRenderer,
      radius,
      color,
      weight: 1.5,
      fillColor,
      fillOpacity: 0.85,
      interactive: true,
    });
    marker._placeName = name;  // used by unified tooltip
    marker.on('click', () => {
      searchInput.value = name;
      selectLocation('place', name.toLowerCase(), name);
    });
    return marker;
  }

  const layers = [];
  for (const f of cdps) {
    const m = makeMarker(f, 3, C_PLACE, '#a5d6a7');
    if (m) layers.push(m);
  }
  for (const f of incorporated) {
    const m = makeMarker(f, 5, C_PLACE, '#66bb6a');
    if (m) layers.push(m);
  }

  placesMarkers = L.featureGroup(layers).addTo(map);
}

// Compute centroid from GeoJSON feature (handles Polygon and MultiPolygon)
function featureCentroid(feature) {
  const geom = feature.geometry;
  if (!geom) return null;
  if (geom.type === 'Point') return geom.coordinates;
  if (geom.type === 'Polygon') return ringCentroid(geom.coordinates[0]);
  if (geom.type === 'MultiPolygon') {
    // Use centroid of largest ring
    let best = null, bestArea = -1;
    for (const poly of geom.coordinates) {
      const a = Math.abs(ringArea(poly[0]));
      if (a > bestArea) { bestArea = a; best = poly[0]; }
    }
    return best ? ringCentroid(best) : null;
  }
  return null;
}

function ringCentroid(coords) {
  let x = 0, y = 0;
  for (const [cx, cy] of coords) { x += cx; y += cy; }
  return [x / coords.length, y / coords.length];
}

function ringArea(coords) {
  let area = 0;
  for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
    area += (coords[j][0] + coords[i][0]) * (coords[j][1] - coords[i][1]);
  }
  return area / 2;
}

// ── Lazy loaders ─────────────────────────────────────────────────────────────
let zctaLabels = null;

async function ensureZctas() {
  if (!zctasGeoJSON) {
    const [geo, labels] = await Promise.all([
      fetch('/data/co_zctas.geojson').then(r => r.json()),
      fetch('/data/zcta_labels.json').then(r => r.json()),
    ]);
    zctasGeoJSON = geo;
    zctaLabels   = labels;
  }
}

async function ensurePlaces() {
  if (!placesGeoJSON) {
    const r = await fetch('/data/co_places.geojson');
    placesGeoJSON = await r.json();
  }
}

// ── URL state ─────────────────────────────────────────────────────────────────
function pushUrl(type, key) {
  const params = new URLSearchParams({ type, name: key });
  history.pushState({ type, key }, '', '?' + params.toString());
}

function readUrlParams() {
  const p = new URLSearchParams(window.location.search);
  const type = p.get('type'), name = p.get('name');
  return (type && name) ? { type, name } : null;
}

window.addEventListener('popstate', (e) => {
  if (e.state) {
    selectLocation(e.state.type, e.state.key, null, /* pushUrl= */ false);
  } else {
    clearSelection();
  }
});

// ── Search autocomplete ───────────────────────────────────────────────────────
const searchInput   = document.getElementById('search-input');
const suggestionBox = document.getElementById('suggestions');

let debounceTimer = null;

searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) { hideSuggestions(); return; }
  debounceTimer = setTimeout(() => fetchSuggestions(q), 200);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { hideSuggestions(); searchInput.blur(); }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#search-container')) hideSuggestions();
});

async function fetchSuggestions(q) {
  const results = await fetch(`/api/search?q=${encodeURIComponent(q)}`).then(r => r.json());
  if (!results.length) { hideSuggestions(); return; }

  suggestionBox.innerHTML = results.map(r =>
    `<li data-type="${r.type}" data-key="${encodeURIComponent(r.key)}" data-name="${escHtml(r.name)}">
      <span>${escHtml(r.name)}</span>
      <span class="type-badge ${r.type}">${r.type}</span>
    </li>`
  ).join('');
  suggestionBox.style.display = 'block';
}

function hideSuggestions() {
  suggestionBox.style.display = 'none';
  suggestionBox.innerHTML = '';
}

suggestionBox.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  const { type, key, name } = li.dataset;
  searchInput.value = name;
  hideSuggestions();
  selectLocation(type, decodeURIComponent(key), name);
});

// ── Main selection handler ────────────────────────────────────────────────────
async function selectLocation(type, key, displayName, doPushUrl = true) {
  // Resolve displayName from search index if not provided (e.g. popstate restore)
  if (!displayName) {
    const results = await fetch(`/api/search?q=${encodeURIComponent(key)}`).then(r => r.json());
    const match = results.find(r => r.type === type && r.key === key);
    displayName = match ? match.name : key;
    searchInput.value = displayName;
  }

  if (doPushUrl) pushUrl(type, key);

  selectedType        = type;
  selectedKey         = key;
  selectedDisplayName = displayName;

  // Show loading state
  document.getElementById('result-info').style.display = 'block';
  document.getElementById('empty-state').style.display  = 'none';
  document.getElementById('result-name').textContent = displayName;
  document.getElementById('result-type').textContent = type === 'county' ? 'County' : 'City / Place';
  document.getElementById('result-summary').textContent = 'Loading…';

  // Reset all county styles, then highlight selected county
  if (countiesLayer) {
    countiesLayer.resetStyle();
    if (type === 'county') {
      countiesLayer.eachLayer(layer => {
        if (layer.feature.properties.NAME.toLowerCase() === key)
          layer.setStyle(countyStyleSelected);
      });
    }
  }

  // Fetch overlap data
  const data = await fetch(`/api/zipcodes?type=${type}&name=${encodeURIComponent(key)}`).then(r => r.json());

  // Load geometries in parallel
  await Promise.all([ensureZctas(), type === 'place' ? ensurePlaces() : Promise.resolve()]);

  // Remove previous ZCTA + selection layers
  if (zctaLayer)      { map.removeLayer(zctaLayer);      zctaLayer      = null; }
  if (selectionLayer) { map.removeLayer(selectionLayer); selectionLayer = null; }

  // Build fast lookup map (also cached at module level for tooltip)
  const zipMap = new Map(data.zips.map(z => [z.zip, z]));
  currentZipMap = zipMap;

  // Cache boundary feature for tooltip inside/outside check
  const boundarySource  = type === 'county' ? countiesGeoJSON : placesGeoJSON;
  selectedBoundaryFeature = boundarySource.features.find(
    f => f.properties.NAME && f.properties.NAME.toLowerCase() === key
  ) || null;

  // Draw ZCTA choropleth (below county outlines)
  visibleZctaSet = new Set(data.zips.map(z => z.zip));
  zctaLayer = L.geoJSON(zctasGeoJSON, {
    filter: f => zipMap.has(f.properties.ZCTA5CE20),
    style:  f => {
      const z = zipMap.get(f.properties.ZCTA5CE20);
      return { fillColor: coverageColor(z.zcta_coverage), fillOpacity: 0.65, color: C_ZIP, weight: 1 };
    },
    onEachFeature: (f, layer) => {
      const z = zipMap.get(f.properties.ZCTA5CE20);
      const baseStyle = { fillColor: coverageColor(z.zcta_coverage), fillOpacity: 0.65, color: C_ZIP, weight: 1 };
      layer.on('mouseover', () => layer.setStyle({ fillColor: '#ffcdd2', fillOpacity: 0.85, color: C_ZIP, weight: 2 }));
      layer.on('mouseout',  () => layer.setStyle(baseStyle));
    },
  }).addTo(map);

  // For places: draw dashed green boundary outline
  if (type === 'place') {
    const matchFeature = placesGeoJSON.features.find(
      f => f.properties.NAME && f.properties.NAME.toLowerCase() === key
    );
    if (matchFeature) {
      selectionLayer = L.geoJSON(matchFeature, {
        style: { color: C_PLACE, weight: 2.5, fillColor: C_PLACE, fillOpacity: 0.06, dashArray: '6,4' },
      }).addTo(map);
    }
  }

  // Bring county outlines above ZCTA layer (city pins stay on top via their dedicated pane)
  if (countiesLayer)  countiesLayer.bringToFront();

  // Update sidebar
  const primary = data.zips.filter(z => z.primary);
  const partial  = data.zips.filter(z => !z.primary);
  document.getElementById('result-summary').textContent =
    data.zips.length === 0
      ? 'No qualifying ZIP codes found (no ZCTAs overlap ≥10%).'
      : `${primary.length} primary ZIP${primary.length !== 1 ? 's' : ''} (≥50% coverage), ` +
        `${partial.length} partial ZIP${partial.length !== 1 ? 's' : ''} (10–50%)`;

  document.getElementById('legend').style.display   = data.zips.length ? 'block' : 'none';
  document.getElementById('clear-btn').style.display = 'block';

  // Render panel first so it takes its space, then invalidate + fit.
  // fitBounds before renderZipPanel means the 260px panel height isn't
  // accounted for yet on first selection, clipping the bottom of the view.
  renderZipPanel(data, displayName, type);

  requestAnimationFrame(() => {
    map.invalidateSize();
    if (selectedBoundaryFeature) {
      map.fitBounds(L.geoJSON(selectedBoundaryFeature).getBounds(), { padding: [40, 40] });
    } else if (zctaLayer.getLayers().length > 0) {
      map.fitBounds(zctaLayer.getBounds(), { padding: [30, 30] });
    }
  });
}

const CO_BOUNDS = [[36.99, -109.06], [41.00, -102.04]];

function clearSelection() {
  selectedType = null;
  selectedKey  = null;
  searchInput.value = '';
  if (zctaLayer)      { map.removeLayer(zctaLayer);      zctaLayer      = null; }
  if (selectionLayer) { map.removeLayer(selectionLayer); selectionLayer = null; }
  if (countiesLayer)  countiesLayer.resetStyle();
  visibleZctaSet.clear();
  currentZipMap.clear();
  selectedBoundaryFeature = null;
  selectedDisplayName     = null;
  document.getElementById('result-info').style.display  = 'none';
  document.getElementById('empty-state').style.display  = 'block';
  document.getElementById('zip-panel').style.display    = 'none';
  document.getElementById('legend').style.display       = 'none';
  document.getElementById('clear-btn').style.display    = 'none';
  history.pushState(null, '', window.location.pathname);
  requestAnimationFrame(() => {
    map.invalidateSize();
    map.fitBounds(CO_BOUNDS, { padding: [20, 20] });
  });
}

// ── ZIP panel ─────────────────────────────────────────────────────────────────
function renderZipPanel(data, displayName, type) {
  const panel = document.getElementById('zip-panel');
  panel.style.display = 'flex';

  document.getElementById('zip-panel-title').textContent = displayName;

  const primary = data.zips.filter(z => z.primary);
  const partial  = data.zips.filter(z => !z.primary);
  document.getElementById('zip-panel-counts').textContent =
    `${primary.length} primary (≥${Math.round(ZCTA_PRIMARY_COVERAGE * 100)}% coverage) · ${partial.length} partial · ${data.zips.length} total`;

  currentZips        = data.zips.map(z => z.zip);
  currentPrimaryZips = data.zips.filter(z => z.primary).map(z => z.zip);
  document.getElementById('zip-text-output').textContent = formatZips(currentZips, currentFmt);

  const tbody = document.getElementById('zip-table-body');
  tbody.innerHTML = data.zips.map(z => `
    <tr class="${z.primary ? 'primary-zip' : ''}">
      <td>${z.zip}</td>
      <td>${(z.zcta_coverage * 100).toFixed(0)}%</td>
      <td>${(z.area_coverage * 100).toFixed(1)}%</td>
      <td><span class="${z.primary ? 'badge-primary' : 'badge-partial'}">${z.primary ? 'Primary' : 'Partial'}</span></td>
    </tr>`
  ).join('');
}

// ── Constants ─────────────────────────────────────────────────────────────────
const ZCTA_PRIMARY_COVERAGE = 0.50;  // must match setup.py

// ── Copy format tabs ──────────────────────────────────────────────────────────
let currentZips        = [];
let currentPrimaryZips = [];
let currentFmt         = 'list';

const FMT = {
  list:  zips => zips.join(', '),
  regex: zips => zips.join('|'),
  rows:  zips => zips.join('\n'),
  cols:  zips => zips.join('\t'),
};

function formatZips(zips, fmt) {
  return zips.length ? FMT[fmt](zips) : '(none — no ZCTAs overlap ≥10%)';
}

document.getElementById('copy-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-tab');
  if (!btn) return;
  document.querySelectorAll('.copy-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentFmt = btn.dataset.fmt;
  document.getElementById('zip-text-output').textContent = formatZips(currentZips, currentFmt);
});

// ── Copy buttons ──────────────────────────────────────────────────────────────
function flashCopied() {
  const fb = document.getElementById('copy-feedback');
  fb.style.display = 'block';
  setTimeout(() => { fb.style.display = 'none'; }, 2000);
}

document.getElementById('copy-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(document.getElementById('zip-text-output').textContent).then(flashCopied);
});

document.getElementById('copy-primary-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(formatZips(currentPrimaryZips, currentFmt)).then(flashCopied);
});

// ── Clear button ──────────────────────────────────────────────────────────────
document.getElementById('clear-btn').addEventListener('click', clearSelection);

// ── Unified hover tooltip ─────────────────────────────────────────────────────
const hoverTip = document.getElementById('map-hover-tip');
let   tipFrame = null;

map.on('mousemove', (e) => {
  if (tipFrame) cancelAnimationFrame(tipFrame);
  tipFrame = requestAnimationFrame(() => showHoverTip(e));
});
map.on('mouseout', () => { hoverTip.style.display = 'none'; });

function showHoverTip(e) {
  const pt = [e.latlng.lng, e.latlng.lat];

  // Nearest city pin within 10px (checked in both modes)
  let pinCity = null;
  if (placesMarkers) {
    let bestDist = 10;
    placesMarkers.eachLayer(marker => {
      if (!marker._placeName) return;
      const dist = e.containerPoint.distanceTo(map.latLngToContainerPoint(marker.getLatLng()));
      if (dist < bestDist) { bestDist = dist; pinCity = marker._placeName; }
    });
  }

  let html = '';

  if (!selectedKey) {
    // ── Mode 1: no selection — show what a click would select ────────────────
    if (pinCity) {
      html = `<div class="tt-place">${pinCity}</div><div class="tt-hint">click to select</div>`;
    } else {
      let countyName = null;
      for (const f of (countiesGeoJSON?.features ?? [])) {
        if (ptInFeature(pt, f)) { countyName = f.properties.NAME; break; }
      }
      if (countyName) {
        html = `<div class="tt-county">${countyName} County</div><div class="tt-hint">click to select</div>`;
      }
    }
  } else {
    // ── Mode 2: selection active — show context relative to selection ─────────
    const inside = selectedBoundaryFeature ? ptInFeature(pt, selectedBoundaryFeature) : false;

    // Find ZCTA under cursor (check all ZCTAs, not just visible ones)
    let zcta = null;
    for (const f of (zctasGeoJSON?.features ?? [])) {
      if (ptInFeature(pt, f)) { zcta = f.properties.ZCTA5CE20; break; }
    }

    // Inside/outside line
    const label = selectedDisplayName || selectedKey;
    html += inside
      ? `<div class="tt-inside">inside ${label}</div>`
      : `<div class="tt-outside">outside ${label}</div>`;

    // ZIP line
    if (zcta) {
      html += `<div class="tt-zip">${zcta}</div>`;

      // Coverage stats — only when inside and ZIP is in our selection data
      if (inside && currentZipMap.has(zcta)) {
        const z = currentZipMap.get(zcta);
        html +=
          `<div class="tt-zip-stats">` +
            `${(z.zcta_coverage * 100).toFixed(0)}% of ZIP is inside` +
          `</div>` +
          `<div class="tt-zip-stats">` +
            `${(z.area_coverage * 100).toFixed(1)}% of area covered by ZIP` +
          `</div>`;
      }
    }
  }

  if (!html) { hoverTip.style.display = 'none'; return; }

  hoverTip.innerHTML = html;
  hoverTip.style.display = 'block';

  const { clientX, clientY } = e.originalEvent;
  const tw = hoverTip.offsetWidth, th = hoverTip.offsetHeight;
  const ox = (clientX + tw + 20 > window.innerWidth)  ? -tw - 10 : 15;
  const oy = (clientY + th + 10 > window.innerHeight) ? -th - 5  : -10;
  hoverTip.style.left = (clientX + ox) + 'px';
  hoverTip.style.top  = (clientY + oy) + 'px';
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
// Load counties first, then place markers on top, then restore URL state.
loadCountyLayer()
  .then(() => ensurePlaces())
  .then(() => loadPlaceMarkers())
  .then(() => {
    const urlState = readUrlParams();
    if (urlState) selectLocation(urlState.type, urlState.name, null, /* doPushUrl= */ false);
  })
  .catch(err => console.error('Boot error:', err));
