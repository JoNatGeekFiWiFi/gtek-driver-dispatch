// In the browser the app is served next to its API, so relative paths work.
// Native (Capacitor) builds bundle the web assets on-device, so they must
// point at the deployed server: build with VITE_API_BASE=https://your-server
export const API_BASE = import.meta.env.VITE_API_BASE || '';

export function getToken() {
  return localStorage.getItem('dispatch_token');
}

export function getUser() {
  try {
    return JSON.parse(localStorage.getItem('dispatch_user'));
  } catch {
    return null;
  }
}

export function saveSession(token, user) {
  localStorage.setItem('dispatch_token', token);
  localStorage.setItem('dispatch_user', JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem('dispatch_token');
  localStorage.removeItem('dispatch_user');
}

export async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API_BASE + path, {
    ...opts,
    headers,
    body: opts.body != null && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  let data = null;
  try {
    data = await res.json();
  } catch { /* non-JSON error body */ }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export function openWs(onMessage) {
  const token = getToken();
  if (!token) return null;
  const base = API_BASE || `${location.protocol}//${location.host}`;
  const wsBase = base.replace(/^http/, 'ws');
  let ws = null;
  let closed = false;
  let retry = 1000;

  function connect() {
    ws = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen = () => { retry = 1000; };
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch { /* ignore malformed frames */ }
    };
    ws.onclose = () => {
      if (closed) return;
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 15000);
    };
  }
  connect();

  return {
    send(msg) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      closed = true;
      ws?.close();
    },
  };
}

export const fmtMiles = (m) => `${(m / 1609.34).toFixed(1)} mi`;

export const fmtDuration = (s) => {
  if (s == null) return '—';
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} hr ${mins % 60} min`;
};

export const fmtAgo = (ts) => {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 10) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
};

// Local wall-clock time (e.g. "3:05 PM") from an ISO timestamp.
export const fmtClock = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

// Signed minutes difference, formatted (e.g. "+8m late", "on time").
export const fmtDelay = (min) => {
  const m = Math.round(min);
  if (m <= 0) return 'on time';
  return `${m}m behind`;
};
