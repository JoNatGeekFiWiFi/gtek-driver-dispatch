import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, openWs, clearSession, getUser, fmtMiles, fmtDuration, fmtAgo, fmtClock, walkOneWayM, walkRoundTripMin } from '../api.js';
import { createMap, setLineLayer, setCrashLayer, removeCrashLayer, makeMarker, setWalkPaths } from '../map.js';

const POINT_COLORS = { first: '#2ecc71', last: '#e74c3c', mid: '#2f7df6' };

export default function Dispatch() {
  const navigate = useNavigate();
  const user = getUser();

  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const pointMarkers = useRef([]);
  const driverMarkers = useRef(new Map());
  const clickHandler = useRef(() => {});

  const [tab, setTab] = useState('build');
  const [points, setPoints] = useState([]);
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [departAt, setDepartAt] = useState(() => toLocalInput(new Date()));
  const [plan, setPlan] = useState(null);
  const [planning, setPlanning] = useState(false);
  const [walkEdit, setWalkEdit] = useState(null); // { stopIndex, mode } while tracing a walk
  const [routeName, setRouteName] = useState('');
  const [assignTo, setAssignTo] = useState('');
  const [msg, setMsg] = useState(null); // {kind:'error'|'success', text}
  const [drivers, setDrivers] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [livePos, setLivePos] = useState({});
  const [alerts, setAlerts] = useState([]); // recent stop events / behind alerts
  const [crashOverlay, setCrashOverlay] = useState(false);
  const [dataStats, setDataStats] = useState({ stats: [], states: [] });
  const [providers, setProviders] = useState(null);
  const [ingest, setIngest] = useState({ state: 'AZ', fromYear: 2021, toYear: 2023 });
  const [sources, setSources] = useState([]);
  const [busyIngest, setBusyIngest] = useState(null); // sourceId while running

  // ---- map lifecycle ----
  useEffect(() => {
    const map = createMap(mapEl.current);
    mapRef.current = map;
    map.on('click', (e) => clickHandler.current(e));
    map.on('moveend', () => {
      if (crashOverlayRef.current) loadCrashes();
    });
    return () => map.remove();
  }, []);

  // map click: while editing a stop's walk path it adds walk waypoints,
  // otherwise it appends a route point (start, then stops, then end).
  clickHandler.current = (e) => {
    if (tab !== 'build') return;
    const { lat, lng } = e.lngLat;
    if (walkEditRef.current) {
      handleWalkClick(lat, lng);
      return;
    }
    addPoint({ lat, lng, name: `${lat.toFixed(4)}, ${lng.toFixed(4)}` });
  };

  function addPoint(p) {
    setPoints((pts) => [...pts, p]);
    setPlan(null);
    setSearchResults([]);
  }

  // Edit a stop's dwell limit / deadline; invalidate the plan so the schedule
  // is recomputed before saving.
  function updatePoint(i, patch) {
    setPoints((pts) => pts.map((p, j) => (j === i ? { ...p, ...patch } : p)));
    setPlan(null);
  }

  // ---- walking sub-path editing ----
  const walkEditRef = useRef(null);
  useEffect(() => { walkEditRef.current = walkEdit; }, [walkEdit]);

  function setWalk(i, walk) {
    setPoints((pts) => pts.map((p, j) => (j === i ? { ...p, walk } : p)));
    setPlan(null);
  }

  function startWalkEdit(i, mode) {
    if (mode === 'none') { setWalk(i, null); setWalkEdit(null); return; }
    setWalk(i, { mode, geometry: null, oneWayM: 0 }); // reset; awaits map clicks
    setWalkEdit({ stopIndex: i, mode });
    setMsg({ kind: 'success', text: mode === 'traced'
      ? 'Click the map to trace the walk from the vehicle; click “Finish walk” when done.'
      : mode === 'point' ? 'Click the walk destination on the map.'
      : 'Click the walk destination — it will be routed on foot.' });
  }

  async function handleWalkClick(lat, lng) {
    const edit = walkEditRef.current;
    if (!edit) return;
    const i = edit.stopIndex;
    const stop = points[i];
    if (edit.mode === 'traced') {
      // Walk starts at the vehicle (the stop) and follows each clicked point.
      setPoints((pts) => pts.map((p, j) => {
        if (j !== i) return p;
        const coords = p.walk?.geometry?.coordinates?.length
          ? [...p.walk.geometry.coordinates, [lng, lat]]
          : [[p.lng, p.lat], [lng, lat]];
        const geometry = { type: 'LineString', coordinates: coords };
        return { ...p, walk: { mode: 'traced', geometry, oneWayM: walkOneWayM(geometry) } };
      }));
      setPlan(null);
    } else if (edit.mode === 'point') {
      const geometry = { type: 'LineString', coordinates: [[stop.lng, stop.lat], [lng, lat]] };
      setWalk(i, { mode: 'point', geometry, oneWayM: walkOneWayM(geometry) });
      setWalkEdit(null);
    } else if (edit.mode === 'routed') {
      try {
        const r = await api('/api/walk/route', { method: 'POST', body: { from: { lat: stop.lat, lng: stop.lng }, to: { lat, lng } } });
        setWalk(i, { mode: 'routed', geometry: r.geometry, oneWayM: r.oneWayM ?? walkOneWayM(r.geometry) });
        setMsg({ kind: 'success', text: `Walk routed on foot (${r.provider})` });
      } catch (err) {
        setMsg({ kind: 'error', text: err.message });
      }
      setWalkEdit(null);
    }
  }

  // keep point markers in sync
  useEffect(() => {
    pointMarkers.current.forEach((m) => m.remove());
    pointMarkers.current = points.map((p, i) => {
      const color =
        i === 0 ? POINT_COLORS.first : i === points.length - 1 && points.length > 1 ? POINT_COLORS.last : POINT_COLORS.mid;
      return makeMarker(mapRef.current, [p.lng, p.lat], { color, label: p.name });
    });
    if (mapRef.current) setWalkPaths(mapRef.current, points);
  }, [points]);

  // draw planned route
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    setLineLayer(map, 'planned-route', plan?.geometry || null);
    if (plan?.geometry) fitTo(map, plan.geometry.coordinates);
  }, [plan]);

  // ---- crash overlay ----
  const crashOverlayRef = useRef(false);
  crashOverlayRef.current = crashOverlay;

  const loadCrashes = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;
    const b = map.getBounds();
    try {
      const { crashes } = await api(
        `/api/crashes?minLat=${b.getSouth()}&maxLat=${b.getNorth()}&minLng=${b.getWest()}&maxLng=${b.getEast()}`
      );
      setCrashLayer(map, 'crashes', crashes);
    } catch { /* keep old layer on transient errors */ }
  }, []);

  useEffect(() => {
    if (crashOverlay) loadCrashes();
    else if (mapRef.current) removeCrashLayer(mapRef.current, 'crashes');
  }, [crashOverlay, loadCrashes]);

  // ---- data loading ----
  const refreshDrivers = useCallback(() => {
    api('/api/drivers').then((d) => setDrivers(d.drivers)).catch(() => {});
  }, []);
  const refreshRoutes = useCallback(() => {
    api('/api/routes').then((d) => setRoutes(d.routes)).catch(() => {});
  }, []);

  useEffect(() => {
    refreshDrivers();
    refreshRoutes();
    api('/api/status').then((d) => setProviders(d.providers)).catch(() => {});
    api('/api/crashes/stats').then(setDataStats).catch(() => {});
  }, [refreshDrivers, refreshRoutes]);

  // ---- live tracking ----
  useEffect(() => {
    const ws = openWs((m) => {
      if (m.type === 'driver_position') {
        setLivePos((prev) => ({ ...prev, [m.driverId]: m }));
      } else if (m.type === 'driver_offline') {
        setLivePos((prev) => {
          const next = { ...prev };
          delete next[m.driverId];
          return next;
        });
      } else if (m.type === 'route_status' || m.type === 'route_assigned') {
        refreshRoutes();
      } else if (m.type === 'stop_event') {
        setAlerts((prev) => [{ ...m, id: `${m.driverId}-${m.ts}` }, ...prev].slice(0, 30));
      } else if (m.type === 'walk_status') {
        setAlerts((prev) => [{ ...m, kind: 'walk', id: `${m.driverId}-${m.ts}` }, ...prev].slice(0, 30));
      }
    });
    return () => ws?.close();
  }, [refreshRoutes]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const seen = new Set();
    for (const pos of Object.values(livePos)) {
      seen.add(pos.driverId);
      let marker = driverMarkers.current.get(pos.driverId);
      if (!marker) {
        marker = makeMarker(map, [pos.lng, pos.lat], { html: `<div class="driver-marker">${esc(pos.name)}</div>` });
        driverMarkers.current.set(pos.driverId, marker);
      } else {
        marker.setLngLat([pos.lng, pos.lat]);
      }
      // toggle, don't overwrite — MapLibre keeps its own classes on this element
      marker.getElement().classList.toggle('offroute', Boolean(pos.offRoute));
    }
    for (const [id, marker] of driverMarkers.current) {
      if (!seen.has(id)) {
        marker.remove();
        driverMarkers.current.delete(id);
      }
    }
  }, [livePos]);

  // ---- actions ----
  async function doSearch(e) {
    e?.preventDefault();
    if (searchQ.trim().length < 3) return;
    try {
      const { results } = await api(`/api/geocode?q=${encodeURIComponent(searchQ)}`);
      setSearchResults(results);
      if (!results.length) setMsg({ kind: 'error', text: 'No matches — try a fuller address' });
    } catch (err) {
      setMsg({ kind: 'error', text: err.message });
    }
  }

  async function doPlan() {
    setPlanning(true);
    setMsg(null);
    try {
      const departIso = new Date(departAt).toISOString();
      const result = await api('/api/route/plan', { method: 'POST', body: { points, departAt: departIso } });
      setPlan({ ...result, departAt: departIso });
    } catch (err) {
      setMsg({ kind: 'error', text: err.message });
    } finally {
      setPlanning(false);
    }
  }

  async function saveRoute() {
    if (!routeName.trim()) {
      setMsg({ kind: 'error', text: 'Give the route a name first' });
      return;
    }
    try {
      await api('/api/routes', {
        method: 'POST',
        body: {
          name: routeName.trim(),
          points,
          geometry: plan.geometry,
          distanceM: plan.distanceM,
          durationS: plan.durationS,
          durationTrafficS: plan.durationTrafficS,
          hazard: plan.hazard,
          provider: plan.provider,
          schedule: plan.schedule,
          driverId: assignTo ? Number(assignTo) : null,
          scheduledStart: plan.departAt,
        },
      });
      setMsg({ kind: 'success', text: assignTo ? 'Route saved and assigned' : 'Route saved as draft' });
      setRouteName('');
      refreshRoutes();
    } catch (err) {
      setMsg({ kind: 'error', text: err.message });
    }
  }

  function clearBuilder() {
    setPoints([]);
    setPlan(null);
    setMsg(null);
    if (mapRef.current) setLineLayer(mapRef.current, 'planned-route', null);
  }

  function showRoute(r) {
    if (!r.geometry) return;
    setPlan(null);
    setLineLayer(mapRef.current, 'planned-route', r.geometry);
    fitTo(mapRef.current, r.geometry.coordinates);
  }

  async function showTrail(driverId) {
    try {
      const { trail } = await api(`/api/drivers/${driverId}/trail`);
      if (trail.length) {
        setLineLayer(mapRef.current, 'driver-trail', {
          type: 'LineString',
          coordinates: trail.map((t) => [t.lng, t.lat]),
        }, { color: '#f39c12', width: 3, dash: [1, 2] });
        const last = trail[trail.length - 1];
        mapRef.current.flyTo({ center: [last.lng, last.lat], zoom: 13 });
      }
      const live = livePos[driverId];
      if (live) mapRef.current.flyTo({ center: [live.lng, live.lat], zoom: 13 });
    } catch { /* trail is best-effort */ }
  }

  // refresh available importers whenever the state changes
  useEffect(() => {
    api(`/api/crashes/sources?state=${ingest.state}`)
      .then((d) => setSources(d.sources))
      .catch(() => {});
  }, [ingest.state]);

  async function runIngest(sourceId) {
    setBusyIngest(sourceId);
    setMsg(null);
    try {
      const res = await api('/api/crashes/ingest', { method: 'POST', body: { sourceId, ...ingest } });
      setMsg({ kind: 'success', text: `Loaded ${res.inserted.toLocaleString()} crash records` });
      api('/api/crashes/stats').then(setDataStats).catch(() => {});
      if (crashOverlay) loadCrashes();
    } catch (err) {
      setMsg({ kind: 'error', text: err.message });
    } finally {
      setBusyIngest(null);
    }
  }

  function logout() {
    clearSession();
    navigate('/login');
  }

  const maxProfile = plan ? Math.max(...plan.departureProfile.map((p) => p.durationS)) : 1;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-head">
          <img src="/icon.svg" alt="" width="26" height="26" />
          <h1>Dispatch</h1>
          <span className="muted" style={{ fontSize: 12 }}>{user?.name}</span>
          <button className="btn small" onClick={logout}>Sign out</button>
        </div>
        <div className="tabs">
          {[['build', 'Route Builder'], ['routes', 'Routes'], ['drivers', 'Drivers'], ['data', 'Data']].map(([id, label]) => (
            <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        <div className="sidebar-body">
          {msg && <div className={msg.kind}>{msg.text}</div>}

          {alerts.length > 0 && (
            <div className="card" style={{ borderColor: alerts.some((a) => a.kind === 'behind') ? 'var(--red)' : 'var(--border)' }}>
              <h3 style={{ display: 'flex', justifyContent: 'space-between' }}>
                Live alerts
                <button className="btn link" style={{ padding: 0 }} onClick={() => setAlerts([])}>clear</button>
              </h3>
              <div className="alert-feed">
                {alerts.slice(0, 8).map((a) => (
                  <div key={a.id} className={`alert-line ${a.kind}`}>
                    <span className="alert-icon">{a.kind === 'behind' ? '⚠' : a.kind === 'arrived' ? '●' : a.kind === 'walk' ? '🚶' : '→'}</span>
                    <span className="alert-text">
                      <b>{a.driverName}</b>{' '}
                      {a.kind === 'behind'
                        ? `running behind${a.delayMin ? ` ~${a.delayMin}m` : ''}${a.stopName ? ` (before ${a.stopName})` : ''}`
                        : a.kind === 'arrived'
                        ? `arrived at ${a.stopName || `stop ${a.stopIndex}`}${a.auto ? '' : ' (manual)'}`
                        : a.kind === 'walk'
                        ? (a.phase === 'walking' ? `walking to ${a.stopName || `stop ${a.stopIndex}`}`
                           : a.phase === 'returning' ? `walking back to the vehicle at ${a.stopName || `stop ${a.stopIndex}`}`
                           : `finished the walk at ${a.stopName || `stop ${a.stopIndex}`}`)
                        : `departed ${a.stopName || `stop ${a.stopIndex}`}`}
                      {a.note ? ` — “${a.note}”` : ''}
                    </span>
                    <span className="alert-time">{fmtAgo(a.ts)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'build' && (
            <>
              <div className="card">
                <h3>Stops</h3>
                <p className="muted" style={{ margin: '4px 0 8px', fontSize: 12.5 }}>
                  Search an address or click the map. First point is the start, last is the end.
                </p>
                <form className="row" onSubmit={doSearch}>
                  <input value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder="Search address or place" />
                  <button className="btn" type="submit">Search</button>
                </form>
                {searchResults.length > 0 && (
                  <ul className="geo-results">
                    {searchResults.map((r, i) => (
                      <li key={i} onClick={() => addPoint(r)}>{r.name}</li>
                    ))}
                  </ul>
                )}
                <ul className="point-list">
                  {points.map((p, i) => {
                    const isStart = i === 0;
                    const isEnd = i === points.length - 1 && points.length > 1;
                    return (
                    <li key={i} className="stop-row">
                      <div className="stop-head">
                        <span
                          className="dot"
                          style={{ background: isStart ? POINT_COLORS.first : isEnd ? POINT_COLORS.last : POINT_COLORS.mid }}
                        />
                        <span className="name" title={p.name}>
                          {isStart ? 'Start: ' : isEnd ? 'End: ' : `Stop ${i}: `}{p.name}
                        </span>
                        <button className="x" onClick={() => { setPoints(points.filter((_, j) => j !== i)); setPlan(null); }}>✕</button>
                      </div>
                      {!isStart && (
                        <div className="stop-limits">
                          {!isEnd && (
                            <label className="mini">Time limit
                              <span className="with-unit">
                                <input type="number" min="0" placeholder="—"
                                  value={p.timeLimitMin ?? ''}
                                  onChange={(e) => updatePoint(i, { timeLimitMin: e.target.value === '' ? null : Number(e.target.value) })} />
                                <span>min</span>
                              </span>
                            </label>
                          )}
                          <label className="mini">Arrive by (optional)
                            <input type="time"
                              value={p.deadline ?? ''}
                              onChange={(e) => updatePoint(i, { deadline: e.target.value || null })} />
                          </label>
                        </div>
                      )}
                      {!isStart && !isEnd && (
                        <div className="walk-controls">
                          <span className="walk-label">🚶 Walk</span>
                          {walkEdit?.stopIndex === i ? (
                            <>
                              <span className="muted" style={{ fontSize: 11 }}>
                                {walkEdit.mode === 'traced' ? 'tracing…' : 'click destination…'}
                              </span>
                              {walkEdit.mode === 'traced' && (
                                <button className="btn small" onClick={() => setWalkEdit(null)}>Finish walk</button>
                              )}
                              <button className="btn link small" onClick={() => { setWalk(i, null); setWalkEdit(null); }}>cancel</button>
                            </>
                          ) : p.walk?.geometry ? (
                            <>
                              <span className="walk-info">
                                {Math.round(p.walk.oneWayM || walkOneWayM(p.walk.geometry))} m · ~{walkRoundTripMin(p.walk.oneWayM || walkOneWayM(p.walk.geometry))} min round trip
                              </span>
                              <button className="btn link small" onClick={() => setWalk(i, null)}>remove</button>
                            </>
                          ) : (
                            <span className="walk-modes">
                              <button className="btn small" onClick={() => startWalkEdit(i, 'traced')}>Trace</button>
                              <button className="btn small" onClick={() => startWalkEdit(i, 'point')}>Point</button>
                              <button className="btn small" onClick={() => startWalkEdit(i, 'routed')}>Routed</button>
                            </span>
                          )}
                        </div>
                      )}
                    </li>
                  );})}
                </ul>
                <label>Departure time
                  <input type="datetime-local" value={departAt} onChange={(e) => setDepartAt(e.target.value)} />
                </label>
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="btn primary" disabled={points.length < 2 || planning} onClick={doPlan}>
                    {planning ? 'Planning…' : 'Plan route'}
                  </button>
                  <button className="btn" onClick={clearBuilder}>Clear</button>
                </div>
              </div>

              {plan && (
                <div className="card">
                  <h3>Route plan</h3>
                  <div className="stat-grid">
                    <div className="stat"><div className="label">Distance</div><div className="value">{fmtMiles(plan.distanceM)}</div></div>
                    <div className="stat"><div className="label">Normal ETA</div><div className="value">{fmtDuration(plan.durationS)}</div></div>
                    <div className="stat">
                      <div className="label">{plan.liveTraffic ? 'Live traffic ETA' : 'Rush-hour ETA'}</div>
                      <div className="value" style={{ color: plan.durationTrafficS > plan.durationS * 1.15 ? '#f39c12' : undefined }}>
                        {fmtDuration(plan.durationTrafficS)}
                      </div>
                    </div>
                    <div className="stat">
                      <div className="label">Crash hazard</div>
                      <div className="value small">
                        <span className={`chip ${plan.hazard.rating.replace(' ', '.')}`}>{plan.hazard.rating}</span>
                        {' '}{plan.hazard.count > 0 && `${plan.hazard.count} nearby`}
                      </div>
                    </div>
                  </div>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    Provider: {plan.provider}{plan.liveTraffic ? ' (live traffic)' : ' + rush-hour model'}
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <div className="label muted" style={{ fontSize: 11 }}>ETA BY DEPARTURE TIME (NEXT 12 HRS)</div>
                    <div className="profile-bars">
                      {plan.departureProfile.map((p, i) => (
                        <div
                          key={i}
                          className={`bar${p.multiplier > 1.15 ? ' rush' : ''}`}
                          style={{ height: `${(p.durationS / maxProfile) * 100}%` }}
                          title={`${p.hourLabel}: ${fmtDuration(p.durationS)}`}
                        />
                      ))}
                    </div>
                    <div className="profile-labels">
                      {plan.departureProfile.map((p, i) => <span key={i}>{i % 2 === 0 ? p.hourLabel : ''}</span>)}
                    </div>
                  </div>
                  {plan.schedule?.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <div className="label muted" style={{ fontSize: 11 }}>PLANNED SCHEDULE</div>
                      <table className="sched-table">
                        <tbody>
                          {plan.schedule.map((s, i) => (
                            <tr key={i}>
                              <td className="sched-name" title={s.name}>
                                {i === 0 ? 'Start' : i === plan.schedule.length - 1 ? 'End' : `Stop ${i}`}
                              </td>
                              <td className="sched-time">{fmtClock(s.plannedArrival)}</td>
                              <td className="sched-dwell">
                                {s.walkMin ? <span className="chip" style={{ background: '#1d6b40', marginRight: 4 }}>🚶 {s.walkMin}m</span> : ''}
                                {s.timeLimitMin ? `${s.timeLimitMin}m → ` : ''}
                                {(s.timeLimitMin || s.walkMin) ? fmtClock(s.plannedDeparture) : ''}
                                {s.deadline ? <span className="chip high" style={{ marginLeft: 4 }}>by {s.deadline}</span> : ''}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <label>Route name
                    <input value={routeName} onChange={(e) => setRouteName(e.target.value)} placeholder="Morning delivery run" />
                  </label>
                  <label>Assign to driver (optional)
                    <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
                      <option value="">— save as draft —</option>
                      {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </label>
                  <button className="btn primary block" onClick={saveRoute}>Save route</button>
                </div>
              )}
            </>
          )}

          {tab === 'routes' && (
            <>
              {routes.length === 0 && <p className="muted">No routes yet — build one in the Route Builder tab.</p>}
              {routes.map((r) => (
                <div key={r.id} className="list-item" onClick={() => showRoute(r)}>
                  <div className="title">
                    <b>{r.name}</b>
                    <span className={`chip ${r.status}`}>{r.status.replace('_', ' ')}</span>
                  </div>
                  <div className="sub">
                    {r.driver_name ? `Driver: ${r.driver_name}` : 'Unassigned'}
                    {r.distance_m ? ` · ${fmtMiles(r.distance_m)}` : ''}
                    {r.duration_traffic_s ? ` · ${fmtDuration(r.duration_traffic_s)}` : ''}
                    {r.hazard_score != null ? ` · hazard ${r.hazard_score}` : ''}
                  </div>
                  {r.status === 'draft' && drivers.length > 0 && (
                    <div className="row" style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
                      <select defaultValue="" id={`assign-${r.id}`}>
                        <option value="" disabled>Assign to…</option>
                        {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                      <button
                        className="btn small"
                        onClick={async () => {
                          const sel = document.getElementById(`assign-${r.id}`);
                          if (!sel.value) return;
                          await api(`/api/routes/${r.id}/assign`, { method: 'POST', body: { driverId: Number(sel.value) } });
                          refreshRoutes();
                        }}
                      >Assign</button>
                    </div>
                  )}
                </div>
              ))}
            </>
          )}

          {tab === 'drivers' && (
            <>
              <div className="card">
                <h3>Add driver</h3>
                <AddDriver onAdded={() => { refreshDrivers(); setMsg({ kind: 'success', text: 'Driver account created — they sign in at this same site and open /driver' }); }} onError={(text) => setMsg({ kind: 'error', text })} />
              </div>
              {drivers.map((d) => {
                const live = livePos[d.id] || d.live;
                const online = live && Date.now() - live.ts < 60000;
                return (
                  <div key={d.id} className="list-item" onClick={() => showTrail(d.id)}>
                    <div className="title">
                      <b>
                        <span className={`status-dot ${online ? (live.offRoute ? 'offroute' : 'online') : 'offline'}`} />
                        {d.name}
                      </b>
                      {online && live.offRoute && <span className="chip high">off route</span>}
                    </div>
                    <div className="sub">
                      {d.email}
                      {online
                        ? ` · live ${fmtAgo(live.ts)}${live.speed != null ? ` · ${Math.round(live.speed * 2.237)} mph` : ''}`
                        : ' · offline'}
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {tab === 'data' && (
            <>
              <div className="card">
                <h3>Services</h3>
                <div className="sub muted" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
                  Routing: <b style={{ color: 'var(--text)' }}>{providers?.routing || '…'}</b><br />
                  Live traffic: <b style={{ color: 'var(--text)' }}>{providers?.liveTraffic ? 'on' : 'off — using rush-hour model'}</b><br />
                  <span style={{ fontSize: 11.5 }}>Add MAPBOX_TOKEN or TOMTOM_KEY to .env to enable live traffic.</span>
                </div>
              </div>
              <div className="card">
                <h3>Public crash data</h3>
                <div className="row">
                  <label>State
                    <select value={ingest.state} onChange={(e) => setIngest({ ...ingest, state: e.target.value })}>
                      {dataStats.states.map((s) => <option key={s}>{s}</option>)}
                    </select>
                  </label>
                  <label>From
                    <input type="number" min="2010" max="2026" value={ingest.fromYear} onChange={(e) => setIngest({ ...ingest, fromYear: e.target.value })} />
                  </label>
                  <label>To
                    <input type="number" min="2010" max="2026" value={ingest.toYear} onChange={(e) => setIngest({ ...ingest, toYear: e.target.value })} />
                  </label>
                </div>
                {sources.map((src) => {
                  const stat = dataStats.stats.find((s) => s.source === src.id);
                  return (
                    <div key={src.id} className="list-item" style={{ cursor: 'default', marginTop: 8 }}>
                      <div className="title">
                        <b>{src.name}</b>
                        {stat && <span className="chip assigned">{stat.count.toLocaleString()} loaded</span>}
                      </div>
                      <div className="sub">{src.description}</div>
                      <button
                        className="btn small"
                        style={{ marginTop: 8 }}
                        disabled={busyIngest != null}
                        onClick={() => runIngest(src.id)}
                      >
                        {busyIngest === src.id ? 'Importing…' : stat ? 'Re-import' : 'Import'}
                      </button>
                    </div>
                  );
                })}
                <p className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
                  Sources are per-state importers registered in server/src/importers.js — adding a
                  state is one config entry (most agencies publish ArcGIS feeds the generic
                  importer already understands).
                </p>
              </div>
            </>
          )}
        </div>
      </aside>

      <main className="map-wrap">
        <div className="map-toolbar">
          <button className={`btn small${crashOverlay ? ' on' : ''}`} onClick={() => setCrashOverlay(!crashOverlay)}>
            {crashOverlay ? '☑' : '☐'} Crash overlay
          </button>
        </div>
        <div ref={mapEl} className="map" />
      </main>
    </div>
  );
}

function AddDriver({ onAdded, onError }) {
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/drivers', { method: 'POST', body: form });
      setForm({ name: '', email: '', password: '' });
      onAdded();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <label>Name<input value={form.name} onChange={set('name')} required /></label>
      <label>Email<input type="email" value={form.email} onChange={set('email')} required /></label>
      <label>Temporary password<input value={form.password} onChange={set('password')} minLength={8} required /></label>
      <button className="btn primary block" disabled={busy}>{busy ? 'Creating…' : 'Create driver'}</button>
    </form>
  );
}

function fitTo(map, coordinates) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const [lng, lat] of coordinates) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 60, maxZoom: 14 });
}

function toLocalInput(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
