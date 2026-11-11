// كل المنطق الحساس (الصلاحيات، السعر، Escrow، العمولة، المحفظة، النزاعات) بيتنفذ هنا على السيرفر (Cloudflare Pages Functions).
// البيانات في Firestore، والمتصفح مالوش وصول مباشر ليها: كل قراءة وكتابة بتعدّي من هنا وبتتفلتر حسب دور المستخدم.
import { HttpError, verifyIdToken, newId } from '../_lib/core.js';
import { F, STAMP_KINDS, STAMP_PATH, now, rateLimit, rateTake, walletCredit, walletTx, userOut, fleetOut, withdrawalOut, txOut, disputeOut, loadOrder, hydrateOrder, orderUpdate, orderOut, auditLog } from '../_lib/db.js';
import { randomBase32, totpMatch, otpauthURL } from '../_lib/totp.js';
import { loadSettings, clearSettingsCache, sanitizeSettings, distanceKm, calcPrice, calcPassengerPrice, effectiveCommissionPct, canServe, cancelSplit, couponDiscount, haversineM, split, dueOf, lateKinds, guardOf, codPeriodOf, codPeriodBounds, codSplit, codStatements, codBlocked } from '../_lib/logic.js';
import { dcDue, dcBlocked, dcPayable, dcFeesOn, kmFeeOf, vehicleOfSize, fineCredit } from '../_lib/logic.js';
import { saveFile, ownFiles, readFile } from '../_lib/files.js';
import { notify, dispatchNewOrder, adminIds, orderNo, pushEnabled, renderMsg } from '../_lib/push.js';
import { trustOf } from '../_lib/trust.js';
import { flushMetrics, recordError, sentryCapture } from '../_lib/metrics.js';

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
// عناوين العميل المحفوظة (اسم + نقطة على الخريطة) — بتتخزن كـ JSON نصي على مستند المستخدم
const MAX_ADDRESSES = 10;
const parseAddresses = (arr) => {
  if (!Array.isArray(arr) || arr.length > MAX_ADDRESSES) throw new HttpError(400, 'bad_addresses');
  return arr.map((a) => ({ label: str(a?.label ?? '', 1, 30), ...point(a, true) }));
};
// قفل تعديل بيانات الحساب: المدة الفعّالة (عامة أو مخصّصة للمستخدم) + آخر تعديل + الميعاد الجاي. الأدمن معفى دايماً.
const editLock = (r, s) => {
  const days = r?.profile_edit_days != null ? Number(r.profile_edit_days) : s.profileEditCooldownDays;
  const lastAt = Number(r?.profile_edited_at || 0), nextAt = lastAt + days * 86400e3;
  const enabled = !!r && r.role !== 'admin' && s.profileEditEnabled && days > 0;
  return { enabled, days, lastAt, nextAt, locked: enabled && now() < nextAt };
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
// ----- الدفع عند الاستلام (COD): قراية الحساب + حراسة السواق المتأخر -----
const codOf = (v, s) => {
  if (v === undefined || v === null || v === '' || Number(v) === 0) return null;
  if (!s.codEnabled) throw new HttpError(400, 'cod_disabled');
  const x = Number(v); if (!Number.isInteger(x) || x < 1 || x > s.codMaxAmount) throw new HttpError(400, 'bad_cod');
  return { amount: x };
};
const codEntriesOf = (env, driverId) => F.query(env, 'cod', { eq: { driver_id: driverId }, limit: 500 });
const codPaysOf = async (env, driverId) => Object.fromEntries((await F.query(env, 'cod_pay', { eq: { driver_id: driverId }, limit: 100 })).map((p) => [p.period, p]));
const codStatementsOf = async (env, driverId, s) => codStatements(await codEntriesOf(env, driverId), await codPaysOf(env, driverId), s, now());
/** السواق اللي عدّى موعد سداد كشف حسابه بيتوقف تلقائياً (نطاق التوقف من الإعدادات). لو النظام مقفول مفيش توقيف. */
const codGate = async (env, uid, s, o) => {
  if (!s.codEnabled) return;
  if (s.codBlockScope !== 'all' && !(o?.cod?.amount > 0)) return;
  if (codBlocked(await codStatementsOf(env, uid, s))) throw new HttpError(403, 'cod_blocked');
};
// ----- نظام الدفع المباشر + عمولة المنصة (dc) -----
/** السواق اللي إجمالي مكسبه غير المسدَّد وصل للحد (أو عدّاه) ما ياخدش طلبات جديدة لحد ما يسدّد. الطلبات الشغّالة بتكمّل عادي. النظام مقفول أو النسبة 0 = مفيش توقيف. */
const dcGate = async (env, uid, s) => {
  if (!dcFeesOn(s)) return; // مفيش رسوم (نسبة أو كيلومتر) = مفيش توقيف
  if (dcBlocked((await F.get(env, `users/${uid}`))?.dc_gross || 0, s)) throw new HttpError(403, 'dc_blocked');
};
// ----- تعويض السواق وغرامة العميل (الدفع المباشر) -----
const parseJson = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
const fineOn = (s) => s.finesEnabled === true && s.dcEnabled === true; // الغرامات مرتبطة بنظام الدفع المباشر
const curFine = async (env, uid) => Math.max(0, Math.floor((await F.get(env, `users/${uid}`))?.fine_due || 0));
const claimOut = (r) => ({ id: r.id, orderId: r.order_id, driverId: r.driver_id, driverName: r.driver_name, customerId: r.customer_id, customerName: r.customer_name, kind: r.kind, amount: r.amount, credit: r.credit || 0, remaining: r.remaining || 0, status: r.status, createdAt: r.created_at, applyAt: r.apply_at, appliedAt: r.applied_at || null, declaredAt: r.declared_at || null, objected: r.objected === true, objectNote: r.object_note || null, note: r.note || null });
/** موقع السواق: اللي بعته مع الطلب لو صالح، وإلا آخر موقع متسجّل في «متاح لاستقبال الطلبات» */
const driverLoc = async (c) => {
  if (c.body?.loc) { try { return point(c.body.loc, false); } catch { /* موقع غلط: نرجع لآخر موقع معروف */ } }
  const r = await F.get(c.env, `driver_presence/${c.uid}`);
  return r && r.lat != null && r.lng != null ? { lat: r.lat, lng: r.lng } : null;
};
/** نطاق الطلبات: الطلب بعيد عن موقع السواق أكتر من الحد = ممنوع (من غير موقع معروف مبنمنعش — القائمة أصلاً مابتعرضش حاجة من غير موقع) */
const radiusGate = async (c, s, o) => {
  if (!(s.jobsRadiusKm > 0)) return;
  const me = await driverLoc(c);
  if (me && o.pickup && haversineM(me, o.pickup) > s.jobsRadiusKm * 1000) throw new HttpError(403, 'out_of_range');
};
const s0Block = (s, row) => dcBlocked(row?.dc_gross || 0, s);
const dcRefKey = (method, ref) => sha256hex(`${method}:${String(ref).toLowerCase().replace(/\s+/g, '')}`); // نفس رقم المرجع ما يتستخدمش مرتين (منع تكرار إثبات التحويل)
const dcPayOut = (r) => ({ id: r.id, driverId: r.driver_id, name: r.driver_name, gross: r.gross, pct: r.pct, amount: r.amount, commission: r.commission ?? r.amount, km: r.km || 0, kmFee: r.km_fee || 0, creditUsed: r.credit_used || 0, finesHeld: r.fines_held || 0, method: r.method, reference: r.reference, proof: r.proof, status: r.status, note: r.note, createdAt: r.created_at, decidedAt: r.decided_at });
const offerId = (v) => { const s = String(v ?? ''); const m = /^([A-Za-z0-9]{10,40})_([A-Za-z0-9_-]{4,128})$/.exec(s); if (!m) throw new HttpError(400, 'bad_id'); return { key: s, orderId: m[1], uid: m[2] }; };
const byDesc = (f) => (a, b) => (b[f] ?? 0) - (a[f] ?? 0);
const RL_SKIP = new Set(['sync', 'me', 'settings', 'health']); // مسارات كتير ومتكررة (Polling) — ما تتحسبش في الحدّ المركزي
// توكن جلسة 2FA (حروف وأرقام فقط، 40 حرف = newId()+newId()): أي شكل تاني يتجاهل — بدونه الهيدر كان بيدخل في مسار Firestore (../ بيغيّر المستند)
const tfaToken = (v) => { const t = String(v ?? '').trim(); return /^[A-Za-z0-9]{20,64}$/.test(t) ? t : ''; };
const sha256hex = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const dayKey = (t) => new Date(t + 2 * 3600e3).toISOString().slice(0, 10); // يوم بتوقيت مصر (تقريباً)

// ---------- المستخدم الحالي ----------
async function need(c, roles, opts = {}) {
  const r = await F.get(c.env, `users/${c.uid}`);
  if (!r) throw new HttpError(403, 'no_profile');
  // الأدمن بيستخدم المنصة كمستخدم عادي (عميل) كمان: مسارات العميل بس — مش مسارات السواق ولا صلاحيات الأدمن
  const asCustomer = r.role === 'admin' && roles.includes('customer') && !roles.includes('admin');
  if (!roles.includes(r.role) && !asCustomer) throw new HttpError(403, 'forbidden');
  if (r.status !== 'active' && r.role !== 'admin') throw new HttpError(403, 'account_not_active'); // الأدمن مستثنى زي viewer() — الدور بيحمي المسارات
  // التحقق بخطوتين للأدمن: لو مفعّل، لازم جلسة 2FA سارية (ما عدا شاشات الإعداد نفسها، واستخدامه كعميل)
  if (!opts.skip2fa && !asCustomer && r.role === 'admin' && r.totp_enabled) {
    const tk = tfaToken(c.request?.headers?.get('x-2fa'));
    const s = tk ? await F.get(c.env, `admin_2fa/${tk}`) : null;
    if (!s || s.uid !== c.uid || Number(s.exp || 0) < now()) throw new HttpError(403, 'totp_required');
  }
  return userOut(r);
}
// حدّ محاولات التحقق بخطوتين (كود 6 أرقام): 8 محاولات كل 10 دقايق للمستخدم — بدونها التخمين محدود بالحد العام بس
async function totpGate(c) { if (c.env.API_RATE_DISABLED === '1') return; await rateTake(c.env, 'totp', c.uid, 600e3, 8, 'too_many_attempts'); }
/** يتحقق من كود TOTP ويمنع إعادة استخدامه: لازم عدّاد أحدث من آخر عدّاد اتقبل (totp_last). بيرجّع العدّاد عشان يتكتب مع الـpatch بتاع نفس العملية. */
async function totpUse(u, code) {
  const k = await totpMatch(u.totp_secret, code);
  if (k == null || k <= Number(u.totp_last || 0)) throw new HttpError(400, 'totp_bad_code');
  return k;
}
async function needCompany(c) { const u = await need(c, ['driver']); if (u.accountType !== 'company') throw new HttpError(403, 'company_only'); return u; }
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
// كود التسليم: بيتولّد من الطلب نفسه بـ HMAC بسر السيرفر (مش متخزّن في أي مكان فمش ممكن يتسرّب من تصدير أو قاعدة بيانات)
const codeActive = (env, s) => s.deliveryCode === true && !!env.DELIVERY_CODE_SECRET;
const codeNeeded = (env, s, o) => !!env.DELIVERY_CODE_SECRET && (s.deliveryCode === true || o.guard === 'high'); // الشحنة العالية (حراسة القيمة) كودها إجباري حتى لو الإعداد العام مقفول
async function deliveryCodeOf(env, orderId, label = 'dc') { // 'dc' = كود التسليم، 'sc' = كود بداية الرحلة
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.DELIVERY_CODE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(label + ':' + orderId)));
  return String((((sig[0] << 24) | (sig[1] << 16) | (sig[2] << 8) | sig[3]) >>> 0) % 1000000).padStart(6, '0');
}
const safeEq = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

// تحرير الفلوس للسواق/الشركة (مشترك بين تأكيد العميل والتحرير التلقائي — نفس الشروط الذرّية بالظبط)
async function releaseStmts(env, o, s, by, note) {
  const driver = await F.get(env, `users/${o.driverId}`);
  const pct = effectiveCommissionPct(s, o.commissionPct, driver); // خصم مستوى الثقة + عمولة السواق الجديد
  const { commission, net } = split(o.price, pct);
  return { net, commission, stmts: [
    ...orderUpdate(env, o, { status: 'completed', escrowStatus: 'released', commission, driverNet: net, commissionPctApplied: pct, completedAt: now() }, L('completed', by, note ? { note } : {})),
    walletCredit(o.driverId, net),
    walletTx({ uid: o.driverId, type: 'earning', orderId: o.id, amount: net, gross: o.price, commission }),
    F.inc(`users/${o.driverId}`, { completed_orders: 1 }), F.inc(`users/${o.customerId}`, { completed_orders: 1 }),
  ] };
}

// إكمال طلب الدفع المباشر (تأكيد السواق/العميل أو الإكمال التلقائي): مفيش ضمان ولا محفظة (العميل دفع للسواق مباشرة). بنسجّل مكسب السواق في دفتر العمولة (لو النظام شغّال والنسبة > 0).
// مستند الدفتر معرّفه = رقم الطلب و create بيفشل لو موجود => الطلب ما يتحسبش مرتين.
// غرامة العميل اللي السواق حصّلها مع الطلب (الرقم اللي كان شايفه وقت القبول، بحد أقصى المتبقي على العميل فعلاً) بتتوزّع على مطالباته من الأقدم،
// وبتبقى مبلغ مطلوب تحويله للمنصة (dc_fines_held) بعد نسبة المحصِّل (fineCollectorPct).
async function directDoneStmts(env, o, s, patch, log) {
  const gross = collectedOf(o), t = now(), km = Math.max(0, Math.round((Number(o.distanceKm) || 0) * 10) / 10), vk = o.vehiclePick || vehicleOfSize(s, o.size);
  const kmFee = kmFeeOf(s, km, vk), rec = dcFeesOn(s) && (gross > 0 || kmFee > 0); // بنسجّل في الدفتر لو فيه رسوم (نسبة أو كيلومترات)
  let take = 0, claims = [];
  if ((o.fineDue || 0) > 0) {
    take = Math.min(Math.floor(o.fineDue), await curFine(env, o.customerId));
    if (take > 0) claims = (await F.query(env, 'fines', { eq: { customer_id: o.customerId }, limit: 50 })).filter((x) => x.status === 'applied' && (x.remaining || 0) > 0).sort((x, y) => (x.applied_at || 0) - (y.applied_at || 0));
  }
  const keep = Math.floor((take * (s.fineCollectorPct || 0)) / 100), owe = take - keep, claimWrites = [];
  let left = take;
  for (const x of claims) {
    if (left <= 0) break;
    const use = Math.min(left, x.remaining); left -= use;
    claimWrites.push(F.patch(`fines/${x.id}`, { remaining: x.remaining - use, status: x.remaining - use === 0 ? 'collected' : 'applied', collected_by: JSON.stringify([...parseJson(x.collected_by), { order_id: o.id, driver_id: o.driverId, amount: use, at: t }]) }, x._ut)); // المصفوفات بتتخزّن كنص JSON
  }
  return [
    ...orderUpdate(env, o, { ...patch, status: 'completed', completedAt: t, directGross: gross, directKm: km, ...(rec && kmFee > 0 ? { kmFee } : {}), ...(take > 0 ? { fineCollected: take, fineKept: keep } : {}) }, log),
    F.inc(`users/${o.driverId}`, { completed_orders: 1, km_total: km, ...(rec ? { dc_gross: gross, dc_km: km, dc_kmfee: kmFee } : {}), ...(owe > 0 ? { dc_fines_held: owe } : {}) }),
    F.inc(`users/${o.customerId}`, { completed_orders: 1, ...(take > 0 ? { fine_due: -take } : {}) }),
    ...claimWrites,
    ...(rec ? [F.create(`dc_ledger/${o.driverId}/entries/${o.id}`, { id: o.id, order_id: o.id, driver_id: o.driverId, gross, km, km_fee: kmFee, vehicle: vk || null, at: t })] : []),
  ];
}

// بعد إكمال طلب مباشر: لو السواق عدّى حد الأرباح بالطلب ده بالذات نبلّغه فوراً إنه اتوقف عن قبول طلبات جديدة وإزاي يسدّد (مرة واحدة لكل مرة بيوصل فيها للحد)
async function dcNotifyLimit(env, o, s) {
  try {
    if (!dcFeesOn(s) || !o.driverId) return;
    const r = await F.get(env, `users/${o.driverId}`), now_ = r?.dc_gross || 0, prev = now_ - collectedOf(o);
    if (dcBlocked(now_, s) && !dcBlocked(prev, s)) await notify(env, [o.driverId], 'dc_limit_reached', { limit: s.dcLimit, due: dcPayable(now_, s.dcPct, r.dc_credit, r.dc_fines_held, r.dc_kmfee).amount }, { url: '/#/driver/fees' });
  } catch { /* الإشعار مش لازم يوقّف إكمال الطلب */ }
}

// تفاصيل الشحنة اللي السواق بيوافق عليها: بصمة (hash) بتتحفظ لحظة الموافقة كدليل إن الوصف ما اتغيّرش
const manifestHash = (o) => sha256hex(JSON.stringify([o.description || '', o.itemsCount || 1, o.declaredValue || 0, o.photos || [], o.category || '', o.size || '', o.weightKg || 0]));
const ACTIVE_JOB = ['accepted', 'payment_review', 'paid', 'heading_pickup', 'picked_up', 'in_transit']; // طلبات شغّالة على السواق (المسلَّم ما بيتحسبش)
// طلبات السواق الشغّالة: استعلام لكل حالة (مساواة فقط = من غير فهارس مركّبة). استعلام عام بـ limit كان ممكن يفوّت الشغّال لو السواق عنده طلبات تاريخ كتير.
const activeJobsOf = async (env, uid) => (await Promise.all(ACTIVE_JOB.map((st) => F.query(env, 'orders', { eq: { driver_id: uid, status: st }, limit: 50 })))).flat();
/** السواق الفرد: أقصى عدد طلبات شغّالة في نفس الوقت (الافتراضي 1). الشركات بتتحدد بسواق الأسطول في orders/handler.
 *  بيرجّع كتابة على مستند السواق بشرط النسخة: قبولين متوازيين بيفشل التاني (409) بدل ما الاتنين يعدّوا. */
async function driverSlot(env, uid, s, exceptOrderId) {
  const row = await F.get(env, `users/${uid}`);
  if (!row) throw new HttpError(409, 'driver_unavailable');
  if (row.account_type === 'company') return null;
  const mine = (await activeJobsOf(env, uid)).filter((r) => r.id !== exceptOrderId);
  if (mine.length >= s.maxActiveJobs) throw new HttpError(409, 'driver_busy');
  return F.patch(`users/${uid}`, { last_accept_at: now() }, row._ut);
}

const bg = (c, p) => { const safe = Promise.resolve(p).catch(() => {}); if (c.waitUntil) c.waitUntil(safe); return safe; };
// ---------- الكوبونات ----------
const normCode = (v) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, '');
const collectedOf = (o) => (o.amountDue ?? o.price); // المبلغ اللي العميل بيدفعه فعلاً (بعد الخصم)
const couponOut = (r) => r && ({
  id: r.id, code: r.code, type: r.type, value: r.value, maxDiscount: r.max_discount || 0, minPrice: r.min_price || 0,
  maxUses: r.max_uses || 0, perUser: r.per_user || 0, active: r.active === true, expiresAt: r.expires_at || 0,
  usedCount: r.used_count || 0, createdAt: r.created_at, updatedAt: r.updated_at,
});
/** بيتحقق من الكوبون لمستخدم معيّن ويرجّع قيمة الخصم. بيرمي HttpError برمز واضح لو مش ساري. */
async function applyCoupon(env, code, price, uid) {
  if (!/^[A-Z0-9_-]{3,20}$/.test(code)) throw new HttpError(400, 'coupon_not_found'); // نفس شكل كود الإنشاء: يمنع إدخال / أو .. في مسار المستند
  const coupon = await F.get(env, `coupons/${code}`);
  if (!coupon) throw new HttpError(400, 'coupon_not_found');
  const discount = couponDiscount(coupon, price);
  let use = null;
  if (coupon.per_user > 0 && discount > 0) {
    use = await F.get(env, `coupons/${code}/uses/${uid}`);
    if ((use?.n || 0) >= coupon.per_user) throw new HttpError(400, 'coupon_user_limit');
  }
  return { code, discount, coupon, use };
}

