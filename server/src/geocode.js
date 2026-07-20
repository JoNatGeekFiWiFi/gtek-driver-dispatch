// Address search via OpenStreetMap Nominatim (free). Proxied through the server
// so we can send a proper User-Agent per Nominatim's usage policy and cache results.

const cache = new Map();

export async function geocode(query) {
  const q = (query || '').trim();
  if (q.length < 3) return [];
  if (cache.has(q)) return cache.get(q);

  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'DispatchRouteBuilder/0.1 (self-hosted dispatch platform)' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Geocoding failed: ${res.status}`);
  const data = await res.json();
  const results = data.map((r) => ({
    name: r.display_name,
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
  }));
  if (cache.size > 500) cache.clear();
  cache.set(q, results);
  return results;
}
