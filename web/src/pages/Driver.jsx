import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, openWs, clearSession, getUser, fmtMiles, fmtDuration, fmtClock, haversineM, walkOneWayM, walkRoundTripMin } from '../api.js';
import { createMap, setLineLayer, makeMarker, setStopMarkers, setWalkPaths } from '../map.js';
import { watchPosition, isNativeApp } from '../geo.js';

const ARRIVE_RADIUS_M = 120; // auto-mark arrived within this distance of a stop
const DEPART_RADIUS_M = 180; // pulled away this far after arriving => departed
                             // (deliberately wider than ARRIVE so GPS jitter
                             //  can't flap a parked driver in and out)
const WALK_ARRIVE_M = 25;    // tighter radius for reaching a walk point on foot
const BEHIND_GRACE_MIN = 5;  // auto-flag behind once this many minutes past plan

// A stop is finished — and the driver advances to the next one — on DEPARTURE,
// not arrival. Completing on arrival would make the stop's dwell time limit
// unmeasurable (and hide the Depart button the moment it became relevant).
// Walking stops finish when the out-and-back walk is done.
function stopComplete(i, pts, arrived, walkDone, departed) {
  if (i === 0) return true;
  if (pts[i]?.walk?.geometry) return Boolean(walkDone[i]);
  return Boolean(departed?.[i]);
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
  const [arrived, setArrived] = useState({});   // { stopIndex: ms time parked }
  const [departed, setDeparted] = useState({});
  const [walkDone, setWalkDone] = useState({}); // { stopIndex: true } walk finished
  const [walkPhase, setWalkPhase] = useState(null); // { stopIndex, phase:'out'|'back' }
  const [upNext, setUpNext] = useState([]); // routes queued behind this one
  const [follow, setFollow] = useState(true);
  const [behindPicker, setBehindPicker] = useState(false);
  const [behindMin, setBehindMin] = useState(0); // schedule-derived delay, live

  // Refs the GPS callback / interval read (they close over first render).
  const routeRef = useRef(null);
  const arrivedRef = useRef({});
  const departedRef = useRef({});
  const walkDoneRef = useRef({});
  const walkPhaseRef = useRef(null);
  const behindFlaggedRef = useRef({});
  const followRef = useRef(true);
  useEffect(() => { routeRef.current = route; }, [route]);
  useEffect(() => { arrivedRef.current = arrived; }, [arrived]);
  useEffect(() => { departedRef.current = departed; }, [departed]);
  useEffect(() => { walkDoneRef.current = walkDone; }, [walkDone]);
  useEffect(() => { walkPhaseRef.current = walkPhase; }, [walkPhase]);
  useEffect(() => { followRef.current = follow; }, [follow]);

  const stops = route?.points || [];
  const lastIdx = stops.length - 1;
  // Next stop the driver is heading to: first not-yet-complete stop.
  const targetIdx = stops.findIndex((_, i) => i >= 1 && !stopComplete(i, stops, arrived, walkDone, departed));

  const loadRoute = useCallback(async () => {
    try {
      const { route, upNext } = await api('/api/my-route');
      setRoute(route);
      setUpNext(upNext || []);
      if (route?.id) {
        const { events } = await api(`/api/routes/${route.id}/progress`);
        const arr = {}, dep = {}, wd = {};
        for (const e of events) {
          if (e.kind === 'arrived') arr[e.stopIndex] = e.ts;
          if (e.kind === 'departed') { dep[e.stopIndex] = e.ts; wd[e.stopIndex] = true; }
        }
        setArrived(arr);
        setDeparted(dep);
        setWalkDone(wd);
        arrivedRef.current = arr; departedRef.current = dep; walkDoneRef.current = wd;
        behindFlaggedRef.current = {};
      } else {
        setArrived({}); setDeparted({}); setWalkDone({}); setWalkPhase(null);
        arrivedRef.current = {}; departedRef.current = {}; walkDoneRef.current = {};
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
    setWalkPaths(map, stops);
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

    // Auto-progress at the current target stop.
    const r = routeRef.current;
    const pts = r?.points;
    if (pts) {
      const tIdx = pts.findIndex((_, i) => i >= 1 && !stopComplete(i, pts, arrivedRef.current, walkDoneRef.current, departedRef.current));
      if (tIdx >= 1) {
        const s = pts[tIdx];
        const atStop = haversineM(lat, lng, s.lat, s.lng);
        if (s.walk?.geometry) {
          // Walking stop: park -> walk to destination -> walk back to vehicle.
          if (!arrivedRef.current[tIdx]) {
            if (atStop <= ARRIVE_RADIUS_M) markArrived(tIdx, true);
          } else if (walkPhaseRef.current?.stopIndex === tIdx) {
            const dest = s.walk.geometry.coordinates[s.walk.geometry.coordinates.length - 1];
            if (walkPhaseRef.current.phase === 'out' && haversineM(lat, lng, dest[1], dest[0]) <= WALK_ARRIVE_M) {
              setWalkPhaseTo(tIdx, 'back');
            } else if (walkPhaseRef.current.phase === 'back' && atStop <= WALK_ARRIVE_M) {
              finishWalk(tIdx);
            }
          }
        } else if (!arrivedRef.current[tIdx]) {
          if (atStop <= ARRIVE_RADIUS_M) markArrived(tIdx, true);
        } else if (atStop > DEPART_RADIUS_M && tIdx < pts.length - 1) {
          // Pulled away from the stop → the visit is over. (Not for the final
          // stop, which stays current until the driver completes the route.)
          markDeparted(tIdx, true);
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
    // Parked at a walking stop → begin the walk-out phase.
    if (routeRef.current?.points?.[i]?.walk?.geometry) startWalk(i);
  }

  function markDeparted(i, auto = false) {
    if (departedRef.current[i]) return;
    const now = Date.now();
    departedRef.current = { ...departedRef.current, [i]: now };
    setDeparted((d) => ({ ...d, [i]: now }));
    postStopEvent(i, 'departed', { auto });
  }

  // ---- walking sub-path phases ----
  async function postWalkStatus(stopIndex, phase) {
    if (!routeRef.current?.id) return;
    try {
      await api(`/api/routes/${routeRef.current.id}/walk-status`, { method: 'POST', body: { stopIndex, phase } });
    } catch { /* live-only, best-effort */ }
  }

  function startWalk(i) {
    walkPhaseRef.current = { stopIndex: i, phase: 'out' };
    setWalkPhase({ stopIndex: i, phase: 'out' });
    postWalkStatus(i, 'walking');
  }

  function setWalkPhaseTo(i, phase) {
    walkPhaseRef.current = { stopIndex: i, phase };
    setWalkPhase({ stopIndex: i, phase });
    postWalkStatus(i, phase === 'back' ? 'returning' : 'walking');
  }

  // Walk out-and-back done → mark the stop complete and advance.
  function finishWalk(i) {
    walkDoneRef.current = { ...walkDoneRef.current, [i]: true };
    setWalkDone((w) => ({ ...w, [i]: true }));
    walkPhaseRef.current = null;
    setWalkPhase(null);
    postWalkStatus(i, 'done');
    markDeparted(i);
  }

  // Behind-schedule watchdog: every 20s compare now to the target stop's
  // planned arrival; auto-alert dispatch once per stop past the grace window.
  useEffect(() => {
    const iv = setInterval(() => {
      const r = routeRef.current;
      if (!r?.points) return;
      const pts = r.points;
      const tIdx = pts.findIndex((_, i) => i >= 1 && !stopComplete(i, pts, arrivedRef.current, walkDoneRef.current, departedRef.current));
      if (tIdx < 1) { setBehindMin(0); return; }
      const s = pts[tIdx];
      const parked = arrivedRef.current[tIdx];

      // Before arriving we measure lateness against the planned arrival; once
      // parked we measure the stop's own time limit instead — otherwise a
      // driver who arrived exactly on time would be flagged the moment the
      // planned arrival passed. Stops with no limit can't be overstayed.
      let target = null, key = null, overstay = false;
      if (!parked) {
        target = s.plannedArrival; key = `${tIdx}:arrive`;
      } else if (s.timeLimitMin || s.walk?.geometry) {
        target = s.plannedDeparture; key = `${tIdx}:depart`; overstay = true;
      }
      if (!target) { setBehindMin(0); return; }

      const late = (Date.now() - new Date(target).getTime()) / 60000;
      setBehindMin(Math.max(0, Math.round(late)));
      if (late > BEHIND_GRACE_MIN && !behindFlaggedRef.current[key]) {
        behindFlaggedRef.current[key] = true;
        postStopEvent(tIdx, 'behind', {
          auto: true,
          delayMin: Math.round(late),
          note: overstay ? 'over the time limit at this stop' : null,
        });
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
  // Parked at the current stop and past its limit == overstaying, not "late".
  const overstaying = behind && targetIdx >= 1 && Boolean(arrived[targetIdx]) && !departed[targetIdx];

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
          walkPhase ? (
            <div className="banner ok" style={{ color: '#7bedae' }}>
              🚶 {walkPhase.phase === 'out' ? 'Walking to the site' : 'Returning to the vehicle'} — dispatch can see your progress
            </div>
          ) : behind ? (
            <div className="banner warn">
              {overstaying
                ? `⚠ ~${behindMin} min over the time limit at this stop — dispatch has been alerted`
                : `⚠ Running ~${behindMin} min behind schedule — dispatch has been alerted`}
            </div>
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
                const hasWalk = Boolean(s.walk?.geometry);
                const done = isStart || stopComplete(i, stops, arrived, walkDone, departed);
                const current = i === targetIdx;
                const walkM = hasWalk ? Math.round(s.walk.oneWayM || walkOneWayM(s.walk.geometry)) : 0;
                const late = arrived[i] && s.plannedArrival
                  && (arrived[i] - new Date(s.plannedArrival).getTime()) / 60000 > BEHIND_GRACE_MIN;
                const phase = walkPhase?.stopIndex === i ? walkPhase.phase : null;
                return (
                  <li key={i} className={`stop-item${current ? ' current' : ''}${done ? ' done' : ''}`}>
                    <span className="stop-num">{isStart ? '◆' : isEnd ? '■' : i}</span>
                    <span className="stop-body">
                      <span className="stop-name">
                        {s.name?.split(',')[0] || (isStart ? 'Start' : isEnd ? 'End' : `Stop ${i}`)}
                        {hasWalk ? <span className="walk-badge">🚶 {walkM}m</span> : null}
                      </span>
                      <span className="stop-meta">
                        {s.plannedArrival && !isStart ? `plan ${fmtClock(s.plannedArrival)}` : ''}
                        {hasWalk ? ` · walk ~${walkRoundTripMin(s.walk.oneWayM || walkOneWayM(s.walk.geometry))}m` : (s.timeLimitMin ? ` · ${s.timeLimitMin}m` : '')}
                        {s.deadline ? ` · by ${s.deadline}` : ''}
                        {arrived[i] && !isStart ? ` · ${late ? '⚠ ' : '✓ '}parked ${fmtClock(new Date(arrived[i]).toISOString())}` : ''}
                        {arrived[i] && departed[i] ? ` · ${Math.max(1, Math.round((departed[i] - arrived[i]) / 60000))}m here` : ''}
                      </span>
                      {phase && (
                        <span className={`walk-phase ${phase}`}>
                          {phase === 'out' ? '🚶 Walk to the site' : '↩ Return to the vehicle'}
                        </span>
                      )}
                    </span>
                    {current && tracking && !isEnd && (
                      hasWalk ? (
                        phase === 'out' ? <button className="btn small green" onClick={() => setWalkPhaseTo(i, 'back')}>Reached site</button>
                        : phase === 'back' ? <button className="btn small green" onClick={() => finishWalk(i)}>Back at vehicle</button>
                        : !arrived[i] ? <button className="btn small" onClick={() => markArrived(i, false)}>Arrived</button>
                        : null
                      ) : (
                        arrived[i]
                          ? <button className="btn small" onClick={() => markDeparted(i)}>Depart</button>
                          : <button className="btn small" onClick={() => markArrived(i, false)}>Arrived</button>
                      )
                    )}
                  </li>
                );
              })}
            </ol>

            {upNext.length > 0 && (
              <div className="up-next">
                Up next after this: {upNext.map((r) => r.name).join(', ')}
              </div>
            )}

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
