// اختبار الصمود: منع تكرار الطلب (ضغطة مرتين/إعادة محاولة/طلبين متزامنين)، تجاهل حضور السواق الأقدم، وتوفير كتابات الموقع للسواق الواقف — Firestore وهمي. تشغيل: npm test
import assert from 'node:assert/strict';
import { webcrypto as crypto } from 'node:crypto';
import { onRequest } from '../functions/api/[[route]].js';
import { JWKS_URL } from '../functions/_lib/core.js';
import { trustOf } from '../functions/_lib/trust.js';
import { makeFirestore } from './fake-firestore.mjs';
import { DEFAULTS as __ESC } from '../functions/_lib/logic.js'; __ESC.dcEnabled = false; for (const k of Object.keys(__ESC.vehiclePricing)) __ESC.vehiclePricing[k] = { base: 0, perKm: 0, minPrice: 0, kmFee: 0 }; // الاختبارات دي بتفترض المعادلة العامة (التسعير لكل نوع تقديري جديد وليه اختبار خاص) // هذا الملف بيختبر نظام الضمان القديم، فبنختاره صراحةً (الافتراضي الجديد = الدفع المباشر)
import { DEFAULTS as __D } from '../functions/_lib/logic.js'; __D.samePickupMax = 0; // اختبارات قديمة بتفتح طلبات كتير من نفس النقطة؛ حد «نفس نقطة الاستلام» متختبر في dc.test.mjs

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

const ordersOf = (uid) => FS.list('orders').filter((o) => o.customer_id === uid);
const mkOrder = async (uid, extra = {}) => { clearRl(); return call(uid, 'orders/create', { pickup: CAIRO, dropoff: GIZA, category: 'goods', size: 'small', weightKg: 100, description: 'كراتين أدوات منزلية 4 قطع', scheduledAt: new Date(Date.now() + 3600e3).toISOString(), photos: [await up(uid, 'cargo')], ...extra }, eS); };

// ===== 1) منع تكرار الطلب =====
cancelAll('cF', ALIVE);
const K1 = 'k1'.padEnd(32, 'a'), before = ordersOf('cF').length;
const a1 = await ok('طلب بمفتاح', mkOrder('cF', { key: K1 })); check('أول طلب مش مكرر', !a1.duplicate);
const a2 = await ok('نفس الطلب بنفس المفتاح (إعادة محاولة)', mkOrder('cF', { key: K1 }));
check('نفس معرّف الطلب + علامة duplicate', a2.id === a1.id && a2.duplicate === true);
check('نفس السعر والمبلغ المطلوب', a2.price === a1.price && a2.amountDue === a1.amountDue && a2.prepay === a1.prepay);
check('طلب واحد بس اتعمل فعلاً (n=1)', ordersOf('cF').length === before + 1 && FS.list('orders').filter((o) => o.id === a1.id).length === 1);

const b1 = await ok('عميل تاني بنفس المفتاح', mkOrder('stranger', { key: K1 })); check('معرّف مختلف (المفتاح مربوط بالحساب)', b1.id !== a1.id && !b1.duplicate);

cancelAll('cF', ALIVE);
const K2 = 'k2'.padEnd(32, 'b'); clearRl();
const photo = await up('cF', 'cargo'); const same = { key: K2, pickup: CAIRO, dropoff: GIZA, category: 'goods', size: 'small', weightKg: 100, description: 'كراتين أدوات منزلية 4 قطع', scheduledAt: new Date(Date.now() + 3600e3).toISOString(), photos: [photo] };
const [p1, p2] = await Promise.all([call('cF', 'orders/create', same, eS), call('cF', 'orders/create', same, eS)]);
check('طلبين متزامنين بنفس المفتاح: الاتنين 200 ونفس المعرّف', p1.status === 200 && p2.status === 200 && p1.id === p2.id);
check('وطلب واحد بس في القاعدة (n=1)', FS.list('orders').filter((o) => o.id === p1.id).length === 1 && ordersOf('cF').filter((o) => o.id === p1.id).length === 1);

