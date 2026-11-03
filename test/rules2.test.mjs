// اختبار شامل للسيرفر على Firestore وهمي (test/fake-firestore.mjs: نفس واجهة REST + نفس قيود الفهارس والشروط) — من غير إنترنت.  تشغيل: npm test
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

// ===== اختبارات: تفاصيل الشحنة، عدم المطابقة، شحنة واحدة، كود البداية، التأخير، بلاغ الفقدان، ملف الأدلة =====
const mkU = (uid, role, extra = {}) => FS.put(`users/${uid}`, { uid, role, status: 'active', name: uid, phone: '010' + Math.floor(10000000 + Math.random() * 89999999), national_id: String(Math.random()).slice(2, 16), rating_sum: 0, rating_count: 0, completed_orders: 0, cancel_count: 0, created_at: Date.now(), ...extra });
mkU('admin1', 'admin'); mkU('cR', 'customer'); mkU('dR', 'driver', { vehicle_type: 'pickup' }); mkU('dR2', 'driver', { vehicle_type: 'pickup' });
const eC = { ...env, DELIVERY_CODE_SECRET: 'rules2-secret', SWEEP_MIN_INTERVAL_MS: 0 };
const cur = (await call('cR', 'settings')).settings;
const save = (o) => ok('حفظ إعدادات', call('admin1', 'admin/settings/save', { ...cur, ...o }, eC));
await save({ mismatchCompensation: 40, mismatchMaxPer30d: 2, maxActiveJobs: 1, startCode: true, deliveryCode: true, avgSpeedKmh: 40, deliveryBufferMin: 60, stallMinutes: 30 });
const orderRow2 = (id) => FS.get(`orders/${id}`); const dat = (id) => JSON.parse(orderRow2(id).data || '{}');
const mkOrder = async (extra = {}, who = 'cR') => {
  const photo = await up(who, 'cargo');
  const r = await call(who, 'orders/create', { pickup: CAIRO, dropoff: GIZA, category: 'goods', size: 'small', weightKg: 100, description: 'ثلاجة صغيرة بيضاء ماركة X حالتها كويسة', itemsCount: 2, declaredValue: 9000, scheduledAt: new Date(Date.now() + 3600e3).toISOString(), photos: [photo], ...extra }, eC);
  return r;
};
const paid = (id) => FS.patch(`orders/${id}`, { status: 'paid', escrow_status: 'held' });

