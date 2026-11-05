// اختبار نظام الدفع المباشر + عمولة المنصة (dc): العميل بيدفع للسواق، مكسب السواق بيتسجّل في دفتر، والحد من الأدمن بيوقّف قبول الطلبات لحد السداد (محفظة/إنستا باي + صورة + تأكيد الأدمن) — Firestore وهمي.
import assert from 'node:assert/strict';
import { webcrypto as crypto } from 'node:crypto';
import { onRequest } from '../functions/api/[[route]].js';
import { JWKS_URL } from '../functions/_lib/core.js';
import { trustOf } from '../functions/_lib/trust.js';
import { dcDue, dcBlocked, dcPayable, fineCredit, calcPrice, kmFeeOf, dcFeesOn, vehicleOfSize, DEFAULTS as __D } from '../functions/_lib/logic.js'; __D.samePickupMax = 0; // حد «نفس النقطة» بيتختبر بالإعدادات في قسم الغرامات
import { makeFirestore } from './fake-firestore.mjs';
import { DEFAULTS as __ESC } from '../functions/_lib/logic.js'; __ESC.dcEnabled = false; for (const k of Object.keys(__ESC.vehiclePricing)) __ESC.vehiclePricing[k] = { base: 0, perKm: 0, minPrice: 0, kmFee: 0 }; // الاختبارات دي بتفترض المعادلة العامة (التسعير لكل نوع تقديري جديد وليه اختبار خاص) // هذا الملف بيختبر تفعيل الدفع المباشر من الأدمن (من حالة مقفول)؛ الافتراضي الفعلي متغطّي في default.test.mjs

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


// ===== 8) تعويض السواق وغرامة العميل =====
const sf = (p) => save({ dcEnabled: true, dcPct: 2, dcLimit: 1000, finesEnabled: true, ...p });
const claim = (oid) => FS.get(`fines/${oid}`);
const clearFines = () => { FS.list('fines').forEach((d) => FS.del(`fines/${d._id}`)); for (const u of ['drvFF', 'drvXX', 'drvYY']) FS.patch(`users/${u}`, { dc_gross: 0, dc_credit: 0, dc_fines_held: 0, dc_km: 0, dc_kmfee: 0, km_total: 0 }); FS.patch('users/cF', { fine_due: 0, cancel_count: 0 }); };
const back = (oid, extra) => patchData(oid, extra);
// طلب مباشر: السواق يقبل ويوصل ويستنى المهلة ويبلّغ «العميل مش موجود» => مطالبة مفتوحة
const noShow = async (drv, price = 100) => {
  FS.patch('users/cF', { cancel_count: 0 }); const id = (await mk()).id; setPrice(id, price);
  await ok('سواق يقبل', call(drv, 'orders/accept', { orderId: id }, eS));
  await ok('وصلت', call(drv, 'orders/arrived', { orderId: id, loc: CAIRO }, eS));
  back(id, { arrivedAt: Date.now() - 11 * 60000 });
  await ok('العميل مش موجود', call(drv, 'orders/noshow', { orderId: id }, eS));
  return id; };
{ // حسابات نقية
  check('تعويض المنصة 50% من 30 = 15 (أقل من الغرامة)', fineCredit(30, 50) === 15 && fineCredit(15, 50) === 7);
  check('التعويض دايماً أقل من الغرامة حتى بنسبة 99%', fineCredit(30, 99) === 29 && fineCredit(1, 99) === 0 && fineCredit(30, 100) === 29);
  check('صفر لو مدخلات غلط', fineCredit(-5, 50) === 0 && fineCredit('x', 'y') === 0 && fineCredit(30, 0) === 0);
  check('المطلوب = العمولة − التعويض', dcPayable(1400, 2, 0, 0).amount === 28 && dcPayable(1400, 2, 10, 0).amount === 18);
  check('التعويض بيغطي العمولة بس (مش أكتر)', dcPayable(1400, 2, 50, 0).amount === 0 && dcPayable(1400, 2, 50, 0).creditUsed === 28);
  check('الغرامات المحصّلة بتتضاف فوق', dcPayable(1400, 2, 10, 30).amount === 48 && dcPayable(0, 2, 0, 30).amount === 30); }
clearFines();
check('افتراضيات الغرامات مقفولة وقيم معقولة', cur.finesEnabled === false && cur.fineFreeCancelMin === 2 && cur.fineWaitMin === 10 && cur.fineEnRouteAmount === 15 && cur.fineArrivedAmount === 30 && cur.fineClaimHours === 12 && cur.fineObjectHours === 24 && cur.fineDriverSharePct === 50 && cur.fineMonthlyCap === 100 && cur.samePickupMeters === 300); // samePickupMax الافتراضي 1 لكن الملف ده بيصفّره فوق
await bad('تعويض 100%', sf({ fineDriverSharePct: 100 }), 400, 'bad_input');
await bad('نسبة محصّل فوق 50', sf({ fineCollectorPct: 51 }), 400, 'bad_input');
await bad('نطاق نقطة غلط', sf({ samePickupMeters: 5001 }), 400, 'bad_input');
await bad('عميل مايغيّرش', call('cF', 'admin/settings/save', { ...cur, finesEnabled: true }, eS), 403, 'forbidden');
{ // الميزة مقفولة: مفيش وصول ولا غرامة
  await ok('الدفع المباشر شغّال والغرامات مقفولة', save({ dcEnabled: true, dcPct: 2, dcLimit: 1000, finesEnabled: false }));
  const id = (await mk()).id; await ok('سواق يقبل', call('drvFF', 'orders/accept', { orderId: id }, eS));
  await bad('مقفولة: وصلت ممنوع', call('drvFF', 'orders/arrived', { orderId: id, loc: CAIRO }, eS), 409, 'fines_off');
  await ok('في الطريق', call('drvFF', 'orders/status', { orderId: id, next: 'heading_pickup' }, eS)); back(id, { acceptedAt: Date.now() - 10 * 60000 });
  await ok('العميل يلغي (مقفولة = من غير غرامة)', call('cF', 'orders/cancel', { orderId: id }, eS));
  check('مفيش مطالبة', !claim(id)); }
