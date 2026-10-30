// اختبار تتبّع مواعيد الاستلام/التسليم + اقتراح التعديل + نقاط التأخير (العميل بيقرر، الأدمن بيراجع) — Firestore وهمي، من غير إنترنت. تشغيل: npm test
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
mkU('admin1', 'admin'); mkU('cF', 'customer'); mkU('stranger', 'customer'); mkU('drvF', 'driver', { name: 'محمد السيد', vehicle_type: 'pickup' });
const vref = await up('drvF', 'vehiclePhoto'); const idRefF = await up('drvF', 'id'); FS.patch('users/drvF', { vehicle_photo_ref: vref, id_ref: idRefF });
const eC = { ...env, SWEEP_MIN_INTERVAL_MS: 0 };
const eP = { ...eC, PUSH_DISABLED: '0' };
const MIN = 60000;
mkU('drvG', 'driver', { vehicle_type: 'pickup' }); { const v = await up('drvG', 'vehiclePhoto'), i = await up('drvG', 'id'); FS.patch('users/drvG', { vehicle_photo_ref: v, id_ref: i }); }
const cur = { ...(await call('cF', 'settings')).settings, maxActiveJobs: 50 }; // الاختبار بيحتاج طلبات شغّالة كتير على نفس السواق (الإعداد الافتراضي 1)
await ok('أدمن يرفع حد الطلبات الشغّالة (للاختبار بس)', call('admin1', 'admin/settings/save', cur, env));
const dataOf = (oid) => JSON.parse(orderRow(oid).data || '{}');
const patchData = (oid, extra) => FS.patch(`orders/${oid}`, { data: JSON.stringify({ ...dataOf(oid), ...extra }) });
const body = async (extra = {}) => ({ pickup: CAIRO, dropoff: GIZA, category: 'goods', size: 'small', weightKg: 100, description: 'كراتين أدوات منزلية 4 قطع', scheduledAt: new Date(Date.now() + 3600e3).toISOString(), photos: [await up('cF', 'cargo')], ...extra });
const ALIVE = ['open', 'accepted', 'paid', 'heading_pickup', 'picked_up', 'in_transit', 'payment_review', 'awaiting_payment', 'delivered'];

// ينشئ طلب شغّال (مدفوع ومحجوز) ومتأخر/مش متأخر حسب `due` (دقايق بالنسبة للحظة دي؛ سالب = الميعاد فات)
async function mk({ grace = 30, delivery = true, driver = 'drvF', due = -45, committed = -300 } = {}) {
  clearRl(); // الطلب بيتحوّل لـpaid فوراً فمش بيتحسب في حد الطلبات المفتوحة
  const cr = await ok('إنشاء طلب', call('cF', 'orders/create', await body({ ...(grace === null ? {} : { graceMin: grace }), ...(delivery ? { deliveryAt: new Date(Date.now() + 3 * 3600e3).toISOString() } : {}) }), eC));
  await ok('سواق يقبل', call(driver, 'orders/accept', { orderId: cr.id }, eC));
  FS.patch(`orders/${cr.id}`, { status: 'paid', escrow_status: 'held', scheduled_at: Date.now() + due * MIN });
  patchData(cr.id, { acceptedAt: Date.now() + committed * MIN, paidAt: Date.now() + committed * MIN, ...(delivery ? { deliveryAt: Date.now() + (due + 120) * MIN } : {}) });
  return cr.id;
}
const sync = () => call('cF', 'sync', {}, eC);
const marks = (oid) => dataOf(oid).lateMarks || null;

