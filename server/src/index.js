import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import {
  registerOrg, createDriver, login, signToken, authRequired, roleRequired,
} from './auth.js';
import { planRoute, activeProviders } from './routing.js';
import { geocode } from './geocode.js';
import { crashesInBbox, crashStats, hazardForGeometry, STATE_FIPS } from './crashes.js';
import { sourcesForState, runImport } from './importers.js';
import { setupWs } from './ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.API_PORT || 4000;

const app = express();
app.use(express.json({ limit: '2mb' }));

// The native driver app (Capacitor) calls this API from its own origin, so
// cross-origin requests must be allowed. Browser/PWA traffic is same-origin
// and unaffected.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const server = http.createServer(app);
const wsHub = setupWs(server);

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: err.message || 'Server error' });
  });

// ---- Auth ----
app.post('/api/auth/register', wrap((req, res) => {
  const user = registerOrg(req.body);
  res.json({ token: signToken(user), user: publicUser(user) });
}));

app.post('/api/auth/login', wrap((req, res) => {
  const user = login(req.body);
  res.json({ token: signToken(user), user: publicUser(user) });
}));

app.get('/api/me', authRequired, (req, res) => res.json({ user: req.user }));

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, orgId: u.org_id };
}

// ---- Drivers (dispatcher) ----
app.get('/api/drivers', authRequired, roleRequired('dispatcher'), wrap((req, res) => {
  const drivers = db
    .prepare("SELECT id, name, email FROM users WHERE org_id = ? AND role = 'driver' ORDER BY name")
    .all(req.user.org);
  const live = new Map(wsHub.getLivePositions(req.user.org).map((p) => [p.driverId, p]));
  res.json({
    drivers: drivers.map((d) => ({ ...d, live: live.get(d.id) || null })),
  });
}));

app.post('/api/drivers', authRequired, roleRequired('dispatcher'), wrap((req, res) => {
  res.json({ driver: createDriver(req.user.org, req.body) });
}));

app.get('/api/drivers/:id/trail', authRequired, roleRequired('dispatcher'), wrap((req, res) => {
  const rows = db
    .prepare('SELECT lat, lng, ts FROM positions WHERE org_id = ? AND driver_id = ? ORDER BY ts DESC LIMIT 500')
    .all(req.user.org, Number(req.params.id));
  res.json({ trail: rows.reverse() });
}));

// ---- Geocoding & planning ----
app.get('/api/geocode', authRequired, wrap(async (req, res) => {
  res.json({ results: await geocode(req.query.q) });
}));

app.post('/api/route/plan', authRequired, wrap(async (req, res) => {
  const { points, departAt } = req.body;
  const route = await planRoute(points, departAt);
  const hazard = hazardForGeometry(route.geometry);
  res.json({ ...route, hazard });
}));

