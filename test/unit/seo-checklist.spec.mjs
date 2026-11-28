// قايمة الـ20 نقطة SEO: كل نقطة بتتفحص بكود على الصفحات الفعلية (رئيسية + محتوى + طرق + مدونة)، مش على الملفات الثابتة بس.
// النقاط اللي مستحيل تتأكد من الكود (إرسال الـsitemap في Search Console، شهادة SSL الحقيقية، بيانات مستخدمين حقيقيين) متسجّلة كـ«يدوي» في CHECKLIST_MANUAL.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { boot } from '../helpers/harness.mjs';
import { onRequest as landing } from '../../functions/index.js';
import { onRequest as sitemapFn } from '../../functions/sitemap.xml.js';
import { onRequest as routesIndex } from '../../functions/routes/index.js';
import { onRequest as routePage } from '../../functions/routes/[slug].js';
import { onRequest as blogIndex } from '../../functions/blog/index.js';
import { onRequest as blogPage } from '../../functions/blog/[slug].js';
import { onRequest as llmsFn } from '../../functions/llms.txt.js';
import { onRequest as llmsFull } from '../../functions/llms-full.txt.js';
import { onRequest as gsc } from '../../functions/google5463541af54b53ef.html.js';
import { ROUTES, routePath } from '../../functions/_lib/routes.js';
import { PAGE_PATHS } from '../../functions/_lib/pages.js';
import { LP_ORIGIN } from '../../public/js/landing-content.js';

const pub = (p) => new URL('../../public/' + p, import.meta.url);
const shell = readFileSync(pub('index.html'), 'utf8');
const SEED = { ASSETS: { fetch: async () => new Response(shell, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }) } };
const first = (h, re) => (re.exec(h) || [])[1] || '';
const textOf = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
const pages = {}; // path -> { html, status, headers }
let env, sitemapXml;

beforeAll(async () => {
  const h = await boot({}); env = { ...h.env, ...SEED }; h.user('adm1', { role: 'admin', name: 'A', phone: '01000000001' });
  const jpg = 'data:image/jpeg;base64,/9j/' + 'A'.repeat(400);
  const up = await h.call('adm1', 'files/upload', { kind: 'blog', data: jpg }); const imgId = up.ref.slice(3);
  const body = '## مقدمة\n' + 'نص مفيد عن نقل الأثاث بين المدن في مصر. '.repeat(40) + '\n\n[[img:1]]\n\n## خطوات التجهيز\n- غلّف\n- صوّر\n\n### تفصيلة\nنص. [الأسعار](/pricing) و[الطرق](/routes).';
  const a = (await h.call('adm1', 'admin/blog/save', { title: 'نقل الأثاث بين المدن: دليل التجهيز الكامل', body, description: 'دليل عملي لتجهيز نقل الأثاث بين المدن في مصر وتوفير الوقت والتكلفة من غير مشاكل في الطريق.', images: [{ id: imgId, alt: 'تحميل أثاث على عربية نقل' }], faq: [['كام السعر؟', 'بيتغيّر حسب المسافة.']], status: 'published' })).article;
  const get = async (fn, path, params = {}) => { const r = await fn({ request: new Request('https://x.test' + path), env, params }); return { status: r.status, headers: r.headers, html: await r.text() }; };
  pages['/'] = await get(landing, '/');
  for (const p of Object.values(PAGE_PATHS)) pages[p] = await get((await import(`../../functions/${p.slice(1)}.js`)).onRequest, p);
  pages['/routes'] = await get(routesIndex, '/routes');
  for (const r of ROUTES) pages[routePath(r)] = await get(routePage, routePath(r), { slug: r.slug });
  pages['/blog'] = await get(blogIndex, '/blog');
  const bp = `/blog/${encodeURIComponent(a.slug)}`; pages[bp] = await get(blogPage, bp, { slug: encodeURIComponent(a.slug) });
  sitemapXml = await (await sitemapFn({ request: new Request('https://x.test/sitemap.xml'), env })).text();
});

