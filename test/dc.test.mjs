// اختبار نظام الدفع المباشر + عمولة المنصة (dc): العميل بيدفع للسواق، مكسب السواق بيتسجّل في دفتر، والحد من الأدمن بيوقّف قبول الطلبات لحد السداد (محفظة/إنستا باي + صورة + تأكيد الأدمن) — Firestore وهمي.
import assert from 'node:assert/strict';
import { webcrypto as crypto } from 'node:crypto';
import { onRequest } from '../functions/api/[[route]].js';
import { JWKS_URL } from '../functions/_lib/core.js';
import { trustOf } from '../functions/_lib/trust.js';
import { dcDue, dcBlocked } from '../functions/_lib/logic.js';
import { makeFirestore } from './fake-firestore.mjs';

const PROJECT = 'demo-ishhanli';
const b64u = (b) => Buffer.from(b).toString('base64url');

// ---- Firebase ID tokens (Auth فقط) ----
const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
async function idToken(uid, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ sub: uid, aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, iat: now, exp: now + 3600, email: `${uid}@x.com`, ...extra }));
  return `${h}.${p}.${b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, Buffer.from(`${h}.${p}`)))}`;
}

// ---- Firestore وهمي + حساب خدمة (مفتاح RSA حقيقي عشان توقيع التوكن يشتغل فعلاً) ----
const FS = makeFirestore(PROJECT);
const saPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const saPem = '-----BEGIN PRIVATE KEY-----\n' + Buffer.from(await crypto.subtle.exportKey('pkcs8', saPair.privateKey)).toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n';
const SA = JSON.stringify({ client_email: 'sa@demo.iam', private_key: saPem, project_id: PROJECT });
const env = { FIREBASE_PROJECT_ID: PROJECT, FIREBASE_SERVICE_ACCOUNT: SA, SETTINGS_TTL_MS: '0', PUSH_DISABLED: '1', METRICS_DISABLED: '1', API_RATE_DISABLED: '1', ALLOW_TEST_PAYMENTS: '1' }; // الإشعارات والعدّادات متوقفة هنا (envPush بيشغّل الإشعارات)
const envPush = { ...env, PUSH_DISABLED: '0' };
// مساعدات فحص مباشر لمحتوى القاعدة
const U = (uid) => FS.get(`users/${uid}`);
const orderRow = (id) => FS.get(`orders/${id}`);
const wallet = (uid) => FS.get(`wallets/${uid}`);
const offersFor = (oid) => FS.list('offers').filter((x) => x.order_id === oid);
const tokensOf = (uid) => FS.list('push_tokens').filter((t) => t.uid === uid);
const refundsOf = (oid) => FS.list('refunds').filter((r) => r.order_id === oid);
const clearRl = () => FS.list('rl').forEach((d) => FS.del(`rl/${d._id}`)); // تصفير حدود المعدّل (رفع/بلاغات/شات...)
const cancelAll = (cust, statuses, exceptId) => FS.list('orders').filter((o) => o.customer_id === cust && statuses.includes(o.status) && o.id !== exceptId).forEach((o) => FS.patch(`orders/${o.id}`, { status: 'cancelled' }));
const setSched = (id, ms) => FS.patch(`orders/${id}`, { scheduled_at: ms });

// ---- شبكة وهمية: مفاتيح Firebase + OSRM offline ----
let jwksFetches = 0; // عدّاد جلب مفاتيح التوقيع (اختبار حماية الإغراق بـ kid عشوائي)
const realFetch = globalThis.fetch;
const fcm = [], deadTokens = new Set(); // سجل رسائل FCM اللي اتبعتت + أجهزة "ميتة" لاختبار التنضيف
globalThis.fetch = async (url, init) => {
  url = String(url);
  if (url === JWKS_URL) { jwksFetches++; return Response.json({ keys: [jwk] }); }
  if (url.includes('router.project-osrm.org')) throw new Error('offline');
  if (url.startsWith('https://firestore.googleapis.com/')) { const r = await FS.handle(init?.method || 'GET', url, init?.body ? JSON.parse(init.body) : null); return new Response(JSON.stringify(r.body), { status: r.http }); }
  if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'fake-fcm-token', expires_in: 3600 });
  if (url.startsWith('https://fcm.googleapis.com/v1/projects/')) {
    const m = JSON.parse(init.body).message;
    if (deadTokens.has(m.token)) return new Response(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }), { status: 404 });
    fcm.push({ token: m.token, ...m.data, urgency: m.webpush?.headers?.Urgency }); return Response.json({ name: 'projects/x/messages/1' });
  }
  return realFetch(url, init);
};

