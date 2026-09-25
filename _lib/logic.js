import { HttpError } from './core.js';
import { settingsDoc } from './db.js';
import { trustOf } from './trust.js';

// القيم الافتراضية (أرقام تجريبية — الأدمن بيعدّلها من لوحة التحكم ولا تحتاج تعديل كود)
export const DEFAULTS = {
  perKm: 10,
  minPrice: 150,
  commissionPct: 12,
  roadFactor: 1.3,
  geofenceMeters: 300,
  maxCancellations: 5,
  minWithdraw: 100,
  autoApproveCustomers: false,
  cancelPaidDriverPct: 10, cancelPaidPlatformPct: 5,
  cancelHeadingDriverPct: 30, cancelHeadingPlatformPct: 10,
  prepaidGraceMin: 30,
  offersEnabled: true,
  offerMinPct: 70,
  offerMaxPct: 200,
  dispatchRadiusKm: 25,
  dispatchMaxDrivers: 10,
  newDriver: { orders: 10, commissionPct: 5 },
  instapay: { handle: 'yourname@instapay', name: 'اسم صاحب الحساب' },
  categories: {
    furniture:   { ar: 'أثاث',              en: 'Furniture',          mult: 1.3 },
    electronics: { ar: 'أجهزة إلكترونية',   en: 'Electronics',        mult: 1.2 },
    goods:       { ar: 'بضاعة تجارية',      en: 'Commercial goods',   mult: 1.0 },
    building:    { ar: 'مواد بناء',         en: 'Building materials', mult: 1.5 },
    food:        { ar: 'مواد غذائية',       en: 'Food items',         mult: 1.1 },
    parcel:      { ar: 'طرود وتوصيل للمنازل', en: 'Parcels & home delivery', mult: 1.0 },
    other:       { ar: 'أخرى',              en: 'Other',              mult: 1.0 },
  },
  passengersEnabled: false,
  passengerClasses: {
    car:      { ar: 'سيارة (حتى 4 ركاب)',      en: 'Car (up to 4)',          mult: 1.0, seats: 4 },
    van:      { ar: 'فان (حتى 7 ركاب)',        en: 'Van (up to 7)',          mult: 1.3, seats: 7 },
    microbus: { ar: 'ميكروباص (حتى 14 راكب)',  en: 'Minibus (up to 14)',     mult: 1.8, seats: 14 },
    minibus:  { ar: 'ميني باص (حتى 28 راكب)',  en: 'Midi bus (up to 28)',    mult: 2.6, seats: 28 },
  },
  levelDiscountPct: { trusted: 1, pro: 2, elite: 3 },
  sizes: {
    small:  { ar: 'صغير (ربع نقل / سيارة)', en: 'Small (pickup / car)',  mult: 1.0 },
    medium: { ar: 'متوسط (نص نقل)',          en: 'Medium (half-ton)',     mult: 1.4 },
    large:  { ar: 'كبير (نقل ثقيل)',         en: 'Large (heavy truck)',   mult: 2.0 },
  },
};

const num = (v, d, min = 0, max = 1e9) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.min(max, Math.max(min, Number(v))) : d);

