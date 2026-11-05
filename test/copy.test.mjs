// مراجعة الكلام: الجمل العامة ماتقولش حاجة غلط عن الدفع، ونسخ الدفع المباشر ماتذكرش الحجز أو النزاعات.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DICT } from '../public/js/i18n.js';
import '../public/js/i18n-admin.js'; import '../public/js/i18n-info.js';
import { moneySteps } from '../public/js/money.js';

let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓', name); };
const ESC = /محجوز|محجوزة|Escrow|escrow|\bheld\b|نزاع|dispute|InstaPay/i;

ok('نسخ الدفع المباشر موجودة بالعربي والإنجليزي وبدون كلام الحجز أو النزاع', () => {
  for (const k of ['legal.terms.use.d.direct', 'legal.terms.pricing.d.direct', 'legal.terms.cancel.d.direct', 'new.paxNote.direct', 'order.driverWithdrawAsk.direct']) {
    for (const l of ['ar', 'en']) {
      const s = DICT[l][k]; assert.ok(s && s !== k, `${k} (${l}) ناقص`);
      // «إبلاغ» مسموح؛ الممنوع ذكر مبلغ محجوز أو نزاع مفتوح
      assert.ok(!ESC.test(s.replace(/فمفيش مبلغ محجوز لفتح نزاع عليه|no held amount to open a dispute on/g, '')), `${k} (${l}): ${s}`);
    }
  }
});
ok('الجمل العامة (للزوار وكل الأوضاع) من غير ادعاء حجز المبلغ', () => {
  for (const k of ['order.shareText', 'legal.privacy.use.d', 'meta.title']) for (const l of ['ar', 'en']) assert.ok(!/محجوز|escrow|held/i.test(DICT[l][k]), `${k} (${l})`);
});
ok('ملفات عامة ثابتة من غير ادعاء حجز المبلغ', () => {
  for (const f of ['public/manifest.webmanifest', 'functions/_lib/publicProfile.js', 'public/index.html']) assert.ok(!/فلوس محجوزة|فلوسك محجوزة|payment held/.test(readFileSync(new URL('../' + f, import.meta.url), 'utf8')), f);
});
ok('إشعار انسحاب السواق في الدفع المباشر من غير «محجوز»', () => {
  const s = readFileSync(new URL('../functions/_lib/push.js', import.meta.url), 'utf8'), m = s.match(/driver_cancelled_direct: \{([^\n]*)\}/);
  assert.ok(m && !/محجوز|held/i.test(m[1]));
});
ok('نصوص الشروط: كل نسخة مباشرة ليها أصل', () => { for (const k of ['use', 'pricing', 'cancel']) assert.ok(DICT.ar[`legal.terms.${k}.d`] && DICT.ar[`legal.terms.${k}.d.direct`]); });
ok('كارت «فلوسك محجوزة» مايظهرش لطلبات الدفع المباشر', () => {
  assert.equal(moneySteps({ direct: true, status: 'paid', escrowStatus: '' }), null);
  assert.ok(Array.isArray(moneySteps({ status: 'paid', escrowStatus: 'held' })), 'الطلب العادي لسه بيظهر');
});
console.log(`✅ copy tests passed (${n})`);
