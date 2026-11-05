// اختبار مستوى الثقة بالنجوم (الحدود من إعدادات الأدمن) وتأثيره على العمولة — Firestore وهمي. تشغيل: npm test
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
const cur = (await call('cF', 'settings')).settings;
const save = (p) => call('admin1', 'admin/settings/save', { ...cur, ...p }, env);
const base = cur.commissionPct, disc = cur.levelDiscountPct;
// سواق 40 رحلة (مش «سواق جديد» بعمولة مخفضة)، 5 تقييمات متوسطها 4.0، و30% إلغاء (مابيأثرش)
mkU('drvStar', 'driver', { completed_orders: 40, rating_count: 5, rating_sum: 20, cancel_count: 17, vehicle_type: 'pickup' });
const me = async () => (await call('drvStar', 'me', {}, env)).profile.trust;

// ===== 1) الافتراضي: بالنجوم، والإلغاء مايأثرش =====
check('الإعداد الافتراضي موجود', cur.trustRules.trusted.avg === 4 && cur.trustRules.trusted.ratings === 3 && cur.trustRules.pro.ratings === 10 && cur.trustRules.elite.avg === 4.7);
{ const t = await me();
  check('4.0 نجوم و5 تقييمات = موثوق (رغم 30% إلغاء)', t.level === 'trusted' && t.stats.cancelPct === 29.8);
  check('العمولة = الأساسية − خصم الموثوق', t.commissionPct === base - disc.trusted);
  check('المستوى الجاي بالنجوم والتقييمات بس', t.next.level === 'pro' && t.next.ratings === 10 && t.next.avg === 4.5 && t.next.trips === undefined && t.next.maxCancelPct === undefined); }

// ===== 2) الأدمن يغيّر الحدود: المستوى والعمولة بيتغيّروا =====
const rules = (o) => ({ trusted: { avg: 4, ratings: 3 }, pro: { avg: 4.5, ratings: 10 }, elite: { avg: 4.7, ratings: 20 }, ...o });
await ok('أدمن يرفع حد الموثوق لـ10 تقييمات', save({ trustRules: rules({ trusted: { avg: 4, ratings: 10 }, pro: { avg: 4.5, ratings: 10 } }) }));
{ const t = await me(); check('نفس السواق بقى «جديد» وعمولته الأساسية', t.level === 'new' && t.commissionPct === base); }
await ok('أدمن يخفّض حد الموثوق لـ3.5 نجوم/2 تقييم والمحترف 4.0/5', save({ trustRules: rules({ trusted: { avg: 3.5, ratings: 2 }, pro: { avg: 4, ratings: 5 } }) }));
{ const t = await me(); check('نفس السواق بقى «محترف» وعمولته بخصم المحترف', t.level === 'pro' && t.commissionPct === base - disc.pro); }
check('الإعداد ظاهر في settings', (await call('cF', 'settings')).settings.trustRules.pro.ratings === 5);
{ const u = (await call('admin1', 'admin/users', { q: 'drvStar' }, env)).users.find((x) => x.id === 'drvStar' || x.uid === 'drvStar' || x.name); check('قائمة الأدمن بتحسب المستوى بإعدادات الأدمن', u?.trust?.level === 'pro'); }

// ===== 3) التحقق من الإعداد =====
await bad('مستويات مش مرتّبة (النجوم)', save({ trustRules: rules({ trusted: { avg: 4.8, ratings: 3 } }) }), 400);
await bad('مستويات مش مرتّبة (التقييمات)', save({ trustRules: rules({ pro: { avg: 4.5, ratings: 2 } }) }), 400);
await bad('نجوم أكتر من 5', save({ trustRules: rules({ elite: { avg: 5.5, ratings: 20 } }) }), 400);
await bad('نجوم أقل من 1', save({ trustRules: rules({ trusted: { avg: 0.5, ratings: 3 } }) }), 400);
await bad('عدد تقييمات صفر', save({ trustRules: rules({ trusted: { avg: 4, ratings: 0 } }) }), 400);
await bad('قيمة مش رقم', save({ trustRules: rules({ pro: { avg: 'abc', ratings: 10 } }) }), 400);
await bad('غير الأدمن مايغيّرش', call('cF', 'admin/settings/save', { ...cur, trustRules: rules({}) }, env), 403);
await ok('عميل قديم من غير trustRules مايبوّظش الحفظ (بيرجع للافتراضي)', save({ trustRules: undefined }));
{ const t = (await call('cF', 'settings')).settings.trustRules; check('من غير الحقل = الافتراضي', t.trusted.ratings === 3 && t.pro.avg === 4.5 && t.elite.ratings === 20); }
{ const t = await me(); check('وبالافتراضي رجع موثوق', t.level === 'trusted'); }
{ const el = (m) => mkU('drvEl' + m, 'driver', m === 1 ? { rating_count: 1, rating_sum: 5 } : { rating_count: 20, rating_sum: 95 });
  el(1); el(2);
  check('تقييم واحد 5 نجوم مش كفاية (حد أدنى)', (await call('drvEl1', 'me', {}, env)).profile.trust.level === 'new');
  check('20 تقييم متوسط 4.75 = نخبة بغض النظر عن الرحلات', (await call('drvEl2', 'me', {}, env)).profile.trust.level === 'elite'); }

console.log(`\n✅ اختبارات مستوى الثقة بالنجوم نجحت (${pass} فحص)`);
