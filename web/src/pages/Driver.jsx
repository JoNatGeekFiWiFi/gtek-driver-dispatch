import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, openWs, clearSession, getUser, fmtMiles, fmtDuration, fmtClock } from '../api.js';
import { createMap, setLineLayer, makeMarker, setStopMarkers } from '../map.js';
import { watchPosition, isNativeApp } from '../geo.js';

const ARRIVE_RADIUS_M = 120; // auto-mark arrived within this distance of a stop
const BEHIND_GRACE_MIN = 5;  // auto-flag behind once this many minutes past plan

function haversineM(aLat, aLng, bLat, bLng) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad, dLng = (bLng - aLng) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(s));
}

export default function Driver() {
  const navigate = useNavigate();
  const user = getUser();

  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const meMarker = useRef(null);
  const wsRef = useRef(null);
  const watcher = useRef(null);

  const [route, setRoute] = useState(null);
  const [tracking, setTracking] = useState(false);
  const [offRoute, setOffRoute] = useState(false);
  const [gpsError, setGpsError] = useState('');
  const [lastFix, setLastFix] = useState(null);
  const [arrived, setArrived] = useState({});   // { stopIndex: ISO time }
  const [departed, setDeparted] = useState({});
  const [follow, setFollow] = useState(true);
  const [behindPicker, setBehindPicker] = useState(false);
  const [behindMin, setBehindMin] = useState(0); // schedule-derived delay, live

  // Refs the GPS callback / interval read (they close over first render).
  const routeRef = useRef(null);
  const arrivedRef = useRef({});
  const behindFlaggedRef = useRef({});
  const followRef = useRef(true);
  useEffect(() => { routeRef.current = route; }, [route]);
  useEffect(() => { arrivedRef.current = arrived; }, [arrived]);
  useEffect(() => { followRef.current = follow; }, [follow]);

  const stops = route?.points || [];
  const lastIdx = stops.length - 1;
  // Next stop the driver is heading to: first stop (after start) not yet arrived.
  const targetIdx = stops.findIndex((_, i) => i >= 1 && !arrived[i]);

  const loadRoute = useCallback(async () => {
    try {
      const { route } = await api('/api/my-route');
      setRoute(route);
      if (route?.id) {
        const { events } = await api(`/api/routes/${route.id}/progress`);
        const arr = {}, dep = {};
        for (const e of events) {
          if (e.kind === 'arrived') arr[e.stopIndex] = e.ts;
          if (e.kind === 'departed') dep[e.stopIndex] = e.ts;
        }
        setArrived(arr);
        setDeparted(dep);
        behindFlaggedRef.current = {};
      } else {
        setArrived({}); setDeparted({});
      }
    } catch { /* retried on next ws event */ }
  }, []);

  useEffect(() => {
    const map = createMap(mapEl.current, { zoom: 11 });
    mapRef.current = map;
    // Any manual drag disables auto-follow so the driver can look around.
    map.on('dragstart', () => setFollow(false));
    return () => map.remove();
  }, []);

  useEffect(() => { loadRoute(); }, [loadRoute]);

  async function postStopEvent(stopIndex, kind, extra = {}) {
    if (!routeRef.current?.id) return;
    try {
      await api(`/api/routes/${routeRef.current.id}/stop-event`, {
        method: 'POST', body: { stopIndex, kind, ...extra },
      });
    } catch { /* best-effort; server dedupes */ }
  }

  // draw assigned route + numbered stop markers
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    setLineLayer(map, 'my-route', route?.geometry || null);
    setStopMarkers(map, stops, { arrived, targetIdx });
    if (route?.geometry && !tracking) {
      const coords = route.geometry.coordinates;
      let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
      for (const [lng, lat] of coords) {
        minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      }
      map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 50, maxZoom: 14 });
    }
  }, [route, arrived, targetIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  // websocket: route assignments and off-route echoes
  useEffect(() => {
    const ws = openWs((m) => {
      if (m.type === 'route_assigned' || m.type === 'route_status') loadRoute();
      if (m.type === 'position_ack') setOffRoute(Boolean(m.offRoute));
    });
    wsRef.current = ws;
    return () => ws?.close();
  }, [loadRoute]);

  // Handle each GPS fix: stream position, follow map, auto-detect arrival.
  const onFix = useCallback(({ lat, lng, speed, heading, accuracy }) => {
    setLastFix({ lat, lng, at: Date.now() });
    wsRef.current?.send({ type: 'position', lat, lng, speed, heading, accuracy });

    const map = mapRef.current;
    if (map) {
      if (!meMarker.current) {
        meMarker.current = makeMarker(map, [lng, lat], { html: '<div class="driver-marker">You</div>' });
      } else {
        meMarker.current.setLngLat([lng, lat]);
      }
      if (followRef.current) map.easeTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 14), duration: 800 });
    }

    // Auto-arrival: within radius of the next unvisited stop.
    const r = routeRef.current;
    if (r?.points) {
      const tIdx = r.points.findIndex((_, i) => i >= 1 && !arrivedRef.current[i]);
      if (tIdx >= 1) {
        const s = r.points[tIdx];
        if (haversineM(lat, lng, s.lat, s.lng) <= ARRIVE_RADIUS_M) {
          markArrived(tIdx, true);
        }
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function markArrived(i, auto) {
    if (arrivedRef.current[i]) return;
    const now = Date.now();
    arrivedRef.current = { ...arrivedRef.current, [i]: now };
    setArrived((a) => ({ ...a, [i]: now }));
    postStopEvent(i, 'arrived', { auto });
  }

  function markDeparted(i) {
    setDeparted((d) => ({ ...d, [i]: Date.now() }));
    postStopEvent(i, 'departed', { auto: false });
  }

  // Behind-schedule watchdog: every 20s compare now to the target stop's
  // planned arrival; auto-alert dispatch once per stop past the grace window.
  useEffect(() => {
    const iv = setInterval(() => {
      const r = routeRef.current;
      if (!r?.points) return;
      const tIdx = r.points.findIndex((_, i) => i >= 1 && !arrivedRef.current[i]);
      if (tIdx < 1) { setBehindMin(0); return; }
      const planned = r.points[tIdx].plannedArrival;
      if (!planned) return;
      const late = (Date.now() - new Date(planned).getTime()) / 60000;
      setBehindMin(Math.max(0, Math.round(late)));
      if (late > BEHIND_GRACE_MIN && !behindFlaggedRef.current[tIdx]) {
        behindFlaggedRef.current[tIdx] = true;
        postStopEvent(tIdx, 'behind', { auto: true, delayMin: Math.round(late) });
      }
    }, 20000);
    return () => clearInterval(iv);
  }, []);

  async function startTracking() {
    setGpsError('');
    try {
      watcher.current = await watchPosition(onFix, (message) => setGpsError(message));
      setTracking(true);
      setFollow(true);
    } catch (err) {
      setGpsError(err.message);
    }
  }

  function stopTracking() {
    watcher.current?.stop();
    watcher.current = null;
    setTracking(false);
    setOffRoute(false);
  }

  useEffect(() => () => stopTracking(), []);

  async function setStatus(status) {
    if (!route) return;
    try {
      const { route: updated } = await api(`/api/routes/${route.id}/status`, { method: 'POST', body: { status } });
      if (status === 'completed') {
        setRoute(null);
        stopTracking();
        loadRoute();
      } else {
        setRoute(updated);
        if (!tracking) startTracking();
      }
    } catch (err) {
      setGpsError(err.message);
    }
  }

  function reportBehind(min) {
    postStopEvent(targetIdx >= 1 ? targetIdx : lastIdx, 'behind', { auto: false, delayMin: min || behindMin || null });
    setBehindPicker(false);
  }

  function logout() {
    stopTracking();
    clearSession();
    navigate('/login');
  }

  const behind = behindMin > BEHIND_GRACE_MIN;

  return (
    <div className="driver-app">
      <header className="driver-head">
        <img src="/icon.svg" alt="" width="26" height="26" />
        <h1>{user?.name}</h1>
        <button className="btn small" onClick={logout}>Sign out</button>
      </header>

      <div className="driver-map">
        <div ref={mapEl} className="map" />
        {tracking && !follow && (
          <button className="recenter-btn" onClick={() => setFollow(true)}>◎ Recenter</button>
        )}
      </div>

      <div className="driver-panel">
        {tracking ? (
          behind ? (
            <div className="banner warn">⚠ Running ~{behindMin} min behind schedule — dispatch has been alerted</div>
          ) : offRoute ? (
            <div className="banner warn">⚠ You appear to be off route — dispatch can see this</div>
          ) : (
            <div className="banner ok">
              ● Sharing live location with dispatch
              {isNativeApp() && ' (keeps tracking with screen off)'}
              {lastFix && ` · last fix ${new Date(lastFix.at).toLocaleTimeString()}`}
            </div>
          )
        ) : (
          <div className="banner idle">Location sharing is off</div>
        )}
        {gpsError && <div className="error">{gpsError}</div>}

        {route ? (
          <>
            <div className="route-name">{route.name}</div>
            <div className="muted" style={{ margin: '4px 0 8px', fontSize: 13 }}>
              {route.distance_m ? `${fmtMiles(route.distance_m)} · ` : ''}
              {route.duration_traffic_s ? `about ${fmtDuration(route.duration_traffic_s)}` : ''}
              {route.scheduled_start ? ` · start ${fmtClock(route.scheduled_start)}` : ''}
            </div>

            <ol className="stop-track">
              {stops.map((s, i) => {
                const isStart = i === 0, isEnd = i === lastIdx;
                const done = Boolean(arrived[i]) || isStart;
                const current = i === targetIdx;
                const late = arrived[i] && s.plannedArrival
                  && (arrived[i] - new Date(s.plannedArrival).getTime()) / 60000 > BEHIND_GRACE_MIN;
                return (
                  <li key={i} className={`stop-item${current ? ' current' : ''}${done ? ' done' : ''}`}>
                    <span className="stop-num">{isStart ? '◆' : isEnd ? '■' : i}</span>
                    <span className="stop-body">
                      <span className="stop-name">{s.name?.split(',')[0] || (isStart ? 'Start' : isEnd ? 'End' : `Stop ${i}`)}</span>
                      <span className="stop-meta">
                        {s.plannedArrival && !isStart ? `plan ${fmtClock(s.plannedArrival)}` : ''}
                        {s.timeLimitMin ? ` · ${s.timeLimitMin}m` : ''}
                        {s.deadline ? ` · by ${s.deadline}` : ''}
                        {arrived[i] && !isStart ? ` · ${late ? '⚠ ' : '✓ '}arrived ${fmtClock(new Date(arrived[i]).toISOString())}` : ''}
                      </span>
                    </span>
                    {current && tracking && !isEnd && (
                      arrived[i]
                        ? <button className="btn small" onClick={() => markDeparted(i)}>Depart</button>
                        : <button className="btn small" onClick={() => markArrived(i, false)}>Arrived</button>
                    )}
                  </li>
                );
              })}
            </ol>

            {behindPicker ? (
              <div className="behind-picker">
                <span className="muted" style={{ fontSize: 12 }}>Tell dispatch you're behind by:</span>
                <div className="chip-row">
                  {[10, 20, 30].map((m) => (
                    <button key={m} className="btn small" onClick={() => reportBehind(m)}>~{m} min</button>
                  ))}
                  <button className="btn small" onClick={() => reportBehind(0)}>Just notify</button>
                  <button className="btn link small" onClick={() => setBehindPicker(false)}>cancel</button>
                </div>
              </div>
            ) : null}

            <div className="actions">
              {route.status === 'assigned' && (
                <button className="btn green" onClick={() => setStatus('in_progress')}>Start route</button>
              )}
              {route.status === 'in_progress' && (
                <>
                  <button className={`btn ${behind ? 'danger' : ''}`} onClick={() => setBehindPicker((v) => !v)}>
                    Running behind
                  </button>
                  <button className="btn primary" onClick={() => setStatus('completed')}>Complete</button>
                </>
              )}
              <button className="btn" onClick={tracking ? stopTracking : startTracking}>
                {tracking ? 'Stop' : 'Share location'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="route-name muted">No route assigned</div>
            <p className="muted" style={{ fontSize: 13 }}>
              When dispatch assigns you a route it will appear here automatically.
            </p>
            <div className="actions">
              <button className="btn" onClick={tracking ? stopTracking : startTracking}>
                {tracking ? 'Stop sharing' : 'Share location'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
