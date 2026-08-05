import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, 'dispatch.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS orgs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL REFERENCES orgs(id),
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('dispatcher','driver')),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL REFERENCES orgs(id),
    name TEXT NOT NULL,
    driver_id INTEGER REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft','assigned','in_progress','completed')),
    points_json TEXT NOT NULL,
    geometry_json TEXT,
    distance_m REAL,
    duration_s REAL,
    duration_traffic_s REAL,
    hazard_score REAL,
    hazard_count INTEGER,
    provider TEXT,
    scheduled_start TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL,
    driver_id INTEGER NOT NULL,
    route_id INTEGER,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    speed REAL,
    heading REAL,
    accuracy REAL,
    ts TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_positions_driver ON positions(driver_id, ts);
  CREATE INDEX IF NOT EXISTS idx_positions_ts ON positions(ts);

  CREATE TABLE IF NOT EXISTS crashes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    state TEXT,
    year INTEGER,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    fatals INTEGER DEFAULT 0,
    severity TEXT,
    crash_date TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_crashes_geo ON crashes(lat, lng);

  -- Pre-aggregated crash density, one row per ~500 m cell. The map overlay is
  -- a heatmap, so at wide zooms cell totals look identical to plotting every
  -- point — but the query cost tracks cells in view instead of rows in view,
  -- which is what keeps panning fast once a statewide import lands.
  CREATE TABLE IF NOT EXISTS crash_cells (
    gy INTEGER NOT NULL,
    gx INTEGER NOT NULL,
    n INTEGER NOT NULL,
    fatals INTEGER NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    PRIMARY KEY (gy, gx)
  );

  -- Per-stop progress and schedule alerts for a route in progress.
  -- kind: 'arrived' | 'departed' | 'behind'
  CREATE TABLE IF NOT EXISTS stop_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL,
    route_id INTEGER NOT NULL,
    driver_id INTEGER NOT NULL,
    stop_index INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('arrived','departed','behind')),
    auto INTEGER NOT NULL DEFAULT 0,
    delay_min INTEGER,
    note TEXT,
    ts TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_stop_events_route ON stop_events(route_id, ts);
`);

// GPS breadcrumbs accumulate forever otherwise — roughly 4M rows/month at 200
// drivers. Keep a rolling window; 0 disables pruning if you need full history
// for compliance.
const RETENTION_DAYS = Number(process.env.POSITION_RETENTION_DAYS ?? 30);

export function prunePositions() {
  if (!RETENTION_DAYS) return 0;
  const res = db
    .prepare(`DELETE FROM positions WHERE ts < datetime('now', ?)`)
    .run(`-${RETENTION_DAYS} days`);
  const removed = Number(res.changes) || 0;
  if (removed) console.log(`Pruned ${removed} position rows older than ${RETENTION_DAYS} days`);
  return removed;
}

if (RETENTION_DAYS) {
  prunePositions();
  // unref so this timer never holds the process open on shutdown.
  setInterval(prunePositions, 24 * 60 * 60 * 1000).unref();
}