await ok('الأدمن يفعّل الغرامات', sf({}));

// -- وصول السواق (إثبات الموقع) --
FS.patch('users/cF', { cancel_count: 0 });
{ const id = (await mk()).id; setPrice(id, 100);
  await bad('سواق ماقبلش الطلب', call('drvXX', 'orders/arrived', { orderId: id, loc: CAIRO }, eS), 403, 'forbidden');
  await ok('سواق يقبل', call('drvFF', 'orders/accept', { orderId: id }, eS));
  await bad('وصلت من غير موقع', call('drvFF', 'orders/arrived', { orderId: id }, eS), 400);
  await bad('وصلت وهو بعيد', call('drvFF', 'orders/arrived', { orderId: id, loc: FAR }, eS), 403, 'too_far');
  await bad('عدم حضور قبل الوصول', call('drvFF', 'orders/noshow', { orderId: id }, eS), 409, 'not_arrived');
  fcm.length = 0;
  await ok('وصلت (جوه نطاق نقطة الاستلام)', call('drvFF', 'orders/arrived', { orderId: id, loc: CAIRO }, eS));
  check('اتسجّل وقت ومكان الوصول', typeof dataOf(id).arrivedAt === 'number' && dataOf(id).arrivedLoc.lat === CAIRO.lat);
  const t1 = dataOf(id).arrivedAt; await ok('وصلت تاني (نفس الوقت)', call('drvFF', 'orders/arrived', { orderId: id, loc: CAIRO }, eS)); check('الوقت ما اتغيّرش', dataOf(id).arrivedAt === t1);
  await bad('لسه في مهلة الانتظار', call('drvFF', 'orders/noshow', { orderId: id }, eS), 409, 'wait_more');
  await bad('عميل مايبلّغش عدم حضور', call('cF', 'orders/noshow', { orderId: id }, eS), 403, 'forbidden');
  back(id, { arrivedAt: Date.now() - 11 * 60000 });
  const r = await ok('العميل مش موجود (بعد 11 دقيقة)', call('drvFF', 'orders/noshow', { orderId: id }, eS));
  check('الطلب اتلغى بسبب العميل وفيه مطالبة مفتوحة 30 جنيه والتعويض 15', orderRow(id).status === 'cancelled' && dataOf(id).noShow === true && r.amount === 30 && r.credit === 15 && claim(id).status === 'open' && claim(id).amount === 30 && claim(id).remaining === 0);
  check('إنذار للعميل (عدّاد الإلغاء)', U('cF').cancel_count === 1);
  check('لسه مفيش غرامة ولا تعويض (في مهلة التسوية)', !U('cF').fine_due && !U('drvFF').dc_credit);
  await bad('مطالبة تانية على نفس الطلب', call('drvFF', 'orders/noshow', { orderId: id }, eS), 409); }

// -- التسوية المباشرة: العميل عوّض السواق --
clearFines();
{ const id = await noShow('drvFF');
  await bad('عميل تاني مايسجّلش', call('drvXX', 'fines/declare', { orderId: id }, eS), 403, 'forbidden');
  await ok('العميل يسجّل إنه عوّض السواق', call('cF', 'fines/declare', { orderId: id }, eS));
  check('بتستنى تأكيد السواق', claim(id).status === 'customer_paid');
  await bad('العميل مايأكدش لنفسه', call('cF', 'fines/collected', { orderId: id }, eS), 403, 'forbidden');
  await ok('السواق يأكّد إنه استلم التعويض', call('drvFF', 'fines/collected', { orderId: id }, eS));
  check('اتقفلت من غير غرامة ولا تعويض', claim(id).status === 'settled' && !U('cF').fine_due && !U('drvFF').dc_credit);
  await bad('مايتقفلش مرتين', call('drvFF', 'fines/collected', { orderId: id }, eS), 409, 'bad_state'); }
{ const id = await noShow('drvFF');
  await ok('السواق يسجّل «اتحصّل» (كاش)', call('drvFF', 'fines/collected', { orderId: id }, eS));
  check('مقفولة من غير غرامة', claim(id).status === 'settled' && !U('cF').fine_due); }

