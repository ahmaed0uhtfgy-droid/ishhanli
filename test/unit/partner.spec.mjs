// ربط المواقع: موقع شريك (متاجر) ← شركة شحن: ربط بتأكيد الطرفين، طلبات التاجر بتتسجّل وبتتضاف على عدّادات الشركة (رسوم الشركات)، idempotent، إلغاء بيرجّع، وأمان المفتاح.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { boot } from '../helpers/harness.mjs';
import { onRequest } from '../../functions/api/[[route]].js';

describe('ربط المواقع', () => {
  let h, cur, key, siteId;
  const partner = async (route, body = {}, k = key) => {
    const r = await onRequest({ request: new Request('https://x.test/api/' + route, { method: 'POST', headers: { Authorization: 'Bearer ' + (k ?? ''), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env: h.env, params: { route: route.split('/') } });
    return { ...(await r.json()), http: r.status }; // http = كود الاستجابة (status ممكن يكون حالة الرابط)
  };
  const link = { merchantRef: 'store-77', merchantName: 'متجر الأمل', companyId: 'compp1' };
  beforeAll(async () => {
    h = await boot({});
    h.user('adm', { role: 'admin' }); h.user('cust');
    h.user('compp1', { role: 'driver', account_type: 'company', company_name: 'شركة النيل', vehicle_type: 'pickup' });
    h.user('indiv1', { role: 'driver', account_type: 'individual', vehicle_type: 'pickup' });
    cur = { ...(await h.call('cust', 'settings')).settings, dcEnabled: false, cfEnabled: true, cfType: 'fixed', cfValue: 50, cfLimit: 1000 };
    await h.call('adm', 'admin/settings/save', cur);
  });
  afterAll(() => h.restore());

  it('الأدمن بس بينشئ موقع، والمفتاح بيتعرض مرة واحدة ومخزّن كهاش', async () => {
    expect((await h.call('cust', 'admin/partner/save', { name: 'متاجر', url: 'https://shops.example.com' })).status).toBe(403);
    expect((await h.call('adm', 'admin/partner/save', { name: 'متاجر', url: 'http://shops.example.com' })).status).toBe(400); // https بس
    const r = await h.call('adm', 'admin/partner/save', { name: 'موقع المتاجر', url: 'https://shops.example.com' });
    expect(r.status).toBe(200); key = r.key; siteId = r.id; expect(key.startsWith(siteId + '.')).toBe(true);
    const doc = h.FS.get(`partner_sites/${siteId}`); expect(JSON.stringify(doc)).not.toContain(key.split('.')[1]); expect(doc.key_hash).toMatch(/^[0-9a-f]{64}$/);
    const list = await h.call('adm', 'admin/partner/list', {}); expect(JSON.stringify(list)).not.toContain('key_hash');
  });

  it('مفتاح غلط/ناقص/موقع موقوف = 401', async () => {
    for (const k of [null, '', 'x.y', siteId + '.' + 'a'.repeat(48)]) expect((await partner('partner-api/companies', {}, k)).http).toBe(401);
    expect((await h.call('adm', 'admin/partner/save', { id: siteId, name: 'موقع المتاجر', url: 'https://shops.example.com', enabled: false })).status).toBe(200);
    expect((await partner('partner-api/companies')).http).toBe(401);
    await h.call('adm', 'admin/partner/save', { id: siteId, name: 'موقع المتاجر', url: 'https://shops.example.com', enabled: true });
  });

  it('الربط: طلب معلّق ← الشركة توافق ← طلب التاجر بيتسجّل وبيتحسب', async () => {
    const co = await partner('partner-api/companies'); expect(co.http).toBe(200); expect(co.companies.map((x) => x.id)).toEqual(['compp1']); // الفردي مش ظاهر
    expect((await partner('partner-api/link', { ...link, companyId: 'indiv1' })).http).toBe(404);
    const l = await partner('partner-api/link', link); expect(l.http).toBe(200); expect(l.status).toBe('pending');
    const ord = { merchantRef: link.merchantRef, companyId: 'compp1', externalOrderId: 'ORD-1', amount: 400, summary: 'طلب أول' };
    expect((await partner('partner-api/order', ord)).error).toBe('not_linked'); // لسه معلّق
    expect((await partner('partner-api/link/status', link)).status).toBe('pending');
    expect((await h.call('indiv1', 'partner/links', {})).status).toBe(403);
    const mine = await h.call('compp1', 'partner/links', {}); expect(mine.links.length).toBe(1);
    expect((await h.call('compp1', 'partner/respond', { id: mine.links[0].id, action: 'accept' })).status).toBe(200);
    expect((await partner('partner-api/link/status', link)).status).toBe('active');
    const o1 = await partner('partner-api/order', ord); expect([o1.http, o1.counted]).toEqual([200, true]);
    expect((await h.call('compp1', 'cf/summary', {})).cycle).toBe(400);
    const dup = await partner('partner-api/order', ord); expect([dup.http, dup.duplicate]).toEqual([200, true]); // نفس الرقم مايتحسبش مرتين
    expect((await h.call('compp1', 'cf/summary', {})).cycle).toBe(400);
  });

  it('الحد: الشركة بتتوقف (company_blocked)، والإلغاء بيرجّع', async () => {
    const mk = (n, a) => ({ merchantRef: link.merchantRef, companyId: 'compp1', externalOrderId: n, amount: a });
    expect((await partner('partner-api/order', mk('ORD-2', 650))).http).toBe(200); // 400 + 650 = 1050 ≥ 1000
    expect((await h.call('compp1', 'cf/summary', {})).blocked).toBe(true);
    expect((await partner('partner-api/order', mk('ORD-3', 100))).error).toBe('company_blocked');
    expect((await partner('partner-api/companies')).companies[0].paused).toBe(true);
    expect((await partner('partner-api/order/cancel', { externalOrderId: 'ORD-2' })).http).toBe(200);
    expect((await partner('partner-api/order/cancel', { externalOrderId: 'ORD-2' })).already).toBe(true);
    const s = await h.call('compp1', 'cf/summary', {}); expect([s.cycle, s.total, s.blocked]).toEqual([400, 400, false]);
    expect((await partner('partner-api/order', mk('ORD-3', 100))).http).toBe(200);
  });

  it('الإلغاء من الشركة/الأدمن بيوقف الطلبات، وتدوير المفتاح بيبطّل القديم', async () => {
    const lid = (await h.call('compp1', 'partner/links', {})).links[0].id;
    expect((await h.call('compp1', 'partner/respond', { id: lid, action: 'accept' })).error).toBe('bad_state'); // مش معلّق
    expect((await h.call('adm', 'admin/partner/link', { id: lid, action: 'revoke' })).status).toBe(200);
    expect((await partner('partner-api/order', { merchantRef: link.merchantRef, companyId: 'compp1', externalOrderId: 'ORD-9', amount: 10 })).error).toBe('not_linked');
    const old = key, r = await h.call('adm', 'admin/partner/rotate', { id: siteId }); key = r.key;
    expect((await partner('partner-api/companies', {}, old)).http).toBe(401);
    expect((await partner('partner-api/companies')).http).toBe(200);
  });

  it('ادخال فاسد = 400 مش 500', async () => {
    for (const b of [{}, { merchantRef: 'a'.repeat(200) }, { merchantRef: 'a', merchantName: 'b', companyId: '../x' }, { merchantRef: 'a', companyId: 'compp1', externalOrderId: 'z', amount: -5 }, { merchantRef: 'a', companyId: 'compp1', externalOrderId: 'z', amount: 1.5 }]) {
      const r = await partner('partner-api/order', b); expect(r.http, JSON.stringify(b)).toBeLessThan(500);
    }
  });
});
