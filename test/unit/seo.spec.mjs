// اختبار SEO شامل: بيستدعي كل function صفحة فعلياً (من غير شبكة) ويتأكد من العناصر اللي محركات البحث بتعتمد عليها.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { onRequest as landing } from '../../functions/index.js';
import { onRequest as sitemap, buildSitemap } from '../../functions/sitemap.xml.js';
import { onRequest as routesIndex } from '../../functions/routes/index.js';
import { onRequest as routePage } from '../../functions/routes/[slug].js';
import { LP_ORIGIN } from '../../public/js/landing-content.js';
import { ROUTES, routePath, routeFacts, findRoute, routeContent, routeSlug } from '../../functions/_lib/routes.js';
import { PAGE_PATHS } from '../../functions/_lib/pages.js';
import { DEFAULTS } from '../../functions/_lib/logic.js';
import { CITIES, estimate } from '../../public/js/estimate.js';

const shell = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
const ENV = { ASSETS: { fetch: async () => new Response(shell, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }) } };
const get = async (fn, path, params = {}) => { const r = await fn({ request: new Request('https://x.test' + path), env: ENV, params }); return { status: r.status, headers: r.headers, html: await r.text() }; };

const pages = [['/', landing, {}], ...Object.values(PAGE_PATHS).map((p) => [p, null, {}]), ['/routes', routesIndex, {}], ...ROUTES.map((r) => [routePath(r), routePage, { slug: r.slug }])];
const loaders = {};
for (const p of Object.values(PAGE_PATHS)) loaders[p] = async () => (await import(`../../functions/${p.slice(1)}.js`)).onRequest;
const fetchPage = async ([path, fn, params]) => get(fn || (await loaders[path]()), path, params);

const meta = (h, re) => (re.exec(h) || [])[1] || '';
const text = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
const all = {}; // path -> parsed
for (const pg of pages) { const r = await fetchPage(pg); all[pg[0]] = { ...r, title: meta(r.html, /<title>([\s\S]*?)<\/title>/).trim(), desc: meta(r.html, /<meta name="description" content="([^"]*)"/), canon: meta(r.html, /rel="canonical" href="([^"]*)"/), words: (text(r.html).match(/\p{L}+/gu) || []).length }; }

