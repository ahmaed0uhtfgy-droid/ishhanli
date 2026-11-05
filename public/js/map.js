import { APP } from './config.js';

export function createMap(el, { center, zoom } = {}) {
  const map = L.map(el, { scrollWheelZoom: true, zoomControl: false, attributionControl: false, zoomSnap: 0.5, zoomDelta: 0.5 }).setView(center || APP.mapCenter, zoom || APP.mapZoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'map-tiles', keepBuffer: 4 }).addTo(map); // className: بيتلوّن بـ CSS (ألوان أهدى)
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  L.control.attribution({ prefix: false, position: 'bottomright' }).addAttribution('&copy; OpenStreetMap').addTo(map); // الإسناد مطلوب من OSM
  L.control.scale({ imperial: false, position: 'bottomright', maxWidth: 90 }).addTo(map);
  setTimeout(() => map.invalidateSize(), 150);
  return map;
}
// دبابيس بتصميم موحّد: A (استلام) أخضر النيل، B (تسليم) أحمر، والسواق عربية صفراء بنبض
const TRUCK = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 16V7h11v9M14 10h4l3 3v3h-3"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>';
export const pinIcon = (kind) => kind === 'truck'
  ? L.divIcon({ className: 'pin pin-truck', html: `<i class="pulse"></i><span class="truck-body">${TRUCK}</span>`, iconSize: [44, 44], iconAnchor: [22, 22] })
  : L.divIcon({ className: `pin pin-${kind}`, html: `<svg viewBox="0 0 36 46" width="34" height="44" aria-hidden="true"><path class="pin-body" d="M18 2C9.7 2 3 8.5 3 16.6c0 10.6 15 27.4 15 27.4s15-16.8 15-27.4C33 8.5 26.3 2 18 2z" stroke="#fff" stroke-width="3"/><circle cx="18" cy="16.5" r="8" fill="#fff"/><text x="18" y="21" text-anchor="middle" font-size="12" font-weight="700" class="pin-letter">${kind === 'a' ? 'A' : 'B'}</text></svg>`, iconSize: [34, 44], iconAnchor: [17, 44] });
// المسار الفعلي على الطرق (OSRM العام) من نقطة الاستلام A لنقطة التسليم B. فيه كاش (نفس الزوج من النقط ما يتحسبش مرتين)، ومهلة قصيرة،
// ولو الخدمة وقعت بنرسم خط متقطع مستقيم (تقريبي) ونرجّع null. لو اتبعت group بيترسم فيه (وبيتمسح بـ group.clearLayers() لما النقط تتغيّر).
const routeCache = new Map();
export async function drawRoute(map, a, b, group = L.layerGroup().addTo(map)) {
  const key = [a, b].map((p) => p.map((x) => x.toFixed(4)).join(',')).join('|');
  const draw = (pts, km, min) => {
    L.polyline(pts, { color: '#fff', weight: 11, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }).addTo(group);
    L.polyline(pts, { color: '#173B48', weight: 7, opacity: 0.96, lineCap: 'round', lineJoin: 'round' }).addTo(group);
    const line = L.polyline(pts, { color: '#DCC38A', weight: 2.5, opacity: 1, dashArray: '10 12', className: 'route-flow' }).addTo(group);
    map.fitBounds(line.getBounds(), { padding: [40, 40] });
    return { km, min };
  };
  const hit = routeCache.get(key); if (hit) return draw(hit.pts, hit.km, hit.min);
  try {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${a[1]},${a[0]};${b[1]},${b[0]}?overview=simplified&geometries=geojson`, { signal: ctl.signal });
    clearTimeout(tm);
    const rt = (await r.json()).routes?.[0]; if (!rt) throw new Error('no route');
    const pts = rt.geometry.coordinates.map(([lng, lat]) => [lat, lng]), km = rt.distance / 1000, min = Math.max(1, Math.round(rt.duration / 60));
    if (routeCache.size > 40) routeCache.clear();
    routeCache.set(key, { pts, km, min });
    return draw(pts, km, min);
  } catch {
    L.polyline([a, b], { color: '#B8964E', weight: 4, dashArray: '8 10', className: 'route-flow' }).addTo(group);
    map.fitBounds(L.latLngBounds([a, b]).pad(0.3));
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
