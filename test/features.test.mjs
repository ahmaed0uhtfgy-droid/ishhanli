// اختبار شامل للسيرفر على Firestore وهمي (test/fake-firestore.mjs: نفس واجهة REST + نفس قيود الفهارس والشروط) — من غير إنترنت.  تشغيل: npm test
import assert from 'node:assert/strict';
import { webcrypto as crypto } from 'node:crypto';
import { onRequest } from '../functions/api/[[route]].js';
import { JWKS_URL } from '../functions/_lib/core.js';
import { trustOf } from '../functions/_lib/trust.js';
import { makeFirestore } from './fake-firestore.mjs';
import { DEFAULTS as __ESC } from '../functions/_lib/logic.js'; __ESC.dcEnabled = false; for (const k of Object.keys(__ESC.vehiclePricing)) __ESC.vehiclePricing[k] = { base: 0, perKm: 0, minPrice: 0, kmFee: 0 }; // الاختبارات دي بتفترض المعادلة العامة (التسعير لكل نوع تقديري جديد وليه اختبار خاص) // هذا الملف بيختبر نظام الضمان القديم، فبنختاره صراحةً (الافتراضي الجديد = الدفع المباشر)

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
const eC = { ...env, DELIVERY_CODE_SECRET: 'test-secret-123', SWEEP_MIN_INTERVAL_MS: 0 };
const cur = (await call('cF', 'settings')).settings;
await ok('أدمن يفعّل كود التسليم + تحرير تلقائي بعد ساعة', call('admin1', 'admin/settings/save', { ...cur, deliveryCode: true, autoReleaseHours: 1 }, eC));
check('الإعداد اتحفظ', (await call('cF', 'settings', {}, eC)).settings.deliveryCode === true && (await call('cF', 'settings', {}, eC)).settings.deliveryCodeAvailable === true);

async function inTransit() {
  const photo = await up('cF', 'cargo');
  const cr = await ok('إنشاء طلب', call('cF', 'orders/create', { pickup: CAIRO, dropoff: GIZA, category: 'goods', size: 'small', weightKg: 100, description: 'كراتين أدوات منزلية 4 قطع', scheduledAt: new Date(Date.now() + 3600e3).toISOString(), photos: [photo] }, eC));
  const oid = cr.id;
  await ok('سواق يقبل', call('dF', 'orders/accept', { orderId: oid }, eC));
  FS.patch(`orders/${oid}`, { status: 'paid', escrow_status: 'held' }); // نتخطى خطوات الدفع (مش موضوع الاختبار)
  await ok('في الطريق', call('dF', 'orders/status', { orderId: oid, next: 'heading_pickup' }, eC));
  await ok('تم الاستلام', call('dF', 'orders/status', { orderId: oid, next: 'picked_up', photoRef: await up('dF', 'handover'), loc: CAIRO }, eC));
  await ok('في الطريق للتسليم', call('dF', 'orders/status', { orderId: oid, next: 'in_transit' }, eC));
  return oid;
}
const dataOf = (oid) => JSON.parse(orderRow(oid).data || '{}');
const ageDelivery = (oid, hours) => { const d = dataOf(oid); d.deliveredAt = Date.now() - hours * 3600e3; FS.patch(`orders/${oid}`, { data: JSON.stringify(d) }); };
const deliver = async (oid, extra = {}) => call('dF', 'orders/status', { orderId: oid, next: 'delivered', photoRef: await up('dF', 'handover'), loc: GIZA, ...extra }, eC);