export async function loadSettings() {
  const snap = await settingsDoc.get();
  const d = snap.exists ? (snap.data().v || {}) : {};
  const D = DEFAULTS;
  return {
    perKm: num(d.perKm, D.perKm), minPrice: num(d.minPrice, D.minPrice),
    commissionPct: num(d.commissionPct, D.commissionPct, 0, 100), roadFactor: num(d.roadFactor, D.roadFactor, 1, 3),
    geofenceMeters: num(d.geofenceMeters, D.geofenceMeters, 0, 100000),
    maxCancellations: num(d.maxCancellations, D.maxCancellations, 1, 1000),
    minWithdraw: num(d.minWithdraw, D.minWithdraw, 1),
    autoApproveCustomers: d.autoApproveCustomers === true,
    prepaidGraceMin: Math.floor(num(d.prepaidGraceMin, D.prepaidGraceMin, 0, 1440)),
    ...(() => {
      const pair = (dk, pk) => { const dp = num(d[dk], D[dk], 0, 100); return [dp, Math.min(num(d[pk], D[pk], 0, 100), 100 - dp)]; };
      const [pd, pp] = pair('cancelPaidDriverPct', 'cancelPaidPlatformPct'), [hd, hp] = pair('cancelHeadingDriverPct', 'cancelHeadingPlatformPct');
      return { cancelPaidDriverPct: pd, cancelPaidPlatformPct: pp, cancelHeadingDriverPct: hd, cancelHeadingPlatformPct: hp };
    })(),
    offersEnabled: d.offersEnabled !== false, offerMinPct: num(d.offerMinPct, D.offerMinPct, 10, 100), offerMaxPct: num(d.offerMaxPct, D.offerMaxPct, 100, 1000),
    dispatchRadiusKm: num(d.dispatchRadiusKm, D.dispatchRadiusKm, 1, 500), dispatchMaxDrivers: Math.floor(num(d.dispatchMaxDrivers, D.dispatchMaxDrivers, 1, 20)),
    newDriver: { orders: num(d.newDriver?.orders, D.newDriver.orders, 0, 1000), commissionPct: num(d.newDriver?.commissionPct, D.newDriver.commissionPct, 0, 100) },
    instapay: { handle: d.instapay?.handle || D.instapay.handle, name: d.instapay?.name || D.instapay.name },
    categories: d.categories && Object.keys(d.categories).length ? d.categories : D.categories,
    sizes: d.sizes && Object.keys(d.sizes).length ? d.sizes : D.sizes,
    passengersEnabled: d.passengersEnabled === true,
    passengerClasses: d.passengerClasses && Object.keys(d.passengerClasses).length ? d.passengerClasses : D.passengerClasses,
    levelDiscountPct: { trusted: num(d.levelDiscountPct?.trusted, D.levelDiscountPct.trusted, 0, 50), pro: num(d.levelDiscountPct?.pro, D.levelDiscountPct.pro, 0, 50), elite: num(d.levelDiscountPct?.elite, D.levelDiscountPct.elite, 0, 50) },
  };
}

