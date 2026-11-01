// اختبار الدفع عند الاستلام (COD): مخفي افتراضياً، التحصيل قبل التسليم، العمولة المثبّتة، كشف الحساب، التوقيف التلقائي عند التأخر، تأكيد الأدمن والتحويل للمرسل — Firestore وهمي.
import assert from 'node:assert/strict';
import { webcrypto as crypto } from 'node:crypto';
import { onRequest } from '../functions/api/[[route]].js';
import { JWKS_URL } from '../functions/_lib/core.js';
import { trustOf } from '../functions/_lib/trust.js';
import { codPeriodOf, codPeriodBounds, codSplit, codStatements, codBlocked } from '../functions/_lib/logic.js';
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

// ===== 1) وحدة صافية =====
{ check('تقسيم: عمولة صفر', JSON.stringify(codSplit(1000, 0)) === JSON.stringify({ amount: 1000, commission: 0, net: 1000 }));
  check('تقسيم: 2.5% من 1000 = 25', codSplit(1000, 2.5).commission === 25 && codSplit(1000, 2.5).net === 975);
  check('تقسيم: النسبة بتتحدد بـ30%', codSplit(1000, 99).commission === 300);
  check('تقسيم: مبلغ/نسبة غير صالحين = أصفار', codSplit(-5, 3).amount === 0 && codSplit('x', 'y').commission === 0);
  const p = codPeriodOf(Date.UTC(2026, 9, 31), 7), b = codPeriodBounds(p.key);
  check('فترة: المفتاح بيرجع لحدودها', b.start === p.start && b.end === p.end && p.end - p.start === 7 * DAYMS);
  check('فترة: مفتاح غلط = null', codPeriodBounds('x') === null && codPeriodBounds('0d-5') === null && codPeriodBounds('99d-5') === null);
  const s = { codGraceDays: 3 }, t = p.end + 10 * DAYMS, e = [{ period: p.key, amount: 100, commission: 5, net: 95 }, { period: p.key, amount: 50, commission: 0, net: 50 }];
  const st = codStatements(e, {}, s, t)[0];
  check('كشف: بيجمع المبالغ والعمولة', st.collected === 150 && st.commission === 5 && st.net === 145 && st.count === 2);
  check('كشف: بعد المهلة من غير سداد = متأخر', st.status === 'overdue' && codBlocked([st]));
  check('كشف: قبل نهاية الفترة = مفتوح', codStatements(e, {}, s, p.start + 1000)[0].status === 'open');
  check('كشف: بعد الفترة وقبل المهلة = مستحق (مش متوقف)', codStatements(e, {}, s, p.end + DAYMS)[0].status === 'due' && !codBlocked(codStatements(e, {}, s, p.end + DAYMS)));
  check('كشف: اتأكد = مدفوع', codStatements(e, { [p.key]: { status: 'paid' } }, s, t)[0].status === 'paid' && !codBlocked(codStatements(e, { [p.key]: { status: 'paid' } }, s, t)));
  check('كشف: مبلّغ عنه لسه بيتوقف بعد المهلة', codStatements(e, { [p.key]: { status: 'reported' } }, s, t)[0].status === 'overdue'); }

// ===== 2) مخفي افتراضياً =====
check('مقفول افتراضياً بعمولة صفر', cur.codEnabled === false && cur.codCommissionPct === 0 && cur.codPeriodDays === 7 && cur.codGraceDays === 3 && cur.codBlockScope === 'cod');
await bad('طلب فيه تحصيل والنظام مقفول', make(100, eS, { codAmount: 500 }, true), 400, 'cod_disabled');
{ const a = await mk(); check('طلب عادي: مفيش تحصيل', dataOf(a.id).cod === null); }

// ===== 3) الأدمن يفعّله + التحقق =====
await bad('عميل مايفعّلش', call('cF', 'admin/settings/save', { ...cur, codEnabled: true }, eS), 403, 'forbidden');
await bad('نسبة فوق 30', save({ codEnabled: true, codCommissionPct: 31 }), 400, 'bad_input');
await bad('فترة صفر', save({ codEnabled: true, codPeriodDays: 0 }), 400, 'bad_input');
await ok('الأدمن يفعّله', save({ codEnabled: true, codCommissionPct: 0, codPeriodDays: 7, codGraceDays: 3, codMaxAmount: 5000 }));
check('الإعداد اتحفظ', (await call('cF', 'settings')).settings.codEnabled === true);
for (const [v, label] of [[-5, 'سالب'], [1.5, 'كسر'], [5001, 'فوق الحد'], ['abc', 'نص']]) await bad(`مبلغ تحصيل ${label}`, make(100, eS, { codAmount: v }, true), 400, 'bad_cod');
{ const z = await mk({ codAmount: 0 }); check('مبلغ 0 = مفيش تحصيل', dataOf(z.id).cod === null); }