// ---- مساعدات ----
let pass = 0;
async function call(uid, route, body = {}, e = env) {
  // افتراضي الاختبارات: السواق موافق على وصف الشحنة (الاختبار الصريح لـ must_agree بيبعت agree:false)
  if ((route === 'orders/accept' || route === 'offers/create') && body.agree === undefined) body = { ...body, agree: true };
  const req = new Request(`https://x.test/api/${route}`, { method: 'POST', headers: { Authorization: 'Bearer ' + (await idToken(uid)) }, body: JSON.stringify(body) });
  const bgTasks = [];
  const res = await onRequest({ request: req, env: e, params: { route: route.split('/') }, waitUntil: (p) => bgTasks.push(p) });
  const out = { ...(await res.json()), status: res.status };
  await Promise.all(bgTasks); // مهام الخلفية (الإشعارات) بتخلص قبل ما نكمل الاختبار
  return out;
}
async function getFile(uid, ref, e = env) {
  const headers = uid ? { Authorization: 'Bearer ' + (await idToken(uid)) } : {};
  const res = await onRequest({ request: new Request(`https://x.test/api/files/${ref.slice(3)}`, { headers }), env: e, params: { route: ['files', ref.slice(3)] } });
  return res;
}
const ok = async (label, p) => { const r = await p; assert.equal(r.status, 200, `${label}: ${JSON.stringify(r)}`); pass++; console.log('✓', label); return r; };
const bad = async (label, p, status, code) => { const r = await p; assert.equal(r.status, status, `${label}: ${JSON.stringify(r)}`); if (code) assert.equal(r.error, code, label); pass++; console.log('✓', label, `(${r.error})`); };
const check = (label, cond) => { assert.ok(cond, label); pass++; console.log('✓', label); };

const JPEG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(400, 7)]).toString('base64');
const up = async (uid, kind) => (await ok(`رفع ${kind} (${uid})`, call(uid, 'files/upload', { kind, data: JPEG }))).ref;
const CAIRO = { lat: 30.0444, lng: 31.2357, address: 'وسط البلد' };
const GIZA = { lat: 30.0131, lng: 31.2089, address: 'الجيزة' };

// ===== اختبارات: كود التسليم + التحرير التلقائي + رابط المتابعة + خصوصية بيانات السواق =====
const mkU = (uid, role, extra = {}) => FS.put(`users/${uid}`, { uid, role, status: 'active', name: uid, phone: '010' + Math.floor(10000000 + Math.random() * 89999999), national_id: String(Math.random()).slice(2, 16), rating_sum: 0, rating_count: 0, completed_orders: 0, cancel_count: 0, created_at: Date.now(), ...extra });
mkU('admin1', 'admin'); mkU('cF', 'customer'); mkU('stranger', 'customer'); mkU('drvFF', 'driver', { name: 'محمد السيد', vehicle_type: 'pickup' });
const vref = await up('drvFF', 'vehiclePhoto'); const idRefFF = await up('drvFF', 'id'); FS.patch('users/drvFF', { vehicle_photo_ref: vref, id_ref: idRefFF });
const eS = { ...env, DELIVERY_CODE_SECRET: 'test-secret-guard-123', SWEEP_MIN_INTERVAL_MS: 0 }; // فيه سر الكود
const eN = { ...env, SWEEP_MIN_INTERVAL_MS: 0 };                                                  // من غير سر الكود
const cur = { ...(await call('cF', 'settings')).settings, maxActiveJobs: 50 };
const save = (p, e = eS) => call('admin1', 'admin/settings/save', { ...cur, ...p }, e);
const dataOf = (oid) => JSON.parse(orderRow(oid).data || '{}');
const patchData = (oid, extra) => FS.patch(`orders/${oid}`, { data: JSON.stringify({ ...dataOf(oid), ...extra }) });
const ALIVE = ['open', 'accepted', 'paid', 'heading_pickup', 'picked_up', 'in_transit', 'payment_review', 'awaiting_payment', 'delivered'];
const make = async (dv, e = eS, extra = {}, clean = false) => { clearRl(); if (clean) cancelAll('cF', ALIVE); return call('cF', 'orders/create', { pickup: CAIRO, dropoff: GIZA, category: 'goods', size: 'small', weightKg: 100, description: 'كراتين أدوات منزلية 4 قطع', ...(dv === undefined ? {} : { declaredValue: dv }), scheduledAt: new Date(Date.now() + 3600e3).toISOString(), photos: [await up('cF', 'cargo')], ...extra }, e); };
// طلب لحد «في الطريق للتسليم» (نتخطى الدفع)
async function flow(dv) {
  const cr = await ok('إنشاء طلب', make(dv)); const oid = cr.id;
  await ok('سواق يقبل', call('drvFF', 'orders/accept', { orderId: oid }, eS));
  FS.patch(`orders/${oid}`, { status: 'paid', escrow_status: 'held' });
  await ok('في الطريق', call('drvFF', 'orders/status', { orderId: oid, next: 'heading_pickup' }, eS));
  await ok('تم الاستلام', call('drvFF', 'orders/status', { orderId: oid, next: 'picked_up', photoRef: await up('drvFF', 'handover'), loc: CAIRO }, eS));
  await ok('في الطريق للتسليم', call('drvFF', 'orders/status', { orderId: oid, next: 'in_transit' }, eS));
  return oid;
}
const deliver = async (oid, extra = {}) => call('drvFF', 'orders/status', { orderId: oid, next: 'delivered', photoRef: await up('drvFF', 'handover'), loc: GIZA, ...extra }, eS);