cancelAll('cF', ALIVE);
const n0 = ordersOf('cF').length; const x1 = await ok('من غير مفتاح #1', mkOrder('cF')); const x2 = await ok('من غير مفتاح #2', mkOrder('cF'));
check('من غير مفتاح: طلبين مختلفين (نفس السلوك القديم)', x1.id !== x2.id && ordersOf('cF').length === n0 + 2);
const y1 = await ok('مفتاح قصير مرفوض كمفتاح', mkOrder('cF', { key: 'short' })), y2 = await ok('مفتاح قصير تاني', mkOrder('cF', { key: 'short' }));
check('المفتاح القصير بيتتجاهل (طلبين مختلفين)', y1.id !== y2.id);

// ===== 2) حضور السواق: الرسالة الأقدم ما تمسحش الأحدث =====
const pr = (online, ts) => call('dF', 'driver/presence', { online, ...(ts ? { ts } : {}), lat: CAIRO.lat, lng: CAIRO.lng }, eS);
await ok('متاح (ts=2000)', pr(true, 2000)); check('اتسجّل متاح', FS.get('driver_presence/dF').online === true);
const st = await ok('رسالة أقدم (ts=1000) وصلت متأخرة', pr(false, 1000)); check('اتجاهلت (stale) والحالة لسه متاح', st.stale === true && st.online === true && FS.get('driver_presence/dF').online === true);
await ok('رسالة أحدث (ts=3000)', pr(false, 3000)); check('اتطبّقت: غير متاح', FS.get('driver_presence/dF').online === false);
await ok('من غير ts زي الأول', pr(true)); check('شغّال من غير ts (توافق مع النسخ القديمة)', FS.get('driver_presence/dF').online === true);

// ===== 3) موقع السواق: واقف مكانه = مفيش كتابة جديدة =====
cancelAll('cF', ALIVE);
const L = (await ok('طلب للتتبع', mkOrder('cF'))).id;
await ok('سواق يقبل', call('dF', 'orders/accept', { orderId: L }, eS)); FS.patch(`orders/${L}`, { status: 'paid', escrow_status: 'held' });
await ok('في الطريق', call('dF', 'orders/status', { orderId: L, next: 'heading_pickup' }, eS));
const loc = (p) => call('dF', 'orders/location', { orderId: L, lat: p.lat, lng: p.lng, acc: 10 }, eS);
const l1 = await ok('أول موقع', loc(CAIRO)); check('اتكتب', !l1.skipped && !!FS.get(`live_locations/${L}`)); const at1 = FS.get(`live_locations/${L}`).at;
const l2 = await ok('نفس الموقع بعد ثواني', loc(CAIRO)); check('اتخطّى الكتابة (واقف مكانه)', l2.skipped === true && FS.get(`live_locations/${L}`).at === at1);
const l3 = await ok('اتحرّك أكتر من 100م', loc(GIZA)); check('اتكتب تاني', !l3.skipped && FS.get(`live_locations/${L}`).at >= at1 && FS.get(`live_locations/${L}`).lat === GIZA.lat);
FS.patch(`live_locations/${L}`, { at: Date.now() - 50000 });
const l4 = await ok('واقف بس عدّى 45 ثانية', loc(GIZA)); check('بيكتب تحديث «آخر ظهور»', !l4.skipped);
const cv = await ok('العميل يشوف الموقع في تفاصيل الطلب', call('cF', 'orders/get', { orderId: L }, eS)); check('الموقع بيوصل للعميل مع الطلب (طلب واحد)', cv.location?.lat === GIZA.lat);
const av = await ok('الأدمن يشوف الموقع', call('admin1', 'orders/get', { orderId: L }, eS)); check('الموقع بيوصل للأدمن', av.location?.lat === GIZA.lat);
await bad('غير السواق ما يبعتش موقع', call('stranger', 'orders/location', { orderId: L, lat: 30, lng: 31 }, eS), 403);

console.log(`\n✅ اختبارات الصمود نجحت (${pass} فحص)`);
