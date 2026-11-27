// اختبارات المتصفح لتعديلات v0.4: اللوجو ← الرئيسية، التسجيل كشركة شحن، «طلباتي» والترحيب، التسعير المبسّط بالأدمن، تبويب المقالات.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';

const run0 = Date.now().toString(36); let run = run0; const runTag = run0;
const phoneFor = (email) => '010' + String([...email].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 1e8).padStart(8, '0');
const fakeDir = new URL('./fake-firebase/', import.meta.url);
test.beforeEach(async ({ page, baseURL }, testInfo) => {
  run = run0 + '-c-' + testInfo.project.name;
  await page.route((u) => !u.href.startsWith(baseURL) && !u.href.startsWith('data:') && !u.href.startsWith('blob:'), (route) => route.abort());
  await page.route('https://www.gstatic.com/firebasejs/**', async (route) => { const name = new URL(route.request().url()).pathname.split('/').pop(); await route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: await readFile(new URL(name, fakeDir)) }); });
  page.on('pageerror', (e) => { throw new Error('uncaught page error: ' + e.message); });
  page.on('console', (m) => { if (/Content Security Policy|Refused to (load|connect|execute|apply)/i.test(m.text())) throw new Error('CSP violation: ' + m.text().slice(0, 200)); });
});
async function login(page, email, password) {
  await page.goto('/#/login'); await page.fill('input[name=email]', email); await page.fill('input[name=password]', password); await page.click('button[type=submit]');
  await expect(page.locator('[data-logout], #userBtn').first()).toBeVisible({ timeout: 15000 });
}
async function registerCustomer(page, tag) {
  const email = `${tag}-${run}@e2e.test`;
  await page.goto('/#/register'); await page.fill('input[name=name]', 'عميل تعديلات'); await page.fill('input[name=phone]', phoneFor(email));
  await page.fill('input[name=email]', email); await page.fill('input[name=password]', 'Passw0rd!'); await page.check('input[name=terms]'); await page.click('#submit');
  await expect(page.locator('[data-logout], #userBtn').first()).toBeVisible({ timeout: 15000 });
}