// ===== 4) التحصيل قبل التسليم =====
const A = (await mk({ codAmount: 1200 })).id;
check('الطلب فيه مبلغ التحصيل', dataOf(A).cod?.amount === 1200);
await toTransit(A);
await bad('تسليم من غير تحصيل', deliver(A), 409, 'cod_not_collected');
await bad('عميل مايحصّلش', call('cF', 'cod/collect', { orderId: A }, eS), 403, 'forbidden');
await bad('سواق تاني مايحصّلش', call('drvXX', 'cod/collect', { orderId: A }, eS), 403, 'forbidden');
{ const r = await ok('السواق يأكد التحصيل', call('drvFF', 'cod/collect', { orderId: A }, eS)); check('المبلغ المسجّل صح', r.amount === 1200);
  const e = codOf(A); check('الدفتر: المبلغ والعمولة صفر والصافي كامل', e.amount === 1200 && e.pct === 0 && e.commission === 0 && e.net === 1200 && e.payout === 'pending' && e.driver_id === 'drvFF' && e.customer_id === 'cF');
  check('الفترة الحالية', e.period === codPeriodOf(Date.now(), 7).key);
  await ok('تأكيد تاني بيعدّي من غير تكرار', call('drvFF', 'cod/collect', { orderId: A }, eS)); check('سجل واحد بس', cods().filter((x) => x.order_id === A).length === 1); }
await ok('التسليم بعد التحصيل', deliver(A)); check('اتسلّم', orderRow(A).status === 'delivered');
{ const o = (await ok('العميل يشوف الطلب', call('cF', 'orders/get', { orderId: A }))).order; check('الطلب بيعرض مبلغ التحصيل وإنه اتحصّل', o.cod?.amount === 1200 && !!o.codCollectedAt); }
{ const plain = (await mk()).id; await toTransit(plain); await bad('طلب مش فيه تحصيل', call('drvFF', 'cod/collect', { orderId: plain }, eS), 409, 'bad_state'); }

// ===== 5) نسبة العمولة بتتثبّت وقت التحصيل =====
await ok('الأدمن يحط عمولة 5%', save({ codEnabled: true, codCommissionPct: 5 }));
const B = (await mk({ codAmount: 2000 })).id; await toTransit(B); await ok('تحصيل B', call('drvFF', 'cod/collect', { orderId: B }, eS)); await ok('تسليم B', deliver(B));
check('العمولة 5% على B: 100 والصافي 1900', codOf(B).pct === 5 && codOf(B).commission === 100 && codOf(B).net === 1900);
check('القديم A ما اتغيّرش (مثبّت 0%)', codOf(A).pct === 0 && codOf(A).commission === 0);

// ===== 6) كشف حساب السواق =====
{ const s = await ok('كشف السواق', call('drvFF', 'cod/summary', {}, eS));
  check('الفترة الحالية مفتوحة بإجمالي 3200', s.statements.length === 1 && s.statements[0].status === 'open' && s.statements[0].collected === 3200 && s.statements[0].count === 2 && s.statements[0].commission === 100);
  check('مش متوقف', s.enabled === true && s.blocked === false);
  await bad('عميل مايشوفش كشف سواق', call('cF', 'cod/summary', {}, eS), 403, 'forbidden');
  await bad('تبليغ سداد لفترة لسه مفتوحة', call('drvFF', 'cod/remit', { period: s.statements[0].period, ref: 'TX-1' }, eS), 409, 'period_open'); }