// استرجاع واحد بس لكل طلب (معرّف المستند = رقم الطلب، و create بيفشل لو موجود = منع التكرار)
const refundInsert = (env, o, reason, amount = collectedOf(o)) => F.create(`refunds/${o.id}`, { id: o.id, order_id: o.id, customer_id: o.customerId, amount, reason, status: 'pending', created_at: now() });
const afterRefundRequest = (c, o, amount = collectedOf(o)) => {
  toAdmins(c, 'refund_due', { no: orderNo(o.id), amount }, '/#/admin/refunds');
  bg(c, notify(c.env, [o.customerId], 'refund_pending', { no: orderNo(o.id), amount }, { url: `/#/order/${o.id}` }));
};
/** طلب مدفوع مقدماً ماحدش قبله لحد ميعاده + المهلة: بيتلغي ويتسجّل استرجاع للعميل (بدون Cron: بيتنفذ عند القراءة) */
async function expireOrder(env, o) {
  try {
    await F.run(env, [
      ...orderUpdate(env, o, { status: 'cancelled', escrowStatus: 'refund_pending', cancelledBy: 'system', cancelReason: 'no_driver' }, L('cancelled', 'system', { note: 'expired_no_driver' })),
      refundInsert(env, o, 'no_driver'),
    ]);
  } catch (e) { if (e.code === 'conflict') return false; throw e; }
  const amt = collectedOf(o);
  await notify(env, [o.customerId], 'refund_pending', { no: orderNo(o.id), amount: amt }, { url: `/#/order/${o.id}` });
  await notify(env, await adminIds(env), 'refund_due', { no: orderNo(o.id), amount: amt }, { url: '/#/admin/refunds' });
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
  // تحرير تلقائي: مسلَّم + محجوز + عدّى المدة + مفيش نزاع (النزاع بيغيّر الحالة لـ disputed فمش بيدخل هنا) + اتسلّم بكود (التسليم بدون كود بيستنّى تأكيد العميل)
  if (s.autoReleaseHours > 0) {
    const cut = now() - s.autoReleaseHours * 3600000;
    const due = (await F.query(env, 'orders', { eq: { status: 'delivered', escrow_status: 'held' }, limit: 100 })).map(hydrateOrder)
      .filter((o) => o.guard !== 'high' && o.deliveredAt && o.deliveredAt < cut && !o.late && (o.deliveryVerified === 'code' || (o.deliveryVerified === 'geo' && !o.deliveredWithoutCode))).slice(0, 10);
    for (const o of due) await autoRelease(env, o, s).catch((e) => console.error('auto_release_failed', e?.message));
  }
  const moving = (await Promise.all(['picked_up', 'in_transit', 'paid', 'heading_pickup'].map((st) => F.query(env, 'orders', { eq: { status: st }, limit: 50 })))).flat().map(hydrateOrder); // paid/heading_pickup: لتتبّع ميعاد الاستلام
  // الدفع المباشر: الشحنة اتستلمت وفضل الطلب مفتوح المدة دي من غير تأكيد (من السواق أو العميل) = اتسلّمت. بتتكمّل تلقائي وبتتحسب في عمولة السواق.
  const staleIds = new Set();
  if (s.dcAutoCompleteHours > 0) {
    const cutD = now() - s.dcAutoCompleteHours * 3600000;
    const stale = moving.filter((o) => o.direct === true && ['picked_up', 'in_transit'].includes(o.status) && (o.pickedUpAt || o.startedAt) && (o.pickedUpAt || o.startedAt) < cutD).slice(0, 10);
    for (const o of stale) { staleIds.add(o.id); await autoDirectDone(env, o, s).catch((e) => console.error('auto_direct_failed', e?.message)); }
  }
  if (fineOn(s)) { // مطالبات التعويض اللي مهلتها خلصت من غير تسوية مباشرة: بتتطبّق (إعفاء للسواق + غرامة على العميل)
    const t0 = now(), due = [...(await F.query(env, 'fines', { eq: { status: 'open' }, limit: 20 })), ...(await F.query(env, 'fines', { eq: { status: 'customer_paid' }, limit: 20 }))].filter((x) => (x.apply_at || 0) <= t0).slice(0, 10);
    for (const cl of due) await applyClaim(env, cl, s, 'system').catch((e) => console.error('apply_claim_failed', e?.message));
  }
  for (const o of moving) if (!staleIds.has(o.id)) await watchOrder(env, o, s).catch((e) => console.error('watch_failed', e?.message));
}
/** مطالبة تعويض على العميل: مفتوحة لحد ما السواق والعميل يتسوّوا مباشرة أو المهلة تخلص فتتطبّق. بترجع { stmt } أو { limited } (حد المطالبات اليومي) أو {} (مفيش مبلغ) */
async function claimStmt(env, o, kind, amount, s) {
  if (!(amount > 0)) return {};
  const t = now(), mine = await F.query(env, 'fines', { eq: { driver_id: o.driverId }, limit: 100 });
  if (s.fineMaxClaimsPerDay > 0 && mine.filter((x) => (x.created_at || 0) > t - 86400000).length >= s.fineMaxClaimsPerDay) return { limited: true };
  return { stmt: F.create(`fines/${o.id}`, { id: o.id, order_id: o.id, driver_id: o.driverId, driver_name: o.driverName || null, customer_id: o.customerId, customer_name: o.customerName || null, kind, amount, credit: 0, remaining: 0, status: 'open', created_at: t, apply_at: t + s.fineClaimHours * 3600000, applied_at: null, declared_at: null, objected: false, object_note: null, note: null }) };
}
/** تطبيق المطالبة: المنصة بتتنازل عن جزء من عمولة السواق (نسبة من الغرامة، بسقف شهري) والغرامة الكاملة بتتسجّل على العميل. الشرط الذرّي على المطالبة بيمنع التطبيق مرتين. */
async function applyClaim(env, cl, s, by) {
  const t = now();
  let credit = fineCredit(cl.amount, s.fineDriverSharePct);
  if (credit > 0 && s.fineMonthlyCap > 0) {
    const used = (await F.query(env, 'fines', { eq: { driver_id: cl.driver_id }, limit: 100 })).filter((x) => x.id !== cl.id && (x.credit || 0) > 0 && (x.applied_at || 0) > t - 30 * 86400000).reduce((a, x) => a + x.credit, 0);
    credit = Math.max(0, Math.min(credit, s.fineMonthlyCap - used));
  }
  await F.run(env, [
    F.patch(`fines/${cl.id}`, { status: 'applied', credit, credit_mode: s.fineCreditToWallet === true ? 'wallet' : 'commission', remaining: cl.amount, applied_at: t, applied_by: by }, cl._ut),
    F.inc(`users/${cl.customer_id}`, { fine_due: cl.amount }),
    ...(credit > 0 ? [s.fineCreditToWallet === true ? walletCredit(cl.driver_id, credit) : F.inc(`users/${cl.driver_id}`, { dc_credit: credit })] : []),
  ]);
  await notify(env, [cl.customer_id], 'fine_applied', { amount: cl.amount, no: orderNo(cl.order_id) }, { url: '/#/customer' }).catch(() => {});
  if (credit > 0) await notify(env, [cl.driver_id], 'credit_granted', { credit, no: orderNo(cl.order_id) }, { url: '/#/driver/dashboard' }).catch(() => {});
  return { credit };
}
async function autoDirectDone(env, o, s) {
  await F.run(env, await directDoneStmts(env, o, s, { deliveredAt: now(), deliveryVerified: 'auto' }, L('completed', 'system', { note: 'direct_auto' }))); // الشرط الذرّي في orderUpdate بيمنع التكرار لو اتأكد في نفس اللحظة
  await dcNotifyLimit(env, o, s);
  const v = { no: orderNo(o.id), hours: s.dcAutoCompleteHours };
  await notify(env, [o.customerId], 'direct_auto', v, { url: `/#/order/${o.id}` }).catch(() => {});
  await notify(env, [o.driverId], 'direct_auto', v, { url: '/#/driver/dashboard' }).catch(() => {});
}
// متابعة المستلم: أقل قدر من البيانات — حالة + اسم أول + نوع العربية + موقع تقريبي (≈550م) أثناء الرحلة فقط. مفيش تليفون ولا سعر ولا عنوان استلام ولا هوية.
async function publicTrack(request, env) {
  const H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };
  const out = (st, body) => new Response(JSON.stringify(body), { status: st, headers: H });
  try {
    const raw = await request.text(); if (raw.length > 300) return out(413, { error: 'too_large' });
    let t = ''; try { t = String(JSON.parse(raw || '{}').t ?? ''); } catch { /* ignore */ }
    if (!/^[A-Za-z0-9_-]{32}$/.test(t)) return out(404, { error: 'not_found' }); // رمز بشكل غلط: رد فوري من غير ما نلمس Firestore (الحد ده كان بيكتب مستند لكل طلب عشوائي)
    await rateTake(env, 'trk', (await sha256hex('ip:' + (request.headers.get('CF-Connecting-IP') || 'local'))).slice(0, 24), 60000, 30, 'too_many_requests');
    const sh = await F.get(env, `shares/${await sha256hex(t)}`);
    if (!sh || sh.revoked || sh.expires_at < now()) return out(404, { error: 'not_found' });
    const o = await loadOrder(env, sh.order_id).catch(() => null);
    if (!o) return out(404, { error: 'not_found' });
    if (['completed', 'cancelled', 'resolved', 'expired'].includes(o.status)) return out(200, { status: o.status, final: true });
    const rnd = (v) => Math.round(v / 0.005) * 0.005;
    const l = ['picked_up', 'in_transit'].includes(o.status) ? await F.get(env, `live_locations/${o.id}`) : null;
    const fresh = l && now() - l.at < 600000;
    return out(200, { status: o.status, final: false, driver: String(o.driverName || '').split(/\s+/)[0] || null, vehicleType: o.driverVehicle || null,
      location: fresh ? { lat: rnd(l.lat), lng: rnd(l.lng) } : null, dropoff: o.dropoff ? { lat: rnd(o.dropoff.lat), lng: rnd(o.dropoff.lng) } : null, updatedAt: fresh ? l.at : null });
  } catch (e) {
    if (e instanceof HttpError) return out(e.status, { error: e.code || 'error' });
    console.error('track_failed', e?.message); return out(500, { error: 'server_error' });
  }
}
// تنبيه التأخير/الوقوف أثناء الرحلة: مرة واحدة لكل طلب. الطلب المتأخر بيتعلّم (late) وما بيتحررش تلقائي.
async function watchOrder(env, o, s) {
  const t = now(), add = {}; let late = false, stall = false;
  if (o.deadlineAt && t > o.deadlineAt && !o.lateNotified) { add.late = true; add.lateNotified = true; late = true; }
  if (s.stallMinutes > 0 && !o.stallNotified && o.startedAt && t - o.startedAt > s.stallMinutes * 60000) {
    const l = await F.get(env, `live_locations/${o.id}`);
    // «وقوف» = المواقع بتوصل (آخر موقع من أقل من 5 دقايق) لكن مفيش حركة. لو الإرسال واقف (الصفحة مقفولة) ده مش وقوف فمفيش تنبيه كاذب.
    if (l && t - l.at < 5 * 60000 && t - Math.max(l.moved_at || 0, o.startedAt) > s.stallMinutes * 60000) { add.stallNotified = true; stall = true; }
  }
  const ask = lateKinds(o, t); // ميعاد استلام/تسليم متفق عليه فات + المدة (تتبّع اختياري) → العميل يقرر نقطة أو مسامحة
  if (ask.length) add.lateMarks = { ...(o.lateMarks || {}), ...Object.fromEntries(ask.map((k) => [k, { state: 'asked', at: t }])) };
  if (!late && !stall && !ask.length) return;
  await F.run(env, orderUpdate(env, o, add, L(o.status, 'system', { note: late ? 'late' : stall ? 'stalled' : 'late_ask' })));
  if (late || stall) {
    const type = late ? 'late_delivery' : 'stall_alert', vars = { no: orderNo(o.id) };
    await notify(env, [o.customerId], type, vars, { url: `/#/order/${o.id}` }).catch(() => {});
    await notify(env, await adminIds(env), type, vars, { url: '/#/admin/orders' }).catch(() => {});
  }
  for (const k of ask) await notify(env, [o.customerId], `late_ask_${k}`, { no: orderNo(o.id) }, { url: `/#/order/${o.id}` }).catch(() => {});
}
async function autoRelease(env, o, s) {
  if (o.guard === 'high') return; // حراسة القيمة: الشحنة العالية مفيهاش تحرير تلقائي أبداً (العميل هو اللي يأكّد)
  const { net, stmts } = await releaseStmts(env, o, s, 'system', 'auto_release'); // orderUpdate شرطه الذرّي بيمنع الصرف المزدوج لو العميل أكّد في نفس اللحظة
  await F.run(env, stmts);
  await notify(env, [o.driverId], 'completed', { net, no: orderNo(o.id) }, { url: '/#/driver/wallet' }).catch(() => {});
  await notify(env, [o.customerId], 'auto_released', { no: orderNo(o.id), hours: s.autoReleaseHours }, { url: '/#/customer' }).catch(() => {});
  await rewardReferral({ env }, o.customerId, o.id).catch(() => {}); await rewardReferral({ env }, o.driverId, o.id).catch(() => {});
}
const toAdmins = (c, type, vars, url) => bg(c, (async () => notify(c.env, await adminIds(c.env), type, vars, { url }))());

// مكافأة الإحالة: بتتصرف مرة واحدة عند أول طلب مكتمل للمُحال (عميل أو سواق).
// منفصلة عن عملية تأكيد الطلب (best-effort) عشان ما تعطّلش المال الأساسي، ومحمية بـ guard على حالة الإحالة (مفيش صرف مزدوج).
async function rewardReferral(c, uid, orderId) {
  if (!uid) return;
  const s = await loadSettings(c.env);
  const bR = Math.max(0, Math.floor(Number(s.referralBonusReferrer) || 0));
  const bD = Math.max(0, Math.floor(Number(s.referralBonusReferred) || 0));
  if (!s.referralEnabled || (bR <= 0 && bD <= 0)) return;
  const ref = await F.get(c.env, `referrals/${uid}`);
  if (!ref || ref.status !== 'pending') return;
  const writes = [F.patch(`referrals/${uid}`, { status: 'rewarded', rewarded_at: now(), order_id: orderId, bonus_referrer: bR, bonus_referred: bD }, ref._ut)];
  if (bR > 0 && ref.referrer) { writes.push(walletCredit(ref.referrer, bR), walletTx({ uid: ref.referrer, type: 'referral', amount: bR, orderId })); }
  if (bD > 0) { writes.push(walletCredit(uid, bD), walletTx({ uid, type: 'referral_bonus', amount: bD, orderId })); }
  await F.run(c.env, writes);
}

