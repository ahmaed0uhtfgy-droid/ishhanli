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
// صفحات قانونية: كل مفاتيح الشروط والخصوصية موجودة في اللغتين
{
  const secs = { terms: ['use', 'account', 'pricing', 'cancel', 'duties', 'suspend', 'changes'], privacy: ['collect', 'use', 'share', 'store', 'retention', 'local', 'contact'] };
  for (const [doc, list] of Object.entries(secs)) for (const k of list) for (const suf of ['t', 'd']) assert.ok(DICT.ar[`legal.${doc}.${k}.${suf}`] && DICT.en[`legal.${doc}.${k}.${suf}`], `legal ${doc}.${k}.${suf}`);
  assert.ok(DICT.ar['legal.terms'] && DICT.en['legal.privacy'] && DICT.ar['footer.terms'] && DICT.en['footer.privacy']);
}
// كل مفتاح data-i18n في الصفحات الثابتة لازم يكون له ترجمة (يمنع نص ناقص في الصفحة الرئيسية)
{
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../public/', import.meta.url);
  const re = /data-i18n="([^"]+)"/g;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.html'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    let m; while ((m = re.exec(src))) assert.ok(DICT.ar[m[1]] && DICT.en[m[1]], `data-i18n بلا ترجمة: ${f} → ${m[1]}`);
  }
}
console.log('✅ client tests passed');

// ================== poll ==================
const listeners = new Set();
globalThis.document = { hidden: false, documentElement: {}, addEventListener: (t, f) => listeners.add(f), removeEventListener: (t, f) => listeners.delete(f) };
globalThis.POLL_SCALE = 1; // config.js بيضبطه على 3 للكوتا المجانية؛ الاختبار بيقيس السلوك بالفواصل الأصلية
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
{ // gate + sync: جلب البيانات بس لما العدّاد يتغيّر
  const { makeSync } = await import('../public/js/gate.js');
  let stamp = { orders: 1, users: 1 }, syncCalls = 0, fail = false;
  const sy = makeSync(async () => { syncCalls++; if (fail) throw new Error('net'); return { ...stamp }; });
  let fetches = 0; const got = [];
  const p = sy.gpoll(['orders'], async () => ++fetches, 15, (v) => got.push(v), { every: 1e9 }); // every كبير: نقيس التغيير بس
  await sleep(120);
  assert.equal(fetches, 1, 'ثابت: بيجيب البيانات مرة واحدة بس'); assert.ok(syncCalls >= 1, 'بيسأل sync');
  stamp = { orders: 2, users: 1 }; await sleep(2700); // sync مخزّن 2.5 ثانية (طلب مشترك)
  assert.equal(fetches, 2, 'العدّاد اتغيّر: بيجيب من جديد');
  stamp = { orders: 2, users: 99 }; await sleep(2700);
  assert.equal(fetches, 2, 'نوع تاني اتغيّر: ما يهمّناش');
  await p.now(); assert.equal(fetches, 3, 'now() بيجيب غصب عن العدّاد');
  fail = true; stamp = { orders: 2, users: 99 }; await sleep(2700);
  assert.ok(fetches >= 4, 'sync فشل: بيجيب البيانات عادي (مش بيقف)');
  p();
  // طلب مشترك: 3 محدّثات في نفس اللحظة = طلب sync واحد
  fail = false; syncCalls = 0; await sleep(2600);
  const ps = [1, 2, 3].map(() => sy.gpoll(['orders'], async () => 1, 1000, () => {})); await sleep(60); ps.forEach((x) => x());
  assert.equal(syncCalls, 1, 'محدّثات متعددة بتشارك طلب sync واحد');
  // أمان: كل 3 دورات لو gate(every=3) بيجيب حتى لو مفيش تغيير
  const g = sy.gate(['orders'], { every: 3 }); const seq = []; for (let i = 0; i < 7; i++) seq.push(await g());
  assert.deepEqual(seq, [true, false, false, true, false, false, true], 'تحديث أمان كل every دورة');
  // فشل الجلب: reset بيخلّي الدورة الجاية تجيب
  const g2 = sy.gate(['orders']); await g2(); assert.equal(await g2(), false); g2.reset(); assert.equal(await g2(), true, 'reset بعد فشل');
}
{ // تصدير CSV: BOM + اقتباس + حماية من حقن الصيغ
  const { toCsv } = await import('../public/js/csv.js');
  const csv = toCsv([{ h: 'name', v: (r) => r.n }, { h: 'amount', v: (r) => r.a }], [{ n: 'أحمد, "الكبير"', a: -5 }, { n: '=HYPERLINK("x")', a: 10 }, { n: '+cmd', a: 0 }, { n: 'عادي', a: null }]);
  const lines = csv.split('\r\n');
  assert.equal(csv.charCodeAt(0), 0xfeff, 'BOM عشان Excel يقرا العربي');
  assert.equal(lines[1], '"أحمد, ""الكبير""",-5', 'اقتباس الفاصلة والعلامات + الرقم السالب يفضل رقم');
  assert.equal(lines[2], `"'=HYPERLINK(""x"")",10`, 'حقن الصيغ متحصّن');
  assert.equal(lines[3], "'+cmd,0"); assert.equal(lines[4], 'عادي,');
}
console.log('✅ poll tests passed');