// ===== 7) التوقيف التلقائي =====
const P1 = codPeriodOf(Date.now() - 30 * DAYMS, 7).key, P2 = codPeriodOf(Date.now() - 45 * DAYMS, 7).key;
FS.patch(`cod/${A}`, { period: P1, collected_at: Date.now() - 30 * DAYMS }); FS.patch(`cod/${B}`, { period: P2, collected_at: Date.now() - 45 * DAYMS });
{ const s = await ok('كشف بعد التأخير', call('drvFF', 'cod/summary', {}, eS));
  check('الفترتين متأخرتين والسواق متوقف', s.blocked === true && s.statements.every((x) => x.status === 'overdue')); }
{ const c1 = await mk({ codAmount: 300 }); await bad('متوقف: طلب دفع عند الاستلام', call('drvFF', 'orders/accept', { orderId: c1.id }, eS), 403, 'cod_blocked');
  await bad('متوقف: عرض سعر على طلب دفع عند الاستلام', call('drvFF', 'offers/create', { orderId: c1.id, price: c1.price, agree: true }, eS), 403, 'cod_blocked');
  const n1 = await mk(); await ok('متوقف لكن طلب عادي مسموح (النطاق: دفع عند الاستلام بس)', call('drvFF', 'orders/accept', { orderId: n1.id }, eS));
  await ok('الأدمن يوسّع التوقيف على كل الطلبات', save({ codEnabled: true, codCommissionPct: 5, codBlockScope: 'all' }));
  const n2 = await mk(); await bad('النطاق all: حتى الطلب العادي ممنوع', call('drvFF', 'orders/accept', { orderId: n2.id }, eS), 403, 'cod_blocked');
  await ok('نرجّع النطاق', save({ codEnabled: true, codCommissionPct: 5, codBlockScope: 'cod' })); }

// ===== 8) تبليغ السداد (مابيفكّش التوقيف) =====
await bad('مرجع قصير', call('drvFF', 'cod/remit', { period: P1, ref: 'x' }, eS), 400, 'bad_input');
await bad('فترة مالهاش مبالغ', call('drvFF', 'cod/remit', { period: '7d-1', ref: 'TX-123' }, eS), 404, 'not_found');
await bad('فترة غلط', call('drvFF', 'cod/remit', { period: 'nope', ref: 'TX-123' }, eS), 400, 'bad_input');
await ok('السواق يبلّغ بسداد P1', call('drvFF', 'cod/remit', { period: P1, ref: 'InstaPay-998877' }, eS));
await ok('تبليغ تاني يحدّث المرجع', call('drvFF', 'cod/remit', { period: P1, ref: 'InstaPay-998878' }, eS));
check('المرجع اتحفظ', FS.list('cod_pay').find((p) => p.period === P1)?.ref === 'InstaPay-998878' && FS.list('cod_pay').find((p) => p.period === P1)?.status === 'reported');
check('لسه متوقف لحد ما الأدمن يأكد', (await call('drvFF', 'cod/summary', {}, eS)).blocked === true);

// ===== 9) لوحة الأدمن =====
await bad('عميل مايشوفش لوحة COD', call('cF', 'admin/cod/list', {}, eS), 403, 'forbidden');
await bad('سواق مايشوفش لوحة COD', call('drvFF', 'admin/cod/list', {}, eS), 403, 'forbidden');
{ const l = await ok('لوحة الأدمن', call('admin1', 'admin/cod/list', {}, eS)); const d = l.drivers.find((x) => x.driverId === 'drvFF');
  check('السواق ظاهر ومتوقف وإجماليه 3200', d?.blocked === true && d.collected === 3200 && d.statements.length === 2);
  check('كشف P1 مبلّغ عنه', d.statements.find((x) => x.period === P1).ref === 'InstaPay-998878');
  check('المبالغ منتظرة سداد السواق', l.payouts.length === 2 && l.payouts.every((p) => p.status === 'waiting'));
  check('أسماء السواق والعميل ظاهرة', d.name === 'محمد السيد' && l.payouts[0].customerName === 'cF'); }
await bad('تحويل للمرسل قبل سداد السواق', call('admin1', 'admin/cod/payout', { orderId: A, ref: 'PAY-1' }, eS), 409, 'period_unpaid');

