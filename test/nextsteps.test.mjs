// رسالة بعد إنشاء الطلب + كارت «الخطوات الجاية» للطلب المفتوح + مفتاح منع التكرار في الواجهة. تشغيل: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.document = { documentElement: {} };
const { setLang, DICT } = await import('../public/js/i18n.js');
const { showNextSteps, nextStepsCard } = await import('../public/js/pages/nextsteps.js');
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓', name); };
const NEW = ['new.sent', 'order.next.title', 'order.next.s1', 'order.next.s2', 'order.next.s3', 'order.next.push', 'order.next.pushDenied'];

ok('المفاتيح الجديدة بالعربي والإنجليزي ومختلفة', () => { for (const k of NEW) { assert.ok(DICT.ar[k] && DICT.en[k], k); assert.notEqual(DICT.ar[k], DICT.en[k], k); } });
ok('رسالة new.sent بالنص المطلوب حرفياً (عربي وإنجليزي)', () => {
  assert.equal(DICT.ar['new.sent'], 'تم إرسال طلبك لأقرب سائق أو شركة متاحة، وهنبلّغك أول ما حد يقبله.');
  assert.equal(DICT.en['new.sent'], "Your request was sent to the nearest available driver or company. We'll notify you as soon as one accepts.");
});
ok('new.created لسه موجود ومتغيّرش', () => { assert.equal(DICT.ar['new.created'], 'تم إنشاء الطلب'); assert.ok(DICT.en['new.created']); });
ok('مفيش أرقام ولا ادعاء عدد سواقين في النصوص الجديدة', () => { for (const k of NEW) for (const l of ['ar', 'en']) assert.ok(!/[0-9٠-٩]/.test(DICT[l][k]), `${k} ${l}`); });
ok('الكارت بيظهر لعميل + طلب open بس', () => {
  assert.equal(showNextSteps({ status: 'open' }, 'customer'), true);
  for (const st of ['accepted', 'paid', 'awaiting_payment', 'completed', 'cancelled']) assert.equal(showNextSteps({ status: st }, 'customer'), false, st);
  assert.equal(showNextSteps({ status: 'open' }, 'driver'), false); assert.equal(showNextSteps({ status: 'open' }, 'admin'), false); assert.equal(showNextSteps(null, 'customer'), false);
});
ok('الكارت: 3 خطوات + عنوان (عربي)', () => { setLang('ar'); const s = nextStepsCard('granted').s; assert.equal((s.match(/<li>/g) || []).length, 3); for (const k of ['s1', 's2', 's3']) assert.ok(s.includes(DICT.ar['order.next.' + k])); });
ok('الكارت بالإنجليزي', () => { setLang('en'); const s = nextStepsCard('granted').s; assert.ok(s.includes('What happens next') && s.includes('A driver or company accepts your request')); setLang('ar'); });
ok('تنبيه الإشعارات + زرار التفعيل لما الحالة default بس', () => {
  const s = nextStepsCard('default').s; assert.ok(s.includes(DICT.ar['order.next.push']) && s.includes('data-act="enablePush"'));
});
ok('مفيش تنبيه لو مفعّلة أو مش مدعومة أو الإدارة ما فعّلتهاش', () => {
  for (const st of ['granted', 'unsupported', 'not_configured']) { const s = nextStepsCard(st).s; assert.ok(!s.includes('enablePush') && !s.includes(DICT.ar['order.next.push']) && !s.includes(DICT.ar['order.next.pushDenied']), st); }
});
ok('لو محظورة: تلميح من غير زرار', () => { const s = nextStepsCard('denied').s; assert.ok(s.includes(DICT.ar['order.next.pushDenied']) && !s.includes('data-act="enablePush"')); });
ok('من غير منطق إشعارات جديد: nextsteps.js مابيستوردش push.js، وorder.js بيستخدم pushSupport/enablePush الموجودين', () => {
  assert.ok(!/push\.js|Notification|serviceWorker|getToken/.test(read('public/js/pages/nextsteps.js')));
  const o = read('public/js/pages/order.js');
  assert.ok(o.includes("import { pushSupport, enablePush } from '../push.js'") && o.includes('nextStepsCard(pushSupport())') && /async enablePush\(\) \{[^}]*enablePush\(\{ ask: true \}\)/.test(o));
});
ok('customer.js: new.sent بدل new.created + مفتاح منع التكرار في الطلب', () => {
  const c = read('public/js/pages/customer.js');
  assert.ok(c.includes("toast(t('new.sent'))") && !c.includes("toast(t('new.created'))"));
  assert.ok(c.includes("const idemKey = crypto.randomUUID()") && c.includes("key: idemKey, pickup: pts.pickup"));
});
ok('driver.js: الحضور بيبعت توقيت الجهاز', () => assert.ok(read('public/js/pages/driver.js').includes("api('driver/presence', { online: on, ts: Date.now()")));
ok('CSS: كلاسات الكارت موجودة وأقواس متوازنة', () => {
  const css = read('public/css/app.css'); assert.ok(css.includes('.nextsteps-push') && css.includes('.nextsteps .welcome-steps'));
  assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length);
});
console.log(`✅ nextsteps tests passed (${n})`);
