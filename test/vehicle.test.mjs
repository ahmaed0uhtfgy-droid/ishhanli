// اختبار المرافقة وترشيح العربيات (تحكم الأدمن): حقل companion، العربية المختارة vehiclePick، حجم الجامبو، إعدادات الأدمن والتحقق — Firestore وهمي.
import assert from 'node:assert/strict';
import { webcrypto as crypto } from 'node:crypto';
import { onRequest } from '../functions/api/[[route]].js';
import { JWKS_URL } from '../functions/_lib/core.js';
import { trustOf } from '../functions/_lib/trust.js';
import { recommendVehicle, canServe } from '../functions/_lib/logic.js';
import * as clientEst from '../public/js/estimate.js';
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

const mkU = (uid, role, extra = {}) => FS.put(`users/${uid}`, { uid, role, status: 'active', name: uid, phone: '010' + Math.floor(10000000 + Math.random() * 89999999), national_id: String(Math.random()).slice(2, 16), rating_sum: 0, rating_count: 0, completed_orders: 0, cancel_count: 0, created_at: Date.now(), ...extra });
mkU('admin1', 'admin'); mkU('cV', 'customer');
const cur = (await call('cV', 'settings')).settings;
const save = (p) => call('admin1', 'admin/settings/save', { ...cur, ...p });
const dataOf = (oid) => JSON.parse(orderRow(oid).data || '{}');
const ALIVE = ['open', 'accepted', 'paid', 'heading_pickup', 'picked_up', 'in_transit', 'payment_review', 'awaiting_payment', 'delivered'];
const make = async (extra = {}) => { clearRl(); cancelAll('cV', ALIVE); return call('cV', 'orders/create', { pickup: CAIRO, dropoff: GIZA, category: 'goods', size: 'small', weightKg: 100, scheduledAt: new Date(Date.now() + 3600e3).toISOString(), description: 'كراتين أدوات منزلية 4 قطع', photos: [await up('cV', 'cargo')], ...extra }); };

// ===== 1) الافتراضيات =====
check('الترشيح والمرافقة مفعّلين افتراضياً', cur.companionAsk === true && cur.vehicleGuideOn === true);
check('جدول العربيات الافتراضي: ربع نقل 800 / نص نقل 2000 / نقل ثقيل 8000 / جامبو 50000', cur.vehicleGuide.pickup.maxKg === 800 && cur.vehicleGuide.half_ton.maxKg === 2000 && cur.vehicleGuide.truck.maxKg === 8000 && cur.vehicleGuide.jumbo.maxKg === 50000);
check('حجم الجامبو موجود بمعامل 3', cur.sizes.xlarge?.mult === 3 && cur.vehicleGuide.jumbo.size === 'xlarge');

// ===== 2) ترشيح العربية (وحدة) =====
{ const g = cur.vehicleGuide;
  const cases = [[1, 'pickup'], [800, 'pickup'], [801, 'half_ton'], [2000, 'half_ton'], [2001, 'truck'], [8000, 'truck'], [8001, 'jumbo'], [50000, 'jumbo'], [99999, 'jumbo']];
  for (const [kg, want] of cases) check(`ترشيح ${kg} كجم = ${want}`, recommendVehicle(g, kg) === want);
  check('نسخة الواجهة مطابقة للسيرفر لكل الأوزان', [0, 1, 500, 800, 801, 1999, 2001, 7999, 8001, 49999, 100000, NaN, -5].every((kg) => clientEst.recommendVehicle(g, kg) === recommendVehicle(g, kg)));
  const noPickup = { ...g, pickup: { ...g.pickup, maxKg: 0 } };
  check('عربية متوقفة (0) بتتخطّى: 100 كجم = نص نقل', recommendVehicle(noPickup, 100) === 'half_ton');
  const allOff = Object.fromEntries(Object.keys(g).map((k) => [k, { ...g[k], maxKg: 0 }]));
  check('كلهم متوقفين = مفيش ترشيح', recommendVehicle(allOff, 100) === null);
  check('وزن غير صالح = أكبر عربية مفعّلة', recommendVehicle(g, NaN) === 'jumbo'); }

// ===== 3) مين يخدم إيه =====
check('ربع نقل مايخدمش الجامبو', canServe('pickup', { service: 'cargo', size: 'xlarge' }) === false);
check('نص نقل مايخدمش الجامبو', canServe('half_ton', { service: 'cargo', size: 'xlarge' }) === false);
check('النقل الثقيل والجامبو يخدموا الجامبو', canServe('truck', { service: 'cargo', size: 'xlarge' }) && canServe('jumbo', { service: 'cargo', size: 'xlarge' }));
check('الجامبو يخدم كل الأحجام', ['small', 'medium', 'large', 'xlarge'].every((z) => canServe('jumbo', { service: 'cargo', size: z })));

