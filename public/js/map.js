import { APP } from './config.js';

export function createMap(el, { center, zoom } = {}) {
  const map = L.map(el, { scrollWheelZoom: true }).setView(center || APP.mapCenter, zoom || APP.mapZoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
  setTimeout(() => map.invalidateSize(), 150);
  return map;
}
// دبابيس واضحة: A (استلام) أخضر، B (تسليم) أحمر، والسواق عربية 🚚 بنبض
export const pinIcon = (kind) => L.divIcon({
  className: `pin pin-${kind}`,
  html: kind === 'truck' ? '<i class="pulse"></i><span>🚚</span>' : `<span></span><b>${kind === 'a' ? 'A' : 'B'}</b>`,
  iconSize: kind === 'truck' ? [38, 38] : [30, 30], iconAnchor: kind === 'truck' ? [19, 19] : [15, 30],
});
// المسار الفعلي على الطرق (OSRM العام): لو فشل نرسم خط متقطع مستقيم. بيرجّع المسافة (كم) والزمن (دقايق) لو اتحسبوا.
export async function drawRoute(map, a, b) {
  try {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${a[1]},${a[0]};${b[1]},${b[0]}?overview=full&geometries=geojson`, { signal: ctl.signal });
    clearTimeout(tm);
    const rt = (await r.json()).routes?.[0]; if (!rt) throw new Error('no route');
    const pts = rt.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    L.polyline(pts, { color: '#fff', weight: 9, opacity: 0.95 }).addTo(map);
    const line = L.polyline(pts, { color: '#1a6fd1', weight: 5, opacity: 0.95 }).addTo(map);
    map.fitBounds(line.getBounds(), { padding: [40, 40] });
    return { km: rt.distance / 1000, min: Math.max(1, Math.round(rt.duration / 60)) };
  } catch {
    L.polyline([a, b], { color: '#c99400', weight: 4, dashArray: '8 8' }).addTo(map);
    return null;
  }
}
export const gmapsLink = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
export function distKm(a, b) { // مسافة تقريبية بين نقطتين (هافرساين)
  const R = 6371, rad = (x) => (x * Math.PI) / 180, dLa = rad(b[0] - a[0]), dLo = rad(b[1] - a[1]);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

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