describe('كل صفحة SEO', () => {
  it('عدد الصفحات المتوقع (رئيسية + 5 محتوى + فهرس + 37 طريق)', () => { expect(Object.keys(all).length).toBe(1 + 5 + 1 + ROUTES.length); expect(ROUTES.length).toBe(37); });
  for (const [path] of pages) {
    it(`${path}: 200 + title/description/canonical/h1/JSON-LD سليمة`, () => {
      const p = all[path];
      expect(p.status).toBe(200);
      expect(p.title.length, 'title').toBeGreaterThanOrEqual(20); expect(p.title.length, 'title').toBeLessThanOrEqual(70);
      expect(p.desc.length, 'description').toBeGreaterThanOrEqual(70); expect(p.desc.length, 'description').toBeLessThanOrEqual(170);
      expect(p.canon, 'canonical').toBe(LP_ORIGIN + (path === '/' ? '/' : path));
      expect((p.html.match(/<h1[\s>]/g) || []).length, 'h1').toBe(1);
      expect(p.html).toMatch(/<html[^>]*lang="ar"/);
      expect(p.html).not.toMatch(/noindex/);
      for (const m of p.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) expect(() => JSON.parse(m[1]), 'JSON-LD').not.toThrow();
      for (const m of p.html.matchAll(/<img\b[^>]*>/g)) expect(m[0], 'img alt').toMatch(/\balt="/);
      expect(p.html).not.toMatch(/undefined|\[object Object\]|NaN/);
    });
  }
  it('كل title فريد وكل description فريد (من غير تكرار بين الصفحات)', () => {
    const t = Object.values(all).map((p) => p.title), d = Object.values(all).map((p) => p.desc);
    expect(new Set(t).size).toBe(t.length); expect(new Set(d).size).toBe(d.length);
  });
  it('عمق المحتوى: صفحات الطرق ≥ 150 كلمة وصفحات المحتوى ≥ 150 والرئيسية ≥ 500', () => {
    expect(all['/'].words).toBeGreaterThanOrEqual(500);
    for (const p of Object.values(PAGE_PATHS)) expect(all[p].words, p).toBeGreaterThanOrEqual(150);
    for (const r of ROUTES) expect(all[routePath(r)].words, r.slug).toBeGreaterThanOrEqual(150);
  });
  it('الروابط الداخلية كلها بتشير لصفحات أو ملفات موجودة (مفيش 404 داخلي)', () => {
    const known = new Set(Object.keys(all)); const bad = [];
    for (const [path, p] of Object.entries(all)) for (const m of p.html.matchAll(/href="(\/[^"#?]*)/g)) { const h = m[1] === '/' ? '/' : m[1].replace(/\/$/, ''); if (!known.has(h) && !existsSync(new URL('../../public' + h, import.meta.url)) && !['/drivers', '/blog', '/llms.txt', '/llms-full.txt', '/sitemap.xml', '/js/firebase-key.js'].includes(h)) bad.push(`${path} -> ${h}`); }
    expect([...new Set(bad)]).toEqual([]);
  });
  it('كل صفحة طريق مرتبطة من الفهرس ومن صفحات تانية (مفيش صفحة يتيمة)', () => {
    const inbound = new Map(ROUTES.map((r) => [routePath(r), 0]));
    for (const [path, p] of Object.entries(all)) for (const m of p.html.matchAll(/href="(\/routes\/[^"]+)"/g)) if (path !== m[1]) inbound.set(m[1], (inbound.get(m[1]) || 0) + 1);
    expect([...inbound].filter(([, n]) => n < 2)).toEqual([]);
    expect(all['/routes'].html.match(/href="\/routes\//g).length).toBe(ROUTES.length);
  });
});

describe('sitemap.xml', () => {
  it('XML سليم، ومفيهوش تكرار، وبيحتوي كل الصفحات القابلة للفهرسة', async () => {
    const r = await get(sitemap, '/sitemap.xml'); expect(r.status).toBe(200); expect(r.headers.get('content-type')).toMatch(/application\/xml/);
    expect(r.html).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
    const locs = [...r.html.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]); expect(new Set(locs).size).toBe(locs.length);
    const paths = locs.map((l) => l.replace(LP_ORIGIN, '') || '/'); for (const p of Object.keys(all)) expect(paths, p).toContain(p);
    for (const l of locs) expect(l.startsWith(LP_ORIGIN + '/')).toBe(true);
    for (const m of r.html.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)) expect(m[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const m of r.html.matchAll(/<priority>([^<]+)<\/priority>/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(0), expect(Number(m[1])).toBeLessThanOrEqual(1);
  });
  it('buildSitemap بيهرّب الرموز الخاصة', () => { expect(buildSitemap([{ path: '/a?x=1&y="2"' }])).toContain('&amp;y=&quot;2&quot;'); });
  it('robots.txt بيشاور على نفس الـsitemap وبيمنع /api/ بس', () => {
    const t = readFileSync(new URL('../../public/robots.txt', import.meta.url), 'utf8');
    expect(t).toContain(`Sitemap: ${LP_ORIGIN}/sitemap.xml`); expect(t).toMatch(/User-agent: \*\s+Allow: \/\s+Disallow: \/api\//); expect(t).not.toMatch(/Disallow: \/\s*$/m);
  });
});

describe('صفحات الطرق: الأرقام = الحاسبة والإعدادات', () => {
  it('المسافة والسعر في الصفحة = estimate() بتاعة الحاسبة لنفس الزوج والعربية', () => {
    for (const r of ROUTES.slice(0, 12)) { const f = routeFacts(DEFAULTS, r.a, r.b), e = estimate(DEFAULTS, r.a, r.b, 'goods', 'small'); expect(f.km, r.slug).toBe(e.km); expect(f.vehicles.find((v) => v.key === 'pickup').price, r.slug).toBe(e.price); }
  });
  it('الطريق الأبعد أغلى (نفس العربية)', () => { const p = (s) => routeFacts(DEFAULTS, findRoute(s).a, findRoute(s).b).vehicles[0].price; expect(p('cairo-to-giza')).toBeLessThan(p('cairo-to-alexandria')); expect(p('cairo-to-alexandria')).toBeLessThan(p('cairo-to-aswan')); });
  it('لو الأدمن غيّر الأسعار الصفحة بتتغيّر (مفيش أرقام ثابتة)', () => {
    const S2 = { ...DEFAULTS, vehiclePricing: { ...DEFAULTS.vehiclePricing, pickup: { ...DEFAULTS.vehiclePricing.pickup, perKm: DEFAULTS.vehiclePricing.pickup.perKm * 2 } } };
    const r = findRoute('cairo-to-alexandria'); expect(routeFacts(S2, r.a, r.b).low).toBeGreaterThan(routeFacts(DEFAULTS, r.a, r.b).low); expect(routeContent(S2, r).desc).not.toBe(routeContent(DEFAULTS, r).desc);
  });
  it('الـslugs: ASCII فريدة وقابلة للقراءة، ومسار مجهول = 404', async () => {
    const slugs = ROUTES.map((r) => r.slug); expect(new Set(slugs).size).toBe(slugs.length); for (const s of slugs) expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*-to-[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(routeSlug('cairo', 'alex')).toBe('cairo-to-alexandria'); expect(findRoute('nope')).toBeNull(); expect(findRoute(undefined)).toBeNull();
    const r = await get(routePage, '/routes/nope', { slug: 'nope' }); expect(r.status).toBe(404);
  });
  it('كل المدن في CITIES ليها صفحة طريق مع القاهرة أو الإسكندرية', () => { const covered = new Set(ROUTES.flatMap((r) => [r.a, r.b])); expect(Object.keys(CITIES).filter((k) => !covered.has(k))).toEqual([]); });
  it('بيانات منظّمة للطريق: Service + AggregateOffer بسعر منطقي', () => {
    const h = all['/routes/cairo-to-alexandria'].html; const ld = [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    const svc = ld.find((x) => x['@type'] === 'Service'), faq = ld.find((x) => x['@type'] === 'FAQPage'), bc = ld.find((x) => x['@type'] === 'BreadcrumbList');
    expect(svc.offers['@type']).toBe('AggregateOffer'); expect(svc.offers.priceCurrency).toBe('EGP'); expect(svc.offers.lowPrice).toBeGreaterThan(0); expect(svc.offers.highPrice).toBeGreaterThan(svc.offers.lowPrice);
    expect(faq.mainEntity.length).toBe(4); expect(bc.itemListElement.length).toBe(3);
  });
});