// ===== 4) المرافقة =====
{ const a = await ok('طلب: العميل هيرافق', make({ companion: true })); check('companion=true متخزّن', dataOf(a.id).companion === true);
  const b = await ok('طلب: العميل مش هيرافق', make({ companion: false })); check('companion=false متخزّن', dataOf(b.id).companion === false);
  const c = await ok('طلب من غير الحقل', make()); check('من غير الحقل = null (ما اتسألش)', dataOf(c.id).companion === null);
  const d = await ok('قيمة مش منطقية', make({ companion: 'yes' })); check('قيمة مش boolean بتتتجاهل = null', dataOf(d.id).companion === null);
  await ok('الأدمن يقفل سؤال المرافقة', save({ companionAsk: false }));
  const e = await ok('طلب والسؤال مقفول', make({ companion: true })); check('السؤال مقفول = null حتى لو اتبعت true', dataOf(e.id).companion === null);
  await ok('الأدمن يفتحه تاني', save({ companionAsk: true })); }

// ===== 5) العربية المختارة =====
{ const a = await ok('ربع نقل + حجم صغير', make({ vehiclePick: 'pickup', size: 'small' })); check('vehiclePick متخزّن', dataOf(a.id).vehiclePick === 'pickup');
  const n = await ok('من غير اختيار', make()); check('من غير اختيار = null', dataOf(n.id).vehiclePick === null);
  await bad('ربع نقل + حجم متوسط = مش متطابق', make({ vehiclePick: 'pickup', size: 'medium' }), 400, 'bad_vehicle');
  await bad('عربية مش موجودة', make({ vehiclePick: 'rocket', size: 'small' }), 400, 'bad_vehicle');
  const j = await ok('جامبو + حجم جامبو', make({ vehiclePick: 'jumbo', size: 'xlarge' })); check('الجامبو متخزّن', dataOf(j.id).vehiclePick === 'jumbo' && dataOf(j.id).size === 'xlarge');
  const L = await ok('نقل ثقيل', make({ vehiclePick: 'truck', size: 'large' }));
  check('سعر الجامبو أعلى من النقل الثقيل (معامل 3 مقابل 2)', j.price > L.price);
  await ok('الأدمن يوقف الترشيح', save({ vehicleGuideOn: false }));
  const off = await ok('طلب والترشيح مقفول', make({ vehiclePick: 'pickup', size: 'small' })); check('الترشيح مقفول = الاختيار بيتتجاهل', dataOf(off.id).vehiclePick === null);
  await ok('الأدمن يفتحه', save({ vehicleGuideOn: true })); }

// ===== 6) تحكم الأدمن والتحقق =====
{ const g = cur.vehicleGuide;
  await bad('عميل مايعدّلش الإعدادات', call('cV', 'admin/settings/save', { ...cur }), 403, 'forbidden');
  await ok('الأدمن يغيّر أوزان ربع النقل', save({ vehicleGuide: { ...g, pickup: { maxKg: 1000, size: 'small' } } }));
  { const s = (await call('cV', 'settings')).settings; check('التعديل ظاهر للعميل', s.vehicleGuide.pickup.maxKg === 1000 && recommendVehicle(s.vehicleGuide, 900) === 'pickup'); }
  await bad('أوزان مش مرتبة (ربع نقل أكبر من نص نقل)', save({ vehicleGuide: { ...g, pickup: { maxKg: 3000, size: 'small' } } }), 400, 'bad_input');
  await bad('حجم مش موجود في جدول الأحجام', save({ vehicleGuide: { ...g, truck: { maxKg: 8000, size: 'nope' } } }), 400, 'bad_input');
  await bad('وزن سالب', save({ vehicleGuide: { ...g, truck: { maxKg: -5, size: 'large' } } }), 400, 'bad_input');
  await ok('عربية متوقفة (0) مسموح', save({ vehicleGuide: { ...g, pickup: { maxKg: 0, size: 'small' } } }));
  await bad('العربية المتوقفة مش مقبولة كاختيار', make({ vehiclePick: 'pickup', size: 'small' }), 400, 'bad_vehicle');
  await ok('الأدمن يغيّر معامل الجامبو', save({ vehicleGuide: g, sizes: { ...cur.sizes, xlarge: { ...cur.sizes.xlarge, mult: 4 } } }));
  check('معامل الجامبو الجديد اتحفظ', (await call('cV', 'settings')).settings.sizes.xlarge.mult === 4);
  await ok('إعادة الإعدادات الأصلية', save({ vehicleGuide: g, sizes: cur.sizes })); }


