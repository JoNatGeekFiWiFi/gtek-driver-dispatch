import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import {
  registerOrg, createDriver, login, signToken, authRequired, roleRequired,
} from './auth.js';
import { planRoute, activeProviders, walkRoute } from './routing.js';
import { geocode } from './geocode.js';
import { crashesInBbox, crashStats, hazardForGeometry, STATE_FIPS } from './crashes.js';
import { sourcesForState, runImport } from './importers.js';
import { setupWs } from './ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.API_PORT || 4000;

const app = express();
app.use(express.json({ limit: '2mb' }));

// Behind a load balancer this makes req.ip the real client address (needed by
// the auth rate limiter). Set TRUST_PROXY=1 when deploying behind one.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

// The native driver app calls this API cross-origin, so those origins must be
// allowed — but reflecting *any* origin, as this used to, is broader than
// needed. Capacitor's own origins stay allowed; add your web app's origin(s)
// with CORS_ORIGINS=https://dispatch.example.com,https://admin.example.com
const NATIVE_ORIGINS = ['capacitor://localhost', 'http://localhost', 'https://localhost'];
const CONFIGURED_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const DEV_ORIGIN = /^http:\/\/localhost:\d+$/;

function originAllowed(origin) {
  if (NATIVE_ORIGINS.includes(origin) || CONFIGURED_ORIGINS.includes(origin)) return true;
  // Vite's dev server and friends — only outside production.
  return process.env.NODE_ENV !== 'production' && DEV_ORIGIN.test(origin);
}

app.use((req, res, next) => {
  const { origin } = req.headers;
  // No Origin header = same-origin or a non-browser client (curl, the native
  // HTTP stack); nothing to authorise.
  if (origin && originAllowed(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(origin && !originAllowed(origin) ? 403 : 204);
  next();
});

// ---- Sign-in throttling ----
// Credentials are the one endpoint worth guessing at, so cap failures per
// client. In-memory is fine for a single node; move to Redis if you scale out.
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_FAILURES = 10;
const authFailures = new Map(); // ip -> { count, first }

function authLimiter(req, res, next) {
  const rec = authFailures.get(req.ip);
  if (!rec) return next();
  if (Date.now() - rec.first >= AUTH_WINDOW_MS) {
    authFailures.delete(req.ip);
    return next();
  }
  if (rec.count >= AUTH_MAX_FAILURES) {
    const mins = Math.ceil((AUTH_WINDOW_MS - (Date.now() - rec.first)) / 60000);
    return res.status(429).json({ error: `Too many failed sign-in attempts. Try again in ${mins} minute(s).` });
  }
  next();
}

function noteAuthFailure(ip) {
  const rec = authFailures.get(ip);
  if (!rec || Date.now() - rec.first >= AUTH_WINDOW_MS) authFailures.set(ip, { count: 1, first: Date.now() });
  else rec.count++;
}

// Keep the map from growing without bound on a long-lived process.
setInterval(() => {
  const cutoff = Date.now() - AUTH_WINDOW_MS;
  for (const [ip, rec] of authFailures) if (rec.first < cutoff) authFailures.delete(ip);
}, AUTH_WINDOW_MS).unref();

const server = http.createServer(app);
const wsHub = setupWs(server);

// `async` matters: a plain `Promise.resolve(fn())` lets a SYNCHRONOUS throw
// escape before .catch is attached, so Express renders its default HTML error
// page — leaking server file paths and breaking clients that expect JSON.
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    sendError(res, err);
  }
};

function sendError(res, err) {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  if (res.headersSent) return;
  const body = { error: status === 500 ? 'Server error' : err.message || 'Server error' };
  if (err.code) body.code = err.code;          // machine-readable, e.g. DRIVER_BUSY
  if (err.details) body.details = err.details; // structured context for the UI
  res.status(status).json(body);
}

// ---- Auth ----
app.post('/api/auth/register', authLimiter, wrap((req, res) => {
  const user = registerOrg(req.body);
  res.json({ token: signToken(user), user: publicUser(user) });
}));