// -- التطبيق: المنصة تتنازل عن جزء من العمولة والعميل ياخد غرامة --
clearFines();
{ const id = await noShow('drvFF'); fcm.length = 0;
  await bad('عميل مايطبّقش', call('cF', 'fines/apply', { orderId: id }, eS), 403, 'forbidden');
  const r = await ok('السواق: ماتحصّلش — طبّق دلوقتي', call('drvFF', 'fines/apply', { orderId: id }, eS));
  check('تعويض 15 للسواق وغرامة 30 على العميل', r.credit === 15 && U('drvFF').dc_credit === 15 && U('cF').fine_due === 30 && claim(id).status === 'applied' && claim(id).remaining === 30 && claim(id).credit === 15);
  check('التعويض أقل من الغرامة', claim(id).credit < claim(id).amount);
  await bad('مايتطبّقش مرتين', call('drvFF', 'fines/apply', { orderId: id }, eS), 409, 'bad_state');
  const m = await ok('العميل يشوف غراماته', call('cF', 'fines/mine', {}, eS)); check('فيها الغرامة والمطالبة', m.due === 30 && m.claims.length === 1 && m.claims[0].remaining === 30 && m.role === 'customer');
  const d = await ok('السواق يشوف تعويضاته', call('drvFF', 'fines/mine', {}, eS)); check('فيها رصيد التعويض', d.credit === 15 && d.claims.length === 1 && d.role === 'driver' && d.sharePct === 50);
  // اعتراض العميل
  await bad('اعتراض بسبب قصير', call('cF', 'fines/object', { orderId: id, note: 'x' }, eS), 400);
  await bad('سواق مايعترضش', call('drvFF', 'fines/object', { orderId: id, note: 'اعتراض' }, eS), 403, 'forbidden');
  await ok('العميل يعترض', call('cF', 'fines/object', { orderId: id, note: 'كنت في المكان وماحدش اتصل' }, eS));
  await bad('اعتراض تاني', call('cF', 'fines/object', { orderId: id, note: 'تاني' }, eS), 409, 'already_objected');
  const L = await ok('الأدمن يشوف الاعتراضات', call('admin1', 'admin/fines/list', {}, eS)); check('الاعتراض ظاهر مع بيانات العميل', L.objected.some((x) => x.id === id && x.objectNote.includes('المكان')) && L.customers.some((x) => x.id === 'cF' && x.due === 30));
  await bad('عميل مايشوفش لوحة الأدمن', call('cF', 'admin/fines/list', {}, eS), 403, 'forbidden');
  await bad('قرار غلط', call('admin1', 'admin/fines/decide', { id, action: 'x' }, eS), 400, 'bad_action');
  await bad('رفض من غير سبب', call('admin1', 'admin/fines/decide', { id, action: 'reject' }, eS), 400);
  await ok('الأدمن يقبل الاعتراض (الادعاء مش صحيح)', call('admin1', 'admin/fines/decide', { id, action: 'reject', note: 'السواق مكنش في المكان' }, eS));
  check('اتشالت الغرامة والتعويض واتسجّل إنذار للسواق', U('cF').fine_due === 0 && U('drvFF').dc_credit === 0 && U('drvFF').false_claims === 1 && claim(id).status === 'rejected');
  await bad('قرار تاني على نفس المطالبة', call('admin1', 'admin/fines/decide', { id, action: 'waive' }, eS), 409, 'bad_state');
  check('سجل التدقيق', FS.list('audit').some((x) => x.action === 'fine.reject')); }
{ const id = await noShow('drvFF'); await ok('تطبيق', call('drvFF', 'fines/apply', { orderId: id }, eS));
  await ok('الأدمن يعفي العميل (المنصة بتتحمّل)', call('admin1', 'admin/fines/decide', { id, action: 'waive', note: 'عميل قديم' }, eS));
  check('العميل اتعفى والسواق احتفظ بتعويضه', U('cF').fine_due === 0 && U('drvFF').dc_credit === 15 && claim(id).status === 'waived'); }
{ const id = await noShow('drvXX'); await ok('تطبيق', call('drvXX', 'fines/apply', { orderId: id }, eS));
  await ok('العميل سدّد للمنصة مباشرة', call('admin1', 'admin/fines/decide', { id, action: 'settle', note: 'تحويل إنستا باي' }, eS));
  check('اتسوّت', U('cF').fine_due === 0 && claim(id).status === 'paid_platform'); }
mkU('custLong1', 'customer', { name: 'عميل طويل' }); // مُعرّف أطول من 5 حروف (uidOf بيرفض القصير)
await bad('تصحيح من غير سبب', call('admin1', 'admin/fines/adjust', { uid: 'custLong1', due: 10 }, eS), 400);
await bad('تصحيح على سواق', call('admin1', 'admin/fines/adjust', { uid: 'drvFF', due: 10, note: 'تجربة' }, eS), 404, 'not_found');
await ok('الأدمن يصحّح غرامة', call('admin1', 'admin/fines/adjust', { uid: 'custLong1', due: 10, note: 'تصحيح' }, eS)); check('اتصحّحت', U('custLong1').fine_due === 10);
await ok('وتتصفّر', call('admin1', 'admin/fines/adjust', { uid: 'custLong1', due: 0, note: 'تصحيح' }, eS)); check('اتصفّرت وفي سجل التدقيق', U('custLong1').fine_due === 0 && FS.list('audit').some((x) => x.action === 'fine.adjust'));

// -- التطبيق التلقائي بعد المهلة (فحص دوري) --
clearFines();
{ const a = await noShow('drvFF'), b = await noShow('drvXX');
  await ok('العميل يسجّل التعويض على الأولى', call('cF', 'fines/declare', { orderId: a }, eS));
  await ok('فحص دوري والمهلة لسه', call('drvYY', 'orders/list', { scope: 'mine' }, eS));
  check('لسه مفتوحتين', claim(a).status === 'customer_paid' && claim(b).status === 'open' && !U('cF').fine_due);
  FS.patch(`fines/${a}`, { apply_at: Date.now() - 1000 }); FS.patch(`fines/${b}`, { apply_at: Date.now() - 1000 });
  await ok('فحص دوري بعد المهلة', call('drvYY', 'orders/list', { scope: 'mine' }, eS));
  check('اتطبّقتا تلقائي (السواق ماأكدش تأكيد العميل)', claim(a).status === 'applied' && claim(b).status === 'applied' && U('cF').fine_due === 60 && U('drvFF').dc_credit === 15 && U('drvXX').dc_credit === 15); }

