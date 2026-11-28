// اختبار «النقط الثمانية» للمقالات كصفحات مستقلة: فتح مباشر بالرابط الحقيقي، HTML كامل (view-source)، ترقيم، سيو، sitemap، روابط داخلية.
import { describe, it, expect, beforeAll } from 'vitest';
import { boot } from '../helpers/harness.mjs';
import { saveArticle, blogPath, clearBlogCache, BLOG_PER_PAGE } from '../../functions/_lib/blog.js';
import { onRequest as blogIndex } from '../../functions/blog/index.js';
import { onRequest as blogPage } from '../../functions/blog/[slug].js';
import { onRequest as sitemap } from '../../functions/sitemap.xml.js';
import { DEFAULTS } from '../../functions/_lib/logic.js';
import { buildLanding } from '../../functions/_lib/landing.js';

const TOPICS = ['نقل أثاث من القاهرة للإسكندرية', 'تغليف الأثاث قبل النقل', 'أسعار نقل البضائع في مصر', 'اختيار عربية نقل مناسبة', 'نقل عفش شقة في الجيزة', 'شحن بضاعة للمنصورة', 'تأمين الشحنة أثناء النقل', 'فك وتركيب غرف النوم', 'نقل مكتب شركة بدون توقف', 'نصائح لتوفير تكلفة النقل', 'الفرق بين الدبابة والجامبو', 'نقل ثلاجة وغسالة بأمان', 'شحن بضائع من الأقصر لأسوان', 'تجهيز الشحنة للتحميل', 'مواعيد النقل الأفضل في الأسبوع'];
describe('المقالات كصفحات مستقلة', () => {
  let h; const get = (fn, path, params = {}) => fn({ request: new Request('https://ishhanli.pages.dev' + path), env: h.env, params });
  const slugs = [];
  beforeAll(async () => {
    h = await boot({});
    for (const [i, title] of TOPICS.entries()) {
      const a = await saveArticle(h.env, { title, body: `## مقدمة\nنص المقال رقم ${i} عن ${title} كامل داخل الـHTML نفسه.\n\n### تفصيلة\nفقرة تانية للمقال ${i}.`, description: `وصف فريد للمقال ${i}: ${title}`, excerpt: `ملخص ${i}`, status: 'published' });
      slugs.push(a.slug);
    }
    clearBlogCache();
  });

  it('1+2) كل مقال بيفتح مباشرة بكود 200 ومحتواه كامل في الـHTML (من غير JS)', async () => {
    for (const i of [0, 7, 14]) {
      const r = await get(blogPage, blogPath({ slug: slugs[i] }), { slug: encodeURIComponent(slugs[i]) });
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain(`نص المقال رقم ${i} عن ${TOPICS[i]} كامل داخل الـHTML نفسه.`);
      expect(html).not.toMatch(/href="#\//);
    }
  });
  it('6) title/description فريدين، canonical صحيح، OG، H1 واحد مع H2/H3', async () => {
    const seen = { t: new Set(), d: new Set() };
    for (const i of [0, 5, 9]) {
      const html = await (await get(blogPage, '/x', { slug: encodeURIComponent(slugs[i]) })).text();
      seen.t.add(html.match(/<title>([^<]*)<\/title>/)[1]); seen.d.add(html.match(/<meta name="description" content="([^"]*)"/)[1]);
      expect(html.match(/<h1[ >]/g).length).toBe(1);
      expect(html).toContain(`<link rel="canonical" href="https://ishhanli.pages.dev${blogPath({ slug: slugs[i] })}">`);
      for (const p of ['og:title', 'og:description', 'og:url', 'og:image', 'og:type']) expect(html).toContain(`property="${p}"`);
      expect(html).toContain('<h2>'); expect(html).toContain('<h3>');
    }
    expect(seen.t.size).toBe(3); expect(seen.d.size).toBe(3);
  });
  it('8) روابط لمقالات متعلقة وصفحات الخدمات وزرار طلب النقل', async () => {
    const html = await (await get(blogPage, '/x', { slug: encodeURIComponent(slugs[1]) })).text(); // «تغليف الأثاث…»
    expect(html).toContain('اقرأ كمان');
    expect(html).toContain(`href="${blogPath({ slug: slugs[0] })}"`); // الأقرب موضوعاً (أثاث) ضمن المتعلقة
    for (const p of ['/pricing', '/vehicles', '/how-it-works', '/routes']) expect(html).toContain(`href="${p}"`);
    expect(html).toContain('اطلب نقل دلوقتي');
  });
  it('مقال غير موجود = 404 حقيقي (مش redirect ولا الرئيسية)', async () => {
    const r = await get(blogPage, '/x', { slug: encodeURIComponent('مقال-مش-موجود') }); expect(r.status).toBe(404);
  });
  it('4) /blog: روابط a href عادية + ترقيم (12 في الصفحة) وصفحة خارج النطاق = 404', async () => {
    const r1 = await get(blogIndex, '/blog'); expect(r1.status).toBe(200);
    const h1 = await r1.text();
    expect((h1.match(/class="blog-card"/g) || []).length).toBe(BLOG_PER_PAGE);
    expect(h1).toContain('href="/blog?page=2"'); expect(h1).toContain('rel="next"');
    expect(h1).toContain('<link rel="canonical" href="https://ishhanli.pages.dev/blog">');
    const h2 = await (await get(blogIndex, '/blog?page=2')).text();
    expect((h2.match(/class="blog-card"/g) || []).length).toBe(TOPICS.length - BLOG_PER_PAGE);
    expect(h2).toContain('rel="prev"'); expect(h2).toContain('<link rel="canonical" href="https://ishhanli.pages.dev/blog?page=2">');
    expect((await get(blogIndex, '/blog?page=9')).status).toBe(404);
    expect((await get(blogIndex, '/blog?page=abc')).status).toBe(404);
    // كل المقالات الـ15 ظاهرة بروابط عادية عبر الصفحتين
    for (const s of slugs) expect(h1 + h2).toContain(`href="${blogPath({ slug: s })}"`);
  });
  it('7) sitemap فيه /blog وكل المقالات', async () => {
    const x = await (await get(sitemap, '/sitemap.xml')).text();
    expect(x).toContain('https://ishhanli.pages.dev/blog</loc>');
    for (const s of slugs) expect(x).toContain(`https://ishhanli.pages.dev${blogPath({ slug: s })}</loc>`);
  });
  it('5) هيدر الصفحة الرئيسية بروابط حقيقية (مش #/) بتشتغل من غير JS', () => {
    for (const design of ['a', 'b']) {
      const L = buildLanding({ settings: DEFAULTS, site: { ...DEFAULTS.site, design }, company: DEFAULTS.company, env: {} });
      const all = L.body;
      expect(all).toContain('href="/how-it-works"'); expect(all).toContain('href="/pricing"'); expect(all).toContain('href="/vehicles"');
      expect(all).not.toMatch(/href="#\/(how|services|price|trust|faq|top)"/);
      expect(all).toContain('href="/blog"'); expect(all).toContain('href="/for-drivers"'); expect(all).toContain('href="/for-companies"');
    }
  });
});