// فحص صور المستندات على الجهاز (دوال نقية)
const { analyzePixels, judge } = await import('../public/js/docCheck.js');
const mk = (w, h, f) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = f(x, y), p = (y * w + x) * 4; d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255; } return analyzePixels(d, w, h); };
assert.equal(judge(mk(120, 90, () => [20, 20, 20])), 'dark', 'صورة سودا');
assert.equal(judge(mk(120, 90, () => [250, 250, 250])), 'bright', 'صورة مبهورة');
assert.equal(judge(mk(120, 90, () => [130, 130, 130])), 'blank', 'لون واحد');
assert.equal(judge(mk(120, 90, (x) => [x * 2, x * 2, x * 2])), 'blank', 'تدرّج ناعم من غير تفاصيل');
assert.equal(judge(mk(120, 90, (x, y) => (Math.floor(y / 4) % 2 ? [240, 240, 240] : [40, 40, 40]))), null, 'سطور زي كتابة المستند: مقبولة');
assert.equal(judge(mk(120, 90, (x, y) => (Math.floor(y / 4) % 2 ? [235, 175, 140] : [140, 85, 60]))), 'selfie', 'لون بشرة طاغي');
console.log('✅ docCheck tests passed');

// ===== «فين فلوسي؟» (money.js) =====
{
  const { moneySteps } = await import('../public/js/money.js');
  assert.equal(moneySteps({ status: 'open', escrowStatus: '' }), null, 'قبل الدفع مفيش كارت فلوس');
  assert.equal(moneySteps({ status: 'cancelled', escrowStatus: '' }), null, 'ملغي من غير دفع');
  const pick = (o) => moneySteps(o).map((s) => `${s.key}:${s.state}`).join(',');
  assert.equal(pick({ status: 'payment_review' }), 'paid:now,held:wait,out:wait', 'الدفع تحت المراجعة');
  assert.equal(pick({ status: 'in_transit', escrowStatus: 'held' }), 'paid:done,held:now,out:wait', 'محجوز أثناء الرحلة');
  assert.equal(moneySteps({ status: 'completed', escrowStatus: 'released' })[2].text, 'money.out.released');
  assert.equal(moneySteps({ status: 'completed', escrowStatus: 'settled' })[2].text, 'money.out.released');
  assert.equal(pick({ status: 'cancelled', escrowStatus: 'refunded' }), 'paid:done,held:done,out:done', 'اترجّع');
  assert.equal(moneySteps({ status: 'cancelled', escrowStatus: 'refund_pending' })[2].text, 'money.out.refund_pending');
  assert.equal(moneySteps({ status: 'disputed', escrowStatus: 'held' })[2].text, 'money.out.disputed', 'النزاع بيوقف التحويل');
  // كل مفاتيح الترجمة اللي بتستخدمها الدالة موجودة بالعربي والإنجليزي
  const keys = new Set(['money.title', 'money.paid', 'money.held', 'money.out', 'net.offline', 'net.online', 'order.reorder', 'order.reorderHint', 'ui.fontUp', 'ui.fontDown']);
  for (const o of [{ status: 'payment_review' }, { status: 'paid', escrowStatus: 'held' }, { status: 'completed', escrowStatus: 'released' }, { status: 'cancelled', escrowStatus: 'refunded' }, { status: 'cancelled', escrowStatus: 'refund_pending' }, { status: 'disputed', escrowStatus: 'held' }])
    moneySteps(o).forEach((s) => keys.add(s.text));
  for (const k of keys) for (const l of ['ar', 'en']) assert.ok(DICT[l][k] && DICT[l][k] !== k, `ترجمة ناقصة: ${k} (${l})`);
  console.log('✅ money.js tests passed');
}

