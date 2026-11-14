// كارت ترحيب العميل الجديد: نصوص عربي/إنجليزي، من غير أرقام أو ادعاءات، وبيظهر للي معندوش طلبات بس.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.document = { documentElement: {} };
const { t, setLang, DICT } = await import('../public/js/i18n.js');
const { welcomeCard } = await import('../public/js/pages/welcome.js');
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓', name); };
const KEYS = ['title', 'lead', 's1.t', 's1.d', 's2.t', 's2.d', 's3.t', 's3.d', 'cta', 't1.t', 't1.d', 't2.t', 't2.d', 't3.t', 't3.d'].map((k) => 'welcome.' + k);

ok('كل مفاتيح الترحيب موجودة بالعربي والإنجليزي ومختلفة عن بعض', () => {
  for (const k of KEYS) { assert.ok(DICT.ar[k] && DICT.en[k], `ناقص: ${k}`); assert.notEqual(DICT.ar[k], DICT.en[k], k); }
});
ok('مفيش أرقام في نصوص الترحيب (ممنوع أي رقم مش حقيقي)', () => {
  for (const k of KEYS) for (const l of ['ar', 'en']) assert.ok(!/[0-9٠-٩]/.test(DICT[l][k]), `${k} (${l}): ${DICT[l][k]}`);
});
ok('مفيش ادعاء عدد سواقين أو تقييمات أو شهادات', () => {
  for (const k of KEYS) for (const l of ['ar', 'en']) assert.ok(!/(مئات|آلاف|ألف|عملاؤنا|شهادات|تقييمات|thousand|hundreds|testimonial|customer reviews|\bratings?\b|top-rated)/i.test(DICT[l][k]), `${k} (${l})`);
});
ok('الكارت: ٣ خطوات + ٣ نقاط ثقة + زرار «اطلب نقل» لـ #/customer/new (عربي)', () => {
  setLang('ar'); const s = welcomeCard().s;
  assert.equal((s.match(/<li>/g) || []).length, 6);
  assert.ok(s.includes('href="#/customer/new"') && s.includes('>اطلب نقل<'));
  for (const k of ['s1.t', 's2.t', 's3.t', 't1.t', 't2.t', 't3.t']) assert.ok(s.includes(DICT.ar['welcome.' + k]), k);
});
ok('الكارت بالإنجليزي', () => {
  setLang('en'); const s = welcomeCard().s;
  assert.ok(s.includes('>Request a shipment<') && s.includes('Price shown before confirming') && s.includes('Shipment tracking') && s.includes('Driver documents are reviewed'));
  setLang('ar');
});
ok('العميل الجديد بيشوف الكارت، واللي عنده طلبات بيشوف القايمة بس', () => {
  const src = read('public/js/pages/customer.js');
  assert.match(src, /orders\.length \? html`\$\{orders\.map\(\(o\) => waybill\(o\)\)\}` : welcomeCard\(\)/);
  assert.ok(src.includes("import { welcomeCard } from './welcome.js'"));
  assert.ok(!src.includes('class="empty"><p>${t(\'customer.empty\')}'), 'الرسالة الفاضية القديمة اتشالت');
});
ok('CSS: القاعدة القديمة لسه موجودة + إخفاء زرار الرأس مع الكارت + موبايل + أقواس متوازنة', () => {
  const css = read('public/css/app.css');
  assert.ok(css.includes('.page-head:has(~ #list .empty) > .btn { display: none; }'));
  assert.ok(css.includes('.page-head:has(~ #list .welcome) > .btn { display: none; }'));
  assert.ok(/@media \(max-width: 760px\) \{ \.welcome-steps/.test(css));
  assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length);
});
ok('الألوان من متغيرات الموقع (بتتبدّل في الغامق) من غير ألوان ثابتة في بلوك الترحيب', () => {
  const blk = read('public/css/app.css').split('كارت ترحيب العميل الجديد')[1];
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(blk), 'لون ثابت في بلوك الترحيب');
});
console.log(`✅ welcome tests passed (${n})`);
