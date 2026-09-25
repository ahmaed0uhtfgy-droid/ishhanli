// كل المنطق الحساس (الصلاحيات، السعر، Escrow، العمولة، المحفظة، النزاعات) بيتنفذ هنا فوق Firestore.
// المتصفح مالوش وصول مباشر لقاعدة البيانات (Firestore rules بترفض أي وصول مباشر من العميل):
// كل قراءة وكتابة بتعدّي من هنا وبتتفلتر حسب دور المستخدم — بالظبط زي النسخة القديمة فوق Cloudflare D1،
// وبنفس أسماء الـ routes بالظبط عشان public/js (الواجهة) تفضل شغالة من غير أي تعديل.
import { HttpError, verifyIdToken, newId } from '../_lib/core.js';
import {
  initDb, now, runTx, FieldValue, mapDbError,
  usersCol, ordersCol, walletsCol, withdrawalsCol, disputesCol, refundsCol, offersCol, reportsCol, sosCol,
  blacklistCol, uniqueIndexCol, settingsDoc, filesMetaCol, presenceCol, pushTokensCol, liveLocCol,
  walletTxCol, messagesCol, walletCreditTx, walletTxTx,
  userOut, withdrawalOut, txOut, disputeOut, loadOrder, orderFromSnap, orderOut, orderPatch,
} from '../_lib/db.js';
import {
  loadSettings, sanitizeSettings, distanceKm, calcPrice, calcPassengerPrice,
  effectiveCommissionPct, canServe, cancelSplit, haversineM, split,
} from '../_lib/logic.js';
import { saveFile, ownFiles, readFile } from '../_lib/files.js';
import { notify, dispatchNewOrder, adminIds, orderNo, pushEnabled } from '../_lib/push.js';
import { trustOf } from '../_lib/trust.js';
import { AggregateField } from '../_lib/firestore.js';

// كل طلب بيوصل Cloudflare Worker جديد أو دافئ (isolate) — initDb بتتأكد إن حساب الخدمة اتحمّل مرة واحدة بس
// لكل isolate (مش هيعيد التوثيق مع كل طلب لو الـ isolate لسه دافئ).
function boot(env) {
  // بنقبل الاسمين (FIREBASE_SERVICE_ACCOUNT_JSON أو FIREBASE_SERVICE_ACCOUNT) ونطلّع رسالة واضحة لو فيه مشكلة
  const raw = env.FIREBASE_SERVICE_ACCOUNT_JSON ?? env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('config_error: secret FIREBASE_SERVICE_ACCOUNT_JSON is MISSING at runtime (add it under Settings > Runtime > Variables and secrets, not Build)');
  let sa;
  try { sa = typeof raw === 'string' ? JSON.parse(raw.trim()) : raw; } catch (e) { throw new Error('config_error: FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON (paste the whole file from { to }): ' + e.message); }
  if (!sa.client_email || !sa.private_key || !sa.project_id) throw new Error('config_error: service account JSON is missing client_email / private_key / project_id');
  initDb(sa);
  return sa.project_id;
}

// ---------- تحقق من المدخلات (نفس النسخة الأصلية بالظبط) ----------
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
const L = (status, by, extra = {}) => ({ status, by, ...extra }); // سجل الحالات (دليل في النزاعات) — الوقت بيتضاف في orderPatch
const inList10 = (arr) => arr.slice(0, 10); // حد "in" في Firestore = 10 قيم

// ---------- المستخدم الحالي ----------
async function need(req, roles) {
  const snap = await usersCol().doc(req.uid).get();
  if (!snap.exists) throw new HttpError(403, 'no_profile');
  const r = { uid: snap.id, ...snap.data() };
  if (!roles.includes(r.role)) throw new HttpError(403, 'forbidden');
  if (r.status !== 'active') throw new HttpError(403, 'account_not_active');
  return userOut(r);
}
async function viewer(req) {
  const snap = await usersCol().doc(req.uid).get();
  const u = snap.exists ? userOut({ uid: snap.id, ...snap.data() }) : null;
  if (!u) throw new HttpError(403, 'no_profile');
  if (u.status !== 'active' && u.role !== 'admin') throw new HttpError(403, 'account_not_active');
  return u;
}
async function rawUser(uid) { const s = await usersCol().doc(uid).get(); return s.exists ? { uid: s.id, ...s.data() } : null; }

const REPORT_REASONS = ['abuse', 'harassment', 'unsafe', 'fraud', 'no_show', 'other'];
const CHAT_OPEN = ['accepted', 'payment_review', 'paid', 'heading_pickup', 'picked_up', 'in_transit', 'delivered', 'disputed'];
const HELD = ['paid', 'heading_pickup', 'picked_up', 'in_transit', 'delivered'];
const ACTIVE = ['heading_pickup', 'picked_up', 'in_transit'];
const NEXT = { paid: 'heading_pickup', heading_pickup: 'picked_up', picked_up: 'in_transit', in_transit: 'delivered' };

// إرسال الإشعارات: بعد الهجرة لـ Cloud Functions (بدل waitUntil بتاع Workers) بنستنى الإرسال فعلياً قبل الرد
// (أسرع بكتير هنا لأننا بنستخدم admin.messaging() مباشرة، وده بيضمن التوصيل بدل ما يضيع لو الـ instance اتقفل بعد الرد)
const bg = (p) => Promise.resolve(p).catch((e) => console.error('bg_failed', e?.message || e));
const refundInsert = (batchOrTx, o, reason) => {
  const ref = refundsCol().doc(o.id); // orderId كمعرّف = يمنع أكتر من استرجاع لنفس الطلب (بديل UNIQUE INDEX)
  batchOrTx.set(ref, { id: o.id, orderId: o.id, customerId: o.customerId, amount: o.price, reason, status: 'pending', createdAt: now() });
};
const afterRefundRequest = async (o) => {
  await toAdmins('refund_due', { no: orderNo(o.id), amount: o.price }, '/#/admin/refunds');
  await bg(notify([o.customerId], 'refund_pending', { no: orderNo(o.id), amount: o.price }, { url: `/#/order/${o.id}` }));
};
async function toAdmins(type, vars, url) { await bg(notify(await adminIds(), type, vars, { url })); }

/** طلب مدفوع مقدماً ماحدش قبله لحد ميعاده + المهلة: بيتلغي ويتسجّل استرجاع للعميل (بدون Cron: بيتنفذ عند القراءة) */
async function expireOrder(o) {
  const ref = ordersCol().doc(o.id);
  const ok = await runTx(async (tx) => {
    const snap = await tx.get(ref);
    const cur = orderFromSnap(snap);
    if (cur.status !== 'open' || cur.escrowStatus !== 'held') return false;
    tx.update(ref, orderPatch({ status: 'cancelled', escrowStatus: 'refund_pending', cancelledBy: 'system', cancelReason: 'no_driver' }, L('cancelled', 'system', { note: 'expired_no_driver' })));
    refundInsert(tx, cur, 'no_driver');
    return true;
  }).catch((e) => { console.error('expire_failed', e?.message); return false; });
  if (ok) {
    await notify([o.customerId], 'refund_pending', { no: orderNo(o.id), amount: o.price }, { url: `/#/order/${o.id}` });
    await notify(await adminIds(), 'refund_due', { no: orderNo(o.id), amount: o.price }, { url: '/#/admin/refunds' });
  }
  return ok;
}
let lastSweep = 0;
async function sweepExpired() {
  if (Date.now() - lastSweep < 30000) return; // نفحص كل 30 ثانية كحد أقصى (لكل instance دافئة)
  lastSweep = Date.now();
  const s = await loadSettings();
  const cutoff = now() - s.prepaidGraceMin * 60000;
  const snap = await ordersCol().where('status', '==', 'open').where('escrowStatus', '==', 'held').where('scheduledAt', '<', cutoff).limit(10).get();
  for (const d of snap.docs) await expireOrder({ id: d.id, ...d.data() }).catch((e) => console.error('expire_failed', e?.message));
}

