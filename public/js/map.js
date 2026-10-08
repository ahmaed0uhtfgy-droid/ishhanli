import { APP } from './config.js';

export function createMap(el, { center, zoom } = {}) {
  const map = L.map(el, { scrollWheelZoom: true }).setView(center || APP.mapCenter, zoom || APP.mapZoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
  setTimeout(() => map.invalidateSize(), 150);
  return map;
}
export const pinIcon = (kind) => L.divIcon({ className: `pin pin-${kind}`, html: '<span></span>', iconSize: [28, 28], iconAnchor: kind === 'truck' ? [14, 14] : [14, 28] });

// Nominatim (OpenStreetMap): للاستخدام الخفيف فقط — لو الحركة كبرت استبدله بمزوّد جيوكودنج مدفوع أو مستضاف
export async function geocode(q) {
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=eg&accept-language=ar&q=${encodeURIComponent(q)}`);
  if (!r.ok) return [];
  return (await r.json()).map((x) => ({ lat: +x.lat, lng: +x.lon, name: x.display_name }));
}
export async function reverse(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=ar&lat=${lat}&lon=${lng}`);
    const j = await r.json();
    return (j.display_name || '').split('،').slice(0, 3).join('،').slice(0, 120);
  } catch { return ''; }
}
