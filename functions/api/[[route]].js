// كل المنطق الحساس (الصلاحيات، السعر، Escrow، العمولة، المحفظة، النزاعات) بيتنفذ هنا على السيرفر (Cloudflare Pages Functions).
// البيانات في Firestore، والمتصفح مالوش وصول مباشر ليها: كل قراءة وكتابة بتعدّي من هنا وبتتفلتر حسب دور المستخدم.
import { HttpError, verifyIdToken, newId } from '../_lib/core.js';
import { F, now, rateLimit, walletCredit, walletTx, userOut, withdrawalOut, txOut, disputeOut, loadOrder, hydrateOrder, orderUpdate, orderOut } from '../_lib/db.js';
import { loadSettings, clearSettingsCache, sanitizeSettings, distanceKm, calcPrice, calcPassengerPrice, effectiveCommissionPct, canServe, cancelSplit, haversineM, split } from '../_lib/logic.js';
import { saveFile, ownFiles, readFile } from '../_lib/files.js';
import { notify, dispatchNewOrder, adminIds, orderNo, pushEnabled } from '../_lib/push.js';
import { trustOf } from '../_lib/trust.js';

// ---------- تحقق من المدخلات ----------
const str = (v, min, max, code = 'bad_input') => {
  const s = String(v ?? '').trim();
  if (s.length < min || s.length > max) throw new HttpError(400, code);
  return s;
};
const int = (v, min, max, code = 'bad_input') => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, code);
  return n;
};
const docId = (v) => { const s = String(v ?? ''); if (!/^[A-Za-z0-9]{10,40}$/.test(s)) throw new HttpError(400, 'bad_id'); return s; };
const uidOf = (v) => { const s = String(v ?? ''); if (!/^[A-Za-z0-9_-]{4,128}$/.test(s)) throw new HttpError(400, 'bad_id'); return s; };
const fileRef = (v) => { const s = String(v ?? ''); if (!/^fs:[A-Za-z0-9]{10,40}$/.test(s)) throw new HttpError(400, 'bad_file'); return s; };
const fileRefs = (arr, max, min = 0) => {
  if (!Array.isArray(arr) || arr.length > max || arr.length < min) throw new HttpError(400, 'bad_files');
  return arr.map(fileRef);
};
const point = (p, withAddress = true) => {
  const lat = Number(p?.lat), lng = Number(p?.lng);
  if (!(lat >= 21.5 && lat <= 32 && lng >= 24.5 && lng <= 37)) throw new HttpError(400, 'outside_egypt');
  return withAddress ? { lat, lng, address: str(p.address ?? '', 0, 200) } : { lat, lng };
};
const phoneOf = (v) => {
  let p = String(v ?? '').replace(/\D/g, '');
  if (p.startsWith('20') && p.length === 12) p = '0' + p.slice(2);
  if (!/^01[0125]\d{8}$/.test(p)) throw new HttpError(400, 'bad_phone');
  return p;
};
const L = (status, by, extra = {}) => ({ status, by, ...extra }); // سجل الحالات (دليل في النزاعات) — الوقت بيتضاف في orderUpdate

// معرّف العرض = رقم الطلب + "_" + uid السواق  (مستند واحد لكل سواق على كل طلب = منع تكرار العروض المعلّقة)
const offerKey = (orderId, uid) => `${orderId}_${uid}`;
const offerId = (v) => { const s = String(v ?? ''); const m = /^([A-Za-z0-9]{10,40})_([A-Za-z0-9_-]{4,128})$/.exec(s); if (!m) throw new HttpError(400, 'bad_id'); return { key: s, orderId: m[1], uid: m[2] }; };
const byDesc = (f) => (a, b) => (b[f] ?? 0) - (a[f] ?? 0);
const sha256hex = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const dayKey = (t) => new Date(t + 2 * 3600e3).toISOString().slice(0, 10); // يوم بتوقيت مصر (تقريباً)

// ---------- المستخدم الحالي ----------
async function need(c, roles) {
  const r = await F.get(c.env, `users/${c.uid}`);
  if (!r) throw new HttpError(403, 'no_profile');
  if (!roles.includes(r.role)) throw new HttpError(403, 'forbidden');
  if (r.status !== 'active') throw new HttpError(403, 'account_not_active');
  return userOut(r);
}
async function viewer(c) { // أي مستخدم مفعّل (أو أدمن) للقراءة
  const u = userOut(await F.get(c.env, `users/${c.uid}`));
  if (!u) throw new HttpError(403, 'no_profile');
  if (u.status !== 'active' && u.role !== 'admin') throw new HttpError(403, 'account_not_active');
  return u;
}

const REPORT_REASONS = ['abuse', 'harassment', 'unsafe', 'fraud', 'no_show', 'other'];
const CHAT_OPEN = ['accepted', 'payment_review', 'paid', 'heading_pickup', 'picked_up', 'in_transit', 'delivered', 'disputed']; // حالات يُسمح فيها بإرسال رسائل
const HELD = ['paid', 'heading_pickup', 'picked_up', 'in_transit', 'delivered'];
const ACTIVE = ['heading_pickup', 'picked_up', 'in_transit'];
const NEXT = { paid: 'heading_pickup', heading_pickup: 'picked_up', picked_up: 'in_transit', in_transit: 'delivered' };
// إرسال الإشعارات في الخلفية: ما بيبطّأش الرد، وأي فشل فيه ما بيكسّرش العملية الأساسية
const bg = (c, p) => { const safe = Promise.resolve(p).catch(() => {}); if (c.waitUntil) c.waitUntil(safe); return safe; };
// استرجاع واحد بس لكل طلب (معرّف المستند = رقم الطلب، و create بيفشل لو موجود = منع التكرار)
const refundInsert = (env, o, reason) => F.create(`refunds/${o.id}`, { id: o.id, order_id: o.id, customer_id: o.customerId, amount: o.price, reason, status: 'pending', created_at: now() });
const afterRefundRequest = (c, o) => {
  toAdmins(c, 'refund_due', { no: orderNo(o.id), amount: o.price }, '/#/admin/refunds');
  bg(c, notify(c.env, [o.customerId], 'refund_pending', { no: orderNo(o.id), amount: o.price }, { url: `/#/order/${o.id}` }));
};
/** طلب مدفوع مقدماً ماحدش قبله لحد ميعاده + المهلة: بيتلغي ويتسجّل استرجاع للعميل (بدون Cron: بيتنفذ عند القراءة) */
async function expireOrder(env, o) {
  try {
    await F.run(env, [
      ...orderUpdate(env, o, { status: 'cancelled', escrowStatus: 'refund_pending', cancelledBy: 'system', cancelReason: 'no_driver' }, L('cancelled', 'system', { note: 'expired_no_driver' })),
      refundInsert(env, o, 'no_driver'),
    ]);
  } catch (e) { if (e.code === 'conflict') return false; throw e; }
  await notify(env, [o.customerId], 'refund_pending', { no: orderNo(o.id), amount: o.price }, { url: `/#/order/${o.id}` });
  await notify(env, await adminIds(env), 'refund_due', { no: orderNo(o.id), amount: o.price }, { url: '/#/admin/refunds' });
  return true;
}
let lastSweep = 0;
async function sweepExpired(env) {
  if (Date.now() - lastSweep < Number(env.SWEEP_MIN_INTERVAL_MS ?? 30000)) return; // نفحص كل 30 ثانية كحد أقصى
  lastSweep = Date.now();
  const s = await loadSettings(env);
  const cutoff = now() - s.prepaidGraceMin * 60000;
  const rows = (await F.query(env, 'orders', { eq: { status: 'open', escrow_status: 'held' }, limit: 100 })).filter((r) => r.scheduled_at < cutoff).slice(0, 10);
  for (const r of rows) await expireOrder(env, hydrateOrder(r)).catch((e) => console.error('expire_failed', e?.message));
}
const toAdmins = (c, type, vars, url) => bg(c, (async () => notify(c.env, await adminIds(c.env), type, vars, { url }))());