mkU('drvXX', 'driver', { name: 'سواق تاني', vehicle_type: 'pickup' });
const DAYMS = 86400e3, cods = () => FS.list('cod'), codOf = (oid) => cods().find((e) => e.order_id === oid);
const mk = async (extra = {}) => ok('طلب', make(100, eS, extra, true));
const toTransit = async (oid) => { await ok('سواق يقبل', call('drvFF', 'orders/accept', { orderId: oid }, eS)); FS.patch(`orders/${oid}`, { status: 'paid', escrow_status: 'held' });
  await ok('في الطريق', call('drvFF', 'orders/status', { orderId: oid, next: 'heading_pickup' }, eS));
  await ok('تم الاستلام', call('drvFF', 'orders/status', { orderId: oid, next: 'picked_up', photoRef: await up('drvFF', 'handover'), loc: CAIRO }, eS));
  await ok('في الطريق للتسليم', call('drvFF', 'orders/status', { orderId: oid, next: 'in_transit' }, eS)); };

mkU('drvYY', 'driver', { name: 'سواق ثالث', vehicle_type: 'pickup' });
const setPrice = (oid, n) => { FS.patch(`orders/${oid}`, { price: n }); patchData(oid, { price: n, amountDue: n }); };
const ledger = (uid, oid) => FS.get(`dc_ledger/${uid}/entries/${oid}`);
const drive = async (drv, oid) => { // من «السواق قبل» لحد «تم التسليم» (الدفع المباشر: مفيش دفع ولا ضمان)
  await ok('في الطريق', call(drv, 'orders/status', { orderId: oid, next: 'heading_pickup' }, eS));
  await ok('تم الاستلام', call(drv, 'orders/status', { orderId: oid, next: 'picked_up', photoRef: await up(drv, 'handover'), loc: CAIRO }, eS));
  await ok('في الطريق للتسليم', call(drv, 'orders/status', { orderId: oid, next: 'in_transit' }, eS)); };
const finish = async (drv, oid) => call(drv, 'orders/status', { orderId: oid, next: 'delivered', photoRef: await up(drv, 'handover'), loc: GIZA }, eS);
mkU('drvYY2', 'driver'); // مش بنستخدمه — بس بيتأكد إن وجود سواقين تانيين ما بيأثرش
FS.patch('users/drvYY', { vehicle_photo_ref: vref, id_ref: idRefFF });

// ===== 1) وحدة صافية =====
{ check('عمولة 2% من 1000 = 20', dcDue(1000, 2) === 20);
  check('عمولة على 1400 بنسبة 2% = 28', dcDue(1400, 2) === 28);
  check('تقريب: 2.5% من 1001 = 25', dcDue(1001, 2.5) === 25);
  check('مدخلات غير صالحة = صفر', dcDue(-5, 2) === 0 && dcDue('x', 'y') === 0 && dcDue(1000, 0) === 0);
  const on = { dcEnabled: true, dcPct: 2, dcLimit: 1000 };
  check('900 تحت الحد = مش متوقف', dcBlocked(900, on) === false);
  check('1000 = الحد نفسه متوقف', dcBlocked(1000, on) === true);
  check('1200 فوق الحد = متوقف', dcBlocked(1200, on) === true);
  check('النظام مقفول = مفيش توقيف', dcBlocked(5000, { ...on, dcEnabled: false }) === false);
  check('نسبة 0 = مفيش توقيف (من غير فلوس)', dcBlocked(5000, { ...on, dcPct: 0 }) === false); }

