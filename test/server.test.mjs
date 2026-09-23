// اختبار شامل للسيرفر على محرك SQLite حقيقي (نفس schema.sql بتاع Cloudflare D1) — من غير إنترنت.  تشغيل: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { webcrypto as crypto } from 'node:crypto';
import { onRequest } from '../functions/api/[[route]].js';
import { JWKS_URL } from '../functions/_lib/core.js';
import { trustOf } from '../functions/_lib/trust.js';

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

// ---- D1 shim فوق SQLite حقيقي (batch = معاملة ذرّية، بتتنفذ متزامنة زي D1) ----
function makeD1() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, p = []) => ({
    bind: (...a) => stmt(q, a),
    first: async (col) => { const r = sql.prepare(q).get(...p); if (!r) return null; return col ? r[col] : { ...r }; },
    all: async () => ({ results: sql.prepare(q).all(...p).map((r) => ({ ...r })), meta: {} }),
    run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...p).changes) } }),
    _sync: () => (/^\s*select/i.test(q) ? { results: sql.prepare(q).all(...p).map((r) => ({ ...r })), meta: {} } : { results: [], meta: { changes: Number(sql.prepare(q).run(...p).changes) } }),
  });
  return {
    prepare: (q) => stmt(q),
    batch: async (stmts) => { sql.exec('BEGIN'); try { const out = stmts.map((s) => s._sync()); sql.exec('COMMIT'); return out; } catch (e) { sql.exec('ROLLBACK'); throw e; } },
    raw: sql,
  };
}
const DB = makeD1(), FILES = makeD1();
const env = { FIREBASE_PROJECT_ID: PROJECT, DB, FILES };
const q1 = (sql, ...p) => DB.raw.prepare(sql).get(...p);
const qa = (sql, ...p) => DB.raw.prepare(sql).all(...p);

