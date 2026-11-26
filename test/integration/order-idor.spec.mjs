// اختبار عام لعزل الطلبات: كل راوت (غير أدمن) بياخد orderId × كل حالة طلب × غريب (عميل/سواق مش طرف) = لازم يترفض ومفيش أي مستند يتغيّر.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { boot } from '../helpers/harness.mjs';

let h;
const SRC = readFileSync(new URL('../../functions/api/[[route]].js', import.meta.url), 'utf8').split('\n');
// الراوتات (غير الأدمن) اللي بتقرا orderId من الـbody
function orderRoutes() {
  const start = SRC.findIndex((l) => l.startsWith('const ROUTES')); const heads = [];
  SRC.forEach((l, i) => { const m = i > start && /^  async (?:'([^']+)'|([A-Za-z0-9_]+))\(/.exec(l); if (m) heads.push([i, m[1] || m[2]]); });
  return heads.filter(([i, n], k) => !n.startsWith('admin/') && /body\??\.orderId/.test(SRC.slice(i, heads[k + 1]?.[0] ?? SRC.length).join('\n'))).map(([, n]) => n);
}
// استثناءات مقصودة: السواق يقدر يشوف/يقدّم عرض/يقبل على طلب *مفتوح*
const OPEN_DRIVER_OK = new Set(['orders/get', 'offers/create', 'offers/withdraw', 'orders/accept', 'chat/list', 'chat/send']);
const STATUSES = ['open', 'accepted', 'payment_review', 'paid', 'heading_pickup', 'picked_up', 'in_transit', 'delivered', 'completed', 'cancelled', 'disputed'];
const oid = (s) => `order${s.replace(/_/g, '')}00001`.slice(0, 30).padEnd(10, '0');

beforeAll(async () => {
  h = await boot();
  for (const u of ['cust1', 'cust2']) h.user(u, { role: 'customer' });
  for (const d of ['drv1', 'drv2']) h.user(d, { role: 'driver', vehicle_type: 'pickup' });
  h.user('drvpend', { role: 'driver', status: 'pending', vehicle_type: 'pickup' }); h.user('admin1', { role: 'admin' });
  h.FS.put('wallets/drv1', { balance: 500, total_earned: 500, updated_at: 1 });
  for (const s of STATUSES) h.FS.put(`orders/${oid(s)}`, { id: oid(s), customer_id: 'cust1', driver_id: s === 'open' ? null : 'drv1', status: s, escrow_status: ['paid', 'heading_pickup', 'picked_up', 'in_transit', 'delivered', 'disputed'].includes(s) ? 'held' : '', price: 100, scheduled_at: Date.now() + 864e5, created_at: Date.now(), version: 1, data: JSON.stringify({ pickup: { lat: 30.04, lng: 31.23, address: 'a' }, dropoff: { lat: 30.01, lng: 31.2, address: 'b' } }) });
});
afterAll(() => h.restore());

const snap = () => JSON.stringify(['orders', 'wallets', 'withdrawals', 'disputes', 'refunds', 'offers'].map((c) => h.FS.list(c).map((x) => JSON.stringify(x)).sort()));

describe('عزل الطلبات لكل الراوتات', () => {
  const routes = orderRoutes();
  it('اكتشف راوتات الطلبات', () => { expect(routes.length).toBeGreaterThan(15); expect(routes).toContain('orders/cancel'); expect(routes).toContain('orders/confirm'); });

  it('اختبار تحكّم إيجابي: المالك والسواق المعيّن بيشوفوا نفس الطلبات (يثبت إن الرفض عند الغريب بسبب العزل مش بسبب فيكستشر فاسد)', async () => {
    for (const s of STATUSES) {
      expect((await h.call('cust1', 'orders/get', { orderId: oid(s) })).status, `owner @ ${s}`).toBe(200);
      if (s !== 'open') expect((await h.call('drv1', 'orders/get', { orderId: oid(s) })).status, `driver @ ${s}`).toBe(200);
    }
    expect((await h.call('drv2', 'orders/get', { orderId: oid('open') })).status).toBe(200); // مفتوح: أي سواق نشط يشوفه (مقصود)
    expect((await h.call('cust1', 'orders/cancel', { orderId: oid('open'), reason: 'x' })).status).toBe(200); // المالك فعلاً يقدر يعدّل
    h.FS.patch(`orders/${oid('open')}`, { status: 'open', version: 1 }); // نرجّع الحالة للباقي
  });

  it('العميل الغريب (cust2): ولا راوت ينجح على أي طلب في أي حالة، ومفيش مستند بيتغيّر', async () => {
    const before = snap(), bad = [];
    for (const r of routes) for (const s of STATUSES) {
      const res = await h.call('cust2', r, { orderId: oid(s), stars: 5, reason: 'x', agree: true, next: 'delivered', amount: 10, text: 'hi', price: 10 });
      if (res.status === 200) bad.push(`${r} @ ${s}`); if (res.status >= 500) bad.push(`500: ${r} @ ${s}`);
    }
    expect(bad).toEqual([]); expect(snap()).toBe(before);
  }, 120000);

  it('السواق الغريب (drv2): مرفوض على كل الطلبات غير المفتوحة، ومفيش مستند بيتغيّر', async () => {
    const before = snap(), bad = [];
    for (const r of routes) for (const s of STATUSES.filter((x) => x !== 'open')) {
      const res = await h.call('drv2', r, { orderId: oid(s), stars: 5, reason: 'x', agree: true, next: 'delivered', amount: 10, text: 'hi', price: 10, loc: { lat: 30.04, lng: 31.23 } });
      if (res.status === 200) bad.push(`${r} @ ${s}`); if (res.status >= 500) bad.push(`500: ${r} @ ${s}`);
    }
    expect(bad).toEqual([]); expect(snap()).toBe(before);
  }, 120000);

  it('السواق الغريب على طلب مفتوح: مسموح فقط بالراوتات المقصودة (عرض/قبول/عرض الطلب)', async () => {
    const bad = [];
    for (const r of routes.filter((x) => !OPEN_DRIVER_OK.has(x))) {
      const before = snap(); const res = await h.call('drv2', r, { orderId: oid('open'), stars: 5, reason: 'x', agree: true, next: 'delivered', amount: 10, text: 'hi' });
      if (res.status === 200 || snap() !== before) bad.push(`${r} → ${res.status}`);
    }
    expect(bad).toEqual([]);
  }, 120000);

  it('سواق معلّق (pending) مرفوض في كل الراوتات على كل الطلبات', async () => {
    const bad = [];
    for (const r of routes) for (const s of ['open', 'paid', 'delivered']) { const res = await h.call('drvpend', r, { orderId: oid(s), agree: true, next: 'delivered', loc: { lat: 30.04, lng: 31.23 } }); if (res.status === 200) bad.push(`${r} @ ${s}`); }
    expect(bad).toEqual([]);
  }, 120000);
});