// ===== 1) وحدة صافية: lateKinds =====
{ const { lateKinds, dueOf } = await import('../functions/_lib/logic.js');
  const t = 1e12, o = (x) => ({ graceMin: 30, driverId: 'd', status: 'paid', scheduledAt: t - 45 * MIN, acceptedAt: t - 300 * MIN, ...x });
  check('وحدة: استلام متأخر (45 دقيقة والمدة 30)', JSON.stringify(lateKinds(o(), t)) === '["pickup"]');
  check('وحدة: جوه المدة = مفيش تأخير', lateKinds(o({ scheduledAt: t - 20 * MIN }), t).length === 0);
  check('وحدة: بدون مدة = مفيش تتبّع', lateKinds(o({ graceMin: null }), t).length === 0);
  check('وحدة: صفر مدة = أي تأخير يتحسب', lateKinds(o({ graceMin: 0, scheduledAt: t - 1 * MIN }), t).length === 1);
  check('وحدة: السواق التزم بعد ما الميعاد فات = مش ذنبه', lateKinds(o({ acceptedAt: t - 1 * MIN }), t).length === 0);
  check('وحدة: الدفع اتأخر بعد الميعاد = مش ذنبه', lateKinds(o({ paidAt: t - 1 * MIN }), t).length === 0);
  check('وحدة: قبل الدفع (accepted) مفيش تأخير استلام', lateKinds(o({ status: 'accepted' }), t).length === 0);
  check('وحدة: اتحسم قبل كده = مرة واحدة', lateKinds(o({ lateMarks: { pickup: { state: 'forgiven' } } }), t).length === 0);
  check('وحدة: استلم متأخر فعلاً (وقت الاستلام الحقيقي)', lateKinds(o({ status: 'in_transit', pickedUpAt: t - 10 * MIN }), t).includes('pickup'));
  check('وحدة: استلم في الميعاد = مفيش تأخير', lateKinds(o({ status: 'in_transit', pickedUpAt: t - 40 * MIN }), t).length === 0);
  check('وحدة: تسليم متأخر وهو في الطريق', JSON.stringify(lateKinds(o({ status: 'in_transit', scheduledAt: t - 600 * MIN, pickedUpAt: t - 590 * MIN, deliveryAt: t - 45 * MIN }), t)) === '["delivery"]');
  check('وحدة: الميعاد المتفق عليه هو المرجع', dueOf(o({ agreed: { pickupAt: t + 5 * MIN } }), 'pickup') === t + 5 * MIN && lateKinds(o({ agreed: { pickupAt: t + 5 * MIN, at: t - 100 * MIN } }), t).length === 0);
  check('وحدة: مفيش ميعاد تسليم = مفيش تتبّع تسليم', dueOf(o(), 'delivery') === null); }

// ===== 2) إنشاء الطلب: مدخلات اختيارية ومتحقَّق منها =====
await bad('مدة تأخير سالبة', call('cF', 'orders/create', await body({ graceMin: -1 }), eC), 400, 'bad_grace'); clearRl();
await bad('مدة تأخير مش رقم', call('cF', 'orders/create', await body({ graceMin: 'abc' }), eC), 400, 'bad_grace'); clearRl();
await bad('مدة أكبر من أسبوع', call('cF', 'orders/create', await body({ graceMin: 99999 }), eC), 400, 'bad_grace'); clearRl();
await bad('تسليم قبل الاستلام', call('cF', 'orders/create', await body({ graceMin: 30, deliveryAt: new Date(Date.now() + 60000).toISOString() }), eC), 400, 'bad_delivery_time'); clearRl();
await bad('تسليم بعد أكتر من 30 يوم', call('cF', 'orders/create', await body({ graceMin: 30, deliveryAt: new Date(Date.now() + 40 * 86400e3).toISOString() }), eC), 400, 'bad_delivery_time'); clearRl();
cancelAll('cF', ALIVE);
const plain = await ok('طلب عادي من غير تتبّع', call('cF', 'orders/create', await body(), eC));
check('من غير مدة: graceMin = null (مفيش تتبّع)', dataOf(plain.id).graceMin === null && dataOf(plain.id).deliveryAt === null);
clearRl(); cancelAll('cF', ALIVE);
const tr0 = await ok('طلب بتتبّع', call('cF', 'orders/create', await body({ graceMin: 30, deliveryAt: new Date(Date.now() + 3 * 3600e3).toISOString() }), eC));
check('اتخزّن ميعاد التسليم والمدة', dataOf(tr0.id).graceMin === 30 && dataOf(tr0.id).deliveryAt > Date.now());

// ===== 3) الكشف الدوري =====
const N = await mk({ grace: null, due: -600 }); await sync();
check('من غير تتبّع: متأخر جداً ومفيش سؤال', marks(N) === null);
const J = await mk({ due: -20 }); await sync();
check('جوه المدة (متأخر 20 من 30): مفيش سؤال', marks(J) === null);
const K = await mk({ due: -45, committed: -1 }); await sync();
check('السواق التزم بعد الميعاد+المدة: مفيش سؤال', marks(K) === null);
const A = await mk({ due: -45 }); const v0 = orderRow(A).version; await sync();
check('متأخر 45 من 30: العميل يتسأل عن الاستلام', marks(A)?.pickup?.state === 'asked' && !marks(A)?.delivery);
check('اتسجّل في سجل الطلب', JSON.stringify(dataOf(A).log).includes('late_ask'));
const v1 = orderRow(A).version; await sync(); await sync();
check('الفحص المتكرر مايكرّرش السؤال', orderRow(A).version === v1 && v1 > v0);