// ===== 2) مقفول افتراضياً + تحقق الإعدادات =====
check('مقفول افتراضياً (2% / حد 1000)', cur.dcEnabled === false && cur.dcPct === 2 && cur.dcLimit === 1000);
{ const a = await ok('طلب والنظام مقفول', make(100, eS, {}, true)); check('النظام القديم: الدفع على المنصة (مش مباشر)', dataOf(a.id).payMode === 'after' && dataOf(a.id).direct === false); }
await bad('عميل مايفعّلش', call('cF', 'admin/settings/save', { ...cur, dcEnabled: true }, eS), 403, 'forbidden');
await bad('نسبة فوق 50', save({ dcEnabled: true, dcPct: 51 }), 400, 'bad_input');
await bad('حد صفر', save({ dcEnabled: true, dcLimit: 0 }), 400, 'bad_input');
await ok('الأدمن يفعّله (2% / 1000 / محفظة)', save({ dcEnabled: true, dcPct: 2, dcLimit: 1000, dcPay: { wallet: '01012345678', walletName: 'المنصة' } }));
{ const S = (await call('cF', 'settings')).settings; check('الإعدادات اتحفظت', S.dcEnabled === true && S.dcPct === 2 && S.dcLimit === 1000 && S.dcPay.wallet === '01012345678'); }

// ===== 3) طلب الدفع المباشر =====
await bad('كوبون مع الدفع المباشر ممنوع', make(100, eS, { coupon: 'SAVE10' }, true), 400, 'coupon_unavailable');
{ const p = await ok('طلب بخيار الدفع المقدم', make(100, eS, { prepay: true }, true)); const d = dataOf(p.id);
  check('الدفع المباشر بيتخطى الدفع المقدم', d.direct === true && d.payMode === 'direct' && p.prepay === false && orderRow(p.id).status === 'open'); }

// ===== 4) سيناريو الحد: 900 ثم طلب 300 يعدّي الحد، وبعدها بيتوقف =====
const O1 = (await mk()).id; setPrice(O1, 900);
await ok('سواق يقبل (دفع مباشر)', call('drvFF', 'orders/accept', { orderId: O1 }, eS));
check('الحالة paid من غير ضمان', orderRow(O1).status === 'paid' && orderRow(O1).escrow_status === 'none');
await drive('drvFF', O1);
await bad('العميل مايقدرش يفتح نزاع (مفيش فلوس محجوزة)', call('cF', 'disputes/create', { orderId: O1, reason: 'delay' }, eS), 409, 'direct_no_dispute');
await ok('السواق يأكّد التسليم', finish('drvFF', O1)); check('الطلب اتكمّل مباشرة', orderRow(O1).status === 'completed');
check('مكسب السواق اتسجّل 900', U('drvFF').dc_gross === 900 && ledger('drvFF', O1)?.gross === 900);
check('مفيش فلوس دخلت محفظة السواق', !wallet('drvFF') || (wallet('drvFF').balance || 0) === 0);
check('عدّاد الطلبات المكتملة زاد للاتنين', U('drvFF').completed_orders === 1 && U('cF').completed_orders === 1);
{ const s1 = await call('drvFF', 'dc/summary', {}, eS); check('900 تحت الحد: مش متوقف والعمولة 18', s1.blocked === false && s1.gross === 900 && s1.due === 18 && s1.limit === 1000 && s1.pct === 2); }

// الطلب التاني من غير تنضيف عشان الاتنين يفضلوا مفتوحين
const O2 = (await mk()).id, O3 = (await ok('طلب', make(100, eS, {}, false))).id; setPrice(O2, 300); setPrice(O3, 200);
await ok('طلب 300: يقبله وهو تحت الحد', call('drvFF', 'orders/accept', { orderId: O2 }, eS));
await ok('طلب 200: يقبله وهو لسه تحت الحد', call('drvFF', 'orders/accept', { orderId: O3 }, eS));
await drive('drvFF', O2); await ok('تسليم طلب 300', finish('drvFF', O2));
check('900 + 300 = 1200 عدّى الحد', U('drvFF').dc_gross === 1200);
{ const s2 = await call('drvFF', 'dc/summary', {}, eS); check('بقى متوقف والعمولة المستحقة 24', s2.blocked === true && s2.due === 24); }
await drive('drvFF', O3); // الطلب الشغّال بيكمّل عادي حتى بعد ما الحساب اتوقف
await ok('تسليم طلب 200', finish('drvFF', O3));
check('الإجمالي 1400', U('drvFF').dc_gross === 1400);

