// فحص دخان (E2E Smoke) للموقع الحي — من غير أي مكتبات خارجية.
// بيتأكد إن الصفحات العامة والملفات الأساسية و/API/health بترجّع 200 وبتحتوي علامات مهمة.
// الاستخدام: لازم السيرفر شغال (npm run dev) ثم: npm run e2e
//   BASE=http://localhost:8788 node test/e2e.smoke.mjs
const BASE = process.env.BASE || 'http://localhost:8788';
let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { pass++; console.log('✓', label); } else { fail++; console.error('✗', label); } };
const http = async (p, opts) => { const r = await fetch(BASE + p, opts); return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() }; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// نستنى السيرفر يجهز (أول تشغيل Wrangler ممكن ياخد ثواني)
let ready = false;
for (let i = 0; i < 30; i++) {
  try { const r = await fetch(BASE + '/api/health'); if (r.ok) { ready = true; break; } } catch { /* لسه */ }
  await wait(500);
}
check('السيرفر شغال', ready);

// الصفحة الرئيسية
const home = await http('/');
check('الرئيسية 200 + HTML', home.status === 200 && home.type.includes('text/html'));
check('الرئيسية فيها شريط التنقّل والسكربت', home.text.includes('id="topbar"') && home.text.includes('/js/app.js'));
check('الرئيسية فيها وصف/عنوان اشحنلي', home.text.includes('اشحنلي') || home.text.includes('Ashhanli'));

// الملفات الأساسية
for (const [p, marker] of [
  ['/js/app.js', 'renderAdminGated'],
  ['/js/config.js', 'firebaseConfig'],
  ['/js/i18n.js', 'account.password'],
  ['/js/pages/admin.js', 'admin/export'],
  ['/sw.js', 'addEventListener'],
  ['/manifest.webmanifest', 'name'],
  ['/robots.txt', 'Sitemap'],
  ['/sitemap.xml', '<urlset'],
  ['/llms.txt', '#'],
]) {
  const r = await http(p);
  check(`${p} 200 وبيه علامة`, r.status === 200 && r.text.includes(marker));
}

// فحص الربط: بيرجّع JSON فيه ok boolean
const h = await http('/api/health');
check('/api/health JSON فيه ok', h.status === 200 && h.type.includes('json'));
try { const j = JSON.parse(h.text); check('health فيه ok/projectId', 'ok' in j && 'projectId' in j); } catch { check('health فيه ok/projectId', false); }

console.log(`\n${fail === 0 ? '✅' : '❌'} E2E smoke: نجح ${pass} وفشل ${fail}`);
process.exit(fail === 0 ? 0 : 1);