// ---- Routes ----
app.post('/api/routes', authRequired, roleRequired('dispatcher'), wrap((req, res) => {
  const {
    name, points, geometry, distanceM, durationS, durationTrafficS,
    hazard, provider, driverId, scheduledStart,
  } = req.body;
  if (!name || !points?.length) throw Object.assign(new Error('Route name and points are required'), { status: 400 });
  const status = driverId ? 'assigned' : 'draft';
  const result = db.prepare(`
    INSERT INTO routes (org_id, name, driver_id, status, points_json, geometry_json,
      distance_m, duration_s, duration_traffic_s, hazard_score, hazard_count, provider, scheduled_start)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.org, name, driverId || null, status, JSON.stringify(points),
    geometry ? JSON.stringify(geometry) : null, distanceM ?? null, durationS ?? null,
    durationTrafficS ?? null, hazard?.score ?? null, hazard?.count ?? null,
    provider ?? null, scheduledStart ?? null
  );
  const route = getRoute(req.user.org, result.lastInsertRowid);
  if (driverId) wsHub.notifyOrg(req.user.org, { type: 'route_assigned', routeId: route.id, driverId });
  res.json({ route });
}));

app.get('/api/routes', authRequired, roleRequired('dispatcher'), wrap((req, res) => {
  const rows = db.prepare(`
    SELECT r.*, u.name AS driver_name FROM routes r
    LEFT JOIN users u ON u.id = r.driver_id
    WHERE r.org_id = ? ORDER BY r.id DESC LIMIT 100
  `).all(req.user.org);
  res.json({ routes: rows.map(parseRouteRow) });
}));

app.post('/api/routes/:id/assign', authRequired, roleRequired('dispatcher'), wrap((req, res) => {
  const id = Number(req.params.id);
  const { driverId } = req.body;
  const route = getRoute(req.user.org, id);
  if (!route) throw Object.assign(new Error('Route not found'), { status: 404 });
  db.prepare("UPDATE routes SET driver_id = ?, status = 'assigned' WHERE id = ? AND org_id = ?")
    .run(driverId, id, req.user.org);
  wsHub.invalidateRoute(id);
  wsHub.notifyOrg(req.user.org, { type: 'route_assigned', routeId: id, driverId });
  res.json({ route: getRoute(req.user.org, id) });
}));

app.post('/api/routes/:id/status', authRequired, wrap((req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body;
  if (!['in_progress', 'completed'].includes(status)) {
    throw Object.assign(new Error('Status must be in_progress or completed'), { status: 400 });
  }
  const route = getRoute(req.user.org, id);
  if (!route) throw Object.assign(new Error('Route not found'), { status: 404 });
  if (req.user.role === 'driver' && route.driver_id !== req.user.uid) {
    throw Object.assign(new Error('Not your route'), { status: 403 });
  }
  const stampCol = status === 'in_progress' ? 'started_at' : 'completed_at';
  db.prepare(`UPDATE routes SET status = ?, ${stampCol} = datetime('now') WHERE id = ?`).run(status, id);
  wsHub.notifyOrg(req.user.org, { type: 'route_status', routeId: id, status, driverId: route.driver_id });
  res.json({ route: getRoute(req.user.org, id) });
}));

app.get('/api/my-route', authRequired, roleRequired('driver'), wrap((req, res) => {
  const row = db.prepare(`
    SELECT * FROM routes WHERE org_id = ? AND driver_id = ?
    AND status IN ('assigned','in_progress') ORDER BY id DESC LIMIT 1
  `).get(req.user.org, req.user.uid);
  res.json({ route: row ? parseRouteRow(row) : null });
}));

function getRoute(orgId, id) {
  const row = db.prepare('SELECT * FROM routes WHERE id = ? AND org_id = ?').get(id, orgId);
  return row ? parseRouteRow(row) : null;
}

function parseRouteRow(row) {
  return {
    ...row,
    points: JSON.parse(row.points_json || '[]'),
    geometry: row.geometry_json ? JSON.parse(row.geometry_json) : null,
    points_json: undefined,
    geometry_json: undefined,
  };
}

// ---- Crash data ----
app.get('/api/crashes', authRequired, wrap((req, res) => {
  const { minLat, minLng, maxLat, maxLng } = req.query;
  res.json({ crashes: crashesInBbox({ minLat, minLng, maxLat, maxLng }) });
}));

app.get('/api/crashes/stats', authRequired, wrap((req, res) => {
  res.json({ stats: crashStats(), states: Object.keys(STATE_FIPS) });
}));

app.get('/api/crashes/sources', authRequired, wrap((req, res) => {
  res.json({ sources: sourcesForState(req.query.state) });
}));

app.post('/api/crashes/ingest', authRequired, roleRequired('dispatcher'), wrap(async (req, res) => {
  const { sourceId, state, fromYear, toYear } = req.body;
  res.json(await runImport(sourceId, { state, fromYear, toYear }));
}));

// ---- Meta ----
app.get('/api/status', (req, res) => {
  res.json({ ok: true, providers: activeProviders() });
});

// ---- Static (production build of the web app) ----
const distDir = path.join(__dirname, '..', '..', 'web', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api|ws).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

server.listen(PORT, () => {
  console.log(`Dispatch server running on http://localhost:${PORT}`);
  console.log('Routing provider:', activeProviders().routing);
});