test('اللوجو واسم «اشحنلي» في الهيدر بيودّوا للرئيسية حتى لو مسجّل دخول', async ({ page }) => {
  await registerCustomer(page, 'logo'); await expect(page).toHaveURL(/#\/customer/);
  await page.locator('header a.brand, a.brand').first().click();
  await expect(page).toHaveURL(/#\/home/); await expect(page.locator('#lpMark, .lpa-hero').first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator('h1').first()).not.toHaveText('طلباتي'); // مش رجع لقايمة العميل
});

test('التسجيل: زرار «شركة شحن» ظاهر وبيفتح بيانات الشركة، وrole=company في الرابط بيختاره', async ({ page }) => {
  await page.goto('/#/register');
  await expect(page.locator('[data-role]')).toHaveCount(3);
  await page.click('[data-role=company]');
  await expect(page.locator('[data-role=company]')).toHaveClass(/on/); await expect(page.locator('[data-role=driver]')).not.toHaveClass(/on/);
  await expect(page.locator('input[name=isCompany]')).toBeChecked();
  await page.click('[data-role=customer]'); await expect(page.locator('input[name=isCompany]')).not.toBeChecked();
  await page.goto('/#/register?role=company'); await page.reload();
  await expect(page.locator('[data-role=company]')).toHaveClass(/on/); await expect(page.locator('input[name=isCompany]')).toBeChecked();
});

test('«طلباتي» فاضية: رسالة وزرار بس، والترحيب والقواعد في «طلب جديد»', async ({ page }) => {
  await registerCustomer(page, 'empty');
  await page.goto('/#/customer'); await expect(page.locator('.empty')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.empty a.btn')).toHaveAttribute('href', '#/customer/new');
  await expect(page.locator('body')).not.toContainText('أهلاً بيك في اشحنلي'); await expect(page.locator('.welcome-cta')).toHaveCount(0);
  await page.goto('/#/customer/new'); const d = page.locator('details.howto'); await expect(d).toBeVisible({ timeout: 10000 });
  await expect(d).not.toHaveAttribute('open', ''); await d.locator('summary').click(); await expect(d).toContainText('أهلاً بيك في اشحنلي'); await expect(d.locator('.welcome-cta')).toHaveCount(0);
});

test('الأدمن: كارت التسعير المبسّط (4 عربيات + أمثلة حيّة + مقارنة مرجعية) وبيحفظ', async ({ page }) => {
  await login(page, 'admin@e2e.test', 'Admin#12345');
  await page.goto('/#/admin/settings'); const rows = page.locator('input[name$=".perKm"][name^="vp."]'); await expect(rows).toHaveCount(4, { timeout: 15000 });
  const ex = page.locator('[data-ex="half_ton:200"]').first(); await expect(ex).not.toHaveText('');
  const before = await ex.textContent(); await page.fill('input[name="vp.half_ton.perKm"]', '20');
  await expect(ex).not.toHaveText(before); // المثال بيتحدّث وانت بتكتب
  const expected = Math.max(Math.ceil(Number(await page.inputValue('input[name="vp.half_ton.minPrice"]')) || Number(await page.inputValue('input[name=minPrice]'))), Math.ceil(Number(await page.inputValue('input[name="vp.half_ton.base"]')) + 20 * 200));
  expect((await ex.textContent()).replace(/[^\d]/g, '')).toBe(String(expected));
  // سعر العربية = 0 ← بنعرض حساب السعر العام (علامة *) زي السيرفر بالظبط
  await page.fill('input[name="vp.half_ton.perKm"]', '0'); const gen = Number(await page.inputValue('input[name=perKm]')), genMin = Number(await page.inputValue('input[name=minPrice]'));
  await expect.poll(async () => (await ex.textContent()).replace(/[^\d*]/g, '')).toBe(`${Math.max(genMin, Math.ceil(gen * 200))}*`);
  await page.fill('input[name="vp.half_ton.perKm"]', '20');
  await expect(page.locator('details summary').filter({ hasText: 'متقدّم' }).first()).toBeVisible();
  await page.click('#applyKg'); await expect(page.locator('input[name="vg.pickup.maxKg"]')).toHaveValue('850'); await expect(page.locator('input[name="vg.truck.maxKg"]')).toHaveValue('45000');
  await page.locator('#sf button[type=submit]').first().click(); await expect(page.locator('#toasts .toast:not(.bad)').first()).toBeVisible({ timeout: 10000 });
  await page.reload(); await expect(page.locator('input[name="vp.half_ton.perKm"]')).toHaveValue('20', { timeout: 15000 });
});

test('الأدمن: تبويب المقالات ← مقال يدوي ← نشر ← يظهر في /blog وsitemap', async ({ page, request }) => {
  await login(page, 'admin@e2e.test', 'Admin#12345');
  await page.goto('/#/admin/blog'); await expect(page.locator('#gen')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('body')).toContainText('GEMINI_API_KEY'); // مفيش مفتاح AI في بيئة الاختبار: تنبيه واضح
  await page.click('[data-act=new]'); const title = `مقال اختبار ${run}`;
  await page.fill('#ed input[name=title]', title); await page.fill('#ed textarea[name=body]', '## مقدمة\nنص المقال التجريبي الكامل للاختبار والتحقق من النشر.\n\n- نقطة أولى\n- نقطة تانية');
  await page.fill('#ed textarea[name=faq]', 'سؤال تجريبي؟ | إجابة تجريبية.');
  await page.locator('#ed button[data-pub="1"]').last().click(); await expect(page.locator('#ed button', { hasText: 'احفظ وارجّعه مسودة' })).toBeVisible({ timeout: 10000 });
  const slug = await page.inputValue('#ed input[name=slug]'); expect(slug.length).toBeGreaterThan(3);
  const res = await request.get('/blog/' + encodeURIComponent(slug)); expect(res.status()).toBe(200); expect(await res.text()).toContain(`<h1>${title}</h1>`);
  expect(await (await request.get('/sitemap.xml')).text()).toContain(encodeURIComponent(slug));
  await page.goto('/blog/' + encodeURIComponent(slug)); await expect(page.locator('h1')).toHaveText(title); await expect(page.locator('footer a[href="/blog"]')).toBeVisible();
});

test.describe('تثبيت كتطبيق على الموبايل', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  test('آيفون: زرار الفوتر بيفتح شرح خطوات Safari، والشريط بيظهر ويتقفل ويفتكر القفل', async ({ page }) => {
    await page.goto('/#/rules'); const btn = page.locator('footer.site [data-install]'); await expect(btn).toBeVisible({ timeout: 10000 });
    await btn.click(); const m = page.locator('.modal'); await expect(m).toContainText('إضافة إلى الشاشة الرئيسية'); await expect(m.locator('li')).toHaveCount(4);
    await m.locator('[data-close]').click(); await expect(m).toHaveCount(0);
    await page.waitForTimeout(500); await expect(page.locator('.install-bar')).toHaveCount(0); // لسه ما مرّرش: مفيش شريط بيغطّي المحتوى
    await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
    const bar = page.locator('.install-bar'); await expect(bar).toBeVisible({ timeout: 15000 });
    await bar.locator('.install-x').click(); await expect(bar).toHaveCount(0);
    await page.reload(); await page.waitForTimeout(8000); await expect(page.locator('.install-bar')).toHaveCount(0); // اتقفل ← مبيرجعش قبل 14 يوم
  });
  test('أندرويد/كروم: beforeinstallprompt بيتلقط وزرار «ثبّت» بيفتح النافذة الأصلية', async ({ page }) => {
    await page.addInitScript(() => { Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' }); });
    await page.goto('/#/rules');
    await page.evaluate(() => { const e = new Event('beforeinstallprompt', { cancelable: true }); e.prompt = async () => { window.__prompted = true; }; e.userChoice = Promise.resolve({ outcome: 'accepted' }); window.dispatchEvent(e); });
    await expect(page.locator('footer.site [data-install]')).toBeVisible({ timeout: 10000 }); // يعني initInstall اشتغل
    await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
    const bar = page.locator('.install-bar'); await expect(bar).toBeVisible({ timeout: 15000 }); await bar.locator('button.btn').click();
    await expect.poll(() => page.evaluate(() => window.__prompted === true)).toBe(true);
    await expect(page.locator('.modal')).toHaveCount(0); // نافذة المتصفح الأصلية بدل الشرح
  });
  test('متثبّت بالفعل (standalone): مفيش زرار ولا شريط', async ({ page }) => {
    await page.addInitScript(() => { const mm = window.matchMedia.bind(window); window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : mm(q)); });
    await page.goto('/#/rules'); await page.waitForTimeout(8000); await expect(page.locator('[data-install]')).toHaveCount(0); await expect(page.locator('.install-bar')).toHaveCount(0);
  });
});

test('فشل التوليد: السبب يفضل ظاهر في الصفحة (مش تنبيه بيختفي)', async ({ page }) => {
  await login(page, 'admin@e2e.test', 'Admin#12345');
  await page.route('**/api/admin/blog/list', async (r) => { const res = await r.fetch(); const j = await res.json(); r.fulfill({ response: res, json: { ...j, ai: 'gemini' } }); }); // بيئة الاختبار من غير مفتاح AI: نحاكي إنه موجود عشان الزرار يتفعّل
  await page.route('**/api/admin/blog/generate', (r) => r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'ai_failed', detail: 'gemini 503 (gemini-x-flash): high demand' }) }));
  await page.goto('/#/admin/blog'); await expect(page.locator('#gen')).toBeVisible({ timeout: 15000 });
  await page.fill('#gen input[name=title]', 'عنوان اختبار فشل التوليد'); await page.click('#gen button[type=submit]');
  const msg = page.locator('#genMsg'); await expect(msg).toContainText('high demand', { timeout: 10000 }); await expect(msg).toContainText('HTTP 502'); await expect(msg).toHaveClass(/err/);
  await page.waitForTimeout(7000); await expect(msg).toContainText('high demand'); // لسه ظاهر بعد ما التنبيه اختفى
  await expect(page.locator('#gen button[type=submit]')).toBeEnabled();
});