// =====================================================================
const ROUTES = {
  // ---------- عام ----------
  async settings() { return { settings: await loadSettings() }; },
  async me({ uid }) {
    const snap = await usersCol().doc(uid).get();
    const r = snap.exists ? { uid: snap.id, ...snap.data() } : null;
    const profile = r ? userOut(r) : null;
    if (profile && profile.role === 'driver') {
      const s = await loadSettings();
      profile.trust = { ...trustOf(r), commissionPct: effectiveCommissionPct(s, s.commissionPct, r) };
    }
    return { profile };
  },

  // ---------- التسجيل: فحص القائمة السوداء + منع التكرار (بدل UNIQUE في SQL: uniqueIndex + transaction) ----------
  async register({ uid, token, body }) {
    const role = body.role;
    if (!['customer', 'driver'].includes(role)) throw new HttpError(400, 'bad_role');
    const phone = phoneOf(body.phone);
    const driver = role === 'driver';
    // الرقم القومي وصورة البطاقة مطلوبين للسواق فقط — العميل مش محتاجهم
    let nid = null;
    if (driver) {
      nid = String(body.nationalId ?? '').replace(/\D/g, '');
      if (!/^[23]\d{13}$/.test(nid)) throw new HttpError(400, 'bad_national_id');
    }
    const name = str(body.name, 2, 80), area = str(body.area ?? '', 0, 60), lang = body.lang === 'en' ? 'en' : 'ar';
    const refs = {};
    let vehicleType = null;
    if (driver) {
      refs.id = fileRef(body.idRef);
      vehicleType = str(body.vehicleType, 2, 40);
      refs.license = fileRef(body.licenseRef); refs.vehicleReg = fileRef(body.vehicleRegRef); refs.vehiclePhoto = fileRef(body.vehiclePhotoRef);
    }
    await ownFiles(uid, Object.values(refs));
    const phoneKey = `phone_${phone}`, nidKey = nid ? `nid_${nid}` : null;
    const s = await loadSettings();
    const userRef = usersCol().doc(uid);
    const status = await runTx(async (tx) => {
      const [userSnap, phoneIdx, nidIdx, phoneBl, nidBl] = await Promise.all([
        tx.get(userRef), tx.get(uniqueIndexCol().doc(phoneKey)), nidKey ? tx.get(uniqueIndexCol().doc(nidKey)) : null,
        tx.get(blacklistCol().doc(phoneKey)), nidKey ? tx.get(blacklistCol().doc(nidKey)) : null,
      ]);
      if (userSnap.exists) throw new HttpError(409, 'already_registered');
      if (phoneIdx.exists || (nidIdx && nidIdx.exists)) throw new HttpError(409, 'already_registered');
      if (phoneBl.exists || (nidBl && nidBl.exists)) throw new HttpError(403, 'blacklisted');
      const status = role === 'customer' && s.autoApproveCustomers ? 'active' : 'pending';
      const t = now();
      tx.set(userRef, {
        uid, role, status, name, phone, email: token.email || null, nationalId: nid, area, lang,
        idRef: refs.id ?? null, licenseRef: refs.license ?? null, vehicleRegRef: refs.vehicleReg ?? null, vehiclePhotoRef: refs.vehiclePhoto ?? null,
        vehicleType, phoneVerified: !!token.phone_number, ratingSum: 0, ratingCount: 0, completedOrders: 0, cancelCount: 0, createdAt: t,
      });
      tx.set(uniqueIndexCol().doc(phoneKey), { uid, at: t });
      if (nidKey) tx.set(uniqueIndexCol().doc(nidKey), { uid, at: t });
      if (driver) tx.set(walletsCol().doc(uid), { uid, balance: 0, totalEarned: 0, updatedAt: t });
      return status;
    });
    return { ok: true, status };
  },

  // ---------- عرض سعر ----------
  async quote({ uid, body }) {
    await need({ uid }, ['customer']);
    const s = await loadSettings();
    const a = point(body.pickup, false), b = point(body.dropoff, false);
    const d = await distanceKm(a, b, s);
    if (body.service === 'passengers') {
      if (!s.passengersEnabled) throw new HttpError(403, 'service_disabled');
      return { distanceKm: d.km, source: d.source, ...calcPassengerPrice(s, Math.max(d.km, 0.5), body.vehicleClass) };
    }
    return { distanceKm: d.km, source: d.source, ...calcPrice(s, Math.max(d.km, 0.5), body.category, body.size) };
  },

  // ---------- الملفات ----------
  async 'files/upload'({ uid, body }) {
    const snap = await usersCol().doc(uid).get();
    const profile = snap.exists ? userOut({ uid, ...snap.data() }) : null;
    return { ref: await saveFile(uid, profile, body.kind, body.data) };
  },

  // ---------- الطلبات: قراءة ----------
  async 'orders/list'({ uid, body }) {
    const u = await viewer({ uid });
    bg(sweepExpired());
    let snap;
    if (u.role === 'customer') snap = await ordersCol().where('customerId', '==', uid).orderBy('createdAt', 'desc').limit(100).get();
    else if (u.role === 'driver') {
      snap = body.scope === 'mine'
        ? await ordersCol().where('driverId', '==', uid).orderBy('updatedAt', 'desc').limit(100).get()
        : await ordersCol().where('status', '==', 'open').orderBy('createdAt', 'desc').limit(100).get();
    } else {
      const status = body.status ? String(body.status) : null, lim = int(body.limit ?? 200, 1, 300);
      snap = status ? await ordersCol().where('status', '==', status).orderBy('createdAt', 'desc').limit(lim).get()
        : await ordersCol().orderBy('createdAt', 'desc').limit(lim).get();
    }
    const out = snap.docs.map((d) => orderOut({ id: d.id, ...d.data() }, u, { brief: true }));
    if (u.role === 'customer') {
      const open = out.filter((o) => o.status === 'open').map((o) => o.id);
      if (open.length) {
        const counts = await Promise.all(open.map((oid) => offersCol().where('orderId', '==', oid).where('status', '==', 'pending').count().get()));
        const m = Object.fromEntries(open.map((oid, i) => [oid, counts[i].data().count]));
        out.forEach((o) => { if (o.status === 'open') o.offerCount = m[o.id] || 0; });
      }
    }
    return { orders: out };
  },

  async 'orders/get'({ uid, body }) {
    const u = await viewer({ uid });
    let o = await loadOrder(docId(body.orderId));
    if (o.status === 'open' && o.escrowStatus === 'held') {
      const s = await loadSettings();
      if (o.scheduledAt < now() - s.prepaidGraceMin * 60000 && (await expireOrder(o).catch(() => false))) o = await loadOrder(o.id);
    }
    const allowed = u.role === 'admin' || o.customerId === uid || o.driverId === uid || (u.role === 'driver' && o.status === 'open');
    if (!allowed) throw new HttpError(403, 'forbidden');
    let location = null;
    if (ACTIVE.includes(o.status) && u.role !== 'driver') {
      const l = await liveLocCol().doc(o.id).get();
      if (l.exists) { const d = l.data(); location = { lat: d.lat, lng: d.lng, at: d.at }; }
    }
    const out = orderOut(o, u);
    if (o.status === 'open') {
      if (u.role === 'customer' || u.role === 'admin') {
        const offSnap = await offersCol().where('orderId', '==', o.id).where('status', '==', 'pending').orderBy('price', 'asc').limit(30).get();
        const drivers = await Promise.all(offSnap.docs.map((d) => usersCol().doc(d.data().driverId).get()));
        out.offers = offSnap.docs.map((d, i) => {
          const f = d.data(), dr = drivers[i].data() || {};
          return { id: d.id, price: f.price, note: f.note, createdAt: f.createdAt, driverName: dr.name, vehicleType: dr.vehicleType,
            ratingSum: dr.ratingSum || 0, ratingCount: dr.ratingCount || 0, completedOrders: dr.completedOrders || 0, trust: trustOf(dr) };
        });
      } else if (u.role === 'driver') {
        const mineSnap = await offersCol().doc(`${o.id}__${uid}`).get();
        out.myOffer = mineSnap.exists ? (({ id, price, note, status }) => ({ id, price, note, status }))({ id: mineSnap.id, ...mineSnap.data() }) : null;
      }
    }
    if (o.driverId && (u.role === 'customer' || u.role === 'admin')) {
      const d = await usersCol().doc(o.driverId).get();
      if (d.exists) out.driverTrust = trustOf(d.data());
    }
    if (u.role === 'customer' || u.role === 'admin') {
      const rf = await refundsCol().doc(o.id).get();
      if (rf.exists) { const x = rf.data(); out.refund = { status: x.status, amount: x.amount, reason: x.reason }; }
    }
    if (o.driverId && (u.role === 'admin' || o.customerId === uid || o.driverId === uid)) {
      const msnap = await messagesCol(o.id).orderBy('createdAt', 'desc').limit(1).get();
      const cnt = await messagesCol(o.id).count().get();
      out.chat = { count: cnt.data().count, lastAt: msnap.empty ? null : msnap.docs[0].data().createdAt };
    }
    return { order: out, location };
  },

  // السواق بيبعت موقعه (الواجهة بتبعته كل ~15 ثانية)
  async 'orders/location'({ uid, body }) {
    await need({ uid }, ['driver']);
    const o = await loadOrder(docId(body.orderId));
    if (o.driverId !== uid || !ACTIVE.includes(o.status)) throw new HttpError(403, 'forbidden');
    const p = point(body, false);
    await liveLocCol().doc(o.id).set({ orderId: o.id, lat: p.lat, lng: p.lng, acc: int(body.acc ?? 0, 0, 100000), at: now() });
    return { ok: true };
  },

  // ---------- إنشاء طلب ----------
  async 'orders/create'({ uid, body: b }) {
    const u = await need({ uid }, ['customer']);
    const s = await loadSettings();
    const pendingSnap = await ordersCol().where('customerId', '==', uid).where('status', 'in', ['open', 'accepted', 'payment_review', 'awaiting_payment']).count().get();
    if (pendingSnap.data().count >= 10) throw new HttpError(429, 'too_many_open');
    const trip = b.service === 'passengers';
    if (trip && !s.passengersEnabled) throw new HttpError(403, 'service_disabled');
    const pickup = point(b.pickup), dropoff = point(b.dropoff);
    const photos = fileRefs(b.photos ?? [], 5, trip ? 0 : 1);
    await ownFiles(uid, photos);
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
    const prepay = trip || b.prepay === true, first = prepay ? 'awaiting_payment' : 'open';
    const data = {
      id, customerId: uid, status: first, escrowStatus: 'none', price, scheduledAt: when.getTime(), createdAt: t, updatedAt: t, version: 1,
      customerName: u.name, customerPhone: u.phone, ...spec,
      description: str(b.description ?? '', 0, 500), photos, pickup, dropoff, distanceKm: d.km, distanceSource: d.source,
      priceOriginal: price, instant: prepay ? true : b.instant !== false, payMode: prepay ? 'before' : 'after', commissionPct: s.commissionPct,
      log: [{ status: first, by: uid, at: t }],
    };
    await ordersCol().doc(id).set(data);
    if (!prepay) bg(dispatchNewOrder({ id, ...spec, pickup, dropoff, price }, s));
    return { id, price, prepay };
  },

  // ---------- السواق يقبل (أول واحد يكسب: Firestore transaction بترفض التاني تلقائياً) ----------
  async 'orders/accept'({ uid, body }) {
    const u = await need({ uid }, ['driver']);
    const orderId = docId(body.orderId), ref = ordersCol().doc(orderId);
    const pendingOffersQ = offersCol().where('orderId', '==', orderId).where('status', '==', 'pending');
    const { prepaid, customerId } = await runTx(async (tx) => {
      const [snap, offersSnap] = await Promise.all([tx.get(ref), tx.get(pendingOffersQ)]);
      const o = orderFromSnap(snap);
      if (o.status !== 'open') throw new HttpError(409, 'order_not_open');
      if (o.instant === false) throw new HttpError(409, 'offers_only');
      if (o.service === 'passengers' && !canServe(u.vehicleType, o)) throw new HttpError(403, 'vehicle_mismatch');
      const prepaid = o.escrowStatus === 'held';
      tx.update(ref, orderPatch({ status: prepaid ? 'paid' : 'accepted', driverId: uid, driverName: u.name, driverPhone: u.phone, driverVehicle: u.vehicleType, acceptedAt: now() },
        L(prepaid ? 'paid' : 'accepted', uid, prepaid ? { note: 'accepted_prepaid' } : {})));
      offersSnap.forEach((d) => tx.update(d.ref, { status: d.data().driverId === uid ? 'withdrawn' : 'rejected', updatedAt: now() }));
      return { prepaid, customerId: o.customerId };
    });
    bg(notify([customerId], prepaid ? 'accepted_prepaid' : 'accepted', { driver: u.name, no: orderNo(orderId) }, { url: `/#/order/${orderId}` }));
    return { ok: true };
  },

  // ---------- عروض الأسعار ----------
  async 'offers/create'({ uid, body }) {
    const u = await need({ uid }, ['driver']);
    const s = await loadSettings();
    if (!s.offersEnabled) throw new HttpError(403, 'offers_disabled');
    const orderId = docId(body.orderId), orderRef = ordersCol().doc(orderId);
    const o0 = orderFromSnap(await orderRef.get());
    if (o0.status !== 'open') throw new HttpError(409, 'order_not_open');
    if (o0.escrowStatus === 'held' || o0.payMode === 'before') throw new HttpError(409, 'prepaid_fixed');
    if (o0.service === 'passengers' && !canServe(u.vehicleType, o0)) throw new HttpError(403, 'vehicle_mismatch');
    const lo = Math.max(Math.ceil(s.minPrice), Math.ceil((o0.price * s.offerMinPct) / 100)), hi = Math.ceil((o0.price * s.offerMaxPct) / 100);
    const price = int(body.price, lo, hi, 'offer_out_of_range');
    const note = str(body.note ?? '', 0, 200);
    const offerRef = offersCol().doc(`${orderId}__${uid}`);
    await runTx(async (tx) => {
      const snap = await tx.get(orderRef);
      const o = orderFromSnap(snap);
      if (o.status !== 'open') throw new HttpError(409, 'order_not_open');
      const t = now();
      tx.set(offerRef, { id: offerRef.id, orderId, driverId: uid, price, note, status: 'pending', createdAt: t, updatedAt: t }, { merge: true });
    });
    bg(notify([o0.customerId], 'offer', { price, no: orderNo(orderId), driver: u.name }, { url: `/#/order/${orderId}`, tag: 'offer-' + orderId }));
    return { ok: true, min: lo, max: hi };
  },
  async 'offers/withdraw'({ uid, body }) {
    await need({ uid }, ['driver']);
    const ref = offersCol().doc(`${docId(body.orderId)}__${uid}`);
    await runTx(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data().status !== 'pending') throw new HttpError(409, 'bad_state');
      tx.update(ref, { status: 'withdrawn', updatedAt: now() });
    });
    return { ok: true };
  },
  async 'offers/accept'({ uid, body }) {
    await need({ uid }, ['customer']);
    const offerId = docId(body.offerId), offerRef = offersCol().doc(offerId);
    const f0 = await offerRef.get();
    if (!f0.exists) throw new HttpError(404, 'not_found');
    const { orderId, driverId } = f0.data();
    const orderRef = ordersCol().doc(orderId);
    const dSnap = await usersCol().doc(driverId).get();
    const d = dSnap.exists ? { uid: driverId, ...dSnap.data() } : null;
    if (!d || d.role !== 'driver' || d.status !== 'active') throw new HttpError(409, 'driver_unavailable');
    const othersQ = offersCol().where('orderId', '==', orderId).where('status', '==', 'pending');
    const { others } = await runTx(async (tx) => {
      const [fSnap, oSnap, othersSnap] = await Promise.all([tx.get(offerRef), tx.get(orderRef), tx.get(othersQ)]);
      const f = fSnap.data();
      if (!fSnap.exists || f.status !== 'pending') throw new HttpError(409, 'bad_state');
      const o = orderFromSnap(oSnap);
      if (o.customerId !== uid) throw new HttpError(403, 'forbidden');
      if (o.status !== 'open') throw new HttpError(409, 'order_not_open');
      const t = now(), others = [];
      othersSnap.forEach((doc) => {
        if (doc.id === offerId) { tx.update(doc.ref, { status: 'accepted', updatedAt: t }); return; }
        tx.update(doc.ref, { status: 'rejected', updatedAt: t }); others.push(doc.data().driverId);
      });
      tx.update(orderRef, orderPatch({ status: 'accepted', driverId: d.uid, driverName: d.name, driverPhone: d.phone, driverVehicle: d.vehicleType, acceptedAt: t, price: f.price, priceNegotiated: true },
        L('accepted', uid, { note: 'offer', price: f.price })));
      return { others };
    });
    bg(notify([driverId], 'offer_accepted', { price: f0.data().price, no: orderNo(orderId) }, { url: `/#/order/${orderId}` }));
    bg(notify(others, 'offer_rejected', { no: orderNo(orderId) }, { url: '/#/driver' }));
    return { ok: true };
  },
  async 'offers/reject'({ uid, body }) {
    await need({ uid }, ['customer']);
    const offerId = docId(body.offerId), offerRef = offersCol().doc(offerId);
    const driverId = await runTx(async (tx) => {
      const fSnap = await tx.get(offerRef);
      if (!fSnap.exists) throw new HttpError(404, 'not_found');
      const f = fSnap.data();
      if (f.status !== 'pending') throw new HttpError(409, 'bad_state');
      const oSnap = await tx.get(ordersCol().doc(f.orderId));
      const o = orderFromSnap(oSnap);
      if (o.customerId !== uid) throw new HttpError(409, 'bad_state');
      tx.update(offerRef, { status: 'rejected', updatedAt: now() });
      return f.driverId;
    });
    bg(notify([driverId], 'offer_rejected', { no: orderNo(offerId.split('__')[0]) }, { url: '/#/driver' }));
    return { ok: true };
  },

  // ---------- "متاح لاستقبال الطلبات" (زي أوبر) + آخر موقع معروف ----------
  async 'driver/presence'({ uid, body }) {
    await need({ uid }, ['driver']);
    const ref = presenceCol().doc(uid);
    if (body.online === undefined) {
      const s = await ref.get();
      const d = s.data();
      return { online: !!d?.online, seenAt: d?.seenAt || null };
    }
    const online = body.online === true;
    const patch = { uid, online, seenAt: now() };
    if (body.lat != null) { const p = point(body, false); patch.lat = p.lat; patch.lng = p.lng; }
    await ref.set(patch, { merge: true });
    return { online };
  },

  // ---------- أجهزة الإشعارات ----------
  async 'push/register'({ uid, headers, body }) {
    if (!(await usersCol().doc(uid).get()).exists) throw new HttpError(403, 'no_profile');
    const token = str(body.token, 20, 4096), ua = (headers['user-agent'] || '').slice(0, 120);
    await pushTokensCol().doc(token).set({ token, uid, ua, createdAt: now(), lastSeen: now() }, { merge: true });
    // 5 أجهزة كحد أقصى للمستخدم: نمسح الأقدم
    const snap = await pushTokensCol().where('uid', '==', uid).orderBy('lastSeen', 'desc').get();
    const extra = snap.docs.slice(5);
    if (extra.length) await Promise.all(extra.map((d) => d.ref.delete()));
    return { ok: true, push: pushEnabled() };
  },
  async 'push/unregister'({ uid, body }) {
    const ref = pushTokensCol().doc(str(body.token, 20, 4096));
    const s = await ref.get();
    if (s.exists && s.data().uid === uid) await ref.delete();
    return { ok: true };
  },

  // ---------- العميل يرفع إثبات التحويل (InstaPay) ----------
  async 'orders/pay'({ uid, body }) {
    await need({ uid }, ['customer']);
    const o = await loadOrder(docId(body.orderId));
    if (o.customerId !== uid) throw new HttpError(403, 'forbidden');
    if (o.status !== (o.payMode === 'before' ? 'awaiting_payment' : 'accepted')) throw new HttpError(409, 'bad_state');
    const proof = fileRef(body.proofRef); await ownFiles(uid, [proof]);
    await ordersCol().doc(o.id).update(orderPatch({ status: 'payment_review', paymentProof: proof, paymentRef: str(body.reference ?? '', 0, 40), paymentSubmittedAt: now(), paymentRejectReason: null }, L('payment_review', uid)));
    await toAdmins('proof', { no: orderNo(o.id) }, '/#/admin/payments');
    return { ok: true };
  },

  // ---------- السواق يغيّر حالة التنفيذ (صورة + فحص GPS) ----------
  async 'orders/status'({ uid, body }) {
    await need({ uid }, ['driver']);
    const o = await loadOrder(docId(body.orderId));
    if (o.driverId !== uid) throw new HttpError(403, 'forbidden');
    const next = NEXT[o.status];
    if (!next || body.next !== next) throw new HttpError(409, 'bad_state');
    const s = await loadSettings();
    const patch = { status: next }; let loc = null;
    if (body.loc) loc = point(body.loc, false);
    const target = next === 'picked_up' ? o.pickup : next === 'delivered' ? o.dropoff : null;
    if (target) {
      if (o.service !== 'passengers' || body.photoRef) {
        const photo = fileRef(body.photoRef); await ownFiles(uid, [photo]);
        patch[next === 'picked_up' ? 'pickupPhoto' : 'deliveryPhoto'] = photo;
      }
      patch[next === 'picked_up' ? 'pickedUpAt' : 'deliveredAt'] = now();
      if (s.geofenceMeters > 0) {
        if (!loc) throw new HttpError(400, 'location_required');
        if (haversineM(loc, target) > s.geofenceMeters) throw new HttpError(403, 'too_far');
      }
    }
    await ordersCol().doc(o.id).update(orderPatch(patch, L(next, uid, loc ? { lat: loc.lat, lng: loc.lng } : {})));
    bg(notify([o.customerId], o.service === 'passengers' ? `${next}_p` : next, { no: orderNo(o.id) }, { url: `/#/order/${o.id}` }));
    return { ok: true, status: next };
  },

  // ---------- العميل يأكد الاستلام => تحرير الـ Escrow وخصم العمولة وتحويل الباقي لمحفظة السواق ----------
  async 'orders/confirm'({ uid, body }) {
    await need({ uid }, ['customer']);
    const orderId = docId(body.orderId), ref = ordersCol().doc(orderId);
    const s = await loadSettings();
    const o0 = await loadOrder(orderId);
    const { net, commission, driverId } = await runTx(async (tx) => {
      const [oSnap, dSnap] = await Promise.all([tx.get(ref), tx.get(usersCol().doc(o0.driverId))]);
      const o = orderFromSnap(oSnap);
      if (o.customerId !== uid) throw new HttpError(403, 'forbidden');
      if (o.status !== 'delivered' || o.escrowStatus !== 'held') throw new HttpError(409, 'bad_state');
      const driver = dSnap.data();
      const pct = effectiveCommissionPct(s, o.commissionPct, driver);
      const { commission, net } = split(o.price, pct);
      tx.update(ref, orderPatch({ status: 'completed', escrowStatus: 'released', commission, driverNet: net, commissionPctApplied: pct, completedAt: now() }, L('completed', uid)));
      walletCreditTx(tx, o.driverId, net);
      walletTxTx(tx, { uid: o.driverId, type: 'earning', orderId: o.id, amount: net, gross: o.price, commission });
      tx.update(usersCol().doc(o.driverId), { completedOrders: FieldValue.increment(1) });
      tx.update(usersCol().doc(o.customerId), { completedOrders: FieldValue.increment(1) });
      return { net, commission, driverId: o.driverId };
    });
    bg(notify([driverId], 'completed', { net, no: orderNo(orderId) }, { url: '/#/driver/wallet' }));
    return { ok: true, net, commission };
  },

  // ---------- إلغاء ----------
  async 'orders/cancel'({ uid, body }) {
    await need({ uid }, ['customer', 'driver']);
    const orderId = docId(body.orderId), ref = ordersCol().doc(orderId);
    const s = await loadSettings();
    const reason = str(body.reason ?? '', 0, 200);
    const o0 = await loadOrder(orderId);
    const asCustomer = o0.customerId === uid, asDriver = o0.driverId === uid;
    const held = o0.escrowStatus === 'held';
    // تجميد تلقائي عند بلوغ حد الإلغاءات: لازم نقرأ العدّاد الحالي جوه نفس الـ transaction قبل أي كتابة
    const bumpCancelCount = (tx, userSnap) => {
      const cur = (userSnap.data()?.cancelCount || 0) + 1;
      const patch = { cancelCount: FieldValue.increment(1) };
      if (cur >= s.maxCancellations) { patch.status = 'suspended'; patch.statusReason = 'auto_cancellations'; }
      tx.update(userSnap.ref, patch);
    };

    // (1) العميل بعد قبول سواق على طلب مدفوع: إلغاء برسوم
    if (asCustomer && held && ['paid', 'heading_pickup'].includes(o0.status)) {
      const heading = o0.status === 'heading_pickup';
      const dp = heading ? s.cancelHeadingDriverPct : s.cancelPaidDriverPct, pp = heading ? s.cancelHeadingPlatformPct : s.cancelPaidPlatformPct;
      const { driver, platform, refund: back } = cancelSplit(o0.price, dp, pp);
      await runTx(async (tx) => {
        const userRef = usersCol().doc(uid);
        const [oSnap, userSnap] = await Promise.all([tx.get(ref), tx.get(userRef)]);
        const o = orderFromSnap(oSnap);
        if (!(['paid', 'heading_pickup'].includes(o.status) && o.escrowStatus === 'held')) throw new HttpError(409, 'cannot_cancel');
        tx.update(ref, orderPatch({ status: 'cancelled', escrowStatus: 'settled', cancelledBy: 'customer', cancelReason: reason, commission: platform, driverNet: driver, customerRefund: back, cancelFee: { driverPct: dp, platformPct: pp } },
          L('cancelled', uid, { note: 'cancel_after_accept', reason })));
        bumpCancelCount(tx, userSnap);
        if (driver > 0) { walletCreditTx(tx, o.driverId, driver); walletTxTx(tx, { uid: o.driverId, type: 'cancel_compensation', orderId: o.id, amount: driver, gross: o.price, commission: platform }); }
        if (back > 0) refundInsert(tx, { ...o, price: back }, 'cancelled_after_accept');
      });
      bg(notify([o0.driverId], driver > 0 ? 'cancel_comp' : 'cancel_plain', { no: orderNo(orderId), amount: driver }, { url: '/#/driver/wallet' }));
      if (back > 0) await afterRefundRequest({ ...o0, price: back });
      return { ok: true, fee: driver + platform, driver, platform, refund: back };
    }

    let patch, status, counts = false, refund = false;
    if (asCustomer && ['open', 'accepted', 'awaiting_payment'].includes(o0.status)) {
      refund = o0.status === 'open' && held;
      patch = { status: 'cancelled', cancelledBy: 'customer', cancelReason: reason, ...(refund ? { escrowStatus: 'refund_pending' } : {}) };
      status = 'cancelled'; counts = o0.status === 'accepted';
    } else if (asDriver && ['accepted', 'paid', 'heading_pickup'].includes(o0.status)) {
      patch = { status: 'open', driverId: null, driverName: null, driverPhone: null, driverVehicle: null, acceptedAt: null, ...(held ? { instant: true } : {}) };
      status = 'open'; counts = true;
    } else throw new HttpError(409, 'cannot_cancel');
    await runTx(async (tx) => {
      const userRef = usersCol().doc(uid);
      const [oSnap, userSnap] = await Promise.all([tx.get(ref), counts ? tx.get(userRef) : Promise.resolve(null)]);
      const o = orderFromSnap(oSnap);
      if (o.status !== o0.status) throw new HttpError(409, 'cannot_cancel');
      tx.update(ref, orderPatch(patch, L(status, uid, asDriver ? { note: 'driver_cancelled', reason } : { reason })));
      if (refund) refundInsert(tx, o, 'cancelled');
      if (counts) bumpCancelCount(tx, userSnap);
    });
    if (status === 'cancelled') {
      const pend = await offersCol().where('orderId', '==', orderId).where('status', '==', 'pending').get();
      await Promise.all(pend.docs.map((d) => d.ref.update({ status: 'rejected', updatedAt: now() })));
    }
    if (refund) await afterRefundRequest(o0);
    if (asDriver && held) {
      bg(notify([o0.customerId], 'driver_cancelled', { no: orderNo(orderId) }, { url: `/#/order/${orderId}` }));
      bg(dispatchNewOrder({ id: orderId, service: o0.service, size: o0.size, vehicleClass: o0.vehicleClass, passengers: o0.passengers, pickup: o0.pickup, dropoff: o0.dropoff, price: o0.price }, s));
    }
    return { ok: true, refund };
  },

  // ---------- تقييم ----------
  async 'orders/rate'({ uid, body }) {
    await need({ uid }, ['customer', 'driver']);
    const orderId = docId(body.orderId), ref = ordersCol().doc(orderId);
    const o0 = await loadOrder(orderId);
    if (o0.status !== 'completed') throw new HttpError(409, 'bad_state');
    const asCustomer = o0.customerId === uid;
    if (!asCustomer && o0.driverId !== uid) throw new HttpError(403, 'forbidden');
    const field = asCustomer ? 'rateByCustomer' : 'rateByDriver';
    if (o0[field]) throw new HttpError(409, 'already_rated');
    const stars = int(body.stars, 1, 5);
    const target = asCustomer ? o0.driverId : o0.customerId;
    await runTx(async (tx) => {
      const o = orderFromSnap(await tx.get(ref));
      if (o[field]) throw new HttpError(409, 'already_rated');
      tx.update(ref, orderPatch({ [field]: { stars, comment: str(body.comment ?? '', 0, 300), at: now() } }));
      tx.update(usersCol().doc(target), { ratingSum: FieldValue.increment(stars), ratingCount: FieldValue.increment(1) });
    });
    return { ok: true };
  },

  // ---------- المحفظة والسحب ----------
  async wallet({ uid }) {
    await need({ uid }, ['driver']);
    const [wSnap, txSnap, wdSnap] = await Promise.all([
      walletsCol().doc(uid).get(),
      walletTxCol(uid).orderBy('at', 'desc').limit(40).get(),
      withdrawalsCol().where('uid', '==', uid).orderBy('createdAt', 'desc').limit(40).get(),
    ]);
    const w = wSnap.data();
    return {
      wallet: { balance: w?.balance || 0, totalEarned: w?.totalEarned || 0 },
      tx: txSnap.docs.map((d) => txOut({ id: d.id, ...d.data() })),
      withdrawals: wdSnap.docs.map((d) => withdrawalOut({ id: d.id, ...d.data() })),
    };
  },

  // بيخصم من المحفظة فوراً ويحجز المبلغ لحد قرار الأدمن. الـ transaction بيمنع السحب المزدوج (بديل CHECK(balance>=0))
  async 'withdrawals/create'({ uid, body }) {
    const u = await need({ uid }, ['driver']);
    const s = await loadSettings();
    const amount = int(body.amount, s.minWithdraw, 10000000, 'below_min');
    const method = body.method;
    if (!['instapay', 'vodafone', 'bank'].includes(method)) throw new HttpError(400, 'bad_method');
    const account = str(body.account, 5, 60), id = newId();
    const walletRef = walletsCol().doc(uid);
    await runTx(async (tx) => {
      const wSnap = await tx.get(walletRef);
      const balance = wSnap.data()?.balance || 0;
      if (balance < amount) throw new HttpError(400, 'insufficient_balance');
      tx.update(walletRef, { balance: FieldValue.increment(-amount), updatedAt: now() });
      tx.set(withdrawalsCol().doc(id), { id, uid, name: u.name, phone: u.phone, amount, method, account, status: 'pending', createdAt: now() });
      walletTxTx(tx, { uid, type: 'withdrawal', amount: -amount, withdrawalId: id });
    });
    return { ok: true, id };
  },

  // ---------- نزاع ----------
  async 'disputes/create'({ uid, body }) {
    await need({ uid }, ['customer', 'driver']);
    const orderId = docId(body.orderId), ref = ordersCol().doc(orderId);
    const o0 = await loadOrder(orderId);
    const asCustomer = o0.customerId === uid;
    if (!asCustomer && o0.driverId !== uid) throw new HttpError(403, 'forbidden');
    if (!HELD.includes(o0.status)) throw new HttpError(409, 'bad_state');
    if (!['damaged', 'delay', 'not_as_described', 'payment', 'no_show', 'other'].includes(body.reason)) throw new HttpError(400, 'bad_reason');
    const evidence = fileRefs(body.evidence ?? [], 5); await ownFiles(uid, evidence);
    const id = newId();
    await runTx(async (tx) => {
      const o = orderFromSnap(await tx.get(ref));
      if (!HELD.includes(o.status)) throw new HttpError(409, 'bad_state');
      tx.update(ref, orderPatch({ status: 'disputed', prevStatus: o.status, disputeId: id }, L('disputed', uid)));
      tx.set(disputesCol().doc(id), { id, orderId, customerId: o.customerId, driverId: o.driverId, openedBy: uid, openedByRole: asCustomer ? 'customer' : 'driver',
        reason: body.reason, details: str(body.details ?? '', 0, 1000), evidence, orderPrice: o.price, status: 'open', createdAt: now() });
    });
    await toAdmins('dispute', { no: orderNo(orderId) }, '/#/admin/disputes');
    bg(notify([asCustomer ? o0.driverId : o0.customerId], 'dispute', { no: orderNo(orderId) }, { url: `/#/order/${orderId}` }));
    return { ok: true, id };
  },

  // =====================  الأدمن  =====================
  async 'admin/badges'({ uid }) {
    await need({ uid }, ['admin']);
    const [payments, users, withdrawals, disputes, refunds, reports, sos] = await Promise.all([
      ordersCol().where('status', '==', 'payment_review').count().get(),
      usersCol().where('status', '==', 'pending').count().get(),
      withdrawalsCol().where('status', '==', 'pending').count().get(),
      disputesCol().where('status', '==', 'open').count().get(),
      refundsCol().where('status', '==', 'pending').count().get(),
      reportsCol().where('status', '==', 'open').count().get(),
      sosCol().where('status', '==', 'open').count().get(),
    ]);
    const n = (r) => r.data().count;
    return { badges: { payments: n(payments), users: n(users), withdrawals: n(withdrawals), disputes: n(disputes), refunds: n(refunds), reports: n(reports) + n(sos) } };
  },

  // إحصائيات: استعلامات aggregate (count/sum) بدل SQL GROUP BY. الترتيب اليومي وأفضل 5 سواقين محدودين بحجم معقول (كفاية لـ MVP؛
  // لو الحجم كبر كتير، الخطوة التالية الطبيعية هي عدّاد مجمّع (rollup) بيتحدّث مع كل عملية بدل القراءة الكاملة هنا).
  async 'admin/stats'({ uid }) {
    await need({ uid }, ['admin']);
    const since = now() - 14 * 86400e3;
    const settled = ['released', 'settled'];
    const [total, active, refundsDue, activeDrivers, activeCustomers] = await Promise.all([
      ordersCol().count().get(),
      ordersCol().where('status', 'not-in', ['completed', 'cancelled', 'resolved']).count().get(),
      refundsCol().where('status', '==', 'pending').get(),
      usersCol().where('role', '==', 'driver').where('status', '==', 'active').count().get(),
      usersCol().where('role', '==', 'customer').where('status', '==', 'active').count().get(),
    ]);
    // مجاميع السعر/العمولة/المبلغ المحجوز عن طريق aggregate queries حقيقية (sum() في REST API)
    const [priceSum, refundSum, commSum, heldSum] = await Promise.all([
      ordersCol().where('escrowStatus', 'in', settled).aggregate({ v: AggregateField.sum('price') }).get(),
      ordersCol().where('escrowStatus', 'in', settled).aggregate({ v: AggregateField.sum('customerRefund') }).get(),
      ordersCol().where('escrowStatus', 'in', settled).aggregate({ v: AggregateField.sum('commission') }).get(),
      ordersCol().where('escrowStatus', '==', 'held').aggregate({ v: AggregateField.sum('price') }).get(),
    ]);
    const revenue = (priceSum.data().v || 0) - (refundSum.data().v || 0);
    const totals = { total: total.data().count, active: active.data().count, revenue, commission: commSum.data().v || 0, held: heldSum.data().v || 0 };
    let refundsDueSum = 0; refundsDue.forEach((d) => { refundsDueSum += d.data().amount || 0; });
    // آخر 14 يوم: قراءة الحقول المطلوبة بس (select) وتجميعها بالساعة المحلية (القاهرة UTC+2) في الميموري
    const perDaySnap = await ordersCol().where('createdAt', '>=', since).select('createdAt').limit(5000).get();
    const byDay = {};
    perDaySnap.forEach((d) => { const day = new Date(d.data().createdAt + 7200e3).toISOString().slice(0, 10); byDay[day] = (byDay[day] || 0) + 1; });
    const perDay = Object.entries(byDay).sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, n]) => ({ d, n }));
    // أفضل 5 سواقين (على آخر 2000 طلب مكتمل/محسوم — كافي لـ MVP)
    const doneSnap = await ordersCol().where('status', 'in', ['completed', 'resolved']).orderBy('completedAt', 'desc').limit(2000).select('driverId', 'driverNet').get();
    const byDriver = {};
    doneSnap.forEach((d) => { const x = d.data(); if (!x.driverId) return; byDriver[x.driverId] ??= { n: 0, earned: 0 }; byDriver[x.driverId].n++; byDriver[x.driverId].earned += x.driverNet || 0; });
    const topIds = Object.entries(byDriver).sort(([, a], [, b]) => b.n - a.n).slice(0, 5);
    const names = await Promise.all(topIds.map(([id]) => usersCol().doc(id).get()));
    const topDrivers = topIds.map(([id, v], i) => ({ name: names[i].data()?.name || '—', n: v.n, earned: v.earned }));
    return { totals, activeDrivers: activeDrivers.data().count, activeCustomers: activeCustomers.data().count, topDrivers, perDay, refundsDue: refundsDueSum };
  },

  async 'admin/users'({ uid, body }) {
    await need({ uid }, ['admin']);
    let q = usersCol().where('role', '!=', 'admin');
    if (['customer', 'driver'].includes(body.role)) q = usersCol().where('role', '==', body.role);
    if (body.status) q = q.where('status', '==', String(body.status));
    const snap = await q.orderBy('createdAt', 'desc').limit(300).get();
    const query = String(body.q ?? '').trim().slice(0, 40).toLowerCase();
    let rows = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
    if (query) rows = rows.filter((r) => [r.name, r.phone, r.email].some((v) => String(v || '').toLowerCase().includes(query)));
    rows.sort((a, b) => (a.status === 'pending') === (b.status === 'pending') ? 0 : a.status === 'pending' ? -1 : 1);
    return { users: rows.map((r) => { const u = userOut(r); if (r.role === 'driver') u.trust = trustOf(r); return u; }) };
  },

  async 'admin/user'({ uid, body }) {
    const admin = await need({ uid }, ['admin']);
    const targetRef = usersCol().doc(uidOf(body.uid));
    const tSnap = await targetRef.get();
    if (!tSnap.exists) throw new HttpError(404, 'user_not_found');
    const target = { uid: tSnap.id, ...tSnap.data() };
    if (target.role === 'admin') throw new HttpError(403, 'forbidden');
    const status = body.status;
    if (!['active', 'rejected', 'banned', 'pending'].includes(status)) throw new HttpError(400, 'bad_status');
    const reason = str(body.reason ?? '', 0, 200);
    await runTx(async (tx) => {
      tx.update(targetRef, { status, statusReason: reason, reviewedBy: admin.uid, reviewedAt: now() });
      if (status === 'banned' && body.blacklist) {
        for (const [type, value] of [['phone', target.phone], ['nid', target.nationalId]]) {
          if (value) tx.set(blacklistCol().doc(`${type}_${value}`), { type, value, reason, at: now() });
        }
      }
    });
    if (status === 'active' && target.status !== 'active') bg(notify([target.uid], 'account_active', {}, { url: '/' }));
    if (['rejected', 'banned'].includes(status)) bg(notify([target.uid], 'account_rejected', {}, { url: '/' }));
    return { ok: true };
  },

  async 'admin/payment'({ uid, body }) {
    const admin = await need({ uid }, ['admin']);
    const orderId = docId(body.orderId), ref = ordersCol().doc(orderId);
    const o0 = await loadOrder(orderId);
    if (o0.status !== 'payment_review') throw new HttpError(409, 'bad_state');
    const pre = o0.payMode === 'before';
    let patch, logStatus;
    if (body.action === 'confirm') { patch = { status: pre ? 'open' : 'paid', escrowStatus: 'held', paidAt: now(), paymentConfirmedBy: admin.uid }; logStatus = patch.status; }
    else if (body.action === 'reject') { patch = { status: pre ? 'awaiting_payment' : 'accepted', paymentRejectReason: str(body.note ?? '', 0, 200), paymentProof: null, paymentRef: null }; logStatus = 'payment_rejected'; }
    else throw new HttpError(400, 'bad_action');
    await runTx(async (tx) => {
      const o = orderFromSnap(await tx.get(ref));
      if (o.status !== 'payment_review') throw new HttpError(409, 'bad_state');
      tx.update(ref, orderPatch(patch, L(logStatus, admin.uid, pre && body.action === 'confirm' ? { note: 'prepaid_confirmed' } : {})));
    });
    const url = `/#/order/${orderId}`;
    if (body.action === 'confirm') {
      if (pre) {
        bg(notify([o0.customerId], 'prepaid_open', { no: orderNo(orderId) }, { url }));
        bg(loadSettings().then((s) => dispatchNewOrder({ id: orderId, service: o0.service, size: o0.size, vehicleClass: o0.vehicleClass, passengers: o0.passengers, pickup: o0.pickup, dropoff: o0.dropoff, price: o0.price }, s)));
      } else {
        bg(notify([o0.driverId], 'paid_driver', { no: orderNo(orderId) }, { url }));
        bg(notify([o0.customerId], 'paid_customer', { no: orderNo(orderId) }, { url }));
      }
    } else bg(notify([o0.customerId], 'payment_rejected', { no: orderNo(orderId) }, { url }));
    return { ok: true };
  },

  async 'admin/order-price'({ uid, body }) {
    const admin = await need({ uid }, ['admin']);
    const orderId = docId(body.orderId), ref = ordersCol().doc(orderId);
    const o0 = await loadOrder(orderId);
    if (!['open', 'accepted', 'awaiting_payment'].includes(o0.status) || o0.escrowStatus === 'held') throw new HttpError(409, 'bad_state');
    const price = int(body.price, 1, 10000000, 'bad_price');
    await runTx(async (tx) => {
      const o = orderFromSnap(await tx.get(ref));
      if (!['open', 'accepted', 'awaiting_payment'].includes(o.status) || o.escrowStatus === 'held') throw new HttpError(409, 'bad_state');
      tx.update(ref, orderPatch({ price, priceOverridden: true, priceNote: str(body.note ?? '', 0, 200) }, L(o.status, admin.uid, { note: 'price_override', price })));
    });
    return { ok: true };
  },

  async 'admin/withdrawals'({ uid }) {
    await need({ uid }, ['admin']);
    const snap = await withdrawalsCol().orderBy('createdAt', 'desc').limit(200).get();
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.status === 'pending') === (b.status === 'pending') ? 0 : a.status === 'pending' ? -1 : 1);
    return { withdrawals: rows.map(withdrawalOut) };
  },

  async 'admin/withdrawal'({ uid, body }) {
    const admin = await need({ uid }, ['admin']);
    const ref = withdrawalsCol().doc(docId(body.id));
    const { amount, targetUid } = await runTx(async (tx) => {
      const wSnap = await tx.get(ref);
      if (!wSnap.exists) throw new HttpError(404, 'not_found');
      const w = wSnap.data();
      if (w.status !== 'pending') throw new HttpError(409, 'bad_state');
      const note = str(body.note ?? '', 0, 200);
      if (body.action === 'paid') tx.update(ref, { status: 'paid', note, decidedBy: admin.uid, decidedAt: now() });
      else if (body.action === 'reject') {
        tx.update(ref, { status: 'rejected', note, decidedBy: admin.uid, decidedAt: now() });
        walletCreditTx(tx, w.uid, w.amount);
        walletTxTx(tx, { uid: w.uid, type: 'withdrawal_refund', amount: w.amount, withdrawalId: w.id });
      } else throw new HttpError(400, 'bad_action');
      return { amount: w.amount, targetUid: w.uid };
    });
    bg(notify([targetUid], body.action === 'paid' ? 'withdrawal_paid' : 'withdrawal_rejected', { amount }, { url: '/#/driver/wallet' }));
    return { ok: true };
  },

  async 'admin/disputes'({ uid }) {
    await need({ uid }, ['admin']);
    const snap = await disputesCol().orderBy('createdAt', 'desc').limit(100).get();
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.status === 'open') === (b.status === 'open') ? 0 : a.status === 'open' ? -1 : 1);
    const ids = [...new Set(rows.map((r) => r.orderId))];
    const orderSnaps = await Promise.all(ids.map((id) => ordersCol().doc(id).get()));
    const byId = Object.fromEntries(orderSnaps.filter((s) => s.exists).map((s) => [s.id, orderOut({ id: s.id, ...s.data() }, { role: 'admin' })]));
    const chats = await Promise.all(ids.map((id) => messagesCol(id).orderBy('createdAt', 'asc').limit(400).get()));
    const chatOf = {};
    ids.forEach((oid, i) => { chatOf[oid] = chats[i].docs.map((d) => { const m = d.data(); return { from: m.senderId === byId[oid]?.customerId ? 'customer' : m.senderId === byId[oid]?.driverId ? 'driver' : 'admin', body: m.body, at: m.createdAt }; }); });
    return { disputes: rows.map((r) => ({ ...disputeOut(r), order: byId[r.orderId] || null, chat: chatOf[r.orderId] || [] })) };
  },

  // ---------- حسم النزاع: رد كامل للعميل / تحويل كامل للسواق / تقسيم بنسبة ----------
  async 'admin/dispute'({ uid, body }) {
    const admin = await need({ uid }, ['admin']);
    const disputeRef = disputesCol().doc(docId(body.id));
    const dSnap0 = await disputeRef.get();
    if (!dSnap0.exists) throw new HttpError(404, 'not_found');
    const d0 = dSnap0.data();
    if (d0.status !== 'open') throw new HttpError(409, 'bad_state');
    const orderRef = ordersCol().doc(d0.orderId);
    const o0 = await loadOrder(d0.orderId);
    if (o0.status !== 'disputed') throw new HttpError(409, 'bad_state');
    const pct = body.decision === 'refund' ? 100 : body.decision === 'release' ? 0 : body.decision === 'split' ? int(body.customerPct, 1, 99) : null;
    if (pct === null) throw new HttpError(400, 'bad_decision');
    const note = str(body.note ?? '', 0, 500);
    const customerRefund = Math.round((o0.price * pct) / 100);
    const driverGross = o0.price - customerRefund;
    const s = await loadSettings();
    const driverSnap0 = await usersCol().doc(o0.driverId).get();
    const pct_ = effectiveCommissionPct(s, o0.commissionPct, driverSnap0.data());
    const { commission, net } = driverGross > 0 ? split(driverGross, pct_) : { commission: 0, net: 0 };
    await runTx(async (tx) => {
      const [dSnap, oSnap] = await Promise.all([tx.get(disputeRef), tx.get(orderRef)]);
      if (!dSnap.exists || dSnap.data().status !== 'open') throw new HttpError(409, 'bad_state');
      tx.update(disputeRef, { status: 'resolved', decision: body.decision, customerPct: pct, customerRefund, driverNet: net, commission, note, refundPaid: customerRefund === 0, resolvedBy: admin.uid, resolvedAt: now() });
      tx.update(orderRef, orderPatch({ status: 'resolved', escrowStatus: 'settled', commission, driverNet: net, customerRefund, resolution: body.decision }, L('resolved', admin.uid)));
      if (net > 0) { walletCreditTx(tx, o0.driverId, net); walletTxTx(tx, { uid: o0.driverId, type: 'dispute_earning', orderId: o0.id, amount: net, gross: driverGross, commission }); }
    });
    return { ok: true, customerRefund, driverNet: net };
  },

  async 'admin/dispute-refund'({ uid, body }) {
    await need({ uid }, ['admin']);
    const ref = disputesCol().doc(docId(body.id));
    await runTx(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists || s.data().status !== 'resolved') throw new HttpError(409, 'bad_state');
      tx.update(ref, { refundPaid: true, refundPaidAt: now() });
    });
    return { ok: true };
  },

  // ---------- بلاغات ----------
  async 'reports/create'({ uid, body }) {
    const u = await need({ uid }, ['customer', 'driver']);
    const o = await loadOrder(docId(body.orderId));
    if (o.customerId !== uid && o.driverId !== uid) throw new HttpError(403, 'forbidden');
    if (!o.driverId) throw new HttpError(409, 'bad_state');
    if (!REPORT_REASONS.includes(body.reason)) throw new HttpError(400, 'bad_reason');
    const recent = await reportsCol().where('reporterId', '==', uid).where('createdAt', '>', now() - 3600e3).count().get();
    if (recent.data().count >= 5) throw new HttpError(429, 'too_many_reports');
    const chatSnap = await messagesCol(o.id).orderBy('createdAt', 'desc').limit(30).get();
    const chat = chatSnap.docs.reverse().map((d) => { const m = d.data(); return { from: m.senderId === o.customerId ? 'customer' : m.senderId === o.driverId ? 'driver' : 'admin', body: m.body, at: m.createdAt }; });
    const id = newId();
    await reportsCol().doc(id).set({ id, reporterId: uid, targetId: uid === o.customerId ? o.driverId : o.customerId, orderId: o.id, reason: body.reason, details: str(body.details ?? '', 0, 1000), context: { chat, orderStatus: o.status }, status: 'open', createdAt: now() });
    await toAdmins('report', { no: orderNo(o.id), name: u.name }, '/#/admin/reports');
    return { ok: true, id };
  },

  // ---------- زر الطوارئ ----------
  async 'sos/trigger'({ uid, body }) {
    const u = await need({ uid }, ['customer', 'driver']);
    const o = await loadOrder(docId(body.orderId));
    if (o.customerId !== uid && o.driverId !== uid) throw new HttpError(403, 'forbidden');
    if (o.service !== 'passengers' || !['heading_pickup', 'picked_up', 'in_transit'].includes(o.status)) throw new HttpError(409, 'bad_state');
    let lat = null, lng = null;
    if (body.lat != null) { const p = point(body, false); lat = p.lat; lng = p.lng; }
    const openSnap = await sosCol().where('orderId', '==', o.id).where('userId', '==', uid).where('status', '==', 'open').orderBy('createdAt', 'desc').limit(1).get();
    let id, notifyNow = true;
    if (!openSnap.empty) {
      const doc = openSnap.docs[0];
      id = doc.id; notifyNow = now() - doc.data().updatedAt > 60000;
      await doc.ref.update({ ...(lat != null ? { lat, lng } : {}), updatedAt: now() });
    } else {
      const recent = await sosCol().where('userId', '==', uid).where('createdAt', '>', now() - 3600e3).count().get();
      if (recent.data().count >= 3) throw new HttpError(429, 'too_many_reports');
      id = newId();
      await sosCol().doc(id).set({ id, orderId: o.id, userId: uid, lat, lng, status: 'open', createdAt: now(), updatedAt: now() });
    }
    if (notifyNow) await toAdmins('sos', { no: orderNo(o.id), name: u.name }, '/#/admin/reports');
    return { ok: true, id, emergency: { police: '122', ambulance: '123' } };
  },

  async 'admin/reports'({ uid }) {
    await need({ uid }, ['admin']);
    const [rsSnap, ssSnap] = await Promise.all([
      reportsCol().orderBy('createdAt', 'desc').limit(100).get(),
      sosCol().orderBy('createdAt', 'desc').limit(50).get(),
    ]);
    const rs = rsSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.status === 'open') === (b.status === 'open') ? 0 : a.status === 'open' ? -1 : 1);
    const ss = ssSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.status === 'open') === (b.status === 'open') ? 0 : a.status === 'open' ? -1 : 1);
    const peopleIds = [...new Set([...rs.flatMap((r) => [r.reporterId, r.targetId]), ...ss.map((s) => s.userId)])];
    const peopleSnaps = await Promise.all(peopleIds.map((id) => usersCol().doc(id).get()));
    const people = Object.fromEntries(peopleSnaps.map((s) => [s.id, s.data() || {}]));
    const orderIds = [...new Set(ss.map((s) => s.orderId))];
    const orderSnaps = await Promise.all(orderIds.map((id) => ordersCol().doc(id).get()));
    const orders = Object.fromEntries(orderSnaps.filter((s) => s.exists).map((s) => [s.id, s.data()]));
    return {
      reports: rs.map((r) => ({ id: r.id, orderId: r.orderId, reason: r.reason, details: r.details, status: r.status, adminNote: r.adminNote ?? null, createdAt: r.createdAt, handledAt: r.handledAt ?? null,
        reporter: { name: people[r.reporterId]?.name, phone: people[r.reporterId]?.phone }, target: { uid: r.targetId, name: people[r.targetId]?.name, phone: people[r.targetId]?.phone }, context: r.context || {} })),
      sos: ss.map((e) => { const d = orders[e.orderId] || {}; return { id: e.id, orderId: e.orderId, status: e.status, note: e.note ?? null, lat: e.lat, lng: e.lng, createdAt: e.createdAt, updatedAt: e.updatedAt,
        by: { name: people[e.userId]?.name, phone: people[e.userId]?.phone }, customer: { name: d.customerName, phone: d.customerPhone }, driver: { name: d.driverName, phone: d.driverPhone }, pickup: d.pickup, dropoff: d.dropoff }; }),
    };
  },
  async 'admin/report'({ uid, body }) {
    const admin = await need({ uid }, ['admin']);
    const ref = reportsCol().doc(docId(body.id));
    if (!['resolve', 'dismiss'].includes(body.action)) throw new HttpError(400, 'bad_action');
    const { reporterId, orderId } = await runTx(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) throw new HttpError(404, 'not_found');
      const r = s.data();
      if (r.status !== 'open') throw new HttpError(409, 'bad_state');
      tx.update(ref, { status: body.action === 'resolve' ? 'resolved' : 'dismissed', adminNote: str(body.note ?? '', 0, 500), handledBy: admin.uid, handledAt: now() });
      return { reporterId: r.reporterId, orderId: r.orderId };
    });
    bg(notify([reporterId], 'report_handled', { no: orderNo(orderId) }, { url: `/#/order/${orderId}` }));
    return { ok: true };
  },
  async 'admin/sos-handle'({ uid, body }) {
    const admin = await need({ uid }, ['admin']);
    const ref = sosCol().doc(docId(body.id));
    await runTx(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists || s.data().status !== 'open') throw new HttpError(409, 'bad_state');
      tx.update(ref, { status: 'handled', note: str(body.note ?? '', 0, 500), handledBy: admin.uid, handledAt: now() });
    });
    return { ok: true };
  },

  // ---------- استرجاع الفلوس (يدوي على InstaPay) ----------
  async 'admin/refunds'({ uid }) {
    await need({ uid }, ['admin']);
    const snap = await refundsCol().orderBy('createdAt', 'desc').limit(200).get();
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.status === 'pending') === (b.status === 'pending') ? 0 : a.status === 'pending' ? -1 : 1);
    const custIds = [...new Set(rows.map((r) => r.customerId))];
    const custSnaps = await Promise.all(custIds.map((id) => usersCol().doc(id).get()));
    const custs = Object.fromEntries(custSnaps.map((s) => [s.id, s.data() || {}]));
    return { refunds: rows.map((r) => ({ id: r.id, orderId: r.orderId, customerId: r.customerId, customerName: custs[r.customerId]?.name, customerPhone: custs[r.customerId]?.phone, amount: r.amount, reason: r.reason, status: r.status, note: r.note ?? null, createdAt: r.createdAt, paidAt: r.paidAt ?? null })) };
  },
  async 'admin/refund'({ uid, body }) {
    const admin = await need({ uid }, ['admin']);
    const ref = refundsCol().doc(docId(body.id));
    const f0 = await ref.get();
    if (!f0.exists) throw new HttpError(404, 'not_found');
    if (f0.data().status !== 'pending') throw new HttpError(409, 'bad_state');
    const orderRef = ordersCol().doc(f0.data().orderId);
    await runTx(async (tx) => {
      const [fSnap, oSnap] = await Promise.all([tx.get(ref), tx.get(orderRef)]);
      if (!fSnap.exists || fSnap.data().status !== 'pending') throw new HttpError(409, 'bad_state');
      tx.update(ref, { status: 'paid', note: str(body.note ?? '', 0, 200), paidAt: now(), paidBy: admin.uid });
      const o = orderFromSnap(oSnap);
      tx.update(orderRef, orderPatch(o.escrowStatus === 'refund_pending' ? { escrowStatus: 'refunded' } : {}, L(o.status, admin.uid, { note: 'refund_paid' })));
    });
    bg(notify([f0.data().customerId], 'refund_paid', { no: orderNo(f0.data().orderId), amount: f0.data().amount }, { url: `/#/order/${f0.data().orderId}` }));
    return { ok: true };
  },

  // ---------- الشات ----------
  async 'chat/list'({ uid, body }) {
    const u = await viewer({ uid });
    const o = await loadOrder(docId(body.orderId));
    if (!(o.customerId === uid || o.driverId === uid || u.role === 'admin')) throw new HttpError(403, 'forbidden');
    if (!o.driverId) throw new HttpError(409, 'chat_closed');
    const after = Math.max(0, Math.floor(Number(body.after) || 0));
    const snap = await messagesCol(o.id).where('createdAt', '>', after).orderBy('createdAt', 'asc').limit(200).get();
    return { open: CHAT_OPEN.includes(o.status), messages: snap.docs.map((d) => { const m = d.data(); return { seq: m.createdAt, id: d.id, mine: m.senderId === uid, from: m.senderId === o.customerId ? 'customer' : m.senderId === o.driverId ? 'driver' : 'admin', body: m.body, at: m.createdAt }; }) };
  },
  async 'chat/send'({ uid, body }) {
    const u = await need({ uid }, ['customer', 'driver']);
    const o = await loadOrder(docId(body.orderId));
    if (o.customerId !== uid && o.driverId !== uid) throw new HttpError(403, 'forbidden');
    if (!o.driverId || !CHAT_OPEN.includes(o.status)) throw new HttpError(409, 'chat_closed');
    const bodyText = str(body.body, 1, 500);
    const recent = await messagesCol(o.id).where('senderId', '==', uid).where('createdAt', '>', now() - 60000).count().get();
    if (recent.data().count >= 20) throw new HttpError(429, 'too_many_messages');
    const id = newId();
    await messagesCol(o.id).doc(id).set({ id, senderId: uid, body: bodyText, createdAt: now() });
    bg(notify([uid === o.customerId ? o.driverId : o.customerId], 'chat', { name: u.name, text: bodyText.slice(0, 120) }, { url: `/#/order/${o.id}`, tag: `chat-${o.id}` }));
    return { ok: true, id };
  },

  async 'admin/settings/save'({ uid, body }) {
    await need({ uid }, ['admin']);
    const clean = sanitizeSettings(body);
    await settingsDoc().set({ v: clean });
    return { settings: await loadSettings() };
  },

  async 'admin/blacklist'({ uid }) {
    await need({ uid }, ['admin']);
    const snap = await blacklistCol().orderBy('at', 'desc').limit(500).get();
    return { items: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
  },
  async 'admin/blacklist/add'({ uid, body }) {
    await need({ uid }, ['admin']);
    const type = body.type, value = String(body.value ?? '').replace(/\D/g, '');
    if (!['phone', 'nid'].includes(type) || (type === 'phone' && !/^01[0125]\d{8}$/.test(value)) || (type === 'nid' && !/^\d{14}$/.test(value))) throw new HttpError(400, 'bad_input');
    await blacklistCol().doc(`${type}_${value}`).set({ type, value, reason: str(body.reason ?? '', 0, 200), at: now() });
    return { ok: true };
  },
  async 'admin/blacklist/remove'({ uid, body }) {
    await need({ uid }, ['admin']);
    await blacklistCol().doc(str(body.id, 3, 40)).delete();
    return { ok: true };
  },
};