// =====================================================================
const ROUTES = {
  // ---------- عام ----------
  async settings({ env }) { return { settings: await loadSettings(env) }; },
  async me({ env, uid }) {
    const r = await F.get(env, `users/${uid}`);
    const profile = userOut(r) || null;
    if (profile && profile.role === 'driver') { // مستوى السواق وتقدّمه وعمولته الحالية
      const s = await loadSettings(env);
      profile.trust = { ...trustOf(r), commissionPct: effectiveCommissionPct(s, s.commissionPct, r) };
    }
    return { profile };
  },

  // ---------- التسجيل: فحص القائمة السوداء + منع التكرار (مستندات uniq بـ create = مضمونة ضد السباق) ----------
  async register({ env, uid, token, body }) {
    if (await F.get(env, `users/${uid}`)) throw new HttpError(409, 'already_registered');
    const role = body.role;
    if (!['customer', 'driver'].includes(role)) throw new HttpError(400, 'bad_role');
    const phone = phoneOf(body.phone);
    const nid = String(body.nationalId ?? '').replace(/\D/g, '');
    if (!/^[23]\d{13}$/.test(nid)) throw new HttpError(400, 'bad_national_id');
    const name = str(body.name, 2, 80), area = str(body.area ?? '', 0, 60), lang = body.lang === 'en' ? 'en' : 'ar';
    const refs = { id: fileRef(body.idRef) }, driver = role === 'driver';
    let vehicleType = null;
    if (driver) {
      vehicleType = str(body.vehicleType, 2, 40);
      refs.license = fileRef(body.licenseRef); refs.vehicleReg = fileRef(body.vehicleRegRef); refs.vehiclePhoto = fileRef(body.vehiclePhotoRef);
    }
    await ownFiles(env, uid, Object.values(refs));
    if ((await F.getMany(env, 'blacklist', [`phone_${phone}`, `nid_${nid}`])).some(Boolean)) throw new HttpError(403, 'blacklisted');
    if ((await F.getMany(env, 'uniq', [`phone_${phone}`, `nid_${nid}`])).some(Boolean)) throw new HttpError(409, 'duplicate');
    const s = await loadSettings(env);
    const status = role === 'customer' && s.autoApproveCustomers ? 'active' : 'pending';
    const writes = [
      F.create(`users/${uid}`, {
        uid, role, status, status_reason: null, name, phone, email: token.email ?? null, national_id: nid, area, lang, id_ref: refs.id, license_ref: refs.license ?? null,
        vehicle_reg_ref: refs.vehicleReg ?? null, vehicle_photo_ref: refs.vehiclePhoto ?? null, vehicle_type: vehicleType, phone_verified: !!token.phone_number,
        rating_sum: 0, rating_count: 0, completed_orders: 0, cancel_count: 0, reviewed_by: null, reviewed_at: null, created_at: now(),
      }),
      F.create(`uniq/phone_${phone}`, { uid }), F.create(`uniq/nid_${nid}`, { uid }),
    ];
    if (driver) writes.push(F.create(`wallets/${uid}`, { uid, balance: 0, total_earned: 0, updated_at: now() }));
    try { await F.run(env, writes); } catch (e) { if (e.code === 'conflict') throw new HttpError(409, 'duplicate'); throw e; }
    return { ok: true, status };
  },

  // ---------- عرض سعر ----------
  async quote(c) {
    await need(c, ['customer']);
    const s = await loadSettings(c.env);
    const a = point(c.body.pickup, false), b = point(c.body.dropoff, false);
    const d = await distanceKm(a, b, s);
    if (c.body.service === 'passengers') {
      if (!s.passengersEnabled) throw new HttpError(403, 'service_disabled');
      return { distanceKm: d.km, source: d.source, ...calcPassengerPrice(s, Math.max(d.km, 0.5), c.body.vehicleClass) };
    }
    return { distanceKm: d.km, source: d.source, ...calcPrice(s, Math.max(d.km, 0.5), c.body.category, c.body.size) };
  },

  // ---------- الملفات ----------
  async 'files/upload'(c) {
    const profile = userOut(await F.get(c.env, `users/${c.uid}`));
    return { ref: await saveFile(c.env, c.uid, profile, c.body.kind, c.body.data) };
  },

  // ---------- الطلبات: قراءة ----------
  async 'orders/list'(c) {
    const u = await viewer(c);
    bg(c, sweepExpired(c.env)); // إنهاء الطلبات المدفوعة مقدماً اللي ماحدش قبلها (واسترجاعها)
    let rows;
    if (u.role === 'customer') rows = (await F.query(c.env, 'orders', { eq: { customer_id: c.uid }, limit: 100 })).sort(byDesc('created_at'));
    else if (u.role === 'driver') {
      rows = c.body.scope === 'mine'
        ? (await F.query(c.env, 'orders', { eq: { driver_id: c.uid }, limit: 100 })).sort(byDesc('updated_at'))
        : (await F.query(c.env, 'orders', { eq: { status: 'open' }, limit: 100 })).sort(byDesc('created_at'));
    } else {
      const status = c.body.status ? String(c.body.status) : null, lim = int(c.body.limit ?? 200, 1, 300);
      rows = status ? (await F.query(c.env, 'orders', { eq: { status }, limit: lim })).sort(byDesc('created_at'))
        : await F.query(c.env, 'orders', { order: ['created_at', 'desc'], limit: lim });
    }
    const out = rows.map((r) => orderOut(hydrateOrder(r), u, { brief: true }));
    if (u.role === 'customer') { // عدد العروض المعلّقة على كل طلب مفتوح
      const open = out.filter((o) => o.status === 'open').map((o) => o.id);
      if (open.length) {
        const m = {};
        for (const f of await F.query(c.env, 'offers', { inn: { order_id: open } })) if (f.status === 'pending') m[f.order_id] = (m[f.order_id] || 0) + 1;
        out.forEach((o) => { o.offerCount = m[o.id] || 0; });
      }
    }
    return { orders: out };
  },

  async 'orders/get'(c) {
    const u = await viewer(c);
    let o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.status === 'open' && o.escrowStatus === 'held') { // انتهى ميعاده وماحدش قبله؟ نرجّع الفلوس دلوقتي
      const st_ = await loadSettings(c.env);
      if (o.scheduledAt < now() - st_.prepaidGraceMin * 60000 && (await expireOrder(c.env, o).catch(() => false))) o = await loadOrder(c.env, o.id);
    }
    const allowed = u.role === 'admin' || o.customerId === c.uid || o.driverId === c.uid || (u.role === 'driver' && o.status === 'open');
    if (!allowed) throw new HttpError(403, 'forbidden');
    let location = null;
    if (ACTIVE.includes(o.status) && u.role !== 'driver') {
      const l = await F.get(c.env, `live_locations/${o.id}`);
      if (l) location = { lat: l.lat, lng: l.lng, at: l.at };
    }
    const out = orderOut(o, u);
    if (o.status === 'open') {
      if (u.role === 'customer' || u.role === 'admin') { // العميل يشوف العروض (بدون رقم السواق لحد ما يقبل)
        const offs = (await F.query(c.env, 'offers', { eq: { order_id: o.id }, limit: 60 })).filter((f) => f.status === 'pending').sort((a, b) => a.price - b.price).slice(0, 30);
        const ds = await F.getMany(c.env, 'users', offs.map((f) => f.driver_id));
        out.offers = offs.map((f, i) => ({ f, d: ds[i] })).filter((x) => x.d).map(({ f, d }) => ({
          id: f.id, price: f.price, note: f.note, createdAt: f.created_at, driverName: d.name, vehicleType: d.vehicle_type, ratingSum: d.rating_sum, ratingCount: d.rating_count,
          completedOrders: d.completed_orders, trust: trustOf(d),
        }));
      } else if (u.role === 'driver') {
        const f = await F.get(c.env, `offers/${offerKey(o.id, c.uid)}`);
        out.myOffer = f ? { id: f.id, price: f.price, note: f.note, status: f.status } : null;
      }
    }
    if (o.driverId && (u.role === 'customer' || u.role === 'admin')) { // العميل يشوف مستوى وشارات سواق طلبه
      const d = await F.get(c.env, `users/${o.driverId}`);
      if (d) out.driverTrust = trustOf(d);
    }
    if (u.role === 'customer' || u.role === 'admin') { // حالة الاسترجاع
      const rf = await F.get(c.env, `refunds/${o.id}`);
      if (rf) out.refund = { status: rf.status, amount: rf.amount, reason: rf.reason };
    }
    if (o.driverId && (u.role === 'admin' || o.customerId === c.uid || o.driverId === c.uid)) { // مؤشر الشات
      const m = await F.get(c.env, `chatmeta/${o.id}`);
      out.chat = { count: m?.n || 0, lastAt: m?.at ?? null };
    }
    return { order: out, location };
  },

  // السواق بيبعت موقعه (الواجهة بتبعته كل ~15 ثانية)
  async 'orders/location'(c) {
    await need(c, ['driver']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.driverId !== c.uid || !ACTIVE.includes(o.status)) throw new HttpError(403, 'forbidden');
    const p = point(c.body, false);
    await F.run(c.env, [F.patch(`live_locations/${o.id}`, { order_id: o.id, lat: p.lat, lng: p.lng, acc: int(c.body.acc ?? 0, 0, 100000), at: now() })]);
    return { ok: true };
  },

  // ---------- إنشاء طلب ----------
  async 'orders/create'(c) {
    const u = await need(c, ['customer']);
    const s = await loadSettings(c.env), b = c.body;
    const mineOpen = (await F.query(c.env, 'orders', { eq: { customer_id: c.uid }, limit: 100 })).filter((r) => ['open', 'accepted', 'payment_review', 'awaiting_payment'].includes(r.status)).length;
    if (mineOpen >= 10) throw new HttpError(429, 'too_many_open');
    const trip = b.service === 'passengers'; // نقل ركاب (مقفول افتراضياً) أو شحن بضاعة/توصيل
    if (trip && !s.passengersEnabled) throw new HttpError(403, 'service_disabled');
    const pickup = point(b.pickup), dropoff = point(b.dropoff);
    const photos = fileRefs(b.photos ?? [], 5, trip ? 0 : 1);
    await ownFiles(c.env, c.uid, photos);
    const d = await distanceKm(pickup, dropoff, s), km = Math.max(d.km, 0.5);
    let price, spec;
    if (trip) {
      const cls = s.passengerClasses[b.vehicleClass];
      if (!cls) throw new HttpError(400, 'bad_category');
      ({ price } = calcPassengerPrice(s, km, b.vehicleClass));
      spec = { service: 'passengers', vehicleClass: b.vehicleClass, passengers: int(b.passengers, 1, cls.seats, 'bad_passengers') };
    } else {
      ({ price } = calcPrice(s, km, b.category, b.size));
      spec = { service: 'cargo', category: b.category, size: b.size, weightKg: int(b.weightKg, 1, 50000) };
    }
    const when = new Date(b.scheduledAt);
    if (isNaN(when) || when.getTime() < Date.now() - 3600e3) throw new HttpError(400, 'bad_date');
    const id = newId(), t = now();
    const prepay = trip || b.prepay === true, first = prepay ? 'awaiting_payment' : 'open'; // الركاب دايماً دفع مقدم؛ البضاعة باختيار العميل
    const data = {
      customerName: u.name, customerPhone: u.phone, ...spec,
      description: str(b.description ?? '', 0, 500), photos, pickup, dropoff, distanceKm: d.km, distanceSource: d.source,
      priceOriginal: price, instant: prepay ? true : b.instant !== false, payMode: prepay ? 'before' : 'after', commissionPct: s.commissionPct, log: [{ ...L(first, c.uid), at: t }],
    };
    await F.run(c.env, [
      F.create(`orders/${id}`, { id, customer_id: c.uid, driver_id: null, status: first, escrow_status: 'none', price, commission: null, driver_net: null, customer_refund: null, scheduled_at: when.getTime(), created_at: t, updated_at: t, version: 1, data: JSON.stringify(data) }),
      F.inc(`daily/${dayKey(t)}`, { n: 1 }, { day: dayKey(t) }), // عدّاد يومي للإحصائيات (من غير ما نقرا كل الطلبات)
    ]);
    if (!prepay) bg(c, dispatchNewOrder(c.env, { id, ...spec, pickup, dropoff, price }, s)); // المدفوع مقدماً بيتبعت للسواقين بعد تأكيد الدفع
    return { id, price, prepay };
  },

  // ---------- السواق يقبل (أول واحد يكسب: شرط النسخة بيفشّل التاني) ----------
  async 'orders/accept'(c) {
    const u = await need(c, ['driver']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.status !== 'open') throw new HttpError(409, 'order_not_open');
    if (o.instant === false) throw new HttpError(409, 'offers_only'); // العميل اختار يستقبل عروض أسعار بدل القبول الفوري
    if (o.service === 'passengers' && !canServe(u.vehicleType, o)) throw new HttpError(403, 'vehicle_mismatch'); // ركاب: لازم عربية ركاب مناسبة (أمان)
    const prepaid = o.escrowStatus === 'held'; // مدفوع مقدماً: السواق يبدأ فوراً (الحالة paid)
    const pend = (await F.query(c.env, 'offers', { eq: { order_id: o.id }, limit: 100 })).filter((f) => f.status === 'pending');
    await F.run(c.env, [
      ...orderUpdate(c.env, o, { status: prepaid ? 'paid' : 'accepted', driverId: c.uid, driverName: u.name, driverPhone: u.phone, driverVehicle: u.vehicleType, acceptedAt: now() }, L(prepaid ? 'paid' : 'accepted', c.uid, prepaid ? { note: 'accepted_prepaid' } : {})),
      ...pend.map((f) => F.patch(`offers/${f._id}`, { status: f.driver_id === c.uid ? 'withdrawn' : 'rejected', updated_at: now() })),
    ]);
    bg(c, notify(c.env, [o.customerId], prepaid ? 'accepted_prepaid' : 'accepted', { driver: u.name, no: orderNo(o.id) }, { url: `/#/order/${o.id}` }));
    return { ok: true };
  },

  // ---------- عروض الأسعار: السعر اقتراحي من الموقع، والسواق يقدر يقترح سعر مختلف، والعميل يختار ----------
  async 'offers/create'(c) {
    const u = await need(c, ['driver']);
    const s = await loadSettings(c.env);
    if (!s.offersEnabled) throw new HttpError(403, 'offers_disabled');
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.status !== 'open') throw new HttpError(409, 'order_not_open');
    if (o.escrowStatus === 'held' || o.payMode === 'before') throw new HttpError(409, 'prepaid_fixed'); // السعر ثابت لأنه اتدفع مقدماً
    if (o.service === 'passengers' && !canServe(u.vehicleType, o)) throw new HttpError(403, 'vehicle_mismatch');
    const lo = Math.max(Math.ceil(s.minPrice), Math.ceil((o.price * s.offerMinPct) / 100)), hi = Math.ceil((o.price * s.offerMaxPct) / 100);
    const price = int(c.body.price, lo, hi, 'offer_out_of_range');
    const note = str(c.body.note ?? '', 0, 200);
    const key = offerKey(o.id, c.uid), mine = await F.get(c.env, `offers/${key}`), t = now();
    await F.run(c.env, [
      F.guard({ _ut: o._ut }, `orders/${o.id}`), // لو الطلب اتغيّر (اتقبل/اتلغى) في نفس اللحظة العملية تفشل
      mine && mine.status === 'pending' ? F.patch(`offers/${key}`, { price, note, updated_at: t }, mine._ut)
        : F.set(`offers/${key}`, { id: key, order_id: o.id, driver_id: c.uid, price, note, status: 'pending', created_at: t, updated_at: t }),
    ]);
    bg(c, notify(c.env, [o.customerId], 'offer', { price, no: orderNo(o.id), driver: u.name }, { url: `/#/order/${o.id}`, tag: 'offer-' + o.id }));
    return { ok: true, min: lo, max: hi };
  },
  async 'offers/withdraw'(c) {
    await need(c, ['driver']);
    const f = await F.get(c.env, `offers/${offerKey(docId(c.body.orderId), c.uid)}`);
    if (!f || f.status !== 'pending') throw new HttpError(409, 'bad_state');
    await F.run(c.env, [F.patch(`offers/${f._id}`, { status: 'withdrawn', updated_at: now() }, f._ut)]);
    return { ok: true };
  },
  async 'offers/accept'(c) {
    await need(c, ['customer']);
    const f = await F.get(c.env, `offers/${offerId(c.body.offerId).key}`);
    if (!f) throw new HttpError(404, 'not_found');
    if (f.status !== 'pending') throw new HttpError(409, 'bad_state');
    const o = await loadOrder(c.env, f.order_id);
    if (o.customerId !== c.uid) throw new HttpError(403, 'forbidden');
    if (o.status !== 'open') throw new HttpError(409, 'order_not_open');
    const d = await F.get(c.env, `users/${f.driver_id}`);
    if (!d || d.role !== 'driver' || d.status !== 'active') throw new HttpError(409, 'driver_unavailable');
    const others = (await F.query(c.env, 'offers', { eq: { order_id: o.id }, limit: 100 })).filter((r) => r.status === 'pending' && r._id !== f._id);
    await F.run(c.env, [
      F.patch(`offers/${f._id}`, { status: 'accepted', updated_at: now() }, f._ut), // شرط: العرض لسه معلّق
      ...orderUpdate(c.env, o, { status: 'accepted', driverId: d.uid, driverName: d.name, driverPhone: d.phone, driverVehicle: d.vehicle_type, acceptedAt: now(), price: f.price, priceNegotiated: true }, L('accepted', c.uid, { note: 'offer', price: f.price })),
      ...others.map((r) => F.patch(`offers/${r._id}`, { status: 'rejected', updated_at: now() })),
    ]);
    bg(c, notify(c.env, [d.uid], 'offer_accepted', { price: f.price, no: orderNo(o.id) }, { url: `/#/order/${o.id}` }));
    bg(c, notify(c.env, others.map((r) => r.driver_id), 'offer_rejected', { no: orderNo(o.id) }, { url: '/#/driver' }));
    return { ok: true };
  },
  async 'offers/reject'(c) {
    await need(c, ['customer']);
    const f = await F.get(c.env, `offers/${offerId(c.body.offerId).key}`);
    if (!f) throw new HttpError(404, 'not_found');
    const ord = await F.get(c.env, `orders/${f.order_id}`);
    if (f.status !== 'pending' || !ord || ord.customer_id !== c.uid) throw new HttpError(409, 'bad_state');
    await F.run(c.env, [F.patch(`offers/${f._id}`, { status: 'rejected', updated_at: now() }, f._ut)]);
    bg(c, notify(c.env, [f.driver_id], 'offer_rejected', { no: orderNo(f.order_id) }, { url: '/#/driver' }));
    return { ok: true };
  },

  // ---------- "متاح لاستقبال الطلبات" (زي أوبر) + آخر موقع معروف ----------
  async 'driver/presence'(c) {
    await need(c, ['driver']);
    if (c.body.online === undefined) {
      const r = await F.get(c.env, `driver_presence/${c.uid}`);
      return { online: !!r?.online, seenAt: r?.seen_at || null };
    }
    const online = c.body.online === true;
    const data = { uid: c.uid, online, seen_at: now() };
    if (c.body.lat != null) { const p = point(c.body, false); data.lat = p.lat; data.lng = p.lng; } // من غير إحداثيات: بنحتفظ بآخر موقع معروف
    await F.run(c.env, [F.patch(`driver_presence/${c.uid}`, data)]);
    return { online };
  },

  // ---------- أجهزة الإشعارات (معرّف المستند = SHA-256 للتوكن عشان طوله وحروفه) ----------
  async 'push/register'(c) {
    if (!(await F.get(c.env, `users/${c.uid}`))) throw new HttpError(403, 'no_profile');
    const token = str(c.body.token, 20, 4096), ua = (c.request?.headers.get('user-agent') || '').slice(0, 120), h = await sha256hex(token), t = now();
    await F.run(c.env, [F.patch(`push_tokens/${h}`, { token, uid: c.uid, ua, created_at: t, last_seen: t })]);
    const mine = (await F.query(c.env, 'push_tokens', { eq: { uid: c.uid }, limit: 50 })).sort(byDesc('last_seen')).slice(5); // 5 أجهزة كحد أقصى للمستخدم
    if (mine.length) await F.run(c.env, mine.map((r) => F.del(`push_tokens/${r._id}`)));
    return { ok: true, push: pushEnabled(c.env) };
  },
  async 'push/unregister'(c) {
    const r = await F.get(c.env, `push_tokens/${await sha256hex(str(c.body.token, 20, 4096))}`);
    if (r && r.uid === c.uid) await F.run(c.env, [F.del(`push_tokens/${r._id}`)]);
    return { ok: true };
  },

  // ---------- العميل يرفع إثبات التحويل (InstaPay) ----------
  async 'orders/pay'(c) {
    await need(c, ['customer']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.customerId !== c.uid) throw new HttpError(403, 'forbidden');
    if (o.status !== (o.payMode === 'before' ? 'awaiting_payment' : 'accepted')) throw new HttpError(409, 'bad_state');
    const proof = fileRef(c.body.proofRef); await ownFiles(c.env, c.uid, [proof]);
    await F.run(c.env, orderUpdate(c.env, o, { status: 'payment_review', paymentProof: proof, paymentRef: str(c.body.reference ?? '', 0, 40), paymentSubmittedAt: now(), paymentRejectReason: null }, L('payment_review', c.uid)));
    toAdmins(c, 'proof', { no: orderNo(o.id) }, '/#/admin/payments');
    return { ok: true };
  },

  // ---------- السواق يغيّر حالة التنفيذ (صورة + فحص GPS) ----------
  async 'orders/status'(c) {
    await need(c, ['driver']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.driverId !== c.uid) throw new HttpError(403, 'forbidden');
    const next = NEXT[o.status];
    if (!next || c.body.next !== next) throw new HttpError(409, 'bad_state');
    const s = await loadSettings(c.env);
    const patch = { status: next }; let loc = null;
    if (c.body.loc) loc = point(c.body.loc, false);
    const target = next === 'picked_up' ? o.pickup : next === 'delivered' ? o.dropoff : null;
    if (target) {
      if (o.service !== 'passengers' || c.body.photoRef) { // صورة إجبارية للبضاعة، واختيارية في رحلات الركاب
        const photo = fileRef(c.body.photoRef); await ownFiles(c.env, c.uid, [photo]);
        patch[next === 'picked_up' ? 'pickupPhoto' : 'deliveryPhoto'] = photo;
      }
      patch[next === 'picked_up' ? 'pickedUpAt' : 'deliveredAt'] = now();
      if (s.geofenceMeters > 0) {
        if (!loc) throw new HttpError(400, 'location_required');
        if (haversineM(loc, target) > s.geofenceMeters) throw new HttpError(403, 'too_far');
      }
    }
    await F.run(c.env, orderUpdate(c.env, o, patch, L(next, c.uid, loc ? { lat: loc.lat, lng: loc.lng } : {})));
    bg(c, notify(c.env, [o.customerId], o.service === 'passengers' ? `${next}_p` : next, { no: orderNo(o.id) }, { url: `/#/order/${o.id}` }));
    return { ok: true, status: next };
  },

  // ---------- العميل يأكد الاستلام => تحرير الـ Escrow وخصم العمولة وتحويل الباقي لمحفظة السواق ----------
  async 'orders/confirm'(c) {
    await need(c, ['customer']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.customerId !== c.uid) throw new HttpError(403, 'forbidden');
    if (o.status !== 'delivered' || o.escrowStatus !== 'held') throw new HttpError(409, 'bad_state');
    const s = await loadSettings(c.env);
    const driver = await F.get(c.env, `users/${o.driverId}`);
    const pct = effectiveCommissionPct(s, o.commissionPct, driver); // خصم مستوى الثقة + عمولة السواق الجديد
    const { commission, net } = split(o.price, pct);
    await F.run(c.env, [
      ...orderUpdate(c.env, o, { status: 'completed', escrowStatus: 'released', commission, driverNet: net, commissionPctApplied: pct, completedAt: now() }, L('completed', c.uid)),
      walletCredit(o.driverId, net),
      walletTx({ uid: o.driverId, type: 'earning', orderId: o.id, amount: net, gross: o.price, commission }),
      F.inc(`users/${o.driverId}`, { completed_orders: 1 }), F.inc(`users/${o.customerId}`, { completed_orders: 1 }),
    ]);
    bg(c, notify(c.env, [o.driverId], 'completed', { net, no: orderNo(o.id) }, { url: '/#/driver/wallet' }));
    return { ok: true, net, commission };
  },

  // ---------- إلغاء ----------
  async 'orders/cancel'(c) {
    const me = await need(c, ['customer', 'driver']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    const s = await loadSettings(c.env);
    const reason = str(c.body.reason ?? '', 0, 200);
    const asCustomer = o.customerId === c.uid, asDriver = o.driverId === c.uid;
    const held = o.escrowStatus === 'held'; // المبلغ محجوز (مدفوع)
    // زيادة عدّاد الإلغاء وتجميد الحساب تلقائياً عند الوصول للحد
    const cancelCount = () => F.inc(`users/${c.uid}`, { cancel_count: 1 }, (me.cancelCount || 0) + 1 >= s.maxCancellations ? { status: 'suspended', status_reason: 'auto_cancellations' } : {});

    // (1) العميل بعد قبول سواق على طلب مدفوع: إلغاء برسوم — نسبة تعويض للسواق + نسبة للمنصة + الباقي للعميل (النسب من الأدمن)
    if (asCustomer && held && ['paid', 'heading_pickup'].includes(o.status)) {
      const heading = o.status === 'heading_pickup';
      const dp = heading ? s.cancelHeadingDriverPct : s.cancelPaidDriverPct, pp = heading ? s.cancelHeadingPlatformPct : s.cancelPaidPlatformPct;
      const { driver, platform, refund: back } = cancelSplit(o.price, dp, pp);
      const stmts = [
        ...orderUpdate(c.env, o, { status: 'cancelled', escrowStatus: 'settled', cancelledBy: 'customer', cancelReason: reason, commission: platform, driverNet: driver, customerRefund: back, cancelFee: { driverPct: dp, platformPct: pp } }, L('cancelled', c.uid, { note: 'cancel_after_accept', reason })),
        cancelCount(),
      ];
      if (driver > 0) stmts.push(walletCredit(o.driverId, driver), walletTx({ uid: o.driverId, type: 'cancel_compensation', orderId: o.id, amount: driver, gross: o.price, commission: platform }));
      if (back > 0) stmts.push(refundInsert(c.env, { ...o, price: back }, 'cancelled_after_accept'));
      await F.run(c.env, stmts);
      bg(c, notify(c.env, [o.driverId], driver > 0 ? 'cancel_comp' : 'cancel_plain', { no: orderNo(o.id), amount: driver }, { url: '/#/driver/wallet' }));
      if (back > 0) afterRefundRequest(c, { ...o, price: back });
      return { ok: true, fee: driver + platform, driver, platform, refund: back };
    }

    let patch, status, counts = false, refund = false;
    if (asCustomer && ['open', 'accepted', 'awaiting_payment'].includes(o.status)) {
      refund = o.status === 'open' && held; // مدفوع مقدماً وماحدش قبله => استرجاع كامل
      patch = { status: 'cancelled', cancelledBy: 'customer', cancelReason: reason, ...(refund ? { escrowStatus: 'refund_pending' } : {}) }; status = 'cancelled'; counts = o.status === 'accepted';
    } else if (asDriver && ['accepted', 'paid', 'heading_pickup'].includes(o.status)) {
      // السواق اعتذر: الطلب بيرجع مفتوح لسواقين تانيين (ولو مدفوع، المبلغ بيفضل محجوز) وبيتحسب عليه إلغاء
      patch = { status: 'open', driverId: null, driverName: null, driverPhone: null, driverVehicle: null, acceptedAt: null, ...(held ? { instant: true } : {}) }; status = 'open'; counts = true;
    } else throw new HttpError(409, 'cannot_cancel'); // بعد الاستلام: يتم فتح نزاع
    const stmts = orderUpdate(c.env, o, patch, L(status, c.uid, asDriver ? { note: 'driver_cancelled', reason } : { reason }));
    if (refund) stmts.push(refundInsert(c.env, o, 'cancelled'));
    if (status === 'cancelled') for (const f of (await F.query(c.env, 'offers', { eq: { order_id: o.id }, limit: 100 })).filter((r) => r.status === 'pending')) stmts.push(F.patch(`offers/${f._id}`, { status: 'rejected', updated_at: now() }));
    if (counts) stmts.push(cancelCount());
    await F.run(c.env, stmts);
    if (refund) afterRefundRequest(c, o);
    if (asDriver && held) { // الطلب المدفوع رجع مفتوح: نبلّغ العميل ونعيد توزيعه على سواقين تانيين
      bg(c, notify(c.env, [o.customerId], 'driver_cancelled', { no: orderNo(o.id) }, { url: `/#/order/${o.id}` }));
      bg(c, dispatchNewOrder(c.env, { id: o.id, service: o.service, size: o.size, vehicleClass: o.vehicleClass, passengers: o.passengers, pickup: o.pickup, dropoff: o.dropoff, price: o.price }, s));
    }
    return { ok: true, refund };
  },

  // ---------- تقييم ----------
  async 'orders/rate'(c) {
    await need(c, ['customer', 'driver']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.status !== 'completed') throw new HttpError(409, 'bad_state');
    const asCustomer = o.customerId === c.uid;
    if (!asCustomer && o.driverId !== c.uid) throw new HttpError(403, 'forbidden');
    const field = asCustomer ? 'rateByCustomer' : 'rateByDriver';
    if (o[field]) throw new HttpError(409, 'already_rated');
    const stars = int(c.body.stars, 1, 5);
    await F.run(c.env, [
      ...orderUpdate(c.env, o, { [field]: { stars, comment: str(c.body.comment ?? '', 0, 300), at: now() } }),
      F.inc(`users/${asCustomer ? o.driverId : o.customerId}`, { rating_sum: stars, rating_count: 1 }),
    ]);
    return { ok: true };
  },

  // ---------- المحفظة والسحب ----------
  async wallet(c) {
    await need(c, ['driver']);
    const [w, tx, wd] = await Promise.all([
      F.get(c.env, `wallets/${c.uid}`),
      F.query(c.env, `wallets/${c.uid}/tx`, { order: ['at', 'desc'], limit: 40 }),
      F.query(c.env, 'withdrawals', { eq: { uid: c.uid }, limit: 100 }),
    ]);
    return { wallet: { balance: w?.balance || 0, totalEarned: w?.total_earned || 0 }, tx: tx.map(txOut), withdrawals: wd.sort(byDesc('created_at')).slice(0, 40).map(withdrawalOut) };
  },

  // بيخصم من المحفظة فوراً ويحجز المبلغ لحد قرار الأدمن. شرط النسخة على المحفظة بيمنع السحب المزدوج.
  async 'withdrawals/create'(c) {
    const u = await need(c, ['driver']);
    const s = await loadSettings(c.env);
    const amount = int(c.body.amount, s.minWithdraw, 10000000, 'below_min');
    const method = c.body.method;
    if (!['instapay', 'vodafone', 'bank'].includes(method)) throw new HttpError(400, 'bad_method');
    const account = str(c.body.account, 5, 60), id = newId();
    const w = await F.get(c.env, `wallets/${c.uid}`);
    if (!w || (w.balance || 0) < amount) throw new HttpError(400, 'insufficient_balance');
    try {
      await F.run(c.env, [
        F.inc(`wallets/${c.uid}`, { balance: -amount }, { updated_at: now() }, w._ut), // لو الرصيد اتغيّر بعد القراءة => تفشل
        F.create(`withdrawals/${id}`, { id, uid: c.uid, name: u.name, phone: u.phone, amount, method, account, status: 'pending', note: null, created_at: now(), decided_at: null, decided_by: null }),
        walletTx({ uid: c.uid, type: 'withdrawal', amount: -amount, withdrawalId: id }),
      ]);
    } catch (e) { throw e.code === 'conflict' ? new HttpError(400, 'insufficient_balance') : e; }
    return { ok: true, id };
  },

  // ---------- نزاع ----------
  async 'disputes/create'(c) {
    await need(c, ['customer', 'driver']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    const asCustomer = o.customerId === c.uid;
    if (!asCustomer && o.driverId !== c.uid) throw new HttpError(403, 'forbidden');
    if (!HELD.includes(o.status)) throw new HttpError(409, 'bad_state'); // الفلوس لسه محجوزة
    if (!['damaged', 'delay', 'not_as_described', 'payment', 'no_show', 'other'].includes(c.body.reason)) throw new HttpError(400, 'bad_reason');
    const evidence = fileRefs(c.body.evidence ?? [], 5); await ownFiles(c.env, c.uid, evidence);
    const id = newId();
    await F.run(c.env, [
      ...orderUpdate(c.env, o, { status: 'disputed', prevStatus: o.status, disputeId: id }, L('disputed', c.uid)),
      F.create(`disputes/${id}`, {
        id, order_id: o.id, customer_id: o.customerId, driver_id: o.driverId, opened_by: c.uid, opened_by_role: asCustomer ? 'customer' : 'driver', reason: c.body.reason,
        details: str(c.body.details ?? '', 0, 1000), evidence: JSON.stringify(evidence), order_price: o.price, status: 'open', decision: null, customer_pct: null,
        customer_refund: null, driver_net: null, commission: null, note: null, refund_paid: false, created_at: now(), resolved_at: null, resolved_by: null,
      }),
    ]);
    toAdmins(c, 'dispute', { no: orderNo(o.id) }, '/#/admin/disputes');
    bg(c, notify(c.env, [asCustomer ? o.driverId : o.customerId], 'dispute', { no: orderNo(o.id) }, { url: `/#/order/${o.id}` }));
    return { ok: true, id };
  },

  // =====================  الأدمن  =====================
  // أرقام الشارات: تجميع count (بيتحسب قراءة واحدة لكل 1000 مستند) — بتتسحب كل ~30 ثانية
  async 'admin/badges'(c) {
    await need(c, ['admin']);
    const n = (col, status) => F.count(c.env, col, { eq: { status } });
    const [payments, users, withdrawals, disputes, refunds, rep, sos] = await Promise.all([
      n('orders', 'payment_review'), n('users', 'pending'), n('withdrawals', 'pending'), n('disputes', 'open'), n('refunds', 'pending'), n('reports', 'open'), n('sos_events', 'open'),
    ]);
    return { badges: { payments, users, withdrawals, disputes, refunds, reports: rep + sos } };
  },

  // إحصائيات على كل الطلبات بتجميع Firestore (count/sum) من غير قراءة المستندات. اليومي من عدّادات daily.
  async 'admin/stats'(c) {
    await need(c, ['admin']);
    const E = c.env, TERMINAL = ['completed', 'cancelled', 'resolved'];
    const days = Array.from({ length: 15 }, (_, i) => dayKey(now() - (14 - i) * 86400e3));
    const [total, terminal, rev, held, drivers, customers, top, daily, refunds] = await Promise.all([
      F.count(E, 'orders'),
      F.count(E, 'orders', { inn: { status: TERMINAL } }),
      F.aggregate(E, 'orders', { inn: { escrow_status: ['released', 'settled'] } }, { price: ['sum', 'price'], refund: ['sum', 'customer_refund'], commission: ['sum', 'commission'] }),
      F.aggregate(E, 'orders', { eq: { escrow_status: 'held' } }, { price: ['sum', 'price'] }),
      F.count(E, 'users', { eq: { status: 'active', role: 'driver' } }),
      F.count(E, 'users', { eq: { status: 'active', role: 'customer' } }),
      F.query(E, 'users', { order: ['completed_orders', 'desc'], limit: 40 }),
      F.getMany(E, 'daily', days),
      F.aggregate(E, 'refunds', { eq: { status: 'pending' } }, { n: ['sum', 'amount'] }),
    ]);
    const tops = top.filter((u) => u.role === 'driver' && u.completed_orders > 0).slice(0, 5);
    const ws = await F.getMany(E, 'wallets', tops.map((u) => u.uid));
    return {
      totals: { total, active: total - terminal, revenue: rev.price - rev.refund, commission: rev.commission, held: held.price },
      activeDrivers: drivers, activeCustomers: customers,
      topDrivers: tops.map((u, i) => ({ name: u.name, n: u.completed_orders, earned: ws[i]?.total_earned || 0 })), // "earned" = إجمالي ربح المحفظة
      perDay: daily.map((r, i) => (r && r.n > 0 ? { d: days[i], n: r.n } : null)).filter(Boolean),
      refundsDue: refunds.n,
    };
  },

  async 'admin/users'(c) {
    await need(c, ['admin']);
    const role = ['customer', 'driver'].includes(c.body.role) ? c.body.role : null, status = c.body.status ? String(c.body.status) : null;
    const base = role ? { role } : {};
    // بنجيب المعلّقين الأول (عشان ما يضيعوش وسط القائمة) + الأحدث، وبنفلتر البحث في الذاكرة (Firestore مفيهوش LIKE)
    const lists = status ? [await F.query(c.env, 'users', { eq: { ...base, status }, limit: 300 })]
      : [await F.query(c.env, 'users', { eq: { ...base, status: 'pending' }, limit: 300 }),
        role ? await F.query(c.env, 'users', { eq: base, limit: 300 }) : await F.query(c.env, 'users', { order: ['created_at', 'desc'], limit: 300 })];
    const seen = new Map(); for (const r of lists.flat()) seen.set(r.uid, r);
    const q = String(c.body.q ?? '').trim().slice(0, 40).toLowerCase();
    const has = (v) => String(v ?? '').toLowerCase().includes(q);
    const rows = [...seen.values()].filter((r) => r.role !== 'admin' && (!q || has(r.name) || has(r.phone) || has(r.email)))
      .sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.created_at - a.created_at).slice(0, 300);
    return { users: rows.map((r) => { const u = userOut(r); if (r.role === 'driver') u.trust = trustOf(r); return u; }) };
  },

  async 'admin/user'(c) {
    const admin = await need(c, ['admin']);
    const target = await F.get(c.env, `users/${uidOf(c.body.uid)}`);
    if (!target) throw new HttpError(404, 'user_not_found');
    if (target.role === 'admin') throw new HttpError(403, 'forbidden');
    const status = c.body.status;
    if (!['active', 'rejected', 'banned', 'pending'].includes(status)) throw new HttpError(400, 'bad_status');
    const reason = str(c.body.reason ?? '', 0, 200);
    const writes = [F.patch(`users/${target.uid}`, { status, status_reason: reason, reviewed_by: admin.uid, reviewed_at: now() })];
    if (status === 'banned' && c.body.blacklist) {
      for (const [type, value] of [['phone', target.phone], ['nid', target.national_id]]) {
        if (value) writes.push(F.set(`blacklist/${type}_${value}`, { k: `${type}_${value}`, type, value, reason, at: now() }));
      }
    }
    await F.run(c.env, writes);
    if (status === 'active' && target.status !== 'active') bg(c, notify(c.env, [target.uid], 'account_active', {}, { url: '/' }));
    if (['rejected', 'banned'].includes(status)) bg(c, notify(c.env, [target.uid], 'account_rejected', {}, { url: '/' }));
    return { ok: true };
  },

  async 'admin/payment'(c) {
    const admin = await need(c, ['admin']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.status !== 'payment_review') throw new HttpError(409, 'bad_state');
    const pre = o.payMode === 'before'; // دفع مقدم: التأكيد بيفتح الطلب للسواقين. دفع بعد القبول: بيبدأ التنفيذ.
    let patch, logStatus;
    if (c.body.action === 'confirm') { patch = { status: pre ? 'open' : 'paid', escrowStatus: 'held', paidAt: now(), paymentConfirmedBy: admin.uid }; logStatus = patch.status; }
    else if (c.body.action === 'reject') { patch = { status: pre ? 'awaiting_payment' : 'accepted', paymentRejectReason: str(c.body.note ?? '', 0, 200), paymentProof: null, paymentRef: null }; logStatus = 'payment_rejected'; }
    else throw new HttpError(400, 'bad_action');
    await F.run(c.env, orderUpdate(c.env, o, patch, L(logStatus, admin.uid, pre && c.body.action === 'confirm' ? { note: 'prepaid_confirmed' } : {})));
    const url = `/#/order/${o.id}`;
    if (c.body.action === 'confirm') {
      if (pre) {
        bg(c, notify(c.env, [o.customerId], 'prepaid_open', { no: orderNo(o.id) }, { url }));
        bg(c, loadSettings(c.env).then((s) => dispatchNewOrder(c.env, { id: o.id, service: o.service, size: o.size, vehicleClass: o.vehicleClass, passengers: o.passengers, pickup: o.pickup, dropoff: o.dropoff, price: o.price }, s)));
      } else {
        bg(c, notify(c.env, [o.driverId], 'paid_driver', { no: orderNo(o.id) }, { url }));
        bg(c, notify(c.env, [o.customerId], 'paid_customer', { no: orderNo(o.id) }, { url }));
      }
    } else bg(c, notify(c.env, [o.customerId], 'payment_rejected', { no: orderNo(o.id) }, { url }));
    return { ok: true };
  },

  async 'admin/order-price'(c) {
    const admin = await need(c, ['admin']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (!['open', 'accepted', 'awaiting_payment'].includes(o.status) || o.escrowStatus === 'held') throw new HttpError(409, 'bad_state'); // بعد الدفع السعر ثابت
    const price = int(c.body.price, 1, 10000000, 'bad_price');
    await F.run(c.env, orderUpdate(c.env, o, { price, priceOverridden: true, priceNote: str(c.body.note ?? '', 0, 200) }, L(o.status, admin.uid, { note: 'price_override', price })));
    return { ok: true };
  },

  async 'admin/withdrawals'(c) {
    await need(c, ['admin']);
    const [pend, recent] = await Promise.all([F.query(c.env, 'withdrawals', { eq: { status: 'pending' }, limit: 200 }), F.query(c.env, 'withdrawals', { order: ['created_at', 'desc'], limit: 200 })]);
    const seen = new Map(); for (const r of [...pend, ...recent]) seen.set(r.id, r);
    const rows = [...seen.values()].sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.created_at - a.created_at).slice(0, 200);
    return { withdrawals: rows.map(withdrawalOut) };
  },

  async 'admin/withdrawal'(c) {
    const admin = await need(c, ['admin']);
    const w = await F.get(c.env, `withdrawals/${docId(c.body.id)}`);
    if (!w) throw new HttpError(404, 'not_found');
    if (w.status !== 'pending') throw new HttpError(409, 'bad_state');
    const note = str(c.body.note ?? '', 0, 200);
    const mark = (s) => F.patch(`withdrawals/${w.id}`, { status: s, note, decided_by: admin.uid, decided_at: now() }, w._ut); // شرط: لسه معلّق
    if (c.body.action === 'paid') await F.run(c.env, [mark('paid')]);
    else if (c.body.action === 'reject') await F.run(c.env, [mark('rejected'), walletCredit(w.uid, w.amount), walletTx({ uid: w.uid, type: 'withdrawal_refund', amount: w.amount, withdrawalId: w.id })]);
    else throw new HttpError(400, 'bad_action');
    bg(c, notify(c.env, [w.uid], c.body.action === 'paid' ? 'withdrawal_paid' : 'withdrawal_rejected', { amount: w.amount }, { url: '/#/driver/wallet' }));
    return { ok: true };
  },

  async 'admin/disputes'(c) {
    await need(c, ['admin']);
    const [open, recent] = await Promise.all([F.query(c.env, 'disputes', { eq: { status: 'open' }, limit: 100 }), F.query(c.env, 'disputes', { order: ['created_at', 'desc'], limit: 100 })]);
    const seen = new Map(); for (const r of [...open, ...recent]) seen.set(r.id, r);
    const rows = [...seen.values()].sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || b.created_at - a.created_at).slice(0, 100);
    const ids = [...new Set(rows.map((r) => r.order_id))];
    const orders = (await F.getMany(c.env, 'orders', ids)).filter(Boolean);
    const byId = Object.fromEntries(orders.map((o) => [o.id, orderOut(hydrateOrder(o), { role: 'admin' })]));
    const chats = {}; // المحادثة بتتجاب للنزاعات المفتوحة بس (أول 10) عشان نوفّر قراءات
    await Promise.all([...new Set(rows.filter((r) => r.status === 'open').map((r) => r.order_id))].slice(0, 10).map(async (oid) => {
      chats[oid] = (await F.query(c.env, `orders/${oid}/messages`, { order: ['seq', 'asc'], limit: 100 }))
        .map((m) => ({ from: m.sender_id === byId[oid]?.customerId ? 'customer' : m.sender_id === byId[oid]?.driverId ? 'driver' : 'admin', body: m.body, at: m.created_at }));
    }));
    return { disputes: rows.map((r) => ({ ...disputeOut(r), order: byId[r.order_id] || null, chat: chats[r.order_id] || [] })) };
  },

  // ---------- حسم النزاع: رد كامل للعميل / تحويل كامل للسواق / تقسيم بنسبة ----------
  async 'admin/dispute'(c) {
    const admin = await need(c, ['admin']);
    const d = await F.get(c.env, `disputes/${docId(c.body.id)}`);
    if (!d) throw new HttpError(404, 'not_found');
    if (d.status !== 'open') throw new HttpError(409, 'bad_state');
    const o = await loadOrder(c.env, d.order_id);
    if (o.status !== 'disputed') throw new HttpError(409, 'bad_state');
    const pct = c.body.decision === 'refund' ? 100 : c.body.decision === 'release' ? 0 : c.body.decision === 'split' ? int(c.body.customerPct, 1, 99) : null;
    if (pct === null) throw new HttpError(400, 'bad_decision');
    const note = str(c.body.note ?? '', 0, 500);
    const customerRefund = Math.round((o.price * pct) / 100);
    const driverGross = o.price - customerRefund;
    const pct_ = effectiveCommissionPct(await loadSettings(c.env), o.commissionPct, await F.get(c.env, `users/${o.driverId}`));
    const { commission, net } = driverGross > 0 ? split(driverGross, pct_) : { commission: 0, net: 0 };
    const writes = [
      F.patch(`disputes/${d.id}`, { status: 'resolved', decision: c.body.decision, customer_pct: pct, customer_refund: customerRefund, driver_net: net, commission, note, refund_paid: customerRefund === 0, resolved_by: admin.uid, resolved_at: now() }, d._ut), // شرط: لسه مفتوح
      ...orderUpdate(c.env, o, { status: 'resolved', escrowStatus: 'settled', commission, driverNet: net, customerRefund, resolution: c.body.decision }, L('resolved', admin.uid)),
    ];
    if (net > 0) writes.push(walletCredit(o.driverId, net), walletTx({ uid: o.driverId, type: 'dispute_earning', orderId: o.id, amount: net, gross: driverGross, commission }));
    await F.run(c.env, writes);
    return { ok: true, customerRefund, driverNet: net };
  },

  async 'admin/dispute-refund'(c) { // الأدمن يأكد إنه رد المبلغ للعميل يدوياً (InstaPay)
    await need(c, ['admin']);
    const d = await F.get(c.env, `disputes/${docId(c.body.id)}`);
    if (!d || d.status !== 'resolved') throw new HttpError(409, 'bad_state');
    await F.run(c.env, [F.patch(`disputes/${d.id}`, { refund_paid: true, refund_paid_at: now() }, d._ut)]);
    return { ok: true };
  },

  // ---------- بلاغات (سلوك مسيء/احتيال/قيادة غير آمنة...) ----------
  async 'reports/create'(c) {
    const u = await need(c, ['customer', 'driver']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.customerId !== c.uid && o.driverId !== c.uid) throw new HttpError(403, 'forbidden');
    if (!o.driverId) throw new HttpError(409, 'bad_state');
    if (!REPORT_REASONS.includes(c.body.reason)) throw new HttpError(400, 'bad_reason');
    const limit = await rateLimit(c.env, 'report', c.uid, 3600e3, 5, 'too_many_reports');
    const chat = (await F.query(c.env, `orders/${o.id}/messages`, { order: ['seq', 'desc'], limit: 30 })).reverse()
      .map((m) => ({ from: m.sender_id === o.customerId ? 'customer' : m.sender_id === o.driverId ? 'driver' : 'admin', body: m.body, at: m.created_at })); // لقطة من الشات كدليل
    const id = newId();
    await F.run(c.env, [limit, F.create(`reports/${id}`, {
      id, reporter_id: c.uid, target_id: c.uid === o.customerId ? o.driverId : o.customerId, order_id: o.id, reason: c.body.reason, details: str(c.body.details ?? '', 0, 1000),
      context: JSON.stringify({ chat, orderStatus: o.status }), status: 'open', admin_note: null, handled_by: null, handled_at: null, created_at: now(),
    })]);
    toAdmins(c, 'report', { no: orderNo(o.id), name: u.name }, '/#/admin/reports');
    return { ok: true, id };
  },

  // ---------- زر الطوارئ (رحلات الركاب أثناء التنفيذ فقط) ----------
  async 'sos/trigger'(c) {
    const u = await need(c, ['customer', 'driver']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.customerId !== c.uid && o.driverId !== c.uid) throw new HttpError(403, 'forbidden');
    if (o.service !== 'passengers' || !['heading_pickup', 'picked_up', 'in_transit'].includes(o.status)) throw new HttpError(409, 'bad_state');
    let lat = null, lng = null;
    if (c.body.lat != null) { const p = point(c.body, false); lat = p.lat; lng = p.lng; }
    const open = (await F.query(c.env, 'sos_events', { eq: { order_id: o.id, user_id: c.uid }, limit: 20 })).filter((e) => e.status === 'open').sort(byDesc('created_at'))[0];
    let id, notifyNow = true;
    if (open) { // ضغطة تانية على نفس الاستغاثة المفتوحة: نحدّث الموقع بس (وما نزعجش الأدمن أكتر من مرة كل دقيقة)
      id = open.id; notifyNow = now() - open.updated_at > 60000;
      await F.run(c.env, [F.patch(`sos_events/${id}`, { ...(lat != null ? { lat, lng } : {}), updated_at: now() })]);
    } else {
      const limit = await rateLimit(c.env, 'sos', c.uid, 3600e3, 3, 'too_many_reports');
      id = newId();
      await F.run(c.env, [limit, F.create(`sos_events/${id}`, { id, order_id: o.id, user_id: c.uid, lat, lng, status: 'open', note: null, handled_by: null, handled_at: null, created_at: now(), updated_at: now() })]);
    }
    if (notifyNow) toAdmins(c, 'sos', { no: orderNo(o.id), name: u.name }, '/#/admin/reports');
    return { ok: true, id, emergency: { police: '122', ambulance: '123' } };
  },

  async 'admin/reports'(c) {
    await need(c, ['admin']);
    const merge = async (col, lim, openKey) => { // المفتوح الأول ثم الأحدث (من غير فهرس مركّب)
      const [o, r] = await Promise.all([F.query(c.env, col, { eq: { status: 'open' }, limit: lim }), F.query(c.env, col, { order: ['created_at', 'desc'], limit: lim })]);
      const seen = new Map(); for (const x of [...o, ...r]) seen.set(x.id, x);
      return [...seen.values()].sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || b.created_at - a.created_at).slice(0, lim);
    };
    const [rs, ss] = await Promise.all([merge('reports', 100), merge('sos_events', 50)]);
    const [us, os] = await Promise.all([
      F.getMany(c.env, 'users', [...rs.flatMap((r) => [r.reporter_id, r.target_id]), ...ss.map((e) => e.user_id)]),
      F.getMany(c.env, 'orders', ss.map((e) => e.order_id)),
    ]);
    const U = Object.fromEntries(us.filter(Boolean).map((u) => [u.uid, u])), O = Object.fromEntries(os.filter(Boolean).map((o) => [o.id, o]));
    const jp = (x) => { try { return JSON.parse(x || '{}'); } catch { return {}; } };
    return {
      reports: rs.map((r) => ({ id: r.id, orderId: r.order_id, reason: r.reason, details: r.details, status: r.status, adminNote: r.admin_note, createdAt: r.created_at, handledAt: r.handled_at,
        reporter: { name: U[r.reporter_id]?.name, phone: U[r.reporter_id]?.phone }, target: { uid: r.target_id, name: U[r.target_id]?.name, phone: U[r.target_id]?.phone }, context: jp(r.context) })),
      sos: ss.map((e) => { const d = jp(O[e.order_id]?.data); return { id: e.id, orderId: e.order_id, status: e.status, note: e.note, lat: e.lat, lng: e.lng, createdAt: e.created_at, updatedAt: e.updated_at,
        by: { name: U[e.user_id]?.name, phone: U[e.user_id]?.phone }, customer: { name: d.customerName, phone: d.customerPhone }, driver: { name: d.driverName, phone: d.driverPhone }, pickup: d.pickup, dropoff: d.dropoff }; }),
    };
  },
  async 'admin/report'(c) {
    const admin = await need(c, ['admin']);
    const r = await F.get(c.env, `reports/${docId(c.body.id)}`);
    if (!r) throw new HttpError(404, 'not_found');
    if (r.status !== 'open') throw new HttpError(409, 'bad_state');
    if (!['resolve', 'dismiss'].includes(c.body.action)) throw new HttpError(400, 'bad_action');
    await F.run(c.env, [F.patch(`reports/${r.id}`, { status: c.body.action === 'resolve' ? 'resolved' : 'dismissed', admin_note: str(c.body.note ?? '', 0, 500), handled_by: admin.uid, handled_at: now() }, r._ut)]);
    bg(c, notify(c.env, [r.reporter_id], 'report_handled', { no: orderNo(r.order_id) }, { url: `/#/order/${r.order_id}` }));
    return { ok: true };
  },
  async 'admin/sos-handle'(c) {
    const admin = await need(c, ['admin']);
    const e = await F.get(c.env, `sos_events/${docId(c.body.id)}`);
    if (!e || e.status !== 'open') throw new HttpError(409, 'bad_state');
    await F.run(c.env, [F.patch(`sos_events/${e.id}`, { status: 'handled', note: str(c.body.note ?? '', 0, 500), handled_by: admin.uid, handled_at: now() }, e._ut)]);
    return { ok: true };
  },

  // ---------- استرجاع الفلوس (يدوي على InstaPay) ----------
  async 'admin/refunds'(c) {
    await need(c, ['admin']);
    const [p, r] = await Promise.all([F.query(c.env, 'refunds', { eq: { status: 'pending' }, limit: 200 }), F.query(c.env, 'refunds', { order: ['created_at', 'desc'], limit: 200 })]);
    const seen = new Map(); for (const x of [...p, ...r]) seen.set(x.id, x);
    const rows = [...seen.values()].sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.created_at - a.created_at).slice(0, 200);
    const us = await F.getMany(c.env, 'users', rows.map((x) => x.customer_id));
    return { refunds: rows.map((x, i) => ({ id: x.id, orderId: x.order_id, customerId: x.customer_id, customerName: us[i]?.name ?? null, customerPhone: us[i]?.phone ?? null, amount: x.amount, reason: x.reason, status: x.status, note: x.note, createdAt: x.created_at, paidAt: x.paid_at })) };
  },
  async 'admin/refund'(c) { // الأدمن حوّل المبلغ للعميل فعلاً => "تم"
    const admin = await need(c, ['admin']);
    const f = await F.get(c.env, `refunds/${docId(c.body.id)}`);
    if (!f) throw new HttpError(404, 'not_found');
    if (f.status !== 'pending') throw new HttpError(409, 'bad_state');
    const o = await loadOrder(c.env, f.order_id);
    await F.run(c.env, [
      F.patch(`refunds/${f._id}`, { status: 'paid', note: str(c.body.note ?? '', 0, 200), paid_at: now(), paid_by: admin.uid }, f._ut), // شرط: لسه معلّق
      ...orderUpdate(c.env, o, o.escrowStatus === 'refund_pending' ? { escrowStatus: 'refunded' } : {}, L(o.status, admin.uid, { note: 'refund_paid' })), // لو الطلب فيه رسوم إلغاء (settled) بنسيبه زي ما هو عشان الإيراد يفضل محسوب
    ]);
    bg(c, notify(c.env, [f.customer_id], 'refund_paid', { no: orderNo(f.order_id), amount: f.amount }, { url: `/#/order/${f.order_id}` }));
    return { ok: true };
  },

  // ---------- الشات بين العميل والسواق (بيفتح بعد ما سواق يتحدد) ----------
  // الرسائل مستندات داخل الطلب نفسه (orders/{id}/messages) — فالاستعلام بيجيب الجديد بس (seq > after) وبيتحاسب على الجديد فقط.
  async 'chat/list'(c) {
    const u = await viewer(c);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (!(o.customerId === c.uid || o.driverId === c.uid || u.role === 'admin')) throw new HttpError(403, 'forbidden');
    if (!o.driverId) throw new HttpError(409, 'chat_closed');
    const rows = await F.query(c.env, `orders/${o.id}/messages`, { range: [['seq', '>', Math.max(0, Math.floor(Number(c.body.after) || 0))]], order: ['seq', 'asc'], limit: 200 });
    return { open: CHAT_OPEN.includes(o.status), messages: rows.map((m) => ({ seq: m.seq, id: m.id, mine: m.sender_id === c.uid, from: m.sender_id === o.customerId ? 'customer' : m.sender_id === o.driverId ? 'driver' : 'admin', body: m.body, at: m.created_at })) };
  },
  async 'chat/send'(c) {
    const u = await need(c, ['customer', 'driver']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.customerId !== c.uid && o.driverId !== c.uid) throw new HttpError(403, 'forbidden');
    if (!o.driverId || !CHAT_OPEN.includes(o.status)) throw new HttpError(409, 'chat_closed');
    const body = str(c.body.body, 1, 500);
    const limit = await rateLimit(c.env, 'chat', c.uid, 60000, 20, 'too_many_messages');
    const id = newId(), t = now(), seq = t * 1000 + Math.floor(Math.random() * 1000); // seq تصاعدي بحسب الوقت (الواجهة بتطلب اللي بعد آخر seq شافته)
    await F.run(c.env, [limit,
      F.create(`orders/${o.id}/messages/${id}`, { id, order_id: o.id, sender_id: c.uid, body, created_at: t, seq }),
      F.inc(`chatmeta/${o.id}`, { n: 1 }, { order_id: o.id, at: t })]);
    bg(c, notify(c.env, [c.uid === o.customerId ? o.driverId : o.customerId], 'chat', { name: u.name, text: body.slice(0, 120) }, { url: `/#/order/${o.id}`, tag: `chat-${o.id}` }));
    return { ok: true, id };
  },

  async 'admin/settings/save'(c) {
    await need(c, ['admin']);
    const clean = sanitizeSettings(c.body);
    await F.run(c.env, [F.set('settings/pricing', { k: 'pricing', v: JSON.stringify(clean) })]);
    clearSettingsCache();
    return { settings: await loadSettings(c.env) };
  },

  async 'admin/blacklist'(c) {
    await need(c, ['admin']);
    return { items: (await F.query(c.env, 'blacklist', { order: ['at', 'desc'], limit: 500 })).map((r) => ({ id: r.k, type: r.type, value: r.value, reason: r.reason, at: r.at })) };
  },
  async 'admin/blacklist/add'(c) {
    await need(c, ['admin']);
    const type = c.body.type, value = String(c.body.value ?? '').replace(/\D/g, '');
    if (!['phone', 'nid'].includes(type) || (type === 'phone' && !/^01[0125]\d{8}$/.test(value)) || (type === 'nid' && !/^\d{14}$/.test(value))) throw new HttpError(400, 'bad_input');
    await F.run(c.env, [F.set(`blacklist/${type}_${value}`, { k: `${type}_${value}`, type, value, reason: str(c.body.reason ?? '', 0, 200), at: now() })]);
    return { ok: true };
  },
  async 'admin/blacklist/remove'(c) {
    await need(c, ['admin']);
    const k = str(c.body.id, 3, 40);
    if (!/^(phone|nid)_\d+$/.test(k)) throw new HttpError(400, 'bad_input');
    await F.run(c.env, [F.del(`blacklist/${k}`)]);
    return { ok: true };
  },
};