// ===== 4) السواق يتحرك متأخر: السؤال لحظة التنقل =====
const H = await mk({ due: -45 }); // مفيش sync: السواق بيضغط «في الطريق» بعد ما الميعاد فات
await ok('السواق في الطريق (متأخر)', call('drvF', 'orders/status', { orderId: H, next: 'heading_pickup' }, eC));
check('السؤال اتفتح لحظة التنقل', marks(H)?.pickup?.state === 'asked');

// ===== 5) قرار العميل: نقطة أو مسامحة =====
await bad('عميل تاني مايقدرش يقرر', call('stranger', 'orders/late_decision', { orderId: A, kind: 'pickup', point: true }, eC), 403, 'forbidden');
await bad('السواق مايقدرش يقرر', call('drvF', 'orders/late_decision', { orderId: A, kind: 'pickup', point: true }, eC), 403);
await bad('نوع غلط', call('cF', 'orders/late_decision', { orderId: A, kind: 'x', point: true }, eC), 400, 'bad_input');
await bad('point مش boolean', call('cF', 'orders/late_decision', { orderId: A, kind: 'pickup', point: 'yes' }, eC), 400, 'bad_input');
await bad('مفيش سؤال عن التسليم', call('cF', 'orders/late_decision', { orderId: A, kind: 'delivery', point: true }, eC), 409, 'bad_state');
check('قبل القرار: السواق عنده صفر نقاط', (U('drvF').late_points || 0) === 0);
await ok('العميل يسامح', call('cF', 'orders/late_decision', { orderId: A, kind: 'pickup', point: false }, eC));
check('المسامحة: مفيش نقطة ولا سجل', (U('drvF').late_points || 0) === 0 && FS.list('late_points').length === 0 && marks(A).pickup.state === 'forgiven');
await bad('القرار مرة واحدة بس', call('cF', 'orders/late_decision', { orderId: A, kind: 'pickup', point: true }, eC), 409, 'bad_state');
await sync(); check('بعد المسامحة الفحص مايفتحش السؤال تاني', marks(A).pickup.state === 'forgiven');
await ok('العميل يسجّل نقطة (الطلب H)', call('cF', 'orders/late_decision', { orderId: H, kind: 'pickup', point: true }, eC));
check('نقطة واحدة على السواق + سجل بالتفاصيل', U('drvF').late_points === 1 && FS.list('late_points').length === 1 && FS.list('late_points')[0].order_id === H && FS.list('late_points')[0].grace_min === 30);
check('النقطة ما بتأثرش على الثقة/العمولة/الإلغاءات', U('drvF').cancel_count === 0 && trustOf(U('drvF')).level === trustOf({ ...U('drvF'), late_points: 0 }).level);
await bad('مفيش نقطة مزدوجة', call('cF', 'orders/late_decision', { orderId: H, kind: 'pickup', point: true }, eC), 409, 'bad_state');

