// فحص accessibility آلي (axe-core / WCAG 2.1 A+AA) على الصفحات الرئيسية بمتصفح حقيقي، بالعربي والإنجليزي.
// بيفشل لو فيه مشاكل بدرجة serious/critical. المشاكل الأقل (moderate/minor) بتتطبع كتحذير بس.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';

const run = Date.now().toString(36);
const fakeDir = new URL('./fake-firebase/', import.meta.url);
const phoneFor = (email) => '010' + String([...email].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 1e8).padStart(8, '0');

test.beforeEach(async ({ page, baseURL }) => {
  await page.route((u) => !u.href.startsWith(baseURL) && !u.href.startsWith('data:') && !u.href.startsWith('blob:'), (r) => r.abort());
  await page.route('https://www.gstatic.com/firebasejs/**', async (route) => { const n = new URL(route.request().url()).pathname.split('/').pop(); await route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: await readFile(new URL(n, fakeDir)) }); });
});

async function scan(page, name, info) {
  const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const rows = res.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ').slice(0, 90), help: v.help }));
  if (rows.length) console.log(`A11Y[${name}]`, JSON.stringify(rows));
  info.annotations.push({ type: 'a11y', description: `${name}: ${rows.map((r) => `${r.id}(${r.impact},${r.nodes})`).join(' ') || 'clean'}` });
  return rows.filter((r) => r.impact === 'serious' || r.impact === 'critical');
}

for (const lang of ['ar', 'en']) {
  test(`الصفحات العامة (${lang}): مفيش مشاكل accessibility خطيرة`, async ({ page }, info) => {
    await page.addInitScript((l) => localStorage.setItem('lang', l), lang);
    const bad = [];
    for (const [name, path] of [['landing', '/'], ['login', '/#/login'], ['register', '/#/register']]) { await page.goto(path); await page.waitForTimeout(1200); bad.push(...(await scan(page, `${name}-${lang}`, info)).map((r) => ({ name, ...r }))); }
    expect(bad).toEqual([]);
  });
}

test('بعد تسجيل الدخول (عميل): مفيش مشاكل خطيرة', async ({ page }, info) => {
  const email = `a11y-${run}@e2e.test`;
  await page.goto('/#/register'); await page.fill('input[name=name]', 'عميل'); await page.fill('input[name=phone]', phoneFor(email)); await page.fill('input[name=email]', email); await page.fill('input[name=password]', 'Passw0rd!'); await page.check('input[name=terms]'); await page.click('#submit');
  await expect(page.locator('[data-logout], #userBtn').first()).toBeVisible({ timeout: 15000 });
  const bad = [];
  for (const [name, path] of [['customer', '/#/customer'], ['new-order', '/#/customer/new']]) { await page.goto(path); await page.waitForTimeout(1500); bad.push(...(await scan(page, name, info)).map((r) => ({ name, ...r }))); }
  expect(bad).toEqual([]);
});

test('الوضع الليلي (الرئيسية وتسجيل الدخول): مفيش مشاكل خطيرة', async ({ page }, info) => {
  const bad = [];
  for (const [name, path] of [['landing-dark', '/'], ['login-dark', '/#/login']]) {
    await page.goto(path); await page.waitForTimeout(1000);
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark')); await page.waitForTimeout(400);
    bad.push(...(await scan(page, name, info)).map((r) => ({ name, ...r })));
  }
  expect(bad).toEqual([]);
});

test('صفحة الـ404: مفيش مشاكل خطيرة (فاتح وليلي)', async ({ page }, info) => {
  const bad = [];
  await page.goto('/no-such-page'); bad.push(...(await scan(page, '404-light', info)));
  await page.emulateMedia({ colorScheme: 'dark' }); await page.goto('/no-such-page'); bad.push(...(await scan(page, '404-dark', info)));
  expect(bad).toEqual([]);
});

test('صفحات المحتوى وطرق النقل: مفيش مشاكل accessibility خطيرة (فاتح وليلي)', async ({ page }, info) => {
  const bad = [];
  for (const path of ['/pricing', '/vehicles', '/for-drivers', '/routes', '/routes/cairo-to-alexandria']) {
    for (const scheme of ['light', 'dark']) { await page.emulateMedia({ colorScheme: scheme }); await page.goto(path); await page.waitForTimeout(500); bad.push(...(await scan(page, `${path}-${scheme}`, info)).map((r) => ({ path, scheme, ...r }))); }
  }
  expect(bad).toEqual([]);
});