// -- تحصيل الغرامة مع الطلب الجاي + تحويلها للمنصة --
{ const pre = U('drvYY');
  await bad('عميل عليه غرامة وفيه طلب شغّال تاني', (async () => { await mk(); return make(100, eS, {}, false); })(), 409, 'fine_one_order');
  const id = (await mk()).id; setPrice(id, 900);
  check('الغرامة 60 ظاهرة في الطلب للسواق', dataOf(id).fineDue === 60);
  await ok('السواق يقبل', call('drvYY', 'orders/accept', { orderId: id }, eS));
  FS.patch('users/drvYY', { dc_gross: 0, dc_credit: 0, dc_fines_held: 0 });
  await drive('drvYY', id); await ok('تسليم', finish('drvYY', id));
  check('اتحصّلت 60 من العميل وبقت على السواق للمنصة', U('cF').fine_due === 0 && U('drvYY').dc_fines_held === 60 && dataOf(id).fineCollected === 60 && orderRow(id).status === 'completed');
  check('المطالبات اتقفلت وفيها مين حصّلها', ['collected'].every((x) => FS.list('fines').filter((f) => f.customer_id === 'cF').every((f) => f.status === x && f.remaining === 0 && JSON.parse(f.collected_by || '[]')[0]?.driver_id === 'drvYY')));
  check('مكسب الطلب (900) اتسجّل من غير الغرامة', U('drvYY').dc_gross === 900 && ledger('drvYY', id)?.gross === 900);
  const sm = await ok('ملخص السواق', call('drvYY', 'dc/summary', {}, eS));
  check('المطلوب = عمولة 18 + غرامات 60', sm.commission === 18 && sm.finesHeld === 60 && sm.due === 78 && sm.creditUsed === 0);
  // رصيد تعويض: 10 يتخصم من العمولة
  FS.patch('users/drvYY', { dc_credit: 10 }); const sm2 = await call('drvYY', 'dc/summary', {}, eS);
  check('المطلوب = 18 − 10 + 60 = 68', sm2.due === 68 && sm2.credit === 10 && sm2.creditUsed === 10);
  const pr = await up('drvYY', 'payment');
  const py = await ok('السواق يحوّل المطلوب', call('drvYY', 'dc/pay', { method: 'wallet', proofRef: pr, reference: 'FINE-0001' }, eS));
  check('المبلغ 68', py.amount === 68 && FS.get(`dc_pay/${py.id}`).credit_used === 10 && FS.get(`dc_pay/${py.id}`).fines_held === 60);
  FS.patch('users/drvYY', { dc_fines_held: 70 }); // غرامة اتحصّلت بعد طلب السداد
  await ok('الأدمن يأكّد', call('admin1', 'admin/dc/confirm', { id: py.id, action: 'confirm' }, eS));
  check('اتخصم اللي اتحسب بس', U('drvYY').dc_gross === 0 && U('drvYY').dc_credit === 0 && U('drvYY').dc_fines_held === 10 && U('drvYY').dc_paid_total >= 68); }

// -- عمولة اتغطّت برصيد التعويض بالكامل: تتسوّى من غير تحويل --
{ FS.patch('users/drvXX', { dc_gross: 600, dc_credit: 20, dc_fines_held: 0 });
  const pbefore = await call('drvXX', 'dc/summary', {}, eS); check('العمولة 12 والتعويض 20 = المطلوب صفر', pbefore.commission === 12 && pbefore.due === 0);
  const cv = await ok('سواق يسوّي بالتعويض من غير إثبات', call('drvXX', 'dc/pay', { method: 'wallet' }, eS));
  check('اتسوّت فوراً والباقي من التعويض 8', cv.covered === true && U('drvXX').dc_gross === 0 && U('drvXX').dc_credit === 8 && FS.list('dc_pay').some((x) => x.driver_id === 'drvXX' && x.method === 'credit' && x.status === 'paid'));
  await bad('ماعليهوش حاجة بعدها', call('drvXX', 'dc/pay', { method: 'wallet' }, eS), 409, 'nothing_due'); }

// -- نسبة المحصِّل (السواق يحتفظ بجزء من الغرامة) --
clearFines();
{ await ok('الأدمن يخلّي المحصّل ياخد 10%', sf({ fineCollectorPct: 10 }));
  const a = await noShow('drvFF'); await ok('تطبيق', call('drvFF', 'fines/apply', { orderId: a }, eS));
  const id = (await mk()).id; setPrice(id, 200); await ok('سواق يقبل', call('drvXX', 'orders/accept', { orderId: id }, eS)); await drive('drvXX', id); await ok('تسليم', finish('drvXX', id));
  check('المحصّل احتفظ بـ3 وعليه 27 للمنصة', dataOf(id).fineCollected === 30 && dataOf(id).fineKept === 3 && U('drvXX').dc_fines_held === 27); }

