// المسار الكامل عبر HTTP على سيرفر الاختبار: تسجيل ← دخول ← إنشاء طلب ← قبول ← دفع ← تتبع ← تسليم ← تأكيد/تحرير ← محفظة.
// من غير متصفح، فبيشتغل في أي بيئة. الحسابات والبيانات كلها في الذاكرة.
import { test, expect, request as pwRequest } from '@playwright/test';

const JPEG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(400, 7)]).toString('base64');
const CAIRO = { lat: 30.0444, lng: 31.2357, address: 'وسط البلد' }, GIZA = { lat: 30.0131, lng: 31.2089, address: 'الجيزة' };
const run = Date.now().toString(36);

test.describe.configure({ mode: 'serial' });

async function account(request, email, password = 'Passw0rd!') {
  const r = await request.post('/__e2e/auth', { data: { op: 'signup', email, password } }); expect(r.status()).toBe(200);
  const { uid } = await r.json(); return { uid, email, password, token: async () => (await (await request.get(`/__e2e/token?uid=${uid}&email=${email}`)).json()).token };
}
const api = (request) => async (who, route, data = {}) => { const r = await request.post('/api/' + route, { headers: { Authorization: 'Bearer ' + (await who.token()) }, data }); return { ...(await r.json().catch(() => ({}))), status: r.status() }; };

let R, call, cust, drv, admin;
test.beforeAll(async ({ baseURL }) => {
  R = await pwRequest.newContext({ baseURL }); // سياق مستقل (fixture الـrequest ما ينفعش يتعاد استخدامه من beforeAll)
  call = api(R);
  cust = await account(R, `cust-${run}@e2e.test`); drv = await account(R, `drv-${run}@e2e.test`);
  admin = { token: async () => (await (await R.get('/__e2e/token?uid=uid-admin')).json()).token };
});
test.afterAll(async () => { await R.dispose(); });

test('تسجيل عميل وسواق', async () => {
  const idc = await call(cust, 'files/upload', { kind: 'id', data: JPEG }); expect(idc.status).toBe(200);
  expect((await call(cust, 'register', { role: 'customer', name: 'عميل اختبار', phone: '01011112222', idRef: idc.ref })).status).toBe(200);
  const f = async (k) => (await call(drv, 'files/upload', { kind: k, data: JPEG })).ref;
  const reg = await call(drv, 'register', { role: 'driver', name: 'سواق اختبار', phone: '01233334444', nationalId: '28501011234567', vehicleType: 'pickup', idRef: await f('id'), licenseRef: await f('license'), vehicleRegRef: await f('vehicle'), vehiclePhotoRef: await f('vehiclePhoto') });
  expect(reg.status).toBe(200);
  expect((await call(cust, 'me')).profile.status).toBe('active');
  expect((await call(drv, 'me')).profile.status).toBe('pending');
});

test('السواق المعلّق ما يشوفش طلبات، والأدمن يفعّله', async () => {
  expect((await call(drv, 'orders/list', { scope: 'available' })).status).toBe(403);
  expect((await call(cust, 'admin/user', { uid: drv.uid, status: 'active' })).status).toBe(403);
  expect((await call(admin, 'admin/user', { uid: drv.uid, status: 'active' })).status).toBe(200);
});