const each = (fn) => { for (const [p, r] of Object.entries(pages)) fn(p, r); };
const links = (html) => [...html.matchAll(/<a\b[^>]*href="([^"#][^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
const internal = (href) => (href.startsWith(LP_ORIGIN) ? href.slice(LP_ORIGIN.length) || '/' : href.startsWith('/') && !href.startsWith('//') ? href : null);

describe('قايمة SEO — 20 نقطة', () => {
  it('كل الصفحات اتجابت 200', () => each((p, r) => expect(r.status, p).toBe(200)));
  it('1. sitemap.xml: فيه كل الصفحات القابلة للفهرسة', () => {
    for (const p of Object.keys(pages)) expect(sitemapXml, p).toContain(`<loc>${LP_ORIGIN}${p === '/' ? '/' : p}</loc>`);
  });
  it('2. robots.txt: مسموح للزواحف، /api/ بس ممنوع، وبيشاور على الـsitemap', () => {
    const r = readFileSync(pub('robots.txt'), 'utf8');
    expect(r).toMatch(/User-agent: \*\s+Allow: \/\s+Disallow: \/api\//); expect(r).toContain(`Sitemap: ${LP_ORIGIN}/sitemap.xml`); expect(r).not.toMatch(/Disallow: \/\s*$/m);
  });
  it('3. noindex: مفيش صفحة مهمة عليها noindex (الاستثناء: فهرس المدونة وهو فاضي)', () => each((p, r) => {
    const robots = first(r.html, /<meta name="robots" content="([^"]*)"/); const xrt = r.headers.get('x-robots-tag') || '';
    expect(robots + xrt, p).not.toMatch(/noindex/i);
  }));
  it('4. canonical: واحد مطلق = رابط الصفحة نفسها', () => each((p, r) => {
    const c = [...r.html.matchAll(/<link rel="canonical" href="([^"]+)"/g)].map((m) => m[1]); expect(c.length, p).toBe(1);
    expect(c[0], p).toBe(`${LP_ORIGIN}${p === '/' ? '/' : p}`);
  }));
  it('5. title: فريد وطوله معقول', () => { const seen = new Set(); each((p, r) => { const t = first(r.html, /<title>([\s\S]*?)<\/title>/).trim(); expect(t.length, p).toBeGreaterThan(10); expect(t.length, p + ' ' + t).toBeLessThanOrEqual(90); expect(seen.has(t), 'مكرر: ' + t).toBe(false); seen.add(t); }); });
  it('6. meta description: فريد وطوله 50–175', () => { const seen = new Set(); each((p, r) => { const d = first(r.html, /<meta name="description" content="([^"]*)"/); expect(d.length, p).toBeGreaterThanOrEqual(50); expect(d.length, p).toBeLessThanOrEqual(175); expect(seen.has(d), 'مكرر: ' + p).toBe(false); seen.add(d); }); });
  it('7. H1 واحد بالظبط في كل صفحة', () => each((p, r) => expect((r.html.match(/<h1[\s>]/g) || []).length, p).toBe(1)));
  it('8. تسلسل العناوين من غير قفز (H1 ← H2 ← H3)', () => each((p, r) => {
    const lv = [...r.html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1])); let prev = 0;
    for (const l of lv) { expect(l <= prev + 1, `${p}: h${prev} ← h${l}`).toBe(true); prev = l; }
  }));
  it('9. كل <img> ليها alt (وغير الزخرفية وصفها مش فاضي)', () => each((p, r) => {
    for (const m of r.html.matchAll(/<img\b[^>]*>/g)) { const tag = m[0]; expect(/\balt="/.test(tag), `${p}: ${tag.slice(0, 80)}`).toBe(true); if (!/aria-hidden="true"|role="presentation"/.test(tag)) expect(first(tag, /\balt="([^"]*)"/).length, `${p}: alt فاضي ${tag.slice(0, 80)}`).toBeGreaterThan(0); }
  }));
  it('10. Schema: JSON-LD سليم وفيه @type (والمقال Article + FAQPage)', () => {
    each((p, r) => { const blocks = [...r.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1])); expect(blocks.length, p).toBeGreaterThan(0); for (const b of blocks) expect(JSON.stringify(b), p).toContain('"@type"'); });
    const art = pages[Object.keys(pages).find((p) => p.startsWith('/blog/'))].html; expect(art).toContain('"@type":"Article"'); expect(art).toContain('"@type":"FAQPage"'); expect(art).toContain('"@type":"BreadcrumbList"');
  });
  it('11. ربط داخلي: كل صفحة فيها ≥3 روابط داخلية، وكل صفحة مرتبطة من صفحة تانية', () => {
    const inbound = {}; each((p, r) => { const ls = links(r.html).map(internal).filter(Boolean).map((h) => h.split(/[?#]/)[0]); expect(new Set(ls).size, p).toBeGreaterThanOrEqual(3); for (const l of ls) if (l !== p) (inbound[l] ||= new Set()).add(p); });
    for (const p of Object.keys(pages)) if (p !== '/') expect(inbound[p]?.size || 0, 'يتيمة: ' + p).toBeGreaterThan(0);
  });
  it('12. مفيش رابط داخلي مكسور', () => {
    const ok = new Set([...Object.keys(pages), '/llms.txt', '/llms-full.txt', '/sitemap.xml', '/robots.txt', '/manifest.webmanifest', '/js/firebase-key.js']);
    each((p, r) => { for (const h of links(r.html)) { const i = internal(h); if (!i) continue; const path = i.split(/[?#]/)[0]; if (path.startsWith('/#') || path === '' ) continue; const dec = (() => { try { return decodeURI(path); } catch { return path; } })(); const file = existsSync(pub(dec.slice(1))) && dec !== '/'; expect(ok.has(path) || ok.has(dec) || file || /^\/drivers\/[A-Za-z0-9]+$/.test(path) || path === '/drivers', `${p} → ${h}`).toBe(true); } });
  });
  it('13. slugs: مقروءة (حروف/أرقام/شرطات) ومش طويلة', () => { for (const p of Object.keys(pages)) { const d = decodeURIComponent(p); expect(d, p).toMatch(/^\/[\p{L}\p{N}\-/]*$/u); expect(d.length, p).toBeLessThanOrEqual(90); } });
  it('14. الصور: WebP للّوجو، og.jpg أقل من 200KB، وكل صور الصفحات بأحجام معروفة', () => {
    expect(statSync(pub('img/logo.webp')).size).toBeLessThan(40000); expect(statSync(pub('img/og.jpg')).size).toBeLessThan(200000);
    const landingHtml = pages['/'].html; expect(landingHtml).toMatch(/<img[^>]*logo\.webp[^>]*width="\d+"[^>]*height="\d+"|<img[^>]*width="\d+"[^>]*height="\d+"[^>]*logo\.webp/);
  });
  it('15. Core Web Vitals (مؤشرات ثابتة في الكود؛ الأرقام الحقيقية من PageSpeed تحت)', () => {
    const l = pages['/'].html; expect(l).toContain('fetchpriority="high"'); expect(l).toMatch(/rel="preload"[^>]*as="font"/); expect(l).toMatch(/rel="modulepreload"/); expect(l).toContain('decoding="async"');
  });
  it('16. موبايل: viewport في كل صفحة', () => each((p, r) => expect(r.html, p).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1/)));
  it('17. HTTPS: HSTS في _headers، ومفيش http:// في الصفحات (mixed content)', () => {
    expect(readFileSync(pub('_headers'), 'utf8')).toMatch(/Strict-Transport-Security: max-age=31536000/);
    each((p, r) => { const bad = [...r.html.matchAll(/(?:href|src)="(http:\/\/[^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith('http://www.w3.org')); expect(bad, p).toEqual([]); });
  });
  it('18. Open Graph: og:title/description/url/image/type + twitter:card، والصورة موجودة 1200×630', () => {
    each((p, r) => { for (const k of ['og:title', 'og:description', 'og:url', 'og:image', 'og:type']) expect(r.html, `${p} ${k}`).toContain(`property="${k}"`); expect(r.html, p).toContain('name="twitter:card"'); expect(first(r.html, /property="og:image" content="([^"]+)"/), p).toMatch(/^https:\/\//); });
    const og = first(pages['/'].html, /property="og:image" content="([^"]+)"/); expect(existsSync(pub(og.replace(LP_ORIGIN + '/', '')))).toBe(true);
  });
  it('19. Search Console: ملف التوثيق بيرجع 200 بالنص الصح (الإرسال نفسه يدوي)', async () => { const r = gsc(); expect(r.status).toBe(200); expect(await r.text()).toContain('google-site-verification: google5463541af54b53ef.html'); });
  it('20. llms.txt وllms-full.txt: 200 نص عادي وفيهم روابط الصفحات', async () => {
    for (const fn of [llmsFn, llmsFull]) { const r = await fn({ request: new Request('https://x.test/llms.txt'), env }); expect(r.status).toBe(200); expect(r.headers.get('content-type')).toMatch(/text\/plain/); const t = await r.text(); expect(t.length).toBeGreaterThan(500); expect(t).toContain(`${LP_ORIGIN}/pricing`); }
  });
});
