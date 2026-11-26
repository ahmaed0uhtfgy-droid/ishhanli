// دومين الموقع في المقالات وكل الصفحات: {{site}}، تبديل الدومين القديم، SITE_ORIGIN من متغيّر البيئة، robots/sitemap/canonical بيتبعوه.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { boot } from '../helpers/harness.mjs';
import { LP_ORIGIN, setSiteOrigin } from '../../public/js/landing-content.js';
import { mdToHtml, resolveSite } from '../../functions/_lib/blog.js';
import { onRequest as middleware } from '../../functions/_middleware.js';
import { onRequest as blogPage } from '../../functions/blog/[slug].js';
import { onRequest as sitemapFn } from '../../functions/sitemap.xml.js';
import { onRequest as robotsFn } from '../../functions/robots.txt.js';
import { onRequest as landing } from '../../functions/index.js';

const DEFAULT = 'https://ishhanli.pages.dev', NEW = 'https://shipli.example.com';
afterAll(() => setSiteOrigin(DEFAULT));

describe('setSiteOrigin / middleware', () => {
  it('الافتراضي pages.dev، وقيم غير صالحة بتتتجاهل', () => {
    setSiteOrigin(DEFAULT); expect(LP_ORIGIN).toBe(DEFAULT);
    for (const bad of ['http://x.com', 'javascript:alert(1)', 'https://x.com/path', 'https://', 'x.com', '', null, 'https://a b.com']) { setSiteOrigin(bad); expect(LP_ORIGIN, String(bad)).toBe(DEFAULT); }
  });
  it('المتغيّر بيتطبّق من الـmiddleware وبيشيل / الأخيرة', async () => {
    let nexted = false; await middleware({ env: { SITE_ORIGIN: NEW + '/' }, next: async () => { nexted = true; return new Response('ok'); } });
    expect(nexted).toBe(true); expect(LP_ORIGIN).toBe(NEW); setSiteOrigin(DEFAULT);
  });
});

describe('مقالات بتتبع الدومين', () => {
  it('{{site}} بيتبدّل بالدومين الحالي، والروابط الداخلية بتبقى مسارات (مش nofollow)', () => {
    setSiteOrigin(NEW);
    const h = mdToHtml('زور [موقعنا]({{site}}) و[الأسعار]({{site}}/pricing) و[خارجي](https://example.org/x).\n\nالرابط: {{site}}');
    expect(h).toContain('<a href="/">موقعنا</a>'); expect(h).toContain('<a href="/pricing">الأسعار</a>'); expect(h).toContain('rel="noopener nofollow" target="_blank">خارجي</a>'); expect(h).toContain(`الرابط: <a href="/">${NEW}</a>`); // الرابط المكتوب عادي بقى قابل للضغط
    setSiteOrigin(DEFAULT);
  });
  it('دومين قديم مكتوب جوه مقال متخزّن بيتبدّل بالجديد (روابط ونص عادي)', () => {
    setSiteOrigin(NEW, 'https://old-domain.example.net');
    const md = 'شوف [الأسعار](https://ishhanli.pages.dev/pricing) و[الرئيسية](https://old-domain.example.net) أو ادخل على https://ishhanli.pages.dev/routes دلوقتي.';
    const h = mdToHtml(md);
    expect(h).toContain('<a href="/pricing">الأسعار</a>'); expect(h).toContain('<a href="/">الرئيسية</a>'); expect(h).toContain(`<a href="/routes">${NEW}/routes</a>`); expect(h).not.toContain('ishhanli.pages.dev'); expect(h).not.toContain('old-domain');
    expect(resolveSite('{{site}} و https://ishhanli.pages.dev/x')).toBe(`${NEW} و ${NEW}/x`);
    setSiteOrigin(DEFAULT);
  });
});

describe('الصفحات الكاملة بعد تغيير الدومين', () => {
  let h, env;
  beforeAll(async () => {
    h = await boot({}); const shell = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
    env = { ...h.env, ASSETS: { fetch: async (r) => (new URL(r.url).pathname === '/robots.txt' ? new Response(readFileSync(new URL('../../public/robots.txt', import.meta.url), 'utf8')) : new Response(shell, { headers: { 'content-type': 'text/html' } })) } };
    h.user('adm', { role: 'admin' });
  });
  it('المقال: رابط الموقع ظاهر في آخره، وJSON-LD وcanonical وog:url بالدومين الجديد، وبيرجع للقديم لو اتغيّر تاني', async () => {
    const a = (await h.call('adm', 'admin/blog/save', { title: 'مقال دومين تجريبي طويل', body: '## مقدمة\nزور [موقع اشحنلي]({{site}}) للتفاصيل. وقديم: https://ishhanli.pages.dev/pricing\n\n' + 'نص. '.repeat(30), status: 'published' })).article; const sl = encodeURIComponent(a.slug);
    const get = async () => { const r = await blogPage({ request: new Request('https://x.test/blog/' + sl), env, params: { slug: sl } }); return r.text(); };
    setSiteOrigin(NEW, 'https://ishhanli.pages.dev'); let html = await get();
    expect(html).toContain(`<a href="${NEW}/">${NEW}</a>`); expect(html).toContain(`<link rel="canonical" href="${NEW}/blog/${sl}"`); expect(html).toContain(`"url":"${NEW}/blog/${sl}"`); expect(html).toContain(`property="og:url" content="${NEW}/blog/${sl}"`);
    expect(html).not.toMatch(/ishhanli\.pages\.dev(?!\/blog\/img)/); // ولا ذكر للدومين القديم (بما فيهم نص المقال)
    setSiteOrigin(DEFAULT); html = await get(); expect(html).toContain(`<a href="${DEFAULT}/">${DEFAULT}</a>`); expect(html).not.toContain('shipli.example.com');
  });
  it('sitemap وrobots وlanding canonical بيتبعوا الدومين', async () => {
    setSiteOrigin(NEW, 'https://ishhanli.pages.dev');
    const sm = await (await sitemapFn({ request: new Request('https://x.test/sitemap.xml'), env })).text(); expect(sm).toContain(`<loc>${NEW}/</loc>`); expect(sm).not.toContain('ishhanli.pages.dev');
    const rb = await (await robotsFn({ request: new Request('https://x.test/robots.txt'), env })).text(); expect(rb).toContain(`Sitemap: ${NEW}/sitemap.xml`); expect(rb).not.toContain('ishhanli.pages.dev'); expect(rb).toMatch(/Disallow: \/api\//); expect((rb.match(/^Sitemap:/gim) || []).length).toBe(1);
    const lp = await (await landing({ request: new Request('https://x.test/'), env, waitUntil() {} })).text(); expect(lp).toContain(`rel="canonical" href="${NEW}/"`); expect(lp).not.toContain('ishhanli.pages.dev');
    setSiteOrigin(DEFAULT);
  });
});
