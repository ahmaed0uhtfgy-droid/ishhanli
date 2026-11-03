// اختبارات الصفحة الرئيسية: الحقائق من الإعدادات، منع الكلام الغلط، الأمان (XSS)، السيو، الترجمة.
import assert from 'node:assert/strict';
import { DEFAULTS } from '../functions/_lib/logic.js';
import { buildLanding, injectShell } from '../functions/_lib/landing.js';
import { renderPage } from '../functions/_lib/pages.js';
import { LP_ROWS, LP_FIELDS, LP_SECTIONS, cleanSite, lpFacts, lpSlots, lpText } from '../public/js/landing-content.js';

let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓', name); };
const S = (o = {}) => ({ ...DEFAULTS, ...o });
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const jsonld = (h) => [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const L = (s, site, company, env) => buildLanding({ settings: s, site, company: company || s.company, env });

ok('الافتراضي (حجز عبر المنصة): كلام الحجز موجود وحجز العربية مش ظاهر', () => {
  const r = L(S()), t = strip(r.body);
  assert.match(t, /محجوزة/); assert.match(t, /InstaPay/); assert.ok(!t.includes('حجز عربية'), 'حجز عربية مقفول افتراضياً');
  assert.ok(!t.includes('بنبدأ بمنطقة'), 'جملة المنطقة الواحدة اتشالت');
  assert.match(t, new RegExp(`${DEFAULTS.commissionPct}%`)); assert.match(t, new RegExp(`${DEFAULTS.minPrice} جنيه`));
});
ok('الدفع المباشر: مفيش أي كلام عن حجز المبلغ أو InstaPay أو السحب', () => {
  const r = L(S({ dcEnabled: true, dcPct: 7 })), t = strip(r.body) + JSON.stringify(jsonld(r.head));
  for (const bad of ['محجوز', 'محجوزة', 'InstaPay', 'Escrow', 'escrow', 'نزاع', 'فودافون كاش']) assert.ok(!t.includes(bad), 'ظهرت: ' + bad);
  assert.match(t, /بتدفع للسواق مباشرة/); assert.match(t, /7%/);
});
ok('التحرير التلقائي بيظهر بعدد الساعات الحقيقي بس لو مفعّل', () => {
  assert.ok(!strip(L(S()).body).includes('تلقائياً بعد'));
  assert.match(strip(L(S({ autoReleaseHours: 36 })).body), /36 ساعة/);
});
ok('نطاق GPS: الرقم من الإعدادات، ولو صفر بيتشال الادعاء', () => {
  assert.match(strip(L(S({ geofenceMeters: 250 })).body), /250 متر/);
  const t = strip(L(S({ geofenceMeters: 0 })).body); assert.ok(!/متر نطاق/.test(t) && !/حدود \d+ متر/.test(t));
});
ok('العروض: جملة الاقتراح بتظهر بس لو العروض مفعّلة', () => {
  assert.match(strip(L(S({ offersEnabled: true })).body), /يقترح عليك سعر/); assert.ok(!strip(L(S({ offersEnabled: false })).body).includes('يقترح عليك سعر'));
});
ok('حجز عربية بيظهر لما الأدمن يفعّله', () => { assert.match(strip(L(S({ passengersEnabled: true })).body), /حجز عربية/); });
ok('معادلة السعر بتتبدّل لو التسعير بالعربية مفعّل', () => {
  assert.match(strip(L(S()).body), /معامل الحجم/);
  const vp = { pickup: { base: 50, perKm: 8, minPrice: 100, kmFee: 0 } };
  const t = strip(L(S({ vehiclePricing: vp })).body); assert.match(t, /سعر الفتح/); assert.ok(!t.includes('معامل الحجم'));
});
ok('عمولة السواق الجديد بتظهر بأرقام الإعدادات', () => {
  const t = strip(L(S({ commissionPct: 12, newDriver: { orders: 10, commissionPct: 5 } })).body); assert.match(t, /أول 10 رحلات/); assert.match(t, /5%/);
});
ok('الأمان: النص المعدّل والبيانات بتتهرّب والروابط الغريبة بتتشال', () => {
  const site = { texts: { 'hero.h1': '<img src=x onerror=alert(1)> *مهم*' } };
  const co = { ...DEFAULTS.company, about: '<script>alert(1)</script>', phone: '+20 100 <b>1</b>', facebook: 'javascript:alert(1)', instagram: 'https://instagram.com/x' };
  const r = L(S(), site, co), b = r.body;
  assert.ok(!/<img src=x/.test(b) && !b.includes('<script>alert')); assert.match(b, /&lt;img src=x/); assert.match(b, /<em>مهم<\/em>/);
  assert.ok(!b.includes('javascript:')); assert.match(b, /instagram\.com\/x/);
});
ok('cleanSite: قيم غلط بتتصلّح ومفاتيح مجهولة بتتشال', () => {
  const c = cleanSite({ design: 'zzz', mode: 'x', hide: ['faq', 'nope'], logoUrl: 'http://a.com/x.png', seo: { title: 'ت'.repeat(500) }, texts: { 'hero.h1': ' مرحبا ', bogus: 'x', 'faq.1a': 'ا'.repeat(2000) } });
  assert.equal(c.design, 'a'); assert.equal(c.mode, 'auto'); assert.deepEqual(c.hide, ['faq']); assert.equal(c.logoUrl, ''); assert.equal(c.seo.title.length, 70);
  assert.equal(c.texts['hero.h1'], 'مرحبا'); assert.ok(!('bogus' in c.texts)); assert.equal(c.texts['faq.1a'].length, 600);
  assert.equal(cleanSite({ logoUrl: 'https://ok.com/l.png' }).logoUrl, 'https://ok.com/l.png');
});
ok('التصميم الثاني + إخفاء الأقسام + الوضع الافتراضي', () => {
  const r = L(S(), { design: 'b', hide: ['faq', 'trust'] });
  assert.equal(r.design, 'b'); assert.equal(r.mode, 'dark'); assert.match(r.body, /lpb-hero/); assert.ok(!r.body.includes('id="faq"') && !r.body.includes('id="trust"'));
  assert.equal(L(S(), { design: 'a' }).mode, 'light'); assert.equal(L(S(), { design: 'a', mode: 'dark' }).mode, 'dark');
});
ok('السيو: JSON-LD سليم، FAQ مطابق للمعروض، canonical، OG', () => {
  const r = L(S()), ld = jsonld(r.head); assert.ok(ld.length >= 3);
  const faq = ld.find((x) => x['@type'] === 'FAQPage'); assert.equal(faq.mainEntity.length, 4);
  const t = strip(r.body); for (const q of faq.mainEntity) { assert.ok(t.includes(q.name)); assert.ok(t.includes(q.acceptedAnswer.text.slice(0, 25))); }
  assert.match(r.head, /rel="canonical" href="https:\/\/ishhanli\.pages\.dev\/"/); assert.match(r.head, /og:image/); assert.ok(r.title.length <= 70);
  assert.equal(ld.find((x) => x['@type'] === 'Service').offers.priceSpecification.minPrice, DEFAULTS.minPrice);
});
ok('injectShell بيحط الصفحة والعنوان ومفيش عنوانين', () => {
  const shell = '<!doctype html><html lang="ar" dir="rtl"><head><title>x</title><!--LP_HEAD--></head><body><div id="landing"><!--LP_BODY--></div></body></html>';
  const out = injectShell(shell, L(S(), { design: 'b' })); assert.equal((out.match(/<title>/g) || []).length, 1); assert.ok(!out.includes('<!--LP_')); assert.match(out, /data-design="b" data-theme="dark"/);
});
ok('الترجمة: كل مفتاح في الخانات موجود بالعربي والإنجليزي', () => {
  const keys = new Set(LP_ROWS.map((r) => r[0])); assert.equal(keys.size, LP_ROWS.length, 'مفتاح مكرر');
  for (const [k, ar, en] of LP_ROWS) { assert.ok(ar && en, k); assert.equal((ar.match(/\{\w+\}/g) || []).sort().join(), (en.match(/\{\w+\}/g) || []).sort().join(), 'متغيرات مختلفة: ' + k); }
  const combos = [{}, { dcEnabled: true }, { autoReleaseHours: 12 }, { passengersEnabled: true }, { offersEnabled: false }, { geofenceMeters: 0 }, { dcEnabled: true, dcPct: 0, dcPerKm: 2 }, { newDriver: { orders: 5, commissionPct: 3 } }];
  for (const c of combos) for (const [id, sl] of Object.entries(lpSlots(lpFacts(S(c))))) { assert.ok(keys.has(sl.key), `${id} -> ${sl.key}`); assert.ok(lpText(sl.key, sl.vars, 'en') !== sl.key); assert.ok(!/\{\w+\}/.test(lpText(sl.key, sl.vars, 'ar')), 'متغير ناقص: ' + sl.key); }
  const ids = new Set(Object.keys(lpSlots(lpFacts(S({ passengersEnabled: true }))))); for (const f of LP_FIELDS) assert.ok(ids.has(f.id), 'حقل أدمن من غير خانة: ' + f.id);
  assert.deepEqual(LP_SECTIONS.length, 7);
});
ok('صفحات المحتوى: عنوان فريد، canonical، من غير ادعاءات في الدفع المباشر', () => {
  const titles = new Set();
  for (const k of ['how', 'pricing', 'vehicles', 'drivers', 'companies']) {
    const h = renderPage(k, { settings: S() }); const t = h.match(/<title>(.*?)<\/title>/)[1]; titles.add(t); assert.match(h, /rel="canonical"/); assert.ok(jsonld(h).length >= 1);
    const d = renderPage(k, { settings: S({ dcEnabled: true }) }), dt = strip(d); for (const bad of ['محجوز', 'InstaPay', 'نزاع']) assert.ok(!dt.includes(bad), `${k}: ${bad}`);
  }
  assert.equal(titles.size, 5);
});
ok('صفحة العربيات والتسعير: الأرقام من الإعدادات بالظبط', () => {
  const v = strip(renderPage('vehicles', { settings: S({ vehicleGuide: { pickup: { maxKg: 900, size: 'small' }, half_ton: { maxKg: 0, size: 'medium' }, truck: { maxKg: 9000, size: 'large' }, jumbo: { maxKg: 50000, size: 'xlarge' } } }) }));
  assert.match(v, /ربع نقل\s*: أقصى وزن 900 كجم/); assert.ok(!/نص نقل\s*: أقصى/.test(v), 'عربية متوقفة ماتظهرش'); assert.match(v, /نقل ثقيل\s*: أقصى وزن 9,000 كجم/);
  const p = strip(renderPage('pricing', { settings: S({ categories: { furniture: { ar: 'أثاث', mult: 1.7 } }, minPrice: 222 }) }));
  assert.match(p, /أثاث: 1\.7/); assert.match(p, /222 جنيه/);
});
ok('رموز توثيق جوجل وبينج: بتتنضّف وبتظهر في الصفحة', () => {
  const site = { seo: { google: 'abcDEF_123-xyz456', bing: 'bad token!' } }, h = L(S(), site).head;
  assert.match(h, /google-site-verification" content="abcDEF_123-xyz456"/); assert.ok(!h.includes('msvalidate'));
});
console.log(`✅ landing tests passed (${n})`);