// ---- خصوصية بيانات السواق: العميل يشوف التليفون وصورة العربية بس ----
const A = await inTransit();
const view = await ok('العميل يفتح الطلب', call('cF', 'orders/get', { orderId: A }, eC));
check('العميل يشوف تليفون السواق', !!view.order.driverPhone);
check('العميل يشوف صورة العربية', view.order.driverVehiclePhoto === vref);
check('مفيش بطاقة/رخصة/رقم قومي في رد العميل', !/national|idRef|licenseRef|vehicleReg|id_ref|license_ref/i.test(JSON.stringify(view.order)));
check('العميل يقدر يحمّل صورة العربية', (await getFile('cF', vref, eC)).status === 200);
check('العميل ما يقدرش يحمّل بطاقة السواق', (await getFile('cF', idRefF, eC)).status === 403);
{ const { orderOut } = await import('../functions/_lib/db.js');
  const o = orderOut({ id: 'x', customerId: 'cF', driverId: 'dF', status: 'paid', handler: { name: 'ن', phone: '010', plate: 'أ ب 123', vehicleType: 'pickup', vehiclePhotoRef: 'fs:photo1', nationalId: '123', idRef: 'fs:id', licenseRef: 'fs:lic' } }, { uid: 'cF', role: 'customer' });
  check('سواق الشركة: العميل ياخد الاسم والتليفون وصورة العربية بس', o.handler.vehiclePhotoRef === 'fs:photo1' && !o.handler.nationalId && !o.handler.idRef && !o.handler.licenseRef); }

// ---- كود التسليم ----
await bad('تسليم من غير كود', deliver(A), 403, 'bad_delivery_code');
await bad('تسليم بكود غلط', deliver(A, { code: '000000' }), 403, 'bad_delivery_code');
const codeA = await ok('العميل يجيب كود التسليم', call('cF', 'orders/code', { orderId: A }, eC));
check('الكود 6 أرقام', codeA.active && /^\d{6}$/.test(codeA.code));
check('الكود ثابت لنفس الطلب', (await call('cF', 'orders/code', { orderId: A }, eC)).code === codeA.code);
await bad('السواق مايقدرش يطلب الكود', call('dF', 'orders/code', { orderId: A }, eC), 403);
await bad('عميل تاني مايقدرش يطلب الكود', call('stranger', 'orders/code', { orderId: A }, eC), 403, 'forbidden');
check('الكود مش متخزّن في الطلب', !JSON.stringify(orderRow(A)).includes(codeA.code));
await ok('تسليم بالكود الصح', deliver(A, { code: codeA.code.slice(0, 3) + ' ' + codeA.code.slice(3), photoRef: await up('dF', 'handover') }));
check('الطلب اتعلّم متحقَّق بكود', dataOf(A).deliveryVerified === 'code' && dataOf(A).deliveredWithCode === true);

// ---- حد محاولات التخمين + التسليم بدون كود ----
const B = await inTransit();
const photoB = async () => ({ photoRef: await up('dF', 'handover') });
const codeB = (await call('cF', 'orders/code', { orderId: B }, eC)).code;
for (let i = 0; i < 6; i++) await bad(`تخمين ${i + 1}`, deliver(B, { code: String(100000 + i), ...(await photoB()) }), 403, 'bad_delivery_code');
await bad('بعد 6 محاولات حتى الكود الصح بيتقفل', deliver(B, { code: codeB, ...(await photoB()) }), 429);
await ok('بديل: تسليم بدون كود (العميل مش متاح)', deliver(B, { noCode: true, noCodeReason: 'customer_unreachable', ...(await photoB()) }));
check('اتعلّم تسليم بدون كود', dataOf(B).deliveredWithoutCode === true && dataOf(B).deliveryVerified !== 'code');

// ---- التحرير التلقائي ----
const C = await inTransit(); await ok('تسليم C بكود', deliver(C, { code: (await call('cF', 'orders/code', { orderId: C }, eC)).code, ...(await photoB()) }));
ageDelivery(A, 2); ageDelivery(B, 2); // A اتسلّم بكود من ساعتين، B بدون كود، C لسه جديد
const w0 = (wallet('dF')?.balance ?? 0);
await call('cF', 'sync', {}, eC); // الفحص الدوري
check('A اتحرر تلقائي', orderRow(A).status === 'completed' && orderRow(A).escrow_status === 'released');
check('فلوس السواق زادت', (wallet('dF')?.balance ?? 0) > w0);
check('B (بدون كود) ما اتحررش', orderRow(B).status === 'delivered' && orderRow(B).escrow_status === 'held');
check('C (لسه جديد) ما اتحررش', orderRow(C).status === 'delivered');
check('السجل بيوضّح إنه تلقائي', JSON.stringify(dataOf(A).log || []).includes('auto_release'));
const w1 = (wallet('dF')?.balance ?? 0); await call('cF', 'sync', {}, eC); await call('cF', 'sync', {}, eC);
check('مفيش صرف مزدوج', (wallet('dF')?.balance ?? 0) === w1);
await bad('العميل يأكد بعد التحرير التلقائي', call('cF', 'orders/confirm', { orderId: A }, eC), 409, 'bad_state');
await ok('العميل يأكد C بنفسه', call('cF', 'orders/confirm', { orderId: C }, eC));