// ===== 10) تأكيد الأدمن =====
await bad('عميل مايأكدش', call('cF', 'admin/cod/confirm', { driverId: 'drvFF', period: P1 }, eS), 403, 'forbidden');
await bad('سواق مايأكدش لنفسه', call('drvFF', 'admin/cod/confirm', { driverId: 'drvFF', period: P1 }, eS), 403, 'forbidden');
await bad('فترة مالهاش مبالغ', call('admin1', 'admin/cod/confirm', { driverId: 'drvFF', period: '7d-1' }, eS), 404, 'not_found');
{ const r = await ok('الأدمن يأكد P1', call('admin1', 'admin/cod/confirm', { driverId: 'drvFF', period: P1, note: 'اتأكد من إنستاباي' }, eS)); check('إجمالي P1', r.amount === 1200 && r.commission === 0 && r.net === 1200);
  check('اتسجّل في سجل الأدمن', FS.list('audit').some((a) => a.action === 'cod.confirm' && a.target_id === 'drvFF' && /إنستاباي/.test(a.note)));
  await bad('تأكيد تاني = bad_state', call('admin1', 'admin/cod/confirm', { driverId: 'drvFF', period: P1 }, eS), 409, 'bad_state');
  check('لسه متوقف بسبب P2', (await call('drvFF', 'cod/summary', {}, eS)).blocked === true);
  const c2 = await mk({ codAmount: 300 }); await bad('لسه ممنوع (P2 متأخرة)', call('drvFF', 'orders/accept', { orderId: c2.id }, eS), 403, 'cod_blocked'); }
await ok('الأدمن يأكد P2 (من غير تبليغ من السواق)', call('admin1', 'admin/cod/confirm', { driverId: 'drvFF', period: P2 }, eS));
check('اتفكّ التوقيف', (await call('drvFF', 'cod/summary', {}, eS)).blocked === false);
{ const c3 = await mk({ codAmount: 300 }); await ok('بعد السداد يقبل طلب دفع عند الاستلام تاني', call('drvFF', 'orders/accept', { orderId: c3.id }, eS)); }

// ===== 11) التحويل للمرسل =====
await bad('عميل مايحوّلش', call('cF', 'admin/cod/payout', { orderId: A, ref: 'PAY-1' }, eS), 403, 'forbidden');
await bad('مرجع قصير', call('admin1', 'admin/cod/payout', { orderId: A, ref: 'x' }, eS), 400, 'bad_input');
{ const r = await ok('الأدمن يحوّل صافي A', call('admin1', 'admin/cod/payout', { orderId: A, ref: 'PAY-A-1' }, eS)); check('الصافي 1200', r.net === 1200);
  const r2 = await ok('الأدمن يحوّل صافي B بعد العمولة', call('admin1', 'admin/cod/payout', { orderId: B, ref: 'PAY-B-1' }, eS)); check('الصافي 1900 (بعد خصم 100)', r2.net === 1900);
  await bad('تحويل تاني على نفس الطلب', call('admin1', 'admin/cod/payout', { orderId: A, ref: 'PAY-A-2' }, eS), 409, 'bad_state');
  check('الدفتر اتحدّث', codOf(A).payout === 'paid' && codOf(A).payout_ref === 'PAY-A-1' && codOf(B).payout === 'paid');
  check('سجل الأدمن للتحويلين', FS.list('audit').filter((a) => a.action === 'cod.payout').length === 2);
  const l = await ok('لوحة الأدمن بعد التحويل', call('admin1', 'admin/cod/list', {}, eS)); check('المبالغ كلها اتحوّلت', l.payouts.filter((p) => p.orderId === A || p.orderId === B).every((p) => p.status === 'paid')); }

// ===== 12) لو الأدمن قفل النظام =====
FS.put('cod/zzzzdebt01', { order_id: 'zzzzdebt01', driver_id: 'drvFF', customer_id: 'cF', amount: 100, pct: 0, commission: 0, net: 100, period: codPeriodOf(Date.now() - 60 * DAYMS, 7).key, collected_at: Date.now() - 60 * DAYMS, payout: 'pending' });
{ check('عليه دين قديم = متوقف', (await call('drvFF', 'cod/summary', {}, eS)).blocked === true);
  await ok('الأدمن يقفل النظام', save({ codEnabled: false }));
  const d1 = await mk(); await ok('النظام مقفول = مفيش توقيف', call('drvFF', 'orders/accept', { orderId: d1.id }, eS));
  check('الكشف بيقول مقفول', (await call('drvFF', 'cod/summary', {}, eS)).blocked === false);
  await bad('وتحصيل جديد ممنوع', make(100, eS, { codAmount: 100 }, true), 400, 'cod_disabled'); }

console.log(`\n✅ اختبارات الدفع عند الاستلام نجحت (${pass} فحص)`);
