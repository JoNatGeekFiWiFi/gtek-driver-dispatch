// Live tracking hub. Drivers stream GPS positions in; dispatchers in the same
// org receive them in real time along with on-route/off-route status.

import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from './auth.js';
import { db } from './db.js';
import { minDistToPolyline } from './crashes.js';

const OFF_ROUTE_M = 150;
const DB_WRITE_INTERVAL_MS = 15000;
const HEARTBEAT_MS = 30000;

export function setupWs(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Map(); // ws -> { uid, org, role, name }
  const lastPos = new Map(); // driverId -> position payload
  const lastDbWrite = new Map(); // driverId -> timestamp
  const routeGeomCache = new Map(); // routeId -> projected polyline

  const activeRouteStmt = db.prepare(
    "SELECT id, geometry_json FROM routes WHERE driver_id = ? AND status IN ('assigned','in_progress') ORDER BY id DESC LIMIT 1"
  );
  const insertPos = db.prepare(
    'INSERT INTO positions (org_id, driver_id, route_id, lat, lng, speed, heading, accuracy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );

  function projectedRoute(routeId, geometryJson) {
    if (routeGeomCache.has(routeId)) return routeGeomCache.get(routeId);
    let entry = null;
    try {
      const geom = JSON.parse(geometryJson);
      const coords = geom?.coordinates || [];
      if (coords.length >= 2) {
        const refLat = coords[0][1];
        const mPerDegLng = 111320 * Math.cos((refLat * Math.PI) / 180);
        entry = {
          refLat,
          mPerDegLng,
          line: coords.map(([lng, lat]) => [lng * mPerDegLng, lat * 110540]),
        };
      }
    } catch { /* bad geometry -> no off-route detection */ }
    routeGeomCache.set(routeId, entry);
    return entry;
  }

  function sendToOrg(org, msg, roleFilter = null) {
    const raw = JSON.stringify(msg);
    for (const [ws, user] of clients) {
      if (user.org !== org) continue;
      if (roleFilter && user.role !== roleFilter) continue;
      if (ws.readyState === ws.OPEN) ws.send(raw);
    }
  }

  // A phone that dies or loses signal leaves a half-open socket: 'close' never
  // fires, so the driver would look permanently "live" to dispatch. Ping every
  // client and drop the ones that stop answering.
  const heartbeat = setInterval(() => {
    for (const [ws] of clients) {
      if (ws.isAlive === false) {
        ws.terminate(); // fires 'close' → cleanup + driver_offline
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* socket already gone */ }
    }
  }, HEARTBEAT_MS);
  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws, req) => {
    let user;
    try {
      const url = new URL(req.url, 'http://localhost');
      user = jwt.verify(url.searchParams.get('token') || '', JWT_SECRET);
    } catch {
      ws.close(4001, 'Authentication failed');
      return;
    }
    clients.set(ws, user);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // New dispatcher connections get a snapshot of current driver positions.
    if (user.role === 'dispatcher') {
      for (const pos of lastPos.values()) {
        if (pos.org === user.org) ws.send(JSON.stringify(pos));
      }
    }

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.type === 'position' && user.role === 'driver') {
        const { lat, lng, speed, heading, accuracy } = msg;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

        const route = activeRouteStmt.get(user.uid);
        let offRoute = null;
        if (route?.geometry_json) {
          const proj = projectedRoute(route.id, route.geometry_json);
          if (proj) {
            const p = [lng * proj.mPerDegLng, lat * 110540];
            offRoute = minDistToPolyline(p, proj.line) > OFF_ROUTE_M;
          }
        }

        const payload = {
          type: 'driver_position',
          org: user.org,
          driverId: user.uid,
          name: user.name,
          lat, lng,
          speed: speed ?? null,
          heading: heading ?? null,
          accuracy: accuracy ?? null,
          routeId: route?.id ?? null,
          offRoute,
          ts: Date.now(),
        };
        lastPos.set(user.uid, payload);

        const last = lastDbWrite.get(user.uid) || 0;
        if (Date.now() - last > DB_WRITE_INTERVAL_MS) {
          insertPos.run(user.org, user.uid, route?.id ?? null, lat, lng, speed ?? null, heading ?? null, accuracy ?? null);
          lastDbWrite.set(user.uid, Date.now());
        }

        sendToOrg(user.org, payload, 'dispatcher');
        // Echo status back so the driver app can show its own off-route warning.
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'position_ack', offRoute, routeId: route?.id ?? null }));
        }
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      if (user.role === 'driver') {
        // Drop the last known position too — otherwise /api/drivers keeps
        // reporting a stale fix as this driver's "live" location.
        const stillConnected = [...clients.values()].some((u) => u.uid === user.uid);
        if (!stillConnected) {
          lastPos.delete(user.uid);
          lastDbWrite.delete(user.uid);
        }
        sendToOrg(user.org, { type: 'driver_offline', driverId: user.uid, name: user.name, ts: Date.now() }, 'dispatcher');
      }
    });
  });

  return {
    // Called by the REST API when routes change so caches stay fresh and
    // connected apps update immediately.
    notifyOrg(org, msg) {
      sendToOrg(org, msg);
    },
    invalidateRoute(routeId) {
      routeGeomCache.delete(routeId);
    },
    getLivePositions(org) {
      return [...lastPos.values()].filter((p) => p.org === org);
    },
  };
}