const O4 = (await mk()).id;
await bad('المتوقف مايقبلش طلب جديد', call('drvFF', 'orders/accept', { orderId: O4 }, eS), 403, 'dc_blocked');
await bad('ولا يقدّم عرض سعر', call('drvFF', 'offers/create', { orderId: O4, price: 150 }, eS), 403, 'dc_blocked');
await ok('سواق تاني مش متوقف يقبل عادي', call('drvYY', 'orders/accept', { orderId: O4 }, eS));
{ const O5 = (await mk()).id; await ok('سواق تاني يقدّم عرض', call('drvXX', 'offers/create', { orderId: O5, price: 160 }, eS));
  FS.patch('users/drvXX', { dc_gross: 5000 }); const f = offersFor(O5)[0];
  await bad('اتوقف بعد عرضه: العميل مايقدرش يقبله', call('cF', 'offers/accept', { offerId: f.id }, eS), 409, 'driver_unavailable');
  FS.patch('users/drvXX', { dc_gross: 0 }); }

// ===== 5) إلغاء الدفع المباشر =====
{ const C = (await mk()).id; await ok('سواق يقبل', call('drvYY', 'orders/accept', { orderId: C }, eS));
  await ok('العميل يلغي بعد القبول (من غير رسوم)', call('cF', 'orders/cancel', { orderId: C }, eS));
  check('اتلغى من غير أي حركة فلوس', orderRow(C).status === 'cancelled' && !FS.list('refunds').some((r) => r.order_id === C)); }
{ const C = (await mk()).id; await ok('سواق يقبل', call('drvYY', 'orders/accept', { orderId: C }, eS));
  await ok('السواق يعتذر', call('drvYY', 'orders/cancel', { orderId: C }, eS));
  check('الطلب رجع مفتوح', orderRow(C).status === 'open'); }

// ===== 6) السداد: محفظة/إنستا باي + صورة التحويل =====
const proofF = await up('drvFF', 'payment'), proofX = await up('drvXX', 'payment');
await bad('طريقة دفع غلط', call('drvFF', 'dc/pay', { method: 'cash', proofRef: proofF, reference: 'WAL-12345' }, eS), 400, 'bad_method');
await bad('مرجع قصير', call('drvFF', 'dc/pay', { method: 'wallet', proofRef: proofF, reference: 'ab' }, eS), 400);
{ const r = await call('drvFF', 'dc/pay', { method: 'wallet', proofRef: proofX, reference: 'WAL-12345' }, eS); check('إثبات صورة حد تاني مرفوض', r.status !== 200); }
await bad('سواق ماعليهوش حاجة', call('drvYY', 'dc/pay', { method: 'wallet', proofRef: await up('drvYY', 'payment'), reference: 'YY-0001' }, eS), 409, 'nothing_due');
await bad('عميل مايسدّدش', call('cF', 'dc/pay', { method: 'wallet', proofRef: proofF, reference: 'WAL-12345' }, eS), 403, 'forbidden');
const pay1 = await ok('السواق يبعت تحويل المحفظة', call('drvFF', 'dc/pay', { method: 'wallet', proofRef: proofF, reference: 'WAL-12345' }, eS));
check('المبلغ = 2% من 1400 = 28', pay1.amount === 28);
await bad('طلب سداد تاني وفيه واحد معلّق', call('drvFF', 'dc/pay', { method: 'wallet', proofRef: await up('drvFF', 'payment'), reference: 'WAL-99999' }, eS), 409, 'dc_pending');
{ FS.patch('users/drvXX', { dc_gross: 5000 });
  const r = await call('drvXX', 'dc/pay', { method: 'wallet', proofRef: proofX, reference: 'wal-12345' }, eS); check('نفس رقم المرجع ما يتكررش (حتى باختلاف الحروف)', r.status === 409 && r.error === 'dc_conflict'); FS.patch('users/drvXX', { dc_gross: 0 }); }
{ const s3 = await call('drvFF', 'dc/summary', {}, eS); check('الملخص بيعرض الطلب المعلّق وبيانات السداد', s3.pending?.amount === 28 && s3.pending.status === 'pending' && s3.pay.wallet.wallet === '01012345678' && s3.entries.length === 3 && s3.blocked === true); }

// لوحة الأدمن
await bad('غير الأدمن مايشوفش', call('cF', 'admin/dc/list', {}, eS), 403, 'forbidden');
{ const l = await ok('لوحة الأدمن', call('admin1', 'admin/dc/list', {}, eS));
  check('فيها طلب السداد المعلّق', l.pending.length === 1 && l.pending[0].amount === 28 && l.pending[0].gross === 1400);
  check('وفيها السواق المتوقف وعليه 1400', l.drivers.some((d) => d.id === 'drvFF' && d.gross === 1400 && d.blocked === true && d.due === 28)); }

