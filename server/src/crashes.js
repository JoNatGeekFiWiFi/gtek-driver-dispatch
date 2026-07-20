// Public crash data: NHTSA FARS (Fatality Analysis Reporting System) ingest,
// map overlay queries, and hazard scoring for planned routes.
// State DOT feeds can be added later as additional ingest adapters.

import { db } from './db.js';

const NHTSA_BASE = 'https://crashviewer.nhtsa.dot.gov/CrashAPI';

// FIPS codes for the NHTSA API, keyed by postal abbreviation.
export const STATE_FIPS = {
  AL: 1, AK: 2, AZ: 4, AR: 5, CA: 6, CO: 8, CT: 9, DE: 10, DC: 11, FL: 12,
  GA: 13, HI: 15, ID: 16, IL: 17, IN: 18, IA: 19, KS: 20, KY: 21, LA: 22,
  ME: 23, MD: 24, MA: 25, MI: 26, MN: 27, MS: 28, MO: 29, MT: 30, NE: 31,
  NV: 32, NH: 33, NJ: 34, NM: 35, NY: 36, NC: 37, ND: 38, OH: 39, OK: 40,
  OR: 41, PA: 42, RI: 44, SC: 45, SD: 46, TN: 47, TX: 48, UT: 49, VT: 50,
  VA: 51, WA: 53, WV: 54, WI: 55, WY: 56,
};

const insertCrash = db.prepare(
  'INSERT INTO crashes (source, state, year, lat, lng, fatals, severity, crash_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
);

function findKey(row, ...names) {
  const keys = Object.keys(row);
  for (const n of names) {
    const k = keys.find((key) => key.toLowerCase() === n.toLowerCase());
    if (k !== undefined) return row[k];
  }
  return undefined;
}

function validUsCoord(lat, lng) {
  // FARS uses sentinel values like 77.7777 / 88.8888 / 99.9999 for unknown locations;
  // a plausible-US range check filters those out.
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= 15 && lat <= 72 && lng >= -180 && lng <= -60;
}

export async function ingestNhtsa({ state, fromYear, toYear }) {
  const fips = STATE_FIPS[String(state).toUpperCase()] ?? Number(state);
  if (!fips) throw Object.assign(new Error('Unknown state — use a postal code like CA or TX'), { status: 400 });
  const from = Number(fromYear);
  const to = Number(toYear || fromYear);

  const url =
    `${NHTSA_BASE}/FARSData/GetFARSData?dataset=Accident&fromYear=${from}&toYear=${to}` +
    `&state=${fips}&format=json`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) DispatchRouteBuilder/0.1',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`NHTSA API returned ${res.status} — try again later or load sample data`);
  const data = await res.json();

  const rows = (data.Results || []).flat();
  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const lat = parseFloat(findKey(row, 'LATITUDE', 'latitude'));
      const lng = parseFloat(findKey(row, 'LONGITUD', 'LONGITUDE', 'longitud'));
      if (!validUsCoord(lat, lng)) continue;
      const fatals = parseInt(findKey(row, 'FATALS', 'fatals'), 10) || 0;
      const year = parseInt(findKey(row, 'CaseYear', 'YEAR', 'year'), 10) || from;
      insertCrash.run('nhtsa-fars', String(state).toUpperCase(), year, lat, lng, fatals, 'fatal', null);
      inserted++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { inserted, totalRows: rows.length };
}

export function crashesInBbox({ minLat, minLng, maxLat, maxLng, limit = 3000 }) {
  // Random sample when the view holds more points than the cap, so wide zooms
  // show a representative density instead of whichever source imported first.
  return db
    .prepare(
      'SELECT lat, lng, fatals, severity, year, source FROM crashes WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? ORDER BY RANDOM() LIMIT ?'
    )
    .all(Number(minLat), Number(maxLat), Number(minLng), Number(maxLng), Number(limit));
}

export function crashStats() {
  return db.prepare('SELECT source, COUNT(*) AS count FROM crashes GROUP BY source').all();
}

// Score a planned route by counting known crashes within `radiusM` of the
// route line, weighted by fatalities, normalized per km.
export function hazardForGeometry(geometry, radiusM = 150) {
  const coords = geometry?.coordinates;
  if (!coords || coords.length < 2) return { count: 0, score: 0, rating: 'unknown' };

  const pad = 0.02;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [lng, lat] of coords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  const candidates = crashesInBbox({
    minLat: minLat - pad, maxLat: maxLat + pad,
    minLng: minLng - pad, maxLng: maxLng + pad,
    limit: 20000,
  });
  if (!candidates.length) return { count: 0, score: 0, rating: 'no data' };

  const refLat = (minLat + maxLat) / 2;
  const mPerDegLng = 111320 * Math.cos((refLat * Math.PI) / 180);
  const mPerDegLat = 110540;
  const toXY = (lng, lat) => [lng * mPerDegLng, lat * mPerDegLat];

  const line = coords.map(([lng, lat]) => toXY(lng, lat));
  let lengthM = 0;
  for (let i = 1; i < line.length; i++) {
    lengthM += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  }

  // Severity-weighted: property-damage-only crashes barely count, fatal
  // crashes dominate. Keeps scores comparable whether a state has sparse
  // fatal-only FARS data or a dense all-severity city feed loaded.
  let count = 0;
  let weighted = 0;
  for (const c of candidates) {
    const p = toXY(c.lng, c.lat);
    if (minDistToPolyline(p, line) <= radiusM) {
      count++;
      const sev = (c.severity || '').toLowerCase();
      const base = c.fatals > 0 || sev.includes('fatal') ? 5
        : sev.includes('incapacitating') && !sev.includes('non') ? 2
        : sev.includes('no injury') || sev.includes('property') ? 0.2
        : 1;
      weighted += base + (c.fatals || 0);
    }
  }

  const km = Math.max(lengthM / 1000, 0.1);
  const score = weighted / km;
  // Thresholds are a tuning knob — calibrated so a typical metro arterial run
  // with all-severity data lands "moderate" and crash-hotspot corridors "high".
  const rating = score < 3 ? 'low' : score < 25 ? 'moderate' : 'high';
  return { count, score: Math.round(score * 100) / 100, rating, routeKm: Math.round(km * 10) / 10 };
}

export function minDistToPolyline(p, line) {
  let min = Infinity;
  for (let i = 1; i < line.length; i++) {
    const d = distToSegment(p, line[i - 1], line[i]);
    if (d < min) min = d;
  }
  return min;
}

function distToSegment(p, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const lenSq = abx * abx + aby * aby;
  let t = lenSq === 0 ? 0 : ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * abx), p[1] - (a[1] + t * aby));
}