// ---- تفاصيل الشحنة ----
await bad('وصف قصير مرفوض', mkOrder({ description: 'شحنة' }), 400, 'bad_input');
await bad('عدد قطع غلط', mkOrder({ itemsCount: 0 }), 400);
const A = (await ok('طلب بتفاصيل كاملة', mkOrder())).id;
check('التفاصيل اتخزّنت', dat(A).itemsCount === 2 && dat(A).declaredValue === 9000 && dat(A).description.includes('ثلاجة'));
await bad('السواق ما يقبلش من غير موافقة', call('dR', 'orders/accept', { orderId: A, agree: false }, eC), 400, 'must_agree');
await ok('السواق يوافق ويقبل', call('dR', 'orders/accept', { orderId: A, agree: true }, eC));
check('موافقة السواق متسجّلة ببصمة', dat(A).driverAgreedAt > 0 && /^[0-9a-f]{64}$/.test(dat(A).manifestHash));
// ---- شحنة واحدة ----
const B = (await mkOrder()).id; paid(A);
await bad('السواق مشغول بشحنة', call('dR', 'orders/accept', { orderId: B, agree: true }, eC), 409, 'driver_busy');
await ok('سواق تاني يقبل', call('dR2', 'orders/accept', { orderId: B, agree: true }, eC));
// ---- عدم المطابقة ----
FS.patch(`orders/${A}`, { status: 'heading_pickup' });
await bad('عميل ما يقدرش يبلّغ عدم مطابقة', call('cR', 'orders/mismatch', { orderId: A, reason: 'مش زي الوصف' }, eC), 403);
await bad('سبب قصير', call('dR', 'orders/mismatch', { orderId: A, reason: 'x', loc: CAIRO }, eC), 400);
if (cur.geofenceMeters > 0) await bad('بعيد عن موقع الاستلام', call('dR', 'orders/mismatch', { orderId: A, reason: 'الشحنة غير مطابقة', loc: { lat: 31.2, lng: 29.9 } }, eC), 403, 'too_far');
const w0 = FS.get('wallets/dR')?.balance ?? 0;
const mm = await ok('السواق يرفض الاستلام (مش زي الوصف)', call('dR', 'orders/mismatch', { orderId: A, reason: 'الثلاجة مكسورة مش زي الصور', loc: CAIRO }, eC));
const collected = orderRow2(A).price;
check('تعويض السواق = قيمة الأدمن والباقي للعميل', mm.compensation === 40 && mm.refund === collected - 40, JSON.stringify(mm));
check('محفظة السواق زادت بالتعويض', (FS.get('wallets/dR')?.balance ?? 0) === w0 + 40);
check('الطلب اتلغى والباقي اتسجّل استرجاع', orderRow2(A).status === 'cancelled' && FS.get(`refunds/${A}`)?.amount === collected - 40);
await bad('ما يتكررش على نفس الطلب', call('dR', 'orders/mismatch', { orderId: A, reason: 'مرة تانية للاختبار', loc: CAIRO }, eC), 409);
check('بلاغ اتسجّل في سجل التدقيق', FS.list('audit').some((r) => (r.action || '') === 'order.mismatch'));
// حد البلاغات: 2 في الشهر
const mk3 = async () => { const o = (await mkOrder()).id; await call('dR', 'orders/accept', { orderId: o, agree: true }, eC); FS.patch(`orders/${o}`, { status: 'heading_pickup', escrow_status: 'held' }); return o; };
const A2 = await mk3(); await ok('بلاغ ٢', call('dR', 'orders/mismatch', { orderId: A2, reason: 'الكمية أقل من المكتوب', loc: CAIRO }, eC));
const A3 = await mk3(); await bad('بلاغ ٣ بيتمنع (الحد 2)', call('dR', 'orders/mismatch', { orderId: A3, reason: 'مش زي الوصف تاني', loc: CAIRO }, eC), 429, 'mismatch_limit');
// السواق يقدر ياخدها عادي (من غير ما يستخدم البلاغ)
FS.patch(`orders/${A3}`, { status: 'paid' });