// =====================================================================
// نقطة الدخول: Worker واحد بيقدّم الموقع الثابت (public/) وبيتعامل مع /api/* بنفس الوقت
// (النموذج الحديث "Workers with Static Assets" بدل Pages القديم).
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const errorResponse = (e) => {
  if (!(e instanceof HttpError)) console.error(e);
  // detail: سبب الخطأ الحقيقي (للتشخيص وقت الإعداد) — مفيهوش أي أسرار. لو حبيت تشيله بعد ما كل حاجة تشتغل، احذف السطر ده وارجع للسطر البسيط اللي كان: if (e instanceof HttpError) return json({ error: e.code }, e.status);
  const status = e instanceof HttpError ? e.status : 500;
  const code = e instanceof HttpError ? e.code : 'server_error';
  const detail = e?.detail || e?.message || String(e);
  return json({ error: code, detail: String(detail).slice(0, 400) }, status);
};
const bearerFrom = (request) => (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');

// تشخيص الربط: افتح <رابط الموقع>/api/health بعد النشر
async function health() {
  const out = { ok: false, push: pushEnabled() };
  try { await settingsDoc().get(); out.ok = true; } catch (e) { out.error = e?.message; }
  return out;
}

async function handleApi(request, env, route) {
  const projectId = boot(env);
  if (request.method === 'GET' && route === 'health') return json(await health());

  const filesMatch = route.match(/^files\/([A-Za-z0-9]{10,40})$/);
  if (request.method === 'GET' && filesMatch) {
    const bearer = bearerFrom(request);
    if (!bearer) throw new HttpError(401, 'unauthenticated');
    const token = await verifyIdToken(bearer, projectId);
    const snap = await usersCol().doc(token.uid).get();
    const role = snap.exists ? snap.data().role : null;
    const { bytes, mime } = await readFile({ uid: token.uid, role }, filesMatch[1]);
    return new Response(bytes, { headers: { 'Content-Type': mime, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
  }

  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const bearer = bearerFrom(request);
  if (!bearer) throw new HttpError(401, 'unauthenticated');
  const token = await verifyIdToken(bearer, projectId);
  const handler = Object.hasOwn(ROUTES, route) ? ROUTES[route] : null;
  if (!handler) throw new HttpError(404, 'not_found');
  let body = {};
  try { body = (await request.json()) || {}; } catch { /* body فاضي مقبول لبعض الـ routes */ }
  const headers = Object.fromEntries(request.headers);
  const result = await handler({ uid: token.uid, token, body, headers });
  return json(result);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const route = url.pathname.replace(/^\/api\/?/, '');
      try { return await handleApi(request, env, route); } catch (e) { return errorResponse(e); }
    }
    // أي حاجة تانية: ملفات الموقع الثابتة (public/) — الـ binding اسمه ASSETS في wrangler.jsonc
    return env.ASSETS.fetch(request);
  },
};
