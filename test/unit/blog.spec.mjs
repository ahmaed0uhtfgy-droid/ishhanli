// اختبار نظام المقالات: دوال نقية (سلاج/Markdown آمن/يوتيوب/JSON) + تكامل حقيقي فوق API وFirestore وهمي (صلاحيات، مسودة/نشر، صفحات عامة، sitemap، توليد بذكاء اصطناعي مُحاكى، تشغيل تلقائي، صور).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { boot } from '../helpers/harness.mjs';
import { slugify, mdToHtml, youtubeId, parseAiJson, cleanArticle, cleanConfig, ANGLES } from '../../functions/_lib/blog.js';
import { onRequest as blogIndex } from '../../functions/blog/index.js';
import { onRequest as blogPage } from '../../functions/blog/[slug].js';
import { onRequest as blogImg } from '../../functions/blog/img/[id].js';
import { onRequest as sitemap } from '../../functions/sitemap.xml.js';
import * as Blog from '../../functions/_lib/blog.js';
import { resetAiCache } from '../../functions/_lib/blog.js';

describe('دوال نقية', () => {
  it('slugify: عربي بدون تشكيل ولا رموز', () => { expect(slugify('نقلُ أثاثٍ من القاهرة إلى الإسكندرية!')).toBe('نقل-أثاث-من-القاهرة-إلى-الإسكندرية'); expect(slugify('  ')).toBe(''); expect(slugify('A/B c')).toBe('a-b-c'); });
  it('mdToHtml: بيهرّب HTML ويمنع روابط javascript:', () => {
    const h = mdToHtml('## عنوان <script>alert(1)</script>\n[x](javascript:alert(1)) و [y](/pricing) و [z](//evil.com) و [w](https://a.com/?a=1&b=2)');
    expect(h).not.toContain('<script'); expect(h).not.toContain('javascript:'); expect(h).toContain('<h2>'); expect(h).toContain('href="/pricing"'); expect(h).not.toContain('href="//evil'); expect(h).toContain('href="https://a.com/?a=1&amp;b=2"'); expect(h).toContain('rel="noopener nofollow"');
  });
  it('mdToHtml: قوائم وصور وفيديو', () => {
    const h = mdToHtml('- أ\n- ب\n\n1. واحد\n\n[[img:1]]\n[[img:9]]\n[[video]]', { images: [{ id: 'abcdefghij12', alt: 'وصف "ج"' }], video: 'dQw4w9WgXcQ', title: 't' });
    expect(h).toContain('<ul>'); expect(h).toContain('<ol>'); expect(h).toContain('src="/blog/img/abcdefghij12"'); expect(h).toContain('alt="وصف &quot;ج&quot;"'); expect(h).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ'); expect(h.match(/<figure/g).length).toBe(1);
  });
  it('youtubeId', () => { expect(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ'); expect(youtubeId('https://youtu.be/dQw4w9WgXcQ?t=3')).toBe('dQw4w9WgXcQ'); expect(youtubeId('https://evil.com/watch?v=dQw4w9WgXcQ')).toBe(''); expect(youtubeId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ'); expect(youtubeId('x')).toBe(''); });
  it('parseAiJson: سياج markdown ونص حواليه', () => { expect(parseAiJson('هاك:\n```json\n{"a":1}\n```')).toEqual({ a: 1 }); expect(() => parseAiJson('مفيش')).toThrow(); expect(() => parseAiJson('{bad')).toThrow(); });
  it('cleanArticle: حدود وتنظيف', () => {
    const a = cleanArticle({ title: 'عنوان تجريبي', body: 'x'.repeat(50), images: [{ id: 'bad id', alt: 'a' }, { id: 'abcdefghij12', alt: 'ok' }], faq: [['س', 'ج'], ['', 'x']], video: 'https://youtu.be/dQw4w9WgXcQ', status: 'whatever' });
    expect(a.status).toBe('draft'); expect(a.images).toEqual([{ id: 'abcdefghij12', alt: 'ok' }]); expect(a.faq).toEqual([['س', 'ج']]); expect(a.video).toBe('dQw4w9WgXcQ'); expect(a.slug).toBe('عنوان-تجريبي');
    expect(() => cleanArticle({ title: 'قصير', body: 'x'.repeat(50) })).toThrow(); expect(() => cleanArticle({ title: 'عنوان طويل كفاية', body: 'x' })).toThrow();
  });
  it('cleanConfig: حدود الساعات والمواضيع', () => { const c = cleanConfig({ topics: 'أ\nموضوع واحد\nموضوع واحد\nab', everyHours: 99999, autoEnabled: true }); expect(c.topics).toEqual(['موضوع واحد']); expect(c.everyHours).toBe(720); expect(c.autoEnabled).toBe(true); expect(c.autoPublish).toBe(false); });
});

describe('تكامل', () => {
  let h, origFetch, aiCalls = 0, aiBody;
  const good = () => ({ title: 'نقل أثاث من المنصورة للقاهرة: دليلك الكامل', slugWords: 'نقل اثاث المنصورة القاهرة', description: 'وصف '.repeat(30), excerpt: 'ملخص جذاب.', body: '## البداية\n' + 'فقرة مفيدة عن النقل. '.repeat(60) + '\n\n[[img:1]]\n\n## خطوات\n- جهّز\n- غلّف', faq: [['سؤال؟', 'إجابة.']], keywords: ['نقل أثاث', 'شحن'], imageIdeas: ['صورة تحميل'] });
  beforeAll(async () => {
    h = await boot({ GEMINI_API_KEY: 'test-key', AI_RETRY_MS: '0' });
    h.user('adm1', { role: 'admin', name: 'Adm', phone: '01000000001' }); h.user('cus1', { role: 'customer', name: 'Cus', phone: '01000000002' });
    origFetch = globalThis.fetch;
    globalThis.fetch = async (u, i) => { if (String(u).includes('generativelanguage.googleapis.com')) { aiCalls++; aiBody = JSON.parse(i.body); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(good()) }] } }] }), { status: 200 }); } return origFetch(u, i); };
  });
  afterAll(() => { globalThis.fetch = origFetch; });
  const page = (fn, path, params = {}) => fn({ request: new Request('https://x.test' + path), env: h.env, params });

  it('غير الأدمن ممنوع من كل مسارات المقالات', async () => {
    for (const r of ['admin/blog/list', 'admin/blog/save', 'admin/blog/generate', 'admin/blog/config', 'admin/blog/config/save', 'admin/blog/run', 'admin/blog/delete', 'admin/blog/get']) expect((await h.call('cus1', r, {})).status, r).toBe(403);
  });
  it('رفع صورة نوع blog للأدمن بس + الخدمة العامة', async () => {
    const jpg = 'data:image/jpeg;base64,/9j/' + 'A'.repeat(400);
    expect((await h.call('cus1', 'files/upload', { kind: 'blog', data: jpg })).status).toBe(403);
    const up = await h.call('adm1', 'files/upload', { kind: 'blog', data: jpg }); expect(up.status).toBe(200);
    const id = up.ref.slice(3); h.imgId = id;
    const ok = await page(blogImg, '/blog/img/' + id, { id }); expect(ok.status).toBe(200); expect(ok.headers.get('content-type')).toBe('image/jpeg');
    const cus = await h.call('cus1', 'files/upload', { kind: 'cargo', data: jpg }); expect(cus.status).toBe(200);
    expect((await page(blogImg, '/blog/img/x', { id: cus.ref.slice(3) })).status).toBe(404); // ملف عميل مش نوع blog
  });
  it('مسودة: مش ظاهرة للعامة، وبعد النشر تظهر بصفحة كاملة + JSON-LD + sitemap', async () => {
    const s = await h.call('adm1', 'admin/blog/save', { title: 'أسعار نقل العفش في مصر', body: '## مقدمة\nنص المقال كامل.\n\n[[img:1]]\n\n[[video]]', images: [{ id: h.imgId, alt: 'تحميل عفش' }], video: 'https://youtu.be/dQw4w9WgXcQ', faq: [['كام السعر؟', 'بيتغيّر حسب المسافة.']], keywords: ['نقل عفش'], status: 'draft' });
    expect(s.status).toBe(200); const a = s.article; expect(a.slug).toBe('أسعار-نقل-العفش-في-مصر');
    const slug = encodeURIComponent(a.slug);
    expect((await page(blogPage, '/blog/' + slug, { slug })).status).toBe(404);
    expect((await (await page(blogIndex, '/blog')).text())).toContain('noindex');
    const p = await h.call('adm1', 'admin/blog/save', { ...a, status: 'published' }); expect(p.status).toBe(200);
    const r = await page(blogPage, '/blog/' + slug, { slug }); expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('<h1>أسعار نقل العفش في مصر</h1>'); expect(html).toContain('"@type":"Article"'); expect(html).toContain('"@type":"FAQPage"'); expect(html).toContain('/blog/img/' + h.imgId); expect(html).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(r.headers.get('content-security-policy')).toContain('frame-src https://www.youtube-nocookie.com');
    expect(await (await page(blogIndex, '/blog')).text()).toContain('أسعار نقل العفش في مصر');
    const sm = await (await page(sitemap, '/sitemap.xml')).text(); expect(sm).toContain('/blog</loc>'); expect(sm).toContain('/blog/' + slug);
  });
  it('سلاج مكرر بيتفرّد، والحذف بيشيل المقال', async () => {
    const x = await h.call('adm1', 'admin/blog/save', { title: 'أسعار نقل العفش في مصر', body: 'x'.repeat(60), status: 'draft' }); expect(x.article.slug).toBe('أسعار-نقل-العفش-في-مصر-2');
    expect((await h.call('adm1', 'admin/blog/delete', { id: x.article.id })).status).toBe(200);
    expect((await h.call('adm1', 'admin/blog/get', { id: x.article.id })).status).toBe(404);
  });
  it('توليد بالذكاء الاصطناعي (مُحاكى): مسودة، تعليمات منع الاختلاق، وتغيير الزاوية', async () => {
    const r = await h.call('adm1', 'admin/blog/generate', { title: 'نقل أثاث من المنصورة', index: 0 }); expect(r.status).toBe(200);
    expect(r.article.status).toBe('draft'); expect(r.article.source).toBe('ai'); expect(r.article.slug).toBe('نقل-اثاث-المنصورة-القاهرة'); expect(r.article.imageIdeas).toEqual(['صورة تحميل']);
    const sys = aiBody.systemInstruction.parts[0].text; expect(sys).toContain('ممنوع تألّف أرقام'); expect(sys).toContain('ممنوع تقول إنك ذكاء اصطناعي');
    await h.call('adm1', 'admin/blog/generate', { title: 'نقل أثاث من المنصورة', index: 1 });
    expect(aiBody.contents[0].parts[0].text).toContain(ANGLES[1][1]);
    expect((await h.call('adm1', 'admin/blog/generate', { title: 'قصير' })).status).toBe(400);
  });
  it('فشل Gemini: الأدمن يشوف السبب (من غير المفتاح)، والـ404 بيلاقي موديل flash شغّال لوحده', async () => {
    resetAiCache(); const calls = []; const prev = globalThis.fetch;
    globalThis.fetch = async (u, i) => { const url = String(u); if (url.includes('generativelanguage.googleapis.com')) { calls.push(url); if (url.includes('/models?pageSize')) return new Response(JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-3-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-3-flash-lite', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-3-pro', supportedGenerationMethods: ['generateContent'] }] }), { status: 200 }); if (url.includes('gemini-2.5-flash:')) return new Response(JSON.stringify({ error: { message: 'models/gemini-2.5-flash is not found' } }), { status: 404 }); aiCalls++; return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(good()) }] } }] }), { status: 200 }); } return prev(u, i); };
    const r = await h.call('adm1', 'admin/blog/generate', { title: 'عنوان بعد اكتشاف الموديل', index: 0 }); expect(r.status).toBe(200);
    expect(calls.some((u) => u.includes('gemini-3-flash:generateContent'))).toBe(true); expect(calls.some((u) => u.includes('flash-lite:'))).toBe(false);
    globalThis.fetch = async (u, i) => (String(u).includes('generativelanguage') ? new Response(JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key. key=test-key' } }), { status: 400 }) : prev(u, i));
    h.env.GEMINI_MODEL = 'custom-model';
    const bad = await h.call('adm1', 'admin/blog/generate', { title: 'عنوان بمفتاح غلط', index: 0 }); expect(bad.status).toBe(502); expect(bad.error).toBe('ai_failed'); expect(bad.detail).toContain('gemini 400 (custom-model)'); expect(bad.detail).not.toContain('test-key');
    delete h.env.GEMINI_MODEL; globalThis.fetch = prev;
  });
  it('Gemini عليه ضغط (503): إعادة محاولة ثم موديل تاني، وبيفشل برسالة واضحة لو الكل مشغول', async () => {
    resetAiCache(); const prev = globalThis.fetch, seen = [];
    const list = new Response(JSON.stringify({ models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] }), { status: 200 });
    globalThis.fetch = async (u, i) => { const url = String(u); if (!url.includes('generativelanguage')) return prev(u, i); if (url.includes('/models?pageSize')) return list.clone(); const m = url.match(/models\/([^:]+):/)[1]; seen.push(m); if (m === 'gemini-2.5-flash' || m === 'gemini-3.8-flash') return new Response(JSON.stringify({ error: { message: 'high demand' } }), { status: 503 }); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(good()) }] } }] }), { status: 200 }); };
    const ok = await h.call('adm1', 'admin/blog/generate', { title: 'عنوان تحت ضغط الموديل', index: 0 }); expect(ok.status).toBe(200);
    expect(seen).toEqual(['gemini-2.5-flash', 'gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.5-flash']); // محاولتين لكل موديل مشغول ثم الناجح
    seen.length = 0; globalThis.fetch = async (u, i) => (String(u).includes('generativelanguage') ? (String(u).includes('/models?pageSize') ? list.clone() : (seen.push(1), new Response(JSON.stringify({ error: { message: 'high demand' } }), { status: 503 }))) : prev(u, i));
    const bad = await h.call('adm1', 'admin/blog/generate', { title: 'عنوان والكل مشغول', index: 0 }); expect(bad.status).toBe(502); expect(bad.detail).toContain('503'); expect(bad.detail).toContain('high demand'); expect(seen.length).toBeLessThanOrEqual(8);
    globalThis.fetch = prev;
  });
  it('الموديل رفض حقل thinking (400): بيعيد من غيره على نفس الموديل', async () => {
    resetAiCache(); const prev = globalThis.fetch, bodies = []; h.env.GEMINI_MODEL = 'gemini-x-flash';
    globalThis.fetch = async (u, i) => { if (!String(u).includes('generativelanguage')) return prev(u, i); const b = JSON.parse(i.body); bodies.push(!!b.generationConfig.thinkingConfig); if (b.generationConfig.thinkingConfig) return new Response(JSON.stringify({ error: { message: 'Invalid JSON payload: Unknown name "thinkingConfig"' } }), { status: 400 }); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(good()) }] } }] }), { status: 200 }); };
    try { const r = await h.call('adm1', 'admin/blog/generate', { title: 'عنوان موديل بدون تفكير', index: 0 }); expect(r.status).toBe(200); expect(bodies).toEqual([true, false]); } finally { delete h.env.GEMINI_MODEL; globalThis.fetch = prev; }
  });
  it('موديل بطيء (timeout لكل محاولة): بيقطع ويجرّب موديل تاني بدل ما يستنى للأبد', async () => {
    resetAiCache(); const prev = globalThis.fetch, seen = []; h.env.AI_ATTEMPT_MS = '30';
    const list = JSON.stringify({ models: [{ name: 'models/gemini-9-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-8-flash', supportedGenerationMethods: ['generateContent'] }] });
    globalThis.fetch = async (u, i) => { const url = String(u); if (!url.includes('generativelanguage')) return prev(u, i); if (url.includes('/models?pageSize')) return new Response(list, { status: 200 }); const m = url.match(/models\/([^:]+):/)[1]; seen.push(m); if (m !== 'gemini-8-flash') return new Promise((_, rej) => i.signal.addEventListener('abort', () => rej(new Error('aborted')))); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(good()) }] } }] }), { status: 200 }); };
    try { const r = await h.call('adm1', 'admin/blog/generate', { title: 'عنوان موديل بطيء جدا', index: 0 }); expect(r.status).toBe(200); expect(seen[seen.length - 1]).toBe('gemini-8-flash'); expect(seen.filter((m) => m === 'gemini-2.5-flash').length).toBe(2); } finally { delete h.env.AI_ATTEMPT_MS; globalThis.fetch = prev; }
  });
  it('مفيش مفتاح AI: خطأ واضح مش 500', async () => {
    const saved = h.env.GEMINI_API_KEY; delete h.env.GEMINI_API_KEY;
    const r = await h.call('adm1', 'admin/blog/generate', { title: 'عنوان بدون مفتاح' }); expect(r.status).toBe(503); expect(r.error).toBe('ai_not_configured');
    h.env.GEMINI_API_KEY = saved;
  });
  it('إعدادات التشغيل التلقائي + «شغّل دلوقتي» + الموعد', async () => {
    const c = await h.call('adm1', 'admin/blog/config/save', { autoEnabled: true, autoPublish: false, everyHours: 24, topics: ['موضوع أول للمقالات', 'موضوع تاني للمقالات'] }); expect(c.status).toBe(200); expect(c.config.topics.length).toBe(2);
    const before = aiCalls;
    const run = await h.call('adm1', 'admin/blog/run', {}); expect(run.ok).toBe(true); expect((await h.call('adm1', 'admin/blog/get', { id: run.id })).article.status).toBe('draft'); expect(aiCalls).toBe(before + 1); // h.call بيكتب status الـHTTP فوق حقل status في الرد
    expect((await Blog.getConfig(h.env)).cursor).toBe(1);
    expect(await Blog.autoTick(h.env, { throttle: false })).toEqual({ skipped: 'not_due' }); // لسه الموعد ما جاش
    await h.call('adm1', 'admin/blog/config/save', { autoEnabled: false, topics: ['موضوع أول للمقالات'] });
    expect(await Blog.autoTick(h.env, { throttle: false })).toEqual({ skipped: 'off' });
  });
  it('الـcron الخارجي: بمفتاح بس', async () => {
    const r1 = await h.raw('blog/cron', { body: {} }); expect([401, 403]).toContain(r1.status);
  });
});