// -- مراحل إلغاء العميل بعد القبول --
clearFines(); await ok('نرجّع النسبة', sf({}));
{ const stage = async (setup) => { FS.patch('users/cF', { cancel_count: 0 }); const id = (await mk()).id; await ok('سواق يقبل', call('drvFF', 'orders/accept', { orderId: id }, eS)); await setup(id); return id; };
  let id = await stage(async () => {}); const r0 = await ok('إلغاء مباشرة بعد القبول', call('cF', 'orders/cancel', { orderId: id }, eS));
  check('إلغاء مجاني (جوه فترة الإلغاء المجاني)', r0.fine === undefined && !claim(id));
  id = await stage(async (x) => { back(x, { acceptedAt: Date.now() - 5 * 60000 }); });
  const r1 = await ok('إلغاء بعد المهلة والسواق لسه ماتحرّكش', call('cF', 'orders/cancel', { orderId: id }, eS));
  check('من غير غرامة (السواق لسه ماطلعش)', r1.fine === undefined && !claim(id));
  id = await stage(async (x) => { await ok('في الطريق', call('drvFF', 'orders/status', { orderId: x, next: 'heading_pickup' }, eS)); back(x, { acceptedAt: Date.now() - 5 * 60000 }); fcm.length = 0; });
  const r2 = await ok('إلغاء والسواق في الطريق', call('cF', 'orders/cancel', { orderId: id }, eS));
  check('غرامة السواق في الطريق 15', r2.fine === 15 && claim(id).kind === 'cancel_enroute' && claim(id).amount === 15 && claim(id).status === 'open');
  id = await stage(async (x) => { await ok('وصلت', call('drvFF', 'orders/arrived', { orderId: x, loc: CAIRO }, eS)); back(x, { acceptedAt: Date.now() - 5 * 60000 }); });
  const r3 = await ok('إلغاء بعد وصول السواق', call('cF', 'orders/cancel', { orderId: id }, eS));
  check('غرامة بعد الوصول 30', r3.fine === 30 && claim(id).kind === 'cancel_arrived' && claim(id).amount === 30);
  id = await stage(async (x) => { await ok('وصلت', call('drvFF', 'orders/arrived', { orderId: x, loc: CAIRO }, eS)); }); // جوه فترة الإلغاء المجاني
  const r4 = await ok('إلغاء بعد وصول السواق لكن جوه الفترة المجانية', call('cF', 'orders/cancel', { orderId: id }, eS));
  check('من غير غرامة', r4.fine === undefined && !claim(id)); }

// -- الحد اليومي للمطالبات --
clearFines();
{ await ok('حد مطالبة واحدة في اليوم', sf({ fineMaxClaimsPerDay: 1 }));
  await noShow('drvFF');
  FS.patch('users/cF', { cancel_count: 0 }); const id = (await mk()).id; await ok('سواق يقبل', call('drvFF', 'orders/accept', { orderId: id }, eS));
  await ok('وصلت', call('drvFF', 'orders/arrived', { orderId: id, loc: CAIRO }, eS)); back(id, { arrivedAt: Date.now() - 11 * 60000 });
  await bad('تعدّى الحد اليومي', call('drvFF', 'orders/noshow', { orderId: id }, eS), 429, 'claims_limit');
  check('الطلب لسه شغّال (الإبلاغ ما اتنفذش)', orderRow(id).status === 'paid');
  back(id, { acceptedAt: Date.now() - 5 * 60000 }); const rc = await ok('العميل يلغي بعد الوصول', call('cF', 'orders/cancel', { orderId: id }, eS));
  check('وبرضه من غير غرامة لأن السواق وصل لحد المطالبات', rc.fine === undefined && !claim(id));
  await ok('نرجّع الحد', sf({})); }

// -- السقف الشهري لتعويض المنصة --
clearFines();
{ await ok('سقف 20 جنيه في الشهر', sf({ fineMonthlyCap: 20 }));
  const a = await noShow('drvFF'); await ok('تطبيق', call('drvFF', 'fines/apply', { orderId: a }, eS));
  const b = await noShow('drvFF'); const rb = await ok('تطبيق التاني', call('drvFF', 'fines/apply', { orderId: b }, eS));
  check('الأولى 15 والتانية 5 (الباقي من السقف) والغرامة كاملة على العميل', claim(a).credit === 15 && rb.credit === 5 && U('drvFF').dc_credit === 20 && U('cF').fine_due === 60);
  const c3 = await noShow('drvFF'); const rc3 = await ok('تطبيق التالتة', call('drvFF', 'fines/apply', { orderId: c3 }, eS));
  check('السقف خلص: من غير تعويض لكن الغرامة اتسجّلت', rc3.credit === 0 && U('drvFF').dc_credit === 20 && U('cF').fine_due === 90);
  await ok('نرجّع', sf({})); }

// -- منع العميل بسبب غرامات متراكمة --
clearFines();
{ FS.patch('users/cF', { fine_due: 40 }); await ok('منع عند 40', sf({ fineBlockLimit: 40 }));
  await bad('عميل عليه 40 مايطلبش', make(100, eS, {}, true), 403, 'fine_blocked');
  FS.patch('users/cF', { fine_due: 10 }); // تسوية (الأدمن بيصفّرها من لوحة الغرامات)
  await ok('بعد التسوية يطلب', make(100, eS, {}, true));
  await ok('نرجّع', sf({})); }

// -- طلبين من نفس النقطة --
clearFines();
{ await ok('حد طلب واحد شغّال في نفس النقطة', sf({ samePickupMax: 1, samePickupMeters: 300 }));
  await ok('الأول', make(100, eS, {}, true));
  await bad('التاني من نفس النقطة', make(100, eS, {}, false), 409, 'same_pickup_limit');
  { clearRl(); const far = await call('cF', 'orders/create', { pickup: { ...FAR, address: 'إسكندرية' }, dropoff: GIZA, category: 'goods', size: 'small', weightKg: 100, description: 'كراتين أدوات منزلية 4 قطع', declaredValue: 100, scheduledAt: new Date(Date.now() + 3600e3).toISOString(), photos: [await up('cF', 'cargo')] }, eS); check('نقطة بعيدة مسموحة', far.status === 200 || far.error !== 'same_pickup_limit'); }
  await ok('نرفع الحد لـ2', sf({ samePickupMax: 2 }));
  await ok('التاني يعدّي', make(100, eS, {}, false));
  await bad('التالت لأ', make(100, eS, {}, false), 409, 'same_pickup_limit');
  await ok('نقفل القاعدة', sf({ samePickupMax: 0 }));
  await ok('التالت يعدّي', make(100, eS, {}, false));
  await bad('نطاق غلط', sf({ samePickupMax: 51 }), 400, 'bad_input'); }

