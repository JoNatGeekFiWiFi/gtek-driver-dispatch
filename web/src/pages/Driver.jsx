import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, openWs, clearSession, getUser, fmtMiles, fmtDuration } from '../api.js';
import { createMap, setLineLayer, makeMarker } from '../map.js';
import { watchPosition, isNativeApp } from '../geo.js';

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

  const loadRoute = useCallback(async () => {
    try {
      const { route } = await api('/api/my-route');
      setRoute(route);
    } catch { /* retried on next ws event */ }
  }, []);

  useEffect(() => {
    const map = createMap(mapEl.current, { zoom: 11 });
    mapRef.current = map;
    return () => map.remove();
  }, []);

  useEffect(() => { loadRoute(); }, [loadRoute]);

  // draw assigned route
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    setLineLayer(map, 'my-route', route?.geometry || null);
    if (route?.geometry) {
        const coords = route.geometry.coordinates;
        let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
        for (const [lng, lat] of coords) {
          minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
          minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
        }
        map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 50, maxZoom: 14 });
    }
  }, [route]);

  // websocket: receives route assignments and off-route status echoes
  useEffect(() => {
    const ws = openWs((m) => {
      if (m.type === 'route_assigned' || m.type === 'route_status') loadRoute();
      if (m.type === 'position_ack') setOffRoute(Boolean(m.offRoute));
    });
    wsRef.current = ws;
    return () => ws?.close();
  }, [loadRoute]);

  async function startTracking() {
    setGpsError('');
    try {
      watcher.current = await watchPosition(
        ({ lat, lng, speed, heading, accuracy }) => {
          setLastFix({ lat, lng, at: Date.now() });
          wsRef.current?.send({ type: 'position', lat, lng, speed, heading, accuracy });
          const map = mapRef.current;
          if (map) {
            if (!meMarker.current) {
              meMarker.current = makeMarker(map, [lng, lat], {
                html: '<div class="driver-marker">You</div>',
              });
              map.flyTo({ center: [lng, lat], zoom: 14 });
            } else {
              meMarker.current.setLngLat([lng, lat]);
            }
          }
        },
        (message) => setGpsError(message)
      );
      setTracking(true);
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

  function logout() {
    stopTracking();
    clearSession();
    navigate('/login');
  }

  return (
    <div className="driver-app">
      <header className="driver-head">
        <img src="/icon.svg" alt="" width="26" height="26" />
        <h1>{user?.name}</h1>
        <button className="btn small" onClick={logout}>Sign out</button>
      </header>

      <div className="driver-map">
        <div ref={mapEl} className="map" />
      </div>

      <div className="driver-panel">
        {tracking ? (
          offRoute ? (
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
            <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>
              {route.points?.[0]?.name} → {route.points?.[route.points.length - 1]?.name}
              <br />
              {route.distance_m ? `${fmtMiles(route.distance_m)} · ` : ''}
              {route.duration_traffic_s ? `about ${fmtDuration(route.duration_traffic_s)}` : ''}
              {route.scheduled_start ? ` · scheduled ${new Date(route.scheduled_start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}
            </div>
            <div className="actions">
              {route.status === 'assigned' && (
                <button className="btn green" onClick={() => setStatus('in_progress')}>Start route</button>
              )}
              {route.status === 'in_progress' && (
                <button className="btn primary" onClick={() => setStatus('completed')}>Complete route</button>
              )}
              <button className="btn" onClick={tracking ? stopTracking : startTracking}>
                {tracking ? 'Stop sharing' : 'Share location'}
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