// ---- شبكة وهمية: مفاتيح Firebase + OSRM offline ----
const realFetch = globalThis.fetch;
const fcm = [], deadTokens = new Set(); // سجل رسائل FCM اللي اتبعتت + أجهزة "ميتة" لاختبار التنضيف
globalThis.fetch = async (url, init) => {
  url = String(url);
  if (url === JWKS_URL) return Response.json({ keys: [jwk] });
  if (url.includes('router.project-osrm.org')) throw new Error('offline');
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
const orderRow = (id) => q1('SELECT * FROM orders WHERE id = ?', id);
const wallet = (uid) => q1('SELECT * FROM wallets WHERE uid = ?', uid);

// ================== الاختبارات ==================
DB.raw.prepare("INSERT INTO users(uid, role, status, name, created_at) VALUES('admin1', 'admin', 'active', 'Admin', ?)").run(Date.now());

// أمان أساسي
await bad('بدون توكن', onRequest({ request: new Request('https://x.test/api/quote', { method: 'POST' }), env, params: { route: ['quote'] } }).then(async (r) => ({ ...(await r.json()), status: r.status })), 401);
await bad('توكن مزوّر', (async () => { const t = (await idToken('cust1')).slice(0, -6) + 'AAAAAA'; const r = await onRequest({ request: new Request('https://x.test/api/quote', { method: 'POST', headers: { Authorization: 'Bearer ' + t } }), env, params: { route: ['quote'] } }); return { ...(await r.json()), status: r.status }; })(), 401, 'invalid_token');
await bad('route غير موجود', call('cust1', 'constructor'), 404);
await bad('GET على route عادي مرفوض', (async () => { const r = await onRequest({ request: new Request('https://x.test/api/settings', { headers: { Authorization: 'Bearer ' + (await idToken('cust1')) } }), env, params: { route: ['settings'] } }); return { ...(await r.json()), status: r.status }; })(), 405);
await bad('غياب ربط القاعدة', call('cust1', 'settings', {}, { FIREBASE_PROJECT_ID: PROJECT }), 500, 'missing_db_binding');

// تشخيص الربط /api/health (public، من غير توكن، true/false فقط)
const hget = async (e) => { const r = await onRequest({ request: new Request('https://x.test/api/health'), env: e, params: { route: ['health'] } }); return { status: r.status, ...(await r.json()) }; };
{
  const h = await hget(env); check('health سليم', h.status === 200 && h.ok === true && h.db && h.schema && h.filesDb && h.filesSchema && h.projectId);
  check('health لا يسرّب قيم (booleans فقط)', Object.values(h).every((v) => typeof v === 'boolean' || typeof v === 'number'));
  const noDb = await hget({ FIREBASE_PROJECT_ID: PROJECT }); check('health يكشف غياب القاعدة', noDb.ok === false && noDb.db === false);
  const ph = await hget({ ...env, FIREBASE_PROJECT_ID: 'YOUR_FIREBASE_PROJECT_ID' }); check('health يكشف معرّف Firebase الافتراضي', ph.ok === false && ph.projectId === false);
  const empty = { prepare: (q) => ({ bind: () => ({ first: async () => null }) }) }; const noSchema = await hget({ ...env, DB: empty }); check('health يكشف غياب الجداول', noSchema.ok === false && noSchema.schema === false);
}

// تسجيل (الصور بتترفع الأول)
const people = {
  cust1: { role: 'customer', name: 'عميل تجريبي', phone: '01012345678', nationalId: '29001011234567' },
  cust2: { role: 'customer', name: 'عميل تاني', phone: '01555555555', nationalId: '29501011234567' },
  drv1: { role: 'driver', name: 'سواق تجريبي', phone: '01198765432', nationalId: '28501011234567', vehicleType: 'pickup' },
  drv2: { role: 'driver', name: 'سواق تاني', phone: '01234567890', nationalId: '28001011234567', vehicleType: 'truck' },
};
await bad('حساب جديد ما يقدرش يرفع صورة شحنة', call('cust1', 'files/upload', { kind: 'cargo', data: JPEG }), 403, 'no_profile');
await bad('ملف مش JPEG', call('cust1', 'files/upload', { kind: 'id', data: 'data:image/jpeg;base64,' + Buffer.alloc(400, 1).toString('base64') }), 400, 'bad_image');
for (const [uid, p] of Object.entries(people)) {
  const body = { ...p, idRef: await up(uid, 'id') };
  if (p.role === 'driver') { body.licenseRef = await up(uid, 'license'); body.vehicleRegRef = await up(uid, 'vehicle'); body.vehiclePhotoRef = await up(uid, 'vehiclePhoto'); }
  await ok(`تسجيل ${uid}`, call(uid, 'register', body));
}
check('السواق ليه محفظة', wallet('drv1').balance === 0);
check('الحساب pending', q1("SELECT status FROM users WHERE uid='cust1'").status === 'pending');
const stolen = (await ok('رفع', call('cust1', 'files/upload', { kind: 'id', data: JPEG }))).ref;
await bad('تكرار الموبايل/الرقم القومي', call('cust9', 'register', { ...people.cust1, idRef: await up('cust9', 'id') }), 409, 'duplicate');
await bad('التسجيل بملف مش بتاعه', call('cust8', 'register', { ...people.cust1, phone: '01066666666', nationalId: '29901011234567', idRef: stolen }), 400, 'bad_file');
await bad('رقم قومي غلط', call('cust7', 'register', { ...people.cust1, phone: '01077777777', nationalId: '123', idRef: await up('cust7', 'id') }), 400, 'bad_national_id');
await bad('حساب لسه معلّق', call('cust1', 'quote', { pickup: CAIRO, dropoff: GIZA, category: 'goods', size: 'small' }), 403, 'account_not_active');
await bad('عميل يستخدم API الأدمن', call('cust1', 'admin/user', { uid: 'drv1', status: 'active' }), 403);
await bad('عميل يفتح قائمة الأدمن', call('cust1', 'admin/users'), 403);
const me = await ok('me', call('cust1', 'me')); assert.equal(me.profile.role, 'customer');
check('me لمستخدم مجهول = null', (await call('nobody', 'me')).profile === null);

// موافقة الأدمن
for (const u of ['cust1', 'cust2', 'drv1', 'drv2']) await ok(`أدمن يفعّل ${u}`, call('admin1', 'admin/user', { uid: u, status: 'active' }));
const badges0 = await ok('badges', call('admin1', 'admin/badges')); assert.equal(badges0.badges.users, 0);

// عرض سعر
const q = await ok('عرض سعر', call('cust1', 'quote', { pickup: CAIRO, dropoff: GIZA, category: 'furniture', size: 'medium' }));
assert.equal(q.source, 'estimate'); assert.ok(q.price >= 150);
await bad('فئة غلط', call('cust1', 'quote', { pickup: CAIRO, dropoff: GIZA, category: 'xx', size: 'small' }), 400, 'bad_category');
await bad('خارج مصر', call('cust1', 'quote', { pickup: { lat: 48, lng: 2 }, dropoff: GIZA, category: 'goods', size: 'small' }), 400, 'outside_egypt');

// ------------------ دورة طلب كاملة ------------------
const cargo = await up('cust1', 'cargo');
const base = { pickup: CAIRO, dropoff: GIZA, category: 'goods', size: 'small', weightKg: 200, photos: [cargo], scheduledAt: new Date(Date.now() + 3600e3).toISOString() };
await bad('صورة شحنة بمرجع مش موجود', call('cust1', 'orders/create', { ...base, photos: ['fs:doesnotexist12345'] }), 400, 'bad_file');
const { id: oid, price } = await ok('إنشاء طلب', call('cust1', 'orders/create', base));
assert.equal(price, 150, 'الحد الأدنى للسعر');

// رؤية الطلب المفتوح
const openView = await ok('سواق يشوف الطلب المفتوح', call('drv1', 'orders/get', { orderId: oid }));
check('بيانات العميل مخفية عن السواق قبل القبول', !openView.order.customerPhone && !openView.order.customerName);
await bad('عميل تاني ما يشوفش الطلب', call('cust2', 'orders/get', { orderId: oid }), 403, 'forbidden');
const lst = await ok('قائمة المتاح للسواق', call('drv1', 'orders/list', { scope: 'available' })); check('الطلب في المتاح', lst.orders.some((o) => o.id === oid));
check('قائمة العميل تخصه فقط', (await call('cust2', 'orders/list')).orders.length === 0);

// تنافس سواقين: واحد بس ياخد الطلب
const race = await Promise.all([call('drv1', 'orders/accept', { orderId: oid }), call('drv2', 'orders/accept', { orderId: oid })]);
check('سواق واحد فقط يقبل (تنافس متزامن)', race.filter((r) => r.status === 200).length === 1 && race.filter((r) => r.status === 409).length === 1);
const winner = race[0].status === 200 ? 'drv1' : 'drv2', loser = winner === 'drv1' ? 'drv2' : 'drv1';
check('السواق الكسبان متسجل في الطلب', orderRow(oid).driver_id === winner);
await bad('السواق التاني مايقدرش يبدأ', call(loser, 'orders/status', { orderId: oid, next: 'heading_pickup' }), 403, 'forbidden');
await bad('سواق يبدأ قبل الدفع', call(winner, 'orders/status', { orderId: oid, next: 'heading_pickup' }), 409, 'bad_state');
const asDrv = await ok('السواق يشوف طلبه', call(winner, 'orders/get', { orderId: oid }));
check('رقم العميل مخفي قبل الدفع', !asDrv.order.customerPhone && asDrv.order.customerName === 'عميل تجريبي');
const asCust = await ok('العميل يشوف بيانات السواق', call('cust1', 'orders/get', { orderId: oid })); check('بيانات السواق ظاهرة للعميل', asCust.order.driverPhone && asCust.order.driverName);

const proof = await up('cust1', 'payment');
await bad('دفع بملف بتاع حد تاني', call('cust1', 'orders/pay', { orderId: oid, proofRef: await up(winner, 'handover') }), 400, 'bad_file');
await ok('عميل يرفع إثبات الدفع', call('cust1', 'orders/pay', { orderId: oid, proofRef: proof, reference: '12345' }));
check('السواق مايشوفش إثبات الدفع', !(await call(winner, 'orders/get', { orderId: oid })).order.paymentProof);
check('badge المدفوعات = 1', (await call('admin1', 'admin/badges')).badges.payments === 1);
await bad('تأكيد دفع من غير أدمن', call('cust1', 'admin/payment', { orderId: oid, action: 'confirm' }), 403);
await ok('أدمن يؤكد الدفع', call('admin1', 'admin/payment', { orderId: oid, action: 'confirm' }));
assert.equal(orderRow(oid).escrow_status, 'held');
check('رقم العميل يظهر بعد الدفع', !!(await call(winner, 'orders/get', { orderId: oid })).order.customerPhone);

await ok('في الطريق للاستلام', call(winner, 'orders/status', { orderId: oid, next: 'heading_pickup' }));
const hand = await up(winner, 'handover');
await bad('استلام من مكان بعيد (GPS)', call(winner, 'orders/status', { orderId: oid, next: 'picked_up', photoRef: hand, loc: { lat: 31.2, lng: 29.9 } }), 403, 'too_far');
await bad('استلام بدون صورة', call(winner, 'orders/status', { orderId: oid, next: 'picked_up', loc: CAIRO }), 400, 'bad_file');
await ok('السواق يبعت موقعه', call(winner, 'orders/location', { orderId: oid, lat: 30.04, lng: 31.23, acc: 12 }));
await bad('غير السواق ما يبعتش موقع', call(loser, 'orders/location', { orderId: oid, lat: 30.04, lng: 31.23 }), 403);
const live = await ok('العميل يشوف موقع السواق', call('cust1', 'orders/get', { orderId: oid })); check('الموقع وصل للعميل', live.location && Math.abs(live.location.lat - 30.04) < 1e-9);
await ok('تم الاستلام (صورة+GPS)', call(winner, 'orders/status', { orderId: oid, next: 'picked_up', photoRef: hand, loc: CAIRO }));
await ok('في الطريق للتسليم', call(winner, 'orders/status', { orderId: oid, next: 'in_transit' }));
await ok('تم التسليم', call(winner, 'orders/status', { orderId: oid, next: 'delivered', photoRef: await up(winner, 'handover'), loc: GIZA }));
await bad('السواق مايقدرش يحرر الفلوس', call(winner, 'orders/confirm', { orderId: oid }), 403);
const conf = await ok('العميل يأكد => تحرير Escrow', call('cust1', 'orders/confirm', { orderId: oid }));
assert.equal(conf.commission, 8); assert.equal(conf.net, 142); // سواق جديد: عمولة 5% من 150 = 7.5 => 8
assert.equal(wallet(winner).balance, 142); assert.equal(wallet(winner).total_earned, 142);
assert.equal(q1('SELECT completed_orders c FROM users WHERE uid = ?', winner).c, 1);
await bad('تأكيد مرتين (لا صرف مزدوج)', call('cust1', 'orders/confirm', { orderId: oid }), 409);
assert.equal(wallet(winner).balance, 142);
const log = JSON.parse(orderRow(oid).data).log; check('سجل الحالات كامل مع GPS', log.length === 9 && !!log.find((l) => l.status === 'picked_up').lat);

await ok('تقييم السواق', call('cust1', 'orders/rate', { orderId: oid, stars: 5, comment: 'ممتاز' }));
await bad('تقييم مكرر', call('cust1', 'orders/rate', { orderId: oid, stars: 1 }), 409, 'already_rated');
assert.equal(q1('SELECT rating_sum s FROM users WHERE uid = ?', winner).s, 5);

// ------------------ سحب ------------------
const W = winner;
await bad('سحب أقل من الحد الأدنى', call(W, 'withdrawals/create', { amount: 50, method: 'instapay', account: 'x@instapay' }), 400, 'below_min');
await bad('سحب أكبر من الرصيد', call(W, 'withdrawals/create', { amount: 500, method: 'instapay', account: 'x@instapay' }), 400, 'insufficient_balance');
const w = await ok('طلب سحب 100', call(W, 'withdrawals/create', { amount: 100, method: 'instapay', account: 'drv@instapay' }));
assert.equal(wallet(W).balance, 42);
await ok('أدمن يرفض السحب => رجوع الرصيد', call('admin1', 'admin/withdrawal', { id: w.id, action: 'reject', note: 'بيانات ناقصة' }));
assert.equal(wallet(W).balance, 142);
await bad('قرار مكرر على نفس السحب', call('admin1', 'admin/withdrawal', { id: w.id, action: 'paid' }), 409);
// سحب متزامن بكامل الرصيد: واحد بس ينجح
const dbl = await Promise.all([call(W, 'withdrawals/create', { amount: 142, method: 'vodafone', account: '01198765432' }), call(W, 'withdrawals/create', { amount: 142, method: 'vodafone', account: '01198765432' })]);
check('سحب متزامن: واحد ينجح والتاني يترفض', dbl.filter((r) => r.status === 200).length === 1 && dbl.filter((r) => r.status === 400).length === 1);
assert.equal(wallet(W).balance, 0);
await ok('أدمن يؤكد التحويل', call('admin1', 'admin/withdrawal', { id: dbl.find((r) => r.status === 200).id, action: 'paid' }));
const wl = await ok('المحفظة', call(W, 'wallet')); check('حركات المحفظة موجودة', wl.tx.length >= 3 && wl.withdrawals.length >= 2 && wl.wallet.balance === 0);
await bad('عميل يفتح محفظة', call('cust1', 'wallet'), 403);

// ------------------ نزاع ------------------
const big = { ...base, size: 'large', category: 'building', photos: [await up('cust1', 'cargo')], dropoff: { lat: 31.2001, lng: 29.9187, address: 'الإسكندرية' } };
const o2 = await ok('طلب طويل (القاهرة → الإسكندرية)', call('cust1', 'orders/create', big));
await ok('قبول', call(W, 'orders/accept', { orderId: o2.id }));
await bad('نزاع قبل الدفع مرفوض', call('cust1', 'disputes/create', { orderId: o2.id, reason: 'delay' }), 409);
await ok('دفع', call('cust1', 'orders/pay', { orderId: o2.id, proofRef: await up('cust1', 'payment') }));
await ok('رفض الدفع', call('admin1', 'admin/payment', { orderId: o2.id, action: 'reject', note: 'المبلغ غير مطابق' }));
assert.equal(orderRow(o2.id).status, 'accepted');
await ok('دفع تاني', call('cust1', 'orders/pay', { orderId: o2.id, proofRef: await up('cust1', 'payment') }));
await ok('تأكيد الدفع', call('admin1', 'admin/payment', { orderId: o2.id, action: 'confirm' }));
const price2 = orderRow(o2.id).price; console.log('   سعر القاهرة→الإسكندرية (تقديري بالافتراضي):', price2, 'ج');
const d = await ok('العميل يفتح نزاع', call('cust1', 'disputes/create', { orderId: o2.id, reason: 'damaged', details: 'الشحنة اتكسرت', evidence: [await up('cust1', 'evidence')] }));
assert.equal(orderRow(o2.id).status, 'disputed');
await bad('السواق مايقدرش يكمّل طلب متنازع عليه', call(W, 'orders/status', { orderId: o2.id, next: 'heading_pickup' }), 409);
const dl = await ok('أدمن يشوف النزاعات مع سياق الطلب', call('admin1', 'admin/disputes')); check('النزاع + الطلب + الدليل', dl.disputes[0].order.id === o2.id && dl.disputes[0].evidence.length === 1);
await bad('نسبة تقسيم غلط', call('admin1', 'admin/dispute', { id: d.id, decision: 'split', customerPct: 100 }), 400);
const before = wallet(W).balance;
const res = await ok('أدمن يقسّم 60% للعميل', call('admin1', 'admin/dispute', { id: d.id, decision: 'split', customerPct: 60, note: 'تلف جزئي' }));
assert.equal(res.customerRefund, Math.round(price2 * 0.6));
assert.equal(res.driverNet + Math.round((price2 - res.customerRefund) * 0.05), price2 - res.customerRefund, 'الأرقام بتتطابق (سواق جديد = عمولة 5%)');
assert.equal(wallet(W).balance, before + res.driverNet);
assert.equal(q1('SELECT refund_paid r FROM disputes WHERE id=?', d.id).r, 0);
await ok('تأكيد رد المبلغ للعميل', call('admin1', 'admin/dispute-refund', { id: d.id })); assert.equal(q1('SELECT refund_paid r FROM disputes WHERE id=?', d.id).r, 1);
await bad('حسم مرتين', call('admin1', 'admin/dispute', { id: d.id, decision: 'refund' }), 409);

// ------------------ الإحصائيات والإعدادات ------------------
const st_ = await ok('إحصائيات الأدمن', call('admin1', 'admin/stats'));
check('الإحصائيات محسوبة بـ SQL', st_.totals.total === 2 && st_.totals.commission >= 8 && st_.activeDrivers === 2 && st_.topDrivers[0].name && st_.perDay.length >= 1);
const cur = (await ok('قراءة الإعدادات', call('cust1', 'settings'))).settings;
await bad('إعدادات غلط (عمولة 150%)', call('admin1', 'admin/settings/save', { ...cur, commissionPct: 150 }), 400, 'bad_input');
await bad('إعدادات غلط (مفتاح فئة)', call('admin1', 'admin/settings/save', { ...cur, categories: { 'BAD KEY': { ar: 'x', en: 'x', mult: 1 } } }), 400, 'bad_input');
await bad('عميل يحفظ إعدادات', call('cust1', 'admin/settings/save', cur), 403);
await ok('أدمن يرفع سعر الكم إلى 20', call('admin1', 'admin/settings/save', { ...cur, perKm: 20, maxCancellations: 1 }));
const q20 = await ok('السعر بعد التعديل', call('cust1', 'quote', { pickup: CAIRO, dropoff: { lat: 31.2001, lng: 29.9187 }, category: 'goods', size: 'small' }));
assert.ok(q20.price > 1000, 'سعر الكم الجديد اتطبق');

// ------------------ إلغاء وتجميد تلقائي ------------------
const o3 = await ok('طلب جديد', call('cust1', 'orders/create', { ...base, photos: [await up('cust1', 'cargo')] }));
await ok('سواق يقبل', call(W, 'orders/accept', { orderId: o3.id }));
await ok('سواق يلغي بعد القبول', call(W, 'orders/cancel', { orderId: o3.id, reason: 'عطل' }));
assert.equal(orderRow(o3.id).status, 'open'); assert.equal(orderRow(o3.id).driver_id, null);
assert.equal(q1('SELECT status FROM users WHERE uid=?', W).status, 'suspended', 'تجميد تلقائي');
await bad('السواق المجمّد ممنوع', call(W, 'orders/accept', { orderId: o3.id }), 403, 'account_not_active');
await ok('عميل يلغي طلب مفتوح', call('cust1', 'orders/cancel', { orderId: o3.id }));
check('إلغاء طلب مفتوح ما بيتحسبش على العميل', q1("SELECT cancel_count c FROM users WHERE uid='cust1'").c === 0);
// حد الطلبات المفتوحة
const ids = []; for (let i = 0; i < 10; i++) ids.push((await call('cust2', 'orders/create', { ...base, photos: [await up('cust2', 'cargo')] })).status);
check('10 طلبات مفتوحة مسموحة', ids.filter((s) => s === 200).length === 10);
await bad('الطلب الحادي عشر مرفوض', call('cust2', 'orders/create', { ...base, photos: [await up('cust2', 'cargo')] }), 429, 'too_many_open');

// ------------------ الملفات: صلاحيات ------------------
const idFile = q1("SELECT id_ref r FROM users WHERE uid='drv1'").r;
check('المالك يقرأ بطاقته', (await getFile('drv1', idFile)).status === 200);
check('الأدمن يقرأ أي مستند', (await getFile('admin1', idFile)).status === 200);
check('عميل مايقرأش بطاقة سواق', (await getFile('cust1', idFile)).status === 403);
check('السواق يقرأ صورة الشحنة (مشتركة)', (await getFile('drv2', cargo)).status === 200);
check('إثبات الدفع خاص بالمالك والأدمن', (await getFile('drv1', proof)).status === 403 && (await getFile('cust1', proof)).status === 200);
const img = await getFile('cust1', cargo); check('الصورة بترجع JPEG صحيح', img.headers.get('content-type') === 'image/jpeg' && new Uint8Array(await img.arrayBuffer())[0] === 0xff);
check('بدون توكن مرفوض', (await getFile(null, cargo)).status === 401);
check('ملف مش موجود', (await getFile('cust1', 'fs:doesnotexist12345')).status === 404);
check('الصور اتخزنت في قاعدة FILES المنفصلة', FILES.raw.prepare('SELECT COUNT(*) c FROM file_blobs').get().c > 10 && DB.raw.prepare('SELECT COUNT(*) c FROM file_blobs').get().c === 0);
// وضع R2 (لو اتربط BUCKET)
const bucket = new Map(); const env2 = { ...env, BUCKET: { put: async (k, v) => bucket.set(k, v), get: async (k) => (bucket.has(k) ? { arrayBuffer: async () => bucket.get(k).buffer } : null) } };
const r2 = await ok('رفع على R2', call('cust1', 'files/upload', { kind: 'cargo', data: JPEG }, env2));
check('R2 قراءة/كتابة', bucket.size === 1 && (await getFile('drv2', r2.ref, env2)).status === 200 && q1('SELECT store s FROM files_meta WHERE id=?', r2.ref.slice(3)).s === 'r2');

// ------------------ القائمة السوداء ------------------
await ok('أدمن يحظر + قائمة سوداء', call('admin1', 'admin/user', { uid: 'cust1', status: 'banned', reason: 'نصب', blacklist: true }));
await bad('تسجيل بنفس البيانات ممنوع', call('cust9', 'register', { ...people.cust1, idRef: await up('cust9', 'id') }), 403, 'blacklisted');
const bl = await ok('عرض القائمة السوداء', call('admin1', 'admin/blacklist')); check('رقم وبطاقة في القائمة', bl.items.length === 2);
await ok('إضافة يدوية', call('admin1', 'admin/blacklist/add', { type: 'phone', value: '01099999999', reason: 'test' }));
await bad('إضافة رقم غلط', call('admin1', 'admin/blacklist/add', { type: 'phone', value: '123' }), 400);
await ok('حذف', call('admin1', 'admin/blacklist/remove', { id: 'phone_01099999999' }));


// ================== عروض الأسعار + متاح/غير متاح + إشعارات Push ==================
console.log('\n— عروض الأسعار والإشعارات —');
const saPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const saPem = '-----BEGIN PRIVATE KEY-----\n' + Buffer.from(await crypto.subtle.exportKey('pkcs8', saPair.privateKey)).toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n';
const envPush = { ...env, FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'sa@demo.iam', private_key: saPem, project_id: PROJECT }) };
const settingsNow = async () => (await call('cust2', 'settings')).settings;
await ok('إعادة ضبط الإعدادات', call('admin1', 'admin/settings/save', { ...(await settingsNow()), perKm: 10, maxCancellations: 5 }));
check('health يكشف الإشعارات', (await hget(envPush)).push === true && (await hget(env)).push === false);

