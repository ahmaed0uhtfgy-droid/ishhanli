import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { boot, routeNames } from '../helpers/harness.mjs';

let h; const ROUTES = routeNames();
beforeAll(async () => {
  h = await boot();
  h.user('admin1', { role: 'admin' }); h.user('cust1', { role: 'customer' }); h.user('cust2', { role: 'customer' }); h.user('drv1', { role: 'driver', vehicle_type: 'pickup' });
});
afterAll(() => h.restore());

describe('اكتشاف المسارات', () => { it('لقى مسارات كتير بما فيها الأدمن', () => { expect(ROUTES.length).toBeGreaterThan(90); expect(ROUTES).toContain('orders/create'); expect(ROUTES.filter((r) => r.startsWith('admin/')).length).toBeGreaterThan(30); }); });

describe('التوثيق (JWT)', () => {
  const q = (token) => h.raw('me', { token });
  it('بدون توكن → 401', async () => { expect((await h.raw('me')).status).toBe(401); });
  it('توكن صحيح → 200', async () => { expect((await q(await h.idToken('cust1'))).status).toBe(200); });
  it('توقيع معدّل → 401', async () => { const t = await h.idToken('cust1'); expect((await q(t.slice(0, -4) + 'AAAA')).status).toBe(401); });
  it('payload معدّل (تغيير uid) بنفس التوقيع → 401', async () => {
    const t = (await h.idToken('cust1')).split('.'); const p = JSON.parse(Buffer.from(t[1], 'base64url')); p.sub = 'admin1';
    expect((await q(`${t[0]}.${Buffer.from(JSON.stringify(p)).toString('base64url')}.${t[2]}`)).status).toBe(401);
  });
  it('alg none → 401', async () => { expect((await q(await h.sign({ sub: 'admin1' }, { alg: 'none' }))).status).toBe(401); });
  it('alg HS256 (confusion) → 401', async () => { expect((await q(await h.sign({ sub: 'admin1' }, { alg: 'HS256' }))).status).toBe(401); });
  it('منتهي → 401', async () => { expect((await q(await h.sign({ sub: 'cust1', exp: Math.floor(Date.now() / 1000) - 10 }))).status).toBe(401); });
  it('aud غلط → 401', async () => { expect((await q(await h.sign({ sub: 'cust1', aud: 'other-project' }))).status).toBe(401); });
  it('iss غلط → 401', async () => { expect((await q(await h.sign({ sub: 'cust1', iss: 'https://evil.example' }))).status).toBe(401); });
  it('من غير sub → 401', async () => { expect((await q(await h.sign({ sub: '' }))).status).toBe(401); });
  it('موقّع بمفتاح تاني (kid معروف) → 401', async () => {
    const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign']);
    expect((await q(await h.sign({ sub: 'admin1' }, { key: other.privateKey }))).status).toBe(401);
  });
  it('kid مجهول → 401', async () => { expect((await q(await h.sign({ sub: 'admin1' }, { kid: 'zzz' }))).status).toBe(401); });
  it('قيم Authorization غريبة → 401 مش 500', async () => {
    for (const v of ['Bearer', 'Bearer ', 'Bearer a.b', 'Bearer a.b.c', 'Basic abc', 'x'.repeat(50000)]) { const r = await h.raw('me', { headers: { Authorization: v } }); expect([401]).toContain(r.status); }
  });
});

