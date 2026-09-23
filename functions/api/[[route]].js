// كل المنطق الحساس (الصلاحيات، السعر، Escrow، العمولة، المحفظة، النزاعات) بيتنفذ هنا على السيرفر فوق Cloudflare D1.
// المتصفح مالوش وصول مباشر لقاعدة البيانات: كل قراءة وكتابة بتعدّي من هنا وبتتفلتر حسب دور المستخدم.
import { HttpError, verifyIdToken, newId } from '../_lib/core.js';
import { st, one, all, guard, run, now, walletCredit, walletTx, userOut, withdrawalOut, txOut, disputeOut, loadOrder, hydrateOrder, orderUpdate, orderOut } from '../_lib/db.js';
import { loadSettings, sanitizeSettings, distanceKm, calcPrice, calcPassengerPrice, effectiveCommissionPct, canServe, cancelSplit, haversineM, split } from '../_lib/logic.js';
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

// ---------- المستخدم الحالي ----------
async function need(c, roles) {
  const r = await one(c.env, 'SELECT * FROM users WHERE uid = ?', c.uid);
  if (!r) throw new HttpError(403, 'no_profile');
  if (!roles.includes(r.role)) throw new HttpError(403, 'forbidden');
  if (r.status !== 'active') throw new HttpError(403, 'account_not_active');
  return userOut(r);
}
async function viewer(c) { // أي مستخدم مفعّل (أو أدمن) للقراءة
  const u = userOut(await one(c.env, 'SELECT * FROM users WHERE uid = ?', c.uid));
  if (!u) throw new HttpError(403, 'no_profile');
  if (u.status !== 'active' && u.role !== 'admin') throw new HttpError(403, 'account_not_active');
  return u;
}