// ===== 6) اقتراح التعديل + رد العميل =====
const P = await mk({ due: -45 }); // اتفتح عليه سؤال استلام
await sync(); check('P: سؤال استلام معلّق', marks(P)?.pickup?.state === 'asked');
const fut = (m) => new Date(Date.now() + m * MIN).toISOString();
await bad('سواق تاني مايقدرش يقترح', call('drvG', 'orders/propose_times', { orderId: P, pickupAt: fut(60) }, eC), 403, 'forbidden');
await bad('العميل مايقدرش يقترح', call('cF', 'orders/propose_times', { orderId: P, pickupAt: fut(60) }, eC), 403);
await bad('اقتراح فاضي', call('drvF', 'orders/propose_times', { orderId: P }, eC), 400, 'bad_input');
await bad('ميعاد في الماضي', call('drvF', 'orders/propose_times', { orderId: P, pickupAt: fut(-120) }, eC), 400, 'bad_date');
await bad('ميعاد بعد 40 يوم', call('drvF', 'orders/propose_times', { orderId: P, pickupAt: fut(40 * 1440) }, eC), 400, 'bad_date');
await bad('تسليم قبل الاستلام المقترح', call('drvF', 'orders/propose_times', { orderId: P, pickupAt: fut(600), deliveryAt: fut(60) }, eC), 400, 'bad_delivery_time');
const NT = await mk({ grace: null }); await bad('طلب من غير تتبّع مايتعدّلش', call('drvF', 'orders/propose_times', { orderId: NT, pickupAt: fut(60) }, eC), 409, 'no_time_tracking');
await bad('مفيش اقتراح عشان العميل يرد', call('cF', 'orders/answer_times', { orderId: P, accept: true }, eC), 409, 'no_proposal');
await ok('السواق يقترح استلام + تسليم', call('drvF', 'orders/propose_times', { orderId: P, pickupAt: fut(60), deliveryAt: fut(240) }, eC));
check('الاقتراح معلّق ومحسوب', !!dataOf(P).timeProposal && dataOf(P).proposalCount === 1 && !dataOf(P).agreed);
await bad('accept لازم boolean', call('cF', 'orders/answer_times', { orderId: P, accept: 'yes' }, eC), 400, 'bad_input');
await bad('عميل تاني مايرد', call('stranger', 'orders/answer_times', { orderId: P, accept: true }, eC), 403, 'forbidden');
await bad('السواق مايوافقش على نفسه', call('drvF', 'orders/answer_times', { orderId: P, accept: true }, eC), 403);
await ok('العميل يرفض', call('cF', 'orders/answer_times', { orderId: P, accept: false }, eC));
check('الرفض: الاقتراح اتشال والمواعيد زي ما هي', !dataOf(P).timeProposal && !dataOf(P).agreed && marks(P)?.pickup?.state === 'asked');
await ok('اقتراح جديد', call('drvF', 'orders/propose_times', { orderId: P, pickupAt: fut(60), deliveryAt: fut(240) }, eC));
await ok('اقتراح تالت يبدّل الاقتراح المعلّق', call('drvF', 'orders/propose_times', { orderId: P, pickupAt: fut(90), deliveryAt: fut(300) }, eC));
check('اقتراح واحد معلّق بس', Object.keys(dataOf(P).timeProposal).length === 3 && dataOf(P).proposalCount === 3);
await ok('العميل يوافق', call('cF', 'orders/answer_times', { orderId: P, accept: true }, eC));
check('الموافقة: المواعيد اتحفظت والاقتراح اتشال', !dataOf(P).timeProposal && dataOf(P).agreed.pickupAt > Date.now() + 80 * MIN && dataOf(P).agreed.deliveryAt > Date.now() + 290 * MIN);
check('السؤال المعلّق عن الميعاد القديم اتلغى', !marks(P));
await sync(); check('الميعاد الجديد في المستقبل: مفيش سؤال', !marks(P));
// بعد الميعاد المتفق عليه + المدة: السؤال يتفتح على الميعاد الجديد
{ const d = dataOf(P); d.agreed.pickupAt = Date.now() - 45 * MIN; d.agreed.at = Date.now() - 200 * MIN; FS.patch(`orders/${P}`, { data: JSON.stringify(d) }); }
await sync(); check('الميعاد المتفق عليه هو المرجع للتأخير', marks(P)?.pickup?.state === 'asked');
// حد 5 اقتراحات
const Q = await mk({ due: 120 }); for (let i = 0; i < 5; i++) await ok(`اقتراح ${i + 1}`, call('drvF', 'orders/propose_times', { orderId: Q, pickupAt: fut(200 + i) }, eC));
await bad('الاقتراح السادس مرفوض', call('drvF', 'orders/propose_times', { orderId: Q, pickupAt: fut(300) }, eC), 429, 'too_many_proposals');
// الموافقة على ميعاد فات
const X = await mk({ due: 120 }); await ok('اقتراح قريب', call('drvF', 'orders/propose_times', { orderId: X, pickupAt: fut(1) }, eC));
{ const d = dataOf(X); d.timeProposal.pickupAt = Date.now() - 5 * MIN; FS.patch(`orders/${X}`, { data: JSON.stringify(d) }); }
await bad('الموافقة على ميعاد مقترح فات', call('cF', 'orders/answer_times', { orderId: X, accept: true }, eC), 409, 'proposal_expired');
await ok('الرفض بيشيل الاقتراح الفايت', call('cF', 'orders/answer_times', { orderId: X, accept: false }, eC));

// ===== 7) تسليم متأخر =====
const T = await mk({ due: -600, committed: -900 }); // استلام متأخر + تسليم متأخر
FS.patch(`orders/${T}`, { status: 'in_transit' }); patchData(T, { pickedUpAt: Date.now() - 590 * MIN, lateMarks: { pickup: { state: 'forgiven', at: 1 } }, deliveryAt: Date.now() - 45 * MIN });
await sync(); check('تسليم متأخر وهو في الطريق: سؤال التسليم (والاستلام اتحسم)', marks(T)?.delivery?.state === 'asked' && marks(T).pickup.state === 'forgiven');
await ok('نقطة تسليم', call('cF', 'orders/late_decision', { orderId: T, kind: 'delivery', point: true }, eC));
check('عدّاد واحد للاتنين (استلام + تسليم)', U('drvF').late_points === 2);

