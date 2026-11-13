// اختبارات مراجعة الأمان (نوفمبر 2026): XSS في JSON-LD، هيدرز صفحات السيرفر، CSP مفعّل، منع إعادة استخدام كود 2FA
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { driverPage, driversIndexPage } from '../functions/_lib/publicProfile.js';
import { totpCode, totpMatch } from '../functions/_lib/totp.js';
import { onRequest as how } from '../functions/how-it-works.js';

const check = (name, ok) => { assert.ok(ok, name); console.log('✓', name); };
const EVIL = '</script><script>alert(1)</script>';

// 1) اسم سواق خبيث ما يقدرش يكسر وسم JSON-LD ولا يضيف سكربت
{
  const u = { uid: 'drvEvil1', role: 'driver', status: 'active', name: EVIL, vehicle_type: 'pickup', created_at: Date.now(), completed_orders: 3, rating_sum: 10, rating_count: 2 };
  const html = await driverPage({}, u, 'https://x.test', {}).text();
  check('صفحة السواق: سكربت واحد بس (JSON-LD)', (html.match(/<script/gi) || []).length === 1);
  check('صفحة السواق: مفيش </script> قبل نهاية JSON-LD', !html.includes(EVIL) && !html.includes('<script>alert'));
  const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
  check('JSON-LD لسه JSON صالح والاسم محفوظ', JSON.parse(ld).name.includes('alert(1)'));
  const idx = await driversIndexPage([{ id: 'drvEvil1', name: EVIL, vehicle: '', rating: 0, trips: 0 }], 'https://x.test').text();
  check('فهرس السواقين: مفيش سكربت محقون', (idx.match(/<script/gi) || []).length === 1 && !idx.includes('<script>alert'));
  const r = driverPage({}, u, 'https://x.test', {});
  check('صفحة السواق: هيدرز أمنية (CSP + nosniff + frame)', /default-src 'none'/.test(r.headers.get('content-security-policy')) && r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('x-frame-options') === 'DENY');
}

// 2) صفحات السيو من السيرفر عليها هيدرز أمنية (ملف _headers مابيطبقش على الـFunctions)
{
  const r = await how({ request: new Request('https://x.test/how-it-works'), env: {} });
  check('/how-it-works: CSP بدون سكربتات', /default-src 'none'/.test(r.headers.get('content-security-policy')) && !/script-src/.test(r.headers.get('content-security-policy')));
  check('/how-it-works: nosniff + HSTS + frame DENY', r.headers.get('x-content-type-options') === 'nosniff' && /max-age/.test(r.headers.get('strict-transport-security')) && r.headers.get('x-frame-options') === 'DENY');
  check('/how-it-works: لسه HTML', r.status === 200 && (r.headers.get('content-type') || '').includes('text/html'));
}

