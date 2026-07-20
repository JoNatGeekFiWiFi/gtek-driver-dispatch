// Route planning with a pluggable provider chain.
// Free default: OSRM public server (no key, no live traffic) + built-in rush-hour model.
// Set MAPBOX_TOKEN or TOMTOM_KEY in .env to upgrade to live traffic-aware routing.

const FETCH_TIMEOUT = 15000;

// Multiplier applied to free-tier ETAs based on typical weekday congestion patterns.
export function rushHourMultiplier(when) {
  const d = when ? new Date(when) : new Date();
  if (Number.isNaN(d.getTime())) return 1.0;
  const day = d.getDay();
  const h = d.getHours() + d.getMinutes() / 60;
  const weekend = day === 0 || day === 6;
  if (weekend) return h >= 11 && h < 18 ? 1.1 : 1.0;
  if (h >= 6.5 && h < 9.5) return 1.35;
  if (h >= 9.5 && h < 11) return 1.1;
  if (h >= 15 && h < 16) return 1.2;
  if (h >= 16 && h < 19) return 1.45;
  if (h >= 19 && h < 20.5) return 1.15;
  return 1.0;
}

// ETA outlook for the next 12 hours so dispatchers can pick a smarter departure time.
export function departureProfile(baseDurationS, departAt) {
  const start = departAt ? new Date(departAt) : new Date();
  const profile = [];
  for (let i = 0; i < 12; i++) {
    const t = new Date(start.getTime() + i * 3600 * 1000);
    const mult = rushHourMultiplier(t);
    profile.push({
      departAt: t.toISOString(),
      hourLabel: t.toLocaleTimeString([], { hour: 'numeric' }),
      multiplier: mult,
      durationS: Math.round(baseDurationS * mult),
    });
  }
  return profile;
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

const coordPath = (points) => points.map((p) => `${p.lng},${p.lat}`).join(';');

async function osrmRoute(points) {
  const url = `https://router.project-osrm.org/route/v1/driving/${coordPath(points)}?overview=full&geometries=geojson&steps=false`;
  const data = await fetchJson(url);
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error(`OSRM: ${data.code}`);
  const r = data.routes[0];
  return {
    provider: 'osrm',
    liveTraffic: false,
    geometry: r.geometry,
    distanceM: r.distance,
    durationS: r.duration,
    durationTrafficS: null, // filled in by the rush-hour model
    legs: (r.legs || []).map((l) => ({ durationS: l.duration, distanceM: l.distance })),
  };
}

async function mapboxRoute(points, token) {
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${coordPath(points)}` +
    `?overview=full&geometries=geojson&access_token=${token}`;
  const data = await fetchJson(url);
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error(`Mapbox: ${data.code}`);
  const r = data.routes[0];
  return {
    provider: 'mapbox',
    liveTraffic: true,
    geometry: r.geometry,
    distanceM: r.distance,
    durationS: r.duration_typical ?? r.duration,
    durationTrafficS: r.duration,
    legs: (r.legs || []).map((l) => ({ durationS: l.duration_typical ?? l.duration, distanceM: l.distance })),
  };
}

async function tomtomRoute(points, key) {
  const path = points.map((p) => `${p.lat},${p.lng}`).join(':');
  const url =
    `https://api.tomtom.com/routing/1/calculateRoute/${path}/json` +
    `?traffic=true&computeTravelTimeFor=all&routeRepresentation=polyline&key=${key}`;
  const data = await fetchJson(url);
  const r = data.routes?.[0];
  if (!r) throw new Error('TomTom: no route');
  const coords = r.legs.flatMap((leg) => leg.points.map((pt) => [pt.longitude, pt.latitude]));
  return {
    provider: 'tomtom',
    liveTraffic: true,
    geometry: { type: 'LineString', coordinates: coords },
    distanceM: r.summary.lengthInMeters,
    durationS: r.summary.noTrafficTravelTimeInSeconds ?? r.summary.travelTimeInSeconds,
    durationTrafficS: r.summary.travelTimeInSeconds,
    legs: (r.legs || []).map((l) => ({
      durationS: l.summary.noTrafficTravelTimeInSeconds ?? l.summary.travelTimeInSeconds,
      distanceM: l.summary.lengthInMeters,
    })),
  };
}

// Average walking pace, ~3 mph. Used to turn a walk path length into time.
export const WALK_SPEED_MPS = 1.34;

// One-way distance and round-trip time for a stop's walking sub-path.
// The driver parks at the stop, walks the path to the destination, and walks
// back to the vehicle — so time counts the length twice.
export function walkMetrics(walk) {
  if (!walk) return { oneWayM: 0, roundTripS: 0 };
  let oneWayM = Number(walk.oneWayM) || 0;
  const coords = walk.geometry?.coordinates;
  if (!oneWayM && coords && coords.length >= 2) {
    for (let i = 1; i < coords.length; i++) {
      oneWayM += haversineM(
        { lng: coords[i - 1][0], lat: coords[i - 1][1] },
        { lng: coords[i][0], lat: coords[i][1] }
      );
    }
  }
  const onSiteS = (Number(walk.onSiteMin) || 0) * 60;
  return { oneWayM, roundTripS: (oneWayM * 2) / WALK_SPEED_MPS + onSiteS };
}

const EARTH_M = 111320;
export function haversineM(a, b) {
  const dLat = (b.lat - a.lat) * (Math.PI / 180);
  const dLng = (b.lng - a.lng) * (Math.PI / 180);
  const la1 = a.lat * (Math.PI / 180);
  const la2 = b.lat * (Math.PI / 180);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(h));
}

