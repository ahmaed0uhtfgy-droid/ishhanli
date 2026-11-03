// اختبار تحرير الفلوس المحجوزة بقرار أدمن (admin/release): الحالات المسموحة، السبب الإجباري، الصلاحيات، منع الصرف المزدوج، ومطابقة العمولة لتأكيد العميل — Firestore وهمي.
import assert from 'node:assert/strict';
import { webcrypto as crypto } from 'node:crypto';
import { onRequest } from '../functions/api/[[route]].js';
import { JWKS_URL } from '../functions/_lib/core.js';
import { trustOf } from '../functions/_lib/trust.js';
import { makeFirestore } from './fake-firestore.mjs';
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

const audits = () => FS.list('audit').filter((a) => a.action === 'order.release');
const delivered = async (dv, extra) => { const oid = await flow(dv); await ok('تسليم', deliver(oid, extra)); check('اتسلّم والفلوس محجوزة', orderRow(oid).status === 'delivered' && orderRow(oid).escrow_status === 'held'); return oid; };

// ===== 1) الحالة العادية =====
const A = await delivered(100);
{ const w0 = wallet('dF')?.balance ?? 0;
  const r = await ok('أدمن يحرر بسبب', call('admin1', 'admin/release', { orderId: A, note: 'العميل استلم وأكد بالتليفون ونسي يضغط تأكيد' }, eS));
  const o = orderRow(A);
  check('الطلب اتقفل والفلوس اتحررت', o.status === 'completed' && o.escrow_status === 'released');
  check('المحفظة زادت بالصافي بالظبط', (wallet('dF')?.balance ?? 0) - w0 === r.net && r.net > 0);
  check('العمولة + الصافي = سعر الطلب', r.net + r.commission === o.price);
  check('اتسجّل في سجل الأدمن بالسبب', audits().some((a) => a.target_id === A && a.admin_uid === 'admin1' && /نسي يضغط/.test(a.note)));
  check('سجل الطلب فيه إن الأدمن هو اللي حرر', JSON.stringify(o).includes('admin_release'));
  const w1 = wallet('dF')?.balance;
  await bad('تحرير تاني على نفس الطلب = bad_state', call('admin1', 'admin/release', { orderId: A, note: 'محاولة تانية للتحرير' }, eS), 409, 'bad_state');
  await bad('العميل يأكد بعد التحرير = bad_state', call('cF', 'orders/confirm', { orderId: A }, eS), 409, 'bad_state');
  check('مفيش صرف مزدوج', (wallet('dF')?.balance ?? 0) === w1); }

// ===== 2) السبب والصلاحيات =====
const B = await delivered(100);
await bad('من غير سبب', call('admin1', 'admin/release', { orderId: B }, eS), 400, 'bad_input');
await bad('سبب قصير', call('admin1', 'admin/release', { orderId: B, note: 'ok' }, eS), 400, 'bad_input');
await bad('العميل مايحررش', call('cF', 'admin/release', { orderId: B, note: 'عايز الفلوس تتحرر' }, eS), 403, 'forbidden');
await bad('السواق مايحررش لنفسه', call('dF', 'admin/release', { orderId: B, note: 'حرروا فلوسي بسرعة' }, eS), 403, 'forbidden');
await bad('رقم طلب غلط', call('admin1', 'admin/release', { orderId: 'nope', note: 'سبب كافي للتحرير' }, eS), 400);
check('الطلب لسه محجوز بعد المحاولات المرفوضة', orderRow(B).status === 'delivered' && orderRow(B).escrow_status === 'held');

// ===== 3) حالات مش مسموحة =====
{ const st = await flow(100); // لسه في الطريق
  await bad('طلب مش اتسلّم لسه', call('admin1', 'admin/release', { orderId: st, note: 'سبب كافي للتحرير' }, eS), 409, 'bad_state');
  FS.patch(`orders/${st}`, { status: 'disputed' });
  await bad('طلب متنازع عليه (بيتحل من النزاعات)', call('admin1', 'admin/release', { orderId: st, note: 'سبب كافي للتحرير' }, eS), 409, 'bad_state');
  const op = await ok('طلب مفتوح', make(100)); await bad('طلب لسه مفتوح', call('admin1', 'admin/release', { orderId: op.id, note: 'سبب كافي للتحرير' }, eS), 409, 'bad_state'); }

// ===== 4) العميل أكد الأول =====
{ const c = await delivered(100);
  await ok('العميل يأكد', call('cF', 'orders/confirm', { orderId: c }, eS));
  await bad('الأدمن بعد تأكيد العميل = bad_state', call('admin1', 'admin/release', { orderId: c, note: 'سبب كافي للتحرير' }, eS), 409, 'bad_state'); }

// ===== 5) نفس العمولة بتاعة تأكيد العميل =====
{ const x = await delivered(100), y = await delivered(100);
  FS.patch(`orders/${x}`, { price: 500, amount_due: 500 }); FS.patch(`orders/${y}`, { price: 500, amount_due: 500 });
  const w0 = wallet('dF')?.balance ?? 0;
  await ok('العميل يأكد y', call('cF', 'orders/confirm', { orderId: y }, eS));
  const dY = (wallet('dF')?.balance ?? 0) - w0, w1 = wallet('dF')?.balance ?? 0;
  await ok('الأدمن يحرر x', call('admin1', 'admin/release', { orderId: x, note: 'نفس الحالة بالظبط للمقارنة' }, eS));
  const dX = (wallet('dF')?.balance ?? 0) - w1;
  check('الصافي واحد في الحالتين', dX === dY && dX > 0);
  check('العمولة واحدة في الحالتين', orderRow(x).commission === orderRow(y).commission); }

// ===== 6) شحنة عالية القيمة اتسلّمت من غير كود =====
await ok('الأدمن يفعّل الحراسة', call('admin1', 'admin/settings/save', { ...cur, valueGuardOn: true, valueGuardFrom: 5000 }, eS));
{ const h = await delivered(30000, { noCode: true, noCodeReason: 'customer_unreachable' });
  check('اتعلّمت عالية ومن غير كود', dataOf(h).guard === 'high' && dataOf(h).deliveredWithoutCode === true);
  const w0 = wallet('dF')?.balance ?? 0;
  await ok('الأدمن يحرر العالية بقرار بشري', call('admin1', 'admin/release', { orderId: h, note: 'راجعت المسار والصور والعميل أكد شفهي' }, eS));
  check('اتحررت وفلوس السواق زادت', orderRow(h).escrow_status === 'released' && (wallet('dF')?.balance ?? 0) > w0);
  check('سجل الأدمن فيه إنها عالية ومن غير كود', audits().some((a) => a.target_id === h && /"guard":"high"/.test(a.meta || '') && /"deliveredWithoutCode":true/.test(a.meta || ''))); }

console.log(`\n✅ اختبارات تحرير الأدمن للفلوس المحجوزة نجحت (${pass} فحص)`);
