// اختبارات المتصفح الحقيقي (Chromium) كمستخدم فعلي: الصفحة الرئيسية، التسجيل، الدخول، الخروج.
// Firebase Auth بيتستبدل ببديل اختباري (test/e2e/fake-firebase) والـAPI شغّال على Firestore وهمي، فمفيش أي لمس لبيانات حقيقية.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const run0 = Date.now().toString(36);
let run = run0; // بيتضبط لكل مشروع في beforeEach عشان الإيميلات ما تتصادمش بين ديسكتوب وموبايل
// رقم تليفون فريد لكل إيميل (الـAPI بيرفض الأرقام المكررة)
const phoneFor = (email) => '010' + String([...email].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 1e8).padStart(8, '0');
const fakeDir = new URL('./fake-firebase/', import.meta.url);

test.beforeEach(async ({ page, baseURL }, testInfo) => {
  run = run0 + '-' + testInfo.project.name;
  // ترتيب مهم: Playwright بيدّي أولوية لآخر route اتسجّل، فقاعدة الحجب الأول وبعدين استبدال Firebase
  await page.route((u) => !u.href.startsWith(baseURL) && !u.href.startsWith('data:') && !u.href.startsWith('blob:'), (route) => route.abort());
  await page.route('https://www.gstatic.com/firebasejs/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    await route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: await readFile(new URL(name, fakeDir)) });
  });
  page.on('pageerror', (e) => { throw new Error('uncaught page error: ' + e.message); });
  page.on('console', (m) => { if (/Content Security Policy|Refused to (load|connect|execute|apply)/i.test(m.text())) throw new Error('CSP violation: ' + m.text().slice(0, 200)); });
});

test('الصفحة الرئيسية بتتحمّل عربي RTL من غير أخطاء', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/اشحنلي/);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('body')).not.toBeEmpty();
});

test('صفحة الدخول: بيانات غلط تعرض رسالة خطأ', async ({ page }) => {
  await page.goto('/#/login');
  await page.fill('input[name=email]', `nobody-${run}@e2e.test`); await page.fill('input[name=password]', 'wrongpass1');
  await page.click('button[type=submit]');
  await expect(page.locator('#err')).not.toBeEmpty();
});

test('تسجيل عميل جديد ← دخول تلقائي ← خروج ← دخول تاني', async ({ page }) => {
  const email = `ui-${run}@e2e.test`, password = 'Passw0rd!';
  await page.goto('/#/register');
  await page.fill('input[name=name]', 'عميل واجهة'); await page.fill('input[name=phone]', phoneFor(email));
  await page.fill('input[name=email]', email); await page.fill('input[name=password]', password); await page.check('input[name=terms]');
  await page.click('#submit');
  await expect(page.locator('[data-logout], #userBtn').first()).toBeVisible({ timeout: 15000 });
  await page.evaluate(() => window.dispatchEvent(new Event('app:logout')));
  await expect(page.locator('a[href$="#/login"]:visible').first(), 'بعد الخروج لازم يظهر رابط دخول للمستخدم').toBeVisible({ timeout: 10000 }); // :visible لأن الصفحة الرئيسية ليها هيدر خاص بجانب هيدر التطبيق
  await page.goto('/#/login');
  await page.fill('input[name=email]', email); await page.fill('input[name=password]', password); await page.click('button[type=submit]');
  await expect(page.locator('[data-logout], #userBtn').first()).toBeVisible({ timeout: 15000 });
});

test('مسار مجهول ما بيكسرش التطبيق', async ({ page }) => {
  await page.goto('/#/no-such-page');
  await expect(page.locator('body')).not.toBeEmpty();
});

async function login(page, email, password) {
  await page.goto('/#/login');
  await page.fill('input[name=email]', email); await page.fill('input[name=password]', password); await page.click('button[type=submit]');
  await expect(page.locator('[data-logout], #userBtn').first()).toBeVisible({ timeout: 15000 });
}

test('الأدمن بيدخل ويظهرله رابط لوحة التحكم', async ({ page }) => {
  await login(page, 'admin@e2e.test', 'Admin#12345');
  await expect(page.locator('a[href="#/admin"]').first()).toBeAttached({ timeout: 10000 });
});