let oid, price;
test('إنشاء طلب وقبوله', async () => {
  const cargo = (await call(cust, 'files/upload', { kind: 'cargo', data: JPEG })).ref;
  const q = await call(cust, 'quote', { pickup: CAIRO, dropoff: GIZA, category: 'goods', size: 'small' }); expect(q.status).toBe(200); expect(q.price).toBeGreaterThan(0);
  const o = await call(cust, 'orders/create', { pickup: CAIRO, dropoff: GIZA, category: 'goods', size: 'small', weightKg: 200, description: 'كراتين أدوات منزلية 4 قطع', photos: [cargo], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
  expect(o.status).toBe(200); oid = o.id; price = o.price; expect(price).toBeGreaterThanOrEqual(q.price);
  const noLoc = await call(drv, 'orders/list', { scope: 'available' }); expect(noLoc.orders).toEqual([]); expect(noLoc.needLocation).toBe(true); // من غير موقع: مفيش طلبات (نطاق الخدمة)
  expect((await call(drv, 'orders/list', { scope: 'available', loc: { lat: 31.2, lng: 29.9 } })).orders.some((x) => x.id === oid)).toBe(false); // سواق في إسكندرية: برّه النطاق
  expect((await call(drv, 'orders/list', { scope: 'available', loc: CAIRO })).orders.some((x) => x.id === oid)).toBe(true);
  expect((await call(drv, 'orders/accept', { orderId: oid, agree: true, loc: CAIRO })).status).toBe(200);
});

test('دفع وتأكيد الأدمن ثم تتبع الرحلة', async () => {
  const proof = (await call(cust, 'files/upload', { kind: 'payment', data: JPEG })).ref;
  expect((await call(cust, 'orders/pay', { orderId: oid, proofRef: proof, reference: '12345' })).status).toBe(200);
  expect((await call(drv, 'orders/status', { orderId: oid, next: 'heading_pickup' })).status).toBe(409);
  expect((await call(admin, 'admin/payment', { orderId: oid, action: 'confirm' })).status).toBe(200);
  expect((await call(drv, 'orders/status', { orderId: oid, next: 'heading_pickup' })).status).toBe(200);
  const hand = (await call(drv, 'files/upload', { kind: 'handover', data: JPEG })).ref;
  expect((await call(drv, 'orders/status', { orderId: oid, next: 'picked_up', photoRef: hand, loc: { lat: 31.2, lng: 29.9 } })).status).toBe(403);
  expect((await call(drv, 'orders/status', { orderId: oid, next: 'picked_up', photoRef: hand, loc: CAIRO })).status).toBe(200);
  expect((await call(drv, 'orders/location', { orderId: oid, lat: 30.04, lng: 31.23, acc: 10 })).status).toBe(200);
  expect((await call(cust, 'orders/get', { orderId: oid })).location?.lat).toBeCloseTo(30.04, 5);
  expect((await call(drv, 'orders/status', { orderId: oid, next: 'in_transit' })).status).toBe(200);
  const hand2 = (await call(drv, 'files/upload', { kind: 'handover', data: JPEG })).ref;
  expect((await call(drv, 'orders/status', { orderId: oid, next: 'delivered', photoRef: hand2, loc: GIZA })).status).toBe(200);
});

test('تأكيد العميل يحرّر الفلوس مرة واحدة والمحفظة صح', async () => {
  expect((await call(drv, 'orders/confirm', { orderId: oid })).status).toBe(403);
  const c = await call(cust, 'orders/confirm', { orderId: oid }); expect(c.status).toBe(200);
  expect(c.commission + c.net).toBe(price);
  expect((await call(cust, 'orders/confirm', { orderId: oid })).status).toBe(409);
  const w = await call(drv, 'wallet'); expect(w.status).toBe(200); expect(JSON.stringify(w)).toContain(String(c.net));
  expect((await call(cust, 'orders/rate', { orderId: oid, stars: 5 })).status).toBe(200);
});

test('عزل: غير الأطراف ما يشوفوش الطلب، وتوكن مزوّر يترفض', async () => {
  const request = R; const stranger = await account(request, `x-${run}@e2e.test`);
  await call(stranger, 'register', { role: 'customer', name: 'غريب', phone: '01555556666', idRef: (await call(stranger, 'files/upload', { kind: 'id', data: JPEG })).ref });
  expect([403, 404]).toContain((await call(stranger, 'orders/get', { orderId: oid })).status);
  const r = await request.post('/api/me', { headers: { Authorization: 'Bearer ' + (await cust.token()).slice(0, -5) + 'AAAAA' } }); expect(r.status()).toBe(401);
});

test('الصفحة الرئيسية والملفات الثابتة', async () => {
  const request = R;
  const r = await request.get('/'); expect(r.status()).toBe(200); expect(await r.text()).toContain('اشحنلي');
  for (const p of ['/js/app.js', '/css/app.css', '/manifest.webmanifest', '/robots.txt']) expect((await request.get(p)).status(), p).toBe(200);
  expect((await request.get('/api/health')).status()).toBe(200);
});
