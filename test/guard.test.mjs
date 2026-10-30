// اختبار حراسة القيمة (مفعّلة من الأدمن): فوق حد القيمة المعلنة = كود تسليم إجباري + مفيش تحرير تلقائي (من غير أي قيد على السواقين) — Firestore وهمي. تشغيل: npm test
import assert from 'node:assert/strict';
import { webcrypto as crypto } from 'node:crypto';
import { onRequest } from '../functions/api/[[route]].js';
import { JWKS_URL } from '../functions/_lib/core.js';
import { trustOf } from '../functions/_lib/trust.js';
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
mkU('admin1', 'admin'); mkU('cF', 'customer'); mkU('stranger', 'customer'); mkU('dF', 'driver', { name: 'محمد السيد', vehicle_type: 'pickup' });
const vref = await up('dF', 'vehiclePhoto'); const idRefF = await up('dF', 'id'); FS.patch('users/dF', { vehicle_photo_ref: vref, id_ref: idRefF });
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
  await ok('سواق يقبل', call('dF', 'orders/accept', { orderId: oid }, eS));
  FS.patch(`orders/${oid}`, { status: 'paid', escrow_status: 'held' });
  await ok('في الطريق', call('dF', 'orders/status', { orderId: oid, next: 'heading_pickup' }, eS));
  await ok('تم الاستلام', call('dF', 'orders/status', { orderId: oid, next: 'picked_up', photoRef: await up('dF', 'handover'), loc: CAIRO }, eS));
  await ok('في الطريق للتسليم', call('dF', 'orders/status', { orderId: oid, next: 'in_transit' }, eS));
  return oid;
}
const deliver = async (oid, extra = {}) => call('dF', 'orders/status', { orderId: oid, next: 'delivered', photoRef: await up('dF', 'handover'), loc: GIZA, ...extra }, eS);

// ===== 1) وحدة صافية: guardOf =====
{ const { guardOf } = await import('../functions/_lib/logic.js');
  check('وحدة: مقفولة = مفيش حراسة مهما كانت القيمة', guardOf({ valueGuardOn: false, valueGuardFrom: 100 }, 1e9) === null);
  check('وحدة: تحت الحد', guardOf({ valueGuardOn: true, valueGuardFrom: 5000 }, 4999) === null);
  check('وحدة: عند الحد بالظبط = عالية', guardOf({ valueGuardOn: true, valueGuardFrom: 5000 }, 5000) === 'high');
  check('وحدة: فوق الحد', guardOf({ valueGuardOn: true, valueGuardFrom: 5000 }, 1e8) === 'high');
  check('وحدة: من غير قيمة معلنة = مفيش حراسة', guardOf({ valueGuardOn: true, valueGuardFrom: 5000 }, undefined) === null && guardOf({ valueGuardOn: true, valueGuardFrom: 5000 }, 0) === null); }

// ===== 2) الإعداد: مقفول افتراضياً، ومتحقَّق منه =====
{ const s0 = (await call('cF', 'settings')).settings;
  check('افتراضياً مقفولة والحد 20,000', s0.valueGuardOn === false && s0.valueGuardFrom === 20000); }
await bad('حد صفر مرفوض', save({ valueGuardOn: true, valueGuardFrom: 0 }), 400);
await bad('حد مش رقم مرفوض', save({ valueGuardOn: true, valueGuardFrom: 'abc' }), 400);
await ok('عميل قديم (من غير الحقول) مايبوّظش الحفظ', save({ valueGuardOn: undefined, valueGuardFrom: undefined }));
{ const s1 = (await call('cF', 'settings')).settings; check('من غير الحقول: يرجع للافتراضي', s1.valueGuardOn === false && s1.valueGuardFrom === 20000); }
await bad('غير الأدمن مايغيّرش الإعداد', call('cF', 'admin/settings/save', { ...cur, valueGuardOn: true }, eS), 403);

// ===== 3) إنشاء الطلب: المستوى بيتحسب ويتخزّن =====
const g0 = await make(50000, eS, {}, true); check('الحراسة مقفولة: شحنة 50,000 مش عالية', dataOf(g0.id).guard === null);
await ok('أدمن يفعّل الحراسة من 5,000', save({ valueGuardOn: true, valueGuardFrom: 5000 }));
check('الإعداد اتحفظ', (await call('cF', 'settings')).settings.valueGuardOn === true && (await call('cF', 'settings')).settings.valueGuardFrom === 5000);
const g1 = await make(4999); check('4,999 = مش عالية', dataOf(g1.id).guard === null);
const g2 = await make(5000); check('5,000 بالظبط = عالية', dataOf(g2.id).guard === 'high');
const g3 = await make(100000); check('100,000 = عالية', dataOf(g3.id).guard === 'high');
const g4 = await make(undefined); check('من غير قيمة معلنة = مش عالية', dataOf(g4.id).guard === null);
await bad('عالية من غير سر الكود: مرفوضة برسالة واضحة', make(5000, eN), 409, 'guard_needs_code');
await ok('تحت الحد من غير سر الكود: عادي', make(4999, eN));
{ const v = await ok('السواق يشوف الشحنة العالية (من غير قيد على السواقين)', call('dF', 'orders/get', { orderId: g3.id }, eS)); check('السواق يشوف الحراسة والقيمة قبل ما يقبل', v.order.guard === 'high' && v.order.declaredValue === 100000);
  const w = await ok('سواق جديد (مفيش له رحلات) يقبل الشحنة العالية', call('dF', 'orders/accept', { orderId: g3.id }, eS)); check('القبول اتم', orderRow(g3.id).status !== 'open'); }