test('العميل العادي ما يقدرش يفتح لوحة الأدمن', async ({ page }) => {
  const email = `guard-${run}@e2e.test`;
  await page.goto('/#/register');
  await page.fill('input[name=name]', 'عميل حماية'); await page.fill('input[name=phone]', phoneFor(email));
  await page.fill('input[name=email]', email); await page.fill('input[name=password]', 'Passw0rd!'); await page.check('input[name=terms]');
  await page.click('#submit');
  await expect(page.locator('[data-logout], #userBtn').first()).toBeVisible({ timeout: 15000 });
  await page.goto('/#/admin/overview');
  await page.waitForTimeout(1500);
  await expect(page.locator('a[href="#/admin"]')).toHaveCount(0);   // مفيش رابط أدمن في القايمة
  await expect(page.locator('body')).not.toContainText('admin/stats'); // ومفيش بيانات أدمن اتعرضت
});

async function registerAndOpenNewOrder(page, tag) {
  const email = `${tag}-${run}@e2e.test`;
  await page.goto('/#/register');
  await page.fill('input[name=name]', 'عميل طلب'); await page.fill('input[name=phone]', phoneFor(email));
  await page.fill('input[name=email]', email); await page.fill('input[name=password]', 'Passw0rd!'); await page.check('input[name=terms]');
  await page.click('#submit');
  await expect(page.locator('[data-logout], #userBtn').first()).toBeVisible({ timeout: 15000 });
  await page.goto('/#/customer/new');
}

test('صفحة طلب جديد: الخريطة (Leaflet المستضاف عندنا) بتتحمّل من غير أي CDN خارجي', async ({ page }) => {
  await registerAndOpenNewOrder(page, 'order');
  await expect(page.locator('.leaflet-container').first()).toBeVisible({ timeout: 15000 });
});

test('صفحة طلب جديد: لو ملف الخريطة فشل تعرض رسالة وزر إعادة المحاولة بدل ما تقع', async ({ page }) => {
  await page.route('**/vendor/leaflet-1.9.4/leaflet.js', (r) => r.abort());
  await registerAndOpenNewOrder(page, 'orderfail');
  await expect(page.locator('body')).toContainText('إعادة المحاولة', { timeout: 15000 });
});

test('مفيش تمرير أفقي في الرئيسية وصفحة الدخول (تجاوب)', async ({ page }) => {
  for (const route of ['/', '/#/login', '/#/register']) {
    await page.goto(route); await page.waitForTimeout(600);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(over, route).toBeLessThanOrEqual(1);
  }
});

// ---------- السواق والأدمن (واجهة حقيقية) ----------
const JPEG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(400, 7)]).toString('base64');
async function makeActiveDriver(request, tag) {
  const email = `drv-${tag}-${run}@e2e.test`, password = 'Passw0rd!';
  const nid = '29' + String([...email].reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5)).padStart(12, '0').slice(-12); // رقم قومي فريد (الـAPI بيرفض المكرر)
  const { uid } = await (await request.post('/__e2e/auth', { data: { op: 'signup', email, password } })).json();
  const tok = async (u = uid, e = email) => (await (await request.get(`/__e2e/token?uid=${u}&email=${e}`)).json()).token;
  const api = async (route, data, t) => { const r = await request.post('/api/' + route, { headers: { Authorization: 'Bearer ' + t }, data }); return { ...(await r.json().catch(() => ({}))), http: r.status() }; };
  const t = await tok(); const up = async (kind) => (await api('files/upload', { kind, data: JPEG }, t)).ref;
  const reg = await api('register', { role: 'driver', name: 'سواق واجهة', phone: phoneFor(email), nationalId: nid, vehicleType: 'pickup', idRef: await up('id'), licenseRef: await up('license'), vehicleRegRef: await up('vehicle'), vehiclePhotoRef: await up('vehiclePhoto') }, t);
  expect(reg.http, 'register: ' + JSON.stringify(reg)).toBe(200);
  const act = await api('admin/user', { uid, status: 'active' }, await tok('uid-admin', 'admin@e2e.test')); expect(act.http, 'activate').toBe(200);
  expect((await api('me', {}, t)).profile?.status, 'سواق مفعّل فعلاً').toBe('active'); // تحقّق إن الفيكستشر سليم قبل ما نختبر الواجهة
  return { email, password };
}