// ===== 8) الحد + الأدمن (إشعار، قائمة، مسح، حظر) =====
await ok('أدمن يضبط الحد = 3', call('admin1', 'admin/settings/save', { ...cur, latePointsLimit: 3 }, eC));
check('الإعداد اتحفظ', (await call('cF', 'settings', {}, eC)).settings.latePointsLimit === 3);
await ok('تسجيل جهاز الأدمن', call('admin1', 'push/register', { token: 'tok-admin-11111111111111111' }, eP));
const before = fcm.filter((m) => m.type === 'late_limit').length;
const L1 = await mk({ due: -45 }); await sync(); await ok('نقطة 3', call('cF', 'orders/late_decision', { orderId: L1, kind: 'pickup', point: true }, eP));
check('عدّاد السواق = 3', U('drvF').late_points === 3);
check('وصل الحد: الأدمن اتبلّغ مرة واحدة', fcm.filter((m) => m.type === 'late_limit').length === before + 1);
const L2 = await mk({ due: -45 }); await sync(); await ok('نقطة 4', call('cF', 'orders/late_decision', { orderId: L2, kind: 'pickup', point: true }, eP));
check('بعد الحد: مفيش إشعار تاني', fcm.filter((m) => m.type === 'late_limit').length === before + 1 && U('drvF').late_points === 4);
const lst = await ok('الأدمن يشوف نقاط السواق', call('admin1', 'late/list', { uid: 'drvF' }, eC));
check('القائمة: 4 نقاط بالتفاصيل + العميل اللي سجّل', lst.points === 4 && lst.items.length === 4 && lst.items.every((i) => i.customerId === 'cF' && i.graceMin === 30));
const mine = await ok('السواق يشوف نقاطه', call('drvF', 'late/list', { uid: 'drvG' }, eC));
check('السواق يشوف نقاطه هو بس (مش اللي بعتّه) ومن غير هوية العميل', mine.points === 4 && mine.items.every((i) => i.customerId === undefined));
check('latePoints ظاهرة في me', (await call('drvF', 'me', {}, eC)).profile.latePoints === 4);
await bad('العميل مالوش في القائمة', call('cF', 'late/list', {}, eC), 403);
await bad('غير الأدمن مايمسحش', call('drvF', 'admin/late_clear', { uid: 'drvF' }, eC), 403);
await bad('الأدمن ما يمسحش لغير سواق', call('admin1', 'admin/late_clear', { uid: 'stranger' }, eC), 404);
await ok('الأدمن يمسح النقاط', call('admin1', 'admin/late_clear', { uid: 'drvF', note: 'اتكلمنا معاه' }, eC));
check('المسح: صفر نقاط والقائمة فاضية والحساب لسه شغّال', U('drvF').late_points === 0 && U('drvF').status === 'active' && (await call('admin1', 'late/list', { uid: 'drvF' }, eC)).items.length === 0);
check('المسح اتسجّل في سجل الأدمن', FS.list('audit').some((a) => a.action === 'user.late_clear' && a.target_id === 'drvF'));
await ok('الأدمن يحظر السواق (الطريقة الموجودة)', call('admin1', 'admin/user', { uid: 'drvG', status: 'banned', reason: 'تأخير متكرر' }, eC));
check('الحظر شغّال', U('drvG').status === 'banned');

// ===== 9) السواق يعتذر: تتبّع الطلب يتصفّر للسواق الجديد =====
const R = await mk({ due: -45 }); await sync(); check('R: سؤال معلّق', !!marks(R));
await ok('السواق يعتذر', call('drvF', 'orders/cancel', { orderId: R, reason: 'عطل' }, eC));
check('الطلب رجع مفتوح والتتبّع اتصفّر', orderRow(R).status === 'open' && !marks(R) && !dataOf(R).agreed && !dataOf(R).timeProposal && dataOf(R).proposalCount === 0 && dataOf(R).graceMin === 30);

// ===== 10) الإعداد: 0 = تعطيل الحد، وقيم غلط مرفوضة =====
await ok('أدمن يعطّل الحد', call('admin1', 'admin/settings/save', { ...cur, latePointsLimit: 0 }, eC));
await bad('حد سالب مرفوض', call('admin1', 'admin/settings/save', { ...cur, latePointsLimit: -1 }, eC), 400);
await ok('إعادة الحد الافتراضي', call('admin1', 'admin/settings/save', { ...cur, latePointsLimit: 5 }, eC));

console.log(`\n✅ اختبارات تتبّع المواعيد ونقاط التأخير نجحت (${pass} فحص)`);