// -- رقم التواصل إجباري --
{ const ph = U('cF').phone; FS.patch('users/cF', { phone: '' });
  await bad('عميل من غير رقم تواصل', make(100, eS, {}, true), 400, 'phone_required');
  FS.patch('users/cF', { phone: ph }); await ok('وبرقمه يطلب', make(100, eS, {}, true)); }
{ const r = await call('newcust', 'register', { role: 'customer', name: 'عميل جديد' }, eS); check('التسجيل من غير رقم تواصل مرفوض', r.status === 400 && r.error === 'bad_phone'); }

await ok('نقفل الغرامات', save({ dcEnabled: false, finesEnabled: false }));


// ===== 9) تسعير كل نوع عربية + رسوم الكيلومتر + العمولة 0 مع الغرامة + تعويض المحفظة =====
clearFines();
const sv9 = (p) => save({ dcEnabled: true, dcPct: 2, dcLimit: 1000, finesEnabled: true, ...p });
const VP = { pickup: { base: 30, perKm: 6, minPrice: 200, kmFee: 0 }, half_ton: { base: 0, perKm: 9, minPrice: 0, kmFee: 0 }, jumbo: { base: 50, perKm: 12, minPrice: 400, kmFee: 1 }, truck: { base: 0, perKm: 0, minPrice: 0, kmFee: 0 } };
{ // حسابات نقية
  const S = { ...cur, vehiclePricing: VP };
  const cm = Number(S.categories.goods.mult);
  check('الحجم المرتبط بكل عربية', vehicleOfSize(S, 'small') === 'pickup' && vehicleOfSize(S, 'medium') === 'half_ton' && vehicleOfSize(S, 'large') === 'jumbo' && vehicleOfSize(S, 'nope') === null);
  check('ربع نقل: (30 + 6×10) × المعامل', calcPrice(S, 10, 'goods', 'small').price === Math.max(200, Math.ceil((30 + 6 * 10) * cm)));
  check('الحد الأدنى للعربية بيسري (200)', calcPrice(S, 1, 'goods', 'small').price === 200);
  check('نص نقل من غير حد أدنى خاص: بيستخدم العام', calcPrice(S, 1, 'goods', 'medium').price === Math.max(Math.ceil(S.minPrice), Math.ceil(9 * 1 * cm)));
  check('نقل: (50 + 12×40) × المعامل وحد أدنى 400', calcPrice(S, 40, 'goods', 'large').price === Math.max(400, Math.ceil((50 + 12 * 40) * cm)));
  check('جامبو سعر كيلو 0 = المعادلة العامة القديمة', calcPrice(S, 40, 'goods', 'xlarge').price === calcPrice({ ...S, vehiclePricing: {} }, 40, 'goods', 'xlarge').price);
  check('كل عربية بسعر مختلف على نفس المسافة', new Set(['small', 'medium', 'large'].map((z) => calcPrice(S, 40, 'goods', z).price)).size === 3);
  check('العربية المحددة صراحة بتحدد السعر', calcPrice(S, 40, 'goods', 'small', 'jumbo').price === calcPrice(S, 40, 'goods', 'large').price);
  check('من غير إعدادات تسعير = زي الأول', calcPrice({ ...S, vehiclePricing: undefined }, 40, 'goods', 'small').price === Math.max(Math.ceil(S.minPrice), Math.ceil(S.perKm * 40 * cm * Number(S.sizes.small.mult))));
  check('رسوم الكيلو: العامة والخاصة بالعربية', kmFeeOf({ dcPerKm: 2, vehiclePricing: VP }, 100, 'pickup') === 200 && kmFeeOf({ dcPerKm: 2, vehiclePricing: VP }, 100, 'jumbo') === 100 && kmFeeOf({ dcPerKm: 0, vehiclePricing: VP }, 100, 'pickup') === 0 && kmFeeOf({ dcPerKm: 2 }, 0, null) === 0);
  check('فيه رسوم لو نسبة أو كيلو (عام أو للعربية)', dcFeesOn({ dcEnabled: true, dcPct: 2 }) && dcFeesOn({ dcEnabled: true, dcPct: 0, dcPerKm: 1 }) && dcFeesOn({ dcEnabled: true, dcPct: 0, dcPerKm: 0, vehiclePricing: VP }) && !dcFeesOn({ dcEnabled: true, dcPct: 0, dcPerKm: 0 }) && !dcFeesOn({ dcEnabled: false, dcPct: 5 }));
  check('المطلوب بيشمل رسوم الكيلومتر', dcPayable(1000, 2, 0, 0, 200).commission === 220 && dcPayable(1000, 2, 0, 0, 200).amount === 220 && dcPayable(1000, 0, 50, 30, 200).amount === 180);
  check('الإعدادات الافتراضية: تسعير العربيات مقفول', ['pickup', 'half_ton', 'jumbo', 'truck'].every((k) => cur.vehiclePricing[k].perKm === 0 && cur.vehiclePricing[k].kmFee === 0) && cur.dcPerKm === 0 && cur.fineCreditToWallet === false); }
