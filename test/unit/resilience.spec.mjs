// الصمود تحت الضغط: ميزانية قراءات Firestore للصفحات العامة (زيارات كتير ≠ قراءات كتير)، إعادة محاولة عمليات Firestore العابرة،
// 503 + Retry-After لما الحصة تخلص، وتبطيء الاستطلاع (polling) في الواجهة وقت الأعطال.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { boot } from '../helpers/harness.mjs';
import { onRequest as landing } from '../../functions/index.js';
import { onRequest as blogPage } from '../../functions/blog/[slug].js';
import { onRequest as driverPage } from '../../functions/drivers/[id].js';

let h, env, S, inner;
const page = (fn, p, params = {}) => fn({ request: new Request('https://x.test' + p), env, params, waitUntil() {} });
const fsOnly = (u) => String(u).startsWith('https://firestore.googleapis.com/');
beforeAll(async () => {
  h = await boot({ STAMP_TTL_MS: '4000', SETTINGS_TTL_MS: '15000' });
  const shell = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
  env = { ...h.env, ASSETS: { fetch: async () => new Response(shell, { headers: { 'content-type': 'text/html' } }) } };
  h.user('adm', { role: 'admin' }); h.user('c1', { role: 'customer' }); S = h.FS.stats; inner = globalThis.fetch;
});
afterAll(() => { globalThis.fetch = inner; h.restore(); });
const delta = async (fn) => { const b = { ...S }; await fn(); return { reads: S.reads - b.reads, queries: S.queries - b.queries, writes: S.writes - b.writes }; };

describe('ميزانية قراءات الصفحات العامة', () => {
  it('الرئيسية: 300 زيارة = قراءتين على الأكثر (الإعدادات متكاشية)', async () => {
    await page(landing, '/'); const d = await delta(async () => { for (let i = 0; i < 300; i++) await page(landing, '/'); }); expect(d.reads + d.queries).toBeLessThanOrEqual(2);
  });
  it('مقال منشور: 300 زيارة لنفس المقال = استعلام واحد', async () => {
    const a = (await h.call('adm', 'admin/blog/save', { title: 'مقال لقياس القراءات', body: 'x'.repeat(80), status: 'published' })).article; const sl = encodeURIComponent(a.slug);
    expect((await page(blogPage, '/blog/' + sl, { slug: sl })).status).toBe(200);
    const d = await delta(async () => { for (let i = 0; i < 300; i++) await page(blogPage, '/blog/' + sl, { slug: sl }); }); expect(d.queries).toBeLessThanOrEqual(1);
  });
  it('رابط مقال غير موجود: 300 طلب لنفس الرابط = استعلام واحد، وكلهم 404', async () => {
    const d = await delta(async () => { for (let i = 0; i < 300; i++) expect((await page(blogPage, '/blog/nope', { slug: 'nope' })).status).toBe(404); }); expect(d.queries).toBeLessThanOrEqual(1);
  });
  it('صفحة سواق غير موجود: 300 طلب لنفس الـid = قراءة واحدة', async () => {
    const d = await delta(async () => { for (let i = 0; i < 300; i++) expect([302, 404]).toContain((await page(driverPage, '/drivers/zzzz9999', { id: 'zzzz9999' })).status); }); expect(d.reads).toBeLessThanOrEqual(1); // غير موجود: تحويل أو 404
  });
  it('كتابة مقال بتفرّغ الكاش: النشر الجديد يظهر فوراً في نفس الـisolate', async () => {
    const a = (await h.call('adm', 'admin/blog/save', { title: 'مقال مسودة ثم منشور', body: 'x'.repeat(80), status: 'draft' })).article; const sl = encodeURIComponent(a.slug);
    expect((await page(blogPage, '/blog/' + sl, { slug: sl })).status).toBe(404); // اتكاشت 404
    await h.call('adm', 'admin/blog/save', { ...a, status: 'published' });
    expect((await page(blogPage, '/blog/' + sl, { slug: sl })).status).toBe(200);
  });
});