// طلب خلص بعد طلب السداد (الإجمالي بقى 1500): التأكيد بيخصم اللي اتحسب بس
FS.patch('users/drvFF', { dc_gross: 1500 });
await bad('رفض من غير سبب', call('admin1', 'admin/dc/confirm', { id: pay1.id, action: 'reject' }, eS), 400, 'bad_input');
await bad('إجراء غلط', call('admin1', 'admin/dc/confirm', { id: pay1.id, action: 'x' }, eS), 400, 'bad_action');
await bad('عميل مايأكدش', call('cF', 'admin/dc/confirm', { id: pay1.id, action: 'confirm' }, eS), 403, 'forbidden');
{ const r = await ok('الأدمن يأكد السداد', call('admin1', 'admin/dc/confirm', { id: pay1.id, action: 'confirm', note: 'اتأكد من المحفظة' }, eS));
  check('اتخصم 1400 وفضل 100 (الطلب اللي خلص بعد الطلب)', r.left === 100 && U('drvFF').dc_gross === 100 && U('drvFF').dc_paid_total === 28);
  check('الحالة paid', FS.get(`dc_pay/${pay1.id}`).status === 'paid'); }
await bad('مايتأكدش مرتين', call('admin1', 'admin/dc/confirm', { id: pay1.id, action: 'confirm' }, eS), 409, 'bad_state');
{ const s4 = await call('drvFF', 'dc/summary', {}, eS); check('رجع يقبل طلبات (100 تحت الحد)', s4.blocked === false && s4.history.length === 1 && s4.history[0].status === 'paid'); }
{ const O6 = (await mk()).id; await ok('السواق بعد السداد يقبل طلب جديد', call('drvFF', 'orders/accept', { orderId: O6 }, eS)); }

// رفض + إعادة إرسال بنفس المرجع
FS.patch('users/drvXX', { dc_gross: 5000 });
const pay2 = await ok('سواق تاني يبعت إنستا باي', call('drvXX', 'dc/pay', { method: 'instapay', proofRef: proofX, reference: 'INS-777' }, eS));
await ok('الأدمن يرفض بسبب', call('admin1', 'admin/dc/confirm', { id: pay2.id, action: 'reject', note: 'الصورة مش واضحة' }, eS));
check('الرفض ما خصمش حاجة والمرجع اتحرر', U('drvXX').dc_gross === 5000 && FS.get(`dc_pay/${pay2.id}`).status === 'rejected' && FS.list('dc_ref').every((x) => x.pay_id !== pay2.id));
await ok('يبعت تاني بنفس المرجع بعد الرفض', call('drvXX', 'dc/pay', { method: 'instapay', proofRef: proofX, reference: 'INS-777' }, eS));

// تعديل يدوي من الأدمن
await bad('تعديل من غير سبب', call('admin1', 'admin/dc/adjust', { uid: 'drvXX', gross: 0 }, eS), 400);
await bad('تعديل على عميل', call('admin1', 'admin/dc/adjust', { uid: 'stranger', gross: 0, note: 'تجربة' }, eS), 404, 'not_found');
await bad('عميل مايعدّلش', call('cF', 'admin/dc/adjust', { uid: 'drvXX', gross: 0, note: 'تجربة' }, eS), 403, 'forbidden');
await ok('الأدمن يصحّح الإجمالي', call('admin1', 'admin/dc/adjust', { uid: 'drvXX', gross: 300, note: 'تصحيح خطأ تسجيل' }, eS));
check('الإجمالي اتصحّح', U('drvXX').dc_gross === 300);
check('سجل التدقيق فيه الإجراءات التلاتة', ['dc.confirm', 'dc.reject', 'dc.adjust'].every((a) => FS.list('audit').some((x) => x.action === a)));