const more = {
  cust3: { role: 'customer', name: 'عميل ثالث', phone: '01011112222', nationalId: '29101011234567' },
  drv3: { role: 'driver', name: 'سواق ربع نقل', phone: '01122223333', nationalId: '28601011234567', vehicleType: 'pickup' },
  drv4: { role: 'driver', name: 'سواق نص نقل', phone: '01233334444', nationalId: '28201011234567', vehicleType: 'half_ton' },
};
for (const [uid, p] of Object.entries(more)) {
  const body = { ...p, idRef: await up(uid, 'id') };
  if (p.role === 'driver') { body.licenseRef = await up(uid, 'license'); body.vehicleRegRef = await up(uid, 'vehicle'); body.vehiclePhotoRef = await up(uid, 'vehiclePhoto'); }
  await ok(`تسجيل ${uid}`, call(uid, 'register', body));
  await ok(`تفعيل ${uid}`, call('admin1', 'admin/user', { uid, status: 'active' }, envPush));
}
check('إشعار "تم تفعيل حسابك" ما بيتبعتش لجهاز غير مسجّل', fcm.length === 0);

// تسجيل أجهزة الإشعارات
const tokens = { cust3: 'tok-cust3-aaaaaaaaaaaaaaaaaaaa', drv2: 'tok-drv2-bbbbbbbbbbbbbbbbbbbbb', drv3: 'tok-drv3-cccccccccccccccccccc', drv4: 'tok-drv4-dddddddddddddddddddd', admin1: 'tok-admin-eeeeeeeeeeeeeeeeeeee' };
for (const [u, t_] of Object.entries(tokens)) await ok(`تسجيل جهاز ${u}`, call(u, 'push/register', { token: t_ }, envPush));
await bad('توكن قصير مرفوض', call('cust3', 'push/register', { token: 'x' }), 400);
for (let i = 0; i < 7; i++) await call('drv2', 'push/register', { token: `tok-extra-${i}-fffffffffffffffff` });
check('حد 5 أجهزة للمستخدم', q1("SELECT COUNT(*) c FROM push_tokens WHERE uid = 'drv2'").c === 5);
await call('drv2', 'push/register', { token: tokens.drv2 }); // نرجّع جهازه الأساسي كأحدث جهاز
DB.raw.prepare("DELETE FROM push_tokens WHERE uid = 'drv2' AND token != ?").run(tokens.drv2);
DB.raw.prepare("UPDATE users SET lang = 'en' WHERE uid = 'drv4'").run();

// الحضور (متاح) + الموقع
await bad('عميل ما يقدرش يغيّر الحضور', call('cust3', 'driver/presence', { online: true }), 403);
await bad('موقع خارج مصر', call('drv3', 'driver/presence', { online: true, lat: 10, lng: 10 }), 400, 'outside_egypt');
await ok('drv3 متاح قريب', call('drv3', 'driver/presence', { online: true, lat: 30.05, lng: 31.24 }));
await ok('drv4 متاح أبعد شوية', call('drv4', 'driver/presence', { online: true, lat: 30.10, lng: 31.30 }));
await ok('drv2 متاح في إسكندرية (بعيد)', call('drv2', 'driver/presence', { online: true, lat: 31.2, lng: 29.9 }));
check('حالة الحضور تتقرا', (await call('drv3', 'driver/presence', {})).online === true);
await ok('تحديث بدون موقع ما بيمسحش آخر موقع', call('drv3', 'driver/presence', { online: true }));
check('آخر موقع محفوظ', q1("SELECT lat FROM driver_presence WHERE uid='drv3'").lat === 30.05);

// توجيه الإشعارات: الحجم + المسافة + الحد الأقصى + غير المتاح
const mk = (extra = {}) => ({ ...base, photos: [null], ...extra });
const cargo3 = async () => [await up('cust3', 'cargo')];
fcm.length = 0;
const oMed = await ok('طلب حجم متوسط', call('cust3', 'orders/create', { ...base, size: 'medium', photos: await cargo3() }, envPush));
check('إشعار الطلب لسواق نص نقل القريب فقط (ربع نقل ما يشيلش متوسط، والتاني بعيد)', fcm.length === 1 && fcm[0].token === tokens.drv4 && fcm[0].urgency === 'high');
check('الإشعار بلغة السواق (إنجليزي) ومعاه رابط الطلب', fcm[0].title === 'New delivery request' && fcm[0].url === `/#/order/${oMed.id}` && /150/.test(fcm[0].body));
fcm.length = 0;
const oSmall = await ok('طلب حجم صغير', call('cust3', 'orders/create', { ...base, size: 'small', photos: await cargo3() }, envPush));
check('الصغير يوصل لسواقين ربع ونص نقل (الأقرب في النطاق) وبالعربي للي لغته عربي', fcm.length === 2 && fcm.some((m) => m.token === tokens.drv3 && m.title === 'طلب نقل جديد') && !fcm.some((m) => m.token === tokens.drv2));
await ok('حد أقصى سواق واحد', call('admin1', 'admin/settings/save', { ...(await settingsNow()), dispatchMaxDrivers: 1 }));
fcm.length = 0; await ok('طلب', call('cust3', 'orders/create', { ...base, size: 'small', photos: await cargo3() }, envPush));
check('الأقرب فقط (drv3)', fcm.length === 1 && fcm[0].token === tokens.drv3);
await ok('رجّع الحد', call('admin1', 'admin/settings/save', { ...(await settingsNow()), dispatchMaxDrivers: 10 }));
await ok('drv3 غير متاح', call('drv3', 'driver/presence', { online: false }));
fcm.length = 0; await ok('طلب', call('cust3', 'orders/create', { ...base, size: 'small', photos: await cargo3() }, envPush));
check('غير المتاح ما بيوصلوش إشعار', fcm.length === 1 && fcm[0].token === tokens.drv4);
await ok('drv3 متاح تاني', call('drv3', 'driver/presence', { online: true }));
fcm.length = 0; await ok('طلب من غير Push مفعّل', call('cust3', 'orders/create', { ...base, size: 'small', photos: await cargo3() }));
check('بدون FIREBASE_SERVICE_ACCOUNT مفيش إرسال ولا أخطاء', fcm.length === 0);
DB.raw.prepare("UPDATE driver_presence SET seen_at = 1 WHERE uid = 'drv3'").run();
fcm.length = 0; await ok('طلب', call('cust3', 'orders/create', { ...base, size: 'small', photos: await cargo3() }, envPush));
check('حالة "متاح" القديمة (أكتر من 12 ساعة) ما بيوصلهاش إشعار', fcm.length === 1 && fcm[0].token === tokens.drv4);
await ok('drv3 يجدد حضوره', call('drv3', 'driver/presence', { online: true }));
// جهاز ميت يتشال
deadTokens.add(tokens.drv4); fcm.length = 0;
await ok('طلب', call('cust3', 'orders/create', { ...base, size: 'medium', photos: await cargo3() }, envPush));
check('الجهاز الميت اتحذف من القاعدة', q1('SELECT COUNT(*) c FROM push_tokens WHERE token = ?', tokens.drv4).c === 0);
deadTokens.clear(); await call('drv4', 'push/register', { token: tokens.drv4 });
for (const r of qa("SELECT id FROM orders WHERE customer_id = 'cust3'")) await call('cust3', 'orders/cancel', { orderId: r.id });

// ------------------ عروض الأسعار ------------------
const off = await ok('طلب لعروض الأسعار', call('cust3', 'orders/create', { ...base, size: 'small', photos: await cargo3() }, envPush)); const O = off.id;
await bad('عرض أقل من الحد', call('drv3', 'offers/create', { orderId: O, price: 100 }), 400, 'offer_out_of_range');
await bad('عرض أعلى من الحد', call('drv3', 'offers/create', { orderId: O, price: 999 }), 400, 'offer_out_of_range');
await bad('عميل ما يقدمش عرض', call('cust3', 'offers/create', { orderId: O, price: 200 }), 403);
fcm.length = 0;
await ok('drv3 يقترح 200', call('drv3', 'offers/create', { orderId: O, price: 200, note: 'معايا عمال' }, envPush));
check('العميل اتبلّغ بالعرض', fcm.length === 1 && fcm[0].token === tokens.cust3 && fcm[0].title === 'عرض سعر جديد' && /200/.test(fcm[0].body));
await ok('drv3 يعدّل لـ 220', call('drv3', 'offers/create', { orderId: O, price: 220 }));
check('عرض معلّق واحد لكل سواق', q1("SELECT COUNT(*) c FROM offers WHERE order_id=? AND driver_id='drv3' AND status='pending'", O).c === 1 && q1("SELECT price p FROM offers WHERE order_id=? AND driver_id='drv3'", O).p === 220);
await ok('drv4 يقترح 180', call('drv4', 'offers/create', { orderId: O, price: 180 }));
const ov = await ok('العميل يشوف العروض', call('cust3', 'orders/get', { orderId: O }));
check('العروض مرتبة بالأرخص وبدون أرقام السواقين', ov.order.offers.map((x) => x.price).join() === '180,220' && ov.order.offers.every((x) => x.driverName && !x.phone && !x.driverPhone));
check('السواق يشوف عرضه', (await call('drv4', 'orders/get', { orderId: O })).order.myOffer.status === 'pending');
check('قائمة العميل فيها عدد العروض', (await call('cust3', 'orders/list')).orders.find((x) => x.id === O).offerCount === 2);
const offerIds = qa('SELECT id, driver_id FROM offers WHERE order_id = ?', O); const offerOf = (d) => offerIds.find((x) => x.driver_id === d).id;
await bad('عميل تاني ما يقبلش عرض', call('cust2', 'offers/accept', { offerId: offerOf('drv4') }), 403, 'forbidden');
await bad('سواق ما يقبلش عرض', call('drv3', 'offers/accept', { offerId: offerOf('drv4') }), 403);
fcm.length = 0;
await ok('العميل يقبل عرض 180', call('cust3', 'offers/accept', { offerId: offerOf('drv4') }, envPush));
const ro = orderRow(O); check('الطلب اتحدد للسواق بسعر العرض', ro.status === 'accepted' && ro.driver_id === 'drv4' && ro.price === 180 && JSON.parse(ro.data).priceNegotiated === true && JSON.parse(ro.data).priceOriginal === 150);
check('العروض التانية اترفضت', q1('SELECT status s FROM offers WHERE id=?', offerOf('drv3')).s === 'rejected' && q1('SELECT status s FROM offers WHERE id=?', offerOf('drv4')).s === 'accepted');
check('السواق الكسبان والخسران اتبلّغوا', fcm.some((m) => m.token === tokens.drv4 && m.type === 'offer_accepted') && fcm.some((m) => m.token === tokens.drv3 && m.type === 'offer_rejected'));
await bad('قبول عرض مرتين', call('cust3', 'offers/accept', { offerId: offerOf('drv4') }), 409, 'bad_state');
await bad('عرض على طلب مش مفتوح', call('drv3', 'offers/create', { orderId: O, price: 200 }), 409, 'order_not_open');
check('سجل الحالات فيه سعر العرض', JSON.parse(ro.data).log.some((l) => l.status === 'accepted' && l.note === 'offer' && l.price === 180));

