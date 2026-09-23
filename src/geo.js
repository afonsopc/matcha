// Place names <-> coordinates through OpenStreetMap's Nominatim, called from
// the server so the browser never talks to a third party. Its usage policy
// asks for an identifying User-Agent and at most one request per second, so
// calls are queued one second apart and answers are cached.
const ENDPOINT = 'https://nominatim.openstreetmap.org';
const USER_AGENT = 'Matcha dating app (42 school project)';
const cache = new Map();
let queue = Promise.resolve();

function throttled(url) {
  if (cache.has(url)) return Promise.resolve(cache.get(url));
  const job = queue.then(async () => {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'pt,en' }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`Nominatim answered ${res.status}`);
    const data = await res.json();
    cache.set(url, data);
    return data;
  });
  queue = job.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 1000)));
  return job;
}

// Coordinates -> { city, neighborhood }, or null when nothing is known there.
async function reverseGeocode(lat, lon) {
  const url = `${ENDPOINT}/reverse?format=jsonv2&zoom=16&addressdetails=1&lat=${Number(lat).toFixed(5)}&lon=${Number(lon).toFixed(5)}`;
  const data = await throttled(url);
  const a = data && data.address;
  if (!a) return null;
  const city = a.city || a.town || a.village || a.municipality || a.county || '';
  const neighborhood = a.neighbourhood || a.suburb || a.quarter || a.city_district || (a.village !== city ? a.village : '') || '';
  return city ? { city, neighborhood } : null;
}

// Typed place -> approximate { latitude, longitude } of its centre, or null.
async function forwardGeocode(city, neighborhood) {
  const q = [neighborhood, city].filter(Boolean).join(', ');
  if (!q) return null;
  const url = `${ENDPOINT}/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
  const data = await throttled(url);
  const hit = Array.isArray(data) && data[0];
  return hit ? { latitude: Number(hit.lat), longitude: Number(hit.lon) } : null;
}

module.exports = { reverseGeocode, forwardGeocode };