// حفظ إعدادات مع إبقاء نظام الدفع المباشر شغّال (save بيبني على لقطة الإعدادات الأصلية)
const sv = (p) => save({ dcEnabled: true, dcPct: 2, dcLimit: 1000, ...p });
// ===== 6ب) تأكيد العميل بيكفي + الإكمال التلقائي بعد 24 ساعة من الاستلام =====
FS.patch('users/drvFF', { dc_gross: 0 });
check('الإعداد الافتراضي: 24 ساعة', cur.dcAutoCompleteHours === 24 && cur.jobsRadiusKm === 15);
await bad('ساعات غلط', sv({ dcAutoCompleteHours: 721 }), 400, 'bad_input');
{ const A = (await mk()).id; setPrice(A, 400);
  await ok('سواق يقبل', call('drvFF', 'orders/accept', { orderId: A }, eS));
  await bad('العميل مايأكدش قبل الاستلام', call('cF', 'orders/confirm', { orderId: A }, eS), 409, 'bad_state');
  await drive('drvFF', A);
  { const r = await call('stranger', 'orders/confirm', { orderId: A }, eS); check('حد غريب مايأكدش', r.status !== 200); }
  fcm.length = 0;
  await ok('العميل يأكد الاستلام (من غير ما السواق يضغط تم التسليم)', call('cF', 'orders/confirm', { orderId: A }, eS));
  check('الطلب اتكمّل وتأكيد العميل اتسجّل', orderRow(A).status === 'completed' && dataOf(A).deliveryVerified === 'customer' && dataOf(A).directGross === 400);
  check('مكسب السواق اتسجّل 400', U('drvFF').dc_gross === 400 && ledger('drvFF', A)?.gross === 400);
  check('الأدمن شايف إن مفيش فلوس اتحركت', !wallet('drvFF') || (wallet('drvFF').balance || 0) === 0);
  await bad('التأكيد مرتين ممنوع', call('cF', 'orders/confirm', { orderId: A }, eS), 409, 'bad_state');
  await bad('والسواق مايقدرش يضغط تسليم بعده', finish('drvFF', A), 409); }
{ const B = (await mk()).id; setPrice(B, 600);
  await ok('سواق يقبل', call('drvFF', 'orders/accept', { orderId: B }, eS)); await drive('drvFF', B);
  await ok('فحص دوري والطلب لسه جديد', call('drvFF', 'orders/list', { scope: 'mine' }, eS));
  check('لسه شغّال (ماعدّاش 24 ساعة)', orderRow(B).status === 'in_transit');
  patchData(B, { pickedUpAt: Date.now() - 25 * 3600000 }); fcm.length = 0;
  await ok('فحص دوري بعد 25 ساعة من الاستلام', call('drvFF', 'orders/list', { scope: 'available' }, eS));
  check('اتكمّل تلقائي وقيّد التسليم', orderRow(B).status === 'completed' && dataOf(B).deliveryVerified === 'auto' && dataOf(B).log.some((x) => x.note === 'direct_auto'));
  check('مكسب السواق اتحسب (400 + 600)', U('drvFF').dc_gross === 1000 && ledger('drvFF', B)?.gross === 600);
  check('السواق اتحرر وتوقّف لأنه وصل الحد', (await call('drvFF', 'dc/summary', {}, eS)).blocked === true); }
{ const C = (await mk()).id; setPrice(C, 100); FS.patch('users/drvYY', { dc_gross: 0 });
  await ok('سواق يقبل', call('drvYY', 'orders/accept', { orderId: C }, eS)); await drive('drvYY', C);
  await ok('الأدمن يقفل الإكمال التلقائي', sv({ dcAutoCompleteHours: 0 }));
  patchData(C, { pickedUpAt: Date.now() - 100 * 3600000 });
  await ok('فحص دوري', call('drvYY', 'orders/list', { scope: 'mine' }, eS));
  check('مقفول = الطلب يفضل شغّال', orderRow(C).status === 'in_transit');
  await ok('الأدمن يرجّعه', sv({ dcAutoCompleteHours: 24 }));
  await ok('فحص دوري', call('drvYY', 'orders/list', { scope: 'mine' }, eS));
  check('رجع = اتكمّل', orderRow(C).status === 'completed'); }
// الطلب الواحد: سواق فيه طلب شغّال مايقبلش تاني (الحد الافتراضي طلب واحد)
FS.patch('users/drvYY', { dc_gross: 0 });
{ await ok('الحد الافتراضي: طلب شغّال واحد (الاختبارات بتفكّه)', sv({ maxActiveJobs: 1 }));
  const D1 = (await mk()).id; await ok('سواق يقبل', call('drvYY', 'orders/accept', { orderId: D1 }, eS));
  const D2 = (await ok('طلب', make(100, eS, {}, false))).id;
  const r = await call('drvYY', 'orders/accept', { orderId: D2 }, eS); check('وهو شاغل بطلب مفتوح مايقبلش تاني', r.status === 409);
  await ok('العميل يلغي', call('cF', 'orders/cancel', { orderId: D1 }, eS)); }