test.describe('السواق', () => {
  test.use({ geolocation: { latitude: 30.0444, longitude: 31.2357 }, permissions: ['geolocation'] });
  test('سواق مفعّل: يدخل ويفتح كل صفحاته من غير أخطاء', async ({ page, request }) => {
    const d = await makeActiveDriver(request, 'ui');
    await login(page, d.email, d.password);
    for (const r of ['#/driver', '#/driver/jobs', '#/driver/wallet', '#/driver/dashboard', '#/driver/fees']) {
      await page.goto('/' + r); await page.waitForTimeout(1200);
      await expect(page.locator('body'), r).not.toBeEmpty();
      await expect(page.locator('[data-logout], #userBtn').first(), r).toBeVisible(); // لسه مسجّل دخول ومفيش انهيار
    }
    if (test.info().project.name === 'ui') await expect(page.locator('a[href="#/driver/jobs"]').first()).toBeAttached(); // قايمة الموبايل بتتبني عند الفتح
    await expect(page.locator('#submit'), 'مفيش شاشة تسجيل/استكمال بيانات للسواق المفعّل').toHaveCount(0);
    await expect(page.locator('a[href="#/admin"]')).toHaveCount(0); // السواق ما يشوفش رابط الأدمن
  });
  test('عميل ما يقدرش يفتح صفحات السواق', async ({ page }) => {
    const email = `cdrv-${run}@e2e.test`;
    await page.goto('/#/register');
    await page.fill('input[name=name]', 'عميل'); await page.fill('input[name=phone]', phoneFor(email));
    await page.fill('input[name=email]', email); await page.fill('input[name=password]', 'Passw0rd!'); await page.check('input[name=terms]');
    await page.click('#submit'); await expect(page.locator('[data-logout], #userBtn').first()).toBeVisible({ timeout: 15000 });
    await page.goto('/#/driver/wallet'); await page.waitForTimeout(1200);
    await expect(page.locator('a[href="#/driver/jobs"]')).toHaveCount(0);
  });
});

test('الأدمن: كل تابات لوحة التحكم بتفتح من غير أخطاء (JS/CSP)', async ({ page }) => {
  await login(page, 'admin@e2e.test', 'Admin#12345');
  await page.goto('/#/admin/overview'); await page.waitForTimeout(2000);
  const tabs = await page.$$eval('a[href^="#/admin/"]', (as) => [...new Set(as.map((a) => a.getAttribute('href')))]);
  expect(tabs.length).toBeGreaterThan(5); // لقينا تابات فعلاً
  for (const t of tabs) { await page.goto('/' + t); await page.waitForTimeout(900); await expect(page.locator('body'), t).not.toBeEmpty(); }
});

// الصفحة الرئيسية على الموبايل: لازم رابط "دخول" ظاهر (كان متخفي على ≤900px) ومفيش عنصر في الهيدر بيتقص برّه الشاشة
for (const design of ['a', 'b']) for (const lang of ['ar', 'en']) {
  test(`الرئيسية على الموبايل (تصميم ${design}، ${lang}): رابط الدخول ظاهر ومفيش قص في الهيدر`, async ({ browser, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'ui', 'بتعمل سياقات بعروض موبايل بنفسها، فمش محتاجة تتكرر في مشروع الموبايل'); test.setTimeout(90_000);
    for (const w of [320, 360, 390]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 800 }, baseURL }); const page = await ctx.newPage();
      await page.addInitScript((l) => localStorage.setItem('lang', l), lang);
      await page.route((u) => !u.href.startsWith(baseURL) && !u.href.startsWith('data:') && !u.href.startsWith('blob:'), (r) => r.abort());
      await page.route('https://www.gstatic.com/firebasejs/**', async (route) => { const n = new URL(route.request().url()).pathname.split('/').pop(); await route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: await readFile(new URL(n, fakeDir)) }); });
      await page.goto(`/?preview=${design}`); await page.waitForTimeout(800);
      await expect(page.locator('.lp-act a[href$="#/login"]:visible').first(), `w=${w}`).toBeVisible();
      const clipped = await page.evaluate(() => [...document.querySelectorAll('.lp-head .lp-act > *')].filter((e) => { const q = e.getBoundingClientRect(); return q.width > 0 && (q.right > innerWidth + 1 || q.left < -1); }).length);
      expect(clipped, `w=${w} عناصر مقصوصة`).toBe(0);
      await ctx.close();
    }
  });
}

test('مسار غلط بيرجّع 404 حقيقي وصفحة واضحة فيها رابط للرئيسية', async ({ page }) => {
  const res = await page.goto('/no-such-page-' + run);
  expect(res.status()).toBe(404);
  await expect(page.locator('h1')).toContainText('الصفحة غير موجودة');
  await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', /noindex/);
  await page.click('a[href="/"]'); await expect(page).toHaveURL(/\/$/);
});

test('الرؤوس الأمنية موجودة على الصفحة الرئيسية وعلى الـAPI (من كود الـFunctions نفسه)', async ({ request }) => {
  const home = await request.get('/'); for (const k of ['content-security-policy', 'x-frame-options', 'strict-transport-security', 'x-content-type-options', 'referrer-policy']) expect(home.headers()[k], k).toBeTruthy();
  const api = await request.get('/api/health'); expect(api.headers()['cache-control']).toBe('no-store'); expect(api.headers()['x-content-type-options']).toBe('nosniff');
});
