// سيناريوهات إساءة على الفلوس: سحب مزدوج متزامن، مبالغ فاسدة، تحرير متزامن مرتين، تجميد المحفظة. بتقيس السلوك الحالي للسيرفر (مفيش تعديل في المنطق المالي).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { boot } from '../helpers/harness.mjs';

const JPEG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(400, 7)]).toString('base64');
const CAIRO = { lat: 30.0444, lng: 31.2357, address: 'a' }, GIZA = { lat: 30.0131, lng: 31.2089, address: 'b' };
let h;
const up = async (u, kind) => (await h.call(u, 'files/upload', { kind, data: JPEG })).ref;

beforeAll(async () => {
  h = await boot({ ALLOW_TEST_PAYMENTS: '1' });
  h.FS.put('settings/pricing', { v: JSON.stringify({ dcEnabled: false, jobsRadiusKm: 0, samePickupMax: 0, vehiclePricing: Object.fromEntries(['pickup', 'half_ton', 'jumbo', 'truck'].map((k) => [k, { base: 0, perKm: 0, minPrice: 0, kmFee: 0 }])) }) });
  h.user('admin1', { role: 'admin' }); h.user('cust1', { role: 'customer' }); h.user('drv1', { role: 'driver', vehicle_type: 'pickup' });
});
afterAll(() => h.restore());