const REPORT_REASONS = ['abuse', 'harassment', 'unsafe', 'fraud', 'no_show', 'other'];
const CHAT_OPEN = ['accepted', 'payment_review', 'paid', 'heading_pickup', 'picked_up', 'in_transit', 'delivered', 'disputed']; // حالات يُسمح فيها بإرسال رسائل
const HELD = ['paid', 'heading_pickup', 'picked_up', 'in_transit', 'delivered'];
const ACTIVE = ['heading_pickup', 'picked_up', 'in_transit'];
const NEXT = { paid: 'heading_pickup', heading_pickup: 'picked_up', picked_up: 'in_transit', in_transit: 'delivered' };
const inList = (a) => a.map(() => '?').join(',');
// إرسال الإشعارات في الخلفية: ما بيبطّأش الرد، وأي فشل فيه ما بيكسّرش العملية الأساسية
const bg = (c, p) => { const safe = Promise.resolve(p).catch(() => {}); if (c.waitUntil) c.waitUntil(safe); return safe; };
const refundInsert = (env, o, reason) => st(env, "INSERT INTO refunds(id, order_id, customer_id, amount, reason, status, created_at) VALUES(?,?,?,?,?,'pending',?)", newId(), o.id, o.customerId, o.price, reason, now());
const afterRefundRequest = (c, o) => {
  toAdmins(c, 'refund_due', { no: orderNo(o.id), amount: o.price }, '/#/admin/refunds');
  bg(c, notify(c.env, [o.customerId], 'refund_pending', { no: orderNo(o.id), amount: o.price }, { url: `/#/order/${o.id}` }));
};
/** طلب مدفوع مقدماً ماحدش قبله لحد ميعاده + المهلة: بيتلغي ويتسجّل استرجاع للعميل (بدون Cron: بيتنفذ عند القراءة) */
async function expireOrder(env, o) {
  try {
    await run(env, [
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
  const rows = await all(env, "SELECT * FROM orders WHERE status = 'open' AND escrow_status = 'held' AND scheduled_at < ? LIMIT 10", now() - s.prepaidGraceMin * 60000);
  for (const r of rows) await expireOrder(env, hydrateOrder(r)).catch((e) => console.error('expire_failed', e?.message));
}
const toAdmins = (c, type, vars, url) => bg(c, (async () => notify(c.env, await adminIds(c.env), type, vars, { url }))());

// =====================================================================
const ROUTES = {
  // ---------- عام ----------
  async settings({ env }) { return { settings: await loadSettings(env) }; },
  async me({ env, uid }) {
    const r = await one(env, 'SELECT * FROM users WHERE uid = ?', uid);
    const profile = userOut(r) || null;
    if (profile && profile.role === 'driver') { // مستوى السواق وتقدّمه وعمولته الحالية
      const s = await loadSettings(env);
      profile.trust = { ...trustOf(r), commissionPct: effectiveCommissionPct(s, s.commissionPct, r) };
    }
    return { profile };
  },

  // ---------- التسجيل: فحص القائمة السوداء + منع التكرار (UNIQUE في القاعدة) ----------
  async register({ env, uid, token, body }) {
    if (await one(env, 'SELECT 1 x FROM users WHERE uid = ?', uid)) throw new HttpError(409, 'already_registered');
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
    if (await one(env, 'SELECT 1 x FROM blacklist WHERE k IN (?, ?)', `phone_${phone}`, `nid_${nid}`)) throw new HttpError(403, 'blacklisted');
    const s = await loadSettings(env);
    const status = role === 'customer' && s.autoApproveCustomers ? 'active' : 'pending';
    const stmts = [st(env,
      `INSERT INTO users(uid, role, status, name, phone, email, national_id, area, lang, id_ref, license_ref, vehicle_reg_ref, vehicle_photo_ref, vehicle_type, phone_verified, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      uid, role, status, name, phone, token.email, nid, area, lang, refs.id, refs.license, refs.vehicleReg, refs.vehiclePhoto, vehicleType, !!token.phone_number, now())];
    if (driver) stmts.push(st(env, 'INSERT INTO wallets(uid, balance, total_earned, updated_at) VALUES(?, 0, 0, ?)', uid, now()));
    await run(env, stmts);
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
    const profile = userOut(await one(c.env, 'SELECT * FROM users WHERE uid = ?', c.uid));
    return { ref: await saveFile(c.env, c.uid, profile, c.body.kind, c.body.data) };
  },

  // ---------- الطلبات: قراءة ----------
  async 'orders/list'(c) {
    const u = await viewer(c);
    bg(c, sweepExpired(c.env)); // إنهاء الطلبات المدفوعة مقدماً اللي ماحدش قبلها (واسترجاعها)
    let rows;
    if (u.role === 'customer') rows = await all(c.env, 'SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 100', c.uid);
    else if (u.role === 'driver') {
      rows = c.body.scope === 'mine'
        ? await all(c.env, 'SELECT * FROM orders WHERE driver_id = ? ORDER BY updated_at DESC LIMIT 100', c.uid)
        : await all(c.env, "SELECT * FROM orders WHERE status = 'open' ORDER BY created_at DESC LIMIT 100");
    } else {
      const status = c.body.status ? String(c.body.status) : null, lim = int(c.body.limit ?? 200, 1, 300);
      rows = status ? await all(c.env, 'SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT ?', status, lim)
        : await all(c.env, 'SELECT * FROM orders ORDER BY created_at DESC LIMIT ?', lim);
    }
    const out = rows.map((r) => orderOut(hydrateOrder(r), u, { brief: true }));
    if (u.role === 'customer') { // عدد العروض المعلّقة على كل طلب مفتوح
      const open = out.filter((o) => o.status === 'open').map((o) => o.id);
      if (open.length) {
        const cnt = await all(c.env, `SELECT order_id, COUNT(*) n FROM offers WHERE status = 'pending' AND order_id IN (${inList(open)}) GROUP BY order_id`, ...open);
        const m = Object.fromEntries(cnt.map((x) => [x.order_id, x.n]));
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
      const l = await one(c.env, 'SELECT lat, lng, at FROM live_locations WHERE order_id = ?', o.id);
      if (l) location = { lat: l.lat, lng: l.lng, at: l.at };
    }
    const out = orderOut(o, u);
    if (o.status === 'open') {
      if (u.role === 'customer' || u.role === 'admin') { // العميل يشوف العروض (بدون رقم السواق لحد ما يقبل)
        out.offers = (await all(c.env, `SELECT f.id, f.price, f.note, f.created_at, d.name, d.vehicle_type, d.rating_sum, d.rating_count, d.completed_orders, d.cancel_count, d.phone_verified, d.status AS driver_status
          FROM offers f JOIN users d ON d.uid = f.driver_id WHERE f.order_id = ? AND f.status = 'pending' ORDER BY f.price ASC LIMIT 30`, o.id))
          .map((r) => ({ id: r.id, price: r.price, note: r.note, createdAt: r.created_at, driverName: r.name, vehicleType: r.vehicle_type, ratingSum: r.rating_sum, ratingCount: r.rating_count, completedOrders: r.completed_orders,
            trust: trustOf({ ...r, status: r.driver_status }) }));
      } else if (u.role === 'driver') {
        out.myOffer = (await one(c.env, 'SELECT id, price, note, status FROM offers WHERE order_id = ? AND driver_id = ? ORDER BY created_at DESC LIMIT 1', o.id, c.uid)) || null;
      }
    }
    if (o.driverId && (u.role === 'customer' || u.role === 'admin')) { // العميل يشوف مستوى وشارات سواق طلبه
      const d = await one(c.env, 'SELECT * FROM users WHERE uid = ?', o.driverId);
      if (d) out.driverTrust = trustOf(d);
    }
    if (u.role === 'customer' || u.role === 'admin') { // حالة الاسترجاع
      const rf = await one(c.env, 'SELECT status, amount, reason FROM refunds WHERE order_id = ?', o.id);
      if (rf) out.refund = rf;
    }
    if (o.driverId && (u.role === 'admin' || o.customerId === c.uid || o.driverId === c.uid)) { // مؤشر الشات
      const m = await one(c.env, 'SELECT COUNT(*) n, MAX(created_at) at FROM messages WHERE order_id = ?', o.id);
      out.chat = { count: m.n, lastAt: m.at };
    }
    return { order: out, location };
  },

  // السواق بيبعت موقعه (الواجهة بتبعته كل ~15 ثانية)
  async 'orders/location'(c) {
    await need(c, ['driver']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.driverId !== c.uid || !ACTIVE.includes(o.status)) throw new HttpError(403, 'forbidden');
    const p = point(c.body, false);
    await st(c.env, 'INSERT INTO live_locations(order_id, lat, lng, acc, at) VALUES(?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, acc = excluded.acc, at = excluded.at',
      o.id, p.lat, p.lng, int(c.body.acc ?? 0, 0, 100000), now()).run();
    return { ok: true };
  },

  // ---------- إنشاء طلب ----------
  async 'orders/create'(c) {
    const u = await need(c, ['customer']);
    const s = await loadSettings(c.env), b = c.body;
    const pending = await one(c.env, "SELECT COUNT(*) c FROM orders WHERE customer_id = ? AND status IN ('open','accepted','payment_review','awaiting_payment')", c.uid);
    if (pending.c >= 10) throw new HttpError(429, 'too_many_open');
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
    await run(c.env, [st(c.env, "INSERT INTO orders(id, customer_id, status, escrow_status, price, scheduled_at, created_at, updated_at, version, data) VALUES(?,?,?,'none',?,?,?,?,1,?)",
      id, c.uid, first, price, when.getTime(), t, t, JSON.stringify(data))]);
    if (!prepay) bg(c, dispatchNewOrder(c.env, { id, ...spec, pickup, dropoff, price }, s)); // المدفوع مقدماً بيتبعت للسواقين بعد تأكيد الدفع
    return { id, price, prepay };
  },

  // ---------- السواق يقبل (أول واحد يكسب: حراسة النسخة بتفشل التاني) ----------
  async 'orders/accept'(c) {
    const u = await need(c, ['driver']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.status !== 'open') throw new HttpError(409, 'order_not_open');
    if (o.instant === false) throw new HttpError(409, 'offers_only'); // العميل اختار يستقبل عروض أسعار بدل القبول الفوري
    if (o.service === 'passengers' && !canServe(u.vehicleType, o)) throw new HttpError(403, 'vehicle_mismatch'); // ركاب: لازم عربية ركاب مناسبة (أمان)
    const prepaid = o.escrowStatus === 'held'; // مدفوع مقدماً: السواق يبدأ فوراً (الحالة paid)
    await run(c.env, [
      ...orderUpdate(c.env, o, { status: prepaid ? 'paid' : 'accepted', driverId: c.uid, driverName: u.name, driverPhone: u.phone, driverVehicle: u.vehicleType, acceptedAt: now() }, L(prepaid ? 'paid' : 'accepted', c.uid, prepaid ? { note: 'accepted_prepaid' } : {})),
      st(c.env, "UPDATE offers SET status = CASE WHEN driver_id = ? THEN 'withdrawn' ELSE 'rejected' END, updated_at = ? WHERE order_id = ? AND status = 'pending'", c.uid, now(), o.id),
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
    const mine = await one(c.env, "SELECT id FROM offers WHERE order_id = ? AND driver_id = ? AND status = 'pending'", o.id, c.uid);
    await run(c.env, [
      guard(c.env, "EXISTS (SELECT 1 FROM orders WHERE id = ? AND status = 'open')", o.id),
      mine ? st(c.env, "UPDATE offers SET price = ?, note = ?, updated_at = ? WHERE id = ? AND status = 'pending'", price, note, now(), mine.id)
        : st(c.env, "INSERT INTO offers(id, order_id, driver_id, price, note, status, created_at, updated_at) VALUES(?,?,?,?,?,'pending',?,?)", newId(), o.id, c.uid, price, note, now(), now()),
    ]);
    bg(c, notify(c.env, [o.customerId], 'offer', { price, no: orderNo(o.id), driver: u.name }, { url: `/#/order/${o.id}`, tag: 'offer-' + o.id }));
    return { ok: true, min: lo, max: hi };
  },
  async 'offers/withdraw'(c) {
    await need(c, ['driver']);
    const r = await st(c.env, "UPDATE offers SET status = 'withdrawn', updated_at = ? WHERE order_id = ? AND driver_id = ? AND status = 'pending'", now(), docId(c.body.orderId), c.uid).run();
    if (!r.meta.changes) throw new HttpError(409, 'bad_state');
    return { ok: true };
  },
  async 'offers/accept'(c) {
    await need(c, ['customer']);
    const f = await one(c.env, 'SELECT * FROM offers WHERE id = ?', docId(c.body.offerId));
    if (!f) throw new HttpError(404, 'not_found');
    if (f.status !== 'pending') throw new HttpError(409, 'bad_state');
    const o = await loadOrder(c.env, f.order_id);
    if (o.customerId !== c.uid) throw new HttpError(403, 'forbidden');
    if (o.status !== 'open') throw new HttpError(409, 'order_not_open');
    const d = await one(c.env, "SELECT * FROM users WHERE uid = ? AND role = 'driver' AND status = 'active'", f.driver_id);
    if (!d) throw new HttpError(409, 'driver_unavailable');
    const others = (await all(c.env, "SELECT driver_id FROM offers WHERE order_id = ? AND status = 'pending' AND id != ?", o.id, f.id)).map((r) => r.driver_id);
    await run(c.env, [
      guard(c.env, "EXISTS (SELECT 1 FROM offers WHERE id = ? AND status = 'pending')", f.id),
      ...orderUpdate(c.env, o, { status: 'accepted', driverId: d.uid, driverName: d.name, driverPhone: d.phone, driverVehicle: d.vehicle_type, acceptedAt: now(), price: f.price, priceNegotiated: true }, L('accepted', c.uid, { note: 'offer', price: f.price })),
      st(c.env, "UPDATE offers SET status = CASE WHEN id = ? THEN 'accepted' ELSE 'rejected' END, updated_at = ? WHERE order_id = ? AND status = 'pending'", f.id, now(), o.id),
    ]);
    bg(c, notify(c.env, [d.uid], 'offer_accepted', { price: f.price, no: orderNo(o.id) }, { url: `/#/order/${o.id}` }));
    bg(c, notify(c.env, others, 'offer_rejected', { no: orderNo(o.id) }, { url: '/#/driver' }));
    return { ok: true };
  },
  async 'offers/reject'(c) {
    await need(c, ['customer']);
    const f = await one(c.env, 'SELECT * FROM offers WHERE id = ?', docId(c.body.offerId));
    if (!f) throw new HttpError(404, 'not_found');
    const r = await st(c.env, "UPDATE offers SET status = 'rejected', updated_at = ? WHERE id = ? AND status = 'pending' AND order_id IN (SELECT id FROM orders WHERE customer_id = ?)", now(), f.id, c.uid).run();
    if (!r.meta.changes) throw new HttpError(409, 'bad_state');
    bg(c, notify(c.env, [f.driver_id], 'offer_rejected', { no: orderNo(f.order_id) }, { url: '/#/driver' }));
    return { ok: true };
  },

  // ---------- "متاح لاستقبال الطلبات" (زي أوبر) + آخر موقع معروف ----------
  async 'driver/presence'(c) {
    await need(c, ['driver']);
    if (c.body.online === undefined) {
      const r = await one(c.env, 'SELECT online, seen_at FROM driver_presence WHERE uid = ?', c.uid);
      return { online: !!r?.online, seenAt: r?.seen_at || null };
    }
    const online = c.body.online === true;
    let lat = null, lng = null;
    if (c.body.lat != null) { const p = point(c.body, false); lat = p.lat; lng = p.lng; }
    await st(c.env, `INSERT INTO driver_presence(uid, online, lat, lng, seen_at) VALUES(?,?,?,?,?)
      ON CONFLICT(uid) DO UPDATE SET online = excluded.online, lat = COALESCE(excluded.lat, driver_presence.lat), lng = COALESCE(excluded.lng, driver_presence.lng), seen_at = excluded.seen_at`,
      c.uid, online, lat, lng, now()).run();
    return { online };
  },

  // ---------- أجهزة الإشعارات ----------
  async 'push/register'(c) {
    if (!(await one(c.env, 'SELECT 1 x FROM users WHERE uid = ?', c.uid))) throw new HttpError(403, 'no_profile');
    const token = str(c.body.token, 20, 4096), ua = (c.request?.headers.get('user-agent') || '').slice(0, 120);
    await run(c.env, [
      st(c.env, 'INSERT INTO push_tokens(token, uid, ua, created_at, last_seen) VALUES(?,?,?,?,?) ON CONFLICT(token) DO UPDATE SET uid = excluded.uid, last_seen = excluded.last_seen', token, c.uid, ua, now(), now()),
      st(c.env, 'DELETE FROM push_tokens WHERE uid = ? AND token NOT IN (SELECT token FROM push_tokens WHERE uid = ? ORDER BY last_seen DESC LIMIT 5)', c.uid, c.uid), // 5 أجهزة كحد أقصى للمستخدم
    ]);
    return { ok: true, push: pushEnabled(c.env) };
  },
  async 'push/unregister'(c) {
    await st(c.env, 'DELETE FROM push_tokens WHERE token = ? AND uid = ?', str(c.body.token, 20, 4096), c.uid).run();
    return { ok: true };
  },

  // ---------- العميل يرفع إثبات التحويل (InstaPay) ----------
  async 'orders/pay'(c) {
    await need(c, ['customer']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.customerId !== c.uid) throw new HttpError(403, 'forbidden');
    if (o.status !== (o.payMode === 'before' ? 'awaiting_payment' : 'accepted')) throw new HttpError(409, 'bad_state');
    const proof = fileRef(c.body.proofRef); await ownFiles(c.env, c.uid, [proof]);
    await run(c.env, orderUpdate(c.env, o, { status: 'payment_review', paymentProof: proof, paymentRef: str(c.body.reference ?? '', 0, 40), paymentSubmittedAt: now(), paymentRejectReason: null }, L('payment_review', c.uid)));
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
    await run(c.env, orderUpdate(c.env, o, patch, L(next, c.uid, loc ? { lat: loc.lat, lng: loc.lng } : {})));
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
    const driver = await one(c.env, 'SELECT * FROM users WHERE uid = ?', o.driverId);
    const pct = effectiveCommissionPct(s, o.commissionPct, driver); // خصم مستوى الثقة + عمولة السواق الجديد
    const { commission, net } = split(o.price, pct);
    await run(c.env, [
      ...orderUpdate(c.env, o, { status: 'completed', escrowStatus: 'released', commission, driverNet: net, commissionPctApplied: pct, completedAt: now() }, L('completed', c.uid)),
      walletCredit(c.env, o.driverId, net),
      walletTx(c.env, { uid: o.driverId, type: 'earning', orderId: o.id, amount: net, gross: o.price, commission }),
      st(c.env, 'UPDATE users SET completed_orders = completed_orders + 1 WHERE uid IN (?, ?)', o.driverId, o.customerId),
    ]);
    bg(c, notify(c.env, [o.driverId], 'completed', { net, no: orderNo(o.id) }, { url: '/#/driver/wallet' }));
    return { ok: true, net, commission };
  },

  // ---------- إلغاء ----------
  async 'orders/cancel'(c) {
    await need(c, ['customer', 'driver']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    const s = await loadSettings(c.env);
    const reason = str(c.body.reason ?? '', 0, 200);
    const asCustomer = o.customerId === c.uid, asDriver = o.driverId === c.uid;
    const held = o.escrowStatus === 'held'; // المبلغ محجوز (مدفوع)
    const cancelCount = () => st(c.env, // زيادة عدّاد الإلغاء وتجميد الحساب تلقائياً عند الوصول للحد
      `UPDATE users SET cancel_count = cancel_count + 1,
         status = CASE WHEN cancel_count + 1 >= ? THEN 'suspended' ELSE status END,
         status_reason = CASE WHEN cancel_count + 1 >= ? THEN 'auto_cancellations' ELSE status_reason END WHERE uid = ?`,
      s.maxCancellations, s.maxCancellations, c.uid);

    // (1) العميل بعد قبول سواق على طلب مدفوع: إلغاء برسوم — نسبة تعويض للسواق + نسبة للمنصة + الباقي للعميل (النسب من الأدمن)
    if (asCustomer && held && ['paid', 'heading_pickup'].includes(o.status)) {
      const heading = o.status === 'heading_pickup';
      const dp = heading ? s.cancelHeadingDriverPct : s.cancelPaidDriverPct, pp = heading ? s.cancelHeadingPlatformPct : s.cancelPaidPlatformPct;
      const { driver, platform, refund: back } = cancelSplit(o.price, dp, pp);
      const stmts = [
        ...orderUpdate(c.env, o, { status: 'cancelled', escrowStatus: 'settled', cancelledBy: 'customer', cancelReason: reason, commission: platform, driverNet: driver, customerRefund: back, cancelFee: { driverPct: dp, platformPct: pp } }, L('cancelled', c.uid, { note: 'cancel_after_accept', reason })),
        cancelCount(),
      ];
      if (driver > 0) stmts.push(walletCredit(c.env, o.driverId, driver), walletTx(c.env, { uid: o.driverId, type: 'cancel_compensation', orderId: o.id, amount: driver, gross: o.price, commission: platform }));
      if (back > 0) stmts.push(refundInsert(c.env, { ...o, price: back }, 'cancelled_after_accept'));
      await run(c.env, stmts);
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
    if (status === 'cancelled') stmts.push(st(c.env, "UPDATE offers SET status = 'rejected', updated_at = ? WHERE order_id = ? AND status = 'pending'", now(), o.id));
    if (counts) stmts.push(cancelCount());
    await run(c.env, stmts);
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
    await run(c.env, [
      ...orderUpdate(c.env, o, { [field]: { stars, comment: str(c.body.comment ?? '', 0, 300), at: now() } }),
      st(c.env, 'UPDATE users SET rating_sum = rating_sum + ?, rating_count = rating_count + 1 WHERE uid = ?', stars, asCustomer ? o.driverId : o.customerId),
    ]);
    return { ok: true };
  },

  // ---------- المحفظة والسحب ----------
  async wallet(c) {
    await need(c, ['driver']);
    const w = await one(c.env, 'SELECT balance, total_earned FROM wallets WHERE uid = ?', c.uid);
    const tx = await all(c.env, 'SELECT * FROM wallet_tx WHERE uid = ? ORDER BY at DESC LIMIT 40', c.uid);
    const wd = await all(c.env, 'SELECT * FROM withdrawals WHERE uid = ? ORDER BY created_at DESC LIMIT 40', c.uid);
    return { wallet: { balance: w?.balance || 0, totalEarned: w?.total_earned || 0 }, tx: tx.map(txOut), withdrawals: wd.map(withdrawalOut) };
  },

  // بيخصم من المحفظة فوراً ويحجز المبلغ لحد قرار الأدمن. الحراسة + CHECK(balance>=0) بيمنعوا السحب المزدوج.
  async 'withdrawals/create'(c) {
    const u = await need(c, ['driver']);
    const s = await loadSettings(c.env);
    const amount = int(c.body.amount, s.minWithdraw, 10000000, 'below_min');
    const method = c.body.method;
    if (!['instapay', 'vodafone', 'bank'].includes(method)) throw new HttpError(400, 'bad_method');
    const account = str(c.body.account, 5, 60), id = newId();
    try {
      await run(c.env, [
        guard(c.env, '(SELECT COALESCE(MAX(balance), 0) FROM wallets WHERE uid = ?) >= ?', c.uid, amount),
        st(c.env, 'UPDATE wallets SET balance = balance - ?, updated_at = ? WHERE uid = ?', amount, now(), c.uid),
        st(c.env, "INSERT INTO withdrawals(id, uid, name, phone, amount, method, account, status, created_at) VALUES(?,?,?,?,?,?,?,'pending',?)", id, c.uid, u.name, u.phone, amount, method, account, now()),
        walletTx(c.env, { uid: c.uid, type: 'withdrawal', amount: -amount, withdrawalId: id }),
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
    await run(c.env, [
      ...orderUpdate(c.env, o, { status: 'disputed', prevStatus: o.status, disputeId: id }, L('disputed', c.uid)),
      st(c.env, "INSERT INTO disputes(id, order_id, customer_id, driver_id, opened_by, opened_by_role, reason, details, evidence, order_price, status, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'open',?)",
        id, o.id, o.customerId, o.driverId, c.uid, asCustomer ? 'customer' : 'driver', c.body.reason, str(c.body.details ?? '', 0, 1000), JSON.stringify(evidence), o.price, now()),
    ]);
    toAdmins(c, 'dispute', { no: orderNo(o.id) }, '/#/admin/disputes');
    bg(c, notify(c.env, [asCustomer ? o.driverId : o.customerId], 'dispute', { no: orderNo(o.id) }, { url: `/#/order/${o.id}` }));
    return { ok: true, id };
  },

  // =====================  الأدمن  =====================
  // أرقام الشارات (خفيفة: كلها على index الحالة) — بتتسحب كل ~20 ثانية
  async 'admin/badges'(c) {
    await need(c, ['admin']);
    const r = await c.env.DB.batch([
      st(c.env, "SELECT COUNT(*) n FROM orders WHERE status = 'payment_review'"), st(c.env, "SELECT COUNT(*) n FROM users WHERE status = 'pending'"),
      st(c.env, "SELECT COUNT(*) n FROM withdrawals WHERE status = 'pending'"), st(c.env, "SELECT COUNT(*) n FROM disputes WHERE status = 'open'"),
      st(c.env, "SELECT COUNT(*) n FROM refunds WHERE status = 'pending'"),
      st(c.env, "SELECT (SELECT COUNT(*) FROM reports WHERE status = 'open') + (SELECT COUNT(*) FROM sos_events WHERE status = 'open') n"),
    ]);
    const n = (i) => r[i].results[0].n;
    return { badges: { payments: n(0), users: n(1), withdrawals: n(2), disputes: n(3), refunds: n(4), reports: n(5) } };
  },

  // إحصائيات كاملة على كل الطلبات (بتتحسب بـ SQL — مش محدودة بآخر 500 زي النسخة القديمة)
  async 'admin/stats'(c) {
    await need(c, ['admin']);
    const since = now() - 14 * 86400e3;
    const r = await c.env.DB.batch([
      st(c.env, `SELECT COUNT(*) total,
        COALESCE(SUM(CASE WHEN status NOT IN ('completed','cancelled','resolved') THEN 1 ELSE 0 END), 0) active,
        COALESCE(SUM(CASE WHEN escrow_status IN ('released','settled') THEN price - COALESCE(customer_refund, 0) END), 0) revenue,
        COALESCE(SUM(CASE WHEN escrow_status IN ('released','settled') THEN commission END), 0) commission,
        COALESCE(SUM(CASE WHEN escrow_status = 'held' THEN price END), 0) held FROM orders`),
      st(c.env, "SELECT role, COUNT(*) n FROM users WHERE status = 'active' GROUP BY role"),
      st(c.env, "SELECT u.name, COUNT(*) n, COALESCE(SUM(o.driver_net), 0) earned FROM orders o JOIN users u ON u.uid = o.driver_id WHERE o.status IN ('completed','resolved') GROUP BY o.driver_id ORDER BY n DESC LIMIT 5"),
      st(c.env, "SELECT strftime('%Y-%m-%d', created_at / 1000 + 7200, 'unixepoch') d, COUNT(*) n FROM orders WHERE created_at >= ? GROUP BY d", since),
      st(c.env, "SELECT COALESCE(SUM(amount), 0) n FROM refunds WHERE status = 'pending'"),
    ]);
    const roles = Object.fromEntries(r[1].results.map((x) => [x.role, x.n]));
    return { totals: r[0].results[0], activeDrivers: roles.driver || 0, activeCustomers: roles.customer || 0, topDrivers: r[2].results, perDay: r[3].results, refundsDue: r[4].results[0].n };
  },

  async 'admin/users'(c) {
    await need(c, ['admin']);
    const w = ["role != 'admin'"], p = [];
    if (['customer', 'driver'].includes(c.body.role)) { w.push('role = ?'); p.push(c.body.role); }
    if (c.body.status) { w.push('status = ?'); p.push(String(c.body.status)); }
    const q = String(c.body.q ?? '').trim().slice(0, 40);
    if (q) { w.push('(name LIKE ? OR phone LIKE ? OR email LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const rows = await all(c.env, `SELECT * FROM users WHERE ${w.join(' AND ')} ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 300`, ...p);
    return { users: rows.map((r) => { const u = userOut(r); if (r.role === 'driver') u.trust = trustOf(r); return u; }) };
  },

  async 'admin/user'(c) {
    const admin = await need(c, ['admin']);
    const target = await one(c.env, 'SELECT * FROM users WHERE uid = ?', uidOf(c.body.uid));
    if (!target) throw new HttpError(404, 'user_not_found');
    if (target.role === 'admin') throw new HttpError(403, 'forbidden');
    const status = c.body.status;
    if (!['active', 'rejected', 'banned', 'pending'].includes(status)) throw new HttpError(400, 'bad_status');
    const reason = str(c.body.reason ?? '', 0, 200);
    const stmts = [st(c.env, 'UPDATE users SET status = ?, status_reason = ?, reviewed_by = ?, reviewed_at = ? WHERE uid = ?', status, reason, admin.uid, now(), target.uid)];
    if (status === 'banned' && c.body.blacklist) {
      for (const [type, value] of [['phone', target.phone], ['nid', target.national_id]]) {
        if (value) stmts.push(st(c.env, 'INSERT OR REPLACE INTO blacklist(k, type, value, reason, at) VALUES(?,?,?,?,?)', `${type}_${value}`, type, value, reason, now()));
      }
    }
    await run(c.env, stmts);
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
    await run(c.env, orderUpdate(c.env, o, patch, L(logStatus, admin.uid, pre && c.body.action === 'confirm' ? { note: 'prepaid_confirmed' } : {})));
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
    await run(c.env, orderUpdate(c.env, o, { price, priceOverridden: true, priceNote: str(c.body.note ?? '', 0, 200) }, L(o.status, admin.uid, { note: 'price_override', price })));
    return { ok: true };
  },

  async 'admin/withdrawals'(c) {
    await need(c, ['admin']);
    const rows = await all(c.env, "SELECT * FROM withdrawals ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 200");
    return { withdrawals: rows.map(withdrawalOut) };
  },

  async 'admin/withdrawal'(c) {
    const admin = await need(c, ['admin']);
    const w = await one(c.env, 'SELECT * FROM withdrawals WHERE id = ?', docId(c.body.id));
    if (!w) throw new HttpError(404, 'not_found');
    if (w.status !== 'pending') throw new HttpError(409, 'bad_state');
    const note = str(c.body.note ?? '', 0, 200);
    const pend = guard(c.env, "EXISTS (SELECT 1 FROM withdrawals WHERE id = ? AND status = 'pending')", w.id);
    const mark = (s) => st(c.env, 'UPDATE withdrawals SET status = ?, note = ?, decided_by = ?, decided_at = ? WHERE id = ?', s, note, admin.uid, now(), w.id);
    if (c.body.action === 'paid') await run(c.env, [pend, mark('paid')]);
    else if (c.body.action === 'reject') await run(c.env, [pend, mark('rejected'), walletCredit(c.env, w.uid, w.amount), walletTx(c.env, { uid: w.uid, type: 'withdrawal_refund', amount: w.amount, withdrawalId: w.id })]);
    else throw new HttpError(400, 'bad_action');
    bg(c, notify(c.env, [w.uid], c.body.action === 'paid' ? 'withdrawal_paid' : 'withdrawal_rejected', { amount: w.amount }, { url: '/#/driver/wallet' }));
    return { ok: true };
  },

  async 'admin/disputes'(c) {
    await need(c, ['admin']);
    const rows = await all(c.env, "SELECT * FROM disputes ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC LIMIT 100");
    const ids = [...new Set(rows.map((r) => r.order_id))];
    const orders = ids.length ? await all(c.env, `SELECT * FROM orders WHERE id IN (${inList(ids)})`, ...ids) : [];
    const byId = Object.fromEntries(orders.map((o) => [o.id, orderOut(hydrateOrder(o), { role: 'admin' })]));
    const msgs = ids.length ? await all(c.env, `SELECT rowid AS seq, * FROM messages WHERE order_id IN (${inList(ids)}) ORDER BY rowid LIMIT 400`, ...ids) : [];
    const chatOf = (oid) => msgs.filter((m) => m.order_id === oid).map((m) => ({ from: m.sender_id === byId[oid]?.customerId ? 'customer' : m.sender_id === byId[oid]?.driverId ? 'driver' : 'admin', body: m.body, at: m.created_at }));
    return { disputes: rows.map((r) => ({ ...disputeOut(r), order: byId[r.order_id] || null, chat: chatOf(r.order_id) })) };
  },

  // ---------- حسم النزاع: رد كامل للعميل / تحويل كامل للسواق / تقسيم بنسبة ----------
  async 'admin/dispute'(c) {
    const admin = await need(c, ['admin']);
    const d = await one(c.env, 'SELECT * FROM disputes WHERE id = ?', docId(c.body.id));
    if (!d) throw new HttpError(404, 'not_found');
    if (d.status !== 'open') throw new HttpError(409, 'bad_state');
    const o = await loadOrder(c.env, d.order_id);
    if (o.status !== 'disputed') throw new HttpError(409, 'bad_state');
    const pct = c.body.decision === 'refund' ? 100 : c.body.decision === 'release' ? 0 : c.body.decision === 'split' ? int(c.body.customerPct, 1, 99) : null;
    if (pct === null) throw new HttpError(400, 'bad_decision');
    const note = str(c.body.note ?? '', 0, 500);
    const customerRefund = Math.round((o.price * pct) / 100);
    const driverGross = o.price - customerRefund;
    const pct_ = effectiveCommissionPct(await loadSettings(c.env), o.commissionPct, await one(c.env, 'SELECT * FROM users WHERE uid = ?', o.driverId));
    const { commission, net } = driverGross > 0 ? split(driverGross, pct_) : { commission: 0, net: 0 };
    const stmts = [
      guard(c.env, "EXISTS (SELECT 1 FROM disputes WHERE id = ? AND status = 'open')", d.id),
      st(c.env, "UPDATE disputes SET status = 'resolved', decision = ?, customer_pct = ?, customer_refund = ?, driver_net = ?, commission = ?, note = ?, refund_paid = ?, resolved_by = ?, resolved_at = ? WHERE id = ?",
        c.body.decision, pct, customerRefund, net, commission, note, customerRefund === 0, admin.uid, now(), d.id),
      ...orderUpdate(c.env, o, { status: 'resolved', escrowStatus: 'settled', commission, driverNet: net, customerRefund, resolution: c.body.decision }, L('resolved', admin.uid)),
    ];
    if (net > 0) stmts.push(walletCredit(c.env, o.driverId, net), walletTx(c.env, { uid: o.driverId, type: 'dispute_earning', orderId: o.id, amount: net, gross: driverGross, commission }));
    await run(c.env, stmts);
    return { ok: true, customerRefund, driverNet: net };
  },

  async 'admin/dispute-refund'(c) { // الأدمن يأكد إنه رد المبلغ للعميل يدوياً (InstaPay)
    await need(c, ['admin']);
    const r = await st(c.env, "UPDATE disputes SET refund_paid = 1, refund_paid_at = ? WHERE id = ? AND status = 'resolved'", now(), docId(c.body.id)).run();
    if (!r.meta.changes) throw new HttpError(409, 'bad_state');
    return { ok: true };
  },

  // ---------- بلاغات (سلوك مسيء/احتيال/قيادة غير آمنة...) ----------
  async 'reports/create'(c) {
    const u = await need(c, ['customer', 'driver']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.customerId !== c.uid && o.driverId !== c.uid) throw new HttpError(403, 'forbidden');
    if (!o.driverId) throw new HttpError(409, 'bad_state');
    if (!REPORT_REASONS.includes(c.body.reason)) throw new HttpError(400, 'bad_reason');
    if ((await one(c.env, 'SELECT COUNT(*) n FROM reports WHERE reporter_id = ? AND created_at > ?', c.uid, now() - 3600e3)).n >= 5) throw new HttpError(429, 'too_many_reports');
    const chat = (await all(c.env, 'SELECT sender_id, body, created_at FROM messages WHERE order_id = ? ORDER BY rowid DESC LIMIT 30', o.id)).reverse()
      .map((m) => ({ from: m.sender_id === o.customerId ? 'customer' : m.sender_id === o.driverId ? 'driver' : 'admin', body: m.body, at: m.created_at })); // لقطة من الشات كدليل
    const id = newId();
    await run(c.env, [st(c.env, "INSERT INTO reports(id, reporter_id, target_id, order_id, reason, details, context, status, created_at) VALUES(?,?,?,?,?,?,?,'open',?)",
      id, c.uid, c.uid === o.customerId ? o.driverId : o.customerId, o.id, c.body.reason, str(c.body.details ?? '', 0, 1000), JSON.stringify({ chat, orderStatus: o.status }), now())]);
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
    const open = await one(c.env, "SELECT id, updated_at FROM sos_events WHERE order_id = ? AND user_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1", o.id, c.uid);
    let id, notifyNow = true;
    if (open) { // ضغطة تانية على نفس الاستغاثة المفتوحة: نحدّث الموقع بس (وما نزعجش الأدمن أكتر من مرة كل دقيقة)
      id = open.id; notifyNow = now() - open.updated_at > 60000;
      await st(c.env, 'UPDATE sos_events SET lat = COALESCE(?, lat), lng = COALESCE(?, lng), updated_at = ? WHERE id = ?', lat, lng, now(), id).run();
    } else {
      if ((await one(c.env, 'SELECT COUNT(*) n FROM sos_events WHERE user_id = ? AND created_at > ?', c.uid, now() - 3600e3)).n >= 3) throw new HttpError(429, 'too_many_reports');
      id = newId();
      await st(c.env, "INSERT INTO sos_events(id, order_id, user_id, lat, lng, status, created_at, updated_at) VALUES(?,?,?,?,?,'open',?,?)", id, o.id, c.uid, lat, lng, now(), now()).run();
    }
    if (notifyNow) toAdmins(c, 'sos', { no: orderNo(o.id), name: u.name }, '/#/admin/reports');
    return { ok: true, id, emergency: { police: '122', ambulance: '123' } };
  },

  async 'admin/reports'(c) {
    await need(c, ['admin']);
    const rs = await all(c.env, `SELECT r.*, a.name AS reporter_name, a.phone AS reporter_phone, b.name AS target_name, b.phone AS target_phone
      FROM reports r LEFT JOIN users a ON a.uid = r.reporter_id LEFT JOIN users b ON b.uid = r.target_id
      ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END, r.created_at DESC LIMIT 100`);
    const ss = await all(c.env, `SELECT e.*, u.name AS user_name, u.phone AS user_phone, o.data AS odata FROM sos_events e LEFT JOIN users u ON u.uid = e.user_id LEFT JOIN orders o ON o.id = e.order_id
      ORDER BY CASE e.status WHEN 'open' THEN 0 ELSE 1 END, e.created_at DESC LIMIT 50`);
    const jp = (x) => { try { return JSON.parse(x || '{}'); } catch { return {}; } };
    return {
      reports: rs.map((r) => ({ id: r.id, orderId: r.order_id, reason: r.reason, details: r.details, status: r.status, adminNote: r.admin_note, createdAt: r.created_at, handledAt: r.handled_at,
        reporter: { name: r.reporter_name, phone: r.reporter_phone }, target: { uid: r.target_id, name: r.target_name, phone: r.target_phone }, context: jp(r.context) })),
      sos: ss.map((e) => { const d = jp(e.odata); return { id: e.id, orderId: e.order_id, status: e.status, note: e.note, lat: e.lat, lng: e.lng, createdAt: e.created_at, updatedAt: e.updated_at,
        by: { name: e.user_name, phone: e.user_phone }, customer: { name: d.customerName, phone: d.customerPhone }, driver: { name: d.driverName, phone: d.driverPhone }, pickup: d.pickup, dropoff: d.dropoff }; }),
    };
  },
  async 'admin/report'(c) {
    const admin = await need(c, ['admin']);
    const r = await one(c.env, 'SELECT * FROM reports WHERE id = ?', docId(c.body.id));
    if (!r) throw new HttpError(404, 'not_found');
    if (r.status !== 'open') throw new HttpError(409, 'bad_state');
    if (!['resolve', 'dismiss'].includes(c.body.action)) throw new HttpError(400, 'bad_action');
    await run(c.env, [
      guard(c.env, "EXISTS (SELECT 1 FROM reports WHERE id = ? AND status = 'open')", r.id),
      st(c.env, 'UPDATE reports SET status = ?, admin_note = ?, handled_by = ?, handled_at = ? WHERE id = ?', c.body.action === 'resolve' ? 'resolved' : 'dismissed', str(c.body.note ?? '', 0, 500), admin.uid, now(), r.id),
    ]);
    bg(c, notify(c.env, [r.reporter_id], 'report_handled', { no: orderNo(r.order_id) }, { url: `/#/order/${r.order_id}` }));
    return { ok: true };
  },
  async 'admin/sos-handle'(c) {
    const admin = await need(c, ['admin']);
    const r = await st(c.env, "UPDATE sos_events SET status = 'handled', note = ?, handled_by = ?, handled_at = ? WHERE id = ? AND status = 'open'", str(c.body.note ?? '', 0, 500), admin.uid, now(), docId(c.body.id)).run();
    if (!r.meta.changes) throw new HttpError(409, 'bad_state');
    return { ok: true };
  },

  // ---------- استرجاع الفلوس (يدوي على InstaPay) ----------
  async 'admin/refunds'(c) {
    await need(c, ['admin']);
    const rows = await all(c.env, `SELECT r.*, u.name AS customer_name, u.phone AS customer_phone FROM refunds r LEFT JOIN users u ON u.uid = r.customer_id
      ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.created_at DESC LIMIT 200`);
    return { refunds: rows.map((r) => ({ id: r.id, orderId: r.order_id, customerId: r.customer_id, customerName: r.customer_name, customerPhone: r.customer_phone, amount: r.amount, reason: r.reason, status: r.status, note: r.note, createdAt: r.created_at, paidAt: r.paid_at })) };
  },
  async 'admin/refund'(c) { // الأدمن حوّل المبلغ للعميل فعلاً => "تم"
    const admin = await need(c, ['admin']);
    const f = await one(c.env, 'SELECT * FROM refunds WHERE id = ?', docId(c.body.id));
    if (!f) throw new HttpError(404, 'not_found');
    if (f.status !== 'pending') throw new HttpError(409, 'bad_state');
    const o = await loadOrder(c.env, f.order_id);
    await run(c.env, [
      guard(c.env, "EXISTS (SELECT 1 FROM refunds WHERE id = ? AND status = 'pending')", f.id),
      st(c.env, "UPDATE refunds SET status = 'paid', note = ?, paid_at = ?, paid_by = ? WHERE id = ?", str(c.body.note ?? '', 0, 200), now(), admin.uid, f.id),
      ...orderUpdate(c.env, o, o.escrowStatus === 'refund_pending' ? { escrowStatus: 'refunded' } : {}, L(o.status, admin.uid, { note: 'refund_paid' })), // لو الطلب فيه رسوم إلغاء (settled) بنسيبه زي ما هو عشان الإيراد يفضل محسوب
    ]);
    bg(c, notify(c.env, [f.customer_id], 'refund_paid', { no: orderNo(f.order_id), amount: f.amount }, { url: `/#/order/${f.order_id}` }));
    return { ok: true };
  },

  // ---------- الشات بين العميل والسواق (بيفتح بعد ما سواق يتحدد) ----------
  async 'chat/list'(c) {
    const u = await viewer(c);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (!(o.customerId === c.uid || o.driverId === c.uid || u.role === 'admin')) throw new HttpError(403, 'forbidden');
    if (!o.driverId) throw new HttpError(409, 'chat_closed');
    const rows = await all(c.env, 'SELECT rowid AS seq, * FROM messages WHERE order_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT 200', o.id, Math.max(0, Math.floor(Number(c.body.after) || 0)));
    return { open: CHAT_OPEN.includes(o.status), messages: rows.map((m) => ({ seq: m.seq, id: m.id, mine: m.sender_id === c.uid, from: m.sender_id === o.customerId ? 'customer' : m.sender_id === o.driverId ? 'driver' : 'admin', body: m.body, at: m.created_at })) };
  },
  async 'chat/send'(c) {
    const u = await need(c, ['customer', 'driver']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.customerId !== c.uid && o.driverId !== c.uid) throw new HttpError(403, 'forbidden');
    if (!o.driverId || !CHAT_OPEN.includes(o.status)) throw new HttpError(409, 'chat_closed');
    const body = str(c.body.body, 1, 500);
    if ((await one(c.env, 'SELECT COUNT(*) n FROM messages WHERE sender_id = ? AND created_at > ?', c.uid, now() - 60000)).n >= 20) throw new HttpError(429, 'too_many_messages');
    const id = newId();
    await run(c.env, [st(c.env, 'INSERT INTO messages(id, order_id, sender_id, body, created_at) VALUES(?,?,?,?,?)', id, o.id, c.uid, body, now())]);
    bg(c, notify(c.env, [c.uid === o.customerId ? o.driverId : o.customerId], 'chat', { name: u.name, text: body.slice(0, 120) }, { url: `/#/order/${o.id}`, tag: `chat-${o.id}` }));
    return { ok: true, id };
  },

  async 'admin/settings/save'(c) {
    await need(c, ['admin']);
    const clean = sanitizeSettings(c.body);
    await st(c.env, "INSERT INTO settings(k, v) VALUES('pricing', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify(clean)).run();
    return { settings: await loadSettings(c.env) };
  },

  async 'admin/blacklist'(c) {
    await need(c, ['admin']);
    return { items: (await all(c.env, 'SELECT * FROM blacklist ORDER BY at DESC LIMIT 500')).map((r) => ({ id: r.k, type: r.type, value: r.value, reason: r.reason, at: r.at })) };
  },
  async 'admin/blacklist/add'(c) {
    await need(c, ['admin']);
    const type = c.body.type, value = String(c.body.value ?? '').replace(/\D/g, '');
    if (!['phone', 'nid'].includes(type) || (type === 'phone' && !/^01[0125]\d{8}$/.test(value)) || (type === 'nid' && !/^\d{14}$/.test(value))) throw new HttpError(400, 'bad_input');
    await st(c.env, 'INSERT OR REPLACE INTO blacklist(k, type, value, reason, at) VALUES(?,?,?,?,?)', `${type}_${value}`, type, value, str(c.body.reason ?? '', 0, 200), now()).run();
    return { ok: true };
  },
  async 'admin/blacklist/remove'(c) {
    await need(c, ['admin']);
    await st(c.env, 'DELETE FROM blacklist WHERE k = ?', str(c.body.id, 3, 40)).run();
    return { ok: true };
  },
};

// =====================================================================
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

// تشخيص الربط: افتح /api/health بعد النشر. بيرجّع true/false فقط (بدون أي قيم سرية).
async function health(env) {
  const out = { db: !!env.DB, schema: false, filesDb: !!env.FILES, filesSchema: !env.FILES, r2: !!env.BUCKET, push: pushEnabled(env), projectId: !!env.FIREBASE_PROJECT_ID && !String(env.FIREBASE_PROJECT_ID).startsWith('YOUR_') };
  const has = (db, table) => db.prepare("SELECT 1 x FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).first().then((r) => !!r).catch(() => false);
  if (env.DB) out.schema = await has(env.DB, 'users');
  if (env.FILES) out.filesSchema = await has(env.FILES, 'file_blobs');
  out.ok = out.db && out.schema && out.filesSchema && out.projectId;
  return out;
}

export async function onRequest({ request, env, params, waitUntil }) {
  try {
    const route = [].concat(params.route || []).join('/');
    if (request.method === 'GET' && route === 'health') return json(await health(env));
    if (!env.DB) throw new HttpError(500, 'missing_db_binding');
    const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const isFileGet = request.method === 'GET' && route.startsWith('files/');
    if (request.method !== 'POST' && !isFileGet) throw new HttpError(405, 'method_not_allowed');
    if (!bearer) throw new HttpError(401, 'unauthenticated');
    const token = await verifyIdToken(bearer, env.FIREBASE_PROJECT_ID);
    if (isFileGet) {
      const role = (await one(env, 'SELECT role FROM users WHERE uid = ?', token.uid))?.role;
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