await bad('سعر كيلو سالب', sv9({ vehiclePricing: { ...VP, pickup: { ...VP.pickup, perKm: -1 } } }), 400, 'bad_input');
await bad('رسوم كيلو فوق الحد', sv9({ dcPerKm: 10001 }), 400, 'bad_input');
await bad('عميل مايغيّرش التسعير', call('cF', 'admin/settings/save', { ...cur, vehiclePricing: VP }, eS), 403, 'forbidden');
await ok('الأدمن يحدد تسعير كل عربية', sv9({ vehiclePricing: VP }));
{ const body = (size, extra = {}) => ({ pickup: CAIRO, dropoff: GIZA, category: 'goods', size, ...extra });
  const qS = await ok('عرض سعر ربع نقل', call('cF', 'quote', body('small', { vehiclePick: 'pickup' }), eS));
  const cm = Number(cur.categories.goods.mult), km = Math.max(qS.distanceKm, 0.5);
  check('السعر طبق تسعير ربع نقل', qS.price === Math.max(200, Math.ceil((30 + 6 * km) * cm)) && qS.vehicle === 'pickup');
  const qL = await ok('عرض سعر نقل', call('cF', 'quote', body('large', { vehiclePick: 'jumbo' }), eS));
  check('النقل غير ربع النقل', qL.price === Math.max(400, Math.ceil((50 + 12 * km) * cm)) && qL.price > qS.price);
  const qN = await ok('من غير اختيار عربية (بالحجم)', call('cF', 'quote', body('small'), eS)); check('بيتحسب بعربية الحجم', qN.price === qS.price);
  const qBad = await ok('عربية مش مطابقة للحجم: بيتجاهلها', call('cF', 'quote', body('small', { vehiclePick: 'jumbo' }), eS)); check('بيرجع لعربية الحجم', qBad.price === qS.price);
  const o = await ok('طلب بنفس العربية', make(100, eS, { vehiclePick: 'pickup' }, true)); check('سعر الطلب = عرض السعر', o.price === qS.price || orderRow(o.id).price === qS.price); }

// -- رسوم الكيلومتر + تتبع الكيلومترات --
clearFines();
await ok('رسوم 2 جنيه/كم والنسبة 0', sv9({ vehiclePricing: VP, dcPct: 0, dcPerKm: 2, dcLimit: 1000 }));
{ const id = (await mk()).id; setPrice(id, 400); patchData(id, { distanceKm: 100 });
  await ok('سواق يقبل', call('drvFF', 'orders/accept', { orderId: id }, eS)); await drive('drvFF', id); await ok('تسليم', finish('drvFF', id));
  check('الكيلومترات اتسجّلت ورسومها 200 (ربع نقل ما لهاش رسوم خاصة = العامة)', dataOf(id).directKm === 100 && U('drvFF').dc_km === 100 && U('drvFF').dc_kmfee === 200 && U('drvFF').km_total === 100);
  check('الدفتر فيه الكيلومترات والعربية', ledger('drvFF', id)?.km === 100 && ledger('drvFF', id)?.km_fee === 200 && ledger('drvFF', id)?.vehicle === 'pickup');
  const sm = await ok('ملخص السواق', call('drvFF', 'dc/summary', {}, eS)); check('العمولة = رسوم الكيلومتر (نسبة 0)', sm.commission === 200 && sm.due === 200 && sm.kmFee === 200 && sm.km === 100 && sm.kmTotal === 100 && sm.perKm === 2);
  const L = await ok('لوحة الأدمن', call('admin1', 'admin/dc/list', {}, eS)); check('الأدمن شايف الكيلومترات', L.drivers.some((d) => d.id === 'drvFF' && d.km === 100 && d.kmFee === 200 && d.kmTotal === 100 && d.due === 200));
  const py = await ok('السواق يحوّل رسوم الكيلومتر', call('drvFF', 'dc/pay', { method: 'wallet', proofRef: await up('drvFF', 'payment'), reference: 'KM-0001' }, eS)); check('المبلغ 200', py.amount === 200 && FS.get(`dc_pay/${py.id}`).km === 100 && FS.get(`dc_pay/${py.id}`).km_fee === 200);
  patchData(id, {}); FS.patch('users/drvFF', { dc_km: 130, dc_kmfee: 260 }); // مشوار خلص بعد طلب السداد
  await ok('الأدمن يأكّد', call('admin1', 'admin/dc/confirm', { id: py.id, action: 'confirm' }, eS));
  check('اتخصم اللي اتحسب بس وفضل 30 كم و60 جنيه', U('drvFF').dc_km === 30 && U('drvFF').dc_kmfee === 60 && U('drvFF').km_total === 100); }
{ // رسوم خاصة بنوع العربية (نقل = 1 جنيه/كم) بدل العامة
  FS.patch('users/drvXX', { dc_km: 0, dc_kmfee: 0, dc_gross: 0, km_total: 0 });
  const id = (await ok('طلب نقل', make(100, eS, { size: 'large', vehiclePick: 'jumbo' }, true))).id; setPrice(id, 900); patchData(id, { distanceKm: 100 });
  FS.patch('users/drvXX', { vehicle_type: 'jumbo' });
  await ok('سواق يقبل', call('drvXX', 'orders/accept', { orderId: id }, eS)); await drive('drvXX', id); await ok('تسليم', finish('drvXX', id));
  check('رسوم النقل 100 (1 جنيه/كم) مش العامة 200', U('drvXX').dc_kmfee === 100 && ledger('drvXX', id)?.vehicle === 'jumbo' && dataOf(id).kmFee === 100); }
{ // توقيف بسبب الحد حتى لو النسبة 0 (فيه رسوم كيلومتر)
  FS.patch('users/drvFF', { dc_gross: 1000 }); check('رسوم كيلومتر + مكسب فوق الحد = متوقف', (await call('drvFF', 'dc/summary', {}, eS)).blocked === true);
  const id = (await mk()).id; await bad('المتوقف مايقبلش', call('drvFF', 'orders/accept', { orderId: id }, eS), 403, 'dc_blocked'); FS.patch('users/drvFF', { dc_gross: 0 }); }
