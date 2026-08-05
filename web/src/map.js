// Shared MapLibre helpers. Uses free OpenStreetMap raster tiles — no API key.
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// Default view: Phoenix, AZ (primary testing region).
export function createMap(container, { center = [-112.074, 33.4484], zoom = 10 } = {}) {
  const map = new maplibregl.Map({
    container,
    center,
    zoom,
    attributionControl: { compact: true },
    style: {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '© OpenStreetMap contributors',
        },
      },
      layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
    },
  });
  // The container can measure 0x0 on first paint (styles land after mount),
  // which locks the canvas at a default size — track it ourselves.
  const ro = new ResizeObserver(() => map.resize());
  ro.observe(container);
  map.on('remove', () => ro.disconnect());
  if (import.meta.env.DEV) window.__map = map;
  return map;
}

// Run fn now if the style JSON is parsed; otherwise retry once it is.
// (isStyleLoaded()/`load` also wait on tile downloads, which can take many
// seconds on the free OSM tile server — layers don't need to wait for that.)
function whenStyleReady(map, fn) {
  try {
    fn();
  } catch {
    map.once('styledata', () => whenStyleReady(map, fn));
  }
}

export function setLineLayer(map, id, geometry, opts = {}) {
  whenStyleReady(map, () => setLineLayerNow(map, id, geometry, opts));
}

function setLineLayerNow(map, id, geometry, { color = '#2f7df6', width = 5, dash = null } = {}) {
  const data = geometry
    ? { type: 'Feature', geometry, properties: {} }
    : { type: 'FeatureCollection', features: [] };
  if (map.getSource(id)) {
    map.getSource(id).setData(data);
  } else {
    map.addSource(id, { type: 'geojson', data });
    map.addLayer({
      id,
      type: 'line',
      source: id,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': color,
        'line-width': width,
        'line-opacity': 0.85,
        ...(dash ? { 'line-dasharray': dash } : {}),
      },
    });
  }
}

export function setCrashLayer(map, id, crashes) {
  whenStyleReady(map, () => setCrashLayerNow(map, id, crashes));
}

function setCrashLayerNow(map, id, crashes) {
  const data = {
    type: 'FeatureCollection',
    features: crashes.map((c) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
      // `weight` > 1 means this point is an aggregated density cell standing in
      // for that many crashes (wide zooms); raw points weigh 1.
      properties: { fatals: c.fatals || 0, weight: c.weight || 1 },
    })),
  };
  if (map.getSource(id)) {
    map.getSource(id).setData(data);
    return;
  }
  map.addSource(id, { type: 'geojson', data });
  map.addLayer({
    id: `${id}-heat`,
    type: 'heatmap',
    source: id,
    maxzoom: 13,
    paint: {
      // An aggregated cell stands in for `weight` crashes, but feeding that
      // count in raw saturates the ramp instantly and the whole metro reads
      // solid red. Square-root compression keeps a single raw point at exactly
      // its old value (√1 = 1) while letting dense cells register as hotter,
      // and the cap preserves contrast between "busy" and "worst".
      'heatmap-weight': [
        'min', 6,
        ['+', ['^', ['get', 'weight'], 0.5], ['*', 2, ['get', 'fatals']]],
      ],
      'heatmap-intensity': 0.6,
      'heatmap-radius': 22,
      'heatmap-opacity': 0.55,
      'heatmap-color': [
        'interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(0,0,0,0)',
        0.3, 'rgba(255,196,0,0.5)',
        0.7, 'rgba(255,110,0,0.7)',
        1, 'rgba(230,0,0,0.85)',
      ],
    },
  });
  map.addLayer({
    id: `${id}-pts`,
    type: 'circle',
    source: id,
    minzoom: 11,
    paint: {
      'circle-radius': ['case', ['>', ['get', 'fatals'], 0], 6, 4],
      'circle-color': ['case', ['>', ['get', 'fatals'], 0], '#d81b1b', '#f39c12'],
      'circle-opacity': 0.75,
      'circle-stroke-width': 1,
      'circle-stroke-color': '#fff',
    },
  });
}

export function removeCrashLayer(map, id) {
  for (const layer of [`${id}-heat`, `${id}-pts`]) {
    if (map.getLayer(layer)) map.removeLayer(layer);
  }
  if (map.getSource(id)) map.removeSource(id);
}

// Draw all stops' walking sub-paths as dashed lines with a foot-destination
// dot at the far end. Reuses one source/layer set per map.
export function setWalkPaths(map, stops) {
  const lines = { type: 'FeatureCollection', features: [] };
  const ends = { type: 'FeatureCollection', features: [] };
  (stops || []).forEach((s) => {
    const c = s.walk?.geometry?.coordinates;
    if (!c || c.length < 2) return;
    lines.features.push({ type: 'Feature', geometry: s.walk.geometry, properties: {} });
    ends.features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c[c.length - 1] }, properties: {} });
  });
  const apply = () => {
    if (map.getSource('walk-lines')) {
      map.getSource('walk-lines').setData(lines);
      map.getSource('walk-ends').setData(ends);
      return;
    }
    map.addSource('walk-lines', { type: 'geojson', data: lines });
    map.addLayer({
      id: 'walk-lines', type: 'line', source: 'walk-lines',
      layout: { 'line-cap': 'round' },
      paint: { 'line-color': '#2ecc71', 'line-width': 3, 'line-dasharray': [1, 1.5] },
    });
    map.addSource('walk-ends', { type: 'geojson', data: ends });
    map.addLayer({
      id: 'walk-ends', type: 'circle', source: 'walk-ends',
      paint: { 'circle-radius': 5, 'circle-color': '#2ecc71', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' },
    });
  };
  map.isStyleLoaded() ? apply() : map.once('styledata', apply);
}

// Numbered stop markers for a route. `arrived` is a map of visited stop
// indices; `targetIdx` is the stop the driver is currently heading to.
// Reuses a per-map marker array so repeated calls don't leak markers.
export function setStopMarkers(map, stops, { arrived = {}, targetIdx = -1 } = {}) {
  if (!map.__stopMarkers) map.__stopMarkers = [];
  map.__stopMarkers.forEach((m) => m.remove());
  map.__stopMarkers = [];
  const last = stops.length - 1;
  stops.forEach((s, i) => {
    if (s.lat == null || s.lng == null) return;
    const isStart = i === 0, isEnd = i === last;
    const state = arrived[i] || isStart ? 'done' : i === targetIdx ? 'current' : 'upcoming';
    const glyph = isStart ? '◆' : isEnd ? '■' : i;
    const el = document.createElement('div');
    el.className = `stop-marker ${state}`;
    el.textContent = glyph;
    const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat([s.lng, s.lat])
      .setPopup(new maplibregl.Popup({ offset: 16 }).setText(s.name || `Stop ${i}`))
      .addTo(map);
    map.__stopMarkers.push(marker);
  });
}

export function makeMarker(map, lngLat, { color, label, html } = {}) {
  let el;
  if (html) {
    el = document.createElement('div');
    el.innerHTML = html;
    el = el.firstElementChild;
  }
  const marker = el
    ? new maplibregl.Marker({ element: el })
    : new maplibregl.Marker({ color: color || '#2f7df6' });
  marker.setLngLat(lngLat).addTo(map);
  if (label) marker.setPopup(new maplibregl.Popup({ offset: 18 }).setText(label));
  return marker;
}

export { maplibregl };
