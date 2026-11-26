// رؤوس الأمان: _headers بيتطبّق على الملفات الثابتة بس (مش ردود Functions). الاختبارات دي بتضمن إن الكود بيحط نفس الرؤوس بنفسه.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SECURITY_HEADERS, withSecurityHeaders } from '../../functions/_lib/secHeaders.js';
import { onRequest as landing } from '../../functions/index.js';
import { driverPage, driversIndexPage, driverPublic } from '../../functions/_lib/publicProfile.js';
import { DEFAULTS } from '../../functions/_lib/logic.js';

function globalBlock() {
  const out = {}; let on = false;
  for (const l of readFileSync(new URL('../../public/_headers', import.meta.url), 'utf8').split('\n')) {
    if (l.startsWith('/*')) { on = true; continue; }
    if (on && l && !l.startsWith(' ')) break;
    if (on && l.includes(':')) { const i = l.indexOf(':'); out[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  }
  return out;
}

describe('تزامن رؤوس الأمان', () => {
  it('SECURITY_HEADERS في الكود = القاعدة /* في public/_headers بالظبط (لا نقص ولا اختلاف)', () => { expect({ ...SECURITY_HEADERS }).toEqual(globalBlock()); });
  it('الرؤوس الأساسية موجودة والـCSP مقفول (بدون unsafe-eval ولا * في script-src)', () => {
    for (const k of ['X-Content-Type-Options', 'X-Frame-Options', 'Strict-Transport-Security', 'Content-Security-Policy', 'Referrer-Policy']) expect(SECURITY_HEADERS[k], k).toBeTruthy();
    const csp = SECURITY_HEADERS['Content-Security-Policy']; const script = /script-src ([^;]*)/.exec(csp)[1];
    expect(script).not.toMatch(/unsafe-eval|unsafe-inline|\s\*(\s|$)/); expect(csp).toMatch(/frame-ancestors 'none'/); expect(csp).toMatch(/object-src 'none'/);
  });
  it('withSecurityHeaders: بيضيف الناقص، وما بيمسحش رأس موجود، وبيحافظ على الـstatus والـbody', async () => {
    const r = withSecurityHeaders(new Response('hi', { status: 201, headers: { 'X-Frame-Options': 'SAMEORIGIN', 'X-Custom': '1' } }));
    expect(r.status).toBe(201); expect(await r.text()).toBe('hi'); expect(r.headers.get('X-Frame-Options')).toBe('SAMEORIGIN'); expect(r.headers.get('X-Custom')).toBe('1');
    for (const k of Object.keys(SECURITY_HEADERS).filter((x) => x !== 'X-Frame-Options')) expect(r.headers.get(k), k).toBe(SECURITY_HEADERS[k]);
  });
});

describe('الصفحة الرئيسية "/" (function): الرؤوس من الكود حتى لو الملفات الثابتة رجعت من غير رؤوس', () => {
  const shell = '<!doctype html><html lang="ar"><head><title>x</title></head><body><div id="app"></div></body></html>';
  // أسوأ حالة: env.ASSETS بيرجّع HTML خام من غير أي رأس أمان
  const mk = (over = {}) => ({ ASSETS: { fetch: async () => new Response(shell, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }) }, ...over });
  const call = (env, method = 'GET', url = 'https://x.test/') => landing({ request: new Request(url, { method }), env });
  it('GET', async () => { const r = await call(mk()); expect(r.status).toBe(200); for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(r.headers.get(k), k).toBe(v); });
  it('HEAD', async () => { const r = await call(mk(), 'HEAD'); for (const k of Object.keys(SECURITY_HEADERS)) expect(r.headers.get(k), k).toBeTruthy(); });
  it('وضع المعاينة (preview) برضه', async () => { const r = await call(mk(), 'GET', 'https://x.test/?preview=b'); for (const k of Object.keys(SECURITY_HEADERS)) expect(r.headers.get(k), k).toBeTruthy(); });
  it('لو توليد الصفحة فشل (fallback للـshell الخام): الرؤوس لسه موجودة', async () => {
    const env = mk({ FIREBASE_SERVICE_ACCOUNT: '{bad json', FIREBASE_PROJECT_ID: 'p' }); const r = await call(env);
    expect(r.status).toBe(200); for (const k of Object.keys(SECURITY_HEADERS)) expect(r.headers.get(k), k).toBeTruthy();
  });
});

describe('باقي صفحات الـSSR: رؤوس الأمان بتتحط من الكود', () => {
  const need = ['X-Content-Type-Options', 'X-Frame-Options', 'Content-Security-Policy', 'Strict-Transport-Security'];
  const user = { uid: 'u1', role: 'driver', status: 'active', name: 'أحمد محمد', vehicle_type: 'pickup', rating_sum: 45, rating_count: 10, completed_orders: 12, created_at: 1_700_000_000_000 };
  it('صفحات التسويق (كل function فعلاً)', async () => {
    for (const f of ['how-it-works', 'pricing', 'vehicles', 'for-drivers', 'for-companies']) {
      const { onRequest } = await import(`../../functions/${f}.js`);
      const r = await onRequest({ request: new Request(`https://x.test/${f}`), env: {} });
      expect(r.status, f).toBe(200); for (const k of need) expect(r.headers.get(k), `${f} ${k}`).toBeTruthy();
      expect((await r.text()).length, f).toBeGreaterThan(500);
    }
  });
  it('صفحات السواقين العامة', async () => { for (const r of [driverPage({}, user, 'https://x.test', DEFAULTS), driversIndexPage([driverPublic(user, DEFAULTS)], 'https://x.test')]) { expect(r instanceof Response).toBe(true); for (const k of need) expect(r.headers.get(k), k).toBeTruthy(); } });
});