// الدفع والتنفيذ: العمولة على السعر المتفق عليه
fcm.length = 0;
await ok('دفع', call('cust3', 'orders/pay', { orderId: O, proofRef: await up('cust3', 'payment') }, envPush));
check('الأدمن اتبلّغ بإثبات الدفع', fcm.length === 1 && fcm[0].token === tokens.admin1 && fcm[0].title === 'إثبات دفع جديد');
fcm.length = 0; await ok('تأكيد الدفع', call('admin1', 'admin/payment', { orderId: O, action: 'confirm' }, envPush));
check('السواق والعميل اتبلّغوا بالدفع', fcm.some((m) => m.token === tokens.drv4 && m.type === 'paid_driver') && fcm.some((m) => m.token === tokens.cust3 && m.type === 'paid_customer'));
fcm.length = 0;
await ok('في الطريق', call('drv4', 'orders/status', { orderId: O, next: 'heading_pickup' }, envPush));
check('العميل اتبلّغ إن السواق في الطريق', fcm.length === 1 && fcm[0].token === tokens.cust3 && fcm[0].type === 'heading_pickup');
await ok('استلام', call('drv4', 'orders/status', { orderId: O, next: 'picked_up', photoRef: await up('drv4', 'handover'), loc: CAIRO }));
await ok('في الطريق للتسليم', call('drv4', 'orders/status', { orderId: O, next: 'in_transit' }));
fcm.length = 0; await ok('تسليم', call('drv4', 'orders/status', { orderId: O, next: 'delivered', photoRef: await up('drv4', 'handover'), loc: GIZA }, envPush));
check('العميل اتبلّغ يأكد الاستلام بزر «وصلت شحنتي»', fcm.length === 1 && fcm[0].token === tokens.cust3 && fcm[0].type === 'delivered' && fcm[0].body.includes('وصلت شحنتي'));
fcm.length = 0; const cf = await ok('العميل: وصلت شحنتي', call('cust3', 'orders/confirm', { orderId: O }, envPush));
assert.equal(cf.commission, 9); assert.equal(cf.net, 171); // سواق جديد 5% من 180 = 9
check('المحفظة بسعر العرض والسواق اتبلّغ بمستحقاته', wallet('drv4').balance === 171 && fcm.length === 1 && fcm[0].token === tokens.drv4 && /171/.test(fcm[0].body));

// وضع "عروض فقط" ورفض/سحب العروض والقبول الفوري
const oo = await ok('طلب "عروض فقط"', call('cust3', 'orders/create', { ...base, size: 'small', instant: false, photos: await cargo3() })); const OO = oo.id;
check('instant=false محفوظ', JSON.parse(orderRow(OO).data).instant === false);
await bad('القبول الفوري مرفوض', call('drv3', 'orders/accept', { orderId: OO }), 409, 'offers_only');
await ok('لكن العرض مسموح', call('drv3', 'offers/create', { orderId: OO, price: 170 }));
await ok('drv4 يقدم عرض', call('drv4', 'offers/create', { orderId: OO, price: 190 }));
const f3 = q1("SELECT id FROM offers WHERE order_id=? AND driver_id='drv3'", OO).id;
await ok('العميل يرفض عرض drv3', call('cust3', 'offers/reject', { offerId: f3 }));
await bad('رفض مرتين', call('cust3', 'offers/reject', { offerId: f3 }), 409);
await ok('drv4 يسحب عرضه', call('drv4', 'offers/withdraw', { orderId: OO }));
await bad('سحب مرتين', call('drv4', 'offers/withdraw', { orderId: OO }), 409);
check('مفيش عروض معلّقة', q1("SELECT COUNT(*) c FROM offers WHERE order_id=? AND status='pending'", OO).c === 0);
await ok('عرض جديد', call('drv3', 'offers/create', { orderId: OO, price: 175 }));
await ok('العميل يلغي الطلب', call('cust3', 'orders/cancel', { orderId: OO }));
check('الإلغاء رفض العروض المعلّقة', q1("SELECT COUNT(*) c FROM offers WHERE order_id=? AND status='pending'", OO).c === 0);

const oi = await ok('طلب عادي', call('cust3', 'orders/create', { ...base, size: 'small', photos: await cargo3() })); const OI = oi.id;
await ok('drv3 يقدم عرض', call('drv3', 'offers/create', { orderId: OI, price: 200 }));
await ok('drv4 يقبل فوراً بالسعر المقترح', call('drv4', 'orders/accept', { orderId: OI }));
check('القبول الفوري رفض باقي العروض', q1("SELECT status s FROM offers WHERE order_id=? AND driver_id='drv3'", OI).s === 'rejected' && orderRow(OI).price === 150);
// تنافس: العميل يقبل عرض في نفس لحظة قبول سواق فوري
const oc = await ok('طلب للتنافس', call('cust3', 'orders/create', { ...base, size: 'small', photos: await cargo3() })); await ok('عرض', call('drv3', 'offers/create', { orderId: oc.id, price: 210 }));
const r3 = await Promise.all([call('cust3', 'offers/accept', { offerId: q1("SELECT id FROM offers WHERE order_id=? AND driver_id='drv3'", oc.id).id }), call('drv4', 'orders/accept', { orderId: oc.id })]);
check('واحد بس ينجح في التنافس (عرض العميل vs قبول فوري)', r3.filter((r) => r.status === 200).length === 1 && r3.filter((r) => r.status === 409).length === 1);
// إيقاف العروض من إعدادات الأدمن
await ok('الأدمن يقفل العروض', call('admin1', 'admin/settings/save', { ...(await settingsNow()), offersEnabled: false }));
const od = await ok('طلب', call('cust3', 'orders/create', { ...base, size: 'small', photos: await cargo3() }));
await bad('العروض مقفولة', call('drv3', 'offers/create', { orderId: od.id, price: 200 }), 403, 'offers_disabled');
await ok('الأدمن يفتح العروض', call('admin1', 'admin/settings/save', { ...(await settingsNow()), offersEnabled: true }));
await bad('إعدادات عروض غلط', call('admin1', 'admin/settings/save', { ...(await settingsNow()), offerMaxPct: 50 }), 400, 'bad_input');


// ================== نظام الثقة: مستويات وشارات السواقين ==================
console.log('\n— نظام الثقة —');
{
  const T = (o) => trustOf({ status: 'active', phone_verified: 0, completed_orders: 0, rating_sum: 0, rating_count: 0, cancel_count: 0, ...o });
  check('سواق جديد', T({}).level === 'new' && T({}).next.level === 'trusted');
  check('موثوق: 5 رحلات + 3 تقييمات بمتوسط 4', T({ completed_orders: 5, rating_count: 3, rating_sum: 12 }).level === 'trusted');
  check('متوسط أقل من 4 = لسه جديد', T({ completed_orders: 9, rating_count: 5, rating_sum: 19 }).level === 'new');
  check('رحلات كتير من غير تقييمات كفاية = لسه جديد', T({ completed_orders: 50, rating_count: 2, rating_sum: 10 }).level === 'new');
  check('محترف', T({ completed_orders: 25, rating_count: 10, rating_sum: 45 }).level === 'pro' && T({ completed_orders: 25, rating_count: 10, rating_sum: 45 }).next.level === 'elite');
  check('نسبة إلغاء عالية بتنزّل المستوى', T({ completed_orders: 25, rating_count: 10, rating_sum: 45, cancel_count: 3 }).level === 'trusted');
  const el = T({ completed_orders: 100, rating_count: 25, rating_sum: 121, cancel_count: 1 });
  check('نخبة + مفيش مستوى تالي', el.level === 'elite' && el.next === null);
  check('شارات: موثّق + الأعلى تقييماً', T({ completed_orders: 30, rating_count: 20, rating_sum: 97 }).badges.includes('top_rated') && T({}).badges.join() === 'verified');
  check('شارة "ملتزم" = 15 رحلة بدون إلغاء', T({ completed_orders: 15 }).badges.includes('reliable') && !T({ completed_orders: 15, cancel_count: 1 }).badges.includes('reliable'));
  check('سواق موقوف بدون شارة "موثّق"', !T({ status: 'suspended' }).badges.includes('verified') && T({ phone_verified: 1 }).badges.includes('phone'));
  check('الإحصائيات', JSON.stringify(T({ completed_orders: 3, rating_count: 2, rating_sum: 9, cancel_count: 1 }).stats) === JSON.stringify({ trips: 3, ratingCount: 2, ratingAvg: 4.5, cancels: 1, cancelPct: 25 }));
}
// تكامل: العميل يشوف مستوى السواق في العروض وبعد القبول
DB.raw.prepare("UPDATE users SET completed_orders = 30, rating_sum = 46, rating_count = 10, cancel_count = 1 WHERE uid = 'drv3'").run(); // 4.6 متوسط، 3.2% إلغاء => محترف
const tr = await ok('طلب لاختبار الثقة', call('cust3', 'orders/create', { ...base, size: 'small', photos: await cargo3() })); 
await ok('عرض من drv3', call('drv3', 'offers/create', { orderId: tr.id, price: 200 }));
await ok('عرض من drv4', call('drv4', 'offers/create', { orderId: tr.id, price: 190 }));
const tv = await ok('العميل يشوف العروض مع الثقة', call('cust3', 'orders/get', { orderId: tr.id }));
const t3 = tv.order.offers.find((x) => x.driverName === 'سواق ربع نقل').trust, t4 = tv.order.offers.find((x) => x.driverName === 'سواق نص نقل').trust;
check('مستوى محترف مع شارات الهوية', t3.level === 'pro' && t3.badges.includes('verified') && t3.stats.trips === 30);
check('السواق التاني مستواه موثوق/جديد حسب رحلاته', ['new', 'trusted'].includes(t4.level) && t4.stats.trips >= 1);
check('العروض بترجع من غير أرقام السواقين مع الثقة', tv.order.offers.every((x) => x.trust && !x.driverPhone));
await ok('العميل يقبل عرض drv3', call('cust3', 'offers/accept', { offerId: q1("SELECT id FROM offers WHERE order_id=? AND driver_id='drv3'", tr.id).id }));
check('العميل يشوف driverTrust بعد القبول', (await call('cust3', 'orders/get', { orderId: tr.id })).order.driverTrust.level === 'pro');
check('السواق مايشوفش driverTrust على طلبه', (await call('drv3', 'orders/get', { orderId: tr.id })).order.driverTrust === undefined);
const meD = await ok('me للسواق', call('drv3', 'me')); check('me للسواق فيه مستواه وتقدّمه', meD.profile.trust.level === 'pro' && meD.profile.trust.next.level === 'elite');
check('me للعميل مفيهوش ثقة', (await call('cust3', 'me')).profile.trust === undefined);
const au = await ok('قائمة الأدمن', call('admin1', 'admin/users', { role: 'driver' })); check('قائمة الأدمن فيها مستوى السواقين', au.users.length >= 3 && au.users.every((x) => x.trust && x.trust.level));