app.post('/api/auth/login', authLimiter, wrap((req, res) => {
  let user;
  try {
    user = login(req.body);
  } catch (err) {
    noteAuthFailure(req.ip);
    throw err;
  }
  authFailures.delete(req.ip); // a success clears the streak
  res.json({ token: signToken(user), user: publicUser(user) });
}));

app.get('/api/me', authRequired, (req, res) => res.json({ user: req.user }));

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, orgId: u.org_id };
}

// Routes may only be assigned to a driver in the caller's own organization.
// Without this a dispatcher could point a route at another tenant's user id.
function assertDriverInOrg(orgId, driverId) {
  const d = db
    .prepare("SELECT id FROM users WHERE id = ? AND org_id = ? AND role = 'driver'")
    .get(Number(driverId), orgId);
  if (!d) throw Object.assign(new Error('That driver is not in your organization'), { status: 400 });
}

const openRoutesStmt = db.prepare(
  `SELECT id, name, status, queue_pos FROM routes
   WHERE org_id = ? AND driver_id = ? AND status IN ('assigned','in_progress')
   ORDER BY queue_pos, id`
);

// Assigning to a driver who already has work is ambiguous: replace what they
// have, or line up behind it? Rather than guess, refuse with 409 + the current
// queue and let the dispatcher choose. `mode` then says which they picked.
function planAssignment(orgId, driverId, mode, excludeRouteId = null) {
  const open = openRoutesStmt.all(orgId, Number(driverId))
    .filter((r) => r.id !== excludeRouteId);
  if (!open.length) return { queuePos: 0, cancel: [] };

  if (!mode) {
    const driver = db.prepare('SELECT name FROM users WHERE id = ?').get(Number(driverId));
    throw Object.assign(new Error(`${driver?.name || 'That driver'} already has a route in progress`), {
      status: 409,
      code: 'DRIVER_BUSY',
      details: { driverId: Number(driverId), driverName: driver?.name ?? null, open },
    });
  }
  if (mode === 'replace') return { queuePos: 0, cancel: open.map((r) => r.id) };
  if (mode === 'queue') return { queuePos: Math.max(...open.map((r) => r.queue_pos)) + 1, cancel: [] };
  throw Object.assign(new Error("mode must be 'replace' or 'queue'"), { status: 400 });
}

// Cancel routes the dispatcher chose to replace, and tell the driver's app.
function cancelRoutes(orgId, ids, driverId) {
  if (!ids?.length) return;
  const stmt = db.prepare("UPDATE routes SET status = 'cancelled' WHERE id = ? AND org_id = ?");
  for (const id of ids) {
    stmt.run(id, orgId);
    wsHub.invalidateRoute(id);
    wsHub.notifyOrg(orgId, { type: 'route_status', routeId: id, status: 'cancelled', driverId });
  }
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
    .prepare(`SELECT lat, lng, CAST(strftime('%s', ts) AS INTEGER) * 1000 AS ts
              FROM positions WHERE org_id = ? AND driver_id = ? ORDER BY ts DESC LIMIT 500`)
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

// Foot route for a stop's "routed" walk mode (needs ORS_TOKEN/MAPBOX_TOKEN).
app.post('/api/walk/route', authRequired, roleRequired('dispatcher'), wrap(async (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) throw Object.assign(new Error('from and to points are required'), { status: 400 });
  res.json(await walkRoute(from, to));
}));