await ok('نقفل رسوم الكيلومتر (حتى الخاصة بالنقل)', sv9({ vehiclePricing: { ...VP, jumbo: { ...VP.jumbo, kmFee: 0 } }, dcPct: 0, dcPerKm: 0, dcLimit: 1000 }));
{ const id = (await mk()).id; setPrice(id, 400); patchData(id, { distanceKm: 50, vehiclePick: 'pickup' }); FS.patch('users/drvXX', { dc_km: 0, dc_kmfee: 0, dc_gross: 0, km_total: 0 });
  await ok('سواق يقبل', call('drvXX', 'orders/accept', { orderId: id }, eS)); await drive('drvXX', id); await ok('تسليم', finish('drvXX', id));
  check('من غير أي رسوم: الكيلومترات بتتتبّع بس من غير رسوم ولا دفتر', U('drvXX').km_total === 50 && !U('drvXX').dc_kmfee && !U('drvXX').dc_gross && !ledger('drvXX', id)); }

// -- العمولة 0: السواق يحصّل الغرامة ويحوّلها للمنصة --
clearFines();
await ok('النسبة 0 والكيلو 0 (من غير رسوم)', sv9({ dcPct: 0, dcPerKm: 0 }));
{ const a = await noShow('drvFF'); const r = await ok('تطبيق التعويض', call('drvFF', 'fines/apply', { orderId: a }, eS));
  check('العميل اتفرضت عليه 30 والتعويض بيتسجّل رصيد (مفيش عمولة تتخصم منها)', U('cF').fine_due === 30 && r.credit === 15 && U('drvFF').dc_credit === 15);
  FS.list('dc_pay').filter((x) => x.status === 'pending').forEach((x) => FS.del(`dc_pay/${x._id}`)); // طلبات سداد معلّقة من اختبارات سابقة
  const id = (await mk()).id; setPrice(id, 300); check('الغرامة ظاهرة في الطلب الجديد', dataOf(id).fineDue === 30);
  await ok('سواق تاني يقبل', call('drvXX', 'orders/accept', { orderId: id }, eS)); FS.patch('users/drvXX', { dc_gross: 0, dc_fines_held: 0, dc_credit: 0, dc_kmfee: 0, dc_km: 0 });
  await drive('drvXX', id); await ok('تسليم', finish('drvXX', id));
  check('حصّل الغرامة 30 وبقت عليه للمنصة (من غير ما يتسجّل مكسب)', U('cF').fine_due === 0 && U('drvXX').dc_fines_held === 30 && !U('drvXX').dc_gross && !ledger('drvXX', id));
  const sm = await ok('ملخص السواق', call('drvXX', 'dc/summary', {}, eS)); check('المطلوب 30 (غرامة بس) ومش متوقف', sm.due === 30 && sm.commission === 0 && sm.blocked === false);
  const py = await ok('يحوّل الغرامة للمنصة', call('drvXX', 'dc/pay', { method: 'instapay', proofRef: await up('drvXX', 'payment'), reference: 'FINE-0099' }, eS)); check('المبلغ 30', py.amount === 30);
  await ok('الأدمن يأكّد', call('admin1', 'admin/dc/confirm', { id: py.id, action: 'confirm' }, eS)); check('اتصفّرت الغرامات المحصّلة', U('drvXX').dc_fines_held === 0 && U('drvXX').dc_paid_total >= 30);
  const sm0 = await call('drvFF', 'dc/summary', {}, eS); check('السواق المتضرر رصيده 15 ومفيش عمولة تتخصم منها (بيستنى عمولة أو محفظة)', sm0.credit === 15 && sm0.due === 0); }

// -- تعويض المنصة كرصيد محفظة (مفيد لما العمولة 0) --
clearFines();
await ok('التعويض كمحفظة', sv9({ dcPct: 0, dcPerKm: 0, fineCreditToWallet: true }));
{ FS.put('wallets/drvFF', { balance: 0, uid: 'drvFF' });
  const a = await noShow('drvFF'); const r = await ok('تطبيق', call('drvFF', 'fines/apply', { orderId: a }, eS));
  check('التعويض 15 اتحط في محفظة السواق (مش رصيد عمولة)', r.credit === 15 && (FS.get('wallets/drvFF')?.balance || 0) === 15 && !U('drvFF').dc_credit && claim(a).credit_mode === 'wallet' && U('cF').fine_due === 30);
  const m = await ok('السواق يشوف المحفظة', call('drvFF', 'fines/mine', {}, eS)); check('الغرامة كاملة على العميل والتعويض أقل', m.claims[0].credit === 15 && m.claims[0].amount === 30);
  await ok('الأدمن: الادعاء غير صحيح', call('admin1', 'admin/fines/decide', { id: a, action: 'reject', note: 'السواق مكنش موجود' }, eS));
  check('اتسحب التعويض من المحفظة واتشالت الغرامة وإنذار للسواق', (FS.get('wallets/drvFF')?.balance || 0) === 0 && U('cF').fine_due === 0 && U('drvFF').false_claims >= 1);
  const b = await noShow('drvFF'); await ok('تطبيق', call('drvFF', 'fines/apply', { orderId: b }, eS));
  FS.patch('wallets/drvFF', { balance: 5 }); // السواق سحب جزء من الرصيد
  await ok('رفض بعد ما سحب', call('admin1', 'admin/fines/decide', { id: b, action: 'reject', note: 'ادعاء كاذب' }, eS));
  check('اتسحب اللي لسه موجود بس (5) والرصيد مابقاش سالب', (FS.get('wallets/drvFF')?.balance || 0) === 0); }
await ok('نرجّع الإعدادات', save({ dcEnabled: false, finesEnabled: false }));

console.log(`\n✅ اختبارات الدفع المباشر وعمولة المنصة نجحت (${pass} فحص)`);
