// اختبار شامل للسيرفر على Firestore وهمي (test/fake-firestore.mjs: نفس واجهة REST + نفس قيود الفهارس والشروط) — من غير إنترنت.  تشغيل: npm test
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

const prevFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { if (String(url).startsWith('https://firestore.googleapis.com/') && globalThis.__lat) await new Promise((r) => setTimeout(r, 20 + Math.random() * 60)); return prevFetch(url, init); };
// ===== PoC: سباقات (race conditions) — محلي على Firestore وهمي، مفيش أي اتصال حقيقي =====
const mk = (uid, role) => FS.put(`users/${uid}`, { uid, role, status: 'active', name: uid, phone: '010' + Math.floor(10000000 + Math.random() * 89999999), national_id: String(Math.random()).slice(2, 16), rating_sum: 0, rating_count: 0, completed_orders: 0, cancel_count: 0, created_at: Date.now() });
mk('admin1', 'admin'); mk('victim', 'customer');

globalThis.__lat = true; // تأخير شبكة يحاكي Firestore الحقيقي
// (1) سباق الكوبون: كوبون maxUses=1 و perUser=1
FS.put('coupons/ONCE', { id: 'ONCE', code: 'ONCE', type: 'amount', value: 20, max_discount: 0, min_price: 0, max_uses: 1, per_user: 1, active: true, expires_at: 0, used_count: 0, created_at: Date.now(), updated_at: Date.now() });
const refs = []; for (let i = 0; i < 8; i++) refs.push(await up('victim', 'cargo'));
const base2 = { pickup: CAIRO, dropoff: GIZA, category: 'goods', size: 'small', weightKg: 200, description: 'كراتين أدوات منزلية 4 قطع', scheduledAt: new Date(Date.now() + 3600e3).toISOString(), coupon: 'ONCE' };
const rs = await Promise.all(refs.map((r) => call('victim', 'orders/create', { ...base2, photos: [r] })));
console.log('[كوبون] الأخطاء:', JSON.stringify(rs.map(r=>r.status===200?'ok':r.error)));
const okN = rs.filter((r) => r.status === 200).length;
console.log(`\n[كوبون] 8 طلبات متوازية بكوبون maxUses=1/perUser=1 → نجح: ${okN} | used_count=${FS.get('coupons/ONCE').used_count} | uses.n=${FS.get('coupons/ONCE/uses/victim')?.n}`);

// (2) سباق حدّ المعدّل المركزي: الحد 5/دقيقة
const e5 = { ...env, API_RATE_DISABLED: '0', API_RATE_PER_MIN: '5' };
FS.list('rl').forEach((d) => FS.del(`rl/${d._id}`));
const seq = []; for (let i = 0; i < 12; i++) seq.push((await call('victim', 'orders/list', {}, e5)).status);
console.log(`[حدّ المعدّل] تتابعي 12 طلب بحد 5 → 200: ${seq.filter((s) => s === 200).length} | 429: ${seq.filter((s) => s === 429).length}`);
FS.list('rl').forEach((d) => FS.del(`rl/${d._id}`));
const par = await Promise.all(Array.from({ length: 40 }, () => call('victim', 'orders/list', {}, e5)));
console.log(`[حدّ المعدّل] متوازي 40 طلب بحد 5 → 200: ${par.filter((r) => r.status === 200).length} | 429: ${par.filter((r) => r.status === 429).length}`);

// (3) هل ممكن تعطيل الـ2FA بدون كود؟ أدمن مفعّل 2FA ومعاه توكن دخول بس (من غير جلسة 2FA)
FS.put('users/adminT', { uid: 'adminT', role: 'admin', status: 'active', name: 'adminT', totp_enabled: true, totp_secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', created_at: Date.now() });
const before = await call('adminT', 'admin/withdrawals', {});
console.log(`\n[2FA] قبل: admin/withdrawals بدون جلسة 2FA → ${before.status} (${before.error})`);
const setup = await call('adminT', 'admin/2fa/setup', {});
console.log(`[2FA] admin/2fa/setup بدون كود ولا جلسة → ${setup.status} | totp_enabled الآن = ${FS.get('users/adminT').totp_enabled}`);
const after = await call('adminT', 'admin/withdrawals', {});
console.log(`[2FA] بعد: admin/withdrawals بدون جلسة 2FA → ${after.status}`);
// (4) النسخة الاحتياطية بتسرّب أسرار الـ2FA؟
const exp = await call('adminT', 'admin/export', { col: 'users' });
console.log(`[export] totp_secret موجود في ملف النسخة الاحتياطية: ${JSON.stringify(exp.collections?.users || []).includes('totp_secret')}`);

// ===== تأكيدات الانحدار (لازم تفضل صح) =====
assert.equal(okN, 1, 'كوبون maxUses=1 لازم يتستخدم مرة واحدة حتى لو الطلبات متوازية');
assert.equal(FS.get('coupons/ONCE').used_count, 1);
assert.deepEqual([seq.filter((s) => s === 200).length, par.filter((r) => r.status === 200).length <= 5], [5, true], 'حدّ المعدّل لازم يصمد قدام الطلبات المتوازية');
// ضغطة طلبات متوازية شرعية (60) بالحد الافتراضي ما لازمش تتقفل غلط
{ const eD = { ...env, API_RATE_DISABLED: '0' }; delete eD.API_RATE_PER_MIN; FS.list('rl').forEach((d) => FS.del(`rl/${d._id}`));
  const many = await Promise.all(Array.from({ length: 60 }, () => call('victim', 'orders/list', {}, eD)));
  assert.equal(many.filter((r) => r.status !== 200).length, 0, 'طلبات متوازية شرعية اترفضت غلط (429)'); }
assert.equal(setup.status, 403, 'setup بدون جلسة 2FA لازم يترفض لما الـ2FA مفعّل');
assert.equal(FS.get('users/adminT').totp_enabled, true);
assert.equal(after.status, 403);
assert.equal(JSON.stringify(exp.collections?.users || []).includes('totp_secret'), false, 'النسخة الاحتياطية ما تحتويش أسرار');
console.log('\n✅ اختبارات الانحدار الأمنية نجحت');