// Last-resort estimate when no routing service is reachable: straight legs,
// road-factor-adjusted distance, 30 mph average.
function offlineEstimate(points) {
  const legs = [];
  let dist = 0;
  for (let i = 1; i < points.length; i++) {
    const legM = haversineM(points[i - 1], points[i]) * 1.25;
    legs.push({ durationS: legM / 13.4, distanceM: legM });
    dist += legM;
  }
  return {
    provider: 'offline-estimate',
    liveTraffic: false,
    geometry: { type: 'LineString', coordinates: points.map((p) => [p.lng, p.lat]) },
    distanceM: dist,
    durationS: dist / 13.4,
    durationTrafficS: null,
    legs,
  };
}

export async function planRoute(points, departAt) {
  if (!Array.isArray(points) || points.length < 2) {
    const err = new Error('At least a start and end point are required');
    err.status = 400;
    throw err;
  }
  const chain = [];
  if (process.env.MAPBOX_TOKEN) chain.push(() => mapboxRoute(points, process.env.MAPBOX_TOKEN));
  if (process.env.TOMTOM_KEY) chain.push(() => tomtomRoute(points, process.env.TOMTOM_KEY));
  chain.push(() => osrmRoute(points));

  let route = null;
  const errors = [];
  for (const attempt of chain) {
    try {
      route = await attempt();
      break;
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (!route) {
    console.warn('All routing providers failed, using offline estimate:', errors.join(' | '));
    route = offlineEstimate(points);
  }

  if (route.durationTrafficS == null) {
    route.durationTrafficS = Math.round(route.durationS * rushHourMultiplier(departAt));
  }
  route.departureProfile = departureProfile(route.durationS, departAt);
  route.schedule = computeSchedule(points, route.legs, departAt, route);
  return route;
}

// Planned arrival/departure per stop from the start time, per-leg drive times,
// and each stop's dwell allowance. Legs get the live-traffic ratio (paid
// providers) or a time-of-day rush-hour multiplier applied at the moment the
// driver would actually be on that leg (free path) — so a long multi-stop run
// accounts for hitting rush hour partway through.
export function computeSchedule(points, legs, departAt, route = {}) {
  if (!Array.isArray(points) || !points.length) return [];
  const start = departAt ? new Date(departAt) : new Date();
  const trafficRatio =
    route.liveTraffic && route.durationS ? route.durationTrafficS / route.durationS : null;

  const schedule = [];
  let cursor = start.getTime();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i > 0) {
      const rawLeg = legs?.[i - 1]?.durationS ?? 0;
      const factor = trafficRatio != null ? trafficRatio : rushHourMultiplier(new Date(cursor));
      cursor += rawLeg * factor * 1000;
    }
    const plannedArrival = new Date(cursor);
    const dwellMin = Number(p.timeLimitMin) || 0;
    const walk = walkMetrics(p.walk);
    const dwellS = dwellMin * 60 + walk.roundTripS;
    cursor += dwellS * 1000;
    const plannedDeparture = new Date(cursor);
    schedule.push({
      index: i,
      name: p.name,
      lat: p.lat,
      lng: p.lng,
      timeLimitMin: dwellMin || null,
      deadline: p.deadline || null, // optional hard "must arrive by" ISO/clock
      walkMin: walk.roundTripS ? Math.round(walk.roundTripS / 60) : null,
      walkMeters: walk.oneWayM ? Math.round(walk.oneWayM) : null,
      plannedArrival: plannedArrival.toISOString(),
      plannedDeparture: dwellS ? plannedDeparture.toISOString() : plannedArrival.toISOString(),
    });
  }
  return schedule;
}

export function activeProviders() {
  return {
    routing: process.env.MAPBOX_TOKEN ? 'mapbox' : process.env.TOMTOM_KEY ? 'tomtom' : 'osrm (free)',
    liveTraffic: Boolean(process.env.MAPBOX_TOKEN || process.env.TOMTOM_KEY),
    walkRouter: process.env.ORS_TOKEN ? 'openrouteservice' : process.env.MAPBOX_TOKEN ? 'mapbox' : null,
  };
}

// Foot-routing between two points for the "routed" walk mode. Uses
// OpenRouteService (ORS_TOKEN) or Mapbox walking (MAPBOX_TOKEN). Without a key
// the dispatcher uses the free traced/point modes instead.
export async function walkRoute(from, to) {
  if (process.env.ORS_TOKEN) {
    const res = await fetch('https://api.openrouteservice.org/v2/directions/foot-walking/geojson', {
      method: 'POST',
      headers: { Authorization: process.env.ORS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates: [[from.lng, from.lat], [to.lng, to.lat]] }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) throw new Error(`OpenRouteService: ${res.status}`);
    const data = await res.json();
    const f = data.features?.[0];
    if (!f) throw new Error('No walking route found');
    return { geometry: f.geometry, oneWayM: f.properties?.summary?.distance ?? null, provider: 'openrouteservice' };
  }
  if (process.env.MAPBOX_TOKEN) {
    const url =
      `https://api.mapbox.com/directions/v5/mapbox/walking/${from.lng},${from.lat};${to.lng},${to.lat}` +
      `?geometries=geojson&overview=full&access_token=${process.env.MAPBOX_TOKEN}`;
    const data = await fetchJson(url);
    const r = data.routes?.[0];
    if (!r) throw new Error('No walking route found');
    return { geometry: r.geometry, oneWayM: r.distance, provider: 'mapbox' };
  }
  throw Object.assign(
    new Error('No walking router configured — trace the path or drop a point instead, or set ORS_TOKEN / MAPBOX_TOKEN'),
    { status: 400 }
  );
}