// 3) _headers: CSP فعلي (مش Report-Only) وفيه nominatim (البحث بالعنوان) ومفيش unsafe-inline في السكربتات
{
  const h = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
  const csp = (h.match(/^\s*Content-Security-Policy: (.*)$/m) || [])[1] || '';
  check('CSP فعلي موجود', csp.includes("default-src 'self'"));
  check('مفيش Report-Only متبقي', !/Report-Only/i.test(h));
  check('nominatim مسموح في connect-src (البحث بالعنوان)', /connect-src[^;]*nominatim\.openstreetmap\.org/.test(csp));
  check('OSRM مسموح', /connect-src[^;]*router\.project-osrm\.org/.test(csp));
  check('script-src من غير unsafe-inline / unsafe-eval', !/script-src[^;]*'unsafe-(inline|eval)'/.test(csp));
  check('frame-ancestors none + object-src none', /frame-ancestors 'none'/.test(csp) && /object-src 'none'/.test(csp));
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  check('index.html: مفيش سكربت inline قابل للتنفيذ ولا inline handlers', !/<script(?![^>]*\bsrc=)(?![^>]*type="application\/(ld\+)?json")/i.test(html) && !/\son[a-z]+="/i.test(html));
}

// 4) TOTP: totpMatch بيرجّع العدّاد المطابق (أساس منع الـreplay)
{
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', c = Math.floor(Date.now() / 30000);
  check('totpMatch: الكود الحالي = العدّاد الحالي', (await totpMatch(secret, await totpCode(secret, c))) === c || (await totpMatch(secret, await totpCode(secret, c))) === c + 0);
  check('totpMatch: كود الخطوة اللي فاتت = c-1', (await totpMatch(secret, await totpCode(secret, c - 1))) === c - 1);
  check('totpMatch: كود بعيد/غلط = null', (await totpMatch(secret, await totpCode(secret, c + 5))) === null && (await totpMatch(secret, '12ab')) === null);
}
// 5) زرار الخروج ظاهر دايماً (مش جوه قايمة بس) — الشريط العلوي + الصفحة الرئيسية
{
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  check('الشريط العلوي: زرار خروج مستقل مش جوه القايمة', /class="icon-btn tb-out" data-logout/.test(app));
  check('قايمة الحساب لسه فيها خروج', /menu-item danger" role="menuitem" data-logout/.test(app));
  check('مفيش id="logout" مكرر', !/id="logout"/.test(app));
  check('أيقونة سهم على زرار الحساب (يوضّح إنه قايمة)', /class="chev"/.test(app));
  const land = readFileSync(new URL('../functions/_lib/landing.js', import.meta.url), 'utf8');
  check('الرئيسية: زرار خروج في التصميمين', (land.match(/\$\{logoutA\}/g) || []).length === 2 && /data-lp="logout" hidden/.test(land));
  const lp = readFileSync(new URL('../public/js/landing.js', import.meta.url), 'utf8');
  check('الرئيسية: الزرار بيظهر بس لما المستخدم داخل', /out\.hidden = !user/.test(lp) && /app:logout/.test(lp));
}
// 6) قايمة الحساب الجديدة + الشريط المرتب + CSS
{
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
  const i18n = readFileSync(new URL('../public/js/i18n.js', import.meta.url), 'utf8');
  for (const k of ['menu.profile', 'menu.profileSub', 'menu.notif', 'menu.notifOn', 'menu.notifEnable', 'menu.look', 'menu.lang', 'menu.theme', 'menu.light', 'menu.dark', 'menu.font', 'menu.info']) {
    check(`ترجمة ${k} عربي+إنجليزي`, new RegExp(`\\['${k.replace('.', '\\.')}', '[^']+', '[^']+'\\]`).test(i18n));
    check(`${k} مستخدم في القايمة`, app.includes(`t('${k}')`));
  }
  check('قايمة الحساب: لغة + مظهر + خط + معلومات', /data-set-lang/.test(app) && /data-set-theme/.test(app) && /id="fup"/.test(app) && /href="#\/privacy"/.test(app) && /href="#\/rules"/.test(app));
  check('صف التحقق بخطوتين اتشال من القايمة (الميزة نفسها لسه في صفحة الحساب)', !/t\('menu\.tfa'\)/.test(app) && /tfaBody/.test(readFileSync(new URL('../public/js/pages/account.js', import.meta.url), 'utf8')));
  check('عناصر القايمة class منفصل (segp) مش .seg القديم', /class="segp"/.test(app) && !/class="seg"/.test(app) && /\.segp \{/.test(css));
  check('زرار الخروج على الشاشة العريضة: عرض كامل في القايمة', /\.menu-item\.danger \{[^}]*width: calc\(100% - 1\.8rem\)/.test(css));
  check('الإغلاق خارج القايمة بيستخدم composedPath (مش closest على عنصر اتشال)', /composedPath\(\)\.some/.test(app));
  check('عن اشحنلي للمسجّل في القايمة مش الشريط', /\.\.\.\(p \? \[\] : \[\['\/about'/.test(app));
  check('الوضع الليلي واللغة في الشريط للزائر بس', /\$\{p \? '' : html`<button class="icon-btn" id="theme"/.test(app));
  check('زرار الخروج: صف أفقي (مش أيقونة فوق نص)', /\.icon-btn\.tb-out \{ display: inline-flex; flex-direction: row;/.test(css) && /white-space: nowrap/.test(css));
  check('CSS متوازن الأقواس', (css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length);
  check('موبايل: القايمة بتتفتح من تحت (sheet)', /\.user-pop \{ position: fixed; z-index: 1000; top: auto; bottom: 0;/.test(css));
}
// 7) شريط أخف + فوتر لآخر الصفحة (v24)
{
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
  check('زرار «طلب نقل جديد» في الشريط له class nav-cta', /href === '\/customer\/new' \? ' nav-cta'/.test(app) && /\.topbar \.nav a\.nav-cta \{/.test(css));
  check('الصفحة الحالية في الشريط عليها خط ذهبي', /\.topbar \.nav a\.on::after \{/.test(css));
  check('الفوتر بيلزق في آخر الصفحة (body flex + main flex:1)', /body \{ display: flex; flex-direction: column; \}/.test(css) && /main#view \{ flex: 1 0 auto;/.test(css));
  check('زرار رأس طلباتي بيختفي لما القايمة فاضية', /\.page-head:has\(~ #list \.empty\) > \.btn \{ display: none; \}/.test(css));
}
console.log('✅ hardening tests passed');
