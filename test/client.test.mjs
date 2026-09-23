// اختبار الأجزاء النقية من الواجهة (تنسيق، ترجمة، حماية XSS) — من غير متصفح
import assert from 'node:assert/strict';
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.document = { documentElement: {} };
const { html, esc, raw, fmtMoney, errMsg, orderNo, trustBadge, stamp } = await import('../public/js/ui.js');
const { t, setLang, DICT } = await import('../public/js/i18n.js');

// XSS: أي بيانات مستخدم لازم تتعمل لها escape تلقائياً
const evil = '<img src=x onerror=alert(1)>"\'&';
const out = html`<p title="${evil}">${evil}</p>`.s;
assert.ok(!out.includes('<img'), out); assert.ok(out.includes('&lt;img'), out);
assert.equal(html`<b>${[evil, evil]}</b>`.s.includes('<img'), false);
assert.equal(html`<i>${html`<u>${evil}</u>`}</i>`.s.includes('<img'), false, 'قوالب متداخلة');
assert.equal(html`${raw('<b>ok</b>')}`.s, '<b>ok</b>');
assert.equal(esc(null), '');

// أرقام وأكواد
setLang('ar'); assert.match(fmtMoney(1234), /1,?234/); assert.ok(/[0-9]/.test(fmtMoney(5)), 'أرقام لاتينية');
assert.equal(orderNo('abcdef1234567890'), '#ABCDEF');

// ترجمة الأخطاء
assert.equal(errMsg({ code: 'too_far' }), DICT.ar['err.too_far']);
assert.equal(errMsg({ code: 'auth/invalid-credential' }), DICT.ar['err.auth_invalid_credential']);
assert.equal(errMsg({ code: 'something-unknown' }), DICT.ar['err.generic']);
setLang('en'); assert.equal(t('common.back'), 'Back'); assert.equal(errMsg({ code: 'insufficient_balance' }), 'Insufficient balance.');
assert.equal(t('no.such.key'), 'no.such.key');

// شارة الثقة
setLang('ar');
{ const b = trustBadge({ level: 'pro', badges: ['verified', 'top_rated'] }).s;
  assert.ok(b.includes('lvl-pro') && b.includes('محترف') && b.includes('هوية موثّقة') && b.includes('الأعلى تقييماً'), b);
  assert.equal(trustBadge(null), ''); setLang('en'); assert.ok(trustBadge({ level: 'elite', badges: [] }).s.includes('Elite')); setLang('ar');
  assert.ok(!trustBadge({ level: '"><img src=x>', badges: [] }).s.includes('<img'), 'XSS'); }
// حالات رحلات الركاب لها صياغة مختلفة، والباقي بيرجع للنص العادي
setLang('ar');
assert.ok(stamp('picked_up', 'passengers').s.includes('الركاب ركبوا') && stamp('picked_up', 'cargo').s.includes('تم الاستلام') && stamp('open', 'passengers').s.includes('مفتوح'));
setLang('en'); assert.ok(stamp('delivered', 'passengers').s.includes('Arrived') && stamp('delivered').s.includes('Delivered')); setLang('ar');
// الدفع المقدم: حالة بانتظار الدفع + شارة الاسترجاع
setLang('ar'); assert.ok(stamp('awaiting_payment').s.includes('بانتظار دفعك')); setLang('en'); assert.ok(stamp('awaiting_payment').s.includes('Awaiting your payment')); setLang('ar');
{ // رسالة شات فيها HTML لازم تتعمل لها escape في العرض
  const evil = '<img src=x onerror=alert(1)>';
  const out = html`<div class="msg"><p>${evil}</p></div>`.s; assert.ok(!out.includes('<img') && out.includes('&lt;img')); }
// تطابق اللغتين
for (const k of Object.keys(DICT.ar)) assert.ok(DICT.en[k], 'missing en: ' + k);
console.log('✅ client tests passed');

// ================== poll ==================
const listeners = new Set();
globalThis.document = { hidden: false, documentElement: {}, addEventListener: (t, f) => listeners.add(f), removeEventListener: (t, f) => listeners.delete(f) };
const { poll } = await import('../public/js/poll.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

{ // dedupe + تغيّر البيانات + now()
  let n = 0, data = { v: 1 }; const got = [];
  const p = poll(async () => { n++; return { ...data }; }, 20, (d) => got.push(d.v), { dedupe: true });
  await sleep(90); assert.deepEqual(got, [1], 'نفس البيانات: cb مرة واحدة'); assert.ok(n >= 3, 'بيتكرر');
  data = { v: 2 }; await sleep(50); assert.deepEqual(got, [1, 2], 'التغيير بيوصل');
  await p.now(); assert.deepEqual(got, [1, 2, 2], 'now() بيفرض cb');
  p(); const n0 = n; await sleep(80); assert.equal(n, n0, 'stop بيوقف الاستعلام'); assert.equal(listeners.size, 0, 'listener اتشال');
}
{ // onError مرة واحدة لكل كود + false بيوقف
  const errs = []; let n = 0;
  const p = poll(async () => { n++; throw Object.assign(new Error('x'), { code: n < 6 ? 'network' : 'boom' }); }, 10, () => {}, { onError: (e) => { errs.push(e.code); return e.code === 'boom' ? false : undefined; } });
  await sleep(150); assert.deepEqual(errs, ['network', 'boom'], 'الخطأ المتكرر بيتبلّغ مرة'); const n1 = n; await sleep(50); assert.equal(n, n1, 'return false بيوقف'); p();
}
{ // التاب المخفي بيوقف الطلبات ويكمل عند الرجوع
  let n = 0; document.hidden = true;
  const p = poll(async () => { n++; return n; }, 10, () => {}); await sleep(60); assert.equal(n, 0, 'مفيش طلبات والتاب مخفي');
  document.hidden = false; listeners.forEach((f) => f()); await sleep(40); assert.ok(n >= 1, 'رجع يشتغل'); p();
}
{ // فاصل ديناميكي
  let n = 0, ms = 200; const p = poll(async () => ++n, () => ms, () => {}); await sleep(30); assert.equal(n, 1); ms = 10; await p.now(); await sleep(60); assert.ok(n >= 3, 'الفاصل الجديد اتطبق'); p();
}
console.log('✅ poll tests passed');