// ---- رابط متابعة المستلم (عام) ----
const D = await inTransit();
await ok('السواق يبعت موقعه', call('dF', 'orders/location', { orderId: D, lat: 30.0451, lng: 31.2357 }, eC));
await bad('عميل تاني مايقدرش يعمل رابط', call('stranger', 'orders/share', { orderId: D }, eC), 403, 'forbidden');
const sh = await ok('العميل يعمل رابط متابعة', call('cF', 'orders/share', { orderId: D }, eC));
check('الرمز 32 حرف', /^[A-Za-z0-9_-]{32}$/.test(sh.token));
check('الرمز مش متخزّن كنص (مشفّر)', !JSON.stringify(FS.list('shares')).includes(sh.token));
const track = async (t, e = eC) => { const res = await onRequest({ request: new Request('https://x.test/api/track', { method: 'POST', headers: { 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify({ t }) }), env: e, params: { route: ['track'] } }); return { ...(await res.json()), status: res.status, cc: res.headers.get('Cache-Control') }; };
const tr = await track(sh.token);
check('المتابعة شغّالة من غير تسجيل دخول', tr.status === 200 && tr.status !== undefined && tr.cc === 'no-store');
check('المتابعة: حالة + اسم أول + نوع عربية فقط', tr.driver === 'محمد' && tr.vehicleType === 'pickup' && tr.status === 200);
check('المتابعة: مفيش تليفون/سعر/عنوان استلام/هوية', !/phone|price|pickup|national|customer|amount|id/i.test(Object.keys(tr).filter((k) => !['status', 'final', 'driver', 'vehicleType', 'location', 'dropoff', 'updatedAt', 'cc'].includes(k)).join(',') + ''));
check('الموقع تقريبي (مضاعفات 0.005)', tr.location && Math.abs(tr.location.lat / 0.005 - Math.round(tr.location.lat / 0.005)) < 1e-6);
check('رمز غلط → 404', (await track('A'.repeat(32))).status === 404 && (await track('short')).status === 404);
FS.patch(`shares/${FS.list('shares')[0]._id}`, { expires_at: Date.now() - 1000 });
check('رمز منتهي → 404', (await track(sh.token)).status === 404);
const sh2 = await ok('رابط جديد', call('cF', 'orders/share', { orderId: D }, eC));
check('رابط جديد شغّال', (await track(sh2.token)).status === 200);
await ok('العميل يوقف الروابط', call('cF', 'orders/unshare', { orderId: D }, eC));
check('بعد الإيقاف → 404', (await track(sh2.token)).status === 404);
const sh3 = await ok('رابط تاني', call('cF', 'orders/share', { orderId: D }, eC));
FS.patch(`orders/${D}`, { status: 'completed' });
const fin = await track(sh3.token); check('طلب منتهي → final بدون بيانات سواق ولا موقع', fin.final === true && !fin.driver && !fin.location);
let last; for (let i = 0; i < 32; i++) last = await track('B'.repeat(32), eC);
check('حد المحاولات بالـIP (429)', last.status === 429);

// ---- الميزة مقفولة = السلوك القديم ----
FS.list('rl').forEach((d) => FS.del(`rl/${d._id}`));
await ok('أدمن يقفل الكود والتحرير التلقائي', call('admin1', 'admin/settings/save', { ...cur, deliveryCode: false, autoReleaseHours: 0 }, eC));
const E = await inTransit();
check('الكود غير فعّال', (await call('cF', 'orders/code', { orderId: E }, eC)).active === false);
await ok('تسليم من غير كود لما الميزة مقفولة', deliver(E, await photoB()));
ageDelivery(E, 500); await call('cF', 'sync', {}, eC);
check('التحرير التلقائي مقفول: الطلب فاضل مسلَّم', orderRow(E).status === 'delivered');
console.log('\n✅ اختبارات الميزات (كود التسليم/التحرير التلقائي/المتابعة/الخصوصية) نجحت');
