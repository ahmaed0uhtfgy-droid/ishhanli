// حماية كوتا Firestore/Cloudflare: كاش الـstamp (sync) وتهدئة الـsweep. بنقيس عدد عمليات Firestore الفعلية على الـFirestore الوهمي.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { boot } from '../helpers/harness.mjs';

let h, inner, ops;
const reset = () => { ops = { reads: 0, queries: 0, docs: 0 }; };
beforeAll(async () => {
  h = await boot({ STAMP_TTL_MS: '4000', SETTINGS_TTL_MS: '15000' }); // نفس الافتراضيات الجديدة في الإنتاج
  h.FS.put('settings/pricing', { v: JSON.stringify({ dcEnabled: false, jobsRadiusKm: 0 }) });
  h.user('cust1', { role: 'customer' }); h.user('drv1', { role: 'driver' });
  inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url), res = await inner(url, init);
    if (u.startsWith('https://firestore.googleapis.com/') && !u.includes(':commit')) {
      if (u.includes(':runQuery')) { ops.queries++; const j = await res.clone().json().catch(() => []); ops.docs += (Array.isArray(j) ? j : []).filter((x) => x.document).length; } else ops.reads++;
    }
    return res;
  };
  reset();
});
afterAll(() => { globalThis.fetch = inner; h.restore(); });

describe('كاش sync', () => {
  it('200 طلب sync متتالي = قراءة Firestore واحدة (مش 200)', async () => {
    await h.call('cust1', 'sync'); reset(); // سخّن الإعدادات
    await new Promise((r) => setTimeout(r, 4100)); // يخلّي الكاش ينتهي عشان نقيس من الصفر
    reset();
    const rs = await Promise.all(Array.from({ length: 200 }, () => h.call('cust1', 'sync')));
    expect(rs.every((r) => r.status === 200 && typeof r.stamp?.orders === 'number')).toBe(true);
    expect(ops.reads).toBeLessThanOrEqual(1);
  }, 20000);

  it('أي كتابة في نفس الـisolate بتتشاف فوراً (من غير انتظار TTL)', async () => {
    const before = (await h.call('cust1', 'sync')).stamp;
    const cargo = (await h.call('cust1', 'files/upload', { kind: 'cargo', data: 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(400, 7)]).toString('base64') })).ref;
    const o = await h.call('cust1', 'orders/create', { pickup: { lat: 30.04, lng: 31.23, address: 'a' }, dropoff: { lat: 30.01, lng: 31.2, address: 'b' }, category: 'goods', size: 'small', weightKg: 100, description: 'كراتين أدوات منزلية 4 قطع', photos: [cargo], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    expect(o.status).toBe(200);
    const after = (await h.call('cust1', 'sync')).stamp; // مباشرة بعد الكتابة
    expect(after.orders).toBeGreaterThan(before.orders);
  });

  it('لو الكتابة حصلت في isolate تاني: التأخير ≤ STAMP_TTL_MS ثم يتشاف', async () => {
    const s0 = (await h.call('cust1', 'sync')).stamp.users;
    const cur = h.FS.get('meta/stamp'); h.FS.put('meta/stamp', { ...cur, users: (cur.users || 0) + 5 }); // كتابة "من برّه" بتتخطى run()
    expect((await h.call('cust1', 'sync')).stamp.users).toBe(s0); // لسه في الكاش
    await new Promise((r) => setTimeout(r, 4100));
    expect((await h.call('cust1', 'sync')).stamp.users).toBe(s0 + 5);
  }, 20000);
});

describe('تهدئة الـsweep', () => {
  it('عشرات طلبات sync في دقيقتين = sweep واحد بس (مش كل 30 ثانية)', async () => {
    const mk = (i, status) => h.FS.put(`orders/order${status}${String(i).padStart(5, '0')}`, { id: `order${status}${i}`, customer_id: 'cust1', driver_id: 'drv1', status, escrow_status: 'held', price: 100, scheduled_at: Date.now() - 600e3, created_at: Date.now() - 864e5, version: 1, data: JSON.stringify({ pickup: { lat: 30, lng: 31, address: 'a' }, dropoff: { lat: 30.1, lng: 31.1, address: 'b' } }) });
    for (let i = 0; i < 20; i++) { mk(i, 'in_transit'); mk(i, 'paid'); }
    const e = { ...h.env, SWEEP_MIN_INTERVAL_MS: undefined, STAMP_TTL_MS: '0' };
    delete e.SWEEP_MIN_INTERVAL_MS;
    await h.raw('sync', { token: await h.idToken('cust1'), e }); // قد يشغّل sweep لأول مرة
    reset();
    for (let i = 0; i < 30; i++) await h.raw('sync', { token: await h.idToken('cust1'), e });
    expect(ops.queries).toBe(0); // مفيش sweep جديد خلال الدقيقتين (الافتراضي 120 ثانية)
  });
});