// ===== 7) صورة العربية: بتظهر في العروض قبل القبول، وفي الطلب بعد القبول =====
{ mkU('drvVeh', 'driver', { name: 'سواق الصور', vehicle_type: 'half_ton' });
  const vref = await up('drvVeh', 'vehiclePhoto'), idr = await up('drvVeh', 'id'); FS.patch('users/drvVeh', { vehicle_photo_ref: vref, id_ref: idr });
  const a = await ok('طلب للعروض', make({ size: 'small' }));
  await ok('السواق يقدّم عرض', call('drvVeh', 'offers/create', { orderId: a.id, price: a.price, agree: true }));
  const v = (await ok('العميل يشوف الطلب', call('cV', 'orders/get', { orderId: a.id }))).order;
  check('العرض فيه صورة العربية قبل القبول', v.offers?.length === 1 && v.offers[0].vehiclePhotoRef === vref);
  check('العرض مفيهوش رقم السواق ولا هويته', !JSON.stringify(v.offers[0]).match(/phone|national|id_ref|idRef/i));
  await ok('العميل يقبل العرض', call('cV', 'offers/accept', { offerId: v.offers[0].id }));
  const after = (await ok('الطلب بعد القبول', call('cV', 'orders/get', { orderId: a.id }))).order;
  check('بعد القبول العميل شايف صورة عربية السواق ونوعها', after.driverVehiclePhoto === vref && after.driverVehicle === 'half_ton'); }

// ===== 8) رسمات العربيات (وحدة) =====
{ const { vehicleSvg, vehicleImgKey } = await import('../public/js/vehicles.js');
  for (const k of ['pickup', 'half_ton', 'truck', 'jumbo', 'passengers', 'car', 'van', 'microbus', 'minibus', 'tuktuk', 'reefer', 'flatbed', 'tanker', 'dump', 'curtain', 'carcarrier', 'غريب']) { const x = vehicleSvg(k); check(`رسمة ${k} صالحة`, x.startsWith('<svg') && x.endsWith('</svg>') && x.includes('class="wheel"')); }
  check('كل نوع من الأربعة رسمته مختلفة', new Set(['pickup', 'half_ton', 'truck', 'jumbo'].map((k) => vehicleSvg(k))).size === 4);
  const { VEHICLE_SHAPES } = await import('../public/js/vehicles.js'), { DICT } = await import('../public/js/i18n.js');
  const uniq = VEHICLE_SHAPES.filter((k) => k !== 'passengers'); // passengers = نفس رسمة الميكروباص
  check('16 مفتاح (15 رسمة مختلفة + رسمة الركاب = الميكروباص)', VEHICLE_SHAPES.length === 16 && ['tuktuk', 'reefer', 'flatbed', 'tanker', 'dump', 'curtain', 'carcarrier', 'car', 'van', 'minibus'].every((k) => VEHICLE_SHAPES.includes(k)));
  check('كل الأشكال رسمتها مختلفة عن بعض', new Set(uniq.map((k) => vehicleSvg(k))).size === uniq.length);
  check('كل شكل ليه اسم عربي وإنجليزي', uniq.every((k) => DICT.ar['vehicle.' + k] && DICT.en['vehicle.' + k]));
  check('رسمة الركاب = الميكروباص', vehicleSvg('passengers') === vehicleSvg('microbus'));
  check('السيارة والفان والميني باص ليهم رسمة خاصة', ['car', 'van', 'minibus'].every((k) => vehicleImgKey(k) === k));
  check('النوع الغريب بيرجع لرسمة افتراضية', vehicleImgKey('xyz') === 'half_ton');
  check('مفيش ألوان ثابتة (الثيم فاتح/ليلي)', !/#[0-9a-f]{3,6}|rgb\(/i.test(vehicleSvg('jumbo')));
  check('الاسم بيتنضّف من الرموز الخطرة (XSS)', !vehicleSvg('truck', '"><script>x</script>').includes('<script>')); }

console.log(`\n✅ اختبارات المرافقة وترشيح العربيات نجحت (${pass} فحص)`);