// ================== خدمة الركاب + مزايا المستويات ==================
console.log('\n— خدمة الركاب ومزايا المستويات —');
DB.raw.prepare("UPDATE orders SET status = 'cancelled' WHERE customer_id = 'cust3' AND status IN ('open','accepted','payment_review') AND id != ?").run(tr.id); // تنضيف عشان حد الطلبات المفتوحة
const ALEX = { lat: 31.2001, lng: 29.9187, address: 'الإسكندرية' };
const fin = async (oid, drv, cust, { photos = true, e = env } = {}) => { // دورة تنفيذ كاملة حتى «وصلت شحنتي»
  await call(cust, 'orders/pay', { orderId: oid, proofRef: await up(cust, 'payment') }, e);
  await call('admin1', 'admin/payment', { orderId: oid, action: 'confirm' }, e);
  const ph = async () => (photos ? { photoRef: await up(drv, 'handover') } : {});
  const o = orderRow(oid), d = JSON.parse(o.data);
  await ok('في الطريق', call(drv, 'orders/status', { orderId: oid, next: 'heading_pickup' }, e));
  await ok('استلام/ركوب', call(drv, 'orders/status', { orderId: oid, next: 'picked_up', loc: { lat: d.pickup.lat, lng: d.pickup.lng }, ...(await ph()) }, e));
  await ok('في الطريق للتسليم', call(drv, 'orders/status', { orderId: oid, next: 'in_transit' }, e));
  await ok('تسليم/وصول', call(drv, 'orders/status', { orderId: oid, next: 'delivered', loc: { lat: d.dropoff.lat, lng: d.dropoff.lng }, ...(await ph()) }, e));
  return ok('تأكيد العميل', call(cust, 'orders/confirm', { orderId: oid }, e));
};

// ---- خدمة الركاب: مقفولة افتراضياً ----
await bad('الركاب مقفول افتراضياً (عرض سعر)', call('cust3', 'quote', { service: 'passengers', pickup: CAIRO, dropoff: ALEX, vehicleClass: 'car' }), 403, 'service_disabled');
await bad('الركاب مقفول افتراضياً (طلب)', call('cust3', 'orders/create', { ...base, service: 'passengers', vehicleClass: 'car', passengers: 2, photos: [] }), 403, 'service_disabled');
await bad('إعدادات: عدد مقاعد غلط', call('admin1', 'admin/settings/save', { ...(await settingsNow()), passengerClasses: { car: { ar: 'س', en: 'c', mult: 1, seats: 0 } } }), 400, 'bad_input');
await bad('إعدادات: خصم مستوى غلط', call('admin1', 'admin/settings/save', { ...(await settingsNow()), levelDiscountPct: { trusted: 60, pro: 1, elite: 1 } }), 400, 'bad_input');
await ok('الأدمن يفعّل نقل الركاب', call('admin1', 'admin/settings/save', { ...(await settingsNow()), passengersEnabled: true }));
check('الإعدادات فيها فئات الركاب والتوصيل للمنازل', (await settingsNow()).passengerClasses.microbus.seats === 14 && !!(await settingsNow()).categories.parcel);

// سواقين ركاب
const paxDrivers = {
  drvC: { role: 'driver', name: 'سواق سيارة', phone: '01044445555', nationalId: '28701011234567', vehicleType: 'car' },
  drvM: { role: 'driver', name: 'سواق ميكروباص', phone: '01055556666', nationalId: '28801011234567', vehicleType: 'microbus' },
};
for (const [uid, p] of Object.entries(paxDrivers)) {
  await ok(`تسجيل ${uid}`, call(uid, 'register', { ...p, idRef: await up(uid, 'id'), licenseRef: await up(uid, 'license'), vehicleRegRef: await up(uid, 'vehicle'), vehiclePhotoRef: await up(uid, 'vehiclePhoto') }));
  await ok(`تفعيل ${uid}`, call('admin1', 'admin/user', { uid, status: 'active' }));
  tokens[uid] = `tok-${uid}-gggggggggggggggggggggggg`; await ok('جهاز', call(uid, 'push/register', { token: tokens[uid] }, envPush));
}
await ok('drvC متاح', call('drvC', 'driver/presence', { online: true, lat: 30.045, lng: 31.236 }));
await ok('drvM متاح', call('drvM', 'driver/presence', { online: true, lat: 30.046, lng: 31.238 }));
await ok('drv3 متاح', call('drv3', 'driver/presence', { online: true, lat: 30.05, lng: 31.24 }));
await ok('drv4 متاح', call('drv4', 'driver/presence', { online: true, lat: 30.10, lng: 31.30 }));

// التسعير حسب فئة العربية
const qc = await ok('عرض سعر: سيارة', call('cust3', 'quote', { service: 'passengers', pickup: CAIRO, dropoff: ALEX, vehicleClass: 'car' }));
const qm = await ok('عرض سعر: ميكروباص', call('cust3', 'quote', { service: 'passengers', pickup: CAIRO, dropoff: ALEX, vehicleClass: 'microbus' }));
check('معامل الميكروباص 1.8× السيارة', qm.price / qc.price > 1.75 && qm.price / qc.price < 1.85 && qm.seats === 14);
await bad('فئة غير موجودة', call('cust3', 'quote', { service: 'passengers', pickup: CAIRO, dropoff: ALEX, vehicleClass: 'rocket' }), 400, 'bad_category');
const pax = (extra) => ({ pickup: CAIRO, dropoff: GIZA, service: 'passengers', scheduledAt: new Date(Date.now() + 3600e3).toISOString(), ...extra });
await bad('ركاب أكتر من المقاعد', call('cust3', 'orders/create', pax({ vehicleClass: 'microbus', passengers: 15 })), 400, 'bad_passengers');
await bad('صفر ركاب', call('cust3', 'orders/create', pax({ vehicleClass: 'car', passengers: 0 })), 400, 'bad_passengers');

// ---- رحلات الركاب دفع مقدم: تظهر للسواقين بعد تأكيد الدفع ----
fcm.length = 0;
const p1 = await ok('طلب ركاب: ميكروباص 10 ركاب (من غير صور)', call('cust3', 'orders/create', pax({ vehicleClass: 'microbus', passengers: 10 }), envPush));
const d1 = JSON.parse(orderRow(p1.id).data); check('الطلب متخزن كخدمة ركاب دفع مقدم', d1.service === 'passengers' && d1.passengers === 10 && d1.vehicleClass === 'microbus' && d1.category === undefined && d1.photos.length === 0 && d1.payMode === 'before' && p1.prepay === true);
check('الحالة بانتظار الدفع، والسواقين ما بيتبلّغوش ولا بيشوفوه', orderRow(p1.id).status === 'awaiting_payment' && fcm.length === 0 && !(await call('drvM', 'orders/list', { scope: 'available' })).orders.some((x) => x.id === p1.id));
await bad('السواق ما يقدرش يقبل قبل الدفع', call('drvM', 'orders/accept', { orderId: p1.id }), 409, 'order_not_open');
await bad('السواق ما يشوفش الطلب قبل الدفع', call('drvM', 'orders/get', { orderId: p1.id }), 403, 'forbidden');
await ok('العميل يدفع مقدماً', call('cust3', 'orders/pay', { orderId: p1.id, proofRef: await up('cust3', 'payment'), reference: '777' }));
await ok('الأدمن يرفض الإثبات', call('admin1', 'admin/payment', { orderId: p1.id, action: 'reject', note: 'مبلغ غلط' }));
check('الرفض رجّع الطلب بانتظار الدفع', orderRow(p1.id).status === 'awaiting_payment');
await ok('يدفع تاني', call('cust3', 'orders/pay', { orderId: p1.id, proofRef: await up('cust3', 'payment') }));
fcm.length = 0; await ok('الأدمن يأكد الدفع', call('admin1', 'admin/payment', { orderId: p1.id, action: 'confirm' }, envPush));
check('الطلب بقى مفتوح للسواقين والمبلغ محجوز', orderRow(p1.id).status === 'open' && orderRow(p1.id).escrow_status === 'held');
check('الإشعار لسواق الميكروباص فقط بنص الركاب + العميل اتبلّغ', fcm.some((m) => m.token === tokens.drvM && m.title === 'طلب نقل ركاب جديد' && m.body.includes('10')) && fcm.some((m) => m.token === tokens.cust3 && m.type === 'prepaid_open') && !fcm.some((m) => [tokens.drvC, tokens.drv3, tokens.drv4].includes(m.token)));
check('الطلب ظاهر في قائمة السواق المناسب', (await call('drvM', 'orders/list', { scope: 'available' })).orders.some((x) => x.id === p1.id));
await bad('عروض الأسعار مقفولة على المدفوع مقدماً (سعر ثابت)', call('drvM', 'offers/create', { orderId: p1.id, price: 200 }), 409, 'prepaid_fixed');
await bad('تعديل السعر بعد الدفع ممنوع', call('admin1', 'admin/order-price', { orderId: p1.id, price: 500 }), 409, 'bad_state');

fcm.length = 0; const p2 = await ok('طلب ركاب: سيارة 3 ركاب', call('cust3', 'orders/create', pax({ vehicleClass: 'car', passengers: 3 }), envPush));
await call('cust3', 'orders/pay', { orderId: p2.id, proofRef: await up('cust3', 'payment') }); await call('admin1', 'admin/payment', { orderId: p2.id, action: 'confirm' }, envPush);
check('السيارة تروح لسواق السيارة والميكروباص، مش لسواقين البضاعة', fcm.filter((m) => m.type === 'new_trip').length === 2 && fcm.filter((m) => m.type === 'new_trip').every((m) => [tokens.drvC, tokens.drvM].includes(m.token)));
fcm.length = 0; await ok('بضاعة متوسطة', call('cust3', 'orders/create', { ...base, size: 'medium', category: 'furniture', photos: await cargo3() }, envPush));
check('البضاعة المتوسطة (دفع بعد القبول) بتتبلّغ فوراً لسواق نص نقل فقط', fcm.length === 1 && fcm[0].token === tokens.drv4);
fcm.length = 0; await ok('توصيل طرد صغير', call('cust3', 'orders/create', { ...base, size: 'small', category: 'parcel', photos: await cargo3() }, envPush));
check('الطرد الصغير (توصيل للمنازل) يروح لسواقين السيارات كمان', fcm.some((m) => m.token === tokens.drvC));

// أمان: عربية بضاعة ما تقبلش رحلة ركاب
await bad('سواق ربع نقل يقبل رحلة ركاب', call('drv3', 'orders/accept', { orderId: p1.id }), 403, 'vehicle_mismatch');
await bad('سيارة ما تقبلش ميكروباص 10 ركاب', call('drvC', 'orders/accept', { orderId: p1.id }), 403, 'vehicle_mismatch');
fcm.length = 0;
await ok('سواق الميكروباص يقبل (مدفوع مقدماً => يبدأ فوراً)', call('drvM', 'orders/accept', { orderId: p1.id }, envPush));
check('الحالة paid مباشرة والعميل اتبلّغ', orderRow(p1.id).status === 'paid' && orderRow(p1.id).driver_id === 'drvM' && fcm.some((m) => m.token === tokens.cust3 && m.type === 'accepted_prepaid'));
check('السواق يشوف رقم العميل بعد القبول', !!(await call('drvM', 'orders/get', { orderId: p1.id })).order.customerPhone);
fcm.length = 0;
await ok('في الطريق', call('drvM', 'orders/status', { orderId: p1.id, next: 'heading_pickup' }, envPush));
await bad('الركوب بدون موقع (GPS لسه مطلوب)', call('drvM', 'orders/status', { orderId: p1.id, next: 'picked_up' }), 400, 'location_required');
await bad('الركوب من مكان بعيد', call('drvM', 'orders/status', { orderId: p1.id, next: 'picked_up', loc: ALEX }), 403, 'too_far');
await ok('الركاب ركبوا (بدون صورة)', call('drvM', 'orders/status', { orderId: p1.id, next: 'picked_up', loc: CAIRO }, envPush));
await ok('في الطريق للوجهة', call('drvM', 'orders/status', { orderId: p1.id, next: 'in_transit' }));
fcm.length = 0; await ok('وصلنا (بدون صورة)', call('drvM', 'orders/status', { orderId: p1.id, next: 'delivered', loc: GIZA }, envPush));
check('العميل يتبلّغ بنص الركاب', fcm.length === 1 && fcm[0].type === 'delivered_p' && fcm[0].body.includes('وصلت وجهتي'));
const cfp = await ok('العميل: وصلت وجهتي', call('cust3', 'orders/confirm', { orderId: p1.id }));
check('الفلوس نزلت لمحفظة سواق الميكروباص (سواق جديد 5%)', cfp.commission === 8 && cfp.net === 142 && wallet('drvM').balance === 142);
// البضاعة لسه محتاجة صورة
await ok('طلب بضاعة', call('cust3', 'orders/create', { ...base, size: 'small', photos: await cargo3() })); const pc = q1("SELECT id FROM orders WHERE customer_id='cust3' AND status='open' ORDER BY created_at DESC LIMIT 1").id;
await ok('drvC يقبل', call('drvC', 'orders/accept', { orderId: pc })); await call('cust3', 'orders/pay', { orderId: pc, proofRef: await up('cust3', 'payment') }); await call('admin1', 'admin/payment', { orderId: pc, action: 'confirm' });
await call('drvC', 'orders/status', { orderId: pc, next: 'heading_pickup' });
await bad('البضاعة: الاستلام بدون صورة مرفوض', call('drvC', 'orders/status', { orderId: pc, next: 'picked_up', loc: CAIRO }), 400, 'bad_file');