export function haversineM(a, b) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export async function distanceKm(a, b, settings) {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`, { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    if (j.code === 'Ok' && j.routes?.[0]?.distance > 0) return { km: Math.round(j.routes[0].distance / 100) / 10, source: 'osrm' };
  } catch { /* fallback below */ }
  return { km: Math.round((haversineM(a, b) * settings.roadFactor) / 100) / 10, source: 'estimate' };
}

export function calcPrice(s, km, category, size) {
  const c = s.categories[category], z = s.sizes[size];
  if (!c || !z) throw new HttpError(400, 'bad_category');
  const raw = s.perKm * km * Number(c.mult) * Number(z.mult);
  return { price: Math.max(Math.ceil(s.minPrice), Math.ceil(raw)), raw: Math.round(raw), catMult: Number(c.mult), sizeMult: Number(z.mult) };
}

export function split(amount, pct) {
  const commission = Math.round((amount * pct) / 100);
  return { commission, net: amount - commission };
}

export function sanitizeSettings(b) {
  const bad = () => new HttpError(400, 'bad_input');
  const n = (v, min, max) => { const x = Number(v); if (!Number.isFinite(x) || x < min || x > max) throw bad(); return x; };
  const table = (t, seats = false) => {
    if (!t || typeof t !== 'object') throw bad();
    const out = {};
    for (const [k, v] of Object.entries(t)) {
      if (!/^[a-z0-9_]{2,20}$/.test(k) || !v) throw bad();
      out[k] = { ar: String(v.ar || k).slice(0, 60), en: String(v.en || k).slice(0, 60), mult: n(v.mult, 0.1, 50) };
      if (seats) out[k].seats = Math.floor(n(v.seats, 1, 100));
    }
    if (!Object.keys(out).length || Object.keys(out).length > 30) throw bad();
    return out;
  };
  return {
    perKm: n(b.perKm, 0, 10000), minPrice: n(b.minPrice, 0, 1e6), commissionPct: n(b.commissionPct, 0, 100), roadFactor: n(b.roadFactor, 1, 3),
    geofenceMeters: n(b.geofenceMeters, 0, 100000), maxCancellations: Math.floor(n(b.maxCancellations, 1, 1000)), minWithdraw: Math.floor(n(b.minWithdraw, 1, 1e7)),
    autoApproveCustomers: b.autoApproveCustomers === true,
    prepaidGraceMin: Math.floor(n(b.prepaidGraceMin ?? 30, 0, 1440)),
    ...(() => {
      const one = (dk, pk, dd, pd) => { const dp = n(b[dk] ?? dd, 0, 100), pp = n(b[pk] ?? pd, 0, 100); if (dp + pp > 100) throw bad(); return { [dk]: dp, [pk]: pp }; };
      return { ...one('cancelPaidDriverPct', 'cancelPaidPlatformPct', 10, 5), ...one('cancelHeadingDriverPct', 'cancelHeadingPlatformPct', 30, 10) };
    })(),
    offersEnabled: b.offersEnabled !== false, offerMinPct: n(b.offerMinPct, 10, 100), offerMaxPct: n(b.offerMaxPct, 100, 1000),
    dispatchRadiusKm: n(b.dispatchRadiusKm, 1, 500), dispatchMaxDrivers: Math.floor(n(b.dispatchMaxDrivers, 1, 20)),
    newDriver: { orders: Math.floor(n(b.newDriver?.orders, 0, 1000)), commissionPct: n(b.newDriver?.commissionPct, 0, 100) },
    instapay: { handle: String(b.instapay?.handle || '').slice(0, 80), name: String(b.instapay?.name || '').slice(0, 80) },
    categories: table(b.categories), sizes: table(b.sizes),
    passengersEnabled: b.passengersEnabled === true, passengerClasses: table(b.passengerClasses ?? DEFAULTS.passengerClasses, true),
    levelDiscountPct: { trusted: n(b.levelDiscountPct?.trusted ?? 0, 0, 50), pro: n(b.levelDiscountPct?.pro ?? 0, 0, 50), elite: n(b.levelDiscountPct?.elite ?? 0, 0, 50) },
  };
}

const CARGO_CAP = { car: ['small'], van: ['small'], microbus: ['small'], minibus: [], pickup: ['small'], half_ton: ['small', 'medium'], truck: ['small', 'medium', 'large'] };
const PAX_CAP = { car: ['car'], van: ['car', 'van'], microbus: ['car', 'van', 'microbus'], minibus: ['car', 'van', 'microbus', 'minibus'] };
export function canServe(vehicleType, o) {
  if (o.service === 'passengers') {
    const cap = PAX_CAP[vehicleType];
    return !!cap && (!['car', 'van', 'microbus', 'minibus'].includes(o.vehicleClass) || cap.includes(o.vehicleClass));
  }
  const cap = CARGO_CAP[vehicleType];
  return !cap || !['small', 'medium', 'large'].includes(o.size) || cap.includes(o.size);
}

export function calcPassengerPrice(s, km, vehicleClass) {
  const c = s.passengerClasses[vehicleClass];
  if (!c) throw new HttpError(400, 'bad_category');
  const raw = s.perKm * km * Number(c.mult);
  return { price: Math.max(Math.ceil(s.minPrice), Math.ceil(raw)), raw: Math.round(raw), classMult: Number(c.mult), seats: c.seats };
}

/** driverRow = مستند users (camelCase) */
export function effectiveCommissionPct(s, basePct, driverRow) {
  let pct = Math.max(0, basePct - (s.levelDiscountPct[trustOf(driverRow || {}).level] || 0));
  if ((driverRow?.completedOrders || 0) < s.newDriver.orders) pct = Math.min(pct, s.newDriver.commissionPct);
  return pct;
}

export function cancelSplit(price, driverPct, platformPct) {
  const driver = Math.round((price * driverPct) / 100);
  const platform = Math.min(price - driver, Math.round((price * platformPct) / 100));
  return { driver, platform, refund: price - driver - platform };
}