// ===== 4) كود التسليم إجباري في العالية حتى لو الإعداد العام مقفول =====
cancelAll('cF', ALIVE); // نبدأ نضيف (عشان حد 10 طلبات مفتوحة)
check('الإعداد العام لكود التسليم مقفول', (await call('cF', 'settings')).settings.deliveryCode === false);
const H = await flow(30000);
{ const c = await ok('العميل يجيب كود الشحنة العالية', call('cF', 'orders/code', { orderId: H }, eS)); check('الكود شغّال (6 أرقام) رغم إن الإعداد العام مقفول', c.active === true && /^\d{6}$/.test(c.code));
  await bad('تسليم من غير كود', deliver(H), 403, 'bad_delivery_code');
  await bad('تسليم بكود غلط', deliver(H, { code: '000000' }), 403, 'bad_delivery_code');
  await ok('تسليم بالكود الصح', deliver(H, { code: c.code }));
  check('اتعلّم متحقَّق بكود', dataOf(H).deliveryVerified === 'code' && dataOf(H).deliveredWithCode === true); }
const Nn = await flow(100); // عادية (تحت الحد) والإعداد العام مقفول
{ const c = await ok('عادية: مفيش كود', call('cF', 'orders/code', { orderId: Nn }, eS)); check('الشحنة العادية مفيهاش كود إجباري', c.active === false);
  await ok('عادية: تسليم من غير كود زي ما كان', deliver(Nn)); check('اتسلّمت', orderRow(Nn).status === 'delivered'); }
const H2 = await flow(30000);
await ok('البديل «من غير كود» لسه موجود في العالية (القرار ب)', deliver(H2, { noCode: true, noCodeReason: 'customer_unreachable' }));
check('اتعلّم من غير كود والفلوس محجوزة', dataOf(H2).deliveredWithoutCode === true && orderRow(H2).escrow_status === 'held');

// ===== 5) مفيش تحرير تلقائي للعالية، والعميل لسه يقدر يأكّد =====
await ok('أدمن يفعّل التحرير التلقائي بعد ساعة', save({ valueGuardOn: true, valueGuardFrom: 5000, autoReleaseHours: 1 }));
const H3 = await flow(30000), N3 = await flow(100);
for (const oid of [H3, N3]) { FS.patch(`orders/${oid}`, { status: 'delivered', escrow_status: 'held' }); patchData(oid, { deliveredAt: Date.now() - 2 * 3600e3, deliveryVerified: 'code', deliveredWithCode: true }); }
const w0 = wallet('dF')?.balance ?? 0;
await call('cF', 'sync', {}, eS);
check('العادية اتحررت تلقائي', orderRow(N3).status === 'completed' && orderRow(N3).escrow_status === 'released');
check('العالية ما اتحررتش (فلوسها محجوزة)', orderRow(H3).status === 'delivered' && orderRow(H3).escrow_status === 'held');
const w1 = wallet('dF')?.balance ?? 0; await call('cF', 'sync', {}, eS); await call('cF', 'sync', {}, eS);
check('العالية فضلت محجوزة بعد فحوص تانية (ومفيش صرف مزدوج)', orderRow(H3).escrow_status === 'held' && (wallet('dF')?.balance ?? 0) === w1 && w1 > w0);
await ok('العميل يأكّد استلام العالية بنفسه', call('cF', 'orders/confirm', { orderId: H3 }, eS));
check('اتحررت بتأكيد العميل', orderRow(H3).status === 'completed' && orderRow(H3).escrow_status === 'released' && (wallet('dF')?.balance ?? 0) > w1);

// ===== 6) المستوى متخزّن في الطلب: تغيير الإعداد مايأثرش على الطلبات الشغّالة =====
const H4 = await flow(30000);
await ok('الأدمن يرفع الحد جداً ويقفل الحراسة', save({ valueGuardOn: false, valueGuardFrom: 100000000 }));
check('الطلب لسه عالي (متخزّن)', dataOf(H4).guard === 'high');
{ const c = await ok('كود الطلب الشغّال لسه متاح', call('cF', 'orders/code', { orderId: H4 }, eS)); check('الكود لسه إجباري للطلب القديم', c.active === true);
  await bad('وتسليمه من غير كود لسه مرفوض', deliver(H4), 403, 'bad_delivery_code'); await ok('وبالكود يعدّي', deliver(H4, { code: c.code })); }
const g5 = await make(30000); check('طلب جديد بعد القفل: مش عالي', dataOf(g5.id).guard === null);
await ok('إعادة الإعدادات للوضع الأصلي', save({ valueGuardOn: false, valueGuardFrom: 20000, autoReleaseHours: 0 }));

console.log(`\n✅ اختبارات حراسة القيمة نجحت (${pass} فحص)`);