describe('الطرق والمسارات', () => {
  it('health عام وGET فقط', async () => { expect((await h.raw('health', { method: 'GET' })).status).toBe(200); });
  it('about عام ومفيهوش بيانات حساسة', async () => { const r = await h.raw('about', { method: 'GET' }); expect(r.status).toBe(200); expect(Object.keys(r.json)).toEqual(['company']); expect(r.text).not.toMatch(/private_key|FIREBASE_SERVICE/); });
  it('أفعال غير مسموحة → 405', async () => { for (const m of ['PUT', 'DELETE', 'PATCH']) expect((await h.raw('me', { method: m, token: await h.idToken('cust1') })).status).toBe(405); });
  it('GET على مسار عادي → 405', async () => { expect((await h.raw('settings', { method: 'GET', token: await h.idToken('cust1') })).status).toBe(405); });
  it('مسارات مجهولة وخصائص prototype → 404', async () => { for (const r of ['nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'admin', 'admin/', '../etc/passwd']) expect((await h.raw(r, { token: await h.idToken('cust1') })).status, r).toBe(404); });
  it('جسم أكبر من 1.6MB → 413', async () => { expect((await h.raw('quote', { token: await h.idToken('cust1'), body: 'x'.repeat(1_700_000) })).status).toBe(413); });
  it('JSON فاسد/مصفوفة/null لا يكسر (مش 500)', async () => { for (const b of ['{bad', '[]', 'null', '"str"', '123']) expect((await h.raw('settings', { token: await h.idToken('cust1'), body: b })).status, b).toBe(200); });
});

describe('مصفوفة الصلاحيات: أي مسار admin/* مقفول على غير الأدمن', () => {
  const adminRoutes = ROUTES.filter((r) => r.startsWith('admin/'));
  it('عميل وسواق وحساب مجهول: 403 (أو 401) على كل مسارات الأدمن', async () => {
    const bad = [];
    for (const r of adminRoutes) for (const u of ['cust1', 'drv1', 'ghost']) {
      const res = await h.call(u, r, {});
      if (![401, 403].includes(res.status)) bad.push(`${u} → ${r} = ${res.status}`);
    }
    expect(bad).toEqual([]);
  });
  it('الأدمن مش بيتحجب (مش 401/403) على قراءات الأدمن الأساسية', async () => { for (const r of ['admin/users', 'admin/stats', 'admin/withdrawals', 'admin/disputes']) { const res = await h.call('admin1', r, {}); expect([401, 403], r).not.toContain(res.status); } });
});

describe('Fuzz: مفيش مسار بيرجع 500 على مدخلات فاسدة', () => {
  const evil = [{}, { orderId: null }, { orderId: { $ne: 1 } }, { orderId: ['a'] }, { orderId: '../../users/admin1' }, { orderId: 'x'.repeat(5000) }, { uid: '__proto__' }, { amount: -1 }, { amount: 'NaN' }, { amount: 1e308 }, { next: 'delivered' }, { loc: { lat: 'a', lng: {} } }, { pickup: 5, dropoff: [] }, { __proto__: { admin: true } }, { constructor: { prototype: { role: 'admin' } } }];
  const skip = new Set(['admin/export']);
  it('كل المسارات × أدوار × مدخلات فاسدة', async () => {
    const fails = [];
    for (const r of ROUTES.filter((x) => !skip.has(x))) for (const u of ['cust1', 'drv1', 'admin1']) for (const b of evil) {
      const res = await h.call(u, r, b);
      if (res.status >= 500) fails.push(`${u} ${r} ${JSON.stringify(b).slice(0, 60)} → ${res.status} ${res.error || ''}`);
    }
    expect(fails).toEqual([]);
  }, 120000);
});

describe('عزل البيانات (IDOR)', () => {
  it('عميل ما يشوفش طلب عميل تاني', async () => {
    h.FS.put('orders/order0000001', { id: 'order0000001', customer_id: 'cust1', status: 'open', escrow_status: '', price: 100, scheduled_at: Date.now() + 864e5, created_at: Date.now(), version: 1, data: JSON.stringify({ pickup: { lat: 30, lng: 31, address: 'a' }, dropoff: { lat: 30.1, lng: 31.1, address: 'b' } }) });
    const mine = await h.call('cust1', 'orders/get', { orderId: 'order0000001' }); const other = await h.call('cust2', 'orders/get', { orderId: 'order0000001' });
    expect(mine.status).toBe(200); expect([403, 404]).toContain(other.status);
  });
  it('عميل ما يقدرش يلغي/يقيّم/يحرّر طلب غيره', async () => { for (const r of ['orders/cancel', 'orders/confirm', 'orders/rate', 'orders/pay']) { const res = await h.call('cust2', r, { orderId: 'order0000001', stars: 5 }); expect([400, 403, 404, 409], r).toContain(res.status); } expect(h.FS.get('orders/order0000001').status).toBe('open'); });
  it('ملف الهوية ما يتقراش غير للمالك أو الأدمن', async () => {
    h.FS.put('files/file0000001', { id: 'file0000001', owner: 'cust1', kind: 'id', mime: 'image/jpeg', size: 4, data: '/9j/AAAA', created_at: Date.now() });
    const get = async (u) => (await h.raw('files/file0000001', { method: 'GET', token: await h.idToken(u) })).status;
    expect(await get('cust1')).toBe(200); expect(await get('admin1')).toBe(200); expect([403, 404]).toContain(await get('cust2')); expect([403, 404]).toContain(await get('drv1'));
  });
  it('أدلة النزاع (evidence) للمالك والأدمن فقط، وصور الشحنة (cargo) مشتركة بقصد', async () => {
    h.FS.put('files/evid0000001', { id: 'evid0000001', owner: 'cust1', kind: 'evidence', mime: 'image/jpeg', size: 4, data: '/9j/AAAA', created_at: Date.now() });
    h.FS.put('files/carg0000001', { id: 'carg0000001', owner: 'cust1', kind: 'cargo', mime: 'image/jpeg', size: 4, data: '/9j/AAAA', created_at: Date.now() });
    const get = async (id, u) => (await h.raw('files/' + id, { method: 'GET', token: await h.idToken(u) })).status;
    expect(await get('evid0000001', 'cust1')).toBe(200); expect(await get('evid0000001', 'admin1')).toBe(200);
    expect([403, 404]).toContain(await get('evid0000001', 'cust2')); expect([403, 404]).toContain(await get('evid0000001', 'drv1'));
    expect(await get('carg0000001', 'drv1')).toBe(200);
  });
  it('عميل ما يغيّر دوره لأدمن عبر account/update ولا register', async () => {
    await h.call('cust1', 'account/update', { role: 'admin', status: 'active', name: 'zz' });
    expect(h.FS.get('users/cust1').role).toBe('customer');
    await h.call('cust1', 'register', { role: 'admin', name: 'x', phone: '01000000000' });
    expect(h.FS.get('users/cust1').role).toBe('customer');
  });
});