describe('روابط قابلة للضغط في المقال', () => {
  it('أي https:// مكتوب عادي بيتحوّل لرابط، وعلامات الترقيم في آخره برّا الرابط، والـmarkdown links زي ما هي', () => {
    const h = mdToHtml('زور https://example.org/a?x=1&y=2. وكمان (https://example.org/b) و[نص **غامق**](https://example.org/c) وhttps://ishhanli.pages.dev/pricing، تمام.');
    expect(h).toContain('<a href="https://example.org/a?x=1&amp;y=2" rel="noopener nofollow" target="_blank">https://example.org/a?x=1&amp;y=2</a>.');
    expect(h).toContain('(<a href="https://example.org/b"'); expect(h).toContain('>https://example.org/b</a>)');
    expect(h).toContain('target="_blank">نص <strong>غامق</strong></a>');
    expect(h).toContain('<a href="/pricing">https://ishhanli.pages.dev/pricing</a>،'); // دومين الموقع: رابط داخلي بنص كامل
    expect((h.match(/<a /g) || []).length).toBe(4);
  });
  it('بدون استغلال: javascript:/http:/data: ما بيتحوّلوش لروابط، والـHTML بيتهرّب', () => {
    const h = mdToHtml('javascript:alert(1) و http://evil.com و data:text/html,x و <img src=x onerror=alert(1)> و [x](javascript:alert(1)) و https://a.com/"onmouseover="x');
    expect(h).not.toMatch(/<a [^>]*(javascript:|http:\/\/evil|data:)/); expect(h).not.toContain('<img'); expect(h).not.toMatch(/<a [^>]*onmouseover/);
  });
});