// ---- مزايا المستويات: عمولة أقل ----
const perk = await fin(tr.id, 'drv3', 'cust3');
check('عمولة أقل للمحترف (10% بدل 12%): 200 ج ← عمولة 20 وصافي 180', perk.commission === 20 && perk.net === 180);
check('me بيعرض عمولة السواق الحالية', (await call('drv3', 'me')).profile.trust.commissionPct === 10);
DB.raw.prepare("UPDATE users SET completed_orders = 120, rating_sum = 620, rating_count = 130, cancel_count = 1 WHERE uid = 'drv4'").run(); // نخبة
const eo = await ok('طلب لسواق نخبة', call('cust3', 'orders/create', { ...base, size: 'small', photos: await cargo3() }));
await ok('drv4 يقبل', call('drv4', 'orders/accept', { orderId: eo.id }));
const pe = await fin(eo.id, 'drv4', 'cust3');
check('النخبة: عمولة 9% (12 − 3): 150 ج ← 14 وصافي 136', pe.commission === 14 && pe.net === 136 && JSON.parse(orderRow(eo.id).data).commissionPctApplied === 9);
check('me للنخبة = 9%', (await call('drv4', 'me')).profile.trust.commissionPct === 9);
await ok('الأدمن يغيّر خصم النخبة إلى 5', call('admin1', 'admin/settings/save', { ...(await settingsNow()), levelDiscountPct: { trusted: 1, pro: 2, elite: 5 } }));
check('الخصم الجديد ظاهر فوراً', (await call('drv4', 'me')).profile.trust.commissionPct === 7);
await call('admin1', 'admin/settings/save', { ...(await settingsNow()), levelDiscountPct: { trusted: 1, pro: 2, elite: 3 } });

// ---- مزايا المستويات: أولوية في الإشعارات ----
DB.raw.prepare("UPDATE users SET completed_orders = 0, rating_sum = 0, rating_count = 0, cancel_count = 0 WHERE uid = 'drv3'").run(); // drv3 جديد
await ok('drvC غير متاح', call('drvC', 'driver/presence', { online: false })); await ok('drvM غير متاح', call('drvM', 'driver/presence', { online: false }));
await ok('drv3 متاح قريب (0.7 كم)', call('drv3', 'driver/presence', { online: true, lat: 30.05, lng: 31.24 }));
await ok('drv4 نخبة أبعد (4.6 كم)', call('drv4', 'driver/presence', { online: true, lat: 30.08, lng: 31.26 }));
await ok('حد أقصى سواق واحد', call('admin1', 'admin/settings/save', { ...(await settingsNow()), dispatchMaxDrivers: 1 }));
fcm.length = 0; await ok('طلب صغير', call('cust3', 'orders/create', { ...base, size: 'small', photos: await cargo3() }, envPush));
check('النخبة (4.6 كم) بتتقدّم على الجديد (0.7 كم) في أولوية الإشعار', fcm.length === 1 && fcm[0].token === tokens.drv4);
DB.raw.prepare("UPDATE users SET completed_orders = 0, rating_sum = 0, rating_count = 0, cancel_count = 0 WHERE uid = 'drv4'").run(); // drv4 جديد
fcm.length = 0; await ok('طلب صغير', call('cust3', 'orders/create', { ...base, size: 'small', photos: await cargo3() }, envPush));
check('بدون فرق مستوى: الأقرب هو اللي ياخد الإشعار', fcm.length === 1 && fcm[0].token === tokens.drv3);
await ok('رجّع الحد', call('admin1', 'admin/settings/save', { ...(await settingsNow()), dispatchMaxDrivers: 10 }));


// ================== دفع مقدم للبضاعة + الاسترجاع + الانتهاء التلقائي + الشات ==================
console.log('\n— الدفع المقدم والاسترجاع والشات —');
{ // نطاق مستقل عشان أسماء المتغيرات ما تتعارضش مع الأقسام اللي فاتت
env.SWEEP_MIN_INTERVAL_MS = 0; envPush.SWEEP_MIN_INTERVAL_MS = 0; // بدون تأخير بين فحوصات الانتهاء في الاختبار
DB.raw.prepare("UPDATE orders SET status = 'cancelled' WHERE customer_id = 'cust3' AND status IN ('open','accepted','payment_review','awaiting_payment')").run();
const payConfirm = async (oid, e = envPush) => { await call('cust3', 'orders/pay', { orderId: oid, proofRef: await up('cust3', 'payment') }, e); await call('admin1', 'admin/payment', { orderId: oid, action: 'confirm' }, e); };
const freshUploads = () => DB.raw.prepare('UPDATE files_meta SET created_at = 1').run(); // تصفير حد الرفع (30/ساعة) عشان الاختبار
const prepaidOpen = async (extra = {}) => { freshUploads(); const o = await ok('طلب بضاعة مدفوع مقدماً', call('cust3', 'orders/create', { ...base, size: 'small', prepay: true, photos: await cargo3(), ...extra }, envPush)); await payConfirm(o.id); return o.id; };

// ---- البضاعة بدفع مقدم (باختيار العميل) ----
const pa = await ok('طلب بدفع مقدم (وبيحاول يطلب عروض فقط)', call('cust3', 'orders/create', { ...base, size: 'small', prepay: true, instant: false, photos: await cargo3() }, envPush));
const pad = JSON.parse(orderRow(pa.id).data);
check('بدفع مقدم: السعر ثابت والقبول الفوري إجباري', orderRow(pa.id).status === 'awaiting_payment' && pad.payMode === 'before' && pad.instant === true && pa.prepay === true);
await ok('يلغي قبل الدفع', call('cust3', 'orders/cancel', { orderId: pa.id }));
check('إلغاء قبل الدفع: مفيش فلوس تتسترد', q1('SELECT COUNT(*) c FROM refunds').c === 0 && orderRow(pa.id).status === 'cancelled');
const pb0 = await ok('طلب مدفوع مقدماً', call('cust3', 'orders/create', { ...base, size: 'small', prepay: true, photos: await cargo3() }, envPush));
await call('cust3', 'orders/pay', { orderId: pb0.id, proofRef: await up('cust3', 'payment') });
await bad('مينفعش يلغي وإثبات الدفع تحت المراجعة', call('cust3', 'orders/cancel', { orderId: pb0.id }), 409, 'cannot_cancel');
fcm.length = 0; await ok('الأدمن يأكد', call('admin1', 'admin/payment', { orderId: pb0.id, action: 'confirm' }, envPush));
check('الطلب مفتوح ومحجوز والإشعار للسواقين المناسبين', orderRow(pb0.id).status === 'open' && orderRow(pb0.id).escrow_status === 'held' && fcm.some((m) => m.type === 'new_order' && [tokens.drv3, tokens.drv4].includes(m.token)));
const ovh = (await call('admin1', 'admin/stats')).totals.held;
check('المبلغ المحجوز ظاهر في إحصائيات الأدمن', ovh >= 150);

// ---- الاسترجاع: العميل يلغي وماحدش قبل الطلب ----
fcm.length = 0;
const cx = await ok('العميل يلغي الطلب المدفوع ويسترجع', call('cust3', 'orders/cancel', { orderId: pb0.id, reason: 'مش هحتاج' }, envPush));
check('الاسترجاع اتسجّل بمبلغ الطلب', cx.refund === true && orderRow(pb0.id).status === 'cancelled' && orderRow(pb0.id).escrow_status === 'refund_pending' && q1('SELECT amount a, status s, reason r FROM refunds WHERE order_id = ?', pb0.id).a === 150);
check('الأدمن والعميل اتبلّغوا بالاسترجاع', fcm.some((m) => m.token === tokens.admin1 && m.type === 'refund_due') && fcm.some((m) => m.token === tokens.cust3 && m.type === 'refund_pending'));
await bad('السواق مايقبلش طلب اتلغى', call('drv3', 'orders/accept', { orderId: pb0.id }), 409, 'order_not_open');
check('العميل يشوف حالة الاسترجاع', (await call('cust3', 'orders/get', { orderId: pb0.id })).order.refund.status === 'pending');
check('شارة الأدمن + رصيد الاسترجاع', (await call('admin1', 'admin/badges')).badges.refunds === 1 && (await call('admin1', 'admin/stats')).refundsDue === 150);
const rl = await ok('قائمة الاسترجاع', call('admin1', 'admin/refunds')); const rf1 = rl.refunds[0];
check('القائمة فيها العميل والمبلغ', rf1.customerName === 'عميل ثالث' && rf1.amount === 150 && rf1.status === 'pending' && rf1.customerPhone);
await bad('عميل يفتح قائمة الاسترجاع', call('cust3', 'admin/refunds'), 403);
await bad('عميل يعلّم الاسترجاع تم', call('cust3', 'admin/refund', { id: rf1.id }), 403);
fcm.length = 0; await ok('الأدمن حوّل الفلوس => تم', call('admin1', 'admin/refund', { id: rf1.id, note: 'InstaPay #123' }, envPush));
check('الاسترجاع اتقفل والعميل اتبلّغ', q1('SELECT status s FROM refunds WHERE id = ?', rf1.id).s === 'paid' && orderRow(pb0.id).escrow_status === 'refunded' && fcm.some((m) => m.token === tokens.cust3 && m.type === 'refund_paid'));
await bad('تأكيد الاسترجاع مرتين', call('admin1', 'admin/refund', { id: rf1.id }), 409, 'bad_state');
check('الشارة رجعت صفر', (await call('admin1', 'admin/badges')).badges.refunds === 0);
check('الطلب المستردّ خرج من المحجوز (بالظبط 150)', (await call('admin1', 'admin/stats')).totals.held === ovh - 150);

// ---- انتهاء الطلب المدفوع مقدماً بدون سواق => استرجاع تلقائي ----
const pc = await prepaidOpen();
DB.raw.prepare('UPDATE orders SET scheduled_at = ? WHERE id = ?').run(Date.now() - 2 * 3600e3, pc); // ميعاده فات من ساعتين
fcm.length = 0; await ok('سواق يفتح قائمة المتاح (بيشغّل فحص الانتهاء)', call('drv3', 'orders/list', { scope: 'available' }, envPush));
check('الطلب اتلغى تلقائياً + اتسجّل استرجاع (no_driver)', orderRow(pc).status === 'cancelled' && JSON.parse(orderRow(pc).data).cancelledBy === 'system' && q1('SELECT reason r FROM refunds WHERE order_id = ?', pc).r === 'no_driver');
check('العميل والأدمن اتبلّغوا', fcm.some((m) => m.token === tokens.cust3 && m.type === 'refund_pending') && fcm.some((m) => m.token === tokens.admin1 && m.type === 'refund_due'));
const pd = await prepaidOpen(); DB.raw.prepare('UPDATE orders SET scheduled_at = ? WHERE id = ?').run(Date.now() - 2 * 3600e3, pd);
const gd = await ok('العميل يفتح الطلب المنتهي', call('cust3', 'orders/get', { orderId: pd }, envPush));
check('الانتهاء بيتنفذ فوراً عند فتح الطلب ومعاه الاسترجاع', gd.order.status === 'cancelled' && gd.order.refund?.status === 'pending' && gd.order.refund.amount === 150);
const pe = await prepaidOpen(); DB.raw.prepare('UPDATE orders SET scheduled_at = ? WHERE id = ?').run(Date.now() - 10 * 60e3, pe);
await call('drv3', 'orders/list', { scope: 'available' }, envPush);
check('داخل المهلة (30 دقيقة): لسه مفتوح', orderRow(pe).status === 'open');
await ok('الأدمن يقلّل المهلة لـ 5 دقايق', call('admin1', 'admin/settings/save', { ...(await settingsNow()), prepaidGraceMin: 5 }));
await call('drv3', 'orders/list', { scope: 'available' }, envPush);
check('بعد تقليل المهلة اتنتهى', orderRow(pe).status === 'cancelled');
await call('admin1', 'admin/settings/save', { ...(await settingsNow()), prepaidGraceMin: 30 });
const pf0 = await prepaidOpen(); await ok('drv3 يقبل قبل الانتهاء', call('drv3', 'orders/accept', { orderId: pf0 }, envPush));
DB.raw.prepare('UPDATE orders SET scheduled_at = ? WHERE id = ?').run(Date.now() - 5 * 3600e3, pf0);
await call('drv4', 'orders/list', { scope: 'available' }, envPush);
check('الطلب اللي اتقبل مبيتنتهيش', orderRow(pf0).status === 'paid');
const pg = await prepaidOpen(); DB.raw.prepare('UPDATE orders SET scheduled_at = ? WHERE id = ?').run(Date.now() - 2 * 3600e3, pg);
await Promise.all([call('drv3', 'orders/list', { scope: 'available' }, envPush), call('cust3', 'orders/get', { orderId: pg }, envPush), call('drv4', 'orders/list', { scope: 'available' }, envPush)]);
check('انتهاء متزامن: استرجاع واحد بس (مفيش تكرار)', q1('SELECT COUNT(*) c FROM refunds WHERE order_id = ?', pg).c === 1 && orderRow(pg).status === 'cancelled');
check('ولا استرجاع للطلب المقبول', q1('SELECT COUNT(*) c FROM refunds WHERE order_id = ?', pf0).c === 0);
check('بشارة الأدمن: استرجاعات معلّقة', (await call('admin1', 'admin/badges')).badges.refunds >= 3);

// ---- الشات ----
const po = await prepaidOpen();
await bad('مفيش شات قبل ما سواق يتحدد (عرض)', call('cust3', 'chat/list', { orderId: po }), 409, 'chat_closed');
await bad('مفيش شات قبل ما سواق يتحدد (إرسال)', call('cust3', 'chat/send', { orderId: po, body: 'ألو' }), 409, 'chat_closed');
await ok('drv3 يقبل', call('drv3', 'orders/accept', { orderId: po }, envPush));
fcm.length = 0;
await ok('العميل يبعت رسالة', call('cust3', 'chat/send', { orderId: po, body: 'السلام عليكم، العمارة بجانب الصيدلية' }, envPush));
check('السواق اتبلّغ برسالة العميل باسمه', fcm.length === 1 && fcm[0].token === tokens.drv3 && fcm[0].type === 'chat' && fcm[0].title.includes('عميل ثالث') && fcm[0].body.includes('الصيدلية') && fcm[0].tag === `chat-${po}`);
await ok('السواق يرد', call('drv3', 'chat/send', { orderId: po, body: 'تمام، في الطريق' }, envPush));
const m1 = await ok('العميل يقرأ المحادثة', call('cust3', 'chat/list', { orderId: po }));
check('الرسايل بالترتيب مع mine/from', m1.messages.length === 2 && m1.messages[0].mine === true && m1.messages[0].from === 'customer' && m1.messages[1].from === 'driver' && m1.messages[1].mine === false && m1.open === true);
const m2 = await ok('قراءة الجديد بس (after)', call('cust3', 'chat/list', { orderId: po, after: m1.messages[0].seq }));
check('after بيرجّع اللي بعدها فقط', m2.messages.length === 1 && m2.messages[0].body === 'تمام، في الطريق');
check('مؤشر الشات في الطلب', (await call('cust3', 'orders/get', { orderId: po })).order.chat.count === 2);
await bad('عميل تاني ما يقرأش المحادثة', call('cust2', 'chat/list', { orderId: po }), 403, 'forbidden');
await bad('سواق تاني ما يبعتش', call('drv4', 'chat/send', { orderId: po, body: 'x' }), 403, 'forbidden');
check('الأدمن يقدر يقرأ', (await call('admin1', 'chat/list', { orderId: po })).messages.length === 2);
await bad('الأدمن ما يبعتش رسايل', call('admin1', 'chat/send', { orderId: po, body: 'مرحبا' }), 403);
await bad('رسالة فاضية', call('cust3', 'chat/send', { orderId: po, body: '   ' }), 400, 'bad_input');
await bad('رسالة طويلة', call('cust3', 'chat/send', { orderId: po, body: 'ا'.repeat(501) }), 400, 'bad_input');
const xss = await ok('رسالة فيها HTML بتتخزن كنص', call('cust3', 'chat/send', { orderId: po, body: '<img src=x onerror=alert(1)>' }));
check('النص متخزن كما هو (الواجهة بتعمل escape)', (await call('cust3', 'chat/list', { orderId: po })).messages.some((x) => x.body === '<img src=x onerror=alert(1)>'));
let lim = 0; for (let i = 0; i < 25; i++) if ((await call('drv3', 'chat/send', { orderId: po, body: 'رسالة ' + i })).status === 429) lim++;
check('حد الرسائل: 20 في الدقيقة', lim >= 1);
// الشات كدليل في النزاع
const dsp = await ok('العميل يفتح نزاع', call('cust3', 'disputes/create', { orderId: po, reason: 'delay', details: 'اتأخر' }, envPush));
await ok('الشات لسه شغال أثناء النزاع', call('cust3', 'chat/send', { orderId: po, body: 'لسه مجاش' }));
const dch = (await call('admin1', 'admin/disputes')).disputes.find((x) => x.id === dsp.id);
check('الأدمن يشوف المحادثة كدليل في النزاع', dch.chat.length >= 4 && dch.chat[0].from === 'customer' && dch.chat[0].body.includes('الصيدلية') && dch.chat.some((x) => x.from === 'driver'));
// الشات بيتقفل بعد اكتمال الطلب
const ph = await prepaidOpen(); await call('drv4', 'orders/accept', { orderId: ph }, envPush);
await call('cust3', 'chat/send', { orderId: ph, body: 'تمام' });
freshUploads(); await fin(ph, 'drv4', 'cust3', { e: envPush });
await bad('الشات مقفول بعد اكتمال الطلب', call('cust3', 'chat/send', { orderId: ph, body: 'شكراً' }), 409, 'chat_closed');
const hist = await ok('لكن السجل لسه متاح', call('drv4', 'chat/list', { orderId: ph })); check('السجل والحالة مقفولة', hist.messages.length === 1 && hist.open === false);
// حد رفع الصور: 30 في الساعة لكل مستخدم
freshUploads(); let up429 = 0; for (let i = 0; i < 32; i++) if ((await call('spammer1', 'files/upload', { kind: 'id', data: JPEG })).status === 429) up429++;
check('حد رفع الصور (30/ساعة) بيشتغل', up429 === 2 && q1("SELECT COUNT(*) c FROM files_meta WHERE owner = 'spammer1'").c === 30);
}