// ---- كود بداية الرحلة + المهلة ----
const C = (await mkOrder()).id; await ok('dR2 يقبل C بعد ما خلّص B', (async () => { FS.patch(`orders/${B}`, { status: 'completed' }); return call('dR2', 'orders/accept', { orderId: C, agree: true }, eC); })());
paid(C); await ok('في الطريق', call('dR2', 'orders/status', { orderId: C, next: 'heading_pickup' }, eC));
const codes = await ok('العميل يجيب الأكواد', call('cR', 'orders/code', { orderId: C }, eC));
check('كود بداية 6 أرقام مختلف عن التسليم', /^\d{6}$/.test(codes.startCode) && codes.startCode !== codes.code);
const hand = async () => ({ photoRef: await up('dR2', 'handover'), loc: CAIRO });
await bad('استلام من غير كود البداية', call('dR2', 'orders/status', { orderId: C, next: 'picked_up', ...(await hand()) }, eC), 403, 'bad_start_code');
await bad('كود بداية غلط', call('dR2', 'orders/status', { orderId: C, next: 'picked_up', code: '000000', ...(await hand()) }, eC), 403, 'bad_start_code');
await ok('كود البداية الصح', call('dR2', 'orders/status', { orderId: C, next: 'picked_up', code: codes.startCode, ...(await hand()) }, eC));
check('الرحلة بدأت بعدّاد ومهلة وتحقق بكود', dat(C).startVerified === 'code' && dat(C).startedAt > 0 && dat(C).deadlineAt > dat(C).startedAt);
check('العميل يشوف العدّاد والمهلة', (await ok('عرض', call('cR', 'orders/get', { orderId: C }, eC))).order.deadlineAt === dat(C).deadlineAt);
const code2 = (await call('cR', 'orders/code', { orderId: C }, eC)); check('كود البداية بيختفي بعد الاستلام', code2.startCode === undefined && code2.active === true);
// ---- تأخير ووقوف ----
const d0 = dat(C); d0.deadlineAt = Date.now() - 1000; FS.patch(`orders/${C}`, { data: JSON.stringify(d0) });
await call('cR', 'sync', {}, eC);
check('الطلب اتعلّم متأخر', dat(C).late === true && dat(C).lateNotified === true);
const d1 = dat(C); d1.startedAt = Date.now() - 3600e3; FS.patch(`orders/${C}`, { data: JSON.stringify(d1) });
FS.put(`live_locations/${C}`, { order_id: C, lat: 30.04, lng: 31.23, at: Date.now(), moved_at: Date.now() - 3600e3 });
await call('cR', 'sync', {}, eC);
check('تنبيه وقوف', dat(C).stallNotified === true);
// ---- بلاغ فقدان + تجميد المحفظة ----
FS.patch(`orders/${C}`, { status: 'in_transit' });
await bad('سبب غلط/سواق ما يبلّغش فقدان', call('dR2', 'disputes/create', { orderId: C, reason: 'missing' }, eC), 409, 'bad_state');
const miss = await ok('العميل يبلّغ فقدان', call('cR', 'disputes/create', { orderId: C, reason: 'missing', details: 'الشحنة ما وصلتش والسواق مبيردش' }, eC));
check('محفظة السواق اتجمّدت', FS.get('users/dR2').wallet_frozen === true);
FS.put('wallets/dR2', { uid: 'dR2', balance: 5000, total_earned: 5000 });
await bad('سحب مرفوض وهو متجمّد', call('dR2', 'withdrawals/create', { amount: 500, method: 'instapay', account: '01012345678' }, eC), 403, 'wallet_frozen');
// ---- ملف الأدلة ----
await call('dR2', 'orders/location', { orderId: C, lat: 30.05, lng: 31.24 }, eC).catch(() => {});
const ev = await ok('الأدمن يطلع ملف الأدلة', call('admin1', 'admin/evidence', { orderId: C }, eC));
check('ملف الأدلة فيه الاتفاق والهوية والأكواد والنزاع', ev.evidence.agreement.driverAgreedAt > 0 && ev.evidence.agreement.itemsCount === 2 && ev.evidence.driver?.uid === 'dR2' && ev.evidence.customer?.uid === 'cR' && ev.evidence.codes.startVerified === 'code' && ev.evidence.disputes.length === 1);
check('بصمة النزاهة SHA-256', /^[0-9a-f]{64}$/.test(ev.integrity));
{ const js = JSON.stringify(ev.evidence); check('ما فيش أسرار (سر 2FA/سر الأكواد) في الملف', !/totp_?secret|rules2-secret/i.test(js) && !js.includes(codes.startCode) && !js.includes(codes.code)); }
await bad('عميل ما يطلعش ملف أدلة', call('cR', 'admin/evidence', { orderId: C }, eC), 403);
// فكّ التجميد بقرار الأدمن
await ok('الأدمن يحسم النزاع (استرجاع)', call('admin1', 'admin/dispute', { id: miss.id, decision: 'refund', note: 'تم' }, eC));
check('التجميد اتفك بعد القرار', FS.get('users/dR2').wallet_frozen === false);
console.log('\n✅ اختبارات القواعد الجديدة (تفاصيل/عدم مطابقة/شحنة واحدة/كود بداية/تأخير/فقدان/أدلة) نجحت');

