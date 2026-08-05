// Crash-data source registry. Every source is a small descriptor; adding a new
// state usually means adding ONE entry to CRASH_SOURCES below — most agencies
// publish crash data through ArcGIS FeatureServers, which the generic
// `arcgis` importer handles via a field mapping (no new code).

import { db } from './db.js';
import { ingestNhtsa, rebuildCrashCells } from './crashes.js';

const insertCrash = db.prepare(
  'INSERT INTO crashes (source, state, year, lat, lng, fatals, severity, crash_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
);

const ARCGIS_PAGE = 2000;
const ARCGIS_MAX_RECORDS = 150000;

// Generic importer for ArcGIS FeatureServer point layers.
// cfg: { url, latField, lngField, yearField, fatalsField, severityField, dateField }
async function importArcgis(sourceId, state, cfg, { fromYear, toYear }) {
  const where =
    cfg.yearField && fromYear
      ? `${cfg.yearField} >= ${Number(fromYear)} AND ${cfg.yearField} <= ${Number(toYear || fromYear)}`
      : '1=1';
  const fields = [cfg.latField, cfg.lngField, cfg.yearField, cfg.fatalsField, cfg.severityField, cfg.dateField]
    .filter(Boolean)
    .join(',');

  let offset = 0;
  let inserted = 0;
  let total = 0;
  for (;;) {
    const url =
      `${cfg.url}/query?where=${encodeURIComponent(where)}&outFields=${encodeURIComponent(fields)}` +
      `&returnGeometry=false&resultOffset=${offset}&resultRecordCount=${ARCGIS_PAGE}&f=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
    if (!res.ok) throw new Error(`ArcGIS returned ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`ArcGIS error: ${data.error.message || JSON.stringify(data.error)}`);
    const feats = data.features || [];
    total += feats.length;

    db.exec('BEGIN');
    try {
      for (const f of feats) {
        const a = f.attributes || {};
        const lat = Number(a[cfg.latField]);
        const lng = Number(a[cfg.lngField]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0 || lng === 0) continue;
        const fatals = Number(a[cfg.fatalsField]) || 0;
        const severity = cfg.severityField ? String(a[cfg.severityField] ?? '').toLowerCase() || null : null;
        const year = cfg.yearField ? Number(a[cfg.yearField]) || null : null;
        const date = cfg.dateField && a[cfg.dateField] ? new Date(a[cfg.dateField]).toISOString().slice(0, 10) : null;
        insertCrash.run(sourceId, state, year, lat, lng, fatals, severity, date);
        inserted++;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    // Servers cap pages at their own maxRecordCount (often < our ask), so page
    // by what actually came back and trust exceededTransferLimit when present.
    if (!feats.length || total >= ARCGIS_MAX_RECORDS) break;
    offset += feats.length;
    if (data.exceededTransferLimit !== true && feats.length < ARCGIS_PAGE) break;
  }
  return { inserted, totalRows: total };
}

// Deterministic demo clusters along major corridors so the overlay and hazard
// scoring can be exercised with zero network access.
function importSample(sourceId, state, corridors) {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const [aLat, aLng, bLat, bLng, count] of corridors) {
      for (let i = 0; i < count; i++) {
        const t = rand();
        const lat = aLat + (bLat - aLat) * t + (rand() - 0.5) * 0.015;
        const lng = aLng + (bLng - aLng) * t + (rand() - 0.5) * 0.015;
        const fatals = rand() < 0.12 ? 1 + Math.floor(rand() * 2) : 0;
        insertCrash.run(sourceId, state, 2020 + Math.floor(rand() * 3), lat, lng, fatals, fatals ? 'fatal' : 'injury', null);
        inserted++;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { inserted };
}

// ---------------------------------------------------------------------------
// The registry. `state: '*'` = available for every state.
// To add a state: find its crash dataset (most DOTs/cities publish an ArcGIS
// FeatureServer — check hub.arcgis.com), copy an `arcgis` entry, and update
// the url + field names to match the layer's schema.
// ---------------------------------------------------------------------------
export const CRASH_SOURCES = [
  {
    id: 'nhtsa-fars',
    state: '*',
    name: 'NHTSA FARS',
    description: 'Fatal crashes, nationwide coverage, exact coordinates. Federal data, ~2 years behind.',
    usesYears: true,
    run: ({ state, fromYear, toYear }) => ingestNhtsa({ state, fromYear, toYear }),
  },
  {
    id: 'az-tempe',
    state: 'AZ',
    name: 'Tempe Open Data (all severities)',
    description: 'Every reported crash in Tempe, AZ — injuries and property damage included, updated by the city.',
    usesYears: true,
    run: (params) =>
      importArcgis('az-tempe', 'AZ', {
        url: 'https://services.arcgis.com/lQySeXwbBg53XWDi/arcgis/rest/services/CrashDataReportforGISstory/FeatureServer/0',
        latField: 'Latitude',
        lngField: 'Longitude',
        yearField: 'Year',
        fatalsField: 'Totalfatalities',
        severityField: 'Injuryseverity',
        dateField: 'DateTime',
      }, params),
  },
  {
    id: 'az-phoenix-hin',
    state: 'AZ',
    name: 'Phoenix — serious & fatal crashes',
    description: 'City of Phoenix Vision Zero data: crashes causing serious injury or death, 2020–2024 (~4,300).',
    usesYears: true,
    run: (params) =>
      importArcgis('az-phoenix-hin', 'AZ', {
        url: 'https://services7.arcgis.com/Q5ACvUgn3GTccF5u/arcgis/rest/services/Phoenix_HIN_2026_Crashes_WFL1/FeatureServer/0',
        latField: 'Latitude',
        lngField: 'Longitude',
        yearField: 'IncidentYear',
        fatalsField: 'TotalFatalities',
        severityField: 'InjurySeverity_TEXT',
        dateField: 'IncidentDate',
      }, params),
  },
  {
    id: 'az-tucson',
    state: 'AZ',
    name: 'Tucson — all-severity collisions',
    description: 'City of Tucson police collision records, 2014–2023, all severities (~55,000).',
    usesYears: true,
    run: (params) =>
      importArcgis('az-tucson', 'AZ', {
        url: 'https://services3.arcgis.com/9coHY2fvuFjG9HQX/arcgis/rest/services/Total_Collisions_Point_Data/FeatureServer/43',
        latField: 'Latitude',
        lngField: 'Longitude',
        yearField: 'YEAR_OCCU',
        fatalsField: 'Total_Fatalities',
        severityField: 'Injury_Severity',
        dateField: 'Collision_Date',
      }, params),
  },
  {
    id: 'sample-az',
    state: 'AZ',
    name: 'Sample data (Phoenix metro demo)',
    description: 'Offline demo clusters along I-10, I-17, US-60, and the loops. No network needed.',
    usesYears: false,
    run: () =>
      importSample('sample-az', 'AZ', [
        [33.4610, -112.2250, 33.4280, -111.9400, 130], // I-10 west into downtown
        [33.4280, -111.9400, 33.2920, -111.7700, 110], // I-10 toward Chandler
        [33.9200, -112.1400, 33.4610, -112.1080, 120], // I-17
        [33.3870, -111.9660, 33.3960, -111.6870, 100], // US-60 Superstition
        [33.6390, -112.2300, 33.6360, -111.8900, 90],  // Loop 101 north
        [33.4500, -111.9700, 33.3350, -111.8050, 80],  // Loop 202
      ]),
  },
  {
    id: 'sample-ca',
    state: 'CA',
    name: 'Sample data (LA area demo)',
    description: 'Offline demo clusters along LA freeways. No network needed.',
    usesYears: false,
    run: () =>
      importSample('sample-ca', 'CA', [
        [34.1614, -118.4688, 33.7701, -118.2932, 140], // I-405
        [34.0362, -118.4894, 34.0193, -117.9990, 120], // I-10
        [34.1683, -118.6055, 34.0568, -118.2377, 100], // US-101
        [34.0782, -118.2820, 33.7866, -118.2810, 80],  // I-110
        [34.1425, -118.2551, 33.9245, -118.0980, 90],  // I-5 corridor
      ]),
  },
];

export function sourcesForState(state) {
  const s = String(state || '').toUpperCase();
  return CRASH_SOURCES
    .filter((src) => src.state === '*' || src.state === s)
    .map(({ run, ...meta }) => meta);
}

export async function runImport(sourceId, params) {
  const source = CRASH_SOURCES.find((s) => s.id === sourceId);
  if (!source) throw Object.assign(new Error(`Unknown crash source: ${sourceId}`), { status: 400 });
  // Idempotent re-imports: replace this source's rows rather than duplicating.
  db.prepare('DELETE FROM crashes WHERE source = ?').run(sourceId);
  const result = await source.run(params || {});
  // Keep the map's density grid in step with the rows it summarises.
  rebuildCrashCells();
  return result;
}