async function deliveredOrder() {
  const cargo = await up('cust1', 'cargo');
  const o = await h.call('cust1', 'orders/create', { pickup: CAIRO, dropoff: GIZA, category: 'goods', size: 'small', weightKg: 100, description: 'كراتين أدوات منزلية 4 قطع', photos: [cargo], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
  expect(o.status).toBe(200);
  expect((await h.call('drv1', 'orders/accept', { orderId: o.id, agree: true })).status).toBe(200);
  expect((await h.call('cust1', 'orders/pay', { orderId: o.id, proofRef: await up('cust1', 'payment'), reference: '1' })).status).toBe(200);
  expect((await h.call('admin1', 'admin/payment', { orderId: o.id, action: 'confirm' })).status).toBe(200);
  expect((await h.call('drv1', 'orders/status', { orderId: o.id, next: 'heading_pickup' })).status).toBe(200);
  expect((await h.call('drv1', 'orders/status', { orderId: o.id, next: 'picked_up', photoRef: await up('drv1', 'handover'), loc: CAIRO })).status).toBe(200);
  expect((await h.call('drv1', 'orders/status', { orderId: o.id, next: 'in_transit' })).status).toBe(200);
  expect((await h.call('drv1', 'orders/status', { orderId: o.id, next: 'delivered', photoRef: await up('drv1', 'handover'), loc: GIZA })).status).toBe(200);
  return o;
}

describe('تحرير الفلوس', () => {
  it('5 طلبات تأكيد متزامنة = تحرير مرة واحدة فقط والمحفظة = صافي واحد', async () => {
    const o = await deliveredOrder();
    const before = h.FS.get('wallets/drv1')?.balance || 0;
    const res = await Promise.all(Array.from({ length: 5 }, () => h.call('cust1', 'orders/confirm', { orderId: o.id })));
    const okN = res.filter((r) => r.status === 200);
    expect(okN.length).toBe(1);
    expect(res.filter((r) => r.status !== 200).every((r) => r.status === 409)).toBe(true);
    expect(h.FS.get('wallets/drv1').balance - before).toBe(okN[0].net);
    expect(okN[0].net + okN[0].commission).toBe(o.price);
  });
  it('الأدمن يحرّر طلب اتحرر قبل كده؟ مرفوض ولا يضاعف الرصيد', async () => {
    const o = await deliveredOrder(); await h.call('cust1', 'orders/confirm', { orderId: o.id });
    const bal = h.FS.get('wallets/drv1').balance;
    const r = await h.call('admin1', 'admin/release', { orderId: o.id });
    expect(r.status).toBeGreaterThanOrEqual(400); expect(h.FS.get('wallets/drv1').balance).toBe(bal);
  });
});

describe('السحب', () => {
  it('سحبين متزامنين على رصيد يكفي واحد فقط: واحد ينجح والرصيد مش سالب', async () => {
    h.FS.put('wallets/drv1', { balance: 300, total_earned: 300, updated_at: Date.now() });
    const body = { amount: 300, method: 'instapay', account: 'drv1@instapay' };
    const res = await Promise.all([h.call('drv1', 'withdrawals/create', body), h.call('drv1', 'withdrawals/create', body), h.call('drv1', 'withdrawals/create', body)]);
    expect(res.filter((r) => r.status === 200).length).toBe(1);
    expect(h.FS.get('wallets/drv1').balance).toBe(0);
    expect(h.FS.list('withdrawals').filter((w) => w.uid === 'drv1' && w.amount === 300).length).toBe(1);
  });
  it('مبالغ فاسدة (سالب/صفر/NaN/نص/كسور/ضخم) مرفوضة والرصيد ثابت', async () => {
    h.FS.put('wallets/drv1', { balance: 1000, total_earned: 1000, updated_at: Date.now() });
    for (const amount of [-500, 0, NaN, 'abc', '100; DROP', null, undefined, 1e12, 99.5, {}, [], true]) {
      const r = await h.call('drv1', 'withdrawals/create', { amount, method: 'instapay', account: 'abcdef' });
      expect(r.status, JSON.stringify(amount)).toBeGreaterThanOrEqual(400); expect(r.status).toBeLessThan(500);
    }
    expect(h.FS.get('wallets/drv1').balance).toBe(1000);
  });
  it('أكتر من الرصيد / وسيلة غلط / محفظة مجمّدة / عميل', async () => {
    h.FS.put('wallets/drv1', { balance: 1000, total_earned: 1000, updated_at: Date.now() });
    expect((await h.call('drv1', 'withdrawals/create', { amount: 5000, method: 'instapay', account: 'abcdef' })).error).toBe('insufficient_balance');
    expect((await h.call('drv1', 'withdrawals/create', { amount: 200, method: 'paypal', account: 'abcdef' })).error).toBe('bad_method');
    expect((await h.call('cust1', 'withdrawals/create', { amount: 200, method: 'instapay', account: 'abcdef' })).status).toBe(403);
    h.FS.patch('users/drv1', { wallet_frozen: true });
    expect((await h.call('drv1', 'withdrawals/create', { amount: 200, method: 'instapay', account: 'abcdef' })).error).toBe('wallet_frozen');
    h.FS.patch('users/drv1', { wallet_frozen: false });
    expect(h.FS.get('wallets/drv1').balance).toBe(1000);
  });
});

describe('حد المعدّل (rate limit) الحقيقي', () => {
  const e = () => ({ ...h.env, API_RATE_DISABLED: '0', API_RATE_PER_MIN: '20' }); // نفس الـFirestore الوهمي، حد صغير
  it('مسار محسوب في الحد: بعد 20 طلب/دقيقة الرد 429 مش 500', async () => {
    h.user('rl1', { role: 'customer' }); const codes = [];
    for (let i = 0; i < 30; i++) codes.push((await h.raw('inbox/list', { token: await h.idToken('rl1'), e: e() })).status);
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
    expect(codes.slice(20).every((c) => c === 429)).toBe(true);
  });
  it('الحد لكل مستخدم (مستخدم تاني مش متأثر)', async () => { h.user('rl2', { role: 'customer' }); expect((await h.raw('inbox/list', { token: await h.idToken('rl2'), e: e() })).status).toBe(200); });
  it('مسارات الـpolling (me/sync/settings) مستثناة من الحد بقصد', async () => {
    const codes = []; for (let i = 0; i < 30; i++) codes.push((await h.raw('me', { token: await h.idToken('rl1'), e: e() })).status);
    expect(codes.every((c) => c === 200)).toBe(true);
  });
});