// ===== صفحة قواعد التعامل (rules.js) =====
{
  const { rulesSections } = await import('../public/js/rules.js');
  const ids = (S) => rulesSections(S).flatMap((g) => g.rules.map((r) => r.id));
  const all = ids({ newDriver: { orders: 10, commissionPct: 5 }, geofenceMeters: 300, prepaidGraceMin: 30, offersEnabled: true, autoReleaseHours: 48, deliveryCode: true, deliveryCodeAvailable: true });
  assert.ok(['a1','a7','c4','c8','d1','d1b','d3','d5','d9','k1'].every((x) => all.includes(x)));
  assert.ok(!ids({}).some((x) => ['a7', 'c8', 'd9'].includes(x)), 'قواعد الكود والتحرير التلقائي ما بتظهرش وهي مقفولة');
  const off = ids({ newDriver: { orders: 0 }, geofenceMeters: 0, prepaidGraceMin: 0, offersEnabled: false });
  assert.ok(!off.includes('d1b') && !off.includes('d3') && !off.includes('c7') && !off.includes('d5'), 'القواعد المعطّلة ما بتظهرش');
  assert.deepEqual(rulesSections({}).map((g) => g.id), ['all', 'customer', 'driver', 'company'], 'شغّالة حتى لو الإعدادات فاضية');
  const v = rulesSections({ commissionPct: 15, cancelPaidDriverPct: 12 })[1].rules.find((r) => r.id === 'c4').vars;
  assert.equal(v.dp, 12); assert.equal(rulesSections({ commissionPct: 15 })[2].rules[0].vars.commission, 15, 'الأرقام من الإعدادات');
  // كل مفاتيح الترجمة موجودة بالعربي والإنجليزي، وكل متغيّر {x} في النص له قيمة
  for (const g of rulesSections({ newDriver: { orders: 5, commissionPct: 3 }, geofenceMeters: 100, prepaidGraceMin: 10, offersEnabled: true, autoReleaseHours: 24, deliveryCode: true, deliveryCodeAvailable: true })) {
    for (const k of [`rules.group.${g.id}`]) for (const l of ['ar', 'en']) assert.ok(DICT[l][k], `ناقص ${k}`);
    for (const r of g.rules) for (const part of ['t', 'd']) for (const l of ['ar', 'en']) {
      const s = DICT[l][`rules.${r.id}.${part}`]; assert.ok(s, `ناقص rules.${r.id}.${part} (${l})`);
      for (const m of s.matchAll(/\{(\w+)\}/g)) assert.ok(r.vars[m[1]] !== undefined, `متغيّر ${m[1]} ناقص في ${r.id}`);
    }
  }
  for (const k of ['rules.title', 'rules.sub', 'rules.foot', 'footer.rules']) for (const l of ['ar', 'en']) assert.ok(DICT[l][k], k);
  console.log('✅ rules.js tests passed');
}

// ===== تقدير السعر للزوار (estimate.js): لازم يطابق معادلة السيرفر =====
{
  const { priceFromKm, estimate, CITIES } = await import('../public/js/estimate.js');
  const { calcPrice, DEFAULT_SETTINGS } = await import('../functions/_lib/logic.js');
  const S = DEFAULT_SETTINGS ?? (await import('../functions/_lib/logic.js')).DEFAULTS;
  assert.ok(S?.categories && S?.sizes, 'إعدادات افتراضية متاحة للاختبار');
  let n = 0;
  for (const km of [1, 7, 33, 120, 220, 480]) for (const c of Object.keys(S.categories)) for (const z of Object.keys(S.sizes)) {
    assert.equal(priceFromKm(S, km, c, z), calcPrice(S, km, c, z).price, `تطابق السعر ${km}/${c}/${z}`); n++;
  }
  const e = estimate(S, 'cairo', 'alex', Object.keys(S.categories)[0], Object.keys(S.sizes)[0]);
  assert.ok(e && e.km > 150 && e.km < 400 && e.price >= S.minPrice, 'القاهرة→إسكندرية منطقية');
  assert.equal(estimate(S, 'cairo', 'cairo', 'goods', 'small'), null);
  assert.equal(priceFromKm(S, 10, 'nope', 'small'), null);
  assert.ok(Object.values(CITIES).every((c) => c[2] > 22 && c[2] < 32 && c[3] > 24 && c[3] < 35), 'إحداثيات داخل مصر');
  for (const k of ['est.title', 'est.sub', 'est.note', 'est.about', 'est.pick']) for (const l of ['ar', 'en']) assert.ok(DICT[l][k], k);
  console.log(`✅ estimate.js tests passed (${n} مطابقة مع calcPrice)`);
}