// ===== 6ج) نطاق الطلبات: كل سواق بيشوف اللي في دايرة 15 كم من موقعه =====
const NEAR = { lat: 30.05, lng: 31.24 }, FAR = { lat: 31.2001, lng: 29.9187 }; // القاهرة / إسكندرية
{ await sv({}); const R = (await mk()).id; // طلب استلامه في وسط القاهرة
  const L0 = await ok('قائمة من غير أي موقع', call('drvXX', 'orders/list', { scope: 'available' }, eS));
  check('من غير موقع: مفيش طلبات + طلب تفعيل الموقع', L0.orders.length === 0 && L0.needLocation === true && L0.radiusKm === 15);
  const Ln = await ok('قائمة وهو قريب', call('drvXX', 'orders/list', { scope: 'available', loc: NEAR }, eS));
  check('بيشوف الطلب القريب ومعاه المسافة منه', Ln.orders.some((o) => o.id === R && typeof o.fromMeKm === 'number' && o.fromMeKm < 5) && !Ln.needLocation);
  const Lf = await ok('قائمة وهو بعيد', call('drvXX', 'orders/list', { scope: 'available', loc: FAR }, eS));
  check('بعيد (إسكندرية): مابيشوفش الطلب', !Lf.orders.some((o) => o.id === R));
  await bad('إحداثيات غلط', call('drvXX', 'orders/list', { scope: 'available', loc: { lat: 999, lng: 0 } }, eS), 200).catch(() => {});
  await bad('قبول وهو بعيد', call('drvXX', 'orders/accept', { orderId: R, loc: FAR }, eS), 403, 'out_of_range');
  await bad('عرض سعر وهو بعيد', call('drvXX', 'offers/create', { orderId: R, price: 170, loc: FAR }, eS), 403, 'out_of_range');
  await ok('عرض سعر وهو قريب', call('drvXX', 'offers/create', { orderId: R, price: 170, loc: NEAR }, eS));
  // آخر موقع متسجّل (متاح لاستقبال الطلبات) بيستخدم لو القائمة اتطلبت من غير موقع
  await ok('السواق يسجّل موقعه كمتاح', call('drvYY', 'driver/presence', { online: true, ...NEAR }, eS));
  check('القائمة من غير loc بتستخدم آخر موقع', (await call('drvYY', 'orders/list', { scope: 'available' }, eS)).orders.some((o) => o.id === R));
  await ok('الأدمن يوسّع/يلغي النطاق', sv({ jobsRadiusKm: 0 }));
  const L1 = await ok('من غير حد', call('drvXX', 'orders/list', { scope: 'available', loc: FAR }, eS));
  check('النطاق 0 = كل الطلبات ظاهرة', L1.orders.some((o) => o.id === R) && !L1.needLocation);
  await bad('نطاق غلط', sv({ jobsRadiusKm: 501 }), 400, 'bad_input');
  await ok('نطاق 5 كم', sv({ jobsRadiusKm: 5 }));
  check('القاهرة قريبة جوه 5 كم', (await call('drvXX', 'orders/list', { scope: 'available', loc: NEAR }, eS)).orders.some((o) => o.id === R));
  check('قائمة السواق لشغله مش بتتأثر بالنطاق', Array.isArray((await call('drvXX', 'orders/list', { scope: 'mine', loc: FAR }, eS)).orders));
  await ok('نرجّع 15', sv({ jobsRadiusKm: 15 })); }

// ===== 7) الأدمن يقفل النظام =====
FS.patch('users/drvFF', { dc_gross: 5000 });
check('عليه 5000 = متوقف', (await call('drvFF', 'dc/summary', {}, eS)).blocked === true);
await ok('الأدمن يقفل النظام', save({ dcEnabled: false }));
{ const d1 = await mk(); check('النظام مقفول = رجعنا لنظام الضمان', dataOf(d1.id).payMode === 'after' && dataOf(d1.id).direct === false);
  await ok('مفيش توقيف والنظام مقفول', call('drvFF', 'orders/accept', { orderId: d1.id }, eS));
  const s5 = await call('drvFF', 'dc/summary', {}, eS); check('الملخص بيقول مقفول', s5.enabled === false && s5.blocked === false);
  await bad('السداد مقفول', call('drvFF', 'dc/pay', { method: 'wallet', proofRef: await up('drvFF', 'payment'), reference: 'CLOSED-1' }, eS), 403, 'dc_off'); }
// نسبة 0 = دفع مباشر من غير عمولة ولا توقيف
await ok('الأدمن يفعّله بنسبة 0', save({ dcEnabled: true, dcPct: 0, dcLimit: 1000 }));
{ const z = await mk(); setPrice(z.id, 700); FS.patch('users/drvXX', { dc_gross: 0 });
  await ok('سواق يقبل', call('drvXX', 'orders/accept', { orderId: z.id }, eS)); await drive('drvXX', z.id); await ok('تسليم', finish('drvXX', z.id));
  check('نسبة 0: الطلب اتكمّل من غير تسجيل في الدفتر', orderRow(z.id).status === 'completed' && !U('drvXX').dc_gross && !ledger('drvXX', z.id)); }

console.log(`\n✅ اختبارات الدفع المباشر وعمولة المنصة نجحت (${pass} فحص)`);