// ---- accessibility (axe WCAG 2.1 A+AA) للشاشات الجديدة: بيفشل لو serious/critical ----
async function serious(page, name) {
  const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const rows = res.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ').slice(0, 100) }));
  if (rows.length) console.log(`A11Y[${name}]`, JSON.stringify(rows));
  return rows.filter((r) => r.impact === 'serious' || r.impact === 'critical');
}
test('a11y: أدمن التسعير والمقالات (قايمة + محرّر) وصفحة مقال', async ({ page, request }) => {
  await login(page, 'admin@e2e.test', 'Admin#12345');
  await page.goto('/#/admin/settings'); await expect(page.locator('#applyKg')).toBeVisible({ timeout: 15000 });
  expect(await serious(page, 'admin-pricing')).toEqual([]);
  await page.goto('/#/admin/blog'); await expect(page.locator('#gen')).toBeVisible({ timeout: 15000 });
  expect(await serious(page, 'admin-blog-list')).toEqual([]);
  await page.click('[data-act=new]'); await expect(page.locator('#ed')).toBeVisible();
  expect(await serious(page, 'admin-blog-editor')).toEqual([]);
  await page.fill('#ed input[name=title]', `مقال فحص الوصول ${run0}`); await page.fill('#ed textarea[name=body]', '## مقدمة\nنص للفحص مع رابط https://ishhanli.pages.dev وكلام تاني.');
  await page.locator('#ed button[data-pub="1"]').last().click(); await expect(page.locator('#ed button', { hasText: 'احفظ وارجّعه مسودة' })).toBeVisible({ timeout: 10000 });
  const slug = await page.inputValue('#ed input[name=slug]'); await page.goto('/blog/' + encodeURIComponent(slug));
  expect(await serious(page, 'article')).toEqual([]);
  await page.goto('/blog'); expect(await serious(page, 'blog-index')).toEqual([]);
});
test.describe('a11y: تثبيت التطبيق', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  test('الشريط وشرح الخطوات', async ({ page }) => {
    await page.goto('/#/rules'); await expect(page.locator('footer.site [data-install]')).toBeVisible({ timeout: 10000 });
    await page.evaluate(() => window.dispatchEvent(new Event('scroll'))); await expect(page.locator('.install-bar')).toBeVisible({ timeout: 15000 });
    expect(await serious(page, 'install-bar')).toEqual([]);
    await page.locator('.install-bar button.btn').click(); await expect(page.locator('.modal')).toBeVisible();
    expect(await serious(page, 'install-guide')).toEqual([]);
  });
});