// ===== مفاتيح الترجمة لتفاصيل الشحنة/عدم المطابقة/كود البداية/العدّاد/الأدلة =====
{
  const keys = ['manifest.title','manifest.desc','manifest.descHint','manifest.items','manifest.value','manifest.bindingHint','manifest.needDesc','manifest.agree','manifest.mismatchHint','manifest.reviewAgree',
    'err.must_agree','err.driver_busy','err.fleet_driver_busy','err.bad_start_code','err.mismatch_limit','err.wallet_frozen','err.bad_delivery_code','mismatch.btn','mismatch.ask','mismatch.done',
    'code.start.title','code.start.hint','code.delivery.title','code.delivery.hint','code.startAsk','code.startNoCode','trip.title','trip.startedWithCode','trip.startedNoCode','trip.deadline','trip.left','trip.over','trip.late',
    'dispute.reason.missing','tx.mismatch_compensation','refund.reason.goods_mismatch','order.cancelReason.goods_mismatch','admin.s.guardTitle','admin.s.mismatchComp','admin.s.mismatchMax','admin.s.maxActive','admin.s.avgSpeed','admin.s.deliveryBuffer','admin.s.stallMin','admin.s.startCode',
    'evidence.btn','evidence.title','evidence.customer','evidence.driver','evidence.agreedAt','evidence.codes','evidence.noCode','evidence.timeline','evidence.gps','evidence.points','evidence.lastPoint','evidence.disputes','evidence.done'];
  for (const k of keys) for (const l of ['ar', 'en']) assert.ok(DICT[l][k] && DICT[l][k] !== k, `ترجمة ناقصة: ${k} (${l})`);
  console.log('✅ مفاتيح الواجهة الجديدة موجودة');
}

// ===== لوحة السواق: كل مفاتيح الترجمة المستخدمة (ثابتة وديناميكية) موجودة بالعربي والإنجليزي =====
{
  const { readFileSync } = await import('node:fs');
  const src = ['public/js/pages/driver-dash.js', 'public/js/pages/driver.js'].map((f) => readFileSync(f, 'utf8')).join('\n') + readFileSync('public/js/pages/order.js', 'utf8');
  const used = new Set([...src.matchAll(/\bt\('([a-zA-Z0-9_.\-]+)'/g)].map((m) => m[1]).filter((k) => /^(dash|trust|rate|nav|trip|common)\./.test(k) && !k.endsWith('.')));  // المفاتيح اللي بتنتهي بنقطة بتتركّب ديناميكياً وبنفحصها تحت
  for (const k of ['dash.q.onTime', 'dash.q.intact', 'dash.q.polite', 'rate.q.onTime', 'rate.q.intact', 'rate.q.polite', 'dash.last24', 'dash.last7', 'dash.last30', 'nav.dash']) used.add(k);
  let n = 0; for (const k of used) for (const l of ['ar', 'en']) { assert.ok(DICT[l][k] && DICT[l][k] !== k, `ترجمة ناقصة: ${k} (${l})`); n++; }
  assert.ok(/\{cur\}/.test(DICT.ar['trust.of']) && /\{target\}/.test(DICT.ar['trust.of']), 'trust.of بيدعم المتغيّرات (يحل مشكلة الأرقام المقلوبة)');
  assert.ok(!/\$\{cur\} \/ \$\{target\}/.test(readFileSync('public/js/pages/driver.js', 'utf8')), 'كارت الثقة ما بقاش بيعرض «رقم / رقم» الملخبط');
  console.log(`✅ لوحة السواق: ${n} فحص ترجمة`);
}