// =====================================================================
const ROUTES = {
  // ---------- عام ----------
  // أرخص طلب ممكن (قراءة واحدة، من غير فحص المستخدم): عدّادات "إيه اللي اتغيّر" — الواجهة بتجيب القوائم الكبيرة بس لما عدّاد يتغيّر.
  async sync({ env, waitUntil }) {
    bg({ waitUntil }, sweepExpired(env)); // إنهاء الطلبات المدفوعة مقدماً اللي ماحدش قبلها بيحصل مع التحديث
    const r = await F.get(env, STAMP_PATH);
    return { stamp: Object.fromEntries(STAMP_KINDS.map((k) => [k, r?.[k] || 0])) };
  },
  async settings({ env }) { return { settings: { ...(await loadSettings(env)), testPaymentsAllowed: env.ALLOW_TEST_PAYMENTS === '1', deliveryCodeAvailable: !!env.DELIVERY_CODE_SECRET } }; }, // الدفع التجريبي لازم يتفعّل كمان من متغيّر Cloudflare (fail-closed)
  async me({ env, uid }) {
    const r = await F.get(env, `users/${uid}`);
    const profile = userOut(r) || null;
    if (profile) {
      const s = await loadSettings(env);
      profile.edit = editLock(r, s); // حالة تعديل بيانات الحساب (المدة + الميعاد الجاي) — المستخدم لازم يكون عارف
      if (profile.role === 'driver') profile.trust = { ...trustOf(r, s), commissionPct: effectiveCommissionPct(s, s.commissionPct, r) };
    }
    return { profile };
  },

  // ---------- حساب المستخدم: تعديل الاسم/المنطقة/لغة الإشعارات والعناوين المحفوظة ----------
  // ملاحظة: الموبايل والرقم القومي والدور والحالة محمية — بتتغير من الأدمن/التحقق فقط.
  // التعديل محدود بمدة (افتراضي 15 يوم) والأدمن بيتحكم فيها؛ وبيتخطّى للمستخدم اللي الأدمن فتح قفله.
  async 'account/update'(c) {
    await need(c, ['customer', 'driver', 'admin']);
    const r = await F.get(c.env, `users/${c.uid}`), s = await loadSettings(c.env);
    if (editLock(r, s).locked) throw new HttpError(429, 'profile_edit_locked');
    const patch = {};
    if (c.body.name !== undefined) patch.name = str(c.body.name, 2, 80);
    if (c.body.area !== undefined) patch.area = str(c.body.area, 0, 60);
    if (c.body.lang !== undefined) patch.lang = c.body.lang === 'en' ? 'en' : 'ar';
    if (c.body.addresses !== undefined) patch.addresses = JSON.stringify(parseAddresses(c.body.addresses));
    if (!Object.keys(patch).length) throw new HttpError(400, 'nothing_to_update');
    patch.profile_edited_at = now(); // بداية مدة القفل الجديدة
    try { await F.run(c.env, [F.patch(`users/${c.uid}`, patch, r._ut)]); }
    catch (e) { if (e.code === 'conflict') throw new HttpError(409, 'conflict'); throw e; }
    const row = { ...r, ...patch }, profile = userOut(row);
    if (profile.role === 'driver') profile.trust = { ...trustOf(row, s), commissionPct: effectiveCommissionPct(s, s.commissionPct, row) };
    return { ok: true, profile, edit: editLock(row, s) };
  },

  // ---------- التسجيل: فحص القائمة السوداء + منع التكرار (مستندات uniq بـ create = مضمونة ضد السباق) ----------
  async register({ env, uid, token, body, request }) {
    if (await F.get(env, `users/${uid}`)) throw new HttpError(409, 'already_registered');
    // حدّ تسجيل لكل IP (hash مش الـIP نفسه): 30/ساعة — عالي عشان شبكات الموبايل المشتركة (CGNAT) ما تمنعش ناس حقيقيين، ومنخفض كفاية لمنع إنشاء حسابات بالجملة
    if (env.API_RATE_DISABLED !== '1') await rateTake(env, 'reg', (await sha256hex('ip:' + (request?.headers?.get('CF-Connecting-IP') || 'local'))).slice(0, 24), 3600e3, 30, 'too_many_requests');
    const role = body.role;
    if (!['customer', 'driver'].includes(role)) throw new HttpError(400, 'bad_role');
    const phone = phoneOf(body.phone);
    const nid = role === 'driver' ? String(body.nationalId ?? '').replace(/\D/g, '') : ''; // الرقم القومي للسواق/الشركة بس — العميل مش بيكتبه
    if (role === 'driver' && !/^[23]\d{13}$/.test(nid)) throw new HttpError(400, 'bad_national_id');
    const name = str(body.name, 2, 80), area = str(body.area ?? '', 0, 60), lang = body.lang === 'en' ? 'en' : 'ar';
    const driver = role === 'driver', refs = driver ? { id: fileRef(body.idRef) } : {}; // صورة البطاقة للسواق/الشركة بس
    const company = driver && body.accountType === 'company'; // شركة شحن: بتتعامل كسواق، لكن بمستندات الشركة، وسواقينها بيتسجّلوا لاحقاً
    let vehicleType = null, companyName = null, fleetSize = null;
    if (driver) {
      vehicleType = str(body.vehicleType, 2, 40);
      if (company) {
        companyName = str(body.companyName, 2, 80);
        // شركة الشحن: بطاقة المسؤول (فوق) + سيلفي معاها + استمارة وصورة لمركبة واحدة على الأقل + عدد المركبات. السجل التجاري والبطاقة الضريبية ما بقوش مطلوبين (مستند رسمي اختياري بس)
        refs.selfie = fileRef(body.selfieRef); refs.vehicleReg = fileRef(body.vehicleRegRef); refs.vehiclePhoto = fileRef(body.vehiclePhotoRef);
        fleetSize = Math.floor(Number(body.fleetSize)); if (!(fleetSize >= 1 && fleetSize <= 500)) throw new HttpError(400, 'bad_input');
        if (body.commercialRegRef) refs.company = fileRef(body.commercialRegRef);
        if (body.taxCardRef) refs.tax = fileRef(body.taxCardRef);
        if (body.licenseRef) refs.license = fileRef(body.licenseRef);
      } else { refs.license = fileRef(body.licenseRef); refs.vehicleReg = fileRef(body.vehicleRegRef); refs.vehiclePhoto = fileRef(body.vehiclePhotoRef); }
    }
    await ownFiles(env, uid, Object.values(refs));
    const ids = [`phone_${phone}`, ...(nid ? [`nid_${nid}`] : [])];
    if ((await F.getMany(env, 'blacklist', ids)).some(Boolean)) throw new HttpError(403, 'blacklisted');
    if ((await F.getMany(env, 'uniq', ids)).some(Boolean)) throw new HttpError(409, 'duplicate');
    const s = await loadSettings(env);
    const status = role === 'customer' && s.autoApproveCustomers ? 'active' : 'pending';
    // كود الإحالة: مشتق من uid (8 حروف) — يتشاركه المستخدم مع غيره.
    const refCode = String(uid).replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase();
    // كود إحالة جاي من المُحال (اختياري): نتحقق منه ونربطه.
    let referrer = null;
    const wanted = String(body.referral ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    if (wanted) {
      const hit = (await F.query(env, 'users', { eq: { referral_code: wanted }, limit: 1 }))[0];
      if (hit && hit.uid !== uid) referrer = hit;
    }
    const writes = [
      F.create(`users/${uid}`, {
        uid, role, status, status_reason: null, name, phone, email: token.email ?? null, national_id: nid || null, area, lang, id_ref: refs.id ?? null, license_ref: refs.license ?? null,
        vehicle_reg_ref: refs.vehicleReg ?? null, vehicle_photo_ref: refs.vehiclePhoto ?? null, vehicle_type: vehicleType, phone_verified: !!token.phone_number,
        account_type: company ? 'company' : 'individual', company_name: companyName, fleet_size: fleetSize, selfie_ref: refs.selfie ?? null, commercial_reg_ref: refs.company ?? null, tax_card_ref: refs.tax ?? null,
        rating_sum: 0, rating_count: 0, completed_orders: 0, cancel_count: 0, reviewed_by: null, reviewed_at: null, created_at: now(),
        referral_code: refCode, referred_by: referrer ? referrer.uid : null,
      }),
      F.create(`uniq/phone_${phone}`, { uid }), ...(nid ? [F.create(`uniq/nid_${nid}`, { uid })] : []),
    ];
    if (referrer) writes.push(F.create(`referrals/${uid}`, {
      id: uid, uid, role, referrer: referrer.uid, referrer_role: referrer.role, status: 'pending',
      created_at: now(), rewarded_at: null, order_id: null, bonus_referrer: 0, bonus_referred: 0,
    }));
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
    let out;
    if (c.body.service === 'passengers') {
      if (!s.passengersEnabled) throw new HttpError(403, 'service_disabled');
      out = { distanceKm: d.km, source: d.source, ...calcPassengerPrice(s, Math.max(d.km, 0.5), c.body.vehicleClass) };
    } else {
      const qv = s.vehicleGuideOn !== false && c.body.vehiclePick && s.vehicleGuide?.[String(c.body.vehiclePick)]?.size === c.body.size ? String(c.body.vehiclePick) : null; // العربية المختارة (لو متطابقة مع الحجم) بتحدد التسعير
      out = { distanceKm: d.km, source: d.source, ...calcPrice(s, Math.max(d.km, 0.5), c.body.category, c.body.size, qv) };
    }
    const code = normCode(c.body.coupon); // الكوبون اختياري: بنرجّع الخصم أو سبب رفضه (من غير ما نمنع عرض السعر)
    if (code && s.dcEnabled) out = { ...out, couponError: 'coupon_unavailable' }; // الدفع المباشر: مفيش كوبونات (الخصم كان هيتحمله السواق)
    else if (code) {
      try {
        const { discount } = await applyCoupon(c.env, code, out.price, c.uid);
        out = { ...out, couponCode: code, discount, amountDue: out.price - discount };
      } catch (e) { out = { ...out, couponError: e.code || 'coupon_invalid' }; }
    }
    return out;
  },

  // ---------- الملفات ----------
  async 'files/upload'(c) {
    const profile = userOut(await F.get(c.env, `users/${c.uid}`));
    return { ref: await saveFile(c.env, c.uid, profile, c.body.kind, c.body.data) };
  },

  // ---------- سواقين شركة الشحن: كل سواق بيانات كاملة (بطاقة/رخصة/لوحة) — والشركة بتحدد مين استلم كل شحنة ----------
  async 'fleet/list'(c) {
    const u = await needCompany(c);
    const rows = (await F.query(c.env, 'fleet_drivers', { eq: { company_uid: u.uid }, limit: 100 })).filter((r) => r.active !== false);
    return { drivers: rows.sort((a, b) => b.created_at - a.created_at).map(fleetOut) };
  },
  async 'fleet/add'(c) {
    const u = await needCompany(c), b = c.body;
    const name = str(b.name, 2, 80), phone = phoneOf(b.phone), plate = str(b.plate, 3, 20), vehicleType = str(b.vehicleType, 2, 40);
    const nid = String(b.nationalId ?? '').replace(/\D/g, '');
    if (!/^[23]\d{13}$/.test(nid)) throw new HttpError(400, 'bad_national_id');
    const idRef = fileRef(b.idRef), licenseRef = fileRef(b.licenseRef), vehiclePhotoRef = b.vehiclePhotoRef ? fileRef(b.vehiclePhotoRef) : null;
    await ownFiles(c.env, u.uid, [idRef, licenseRef, vehiclePhotoRef]);
    const active = (await F.query(c.env, 'fleet_drivers', { eq: { company_uid: u.uid }, limit: 100 })).filter((r) => r.active !== false);
    if (active.length >= 50) throw new HttpError(409, 'fleet_full');
    if (active.some((r) => r.national_id === nid)) throw new HttpError(409, 'duplicate');
    const id = newId();
    await F.run(c.env, [F.create(`fleet_drivers/${id}`, { id, company_uid: u.uid, name, phone, national_id: nid, plate, vehicle_type: vehicleType, id_ref: idRef, license_ref: licenseRef, vehicle_photo_ref: vehiclePhotoRef, active: true, created_at: now() })]);
    return { ok: true, id };
  },
  async 'fleet/remove'(c) { // إيقاف (مش مسح): السجل بيفضل عشان الشحنات القديمة تفضل مربوطة بسواقها
    const u = await needCompany(c);
    const r = await F.get(c.env, `fleet_drivers/${docId(c.body.id)}`);
    if (!r || r.company_uid !== u.uid) throw new HttpError(404, 'not_found');
    await F.run(c.env, [F.patch(`fleet_drivers/${r.id}`, { active: false, removed_at: now() })]);
    return { ok: true };
  },
  // الشركة بتحدد السواق التابع ليها اللي هيستلم الشحنة (قبل الاستلام بس). الحالة بتتسجّل في الطلب كدليل.
  async 'orders/handler'(c) {
    const u = await needCompany(c);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.driverId !== u.uid) throw new HttpError(403, 'forbidden');
    if (!['accepted', 'payment_review', 'paid', 'heading_pickup'].includes(o.status)) throw new HttpError(409, 'bad_state');
    const f = await F.get(c.env, `fleet_drivers/${docId(c.body.fleetDriverId)}`);
    if (!f || f.company_uid !== u.uid || f.active === false) throw new HttpError(404, 'not_found');
    const busyN = (await activeJobsOf(c.env, u.uid)).filter((r) => r.id !== o.id && JSON.parse(r.data || '{}').handler?.fleetDriverId === f.id).length;
    if (busyN >= (await loadSettings(c.env)).maxActiveJobs) throw new HttpError(409, 'fleet_driver_busy'); // سواق الأسطول معاه شحنة شغّالة
    const handler = { fleetDriverId: f.id, name: f.name, phone: f.phone, nationalId: f.national_id, plate: f.plate, vehicleType: f.vehicle_type, idRef: f.id_ref, licenseRef: f.license_ref, vehiclePhotoRef: f.vehicle_photo_ref || null, companyName: u.companyName, assignedAt: now() };
    await F.run(c.env, orderUpdate(c.env, o, { handler, handlerHistory: [...(o.handlerHistory || []), { fleetDriverId: f.id, name: f.name, nationalId: f.national_id, plate: f.plate, at: now() }] }));
    bg(c, notify(c.env, [o.customerId], 'handler_assigned', { name: f.name, plate: f.plate, no: orderNo(o.id) }, { url: `/#/order/${o.id}` }));
    return { ok: true };
  },
  async 'admin/fleet'(c) { // الأدمن يشوف سواقين أي شركة (حتى الموقوفين) ببياناتهم ومستنداتهم
    await need(c, ['admin']);
    const rows = await F.query(c.env, 'fleet_drivers', { eq: { company_uid: uidOf(c.body.uid) }, limit: 100 });
    return { drivers: rows.sort((a, b) => b.created_at - a.created_at).map(fleetOut) };
  },

  // ---------- الطلبات: قراءة ----------
  async 'orders/list'(c) {
    const u = await viewer(c);
    bg(c, sweepExpired(c.env)); // إنهاء الطلبات المدفوعة مقدماً اللي ماحدش قبلها (واسترجاعها)
    let rows;
    const mine = u.role === 'customer' || (u.role === 'admin' && c.body.scope === 'mine'); // الأدمن كعميل: طلباته هو بس
    if (mine) rows = (await F.query(c.env, 'orders', { eq: { customer_id: c.uid }, limit: 100 })).sort(byDesc('created_at'));
    else if (u.role === 'driver') {
      rows = c.body.scope === 'mine'
        ? (await F.query(c.env, 'orders', { eq: { driver_id: c.uid }, limit: 100 })).sort(byDesc('updated_at'))
        : (await F.query(c.env, 'orders', { eq: { status: 'open' }, limit: 100 })).sort(byDesc('created_at'));
    } else {
      const status = c.body.status ? String(c.body.status) : null, lim = String(c.body.q ?? '').trim() ? 300 : int(c.body.limit ?? 200, 1, 300); // مع البحث بنفحص آخر 300 طلب
      rows = status ? (await F.query(c.env, 'orders', { eq: { status }, limit: lim })).sort(byDesc('created_at'))
        : await F.query(c.env, 'orders', { order: ['created_at', 'desc'], limit: lim });
    }
    let objs = rows.map(hydrateOrder), extra = {};
    if (u.role === 'driver' && c.body.scope !== 'mine') { // السواق بيشوف الطلبات اللي في نطاقه بس (دايرة نصف قطرها من الإعدادات حوالين موقعه)
      const s = await loadSettings(c.env);
      if (s.jobsRadiusKm > 0) {
        const me = await driverLoc(c);
        extra = { radiusKm: s.jobsRadiusKm };
        if (!me) { objs = []; extra.needLocation = true; }
        else objs = objs.map((o) => ({ o, d: haversineM(me, o.pickup) })).filter((x) => x.d <= s.jobsRadiusKm * 1000).map((x) => Object.assign(x.o, { fromMeKm: Math.round(x.d / 100) / 10 }));
      }
    }
    const out = objs.map((o) => orderOut(o, u, { brief: true }));
    const q = u.role === 'admin' && !mine ? String(c.body.q ?? '').trim().replace(/^#/, '').slice(0, 40).toLowerCase() : ''; // بحث الأدمن: رقم الطلب / اسم أو موبايل العميل أو السواق
    if (q) { const has = (v) => String(v ?? '').toLowerCase().includes(q); return { orders: out.filter((o) => has(o.id.slice(0, 6)) || has(o.customerName) || has(o.customerPhone) || has(o.driverName) || has(o.driverPhone)) }; }
    if (mine) { // عدد العروض المعلّقة على كل طلب مفتوح
      const open = out.filter((o) => o.status === 'open').map((o) => o.id);
      if (open.length) {
        const m = {};
        for (const f of await F.query(c.env, 'offers', { inn: { order_id: open } })) if (f.status === 'pending') m[f.order_id] = (m[f.order_id] || 0) + 1;
        out.forEach((o) => { o.offerCount = m[o.id] || 0; });
      }
    }
    return { orders: out, ...extra };
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
    const out = orderOut(o, u), ts = await loadSettings(c.env); // ts: إعدادات شروط الثقة
    if (o.status === 'open') {
      if (u.role === 'customer' || u.role === 'admin') { // العميل يشوف العروض (بدون رقم السواق لحد ما يقبل)
        const offs = (await F.query(c.env, 'offers', { eq: { order_id: o.id }, limit: 60 })).filter((f) => f.status === 'pending').sort((a, b) => a.price - b.price).slice(0, 30);
        const ds = await F.getMany(c.env, 'users', offs.map((f) => f.driver_id));
        out.offers = offs.map((f, i) => ({ f, d: ds[i] })).filter((x) => x.d).map(({ f, d }) => ({
          id: f.id, price: f.price, note: f.note, createdAt: f.created_at, driverName: d.name, vehicleType: d.vehicle_type, ratingSum: d.rating_sum, ratingCount: d.rating_count,
          completedOrders: d.completed_orders, trust: trustOf(d, ts), vehiclePhotoRef: d.vehicle_photo_ref || null, // صورة العربية بتتشاف قبل القبول (نوع «vehiclePhoto» مشترك أصلاً، مفيش بيانات خاصة)
        }));
      } else if (u.role === 'driver') {
        const f = await F.get(c.env, `offers/${offerKey(o.id, c.uid)}`);
        out.myOffer = f ? { id: f.id, price: f.price, note: f.note, status: f.status } : null;
      }
    }
    if (o.driverId && (u.role === 'customer' || u.role === 'admin')) { // العميل يشوف مستوى وشارات سواق طلبه
      const d = await F.get(c.env, `users/${o.driverId}`);
      if (d) out.driverTrust = trustOf(d, ts);
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
    const prev = await F.get(c.env, `live_locations/${o.id}`), t = now();
    const moved = !prev || haversineM(p, { lat: prev.lat, lng: prev.lng }) > 100;
    const trailDue = (!prev?.trail_at || t - prev.trail_at >= 60000) && (prev?.trail_n || 0) < 600; // نقطة مسار كل دقيقة (دليل في النزاعات)
    await F.run(c.env, [
      F.patch(`live_locations/${o.id}`, { order_id: o.id, lat: p.lat, lng: p.lng, acc: int(c.body.acc ?? 0, 0, 100000), at: t, ...(moved ? { moved_at: t } : {}), ...(trailDue ? { trail_at: t, trail_n: (prev?.trail_n || 0) + 1 } : {}) }),
      ...(trailDue ? [F.create(`order_trail/${o.id}_${t}`, { order_id: o.id, lat: p.lat, lng: p.lng, at: t })] : []),
    ]);
    return { ok: true };
  },

  // ---------- إنشاء طلب ----------
  async 'orders/create'(c) {
    const u = await need(c, ['customer']);
    const s = await loadSettings(c.env), b = c.body;
    if (u.role === 'customer' && !u.phone) throw new HttpError(400, 'phone_required'); // رقم التواصل إجباري (السواق محتاج يوصل للعميل)
    const mine = await F.query(c.env, 'orders', { eq: { customer_id: c.uid }, limit: 100 });
    const mineOpen = mine.filter((r) => ['open', 'accepted', 'payment_review', 'awaiting_payment'].includes(r.status)).length;
    if (mineOpen >= 10) throw new HttpError(429, 'too_many_open');
    const trip = b.service === 'passengers'; // نقل ركاب (مقفول افتراضياً) أو شحن بضاعة/توصيل
    if (trip && !s.passengersEnabled) throw new HttpError(403, 'service_disabled');
    const pickup = point(b.pickup), dropoff = point(b.dropoff);
    const photos = fileRefs(b.photos ?? [], 5, trip ? 0 : 1);
    await ownFiles(c.env, c.uid, photos);
    // طلبين مع بعض من نفس النقطة: حد أقصى للطلبات الشغّالة (قبل الاستلام) من نفس العميل جوه النطاق — عشان سواقين ما يروحوش لنفس المكان على الفاضي
    if (s.samePickupMax > 0 && s.samePickupMeters > 0) {
      const near = mine.filter((r) => ['open', 'accepted', 'awaiting_payment', 'paid', 'heading_pickup'].includes(r.status)).map(hydrateOrder).filter((x) => x.pickup && haversineM(x.pickup, pickup) <= s.samePickupMeters).length;
      if (near >= s.samePickupMax) throw new HttpError(409, 'same_pickup_limit');
    }
    let fineDue = 0; // غرامات على العميل بتتحصّل مع سعر الطلب (السواق بيشوفها قبل ما يقبل)
    if (fineOn(s)) {
      fineDue = await curFine(c.env, c.uid);
      if (s.fineBlockLimit > 0 && fineDue >= s.fineBlockLimit) throw new HttpError(403, 'fine_blocked');
      if (fineDue > 0 && mine.some((r) => ['open', 'accepted', 'awaiting_payment', 'paid', 'heading_pickup', 'picked_up', 'in_transit'].includes(r.status))) throw new HttpError(409, 'fine_one_order'); // الغرامة بتتحصّل مع طلب واحد بس
    }
    const d = await distanceKm(pickup, dropoff, s), km = Math.max(d.km, 0.5);
    let price, spec;
    if (trip) {
      const cls = s.passengerClasses[b.vehicleClass];
      if (!cls) throw new HttpError(400, 'bad_category');
      ({ price } = calcPassengerPrice(s, km, b.vehicleClass));
      if (b.codAmount !== undefined && b.codAmount !== null && b.codAmount !== '') throw new HttpError(400, 'bad_cod');
      spec = { service: 'passengers', vehicleClass: b.vehicleClass, passengers: int(b.passengers, 1, cls.seats, 'bad_passengers') };
    } else {
      // العربية المختارة (اختياري): لازم تكون مفعّلة وحجمها هو نفس الحجم المبعوت. وهي اللي بتحدد التسعير الخاص بيها (لو الأدمن حدد لها سعر)
      const vp = s.vehicleGuideOn !== false && b.vehiclePick ? String(b.vehiclePick) : null;
      if (vp && !(s.vehicleGuide?.[vp]?.maxKg > 0 && s.vehicleGuide[vp].size === b.size)) throw new HttpError(400, 'bad_vehicle');
      ({ price } = calcPrice(s, km, b.category, b.size, vp));
      spec = { service: 'cargo', category: b.category, size: b.size, weightKg: int(b.weightKg, 1, 50000), itemsCount: int(b.itemsCount ?? 1, 1, 10000), declaredValue: int(b.declaredValue ?? 0, 0, 100000000),
        vehiclePick: vp, companion: s.companionAsk !== false && typeof b.companion === 'boolean' ? b.companion : null,
        cod: codOf(b.codAmount, s) }; // الدفع عند الاستلام: المستلم بيدفع المبلغ ده للسواق (null = مفيش) // companion: العميل هيرافق الشحنة؟ (null = ما اتسألش)
    }
    const when = new Date(b.scheduledAt);
    if (isNaN(when) || when.getTime() < Date.now() - 3600e3) throw new HttpError(400, 'bad_date');
    const guard = trip ? null : guardOf(s, spec.declaredValue); // حراسة القيمة (لو الأدمن فعّلها)
    if (guard && !c.env.DELIVERY_CODE_SECRET) throw new HttpError(409, 'guard_needs_code'); // مش هنقبل شحنة عالية من غير القدرة على فرض الكود
    // تتبّع التأخير (اختياري): ميعاد تسليم + مدة تأخير مسموح بالدقايق. من غير المدة مفيش تتبّع للطلب.
    const graceMin = b.graceMin === undefined || b.graceMin === null || b.graceMin === '' ? null : int(b.graceMin, 0, 10080, 'bad_grace');
    let deliveryAt = null;
    if (b.deliveryAt) { const dt = new Date(b.deliveryAt).getTime(); if (!Number.isFinite(dt) || dt <= when.getTime() || dt > when.getTime() + 30 * 86400e3) throw new HttpError(400, 'bad_delivery_time'); deliveryAt = dt; }
    const code = normCode(b.coupon); // كود خصم اختياري: السيرفر هو اللي بيحسب الخصم (مش العميل)
    if (code && s.dcEnabled) throw new HttpError(400, 'coupon_unavailable');
    const cp = code ? await applyCoupon(c.env, code, price, c.uid) : null;
    const discount = cp ? cp.discount : 0;
    const amountDue = price - discount;
    const id = newId(), t = now();
    const direct = s.dcEnabled === true; // الدفع المباشر: العميل بيدفع للسواق، مفيش دفع على المنصة
    const prepay = !direct && (trip || b.prepay === true), first = prepay ? 'awaiting_payment' : 'open'; // الركاب دايماً دفع مقدم؛ البضاعة باختيار العميل (إلا في الدفع المباشر)
    const data = {
      customerName: u.name, customerPhone: u.phone, ...spec,
      description: trip ? str(b.description ?? '', 0, 500) : str(b.description ?? '', 10, 1000), photos, pickup, dropoff, distanceKm: d.km, distanceSource: d.source,
      graceMin, deliveryAt, guard, priceOriginal: price, couponCode: code || null, discount, amountDue, instant: prepay ? true : b.instant !== false, payMode: direct ? 'direct' : prepay ? 'before' : 'after', direct, ...(direct && fineDue > 0 ? { fineDue } : {}), commissionPct: s.commissionPct, log: [{ ...L(first, c.uid), at: t }],
    };
    await F.run(c.env, [
      F.create(`orders/${id}`, { id, customer_id: c.uid, driver_id: null, status: first, escrow_status: 'none', price, commission: null, driver_net: null, customer_refund: null, scheduled_at: when.getTime(), created_at: t, updated_at: t, version: 1, data: JSON.stringify(data) }),
      F.inc(`daily/${dayKey(t)}`, { n: 1 }, { day: dayKey(t) }), // عدّاد يومي للإحصائيات (من غير ما نقرا كل الطلبات)
      ...(code ? [ // استهلاك الكوبون (إجمالي + لكل مستخدم) في نفس الـ commit بتاع الطلب
        // شروط ذرّية: لو اتغيّر عدّاد الكوبون/استخدام المستخدم من وقت ما قرينا (طلب متوازي) الـ commit بيفشل بدل ما الحد يتخطّى
        F.inc(`coupons/${code}`, { used_count: 1 }, { updated_at: t }, cp.coupon.max_uses > 0 ? cp.coupon._ut : undefined),
        { ...F.inc(`coupons/${code}/uses/${c.uid}`, { n: 1 }, { uid: c.uid, code, updated_at: t }), ...(cp.coupon.per_user > 0 && cp.discount > 0 ? { pre: cp.use ? { updateTime: cp.use._ut } : { exists: false } } : {}) },
      ] : []),
    ]);
    if (!prepay) bg(c, dispatchNewOrder(c.env, { id, ...spec, pickup, dropoff, price }, s)); // المدفوع مقدماً بيتبعت للسواقين بعد تأكيد الدفع
    return { id, price, prepay, discount, amountDue };
  },

  // ---------- السواق يقبل (أول واحد يكسب: شرط النسخة بيفشّل التاني) ----------
  async 'orders/accept'(c) {
    const u = await need(c, ['driver']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.status !== 'open') throw new HttpError(409, 'order_not_open');
    if (o.instant === false) throw new HttpError(409, 'offers_only'); // العميل اختار يستقبل عروض أسعار بدل القبول الفوري
    if (o.service === 'passengers' && !canServe(u.vehicleType, o)) throw new HttpError(403, 'vehicle_mismatch'); // ركاب: لازم عربية ركاب مناسبة (أمان)
    if (o.service !== 'passengers' && c.body.agree !== true) throw new HttpError(400, 'must_agree'); // السواق لازم يوافق صراحةً على وصف الشحنة وصورها
    await codGate(c.env, c.uid, await loadSettings(c.env), o); // سواق متأخر في سداد الدفع عند الاستلام = متوقف
    await dcGate(c.env, c.uid, await loadSettings(c.env)); // وصل لحد المكسب غير المسدَّد = متوقف لحد ما يسدّد عمولة المنصة
    await radiusGate(c, await loadSettings(c.env), o); // الطلب لازم يكون في نطاق السواق
    const slot = await driverSlot(c.env, c.uid, await loadSettings(c.env), o.id);
    const direct = o.direct === true, prepaid = o.escrowStatus === 'held'; // مدفوع مقدماً أو دفع مباشر: السواق يبدأ فوراً (الحالة paid)
    const fineNow = direct && fineOn(await loadSettings(c.env)) ? await curFine(c.env, o.customerId) : null; // غرامة العميل وقت القبول (اللقطة اللي هتتحصّل)
    const pend = (await F.query(c.env, 'offers', { eq: { order_id: o.id }, limit: 100 })).filter((f) => f.status === 'pending');
    await F.run(c.env, [
      ...orderUpdate(c.env, o, { status: prepaid || direct ? 'paid' : 'accepted', ...(fineNow !== null ? { fineDue: fineNow } : {}), driverId: c.uid, driverName: u.name, driverPhone: u.phone, driverVehicle: u.vehicleType, driverVehiclePhoto: u.vehiclePhotoRef || null, acceptedAt: now(), ...(o.service !== 'passengers' ? { driverAgreedAt: now(), manifestHash: await manifestHash(o) } : {}) }, L(prepaid || direct ? 'paid' : 'accepted', c.uid, prepaid ? { note: 'accepted_prepaid' } : direct ? { note: 'accepted_direct' } : {})),
      ...(slot ? [slot] : []),
      ...pend.map((f) => F.patch(`offers/${f._id}`, { status: f.driver_id === c.uid ? 'withdrawn' : 'rejected', updated_at: now() })),
    ]);
    bg(c, notify(c.env, [o.customerId], direct ? 'accepted_direct' : prepaid ? 'accepted_prepaid' : 'accepted', { driver: u.name, no: orderNo(o.id) }, { url: `/#/order/${o.id}` }));
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
    await codGate(c.env, c.uid, s, o);
    await dcGate(c.env, c.uid, s);
    await radiusGate(c, s, o);
    const lo = Math.max(Math.ceil(s.minPrice), Math.ceil((o.price * s.offerMinPct) / 100)), hi = Math.ceil((o.price * s.offerMaxPct) / 100);
    if (o.service !== 'passengers' && c.body.agree !== true) throw new HttpError(400, 'must_agree');
    const price = int(c.body.price, lo, hi, 'offer_out_of_range');
    const note = str(c.body.note ?? '', 0, 200);
    const key = offerKey(o.id, c.uid), mine = await F.get(c.env, `offers/${key}`), t = now();
    await F.run(c.env, [
      F.guard({ _ut: o._ut }, `orders/${o.id}`), // لو الطلب اتغيّر (اتقبل/اتلغى) في نفس اللحظة العملية تفشل
      mine && mine.status === 'pending' ? F.patch(`offers/${key}`, { price, note, updated_at: t, agreed_at: t, manifest_hash: await manifestHash(o) }, mine._ut)
        : F.set(`offers/${key}`, { id: key, order_id: o.id, driver_id: c.uid, price, note, status: 'pending', created_at: t, updated_at: t, agreed_at: t, manifest_hash: await manifestHash(o) }),
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
    if (s0Block(await loadSettings(c.env), d)) throw new HttpError(409, 'driver_unavailable'); // السواق اتوقف (عمولة غير مسدّدة) بعد ما بعت عرضه: العميل يختار عرض غيره
    const slot = await driverSlot(c.env, d.uid, await loadSettings(c.env), o.id); // السواق مشغول بطلب تاني؟ العميل يختار عرض غيره
    const others = (await F.query(c.env, 'offers', { eq: { order_id: o.id }, limit: 100 })).filter((r) => r.status === 'pending' && r._id !== f._id);
    const amountDue = Math.max(0, f.price - Math.min(o.discount || 0, f.price)); // لو فيه كوبون: الخصم يفضل مطبّق على السعر المتفق عليه
    await F.run(c.env, [
      F.patch(`offers/${f._id}`, { status: 'accepted', updated_at: now() }, f._ut), // شرط: العرض لسه معلّق
      ...orderUpdate(c.env, o, { status: o.direct === true ? 'paid' : 'accepted', ...(o.direct === true && fineOn(await loadSettings(c.env)) ? { fineDue: await curFine(c.env, o.customerId) } : {}), driverId: d.uid, driverName: d.name, driverPhone: d.phone, driverVehicle: d.vehicle_type, driverVehiclePhoto: d.vehicle_photo_ref || null, acceptedAt: now(), price: f.price, amountDue, priceNegotiated: true, driverAgreedAt: f.agreed_at || null, manifestHash: f.manifest_hash || null }, L(o.direct === true ? 'paid' : 'accepted', c.uid, { note: 'offer', price: f.price })),
      ...others.map((r) => F.patch(`offers/${r._id}`, { status: 'rejected', updated_at: now() })),
      ...(slot ? [slot] : []),
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

  // ---------- صندوق الإشعارات (الجرس): آخر الإشعارات للمستخدم + تعليمها مقروءة ----------
  async 'inbox/list'(c) {
    const rows = (await F.query(c.env, 'inbox', { eq: { uid: c.uid }, limit: 100 })).sort(byDesc('at'));
    const old = rows.slice(60); if (old.length) await F.run(c.env, old.map((r) => F.del(`inbox/${r._id}`))); // نحتفظ بآخر 60 بس
    const lang = (await F.get(c.env, `users/${c.uid}`))?.lang === 'en' ? 'en' : 'ar';
    const items = rows.slice(0, 40).map((r) => { let v = {}; try { v = JSON.parse(r.vars || '{}'); } catch { /* تالف */ } const m = renderMsg(r.type, lang, v); return m && { id: r._id, type: r.type, title: m.title, body: m.body, url: r.url || '/', at: r.at, read: r.read === true }; }).filter(Boolean);
    return { items, unread: rows.filter((r) => r.read !== true).length };
  },
  async 'inbox/read'(c) {
    const id = c.body.id ? str(c.body.id, 10, 64) : null;
    const rows = (await F.query(c.env, 'inbox', { eq: { uid: c.uid }, limit: 100 })).filter((r) => r.read !== true && (!id || r._id === id));
    if (rows.length) await F.run(c.env, rows.map((r) => F.patch(`inbox/${r._id}`, { read: true })));
    return { ok: true, marked: rows.length };
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

  // وضع الدفع التجريبي: بيتخطى الدفع الحقيقي بس بيعدّي بنفس مسار الضمان (escrow محجوز → تسليم → العميل يأكد → تحويل للسواق ناقص العمولة).
  // الأدمن يقفله من الإعدادات. بوابة دفع حقيقية بعدين تستخدم نفس نقطة الدخول دي بعد تأكيد الدفع من البوابة.
  async 'orders/pay-test'(c) {
    await need(c, ['customer']);
    const s = await loadSettings(c.env);
    if (!s.testPayments || c.env.ALLOW_TEST_PAYMENTS !== '1') throw new HttpError(403, 'test_payments_off'); // مقفول إلا لو الإعداد شغّال + المتغيّر ALLOW_TEST_PAYMENTS=1 على Cloudflare
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.customerId !== c.uid) throw new HttpError(403, 'forbidden');
    if (o.status !== (o.payMode === 'before' ? 'awaiting_payment' : 'accepted')) throw new HttpError(409, 'bad_state');
    const pre = o.payMode === 'before', status = pre ? 'open' : 'paid', url = `/#/order/${o.id}`;
    await F.run(c.env, orderUpdate(c.env, o, { status, escrowStatus: 'held', paidAt: now(), paymentMethod: 'test', paymentConfirmedBy: 'test_mode' }, L(status, c.uid, { note: 'test_payment' })));
    if (pre) {
      bg(c, notify(c.env, [o.customerId], 'prepaid_open', { no: orderNo(o.id) }, { url }));
      bg(c, dispatchNewOrder(c.env, { id: o.id, service: o.service, size: o.size, vehicleClass: o.vehicleClass, passengers: o.passengers, pickup: o.pickup, dropoff: o.dropoff, price: o.price }, s));
    } else {
      bg(c, notify(c.env, [o.driverId], 'paid_driver', { no: orderNo(o.id) }, { url }));
      bg(c, notify(c.env, [o.customerId], 'paid_customer', { no: orderNo(o.id) }, { url }));
    }
    return { ok: true };
  },

  // ---------- السواق يغيّر حالة التنفيذ (صورة + فحص GPS) ----------
  async 'orders/status'(c) {
    const du = await need(c, ['driver']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.driverId !== c.uid) throw new HttpError(403, 'forbidden');
    const next = NEXT[o.status];
    if (!next || c.body.next !== next) throw new HttpError(409, 'bad_state');
    if (next === 'delivered' && o.cod?.amount > 0 && !o.codCollectedAt) throw new HttpError(409, 'cod_not_collected'); // لازم السواق يأكد إنه استلم مبلغ التحصيل الأول
    if (next === 'picked_up' && du.accountType === 'company' && !o.handler) throw new HttpError(409, 'handler_required'); // الشركة لازم تحدد السواق اللي هيستلم الشحنة
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
      if (next === 'picked_up') { // عدّاد الرحلة + مهلة التسليم (مدة متوقعة من المسافة + وقت إضافي) — الاتنين بيشوفوهم
        patch.startedAt = now(); patch.deadlineAt = now() + Math.round(((o.distanceKm || 0) / s.avgSpeedKmh) * 60 + s.deliveryBufferMin) * 60000;
      }
      if (s.geofenceMeters > 0) {
        if (!loc) throw new HttpError(400, 'location_required');
        if (haversineM(loc, target) > s.geofenceMeters) throw new HttpError(403, 'too_far');
        if (next === 'delivered') patch.deliveryVerified = 'geo'; // اتسلّم جوه نطاق العميل (شرط للتحرير التلقائي)
      }
      if (next === 'picked_up' && o.service !== 'passengers' && s.startCode === true && c.env.DELIVERY_CODE_SECRET) { // كود بداية الرحلة: العميل بيدّيه للسواق وقت التحميل
        if (c.body.noCode === true) { patch.startVerified = 'none'; patch.noStartCodeReason = str(c.body.noCodeReason ?? '', 0, 120); }
        else {
          const given = String(c.body.code ?? '').replace(/\D/g, '');
          await rateTake(c.env, 'scode', o.id, 30 * 86400e3, 6, 'too_many_attempts');
          if (!safeEq(given, await deliveryCodeOf(c.env, o.id, 'sc'))) throw new HttpError(403, 'bad_start_code');
          patch.startVerified = 'code';
        }
      }
      if (next === 'delivered' && o.service !== 'passengers' && codeNeeded(c.env, s, o)) { // كود التسليم: دليل إن المستلم الحقيقي استلم
        if (c.body.noCode === true) { patch.deliveredWithoutCode = true; patch.noCodeReason = str(c.body.noCodeReason ?? '', 0, 120); } // بديل لو العميل مش متاح: بيتعلّم ومش بيتحرر تلقائي
        else {
          const given = String(c.body.code ?? '').replace(/\D/g, '');
          await rateTake(c.env, 'dcode', o.id, 30 * 86400e3, 6, 'too_many_attempts'); // حد محاولات ذرّي على الطلب نفسه
          if (!safeEq(given, await deliveryCodeOf(c.env, o.id))) throw new HttpError(403, 'bad_delivery_code');
          patch.deliveredWithCode = true; patch.deliveryVerified = 'code';
        }
      }
    }
    const lateNow = lateKinds({ ...o, ...patch }, now()); // السواق وصل/سلّم بعد الميعاد + المدة → العميل يتسأل (يسجّل نقطة أو يسامح)
    if (lateNow.length) patch.lateMarks = { ...(o.lateMarks || {}), ...Object.fromEntries(lateNow.map((k) => [k, { state: 'asked', at: now() }])) };
    const direct = o.direct === true && next === 'delivered'; // الدفع المباشر: تأكيد السواق للتسليم = إكمال الطلب وتسجيل مكسبه في دفتر العمولة
    await F.run(c.env, direct ? await directDoneStmts(c.env, o, s, patch, L('completed', c.uid, { note: 'direct_delivered', ...(loc ? { lat: loc.lat, lng: loc.lng } : {}) }))
      : orderUpdate(c.env, o, patch, L(next, c.uid, loc ? { lat: loc.lat, lng: loc.lng } : {})));
    if (direct) await dcNotifyLimit(c.env, o, s);
    // مكافآت الإحالة مش بتتصرف على طلبات الدفع المباشر: مفيش فلوس متحقق منها عند المنصة، فكانت هتبقى ثغرة لزراعة المكافآت بحسابات وهمية
    for (const k of lateNow) bg(c, notify(c.env, [o.customerId], `late_ask_${k}`, { no: orderNo(o.id) }, { url: `/#/order/${o.id}` }));
    const tpl = direct ? 'delivered_direct' : next === 'picked_up' && patch.startVerified ? (patch.startVerified === 'code' ? 'trip_started' : 'trip_started_nocode') : o.service === 'passengers' ? `${next}_p` : next;
    bg(c, notify(c.env, [o.customerId], tpl, { no: orderNo(o.id) }, { url: `/#/order/${o.id}` }));
    return { ok: true, status: direct ? 'completed' : next };
  },

  // ---------- العميل يأكد الاستلام => تحرير الـ Escrow وخصم العمولة وتحويل الباقي لمحفظة السواق ----------
  async 'orders/confirm'(c) {
    await need(c, ['customer']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.customerId !== c.uid) throw new HttpError(403, 'forbidden');
    if (o.direct === true) { // الدفع المباشر: تأكيد العميل بعد الاستلام بيكفي (زي تأكيد السواق للتسليم) — الطلب بيتكمّل ومكسب السواق بيتسجّل
      if (!['picked_up', 'in_transit'].includes(o.status)) throw new HttpError(409, 'bad_state');
      const s2 = await loadSettings(c.env);
      await F.run(c.env, await directDoneStmts(c.env, o, s2, { deliveredAt: now(), deliveryVerified: 'customer' }, L('completed', c.uid, { note: 'direct_customer_confirm' })));
      await dcNotifyLimit(c.env, o, s2);
      bg(c, notify(c.env, [o.driverId], 'direct_confirmed', { no: orderNo(o.id) }, { url: '/#/driver/dashboard' }));
      return { ok: true };
    }
    if (o.status !== 'delivered' || o.escrowStatus !== 'held') throw new HttpError(409, 'bad_state');
    const s = await loadSettings(c.env);
    const { net, commission, stmts } = await releaseStmts(c.env, o, s, c.uid);
    await F.run(c.env, stmts);
    bg(c, notify(c.env, [o.driverId], 'completed', { net, no: orderNo(o.id) }, { url: '/#/driver/wallet' }));
    bg(c, rewardReferral(c, o.customerId, o.id)); // مكافأة إحالة المُحال (مرة واحدة، لو مفعّلة)
    bg(c, rewardReferral(c, o.driverId, o.id));
    return { ok: true, net, commission };
  },

  // ---------- كود التسليم (للعميل فقط) ----------
  async 'orders/code'(c) {
    await need(c, ['customer']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.customerId !== c.uid) throw new HttpError(403, 'forbidden');
    const s = await loadSettings(c.env);
    const res = { active: false };
    if (o.service === 'passengers' || !c.env.DELIVERY_CODE_SECRET) return res;
    if ((s.deliveryCode === true || o.guard === 'high') && ['accepted', 'paid', 'heading_pickup', 'picked_up', 'in_transit'].includes(o.status)) { res.active = true; res.code = await deliveryCodeOf(c.env, o.id); }
    if (s.startCode === true && ['accepted', 'paid', 'heading_pickup'].includes(o.status)) res.startCode = await deliveryCodeOf(c.env, o.id, 'sc');
    return res;
  },

  // ---------- رابط متابعة للمستلم (من غير تسجيل دخول): رمز عشوائي 192-bit متخزّن مشفّر، بيتلغي بنهاية الطلب أو بعد 72 ساعة ----------
  async 'orders/share'(c) {
    await need(c, ['customer']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.customerId !== c.uid) throw new HttpError(403, 'forbidden');
    if (!['accepted', 'paid', 'heading_pickup', 'picked_up', 'in_transit', 'delivered'].includes(o.status)) throw new HttpError(409, 'bad_state');
    await rateTake(c.env, 'share', c.uid, 3600e3, 10, 'too_many_requests');
    const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const expiresAt = now() + 72 * 3600e3;
    await F.run(c.env, [F.create(`shares/${await sha256hex(token)}`, { order_id: o.id, customer_id: c.uid, expires_at: expiresAt, revoked: false, created_at: now() })]);
    return { token, expiresAt };
  },
  async 'orders/unshare'(c) {
    await need(c, ['customer']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.customerId !== c.uid) throw new HttpError(403, 'forbidden');
    const rows = await F.query(c.env, 'shares', { eq: { order_id: o.id }, limit: 50 });
    await F.run(c.env, rows.filter((r) => !r.revoked).map((r) => F.patch(`shares/${r._id}`, { revoked: true })));
    return { ok: true };
  },

  // ---------- السواق راح يستلم ولقى الشحنة مش زي وصف العميل: يرفض يستلمها ويخد تعويض (من الأدمن) والباقي يترد للعميل ----------
  // لو السواق عايز ياخدها عادي بيكمّل الاستلام وما بيستخدمش الزرار ده. الحماية من الإساءة: لازم يكون في موقع الاستلام + سبب مكتوب + حد بلاغات في الشهر + سجل تدقيق.
  async 'orders/mismatch'(c) {
    const du = await need(c, ['driver']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.driverId !== c.uid || o.service === 'passengers') throw new HttpError(403, 'forbidden');
    if (o.escrowStatus !== 'held' || !['paid', 'heading_pickup'].includes(o.status)) throw new HttpError(409, 'bad_state');
    const s = await loadSettings(c.env);
    if (s.geofenceMeters > 0) {
      if (!c.body.loc) throw new HttpError(400, 'location_required');
      if (haversineM(point(c.body.loc, false), o.pickup) > s.geofenceMeters) throw new HttpError(403, 'too_far'); // لازم يكون فعلاً في مكان الاستلام
    }
    const reason = str(c.body.reason, 5, 300); // سبب مكتوب إجباري
    const row = await F.get(c.env, `users/${c.uid}`), t = now();
    const win = t - (row.mm_start || 0) > 30 * 86400e3 ? { start: t, n: 0 } : { start: row.mm_start, n: row.mm_n || 0 };
    if (win.n >= s.mismatchMaxPer30d) throw new HttpError(429, 'mismatch_limit');
    const collected = collectedOf(o), comp = Math.min(s.mismatchCompensation, collected), back = collected - comp;
    const stmts = [
      ...orderUpdate(c.env, o, { status: 'cancelled', escrowStatus: 'settled', cancelledBy: 'driver', cancelReason: 'goods_mismatch', mismatchNote: reason, commission: 0, driverNet: comp, customerRefund: back }, L('cancelled', c.uid, { note: 'goods_mismatch', reason })),
      F.patch(`users/${c.uid}`, { mm_start: win.start, mm_n: win.n + 1 }, row._ut), // بيمنع بلاغين متوازيين يتخطّوا الحد
      auditLog(du, 'order.mismatch', { targetType: 'order', targetId: o.id, note: reason, meta: { compensation: comp, refund: back, claimsInWindow: win.n + 1 } }),
    ];
    if (comp > 0) stmts.push(walletCredit(c.uid, comp), walletTx({ uid: c.uid, type: 'mismatch_compensation', orderId: o.id, amount: comp, gross: collected, commission: 0 }));
    if (back > 0) stmts.push(refundInsert(c.env, o, 'goods_mismatch', back));
    await F.run(c.env, stmts);
    bg(c, notify(c.env, [o.customerId], 'goods_mismatch', { no: orderNo(o.id), amount: comp }, { url: `/#/order/${o.id}` }));
    if (back > 0) afterRefundRequest(c, o, back);
    return { ok: true, compensation: comp, refund: back };
  },

  // ---------- مواعيد الاستلام/التسليم + نقاط التأخير (تتبّع اختياري: العميل هو اللي بيحدد مدة التأخير المسموح) ----------
  // السواق يقترح تعديل المواعيد (العميل بس هو اللي يوافق). اقتراح واحد معلّق، وحد أقصى 5 اقتراحات للطلب.
  async 'orders/propose_times'(c) {
    await need(c, ['driver']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.driverId !== c.uid) throw new HttpError(403, 'forbidden');
    if (o.graceMin == null) throw new HttpError(409, 'no_time_tracking');
    if (!ACTIVE_JOB.includes(o.status)) throw new HttpError(409, 'bad_state');
    if ((o.proposalCount || 0) >= 5) throw new HttpError(429, 'too_many_proposals');
    const t = now(), pickedUp = ['picked_up', 'in_transit'].includes(o.status);
    const when = (v) => { if (v === undefined || v === null || v === '') return null; const d = new Date(v).getTime(); if (!Number.isFinite(d) || d < t - 60000 || d > t + 30 * 86400e3) throw new HttpError(400, 'bad_date'); return d; };
    const pickupAt = when(c.body.pickupAt), deliveryAt = when(c.body.deliveryAt);
    if (pickupAt === null && deliveryAt === null) throw new HttpError(400, 'bad_input');
    if (pickupAt !== null && pickedUp) throw new HttpError(409, 'bad_state'); // الاستلام حصل خلاص
    const effP = pickupAt ?? dueOf(o, 'pickup'), effD = deliveryAt ?? dueOf(o, 'delivery');
    if (effP && effD && effD <= effP) throw new HttpError(400, 'bad_delivery_time');
    const proposal = { ...(pickupAt !== null ? { pickupAt } : {}), ...(deliveryAt !== null ? { deliveryAt } : {}), at: t };
    await F.run(c.env, orderUpdate(c.env, o, { timeProposal: proposal, proposalCount: (o.proposalCount || 0) + 1 }, L(o.status, c.uid, { note: 'time_proposed' })));
    bg(c, notify(c.env, [o.customerId], 'time_proposed', { no: orderNo(o.id) }, { url: `/#/order/${o.id}` }));
    return { ok: true };
  },
  async 'orders/answer_times'(c) {
    await need(c, ['customer']);
    if (typeof c.body.accept !== 'boolean') throw new HttpError(400, 'bad_input');
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.customerId !== c.uid) throw new HttpError(403, 'forbidden');
    const p = o.timeProposal; if (!p) throw new HttpError(409, 'no_proposal');
    const t = now(), patch = { timeProposal: null };
    if (c.body.accept) {
      const pickedUp = ['picked_up', 'in_transit', 'delivered'].includes(o.status);
      if ((p.pickupAt != null && !pickedUp && p.pickupAt < t) || (p.deliveryAt != null && p.deliveryAt < t)) throw new HttpError(409, 'proposal_expired'); // الميعاد المقترح فات — العميل يرفض والسواق يقترح تاني
      const agreed = { ...(o.agreed || {}), at: t }, marks = { ...(o.lateMarks || {}) };
      if (p.pickupAt != null && !pickedUp) { agreed.pickupAt = p.pickupAt; if (marks.pickup?.state === 'asked') delete marks.pickup; } // سؤال معلّق عن ميعاد اتغيّر بيتلغي؛ اللي اتحسم بيفضل
      if (p.deliveryAt != null) { agreed.deliveryAt = p.deliveryAt; if (marks.delivery?.state === 'asked') delete marks.delivery; }
      patch.agreed = agreed; patch.lateMarks = Object.keys(marks).length ? marks : null;
    }
    await F.run(c.env, orderUpdate(c.env, o, patch, L(o.status, c.uid, { note: c.body.accept ? 'times_agreed' : 'times_rejected' })));
    bg(c, notify(c.env, [o.driverId], c.body.accept ? 'time_agreed' : 'time_rejected', { no: orderNo(o.id) }, { url: `/#/order/${o.id}` }));
    return { ok: true };
  },
  // العميل بعد ما السواق يتأخر: يسجّل نقطة تأخير أو يسامح. من غير رد = مسامحة (مفيش نقطة). نقطة واحدة بس لكل ميعاد (create بيمنع التكرار).
  async 'orders/late_decision'(c) {
    await need(c, ['customer']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.customerId !== c.uid || !o.driverId) throw new HttpError(403, 'forbidden');
    const kind = c.body.kind; if (!['pickup', 'delivery'].includes(kind) || typeof c.body.point !== 'boolean') throw new HttpError(400, 'bad_input');
    const m = o.lateMarks?.[kind]; if (m?.state !== 'asked') throw new HttpError(409, 'bad_state');
    const t = now(), s = await loadSettings(c.env), pointIt = c.body.point === true;
    const marks = { ...o.lateMarks, [kind]: { state: pointIt ? 'point' : 'forgiven', at: t, askedAt: m.at } };
    const stmts = [...orderUpdate(c.env, o, { lateMarks: marks }, L(o.status, c.uid, { note: pointIt ? 'late_point' : 'late_forgiven', kind }))];
    let prev = 0;
    if (pointIt) {
      prev = (await F.get(c.env, `users/${o.driverId}`))?.late_points || 0;
      stmts.push(F.create(`late_points/${o.id}_${kind}_${o.driverId}`, { order_id: o.id, driver_id: o.driverId, customer_id: c.uid, kind, due_at: dueOf(o, kind), grace_min: o.graceMin, at: t }), F.inc(`users/${o.driverId}`, { late_points: 1 }));
    }
    await F.run(c.env, stmts);
    if (pointIt) {
      bg(c, notify(c.env, [o.driverId], 'late_point', { no: orderNo(o.id) }, { url: '/#/driver/dashboard' }));
      if (s.latePointsLimit > 0 && prev < s.latePointsLimit && prev + 1 >= s.latePointsLimit) toAdmins(c, 'late_limit', { name: o.driverName || '', n: prev + 1 }, '/#/admin/drivers'); // وصل الحد → يروح للأدمن (حظر أو مسح)
    }
    return { ok: true, state: marks[kind].state };
  },
  // نقاط التأخير: السواق يشوف نقاطه هو، والأدمن يشوف نقاط أي سواق (مع العميل اللي سجّلها)
  async 'late/list'(c) {
    const u = await need(c, ['driver', 'admin']);
    const uid = u.role === 'admin' ? uidOf(c.body.uid) : c.uid;
    const user = await F.get(c.env, `users/${uid}`); if (!user) throw new HttpError(404, 'user_not_found');
    const since = user.late_cleared_at || 0;
    const rows = (await F.query(c.env, 'late_points', { eq: { driver_id: uid }, limit: 100 })).filter((r) => r.at > since).sort((a, b) => b.at - a.at);
    return { points: user.late_points || 0, items: rows.map((r) => ({ orderId: r.order_id, no: orderNo(r.order_id), kind: r.kind, dueAt: r.due_at, graceMin: r.grace_min, at: r.at, ...(u.role === 'admin' ? { customerId: r.customer_id } : {}) })) };
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

    let claim = null, claimInfo = null; // غرامة/تعويض السواق على إلغاء العميل بعد ما السواق تحرّك (الدفع المباشر)
    // (1) العميل بعد قبول سواق على طلب مدفوع: إلغاء برسوم — نسبة تعويض للسواق + نسبة للمنصة + الباقي للعميل (النسب من الأدمن)
    if (asCustomer && held && ['paid', 'heading_pickup'].includes(o.status)) {
      const heading = o.status === 'heading_pickup';
      const dp = heading ? s.cancelHeadingDriverPct : s.cancelPaidDriverPct, pp = heading ? s.cancelHeadingPlatformPct : s.cancelPaidPlatformPct;
      const { driver, platform, refund: back } = cancelSplit(collectedOf(o), dp, pp);
      const stmts = [
        ...orderUpdate(c.env, o, { status: 'cancelled', escrowStatus: 'settled', cancelledBy: 'customer', cancelReason: reason, commission: platform, driverNet: driver, customerRefund: back, cancelFee: { driverPct: dp, platformPct: pp } }, L('cancelled', c.uid, { note: 'cancel_after_accept', reason })),
        cancelCount(),
      ];
      if (driver > 0) stmts.push(walletCredit(o.driverId, driver), walletTx({ uid: o.driverId, type: 'cancel_compensation', orderId: o.id, amount: driver, gross: o.price, commission: platform }));
      if (back > 0) stmts.push(refundInsert(c.env, o, 'cancelled_after_accept', back));
      await F.run(c.env, stmts);
      bg(c, notify(c.env, [o.driverId], driver > 0 ? 'cancel_comp' : 'cancel_plain', { no: orderNo(o.id), amount: driver }, { url: '/#/driver/wallet' }));
      if (back > 0) afterRefundRequest(c, o, back);
      return { ok: true, fee: driver + platform, driver, platform, refund: back };
    }

    let patch, status, counts = false, refund = false;
    if (asCustomer && ['open', 'accepted', 'awaiting_payment'].includes(o.status)) {
      refund = o.status === 'open' && held; // مدفوع مقدماً وماحدش قبله => استرجاع كامل
      patch = { status: 'cancelled', cancelledBy: 'customer', cancelReason: reason, ...(refund ? { escrowStatus: 'refund_pending' } : {}) }; status = 'cancelled'; counts = o.status === 'accepted';
    } else if (asCustomer && o.direct === true && ['paid', 'heading_pickup'].includes(o.status)) { // الدفع المباشر: مفيش فلوس محجوزة، فالإلغاء بدون رسوم (بيتحسب عليه إلغاء)
      patch = { status: 'cancelled', cancelledBy: 'customer', cancelReason: reason }; status = 'cancelled'; counts = true;
      if (fineOn(s)) { // بعد فترة الإلغاء المجاني: السواق في الطريق = غرامة أقل، بعد وصوله = غرامة أكبر (والمبالغ من الأدمن)
        const free = o.acceptedAt && now() - o.acceptedAt <= s.fineFreeCancelMin * 60000;
        const kind = free ? null : o.arrivedAt ? 'cancel_arrived' : o.status === 'heading_pickup' ? 'cancel_enroute' : null;
        const amount = kind === 'cancel_arrived' ? s.fineArrivedAmount : kind === 'cancel_enroute' ? s.fineEnRouteAmount : 0;
        const r = kind ? await claimStmt(c.env, o, kind, amount, s) : {};
        if (r.stmt) { claim = r.stmt; claimInfo = { kind, amount }; }
      }
    } else if (asDriver && ['accepted', 'paid', 'heading_pickup'].includes(o.status)) {
      // السواق اعتذر: الطلب بيرجع مفتوح لسواقين تانيين (ولو مدفوع، المبلغ بيفضل محجوز) وبيتحسب عليه إلغاء
      patch = { status: 'open', driverId: null, driverName: null, driverPhone: null, driverVehicle: null, driverVehiclePhoto: null, acceptedAt: null, agreed: null, timeProposal: null, proposalCount: 0, lateMarks: null, ...(held ? { instant: true } : {}) }; status = 'open'; counts = true;
    } else throw new HttpError(409, 'cannot_cancel'); // بعد الاستلام: يتم فتح نزاع
    const stmts = orderUpdate(c.env, o, patch, L(status, c.uid, asDriver ? { note: 'driver_cancelled', reason } : { reason }));
    if (refund) stmts.push(refundInsert(c.env, o, 'cancelled'));
    if (status === 'cancelled') for (const f of (await F.query(c.env, 'offers', { eq: { order_id: o.id }, limit: 100 })).filter((r) => r.status === 'pending')) stmts.push(F.patch(`offers/${f._id}`, { status: 'rejected', updated_at: now() }));
    if (counts) stmts.push(cancelCount());
    if (claim) stmts.push(claim);
    await F.run(c.env, stmts);
    if (claimInfo) bg(c, notify(c.env, [o.customerId], 'cancel_claim', { no: orderNo(o.id), amount: claimInfo.amount, hours: s.fineClaimHours }, { url: '/#/customer' }));
    if (refund) afterRefundRequest(c, o);
    if (asDriver && (held || o.direct === true)) { // الطلب (مدفوع/دفع مباشر) رجع مفتوح: نبلّغ العميل ونعيد توزيعه على سواقين تانيين
      bg(c, notify(c.env, [o.customerId], o.direct === true ? 'driver_cancelled_direct' : 'driver_cancelled', { no: orderNo(o.id) }, { url: `/#/order/${o.id}` }));
      bg(c, dispatchNewOrder(c.env, { id: o.id, service: o.service, size: o.size, vehicleClass: o.vehicleClass, passengers: o.passengers, pickup: o.pickup, dropoff: o.dropoff, price: o.price }, s));
    }
    return { ok: true, refund, ...(claimInfo ? { fine: claimInfo.amount } : {}) };
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
    // أسئلة سريعة من العميل عن السواق (وصل في الميعاد؟ البضاعة سليمة؟ تعامل كويس؟) — لازم الـ3 مع بعض ومن العميل بس
    let q = null;
    if (asCustomer && c.body.onTime !== undefined) {
      const v = [c.body.onTime, c.body.intact, c.body.polite];
      if (!v.every((x) => typeof x === 'boolean')) throw new HttpError(400, 'bad_input');
      q = { onTime: v[0], intact: v[1], polite: v[2] };
    }
    await F.run(c.env, [
      ...orderUpdate(c.env, o, { [field]: { stars, comment: str(c.body.comment ?? '', 0, 300), at: now(), ...(q || {}) } }),
      F.inc(`users/${asCustomer ? o.driverId : o.customerId}`, { rating_sum: stars, rating_count: 1, ...(q ? { q_n: 1, q_ontime: q.onTime ? 1 : 0, q_intact: q.intact ? 1 : 0, q_polite: q.polite ? 1 : 0 } : {}) }),
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

  // لوحة بيانات السواق: كل حاجة تخصه في قراءة واحدة (قراءة فقط — ما بتغيّر أي رصيد)
  async 'driver/dashboard'(c) {
    await need(c, ['driver']);
    const s = await loadSettings(c.env);
    const [row, w, tx, wd, orders, disputes] = await Promise.all([
      F.get(c.env, `users/${c.uid}`), F.get(c.env, `wallets/${c.uid}`),
      F.query(c.env, `wallets/${c.uid}/tx`, { order: ['at', 'desc'], limit: 300 }),
      F.query(c.env, 'withdrawals', { eq: { uid: c.uid }, limit: 100 }),
      F.query(c.env, 'orders', { eq: { driver_id: c.uid }, limit: 200 }),
      F.query(c.env, 'disputes', { eq: { driver_id: c.uid }, limit: 100 }),
    ]);
    const activeRows = (await activeJobsOf(c.env, c.uid)).map(hydrateOrder);
    const t = now(), DAY = 86400000, EARN = ['earning', 'dispute_earning', 'cancel_compensation', 'mismatch_compensation'];
    const ms = (v) => (!v ? NaN : v.toDate ? v.toDate().getTime() : v instanceof Date ? v.getTime() : new Date(v).getTime());
    const blank = () => ({ trips: 0, gross: 0, commission: 0, net: 0 });
    const earn = { d1: blank(), d7: blank(), d30: blank() };
    for (const r of tx.map(txOut)) {
      if (!EARN.includes(r.type)) continue;
      const at = ms(r.at); if (isNaN(at)) continue;
      for (const [k, span] of [['d1', DAY], ['d7', 7 * DAY], ['d30', 30 * DAY]]) if (t - at <= span) { const p = earn[k]; p.net += r.amount; p.gross += r.gross || 0; p.commission += r.commission || 0; if (r.type === 'earning') p.trips += 1; }
    }
    earn.all = { trips: row.completed_orders || 0, net: w?.total_earned || 0 }; // إجمالي مدى الحياة من المحفظة نفسها
    const os = orders.map(hydrateOrder);
    const rated = os.filter((o) => o.rateByCustomer).sort((a, b) => (b.rateByCustomer.at || 0) - (a.rateByCustomer.at || 0)).slice(0, 8)
      .map((o) => ({ no: orderNo(o.id), stars: o.rateByCustomer.stars, comment: o.rateByCustomer.comment || '', at: o.rateByCustomer.at, onTime: o.rateByCustomer.onTime ?? null, intact: o.rateByCustomer.intact ?? null, polite: o.rateByCustomer.polite ?? null }));
    const pct = (x, n) => (n ? Math.round((x / n) * 100) : null);
    const win = t - (row.mm_start || 0) > 30 * DAY ? 0 : row.mm_n || 0;
    return {
      profile: { name: row.name, phone: row.phone, status: row.status, accountType: row.account_type || 'individual', companyName: row.company_name || null, vehicleType: row.vehicle_type || null, phoneVerified: !!row.phone_verified, createdAt: row.created_at,
        docs: { id: !!row.id_ref, license: !!row.license_ref, vehicleReg: !!row.vehicle_reg_ref, vehiclePhoto: !!row.vehicle_photo_ref }, walletFrozen: !!row.wallet_frozen },
      wallet: { balance: w?.balance || 0, totalEarned: w?.total_earned || 0, pendingWithdrawals: wd.filter((x) => x.status === 'pending').reduce((a, x) => a + (x.amount || 0), 0), paidWithdrawals: wd.filter((x) => x.status === 'paid').reduce((a, x) => a + (x.amount || 0), 0) },
      earnings: earn,
      orders: {
        active: activeRows.slice(0, 10).map((o) => ({ id: o.id, no: orderNo(o.id), status: o.status, price: o.price, pickup: o.pickup?.address || '', dropoff: o.dropoff?.address || '', scheduledAt: o.scheduledAt || null, late: !!o.late })),
        activeCount: activeRows.length, maxActive: s.maxActiveJobs,
        completed: row.completed_orders || 0, cancelledByYou: row.cancel_count || 0, lateCount: os.filter((o) => o.late === true).length, sample: os.length,
        disputesOpen: disputes.filter((d) => d.status === 'open').length, disputesTotal: disputes.length,
      },
      ratings: { avg: row.rating_count ? Math.round((row.rating_sum / row.rating_count) * 10) / 10 : null, count: row.rating_count || 0, recent: rated,
        quick: row.q_n ? { n: row.q_n, onTime: pct(row.q_ontime || 0, row.q_n), intact: pct(row.q_intact || 0, row.q_n), polite: pct(row.q_polite || 0, row.q_n) } : null },
      trust: { ...trustOf(row, s), commissionPct: effectiveCommissionPct(s, s.commissionPct, row) },
      protection: { mismatchUsed: win, mismatchLimit: s.mismatchMaxPer30d },
    };
  },

  // تقرير مالي أسبوعي للسواق (آخر 8 أسابيع، الأسبوع يبدأ الاثنين) — قراءة واحدة على حركات المحفظة
  async 'wallet/weekly'(c) {
    await need(c, ['driver']);
    const rows = await F.query(c.env, `wallets/${c.uid}/tx`, { order: ['at', 'desc'], limit: 300 });
    const EARN = ['earning', 'dispute_earning', 'cancel_compensation', 'mismatch_compensation'];
    const ms = (v) => (!v ? NaN : v.toDate ? v.toDate().getTime() : v instanceof Date ? v.getTime() : new Date(v).getTime());
    const weeks = new Map();
    for (const r of rows.map(txOut)) {
      const d = new Date(ms(r.at)); if (isNaN(d.getTime())) continue;
      const ws = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime(); // بداية الأسبوع (اثنين)
      const w = weeks.get(ws) || { start: ws, earned: 0, withdrawn: 0, refunded: 0, trips: 0, gross: 0, commission: 0 };
      if (EARN.includes(r.type)) { w.earned += r.amount; w.trips += 1; w.gross += r.gross || 0; w.commission += r.commission || 0; }
      else if (r.type === 'withdrawal') w.withdrawn += -r.amount;
      else if (r.type === 'withdrawal_refund') w.refunded += r.amount;
      weeks.set(ws, w);
    }
    const list = [...weeks.values()].sort((a, b) => b.start - a.start).slice(0, 8).map((w) => ({ ...w, net: w.earned - w.withdrawn }));
    return { weeks: list };
  },

  // بيخصم من المحفظة فوراً ويحجز المبلغ لحد قرار الأدمن. شرط النسخة على المحفظة بيمنع السحب المزدوج.
  async 'withdrawals/create'(c) {
    const u = await need(c, ['driver']);
    const s = await loadSettings(c.env);
    const amount = int(c.body.amount, s.minWithdraw, 10000000, 'below_min');
    const method = c.body.method;
    if (!['instapay', 'vodafone', 'bank'].includes(method)) throw new HttpError(400, 'bad_method');
    const account = str(c.body.account, 5, 60), id = newId();
    if ((await F.get(c.env, `users/${c.uid}`))?.wallet_frozen) throw new HttpError(403, 'wallet_frozen'); // فيه بلاغ فقدان مفتوح على السواق
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
    if (o.direct === true) throw new HttpError(409, 'direct_no_dispute'); // الدفع المباشر: مفيش فلوس محجوزة عند المنصة (للبلاغات استخدم «إبلاغ»)
    if (!HELD.includes(o.status)) throw new HttpError(409, 'bad_state'); // الفلوس لسه محجوزة
    if (!['damaged', 'delay', 'not_as_described', 'payment', 'no_show', 'missing', 'other'].includes(c.body.reason)) throw new HttpError(400, 'bad_reason');
    const missing = c.body.reason === 'missing';
    if (missing && (!asCustomer || !['picked_up', 'in_transit', 'delivered'].includes(o.status))) throw new HttpError(409, 'bad_state'); // بلاغ فقدان: العميل بعد ما السواق استلم الشحنة
    const evidence = fileRefs(c.body.evidence ?? [], 5); await ownFiles(c.env, c.uid, evidence);
    const id = newId();
    await F.run(c.env, [
      ...orderUpdate(c.env, o, { status: 'disputed', prevStatus: o.status, disputeId: id }, L('disputed', c.uid)),
      F.create(`disputes/${id}`, {
        id, order_id: o.id, customer_id: o.customerId, driver_id: o.driverId, opened_by: c.uid, opened_by_role: asCustomer ? 'customer' : 'driver', reason: c.body.reason,
        details: str(c.body.details ?? '', 0, 1000), evidence: JSON.stringify(evidence), order_price: o.price, status: 'open', decision: null, customer_pct: null,
        customer_refund: null, driver_net: null, commission: null, note: null, refund_paid: false, created_at: now(), resolved_at: null, resolved_by: null,
      }),
      ...(missing ? [F.patch(`users/${o.driverId}`, { wallet_frozen: true, wallet_frozen_order: o.id })] : []), // تجميد محفظة السواق وسحوباته لحد قرار الأدمن
    ]);
    toAdmins(c, missing ? 'missing_report' : 'dispute', { no: orderNo(o.id) }, '/#/admin/disputes');
    bg(c, notify(c.env, [asCustomer ? o.driverId : o.customerId], 'dispute', { no: orderNo(o.id) }, { url: `/#/order/${o.id}` }));
    return { ok: true, id };
  },

  // =====================  الأدمن  =====================
  // أرقام الشارات: تجميع count (بيتحسب قراءة واحدة لكل 1000 مستند) — بتتسحب كل ~30 ثانية
  async 'admin/badges'(c) {
    await need(c, ['admin']);
    const n = (col, status) => F.count(c.env, col, { eq: { status } });
    const pendingUsers = async () => (await Promise.all(['customer', 'driver'].map((role) => F.count(c.env, 'users', { eq: { status: 'pending', role } })))).reduce((a, b) => a + b, 0); // من غير حساب الأدمن نفسه
    const [payments, users, withdrawals, disputes, refunds, rep, sos] = await Promise.all([
      n('orders', 'payment_review'), pendingUsers(), n('withdrawals', 'pending'), n('disputes', 'open'), n('refunds', 'pending'), n('reports', 'open'), n('sos_events', 'open'),
    ]);
    return { badges: { payments, users, withdrawals, disputes, refunds, reports: rep + sos } };
  },

  // ---------- سجل عمليات الأدمن (أحدث 200 عملية) — للأمان والمساءلة ----------
  async 'admin/audit'(c) {
    await need(c, ['admin']);
    const rows = await F.query(c.env, 'audit', { order: ['at', 'desc'], limit: 200 });
    const jp = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
    return { entries: rows.map((r) => ({ id: r.id, action: r.action, adminUid: r.admin_uid, adminName: r.admin_name, targetType: r.target_type, targetId: r.target_id, note: r.note, meta: jp(r.meta), at: r.at })) };
  },

  // ---------- المراقبة: استهلاك Firestore اليومي (تقديري) + الأخطاء الأخيرة ----------
  async 'admin/metrics'(c) {
    await need(c, ['admin']);
    const rows = await F.query(c.env, 'metrics', { order: ['day', 'desc'], limit: 30 });
    const limit = Number(c.env.METRICS_READ_ALERT) > 0 ? Number(c.env.METRICS_READ_ALERT) : 40000;
    return {
      limit,
      days: rows.filter((r) => r.day).map((r) => ({ day: r.day, reads: Number(r.reads || 0), writes: Number(r.writes || 0), errors: Number(r.errors || 0) })),
    };
  },

  async 'admin/errors'(c) {
    await need(c, ['admin']);
    const rows = await F.query(c.env, 'errors', { order: ['at', 'desc'], limit: 100 });
    return {
      errors: rows.map((r) => ({ id: r.id, source: r.source, route: r.route, uid: r.uid, status: r.status, message: r.message, stack: r.stack, url: r.url, at: r.at })),
    };
  },

  // ---------- سجل الدخول: آخر عمليات دخول الأدمن/المستخدم — للأمان ----------
  async 'auth/login'(c) {
    await need(c, ['customer', 'driver', 'admin']);
    const limit = await rateLimit(c.env, 'login_log', c.uid, 3600e3, 30, 'too_many_requests');
    const ua = String(c.request?.headers?.get('user-agent') || '').slice(0, 300);
    const id = newId();
    await F.run(c.env, [
      limit,
      F.create(`login_log/${id}`, { id, uid: c.uid, at: now(), ua }),
    ]);
    return { ok: true };
  },

  // ---------- سجل الدخول (عرض للأدمن) ----------
  async 'admin/logins'(c) {
    await need(c, ['admin']);
    const rows = await F.query(c.env, 'login_log', { order: ['at', 'desc'], limit: 200 });
    const uids = [...new Set(rows.map((r) => r.uid))];
    const us = await F.getMany(c.env, 'users', uids, ['uid', 'name', 'role', 'email']);
    const byId = Object.fromEntries(us.filter(Boolean).map((u) => [u.uid, u]));
    return { entries: rows.map((r) => ({ id: r.id, uid: r.uid, name: byId[r.uid]?.name || null, role: byId[r.uid]?.role || null, email: byId[r.uid]?.email || null, ua: r.ua || '', at: r.at })) };
  },

  // ---------- التحقق بخطوتين للأدمن (TOTP) ----------
  async 'admin/2fa/status'(c) {
    await need(c, ['admin'], { skip2fa: true });
    const u = await F.get(c.env, `users/${c.uid}`);
    const tk = tfaToken(c.request?.headers?.get('x-2fa'));
    const s = tk ? await F.get(c.env, `admin_2fa/${tk}`) : null;
    return { enabled: !!u?.totp_enabled, verified: !!(s && s.uid === c.uid && Number(s.exp || 0) > now()) };
  },
  async 'admin/2fa/setup'(c) {
    // لو الـ2FA مفعّل بالفعل لازم جلسة 2FA سارية قبل ما يتغيّر السر — وإلا أي حد معاه الباسورد بس يقدر يعطّل الحماية
    const u = await F.get(c.env, `users/${c.uid}`);
    await need(c, ['admin'], { skip2fa: !u?.totp_enabled });
    const secret = randomBase32(32);
    await F.run(c.env, [F.patch(`users/${c.uid}`, { totp_secret: secret, totp_enabled: false, totp_last: 0, totp_setup_at: now(), updated_at: now() }, u?._ut)]);
    return { secret, otpauth: otpauthURL(secret, u?.email || c.uid) };
  },
  async 'admin/2fa/enable'(c) {
    const admin = await need(c, ['admin'], { skip2fa: true });
    const u = await F.get(c.env, `users/${c.uid}`);
    if (!u?.totp_secret) throw new HttpError(400, 'totp_no_setup');
    await totpGate(c);
    const k = await totpUse(u, c.body.code);
    await F.run(c.env, [
      F.patch(`users/${c.uid}`, { totp_enabled: true, totp_enabled_at: now(), totp_last: k, updated_at: now() }, u._ut),
      auditLog(admin, 'admin.2fa.enable', { targetType: 'user', targetId: c.uid }),
    ]);
    return { ok: true, enabled: true };
  },
  async 'admin/2fa/disable'(c) {
    const admin = await need(c, ['admin'], { skip2fa: true });
    const u = await F.get(c.env, `users/${c.uid}`);
    if (!u?.totp_enabled) throw new HttpError(400, 'totp_not_enabled');
    await totpGate(c);
    await totpUse(u, c.body.code);
    await F.run(c.env, [
      F.patch(`users/${c.uid}`, { totp_enabled: false, totp_secret: null, totp_last: 0, totp_disabled_at: now(), updated_at: now() }, u._ut),
      auditLog(admin, 'admin.2fa.disable', { targetType: 'user', targetId: c.uid }),
    ]);
    return { ok: true, enabled: false };
  },
  async 'admin/2fa/verify'(c) {
    await need(c, ['admin'], { skip2fa: true });
    const u = await F.get(c.env, `users/${c.uid}`);
    if (!u?.totp_enabled) throw new HttpError(400, 'totp_not_enabled');
    await totpGate(c);
    const k = await totpUse(u, c.body.code);
    const token = newId() + newId();
    const exp = now() + 12 * 3600e3;
    try { await F.run(c.env, [F.patch(`users/${c.uid}`, { totp_last: k }, u._ut), F.set(`admin_2fa/${token}`, { token, uid: c.uid, exp, at: now() })]); }
    catch (e) { if (e.code === 'conflict') throw new HttpError(409, 'conflict'); throw e; }
    return { token, exp };
  },

  // ---------- نسخة احتياطية: تصدير البيانات (JSON) — للأدمن فقط. يدوي (التلقائي محتاج Blaze) ----------
  async 'admin/export'(c) {
    await need(c, ['admin']);
    const E = c.env;
    const CAPS = { orders: 5000, users: 5000, offers: 5000, wallets: 2000, withdrawals: 5000, refunds: 5000, disputes: 5000, coupons: 2000, referrals: 5000, blacklist: 2000, reports: 2000, sos_events: 2000, audit: 2000, dc_pay: 5000 };
    const only = str(c.body?.col ?? '', 0, 40);
    const cols = only && CAPS[only] ? [only] : Object.keys(CAPS);
    const clean = (r) => { const o = { ...r }; delete o._id; delete o._ut; delete o._v; for (const k of Object.keys(o)) if (/secret/i.test(k)) delete o[k]; return o; }; // ما نصدّرش أسرار (totp_secret...) في النسخة الاحتياطية
    const collections = {};
    for (const col of cols) { const rows = await F.query(E, col, { limit: CAPS[col] }); collections[col] = rows.map(clean); }
    const walletTx = {};
    if (!only || only === 'wallets') {
      for (const w of (collections.wallets || []).slice(0, 300)) {
        const uid = w.uid ?? w.id;
        const rows = await F.query(E, `wallets/${uid}/tx`, { limit: 500 });
        if (rows.length) walletTx[uid] = rows.map((r) => ({ id: r.id, type: r.type, amount: r.amount, orderId: r.order_id, gross: r.gross, commission: r.commission, withdrawalId: r.withdrawal_id, at: r.at }));
      }
    }
    const settingsDoc = (await F.get(E, 'settings/pricing'))?.v ?? null;
    return {
      at: now(), version: 1,
      counts: Object.fromEntries(Object.entries(collections).map(([k, v]) => [k, v.length])),
      collections, walletTx, settings: settingsDoc,
    };
  },

  // ---------- الإحالة والحوافز: قائمة الإحالات + ملخص ----------
  async 'admin/referrals'(c) {
    await need(c, ['admin']);
    const E = c.env, s = await loadSettings(E);
    const [rows, pending, agg] = await Promise.all([
      F.query(E, 'referrals', { order: ['created_at', 'desc'], limit: 200 }),
      F.count(E, 'referrals', { eq: { status: 'pending' } }),
      F.aggregate(E, 'referrals', { eq: { status: 'rewarded' } }, { r: ['sum', 'bonus_referrer'], d: ['sum', 'bonus_referred'] }),
    ]);
    const uids = [...new Set(rows.flatMap((r) => [r.uid, r.referrer]).filter(Boolean))];
    const us = await F.getMany(E, 'users', uids);
    const nameOf = Object.fromEntries(us.filter(Boolean).map((u) => [u.uid, u.name]));
    return {
      config: { enabled: s.referralEnabled, bonusReferrer: s.referralBonusReferrer, bonusReferred: s.referralBonusReferred },
      pending, rewarded: rows.filter((r) => r.status === 'rewarded').length,
      paid: { referrer: Number(agg.r || 0), referred: Number(agg.d || 0) },
      rows: rows.map((r) => ({ id: r.id, uid: r.uid, userName: nameOf[r.uid] || r.uid, referredBy: r.referrer, referrerName: nameOf[r.referrer] || r.referrer, referrerRole: r.referrer_role, role: r.role, status: r.status, createdAt: r.created_at, rewardedAt: r.rewarded_at, orderId: r.order_id, bonusReferrer: r.bonus_referrer, bonusReferred: r.bonus_referred })),
    };
  },

  // بلاغ خطأ من الواجهة (window.onerror / unhandledrejection). محدود المعدّل عشان مايتحوّلش لإغراق.
  async 'client/error'(c) {
    const limit = await rateLimit(c.env, 'client_error', c.uid, 60000, 10, 'too_many_reports');
    await F.run(c.env, [limit]);
    const msg = str(c.body.message ?? '', 1, 500);
    await recordError(c.env, { source: 'client', route: str(c.body.route ?? '', 0, 120), uid: c.uid, status: 500, message: msg, stack: str(c.body.stack ?? '', 0, 2000), url: str(c.body.url ?? '', 0, 300) });
    return { ok: true };
  },

  // إحصائيات على كل الطلبات بتجميع Firestore (count/sum) من غير قراءة المستندات. اليومي من عدّادات daily.
  async 'admin/stats'(c) {
    await need(c, ['admin']);
    const E = c.env, TERMINAL = ['completed', 'cancelled', 'resolved'];
    const days = Array.from({ length: 15 }, (_, i) => dayKey(now() - (14 - i) * 86400e3));
    // التجميعات المالية ممكن تحتاج فهرس مركّب في Firestore: لو فشلت وحدة، باقي اللوحة تفضل شغالة والمبلغ يظهر «—» مع رابط إنشاء الفهرس
    const soft = (p) => p.then((v) => ({ v }), (e) => { console.error('admin/stats aggregate failed', e?.code, e?.detail || e?.message); return { e }; });
    const [total, terminal, rev, held, drivers, customers, top, daily, refunds, nOpen, nDone, nCancel] = await Promise.all([
      F.count(E, 'orders'),
      F.count(E, 'orders', { inn: { status: TERMINAL } }),
      soft(F.aggregate(E, 'orders', { inn: { escrow_status: ['released', 'settled'] } }, { price: ['sum', 'price'], refund: ['sum', 'customer_refund'], commission: ['sum', 'commission'] })),
      soft(F.aggregate(E, 'orders', { eq: { escrow_status: 'held' } }, { price: ['sum', 'price'] })),
      F.count(E, 'users', { eq: { status: 'active', role: 'driver' } }),
      F.count(E, 'users', { eq: { status: 'active', role: 'customer' } }),
      F.query(E, 'users', { order: ['completed_orders', 'desc'], limit: 40 }),
      F.getMany(E, 'daily', days),
      soft(F.aggregate(E, 'refunds', { eq: { status: 'pending' } }, { n: ['sum', 'amount'] })),
      F.count(E, 'orders', { eq: { status: 'open' } }), F.count(E, 'orders', { inn: { status: ['completed', 'resolved'] } }), F.count(E, 'orders', { eq: { status: 'cancelled' } }), // توزيع الحالات للدونات (عدّاد على حقل واحد: من غير فهارس مركّبة)
    ]);
    const warnings = [['revenue', rev], ['escrowHeld', held], ['refundsDue', refunds]].filter(([, x]) => x.e).map(([what, x]) => ({ what, detail: String(x.e.detail || x.e.code || x.e.message || 'error').slice(0, 700) }));
    const tops = top.filter((u) => u.role === 'driver' && u.completed_orders > 0).slice(0, 5);
    const ws = await F.getMany(E, 'wallets', tops.map((u) => u.uid));
    return {
      totals: { total, active: total - terminal, revenue: rev.e ? null : rev.v.price - rev.v.refund, commission: rev.e ? null : rev.v.commission, held: held.e ? null : held.v.price },
      warnings,
      activeDrivers: drivers, activeCustomers: customers,
      byStatus: { open: nOpen, progress: Math.max(0, total - nOpen - nDone - nCancel), completed: nDone, cancelled: nCancel },
      topDrivers: tops.map((u, i) => ({ name: u.name, n: u.completed_orders, earned: ws[i]?.total_earned || 0 })), // "earned" = إجمالي ربح المحفظة
      perDay: daily.map((r, i) => (r && r.n > 0 ? { d: days[i], n: r.n } : null)).filter(Boolean),
      refundsDue: refunds.e ? null : refunds.v.n,
    };
  },

  // تقرير مالي لفترة: كله بتجميع Firestore (sum/count) — بيتحسب بقراءات قليلة جداً من غير ما نقرا الطلبات نفسها.
  // الأرقام حسب تاريخ إنشاء الطلب (مش تاريخ التسوية). الاسترجاع والسحب حسب تاريخ طلبهم.
  async 'admin/finance'(c) {
    await need(c, ['admin']);
    const from = int(c.body.from, 0, 4e12, 'bad_range'), to = int(c.body.to, 1, 4e12, 'bad_range');
    if (to <= from || to - from > 366 * 86400e3) throw new HttpError(400, 'bad_range');
    const rng = { range: [['created_at', '>=', from], ['created_at', '<', to]] };
    const [o, rf, wd] = await Promise.all([
      F.aggregate(c.env, 'orders', rng, { n: ['count'], commission: ['sum', 'commission'], driver: ['sum', 'driver_net'], refund: ['sum', 'customer_refund'] }),
      F.aggregate(c.env, 'refunds', rng, { n: ['count'], amount: ['sum', 'amount'] }),
      F.aggregate(c.env, 'withdrawals', rng, { n: ['count'], amount: ['sum', 'amount'] }),
    ]);
    return { from, to, orders: o.n, commission: o.commission, driverNet: o.driver, customerRefund: o.refund, settledGross: o.commission + o.driver + o.refund, refunds: { n: rf.n, amount: rf.amount }, withdrawals: { n: wd.n, amount: wd.amount } };
  },

  async 'admin/users'(c) {
    await need(c, ['admin']);
    // kind = صفحات الأدمن المنفصلة: customer (عملاء) / driver (سواقين أفراد) / company (شركات شحن). role لسه شغّال زي ما كان.
    const kind = ['customer', 'driver', 'company'].includes(c.body.kind) ? c.body.kind : null;
    const role = kind ? (kind === 'customer' ? 'customer' : 'driver') : (['customer', 'driver'].includes(c.body.role) ? c.body.role : null), status = c.body.status ? String(c.body.status) : null;
    const base = role ? { role } : {};
    // بنجيب المعلّقين الأول (عشان ما يضيعوش وسط القائمة) + الأحدث، وبنفلتر البحث في الذاكرة (Firestore مفيهوش LIKE)
    const lists = status ? [await F.query(c.env, 'users', { eq: { ...base, status }, limit: 300 })]
      : [await F.query(c.env, 'users', { eq: { ...base, status: 'pending' }, limit: 300 }),
        role ? await F.query(c.env, 'users', { eq: base, limit: 300 }) : await F.query(c.env, 'users', { order: ['created_at', 'desc'], limit: 300 })];
    const seen = new Map(); for (const r of lists.flat()) seen.set(r.uid, r);
    const q = String(c.body.q ?? '').trim().slice(0, 40).toLowerCase();
    const has = (v) => String(v ?? '').toLowerCase().includes(q);
    const kindOk = (r) => !kind || kind === 'customer' || (kind === 'company') === (r.account_type === 'company'); // الشركة = سواق بحساب شركة؛ السواق الفرد = أي سواق غير كده
    const rows = [...seen.values()].filter((r) => r.role !== 'admin' && kindOk(r) && (!q || has(r.name) || has(r.phone) || has(r.email) || has(r.company_name)))
      .sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.created_at - a.created_at).slice(0, 300);
    const ts = await loadSettings(c.env);
    return { users: rows.map((r) => { const u = userOut(r); if (r.role === 'driver') u.trust = trustOf(r, ts); return u; }) };
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
    writes.push(auditLog(admin, 'user.status', { targetType: 'user', targetId: target.uid, note: reason, meta: { from: target.status, to: status, blacklist: !!c.body.blacklist } }));
    await F.run(c.env, writes);
    if (status === 'active' && target.status !== 'active') bg(c, notify(c.env, [target.uid], 'account_active', {}, { url: '/' }));
    if (['rejected', 'banned'].includes(status)) bg(c, notify(c.env, [target.uid], 'account_rejected', {}, { url: '/' }));
    return { ok: true };
  },

  // الأدمن يمسح نقاط تأخير السواق (النقاط القديمة بتفضل في السجل بس مابتتحسبش). الحظر بيتم من admin/user زي ما هو.
  async 'admin/late_clear'(c) {
    const admin = await need(c, ['admin']);
    const target = await F.get(c.env, `users/${uidOf(c.body.uid)}`);
    if (!target || target.role !== 'driver') throw new HttpError(404, 'user_not_found');
    await F.run(c.env, [F.patch(`users/${target.uid}`, { late_points: 0, late_cleared_at: now() }, target._ut), auditLog(admin, 'user.late_clear', { targetType: 'user', targetId: target.uid, note: str(c.body.note ?? '', 0, 200), meta: { cleared: target.late_points || 0 } })]);
    return { ok: true };
  },

  // تحكم الأدمن في قفل تعديل بيانات الحساب لمستخدم: فتح فوري أو مدة مخصّصة له (null = يرجعه للمدة العامة)
  async 'admin/profile-edit'(c) {
    const admin = await need(c, ['admin']);
    const target = await F.get(c.env, `users/${uidOf(c.body.uid)}`);
    if (!target) throw new HttpError(404, 'user_not_found');
    if (target.role === 'admin') throw new HttpError(403, 'forbidden');
    const patch = {};
    if (c.body.unlock === true) patch.profile_edited_at = 0;
    if (c.body.days !== undefined) patch.profile_edit_days = c.body.days === null || c.body.days === '' ? null : Math.floor(int(c.body.days, 0, 365));
    if (!Object.keys(patch).length) throw new HttpError(400, 'nothing_to_update');
    await F.run(c.env, [F.patch(`users/${target.uid}`, patch), auditLog(admin, 'user.profile_edit', { targetType: 'user', targetId: target.uid, meta: { unlock: c.body.unlock === true, days: patch.profile_edit_days } })]);
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
    await F.run(c.env, [orderUpdate(c.env, o, patch, L(logStatus, admin.uid, pre && c.body.action === 'confirm' ? { note: 'prepaid_confirmed' } : {})),
      auditLog(admin, c.body.action === 'confirm' ? 'payment.confirm' : 'payment.reject', { targetType: 'order', targetId: o.id, note: String(c.body.note ?? ''), meta: { price: o.price, prepaid: pre } })]);
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
    const amountDue = Math.max(0, price - (o.discount || 0)); // لو فيه كوبون، الخصم يفضل ثابت والمبلغ المطلوب يتحدّث
    await F.run(c.env, [...orderUpdate(c.env, o, { price, amountDue, priceOverridden: true, priceNote: str(c.body.note ?? '', 0, 200) }, L(o.status, admin.uid, { note: 'price_override', price })),
      auditLog(admin, 'order.price', { targetType: 'order', targetId: o.id, note: str(c.body.note ?? '', 0, 200), meta: { from: o.price, to: price, discount: o.discount || 0 } })]);
    return { ok: true };
  },

  // تحرير فلوس محجوزة بقرار أدمن (العميل استلم وما أكدش من غير نزاع). نفس دالة التحرير بتاعة تأكيد العميل (نفس العمولة والمحفظة)، وشرطها الذرّي بيمنع الصرف المزدوج لو العميل أكّد في نفس اللحظة.
  async 'admin/release'(c) {
    const admin = await need(c, ['admin']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.status !== 'delivered' || o.escrowStatus !== 'held' || !o.driverId) throw new HttpError(409, 'bad_state'); // المتنازع عليه بيتحل من أداة النزاعات
    const note = str(c.body.note, 5, 300); // سبب مكتوب إجباري
    const s = await loadSettings(c.env);
    const { net, commission, stmts } = await releaseStmts(c.env, o, s, admin.uid, 'admin_release');
    stmts.push(auditLog(admin, 'order.release', { targetType: 'order', targetId: o.id, note, meta: { price: o.price, net, commission, guard: o.guard || null, deliveredWithoutCode: !!o.deliveredWithoutCode } }));
    await F.run(c.env, stmts);
    bg(c, notify(c.env, [o.driverId], 'completed', { net, no: orderNo(o.id) }, { url: '/#/driver/wallet' }));
    bg(c, notify(c.env, [o.customerId], 'admin_released', { no: orderNo(o.id) }, { url: `/#/order/${o.id}` }));
    bg(c, rewardReferral(c, o.customerId, o.id)); bg(c, rewardReferral(c, o.driverId, o.id));
    return { ok: true, net, commission };
  },

  // ---------- الدفع عند الاستلام (COD) — مخفي ومقفول افتراضياً (إعداد codEnabled) ----------
  // السواق بيأكد إنه استلم مبلغ التحصيل من المستلم (لازم قبل «تم التسليم»). المبلغ بيتسجّل في دفتر منفصل (cod/) مع نسبة العمولة المثبّتة وقتها.
  async 'cod/collect'(c) {
    await need(c, ['driver']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.driverId !== c.uid) throw new HttpError(403, 'forbidden');
    if (!(o.cod?.amount > 0)) throw new HttpError(409, 'bad_state');
    if (o.codCollectedAt) return { ok: true, already: true };
    if (!['picked_up', 'in_transit'].includes(o.status)) throw new HttpError(409, 'bad_state');
    const s = await loadSettings(c.env), t = now(), sp = codSplit(o.cod.amount, s.codCommissionPct);
    await F.run(c.env, [
      F.create(`cod/${o.id}`, { order_id: o.id, driver_id: c.uid, customer_id: o.customerId, amount: sp.amount, pct: s.codCommissionPct, commission: sp.commission, net: sp.net, period: codPeriodOf(t, s.codPeriodDays).key, collected_at: t, payout: 'pending' }),
      ...orderUpdate(c.env, o, { codCollectedAt: t }),
    ]);
    bg(c, notify(c.env, [o.customerId], 'cod_collected', { amount: sp.amount, no: orderNo(o.id) }, { url: `/#/order/${o.id}` }));
    return { ok: true, amount: sp.amount };
  },
  // كشف حساب السواق: كل فترة فيها إجمالي اللي حصّله وحالة السداد، وهل هو متوقف.
  async 'cod/summary'(c) {
    await need(c, ['driver']);
    const s = await loadSettings(c.env), st = await codStatementsOf(c.env, c.uid, s);
    return { enabled: s.codEnabled, blocked: s.codEnabled && codBlocked(st), scope: s.codBlockScope, pct: s.codCommissionPct, periodDays: s.codPeriodDays, graceDays: s.codGraceDays, statements: st.slice(0, 12) };
  },
  // السواق بيبلّغ إنه حوّل إجمالي فترة اتقفلت (مرجع التحويل). مابيفكّش التوقيف لحد ما الأدمن يأكد.
  async 'cod/remit'(c) {
    await need(c, ['driver']);
    const period = String(c.body.period ?? ''), b = codPeriodBounds(period);
    if (!b) throw new HttpError(400, 'bad_input');
    const ref = str(c.body.ref, 3, 100), t = now();
    if (t < b.end) throw new HttpError(409, 'period_open');
    const entries = (await codEntriesOf(c.env, c.uid)).filter((e) => e.period === period);
    if (!entries.length) throw new HttpError(404, 'not_found');
    const cur = (await F.get(c.env, `cod_pay/${c.uid}_${period}`)) || null;
    if (cur?.status === 'paid') throw new HttpError(409, 'bad_state');
    const amount = entries.reduce((x, e) => x + (e.amount || 0), 0), data = { driver_id: c.uid, period, status: 'reported', ref, amount, reported_at: t };
    await F.run(c.env, [cur ? F.set(`cod_pay/${c.uid}_${period}`, data, cur._ut) : F.create(`cod_pay/${c.uid}_${period}`, data)]);
    return { ok: true };
  },
  // الأدمن: كل السواقين اللي حصّلوا مبالغ، كشوفهم، ومين متوقف، + المبالغ اللي لسه ليها تتحول للمرسلين.
  async 'admin/cod/list'(c) {
    await need(c, ['admin']);
    const s = await loadSettings(c.env), t = now();
    const entries = await F.query(c.env, 'cod', { limit: 1000 }), pays = await F.query(c.env, 'cod_pay', { limit: 500 });
    const payMap = (uid) => Object.fromEntries(pays.filter((p) => p.driver_id === uid).map((p) => [p.period, p]));
    const uids = [...new Set(entries.map((e) => e.driver_id))], custIds = [...new Set(entries.map((e) => e.customer_id))];
    const [ds, cs] = await Promise.all([F.getMany(c.env, 'users', uids), F.getMany(c.env, 'users', custIds)]);
    const name = (m, id) => m.find?.((u) => u && (u._id === id || u.uid === id))?.name ?? '';
    const drivers = uids.map((uid) => {
      const mine = entries.filter((e) => e.driver_id === uid), st = codStatements(mine, payMap(uid), s, t);
      return { driverId: uid, name: name(ds, uid), blocked: codBlocked(st), collected: mine.reduce((x, e) => x + (e.amount || 0), 0), statements: st };
    }).sort((a, b) => Number(b.blocked) - Number(a.blocked) || b.collected - a.collected);
    const paidSet = new Set(pays.filter((p) => p.status === 'paid').map((p) => `${p.driver_id}_${p.period}`));
    const payouts = entries.map((e) => ({ orderId: e.order_id, no: orderNo(e.order_id), driverId: e.driver_id, driverName: name(ds, e.driver_id), customerId: e.customer_id, customerName: name(cs, e.customer_id), amount: e.amount, commission: e.commission, net: e.net, period: e.period, collectedAt: e.collected_at, ref: e.payout_ref ?? null, status: e.payout === 'paid' ? 'paid' : paidSet.has(`${e.driver_id}_${e.period}`) ? 'due' : 'waiting' }))
      .sort((a, b) => b.collectedAt - a.collectedAt);
    return { enabled: s.codEnabled, pct: s.codCommissionPct, periodDays: s.codPeriodDays, graceDays: s.codGraceDays, scope: s.codBlockScope, drivers, payouts, truncated: entries.length >= 1000 };
  },
  // الأدمن بيأكد إن السواق سدّد إجمالي فترة (بعد ما شاف التحويل). ده اللي بيفكّ التوقيف.
  async 'admin/cod/confirm'(c) {
    const admin = await need(c, ['admin']);
    const uid = str(c.body.driverId, 4, 128), period = String(c.body.period ?? ''), note = str(c.body.note ?? '', 0, 300);
    if (!codPeriodBounds(period)) throw new HttpError(400, 'bad_input');
    const entries = (await codEntriesOf(c.env, uid)).filter((e) => e.period === period);
    if (!entries.length) throw new HttpError(404, 'not_found');
    const cur = (await F.get(c.env, `cod_pay/${uid}_${period}`)) || null;
    if (cur?.status === 'paid') throw new HttpError(409, 'bad_state');
    const sum = entries.reduce((x, e) => ({ amount: x.amount + (e.amount || 0), commission: x.commission + (e.commission || 0), net: x.net + (e.net || 0) }), { amount: 0, commission: 0, net: 0 });
    const data = { driver_id: uid, period, status: 'paid', ref: cur?.ref ?? null, amount: sum.amount, commission: sum.commission, net: sum.net, count: entries.length, paid_at: now(), paid_by: admin.uid, reported_at: cur?.reported_at ?? null };
    await F.run(c.env, [cur ? F.set(`cod_pay/${uid}_${period}`, data, cur._ut) : F.create(`cod_pay/${uid}_${period}`, data), auditLog(admin, 'cod.confirm', { targetType: 'user', targetId: uid, note, meta: { period, ...sum, count: entries.length } })]);
    bg(c, notify(c.env, [uid], 'cod_paid', { amount: sum.amount }, { url: '/#/driver/dashboard' }));
    return { ok: true, ...sum };
  },
  // الأدمن بيسجّل إنه حوّل صافي المبلغ للمرسل (بعد ما سداد فترة السواق اتأكد). التحويل نفسه بيتم برّه المنصة.
  async 'admin/cod/payout'(c) {
    const admin = await need(c, ['admin']);
    const oid = docId(c.body.orderId), ref = str(c.body.ref, 3, 100);
    const e = await F.get(c.env, `cod/${oid}`); if (!e) throw new HttpError(404, 'not_found');
    if (e.payout === 'paid') throw new HttpError(409, 'bad_state');
    const pay = await F.get(c.env, `cod_pay/${e.driver_id}_${e.period}`);
    if (pay?.status !== 'paid') throw new HttpError(409, 'period_unpaid'); // ما نحوّلش للمرسل قبل ما السواق يسدّد
    await F.run(c.env, [F.patch(`cod/${oid}`, { payout: 'paid', payout_ref: ref, payout_at: now(), payout_by: admin.uid }, e._ut), auditLog(admin, 'cod.payout', { targetType: 'order', targetId: oid, note: ref, meta: { net: e.net, amount: e.amount, commission: e.commission, customerId: e.customer_id } })]);
    bg(c, notify(c.env, [e.customer_id], 'cod_payout', { net: e.net, no: orderNo(oid) }, { url: `/#/order/${oid}` }));
    return { ok: true, net: e.net };
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
    if (c.body.action === 'paid' && (await F.get(c.env, `users/${w.uid}`))?.wallet_frozen) throw new HttpError(409, 'wallet_frozen');
    if (c.body.action === 'paid') await F.run(c.env, [mark('paid'), auditLog(admin, 'withdrawal.paid', { targetType: 'withdrawal', targetId: w.id, note, meta: { uid: w.uid, amount: w.amount } })]);
    else if (c.body.action === 'reject') await F.run(c.env, [mark('rejected'), walletCredit(w.uid, w.amount), walletTx({ uid: w.uid, type: 'withdrawal_refund', amount: w.amount, withdrawalId: w.id }), auditLog(admin, 'withdrawal.reject', { targetType: 'withdrawal', targetId: w.id, note, meta: { uid: w.uid, amount: w.amount } })]);
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
    const collected = collectedOf(o); // المبلغ اللي اتحصّل فعلاً (بعد خصم الكوبون لو موجود)
    const customerRefund = Math.round((collected * pct) / 100);
    const driverGross = collected - customerRefund;
    const pct_ = effectiveCommissionPct(await loadSettings(c.env), o.commissionPct, await F.get(c.env, `users/${o.driverId}`));
    const { commission, net } = driverGross > 0 ? split(driverGross, pct_) : { commission: 0, net: 0 };
    const writes = [
      F.patch(`disputes/${d.id}`, { status: 'resolved', decision: c.body.decision, customer_pct: pct, customer_refund: customerRefund, driver_net: net, commission, note, refund_paid: customerRefund === 0, resolved_by: admin.uid, resolved_at: now() }, d._ut), // شرط: لسه مفتوح
      ...orderUpdate(c.env, o, { status: 'resolved', escrowStatus: 'settled', commission, driverNet: net, customerRefund, resolution: c.body.decision }, L('resolved', admin.uid)),
    ];
    if (net > 0) writes.push(walletCredit(o.driverId, net), walletTx({ uid: o.driverId, type: 'dispute_earning', orderId: o.id, amount: net, gross: driverGross, commission }));
    if (d.reason === 'missing') writes.push(F.patch(`users/${d.driver_id}`, { wallet_frozen: false, wallet_frozen_order: null })); // فكّ التجميد بقرار الأدمن (الإيقاف الدائم للحساب بيتم من إدارة المستخدمين)
    writes.push(auditLog(admin, 'dispute.resolve', { targetType: 'order', targetId: o.id, note, meta: { decision: c.body.decision, customerRefund, driverNet: net } }));
    await F.run(c.env, writes);
    return { ok: true, customerRefund, driverNet: net };
  },

  // ملف أدلة كامل للطلب (للشرطة/المحامي): التفاصيل المتفق عليها وموافقة السواق، هوية الطرفين، السجل، الصور، مسار الـGPS، الأكواد. بصمة نزاهة (hash) في الآخر.
  async 'admin/evidence'(c) {
    const admin = await need(c, ['admin']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    const [cust, drv, disputes, trail, last] = await Promise.all([F.get(c.env, `users/${o.customerId}`), o.driverId ? F.get(c.env, `users/${o.driverId}`) : null,
      F.query(c.env, 'disputes', { eq: { order_id: o.id }, limit: 20 }), F.query(c.env, 'order_trail', { eq: { order_id: o.id }, limit: 600 }), F.get(c.env, `live_locations/${o.id}`)]);
    const bundle = {
      generatedAt: now(), generatedBy: admin.uid, orderId: o.id,
      order: orderOut(o, { uid: admin.uid, role: 'admin' }),
      agreement: { description: o.description, itemsCount: o.itemsCount || 1, declaredValue: o.declaredValue || 0, photos: o.photos || [], driverAgreedAt: o.driverAgreedAt || null, manifestHash: o.manifestHash || null },
      codes: { startVerified: o.startVerified || null, deliveryVerified: o.deliveryVerified || null, deliveredWithoutCode: !!o.deliveredWithoutCode, noCodeReason: o.noCodeReason || o.noStartCodeReason || null },
      customer: cust ? userOut(cust) : null, driver: drv ? userOut(drv) : null, handler: o.handler || null,
      disputes: disputes.map(disputeOut), lastLocation: last ? { lat: last.lat, lng: last.lng, at: last.at } : null,
      trail: trail.sort((a, b) => a.at - b.at).map((p) => ({ lat: p.lat, lng: p.lng, at: p.at })),
    };
    await F.run(c.env, [auditLog(admin, 'evidence.export', { targetType: 'order', targetId: o.id })]);
    return { evidence: bundle, integrity: await sha256hex(JSON.stringify(bundle)) };
  },

  async 'admin/dispute-refund'(c) { // الأدمن يأكد إنه رد المبلغ للعميل يدوياً (InstaPay)
    const admin = await need(c, ['admin']);
    const d = await F.get(c.env, `disputes/${docId(c.body.id)}`);
    if (!d || d.status !== 'resolved') throw new HttpError(409, 'bad_state');
    await F.run(c.env, [F.patch(`disputes/${d.id}`, { refund_paid: true, refund_paid_at: now() }, d._ut), auditLog(admin, 'dispute.refund_paid', { targetType: 'dispute', targetId: d.id, meta: { orderId: d.order_id, amount: d.customer_refund } })]);
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
    await F.run(c.env, [F.patch(`reports/${r.id}`, { status: c.body.action === 'resolve' ? 'resolved' : 'dismissed', admin_note: str(c.body.note ?? '', 0, 500), handled_by: admin.uid, handled_at: now() }, r._ut),
      auditLog(admin, 'report.handle', { targetType: 'order', targetId: r.order_id, note: str(c.body.note ?? '', 0, 200), meta: { action: c.body.action } })]);
    bg(c, notify(c.env, [r.reporter_id], 'report_handled', { no: orderNo(r.order_id) }, { url: `/#/order/${r.order_id}` }));
    return { ok: true };
  },
  async 'admin/sos-handle'(c) {
    const admin = await need(c, ['admin']);
    const e = await F.get(c.env, `sos_events/${docId(c.body.id)}`);
    if (!e || e.status !== 'open') throw new HttpError(409, 'bad_state');
    await F.run(c.env, [F.patch(`sos_events/${e.id}`, { status: 'handled', note: str(c.body.note ?? '', 0, 500), handled_by: admin.uid, handled_at: now() }, e._ut),
      auditLog(admin, 'sos.handle', { targetType: 'order', targetId: e.order_id, note: str(c.body.note ?? '', 0, 200) })]);
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
      auditLog(admin, 'refund.paid', { targetType: 'order', targetId: f.order_id, note: str(c.body.note ?? '', 0, 200), meta: { amount: f.amount, customerId: f.customer_id } }),
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

  // =====================  نظام الدفع المباشر + عمولة المنصة (السواق/الشركة)  =====================
  // العميل بيدفع للسواق مباشرة. كل شحنة ناجحة بتتسجّل في دفتر السواق (dc_gross). لما الإجمالي غير المسدَّد يوصل للحد (من الأدمن) السواق بيتوقف عن قبول طلبات
  // جديدة لحد ما يسدّد نسبة المنصة (محفظة/إنستا باي + صورة التحويل)، والأدمن بيأكّد يدوي لحد ما تتركّب بوابة الدفع.
  async 'dc/summary'(c) {
    await need(c, ['driver']);
    const s = await loadSettings(c.env);
    const [r, pays, entries] = await Promise.all([
      F.get(c.env, `users/${c.uid}`),
      F.query(c.env, 'dc_pay', { eq: { driver_id: c.uid }, limit: 100 }),
      F.query(c.env, `dc_ledger/${c.uid}/entries`, { order: ['at', 'desc'], limit: 15 }),
    ]);
    const gross = r?.dc_gross || 0, list = pays.sort(byDesc('created_at')), pb = dcPayable(gross, s.dcPct, r?.dc_credit, r?.dc_fines_held, r?.dc_kmfee);
    const pending = list.find((x) => x.status === 'pending') || null;
    return {
      enabled: s.dcEnabled, pct: s.dcPct, limit: s.dcLimit, perKm: s.dcPerKm, km: r?.dc_km || 0, kmFee: r?.dc_kmfee || 0, kmTotal: r?.km_total || 0, gross, due: pb.amount, commission: pb.commission, credit: r?.dc_credit || 0, creditUsed: pb.creditUsed, finesHeld: pb.fines, blocked: dcBlocked(gross, s),
      pay: { instapay: s.instapay, wallet: s.dcPay }, pending: pending && dcPayOut(pending),
      history: list.filter((x) => x.status !== 'pending').slice(0, 10).map(dcPayOut),
      entries: entries.map((e) => ({ orderId: e.order_id, gross: e.gross, at: e.at })),
    };
  },
  async 'dc/pay'(c) {
    const u = await need(c, ['driver']);
    const s = await loadSettings(c.env);
    if (!s.dcEnabled) throw new HttpError(403, 'dc_off');
    const r = await F.get(c.env, `users/${c.uid}`), gross = r?.dc_gross || 0, pb = dcPayable(gross, s.dcPct, r?.dc_credit, r?.dc_fines_held, r?.dc_kmfee), amount = pb.amount;
    if (amount <= 0) {
      if (gross <= 0 && !(r?.dc_kmfee > 0) && !(r?.dc_fines_held > 0)) throw new HttpError(409, 'nothing_due');
      // العمولة كلها اتغطّت برصيد التعويض: بتتسوّى فوراً من غير تحويل (والحساب يرجع يقبل طلبات)
      const idc = newId(), tc = now();
      try {
        await F.run(c.env, [
          F.patch(`users/${c.uid}`, { dc_gross: 0, dc_km: 0, dc_kmfee: 0, dc_credit: Math.max(0, (r.dc_credit || 0) - pb.creditUsed), updated_at: tc }, r._ut),
          F.create(`dc_pay/${idc}`, { id: idc, driver_id: c.uid, driver_name: u.companyName || u.name, gross, km: r.dc_km || 0, km_fee: r.dc_kmfee || 0, pct: s.dcPct, amount: 0, commission: pb.commission, credit_used: pb.creditUsed, fines_held: 0, method: 'credit', reference: 'credit', ref_key: null, proof: null, status: 'paid', note: 'covered_by_credit', created_at: tc, decided_at: tc, decided_by: 'system' }),
        ]);
      } catch (e) { throw e.code === 'conflict' ? new HttpError(409, 'dc_conflict') : e; }
      return { ok: true, covered: true, amount: 0 };
    }
    const method = c.body.method;
    if (!['instapay', 'wallet'].includes(method)) throw new HttpError(400, 'bad_method');
    const proof = fileRef(c.body.proofRef); await ownFiles(c.env, c.uid, [proof]);
    const reference = str(c.body.reference, 4, 40);
    await rateTake(c.env, 'dcpay', c.uid, 3600e3, 6, 'too_many_requests');
    if ((await F.query(c.env, 'dc_pay', { eq: { driver_id: c.uid }, limit: 100 })).some((x) => x.status === 'pending')) throw new HttpError(409, 'dc_pending'); // طلب سداد واحد معلّق في المرة
    const id = newId(), refKey = await dcRefKey(method, reference), t = now();
    try {
      await F.run(c.env, [
        F.guard(r, `users/${c.uid}`), // لو طلب خلص في نفس اللحظة والإجمالي اتغيّر: العملية تفشل ويعيد السواق (المبلغ يفضل مطابق للي اتحسب)
        F.create(`dc_ref/${refKey}`, { pay_id: id, uid: c.uid, at: t }), // رقم المرجع مرة واحدة بس
        F.create(`dc_pay/${id}`, { id, driver_id: c.uid, driver_name: u.companyName || u.name, gross, km: r?.dc_km || 0, km_fee: r?.dc_kmfee || 0, pct: s.dcPct, amount, commission: pb.commission, credit_used: pb.creditUsed, fines_held: pb.fines, method, reference, ref_key: refKey, proof, status: 'pending', note: null, created_at: t, decided_at: null, decided_by: null }),
      ]);
    } catch (e) { throw e.code === 'conflict' ? new HttpError(409, 'dc_conflict') : e; }
    toAdmins(c, 'dc_review', { name: u.companyName || u.name, amount }, '/#/admin/dc');
    return { ok: true, id, amount };
  },

  async 'admin/dc/list'(c) {
    await need(c, ['admin']);
    const s = await loadSettings(c.env);
    const [pending, recent, owing] = await Promise.all([
      F.query(c.env, 'dc_pay', { eq: { status: 'pending' }, limit: 100 }),
      F.query(c.env, 'dc_pay', { order: ['created_at', 'desc'], limit: 30 }),
      F.query(c.env, 'users', { range: [['dc_gross', '>', 0]], limit: 300 }),
    ]);
    const drivers = owing.filter((u) => u.role === 'driver').map((u) => ({ id: u.uid, name: u.company_name || u.name, phone: u.phone, gross: u.dc_gross || 0, due: dcPayable(u.dc_gross, s.dcPct, u.dc_credit, u.dc_fines_held, u.dc_kmfee).amount, km: u.dc_km || 0, kmFee: u.dc_kmfee || 0, kmTotal: u.km_total || 0, credit: u.dc_credit || 0, finesHeld: u.dc_fines_held || 0, blocked: dcBlocked(u.dc_gross, s) })).sort((a, b) => b.gross - a.gross);
    return { enabled: s.dcEnabled, pct: s.dcPct, limit: s.dcLimit, drivers, pending: pending.sort((a, b) => a.created_at - b.created_at).map(dcPayOut), recent: recent.filter((x) => x.status !== 'pending').map(dcPayOut) };
  },
  async 'admin/dc/confirm'(c) {
    const admin = await need(c, ['admin']);
    const p = await F.get(c.env, `dc_pay/${docId(c.body.id)}`);
    if (!p) throw new HttpError(404, 'not_found');
    if (p.status !== 'pending') throw new HttpError(409, 'bad_state');
    const note = str(c.body.note ?? '', 0, 200), t = now();
    if (c.body.action === 'confirm') {
      const ur = await F.get(c.env, `users/${p.driver_id}`);
      if (!ur) throw new HttpError(404, 'not_found');
      const left = Math.max(0, (ur.dc_gross || 0) - p.gross); // بنخصم المبلغ اللي اتحسب وقت الطلب بالظبط (أي طلب خلص بعده يفضل محسوب)
      await F.run(c.env, [
        F.patch(`dc_pay/${p.id}`, { status: 'paid', note, decided_at: t, decided_by: admin.uid }, p._ut),
        F.patch(`users/${p.driver_id}`, { dc_gross: left, dc_km: Math.max(0, Math.round(((ur.dc_km || 0) - (p.km || 0)) * 10) / 10), dc_kmfee: Math.max(0, (ur.dc_kmfee || 0) - (p.km_fee || 0)), dc_credit: Math.max(0, (ur.dc_credit || 0) - (p.credit_used || 0)), dc_fines_held: Math.max(0, (ur.dc_fines_held || 0) - (p.fines_held || 0)), dc_paid_total: (ur.dc_paid_total || 0) + p.amount, updated_at: t }, ur._ut),
        auditLog(admin, 'dc.confirm', { targetType: 'user', targetId: p.driver_id, note, meta: { payId: p.id, gross: p.gross, pct: p.pct, amount: p.amount, creditUsed: p.credit_used || 0, finesHeld: p.fines_held || 0, left } }),
      ]);
      bg(c, notify(c.env, [p.driver_id], 'dc_paid', { amount: p.amount }, { url: '/#/driver/dashboard' }));
      return { ok: true, left };
    }
    if (c.body.action === 'reject') {
      if (note.length < 3) throw new HttpError(400, 'bad_input'); // سبب الرفض إجباري
      await F.run(c.env, [
        F.patch(`dc_pay/${p.id}`, { status: 'rejected', note, decided_at: t, decided_by: admin.uid }, p._ut),
        F.del(`dc_ref/${p.ref_key}`), // رقم المرجع يتحرر عشان السواق يبعت التحويل الصحيح
        auditLog(admin, 'dc.reject', { targetType: 'user', targetId: p.driver_id, note, meta: { payId: p.id, amount: p.amount } }),
      ]);
      bg(c, notify(c.env, [p.driver_id], 'dc_rejected', { amount: p.amount }, { url: '/#/driver/dashboard' }));
      return { ok: true };
    }
    throw new HttpError(400, 'bad_action');
  },
  // تصحيح يدوي لإجمالي مكسب السواق غير المسدَّد (خطأ تسجيل/إعفاء): بسبب إجباري وبيتسجّل في سجل التدقيق بالقيمة قبل وبعد
  async 'admin/dc/adjust'(c) {
    const admin = await need(c, ['admin']);
    const uid = uidOf(c.body.uid), gross = int(c.body.gross, 0, 1000000000), note = str(c.body.note, 3, 200);
    const ur = await F.get(c.env, `users/${uid}`);
    if (!ur || ur.role !== 'driver') throw new HttpError(404, 'not_found');
    await F.run(c.env, [
      F.patch(`users/${uid}`, { dc_gross: gross, updated_at: now() }, ur._ut),
      auditLog(admin, 'dc.adjust', { targetType: 'user', targetId: uid, note, meta: { from: ur.dc_gross || 0, to: gross } }),
    ]);
    return { ok: true };
  },

  // =====================  وصول السواق / عدم حضور العميل / تعويض وغرامة (الدفع المباشر)  =====================
  // «وصلت»: بيتسجّل وقت ومكان وصول السواق (لازم يكون جوه نطاق نقطة الاستلام) — ده الإثبات اللي بيتبني عليه أي تعويض.
  async 'orders/arrived'(c) {
    await need(c, ['driver']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.driverId !== c.uid) throw new HttpError(403, 'forbidden');
    const s = await loadSettings(c.env);
    if (!fineOn(s) || o.direct !== true) throw new HttpError(409, 'fines_off');
    if (!['paid', 'heading_pickup'].includes(o.status)) throw new HttpError(409, 'bad_state');
    if (o.arrivedAt) return { ok: true, arrivedAt: o.arrivedAt };
    const loc = point(c.body.loc, false);
    if (s.geofenceMeters > 0 && haversineM(loc, o.pickup) > s.geofenceMeters) throw new HttpError(403, 'too_far');
    const t = now();
    await F.run(c.env, orderUpdate(c.env, o, { arrivedAt: t, arrivedLoc: { lat: loc.lat, lng: loc.lng } }, L(o.status, c.uid, { note: 'arrived', lat: loc.lat, lng: loc.lng })));
    bg(c, notify(c.env, [o.customerId], 'driver_arrived', { no: orderNo(o.id) }, { url: `/#/order/${o.id}` }));
    return { ok: true, arrivedAt: t };
  },
  // «العميل مش موجود»: بعد وصول مثبّت + مهلة انتظار (من الأدمن). الطلب بيتلغي بسبب العميل وبتتفتح مطالبة تعويض (تسوية مباشرة أو تعويض المنصة + غرامة)
  async 'orders/noshow'(c) {
    await need(c, ['driver']);
    const o = await loadOrder(c.env, docId(c.body.orderId));
    if (o.driverId !== c.uid) throw new HttpError(403, 'forbidden');
    const s = await loadSettings(c.env);
    if (!fineOn(s) || o.direct !== true) throw new HttpError(409, 'fines_off');
    if (!['paid', 'heading_pickup'].includes(o.status)) throw new HttpError(409, 'bad_state');
    if (!o.arrivedAt) throw new HttpError(409, 'not_arrived');
    if (o.arrivedAt + s.fineWaitMin * 60000 > now()) throw new HttpError(409, 'wait_more');
    const cu = await F.get(c.env, `users/${o.customerId}`);
    const r = await claimStmt(c.env, o, 'no_show', s.fineArrivedAmount, s);
    if (r.limited) throw new HttpError(429, 'claims_limit');
    const stmts = [
      ...orderUpdate(c.env, o, { status: 'cancelled', cancelledBy: 'customer', cancelReason: 'no_show', noShow: true }, L('cancelled', c.uid, { note: 'no_show' })),
      F.inc(`users/${o.customerId}`, { cancel_count: 1 }, (cu?.cancel_count || 0) + 1 >= s.maxCancellations ? { status: 'suspended', status_reason: 'auto_cancellations' } : {}),
    ];
    if (r.stmt) stmts.push(r.stmt);
    await F.run(c.env, stmts);
    if (r.stmt) bg(c, notify(c.env, [o.customerId], 'noshow_claim', { no: orderNo(o.id), amount: s.fineArrivedAmount, hours: s.fineClaimHours }, { url: '/#/customer' }));
    return { ok: true, amount: r.stmt ? s.fineArrivedAmount : 0, credit: r.stmt ? fineCredit(s.fineArrivedAmount, s.fineDriverSharePct) : 0 };
  },

  async 'fines/mine'(c) {
    const u = await need(c, ['customer', 'driver']);
    const s = await loadSettings(c.env);
    const [rows, me] = await Promise.all([F.query(c.env, 'fines', { eq: { [u.role === 'driver' ? 'driver_id' : 'customer_id']: c.uid }, limit: 100 }), F.get(c.env, `users/${c.uid}`)]);
    rows.sort(byDesc('created_at'));
    return { enabled: fineOn(s), role: u.role, due: me?.fine_due || 0, credit: me?.dc_credit || 0, held: me?.dc_fines_held || 0, objectHours: s.fineObjectHours, sharePct: s.fineDriverSharePct, claims: rows.slice(0, 30).map(claimOut) };
  },
  // السواق: «اتحصّل» — العميل عوّضه مباشرة (كاش/تحويل) فالمطالبة بتتقفل من غير إعفاء ولا غرامة
  async 'fines/collected'(c) {
    await need(c, ['driver']);
    const cl = await F.get(c.env, `fines/${docId(c.body.orderId)}`);
    if (!cl) throw new HttpError(404, 'not_found');
    if (cl.driver_id !== c.uid) throw new HttpError(403, 'forbidden');
    if (!['open', 'customer_paid'].includes(cl.status)) throw new HttpError(409, 'bad_state');
    await F.run(c.env, [F.patch(`fines/${cl.id}`, { status: 'settled', note: 'collected', decided_at: now(), decided_by: c.uid }, cl._ut)]);
    return { ok: true };
  },
  // العميل: «عوّضت السواق» — بتستنى تأكيد السواق (من غير تأكيده المطالبة بتتطبّق لما المهلة تخلص)
  async 'fines/declare'(c) {
    await need(c, ['customer']);
    const cl = await F.get(c.env, `fines/${docId(c.body.orderId)}`);
    if (!cl) throw new HttpError(404, 'not_found');
    if (cl.customer_id !== c.uid) throw new HttpError(403, 'forbidden');
    if (cl.status !== 'open') throw new HttpError(409, 'bad_state');
    await F.run(c.env, [F.patch(`fines/${cl.id}`, { status: 'customer_paid', declared_at: now() }, cl._ut)]);
    bg(c, notify(c.env, [cl.driver_id], 'fine_declared', { no: orderNo(cl.order_id) }, { url: '/#/driver/dashboard' }));
    return { ok: true };
  },
  // السواق: «ماتحصّلش» — تطبيق التعويض والغرامة دلوقتي من غير ما يستنى المهلة
  async 'fines/apply'(c) {
    await need(c, ['driver']);
    const cl = await F.get(c.env, `fines/${docId(c.body.orderId)}`);
    if (!cl) throw new HttpError(404, 'not_found');
    if (cl.driver_id !== c.uid) throw new HttpError(403, 'forbidden');
    if (!['open', 'customer_paid'].includes(cl.status)) throw new HttpError(409, 'bad_state');
    return { ok: true, ...(await applyClaim(c.env, cl, await loadSettings(c.env), 'driver')) };
  },
  async 'fines/object'(c) {
    const u = await need(c, ['customer']);
    const cl = await F.get(c.env, `fines/${docId(c.body.orderId)}`);
    if (!cl) throw new HttpError(404, 'not_found');
    if (cl.customer_id !== c.uid) throw new HttpError(403, 'forbidden');
    const s = await loadSettings(c.env), note = str(c.body.note, 3, 300);
    if (cl.status !== 'applied') throw new HttpError(409, 'bad_state');
    if (cl.objected === true) throw new HttpError(409, 'already_objected');
    if (!(s.fineObjectHours > 0) || now() - (cl.applied_at || 0) > s.fineObjectHours * 3600000) throw new HttpError(409, 'objection_closed');
    await F.run(c.env, [F.patch(`fines/${cl.id}`, { objected: true, object_note: note, objected_at: now() }, cl._ut)]);
    toAdmins(c, 'fine_objection', { name: u.name, amount: cl.remaining || cl.amount }, '/#/admin/fines');
    return { ok: true };
  },

  async 'admin/fines/list'(c) {
    await need(c, ['admin']);
    const [objected, recent, owing] = await Promise.all([
      F.query(c.env, 'fines', { eq: { objected: true }, limit: 100 }),
      F.query(c.env, 'fines', { order: ['created_at', 'desc'], limit: 60 }),
      F.query(c.env, 'users', { range: [['fine_due', '>', 0]], limit: 200 }),
    ]);
    return { objected: objected.filter((x) => x.status === 'applied').map(claimOut), recent: recent.map(claimOut), customers: owing.filter((u) => u.role === 'customer').map((u) => ({ id: u.uid, name: u.name, phone: u.phone, due: u.fine_due || 0 })).sort((a, b) => b.due - a.due) };
  },
  // قرار الأدمن في مطالبة: waive = إعفاء العميل (المنصة بتتحمّل وتعويض السواق بيفضل)، reject = ادعاء غير صحيح (بيتشال الغرامة والتعويض وإنذار للسواق)، settle = العميل سدّد للمنصة مباشرة
  async 'admin/fines/decide'(c) {
    const admin = await need(c, ['admin']);
    const cl = await F.get(c.env, `fines/${docId(c.body.id)}`);
    if (!cl) throw new HttpError(404, 'not_found');
    const action = c.body.action, note = str(c.body.note ?? '', action === 'reject' ? 3 : 0, 300), t = now();
    if (!['waive', 'reject', 'settle'].includes(action)) throw new HttpError(400, 'bad_action');
    const applied = cl.status === 'applied';
    if (action === 'reject' ? !['open', 'customer_paid', 'applied'].includes(cl.status) : !applied) throw new HttpError(409, 'bad_state');
    const rem = applied ? cl.remaining || 0 : 0, credit = applied && action === 'reject' ? cl.credit || 0 : 0;
    const stmts = [F.patch(`fines/${cl.id}`, { status: action === 'waive' ? 'waived' : action === 'reject' ? 'rejected' : 'paid_platform', remaining: 0, ...(action === 'reject' ? { credit: 0 } : {}), note, decided_at: t, decided_by: admin.uid }, cl._ut)];
    if (rem > 0) { const cu = await F.get(c.env, `users/${cl.customer_id}`); if (cu) stmts.push(F.patch(`users/${cl.customer_id}`, { fine_due: Math.max(0, (cu.fine_due || 0) - rem) }, cu._ut)); }
    if (action === 'reject') {
      const dr = await F.get(c.env, `users/${cl.driver_id}`);
      if (cl.credit_mode === 'wallet' && credit > 0) { // التعويض اتصرف لمحفظة السواق: بنسحب اللي لسه موجود منه (لو كان اتسحب مابنخلّيش الرصيد سالب)
        const w = await F.get(c.env, `wallets/${cl.driver_id}`), back = Math.min(credit, Math.max(0, Math.floor(w?.balance || 0)));
        if (back > 0) stmts.push(walletCredit(cl.driver_id, -back));
        if (dr) stmts.push(F.patch(`users/${cl.driver_id}`, { false_claims: (dr.false_claims || 0) + 1 }, dr._ut));
      } else if (dr) stmts.push(F.patch(`users/${cl.driver_id}`, { dc_credit: Math.max(0, (dr.dc_credit || 0) - credit), false_claims: (dr.false_claims || 0) + 1 }, dr._ut));
    }
    stmts.push(auditLog(admin, `fine.${action}`, { targetType: 'order', targetId: cl.order_id, note, meta: { claim: cl.id, remaining: rem, credit, customer: cl.customer_id, driver: cl.driver_id } }));
    await F.run(c.env, stmts);
    if (rem > 0) bg(c, notify(c.env, [cl.customer_id], 'fine_cleared', { amount: rem }, { url: '/#/customer' }));
    return { ok: true };
  },
  // تصحيح يدوي لغرامات عميل (بسبب إجباري + سجل تدقيق)
  async 'admin/fines/adjust'(c) {
    const admin = await need(c, ['admin']);
    const uid = uidOf(c.body.uid), due = int(c.body.due, 0, 1000000), note = str(c.body.note, 3, 200);
    const cu = await F.get(c.env, `users/${uid}`);
    if (!cu || cu.role !== 'customer') throw new HttpError(404, 'not_found');
    await F.run(c.env, [F.patch(`users/${uid}`, { fine_due: due }, cu._ut), auditLog(admin, 'fine.adjust', { targetType: 'user', targetId: uid, note, meta: { from: cu.fine_due || 0, to: due } })]);
    return { ok: true };
  },

  async 'admin/settings/save'(c) {
    const admin = await need(c, ['admin']);
    const clean = sanitizeSettings(c.body);
    await F.run(c.env, [F.set('settings/pricing', { k: 'pricing', v: JSON.stringify(clean) }), auditLog(admin, 'settings.save', { meta: { perKm: clean.perKm, commissionPct: clean.commissionPct, offersEnabled: clean.offersEnabled, profileEditEnabled: clean.profileEditEnabled, profileEditCooldownDays: clean.profileEditCooldownDays } })]);
    clearSettingsCache();
    return { settings: await loadSettings(c.env) };
  },

  async 'admin/blacklist'(c) {
    await need(c, ['admin']);
    return { items: (await F.query(c.env, 'blacklist', { order: ['at', 'desc'], limit: 500 })).map((r) => ({ id: r.k, type: r.type, value: r.value, reason: r.reason, at: r.at })) };
  },
  async 'admin/blacklist/add'(c) {
    const admin = await need(c, ['admin']);
    const type = c.body.type, value = String(c.body.value ?? '').replace(/\D/g, '');
    if (!['phone', 'nid'].includes(type) || (type === 'phone' && !/^01[0125]\d{8}$/.test(value)) || (type === 'nid' && !/^\d{14}$/.test(value))) throw new HttpError(400, 'bad_input');
    await F.run(c.env, [F.set(`blacklist/${type}_${value}`, { k: `${type}_${value}`, type, value, reason: str(c.body.reason ?? '', 0, 200), at: now() }), auditLog(admin, 'blacklist.add', { targetType: type, targetId: value, note: str(c.body.reason ?? '', 0, 200) })]);
    return { ok: true };
  },
  async 'admin/blacklist/remove'(c) {
    const admin = await need(c, ['admin']);
    const k = str(c.body.id, 3, 40);
    if (!/^(phone|nid)_\d+$/.test(k)) throw new HttpError(400, 'bad_input');
    await F.run(c.env, [F.del(`blacklist/${k}`), auditLog(admin, 'blacklist.remove', { targetType: k.split('_')[0], targetId: k.split('_').slice(1).join('_') })]);
    return { ok: true };
  },

  // ---------- كوبونات الخصم (يتحكم فيها الأدمن) ----------
  async 'admin/coupons'(c) {
    await need(c, ['admin']);
    const rows = await F.query(c.env, 'coupons', { order: ['created_at', 'desc'], limit: 200 });
    return { coupons: rows.map(couponOut) };
  },
  async 'admin/coupon'(c) {
    const admin = await need(c, ['admin']);
    const b = c.body;
    if (b.action === 'delete') {
      const id = normCode(b.id);
      if (!/^[A-Z0-9_-]{3,20}$/.test(id)) throw new HttpError(400, 'bad_code');
      const cur = await F.get(c.env, `coupons/${id}`);
      if (!cur) throw new HttpError(404, 'not_found');
      await F.run(c.env, [F.del(`coupons/${id}`), auditLog(admin, 'coupon.delete', { targetType: 'coupon', targetId: id, meta: { code: id } })]);
      return { ok: true };
    }
    const isNew = !b.id;
    const id = normCode(isNew ? b.code : b.id);
    if (!/^[A-Z0-9_-]{3,20}$/.test(id)) throw new HttpError(400, 'bad_code');
    const cur = await F.get(c.env, `coupons/${id}`);
    if (isNew && cur) throw new HttpError(409, 'coupon_exists');
    if (!isNew && !cur) throw new HttpError(404, 'not_found');
    const type = b.type === 'amount' ? 'amount' : 'percent';
    const value = int(b.value, 1, type === 'percent' ? 100 : 1000000, 'bad_value');
    const fields = {
      code: id, type, value,
      max_discount: Math.floor(int(b.maxDiscount ?? 0, 0, 1000000)),
      min_price: Math.floor(int(b.minPrice ?? 0, 0, 10000000)),
      max_uses: Math.floor(int(b.maxUses ?? 0, 0, 1000000)),
      per_user: Math.floor(int(b.perUser ?? 0, 0, 1000000)),
      active: b.active !== false,
      expires_at: b.expiresAt ? Math.floor(int(b.expiresAt, 0, 9007199254740991, 'bad_date')) : 0,
      updated_at: now(),
    };
    await F.run(c.env, [
      isNew ? F.create(`coupons/${id}`, { id, ...fields, used_count: 0, created_at: now() }) : F.patch(`coupons/${id}`, fields, cur._ut),
      auditLog(admin, isNew ? 'coupon.create' : 'coupon.update', { targetType: 'coupon', targetId: id, meta: { type, value, active: fields.active, maxUses: fields.max_uses, perUser: fields.per_user } }),
    ]);
    return { ok: true, id };
  },
};

// =====================================================================
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

// تشخيص الربط: افتح /api/health بعد النشر. بيرجّع true/false فقط (بدون أي قيم سرية).
let healthCache = { at: 0, key: '', v: null }; // كاش 30 ثانية: الـendpoint عام، وبدون كاش كل طلب كان بيعمل قراءة Firestore (استنزاف كوتا). المفتاح مشتق من الإعدادات (مش هوية الـenv) عشان لو الإعدادات اتغيّرت النتيجة القديمة ما تتعرضش
async function health(env) {
  const sa = String(typeof env.FIREBASE_SERVICE_ACCOUNT === 'string' ? env.FIREBASE_SERVICE_ACCOUNT : JSON.stringify(env.FIREBASE_SERVICE_ACCOUNT ?? ''));
  const key = `${env.FIREBASE_PROJECT_ID}|${sa.length}|${sa.slice(-24)}|${env.PUSH_DISABLED ?? ''}`;
  if (healthCache.v && healthCache.key === key && Date.now() - healthCache.at < 30e3) return healthCache.v;
  const out = { db: !!env.FIREBASE_SERVICE_ACCOUNT, firestore: false, push: pushEnabled(env), projectId: !!env.FIREBASE_PROJECT_ID && !String(env.FIREBASE_PROJECT_ID).startsWith('YOUR_') };
  if (out.db && out.projectId) out.firestore = await F.get(env, 'settings/pricing').then(() => true).catch(() => false); // null (مفيش مستند) برضو معناها إن Firestore شغّال
  out.ok = out.db && out.firestore && out.projectId;
  healthCache = { at: Date.now(), key, v: out };
  return out;
}

export async function onRequest({ request, env, params, waitUntil }) {
  let route = '', uid = null;
  const bg2 = (p) => { if (waitUntil) { try { waitUntil(p); } catch { /* waitUntil مش متاح */ } } };
  try {
    route = [].concat(params.route || []).join('/');
    if (request.method === 'GET' && route === 'health') return json(await health(env));
    if (!env.FIREBASE_SERVICE_ACCOUNT) throw new HttpError(500, 'missing_service_account');
    if (request.method === 'POST' && route === 'track') return publicTrack(request, env); // من غير تسجيل دخول (محمي بالرمز العشوائي + حد محاولات بالـIP)
    if (request.method === 'GET' && route === 'about') { // بيانات الشركة للصفحة الرئيسية العامة (من غير تسجيل دخول): الحقول دي بس
      return new Response(JSON.stringify({ company: (await loadSettings(env)).company }), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=120' } });
    }
    const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const isFileGet = request.method === 'GET' && route.startsWith('files/');
    if (request.method !== 'POST' && !isFileGet) throw new HttpError(405, 'method_not_allowed');
    if (!bearer) throw new HttpError(401, 'unauthenticated');
    const token = await verifyIdToken(bearer, env.FIREBASE_PROJECT_ID);
    uid = token.uid;
    // حدّ مركزي لكل مستخدم على كل المسارات الحسّاسة (حماية موحّدة من الإساءة). مسارات الاستطلاع/القراءة مستثناة لتوفير الكوتا.
    if (env.API_RATE_DISABLED !== '1' && !isFileGet && !RL_SKIP.has(route)) {
      const max = Number(env.API_RATE_PER_MIN) > 0 ? Number(env.API_RATE_PER_MIN) : 240;
      await rateTake(env, 'api', token.uid, 60000, max, 'too_many_requests');
    }
    if (isFileGet) {
      const role = (await F.get(env, `users/${token.uid}`))?.role;
      const res = await readFile(env, { uid: token.uid, role }, route.slice(6));
      bg2(flushMetrics(env));
      return res;
    }
    const handler = Object.hasOwn(ROUTES, route) ? ROUTES[route] : null;
    if (!handler) throw new HttpError(404, 'not_found');
    const rawBody = await request.text(); // سقف حجم الطلب (أكبر طلب مشروع = رفع صورة ~0.9MB)
    if (rawBody.length > 1_600_000) throw new HttpError(413, 'too_large');
    let body = {}; try { body = JSON.parse(rawBody || '{}'); } catch { /* جسم فاضي/غلط => {} */ }
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
    const out = await handler({ env, uid: token.uid, token, body, request, waitUntil });
    bg2(flushMetrics(env));
    return json(out);
  } catch (e) {
    if (e instanceof HttpError) { bg2(flushMetrics(env)); return json(e.detail && route.startsWith('admin/') ? { error: e.code, detail: e.detail } : { error: e.code }, e.status); } // تفاصيل Firestore (رابط الفهرس) للأدمن بس
    console.error(e);
    bg2(recordError(env, { source: 'server', route, uid, status: 500, message: e?.message || String(e), stack: e?.stack }));
    bg2(sentryCapture(env, e, { route, uid }));
    bg2(flushMetrics(env));
    return json({ error: 'server_error' }, 500);
  }
}