describe('إعادة المحاولة والأعطال العابرة', () => {
  const wrap = (rule) => { const calls = []; globalThis.fetch = async (u, i) => { if (fsOnly(u)) { const kind = String(u).includes(':commit') ? 'commit' : (i?.method === 'POST' ? 'query' : 'get'); calls.push(kind); const r = rule(kind, calls.filter((k) => k === kind).length); if (r) return r; } return inner(u, i); }; return calls; };
  const err = (status, fsStatus, message = '') => new Response(JSON.stringify({ error: { code: status, status: fsStatus, message } }), { status });
  it('commit بيرجع ABORTED (تزاحم) مرتين: بيتعاد وينجح من غير ما المستخدم يحس', async () => {
    const calls = wrap((k, n) => (k === 'commit' && n <= 2 ? err(409, 'ABORTED', 'Too much contention on these documents') : null));
    const r = await h.call('adm', 'admin/blog/save', { title: 'مقال بعد تزاحم الكتابة', body: 'x'.repeat(80), status: 'draft' });
    globalThis.fetch = inner; expect(r.status).toBe(200); expect(calls.filter((k) => k === 'commit').length).toBe(4); // حفظ المقال: محاولتين فاشلتين + ناجحة، + commit سجل التدقيق
  });
  it('ABORTED مستمر: بيحاول 4 مرات بس وبعدين 409 (مش لوب)', async () => {
    const calls = wrap((k) => (k === 'commit' ? err(409, 'ABORTED') : null));
    const r = await h.call('adm', 'admin/blog/save', { title: 'مقال تزاحم مستمر', body: 'x'.repeat(80), status: 'draft' });
    globalThis.fetch = inner; expect(r.status).toBe(409); expect(r.error).toBe('conflict'); expect(calls.filter((k) => k === 'commit').length).toBe(4);
  });
  it('conflict حقيقي (FAILED_PRECONDITION) ما بيتعادش', async () => {
    const calls = wrap((k) => (k === 'commit' ? err(400, 'FAILED_PRECONDITION', 'precondition') : null));
    const r = await h.call('adm', 'admin/blog/save', { title: 'مقال شرط مسبق فاشل', body: 'x'.repeat(80), status: 'draft' });
    globalThis.fetch = inner; expect(r.status).toBe(409); expect(calls.filter((k) => k === 'commit').length).toBe(1);
  });
  it('قراءة Firestore بترجّع 503 عابر مرة: بتتعاد وتنجح', async () => {
    const calls = wrap((k, n) => (k === 'get' && n === 1 ? err(503, 'UNAVAILABLE') : null));
    const r = await h.call('c1', 'me'); globalThis.fetch = inner; expect(r.status).toBe(200); expect(calls.filter((k) => k === 'get').length).toBeGreaterThanOrEqual(2);
  });
  it('قراءة بتفشل بالشبكة مرة: بتتعاد وتنجح', async () => {
    let n = 0; globalThis.fetch = async (u, i) => { if (fsOnly(u) && !String(u).includes(':commit') && i?.method !== 'POST' && ++n === 1) throw new TypeError('network'); return inner(u, i); };
    const r = await h.call('c1', 'me'); globalThis.fetch = inner; expect(r.status).toBe(200);
  });
  it('الحصة خلصت (RESOURCE_EXHAUSTED): 503 + Retry-After ورسالة واضحة، من غير إعادة محاولة', async () => {
    const calls = wrap((k) => (k === 'get' ? err(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded') : null));
    const r = await h.raw('me', { token: await h.idToken('c1') }); globalThis.fetch = inner;
    expect(r.status).toBe(503); expect(r.json.error).toBe('quota_exceeded'); expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0); expect(calls.filter((k) => k === 'get').length).toBe(1);
  });
  it('الصفحات العامة تفضل شغّالة (200 بالإعدادات الافتراضية) لما Firestore واقع', async () => {
    wrap(() => err(503, 'UNAVAILABLE'));
    const env2 = { ...env }; // كاش الإعدادات ممكن يكون دافي، فنعطّله لإجبار القراءة
    const r = await landing({ request: new Request('https://x.test/'), env: { ...env2, SETTINGS_TTL_MS: '0' }, params: {}, waitUntil() {} }); globalThis.fetch = inner;
    expect(r.status).toBe(200); expect((await r.text()).length).toBeGreaterThan(2000);
  });
});

describe('ضغط متزامن (منطق الكود، على Firestore وهمي)', () => {
  it('300 عميل بيفتحوا التطبيق مع بعض (me + settings + sync + orders/list): كله 200 وقراءات محدودة', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `load${i}`); ids.forEach((id) => h.user(id, { role: 'customer' }));
    const toks = await Promise.all(ids.map((id) => h.idToken(id)));
    const b = { ...S }; const t0 = Date.now();
    const rs = await Promise.all(toks.flatMap((token) => ['me', 'settings', 'sync', 'orders/list'].map((r) => h.raw(r, { token, body: {} }))));
    const ms = Date.now() - t0, reads = S.reads - b.reads, queries = S.queries - b.queries;
    expect(rs.length).toBe(1200); expect(rs.filter((r) => r.status !== 200).map((r) => r.status)).toEqual([]);
    // me = قراءة لكل مستخدم (ضرورية للأمان) + orders/list ≈ 2 قراءة/استعلام لكل مستخدم؛ settings وsync متكاشين (≈ لا شيء)
    expect(reads).toBeLessThanOrEqual(300 * 4 + 20); expect(queries).toBeLessThanOrEqual(300 + 10);
    console.log(`ضغط: 1200 طلب في ${ms}ms، قراءات ${reads}، استعلامات ${queries}`);
  }, 60000);
  it('60 عميل بيعملوا طلب في نفس اللحظة: كله ينجح والعدّاد بيزيد (من غير ضياع كتابة)', async () => {
    const img = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(400, 7)]).toString('base64');
    const ids = Array.from({ length: 60 }, (_, i) => `ord${i}`); ids.forEach((id) => h.user(id, { role: 'customer' }));
    const before = (await h.call('c1', 'sync')).stamp.orders;
    const rs = await Promise.all(ids.map(async (id) => { const up = await h.call(id, 'files/upload', { kind: 'cargo', data: img }); return h.call(id, 'orders/create', { pickup: { lat: 30.04, lng: 31.23, address: 'a' }, dropoff: { lat: 30.01, lng: 31.2, address: 'b' }, category: 'goods', size: 'small', weightKg: 100, description: 'كراتين أدوات منزلية 4 قطع', photos: [up.ref], scheduledAt: new Date(Date.now() + 3600e3).toISOString() }); }));
    expect(rs.filter((r) => r.status !== 200).map((r) => `${r.status}:${r.error}`)).toEqual([]);
    expect((await h.call('c1', 'sync')).stamp.orders).toBeGreaterThan(before);
  }, 60000);
});

describe('الواجهة: تبطيء الاستطلاع وقت الأعطال', () => {
  it('كل فشل متتالي بيضاعف الفاصل (حد أقصى ×8) ونجاح واحد بيرجّعه طبيعي', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0.5); // العشوائية ثابتة = ×1.0
    globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
    const { poll } = await import('../../public/js/poll.js');
    let fail = true, calls = 0; const times = [];
    const stop = poll(async () => { calls++; times.push(Date.now()); if (fail) throw Object.assign(new Error('x'), { code: 'quota_exceeded' }); return 1; }, 1000, () => {}, { onError: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(40000); // فشل مستمر
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    expect(gaps.slice(0, 4)).toEqual([2000, 4000, 8000, 8000]); // ×2, ×4, ×8, وبعدها يثبت عند ×8
    fail = false; await vi.advanceTimersByTimeAsync(9000);
    const after = times.slice(-3).map((t, i, a) => (i ? t - a[i - 1] : null)).filter(Boolean);
    expect(after[after.length - 1]).toBe(1000); // رجع للفاصل الطبيعي بعد أول نجاح
    stop(); vi.useRealTimers(); vi.restoreAllMocks(); delete globalThis.document;
  });
});