// ===== تقييم العميل المبسّط + لوحة بيانات السواق =====
await bad('أسئلة ناقصة', call('cR', 'orders/rate', { orderId: B, stars: 5, onTime: true }, eC), 400, 'bad_input');
await bad('قيم مش true/false', call('cR', 'orders/rate', { orderId: B, stars: 5, onTime: 'yes', intact: true, polite: true }, eC), 400, 'bad_input');
await ok('العميل يقيّم بالنجوم + 3 أسئلة', call('cR', 'orders/rate', { orderId: B, stars: 5, comment: 'ممتاز', onTime: true, intact: true, polite: false }, eC));
{ const u = FS.get('users/dR2'); check('عدّادات الأسئلة اتحدّثت', u.q_n === 1 && u.q_ontime === 1 && u.q_intact === 1 && u.q_polite === 0 && u.rating_count === 1 && u.rating_sum === 5); }
await bad('مينفعش يقيّم مرتين', call('cR', 'orders/rate', { orderId: B, stars: 4, onTime: true, intact: true, polite: true }, eC), 409, 'already_rated');
const dash2 = await ok('لوحة السواق dR2', call('dR2', 'driver/dashboard', {}, eC));
check('نسب الأسئلة', dash2.ratings.quick.n === 1 && dash2.ratings.quick.onTime === 100 && dash2.ratings.quick.intact === 100 && dash2.ratings.quick.polite === 0);
check('آخر التقييمات فيها التعليق', dash2.ratings.recent[0]?.comment === 'ممتاز' && dash2.ratings.avg === 5 && dash2.ratings.count === 1);
check('المستوى والعمولة جايين من السيرفر', typeof dash2.trust.level === 'string' && dash2.trust.commissionPct >= 0 && dash2.trust.stats.trips >= 0);
check('نزاع الفقدان ظاهر وعدّاد الطلبات الشغّالة', dash2.orders.disputesTotal === 1 && dash2.orders.maxActive === 1 && Array.isArray(dash2.orders.active));
check('المحفظة مفكوكة والمستندات ناقصة (مستخدم تجريبي)', dash2.profile.walletFrozen === false && dash2.profile.docs.vehiclePhoto === false);
const dash1 = await ok('لوحة السواق dR (تعويضات عدم المطابقة)', call('dR', 'driver/dashboard', {}, eC));
check('أرباح 30 يوم فيها تعويضين × 40', dash1.earnings.d30.net === 80 && dash1.earnings.d7.net === 80 && dash1.earnings.d1.net === 80);
check('حد بلاغات عدم المطابقة', dash1.protection.mismatchUsed === 2 && dash1.protection.mismatchLimit === 2);
check('رصيد المحفظة في اللوحة', dash1.wallet.balance === (FS.get('wallets/dR')?.balance ?? 0));
await bad('عميل ما يفتحش لوحة السواق', call('cR', 'driver/dashboard', {}, eC), 403);
console.log('\n✅ اختبارات التقييم المبسّط ولوحة السواق نجحت');

// ===== مراجعة: سواق عنده طلبات تاريخ كتير ما يفوّتش الشغّال، وتنبيه الوقوف مش بيطلع كاذب =====
mkU('dH', 'driver', { vehicle_type: 'pickup' });
// ids بتترتّب قبل أي id عشوائي: الاستعلام القديم (limit 100 من غير حالة) كان هيفوّت الشغّال
for (let i = 0; i < 130; i++) FS.put(`orders/0000old${String(i).padStart(3, '0')}`, { id: `0000old${String(i).padStart(3, '0')}`, driver_id: 'dH', customer_id: 'cR', status: 'completed', created_at: Date.now() - i * 1000 });
const H1 = (await mkOrder()).id; await ok('dH يقبل الأول', call('dH', 'orders/accept', { orderId: H1, agree: true }, eC));
const H2 = (await mkOrder()).id; await bad('وعنده 130 طلب قديم برضه محسوب الشغّال (driver_busy)', call('dH', 'orders/accept', { orderId: H2, agree: true }, eC), 409, 'driver_busy');
FS.patch(`orders/${H1}`, { status: 'in_transit' });
{ const d = dat(H1); d.startedAt = Date.now() - 3 * 3600e3; d.deadlineAt = Date.now() + 3600e3; FS.patch(`orders/${H1}`, { data: JSON.stringify(d) }); }
FS.put(`live_locations/${H1}`, { order_id: H1, lat: 30.04, lng: 31.23, at: Date.now() - 20 * 60000, moved_at: Date.now() - 3 * 3600e3 }); // الإرسال واقف من 20 دقيقة (الصفحة مقفولة)
await call('cR', 'sync', {}, eC);
check('الإرسال واقف = مفيش تنبيه وقوف كاذب', !dat(H1).stallNotified);
FS.put(`live_locations/${H1}`, { order_id: H1, lat: 30.04, lng: 31.23, at: Date.now(), moved_at: Date.now() - 3 * 3600e3 }); // المواقع بتوصل بس مفيش حركة
await call('cR', 'sync', {}, eC);
check('المواقع بتوصل ومفيش حركة = تنبيه وقوف', dat(H1).stallNotified === true);
const dashH = await ok('لوحة dH', call('dH', 'driver/dashboard', {}, eC));
check('لوحة السواق بتعرض الشغّال رغم كتر الطلبات القديمة', dashH.orders.activeCount === 1 && dashH.orders.active[0].id === H1);
console.log('\n✅ اختبارات المراجعة (طلبات تاريخ كتير + تنبيه الوقوف الكاذب) نجحت');