// =====================================================================
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

// تشخيص الربط: افتح /api/health بعد النشر. بيرجّع true/false فقط (بدون أي قيم سرية).
async function health(env) {
  const out = { db: !!env.FIREBASE_SERVICE_ACCOUNT, firestore: false, push: pushEnabled(env), projectId: !!env.FIREBASE_PROJECT_ID && !String(env.FIREBASE_PROJECT_ID).startsWith('YOUR_') };
  if (out.db && out.projectId) out.firestore = await F.get(env, 'settings/pricing').then(() => true).catch(() => false); // null (مفيش مستند) برضو معناها إن Firestore شغّال
  out.ok = out.db && out.firestore && out.projectId;
  return out;
}

export async function onRequest({ request, env, params, waitUntil }) {
  try {
    const route = [].concat(params.route || []).join('/');
    if (request.method === 'GET' && route === 'health') return json(await health(env));
    if (!env.FIREBASE_SERVICE_ACCOUNT) throw new HttpError(500, 'missing_service_account');
    const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const isFileGet = request.method === 'GET' && route.startsWith('files/');
    if (request.method !== 'POST' && !isFileGet) throw new HttpError(405, 'method_not_allowed');
    if (!bearer) throw new HttpError(401, 'unauthenticated');
    const token = await verifyIdToken(bearer, env.FIREBASE_PROJECT_ID);
    if (isFileGet) {
      const role = (await F.get(env, `users/${token.uid}`))?.role;
      return await readFile(env, { uid: token.uid, role }, route.slice(6));
    }
    const handler = Object.hasOwn(ROUTES, route) ? ROUTES[route] : null;
    if (!handler) throw new HttpError(404, 'not_found');
    const body = await request.json().catch(() => ({}));
    return json(await handler({ env, uid: token.uid, token, body, request, waitUntil }));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code }, e.status);
    console.error(e);
    return json({ error: 'server_error' }, 500);
  }
}