// ---- Routes ----
app.post('/api/routes', authRequired, roleRequired('dispatcher'), wrap((req, res) => {
  const {
    name, points, geometry, distanceM, durationS, durationTrafficS,
    hazard, provider, driverId, scheduledStart, schedule, mode,
  } = req.body;
  if (!name || !points?.length) throw Object.assign(new Error('Route name and points are required'), { status: 400 });
  let placement = { queuePos: 0, cancel: [] };
  if (driverId) {
    assertDriverInOrg(req.user.org, driverId);
    // Throws 409 DRIVER_BUSY when the driver already has work and the
    // dispatcher hasn't said whether to replace it or queue behind it.
    placement = planAssignment(req.user.org, driverId, mode);
  }
  // Fold the planned schedule into each stop so points_json is self-contained
  // (driver and dispatcher read planned times straight off the stops).
  const enrichedPoints = points.map((p, i) => ({
    ...p,
    timeLimitMin: p.timeLimitMin ?? null,
    deadline: p.deadline ?? null,
    plannedArrival: schedule?.[i]?.plannedArrival ?? null,
    plannedDeparture: schedule?.[i]?.plannedDeparture ?? null,
  }));
  const status = driverId ? 'assigned' : 'draft';
  const result = db.prepare(`
    INSERT INTO routes (org_id, name, driver_id, status, queue_pos, points_json, geometry_json,
      distance_m, duration_s, duration_traffic_s, hazard_score, hazard_count, provider, scheduled_start)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.org, name, driverId || null, status, placement.queuePos, JSON.stringify(enrichedPoints),
    geometry ? JSON.stringify(geometry) : null, distanceM ?? null, durationS ?? null,
    durationTrafficS ?? null, hazard?.score ?? null, hazard?.count ?? null,
    provider ?? null, scheduledStart ?? null
  );
  const route = getRoute(req.user.org, result.lastInsertRowid);
  if (driverId) {
    cancelRoutes(req.user.org, placement.cancel, driverId);
    wsHub.invalidateDriver(driverId);
    wsHub.notifyOrg(req.user.org, { type: 'route_assigned', routeId: route.id, driverId });
  }
  res.json({ route, queuedBehind: placement.queuePos, cancelled: placement.cancel });
}));

app.get('/api/routes', authRequired, roleRequired('dispatcher'), wrap((req, res) => {
  const rows = db.prepare(`
    SELECT r.*, u.name AS driver_name FROM routes r
    LEFT JOIN users u ON u.id = r.driver_id AND u.org_id = r.org_id
    WHERE r.org_id = ? ORDER BY r.id DESC LIMIT 100
  `).all(req.user.org);
  res.json({ routes: rows.map(parseRouteRow) });
}));

app.post('/api/routes/:id/assign', authRequired, roleRequired('dispatcher'), wrap((req, res) => {
  const id = Number(req.params.id);
  const { driverId, mode } = req.body;
  const route = getRoute(req.user.org, id);
  if (!route) throw Object.assign(new Error('Route not found'), { status: 404 });
  assertDriverInOrg(req.user.org, driverId);
  // Exclude this route from the busy check — reassigning a driver's own route
  // to themselves shouldn't count as a conflict with itself.
  const placement = planAssignment(req.user.org, driverId, mode, id);

  db.prepare("UPDATE routes SET driver_id = ?, status = 'assigned', queue_pos = ? WHERE id = ? AND org_id = ?")
    .run(driverId, placement.queuePos, id, req.user.org);
  cancelRoutes(req.user.org, placement.cancel, driverId);
  wsHub.invalidateRoute(id);
  wsHub.invalidateDriver(driverId);
  wsHub.invalidateDriver(route.driver_id); // the driver it was taken away from
  wsHub.notifyOrg(req.user.org, { type: 'route_assigned', routeId: id, driverId });
  res.json({ route: getRoute(req.user.org, id), queuedBehind: placement.queuePos, cancelled: placement.cancel });
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
  wsHub.invalidateDriver(route.driver_id); // completed routes drop out of "active"
  wsHub.notifyOrg(req.user.org, { type: 'route_status', routeId: id, status, driverId: route.driver_id });
  res.json({ route: getRoute(req.user.org, id) });
}));

// Driver records progress at a stop, or flags running behind. Broadcast to dispatch.
app.post('/api/routes/:id/stop-event', authRequired, roleRequired('driver'), wrap((req, res) => {
  const id = Number(req.params.id);
  const { stopIndex, kind, auto, delayMin, note } = req.body;
  if (!['arrived', 'departed', 'behind'].includes(kind)) {
    throw Object.assign(new Error('kind must be arrived, departed, or behind'), { status: 400 });
  }
  const route = getRoute(req.user.org, id);
  if (!route) throw Object.assign(new Error('Route not found'), { status: 404 });
  if (route.driver_id !== req.user.uid) throw Object.assign(new Error('Not your route'), { status: 403 });

  const idx = Number(stopIndex);
  // Ignore duplicate arrived/departed for the same stop (auto + manual overlap).
  if (kind !== 'behind') {
    const dup = db.prepare(
      'SELECT id FROM stop_events WHERE route_id = ? AND stop_index = ? AND kind = ? LIMIT 1'
    ).get(id, idx, kind);
    if (dup) return res.json({ ok: true, duplicate: true });
  }
  db.prepare(
    'INSERT INTO stop_events (org_id, route_id, driver_id, stop_index, kind, auto, delay_min, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(req.user.org, id, req.user.uid, idx, kind, auto ? 1 : 0, delayMin ?? null, note ?? null);

  const stop = route.points?.[idx];
  wsHub.notifyOrg(req.user.org, {
    type: 'stop_event',
    routeId: id,
    driverId: req.user.uid,
    driverName: req.user.name,
    routeName: route.name,
    stopIndex: idx,
    stopName: stop?.name ?? null,
    kind,
    auto: Boolean(auto),
    delayMin: delayMin ?? null,
    note: note ?? null,
    ts: Date.now(),
  });
  res.json({ ok: true });
}));

// Live-only walk phase for a stop (walking, returning, done) — broadcast to
// dispatch without persisting, so the board shows a driver mid-walk.
app.post('/api/routes/:id/walk-status', authRequired, roleRequired('driver'), wrap((req, res) => {
  const id = Number(req.params.id);
  const { stopIndex, phase } = req.body;
  if (!['walking', 'returning', 'done'].includes(phase)) {
    throw Object.assign(new Error('phase must be walking, returning, or done'), { status: 400 });
  }
  const route = getRoute(req.user.org, id);
  if (!route || route.driver_id !== req.user.uid) {
    throw Object.assign(new Error('Not your route'), { status: 403 });
  }
  wsHub.notifyOrg(req.user.org, {
    type: 'walk_status',
    routeId: id,
    driverId: req.user.uid,
    driverName: req.user.name,
    stopIndex: Number(stopIndex),
    stopName: route.points?.[Number(stopIndex)]?.name ?? null,
    phase,
    ts: Date.now(),
  });
  res.json({ ok: true });
}));

app.get('/api/routes/:id/progress', authRequired, wrap((req, res) => {
  const id = Number(req.params.id);
  const route = getRoute(req.user.org, id);
  if (!route) throw Object.assign(new Error('Route not found'), { status: 404 });
  if (req.user.role === 'driver' && route.driver_id !== req.user.uid) {
    throw Object.assign(new Error('Not your route'), { status: 403 });
  }
  // ts is stored as UTC text by datetime('now'); return epoch ms so clients
  // never have to guess the timezone (a bare "YYYY-MM-DD HH:MM:SS" parses as
  // LOCAL time in JS, which silently shifted displayed times).
  const events = db.prepare(`
    SELECT stop_index AS stopIndex, kind, auto, delay_min AS delayMin, note,
           CAST(strftime('%s', ts) AS INTEGER) * 1000 AS ts
    FROM stop_events WHERE route_id = ? ORDER BY id
  `).all(id);
  res.json({ events, stops: route.points });
}));

app.get('/api/my-route', authRequired, roleRequired('driver'), wrap((req, res) => {
  // First in the queue, not the newest — a route assigned later lines up
  // behind rather than silently taking over.
  const open = db.prepare(`
    SELECT * FROM routes WHERE org_id = ? AND driver_id = ?
    AND status IN ('assigned','in_progress') ORDER BY queue_pos, id
  `).all(req.user.org, req.user.uid);
  res.json({
    route: open.length ? parseRouteRow(open[0]) : null,
    upNext: open.slice(1).map((r) => ({ id: r.id, name: r.name, scheduledStart: r.scheduled_start })),
  });
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
  // Overlay is a visual density layer — sampling keeps wide zooms fast.
  res.json({ crashes: crashesInBbox({ minLat, minLng, maxLat, maxLng, sample: true }) });
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

// Safety net: anything that still reaches Express's error path answers in JSON
// rather than an HTML stack trace.
app.use((err, req, res, _next) => sendError(res, err));

server.listen(PORT, () => {
  console.log(`Dispatch server running on http://localhost:${PORT}`);
  console.log('Routing provider:', activeProviders().routing);
});