// ================== إلغاء برسوم بعد قبول السواق + اعتذار السواق + البلاغات + الطوارئ ==================
console.log('\n— الإلغاء برسوم والبلاغات والطوارئ —');
{
  DB.raw.prepare("UPDATE orders SET status = 'cancelled' WHERE customer_id = 'cust3' AND status IN ('open','accepted','payment_review','awaiting_payment')").run();
  await ok('رفع حد الإلغاء مؤقتاً (عشان الاختبار)', call('admin1', 'admin/settings/save', { ...(await settingsNow()), maxCancellations: 50 }));
  const fresh = () => DB.raw.prepare('UPDATE files_meta SET created_at = 1').run();
  const payConfirm2 = async (oid) => { fresh(); await call('cust3', 'orders/pay', { orderId: oid, proofRef: await up('cust3', 'payment') }, envPush); await call('admin1', 'admin/payment', { orderId: oid, action: 'confirm' }, envPush); };
  const prepaid2 = async (extra = {}) => { fresh(); const o = await call('cust3', 'orders/create', { ...base, size: 'small', prepay: true, photos: await cargo3(), ...extra }, envPush); assert.equal(o.status, 200, JSON.stringify(o)); await payConfirm2(o.id); return o.id; };
  const startTrip = async () => { fresh(); const o = await call('cust3', 'orders/create', pax({ vehicleClass: 'car', passengers: 2 }), envPush); assert.equal(o.status, 200, JSON.stringify(o)); await payConfirm2(o.id); await call('drvM', 'orders/accept', { orderId: o.id }, envPush); return o.id; };
  const settingsWith = async (patch) => call('admin1', 'admin/settings/save', { ...(await settingsNow()), ...patch });
  await call('drv3', 'driver/presence', { online: true, lat: 30.05, lng: 31.24 }); await call('drv4', 'driver/presence', { online: true, lat: 30.08, lng: 31.26 });

  // ---- الإلغاء برسوم: السواق قبل ولسه ما بدأش (10% للسواق + 5% للمنصة) ----
  const c0 = q1("SELECT cancel_count c FROM users WHERE uid='cust3'").c, stats0 = (await call('admin1', 'admin/stats')).totals;
  const w0 = wallet('drv3').balance, x1 = await prepaid2(); await ok('drv3 يقبل', call('drv3', 'orders/accept', { orderId: x1 }, envPush));
  check('الطلب بقى paid ومحجوز', orderRow(x1).status === 'paid' && orderRow(x1).escrow_status === 'held');
  fcm.length = 0;
  const cx1 = await ok('العميل يلغي بعد قبول السواق', call('cust3', 'orders/cancel', { orderId: x1, reason: 'غيرت رأيي' }, envPush));
  check('التقسيم: سواق 15 + منصة 8 + العميل 127 (مجموعهم 150)', cx1.driver === 15 && cx1.platform === 8 && cx1.refund === 127 && cx1.driver + cx1.platform + cx1.refund === 150);
  const o1 = orderRow(x1); check('الطلب ملغي والمبلغ مسوّى', o1.status === 'cancelled' && o1.escrow_status === 'settled' && o1.commission === 8 && o1.driver_net === 15 && o1.customer_refund === 127);
  check('تعويض السواق نزل في محفظته + حركة', wallet('drv3').balance === w0 + 15 && q1("SELECT amount a FROM wallet_tx WHERE order_id = ? AND type = 'cancel_compensation'", x1).a === 15);
  check('استرجاع العميل للباقي فقط (127)', q1('SELECT amount a, reason r FROM refunds WHERE order_id = ?', x1).a === 127 && q1('SELECT reason r FROM refunds WHERE order_id = ?', x1).r === 'cancelled_after_accept');
  check('الإشعارات: السواق (تعويض) + العميل + الأدمن', fcm.some((m) => m.token === tokens.drv3 && m.type === 'cancel_comp' && m.body.includes('15')) && fcm.some((m) => m.token === tokens.cust3 && m.type === 'refund_pending' && m.body.includes('127')) && fcm.some((m) => m.token === tokens.admin1 && m.type === 'refund_due'));
  check('الإلغاء اتحسب على العميل', q1("SELECT cancel_count c FROM users WHERE uid='cust3'").c === c0 + 1);
  const stats1 = (await call('admin1', 'admin/stats')).totals;
  check('رسوم الإلغاء دخلت الإيراد والعمولات (23 و8)', stats1.revenue - stats0.revenue === 23 && stats1.commission - stats0.commission === 8);
  const rf = (await call('admin1', 'admin/refunds')).refunds.find((r) => r.orderId === x1); await ok('الأدمن يحوّل الباقي', call('admin1', 'admin/refund', { id: rf.id }));
  check('بعد تحويل الاسترجاع الإيراد ما اتغيّرش (الحالة settled)', orderRow(x1).escrow_status === 'settled' && (await call('admin1', 'admin/stats')).totals.revenue === stats1.revenue);

  // ---- السواق في الطريق (30% + 10%) ----
  const x2 = await prepaid2(); await call('drv3', 'orders/accept', { orderId: x2 }, envPush); await ok('في الطريق', call('drv3', 'orders/status', { orderId: x2, next: 'heading_pickup' }));
  const cx2 = await ok('العميل يلغي والسواق في الطريق', call('cust3', 'orders/cancel', { orderId: x2 }, envPush));
  check('التقسيم: سواق 45 + منصة 15 + العميل 90', cx2.driver === 45 && cx2.platform === 15 && cx2.refund === 90);
  // ---- بعد الاستلام ممنوع (نزاع) ----
  const x3 = await prepaid2(); await call('drv3', 'orders/accept', { orderId: x3 }, envPush); await call('drv3', 'orders/status', { orderId: x3, next: 'heading_pickup' }); fresh();
  await ok('استلام', call('drv3', 'orders/status', { orderId: x3, next: 'picked_up', photoRef: await up('drv3', 'handover'), loc: CAIRO }));
  await bad('الإلغاء بعد الاستلام ممنوع', call('cust3', 'orders/cancel', { orderId: x3 }), 409, 'cannot_cancel');
  // ---- النسب من الأدمن ----
  await bad('نسب غلط (مجموعها أكتر من 100)', settingsWith({ cancelPaidDriverPct: 80, cancelPaidPlatformPct: 30 }), 400, 'bad_input');
  await ok('الأدمن يخلّي الإلغاء بدون رسوم', settingsWith({ cancelPaidDriverPct: 0, cancelPaidPlatformPct: 0 }));
  const x4 = await prepaid2(); await call('drv4', 'orders/accept', { orderId: x4 }, envPush); const w4 = wallet('drv4').balance; fcm.length = 0;
  const cx4 = await ok('إلغاء بدون رسوم', call('cust3', 'orders/cancel', { orderId: x4 }, envPush));
  check('استرجاع كامل 150 وبدون تعويض', cx4.refund === 150 && cx4.driver === 0 && wallet('drv4').balance === w4 && q1('SELECT amount a FROM refunds WHERE order_id = ?', x4).a === 150 && fcm.some((m) => m.token === tokens.drv4 && m.type === 'cancel_plain'));
  await ok('الأدمن يخلّيها 20% للسواق و10% للمنصة', settingsWith({ cancelPaidDriverPct: 20, cancelPaidPlatformPct: 10 }));
  // ---- دفع بعد القبول (مش مقدم) بنفس القاعدة بعد تأكيد الدفع ----
  fresh(); const px = await ok('طلب عادي', call('cust3', 'orders/create', { ...base, size: 'small', photos: await cargo3() })); await call('drv3', 'orders/accept', { orderId: px.id }, envPush);
  const cxa = await ok('إلغاء قبل الدفع (حالة accepted): من غير رسوم', call('cust3', 'orders/cancel', { orderId: px.id }));
  check('قبل الدفع مفيش رسوم ولا استرجاع', cxa.refund === false && cxa.fee === undefined && q1('SELECT COUNT(*) c FROM refunds WHERE order_id = ?', px.id).c === 0);
  fresh(); const py = await ok('طلب عادي 2', call('cust3', 'orders/create', { ...base, size: 'small', photos: await cargo3() })); await call('drv3', 'orders/accept', { orderId: py.id }, envPush); await payConfirm2(py.id);
  const cxb = await ok('إلغاء بعد الدفع (paid): رسوم 20% + 10%', call('cust3', 'orders/cancel', { orderId: py.id }, envPush));
  check('التقسيم 30 + 15 + 105', cxb.driver === 30 && cxb.platform === 15 && cxb.refund === 105);
  await settingsWith({ cancelPaidDriverPct: 10, cancelPaidPlatformPct: 5 });

  // ---- السواق يعتذر عن طلب مدفوع: بيرجع مفتوح لسواقين تانيين والمبلغ محجوز ----
  const x5 = await prepaid2(); await call('drv3', 'orders/accept', { orderId: x5 }, envPush); const dc0 = q1("SELECT cancel_count c FROM users WHERE uid='drv3'").c; fcm.length = 0;
  await ok('السواق يعتذر', call('drv3', 'orders/cancel', { orderId: x5, reason: 'عطل في العربية' }, envPush));
  const o5 = orderRow(x5), d5 = JSON.parse(o5.data);
  check('الطلب رجع مفتوح ومحجوز وبدون سواق (وسعر ثابت)', o5.status === 'open' && o5.escrow_status === 'held' && o5.driver_id === null && d5.instant === true && d5.driverName === null);
  check('اتحسب على السواق + العميل اتبلّغ + اتبعت لسواقين تانيين', q1("SELECT cancel_count c FROM users WHERE uid='drv3'").c === dc0 + 1 && fcm.some((m) => m.token === tokens.cust3 && m.type === 'driver_cancelled') && fcm.some((m) => m.type === 'new_order' && m.token === tokens.drv4));
  await ok('سواق تاني يقبل', call('drv4', 'orders/accept', { orderId: x5 }, envPush));
  check('الطلب بقى paid مع drv4', orderRow(x5).status === 'paid' && orderRow(x5).driver_id === 'drv4');
  await call('drv4', 'orders/status', { orderId: x5, next: 'heading_pickup' }); fresh();
  await ok('استلام', call('drv4', 'orders/status', { orderId: x5, next: 'picked_up', photoRef: await up('drv4', 'handover'), loc: CAIRO }));
  await bad('السواق ما يعتذرش بعد الاستلام', call('drv4', 'orders/cancel', { orderId: x5 }), 409, 'cannot_cancel');

  // ---- البلاغات ----
  await call('cust3', 'chat/send', { orderId: x5, body: 'إنت فين؟' }); await call('drv4', 'chat/send', { orderId: x5, body: 'ألفاظ مسيئة هنا' });
  fcm.length = 0;
  const rp = await ok('العميل يبلّغ عن السواق', call('cust3', 'reports/create', { orderId: x5, reason: 'harassment', details: 'ألفاظ مسيئة في الشات' }, envPush));
  const rrow = q1('SELECT * FROM reports WHERE id = ?', rp.id);
  check('البلاغ على السواق ومعاه لقطة الشات', rrow.target_id === 'drv4' && rrow.reporter_id === 'cust3' && JSON.parse(rrow.context).chat.length === 2 && JSON.parse(rrow.context).chat[1].from === 'driver');
  check('الأدمن اتبلّغ', fcm.some((m) => m.token === tokens.admin1 && m.type === 'report' && m.body.includes('عميل ثالث')));
  await bad('غير المشتركين ما يبلّغوش', call('cust2', 'reports/create', { orderId: x5, reason: 'abuse' }), 403, 'forbidden');
  await bad('سبب غلط', call('cust3', 'reports/create', { orderId: x5, reason: 'xx' }), 400, 'bad_reason');
  const noDrv = await prepaid2(); await bad('مفيش بلاغ قبل ما سواق يتحدد', call('cust3', 'reports/create', { orderId: noDrv, reason: 'abuse' }), 409, 'bad_state');
  await ok('السواق يبلّغ عن العميل', call('drv4', 'reports/create', { orderId: x5, reason: 'no_show' }));
  check('الهدف هو العميل', q1("SELECT target_id t FROM reports WHERE reporter_id = 'drv4' ORDER BY created_at DESC").t === 'cust3');
  let rl = 0; for (let i = 0; i < 6; i++) if ((await call('cust3', 'reports/create', { orderId: x5, reason: 'other' })).status === 429) rl++;
  check('حد البلاغات: 5 في الساعة', rl >= 1);
  await bad('عميل يفتح بلاغات الأدمن', call('cust3', 'admin/reports'), 403);
  const ar = await ok('الأدمن يفتح البلاغات', call('admin1', 'admin/reports'));
  const rep1 = ar.reports.find((r) => r.id === rp.id);
  check('البلاغ فيه الأسماء والأرقام والشات', rep1.reporter.name === 'عميل ثالث' && rep1.target.name === 'سواق نص نقل' && rep1.target.phone && rep1.context.chat.length === 2 && rep1.status === 'open');
  check('شارة الأدمن للبلاغات', (await call('admin1', 'admin/badges')).badges.reports >= 2);
  fcm.length = 0; await ok('الأدمن يحسم البلاغ', call('admin1', 'admin/report', { id: rp.id, action: 'resolve', note: 'تم تحذير السواق' }, envPush));
  check('المُبلّغ اتبلّغ بالمراجعة', q1('SELECT status s FROM reports WHERE id = ?', rp.id).s === 'resolved' && fcm.some((m) => m.token === tokens.cust3 && m.type === 'report_handled'));
  await bad('حسم مرتين', call('admin1', 'admin/report', { id: rp.id, action: 'dismiss' }), 409, 'bad_state');
  await bad('إجراء غلط', call('admin1', 'admin/report', { id: ar.reports.find((r) => r.status === 'open').id, action: 'zz' }), 400, 'bad_action');

  // ---- زر الطوارئ (ركاب فقط وأثناء الرحلة) ----
  const trip = await startTrip();
  await bad('الطوارئ قبل بداية الرحلة', call('cust3', 'sos/trigger', { orderId: trip, lat: 30.04, lng: 31.23 }), 409, 'bad_state');
  await call('drvM', 'orders/status', { orderId: trip, next: 'heading_pickup' }, envPush);
  await bad('الطوارئ لطلب بضاعة', call('cust3', 'sos/trigger', { orderId: x5 }), 409, 'bad_state');
  await bad('غير المشتركين', call('cust2', 'sos/trigger', { orderId: trip }), 403, 'forbidden');
  await bad('موقع خارج مصر', call('cust3', 'sos/trigger', { orderId: trip, lat: 10, lng: 10 }), 400, 'outside_egypt');
  fcm.length = 0;
  const sos = await ok('العميل يضغط الطوارئ', call('cust3', 'sos/trigger', { orderId: trip, lat: 30.046, lng: 31.237 }, envPush));
  check('بيرجّع أرقام الطوارئ والأدمن اتبلّغ فوراً', sos.emergency.police === '122' && sos.emergency.ambulance === '123' && fcm.some((m) => m.token === tokens.admin1 && m.type === 'sos' && m.body.includes('عميل ثالث')));
  fcm.length = 0; const sos2 = await ok('ضغطة تانية بسرعة', call('cust3', 'sos/trigger', { orderId: trip, lat: 30.047, lng: 31.238 }, envPush));
  check('نفس الاستغاثة (تحديث الموقع بس) ومن غير إزعاج مكرر', sos2.id === sos.id && fcm.length === 0 && q1('SELECT lat l FROM sos_events WHERE id = ?', sos.id).l === 30.047);
  await ok('السواق كمان يقدر يضغط', call('drvM', 'sos/trigger', { orderId: trip }, envPush));
  const as = await ok('الأدمن يشوف الاستغاثات', call('admin1', 'admin/reports')); const ev = as.sos.find((e) => e.id === sos.id);
  check('الاستغاثة فيها الموقع وأرقام العميل والسواق والمسار', ev.lat === 30.047 && ev.by.name === 'عميل ثالث' && ev.customer.phone && ev.driver.phone && ev.driver.name === 'سواق ميكروباص' && ev.pickup?.lat && ev.status === 'open');
  check('الاستغاثات المفتوحة في الشارة وفي أول القائمة', as.sos[0].status === 'open' && (await call('admin1', 'admin/badges')).badges.reports >= 3);
  await ok('الأدمن يعلّم "تم التعامل"', call('admin1', 'admin/sos-handle', { id: sos.id, note: 'اتصلت بالعميل والسواق' }));
  await bad('تكرار', call('admin1', 'admin/sos-handle', { id: sos.id }), 409, 'bad_state');
  await bad('عميل يعلّم استغاثة', call('cust3', 'admin/sos-handle', { id: sos.id }), 403);
  // حد الاستغاثات: 3 في الساعة لكل مستخدم (على رحلات مختلفة)
  const now_ = Date.now(); for (let i = 0; i < 2; i++) DB.raw.prepare("INSERT INTO sos_events(id, order_id, user_id, status, created_at, updated_at) VALUES(?,?,?,'handled',?,?)").run('fakesos' + i + 'aaaaaaaaaaaaaa', 'x', 'cust3', now_, now_);
  const trip2 = await startTrip(); await call('drvM', 'orders/status', { orderId: trip2, next: 'heading_pickup' });
  await bad('حد الاستغاثات', call('cust3', 'sos/trigger', { orderId: trip2 }), 429, 'too_many_reports');
  await ok('إعادة ضبط حد الإلغاء', call('admin1', 'admin/settings/save', { ...(await settingsNow()), maxCancellations: 5 }));
}

console.log(`\n✅ كل الاختبارات نجحت (${pass})`);
