// وحدات الواجهة (public/js) اللي فيها منطق صافي: ui.js / i18n.js / map.js / landing-content.js
// بنركّب بدائل بسيطة للـDOM قبل الاستيراد لأن الملفات دي بتلمس localStorage/document وقت التحميل.
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.stubGlobal('localStorage', { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } });
vi.stubGlobal('document', { documentElement: { lang: 'ar', dir: 'rtl' }, addEventListener() {}, querySelector: () => null, body: {} });
vi.stubGlobal('location', { hash: '' });

const ui = await import('../../public/js/ui.js');
const i18n = await import('../../public/js/i18n.js');
const map = await import('../../public/js/map.js');
const lc = await import('../../public/js/landing-content.js');
const { DICT, t, setLang } = i18n;

describe('ui.js: esc / html / raw', () => {
  it('esc بيهرّب الخمس رموز', () => { expect(ui.esc(`<a href="x" onclick='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;'); });
  it('esc: null/undefined/أرقام/false', () => { expect(ui.esc(null)).toBe(''); expect(ui.esc(undefined)).toBe(''); expect(ui.esc(0)).toBe('0'); expect(ui.esc(false)).toBe('false'); });
  it('html: القيم المتغيّرة بتتهرّب والنص الثابت لا', () => { const r = ui.html`<b>${'<img onerror=1>'}</b>`; expect(r.s).toBe('<b>&lt;img onerror=1&gt;</b>'); });
  it('html: raw ومقاطع html المتداخلة ما بتتهرّبش مرتين', () => { const inner = ui.html`<i>${'a&b'}</i>`; expect(ui.html`<p>${inner}</p>`.s).toBe('<p><i>a&amp;b</i></p>'); expect(ui.html`${ui.raw('<hr>')}`.s).toBe('<hr>'); });
  it('html: المصفوفات بتتدمج وكل عنصر بيتهرّب', () => { expect(ui.html`<ul>${['<x>', ui.html`<li>1</li>`]}</ul>`.s).toBe('<ul>&lt;x&gt;<li>1</li></ul>'); });
  it('html: حقن خاصية (attribute) بيتعطّل', () => { const v = '" onmouseover="alert(1)'; expect(ui.html`<a title="${v}">x</a>`.s).toBe('<a title="&quot; onmouseover=&quot;alert(1)">x</a>'); });
  it('html: null/undefined بتتحوّل لنص فاضي (مش "null")', () => { expect(ui.html`<p>${null}${undefined}</p>`.s).toBe('<p></p>'); });
});

describe('ui.js: التنسيق', () => {
  beforeAll(() => setLang('en'));
  const digits = (s) => s.replace(/[^\d]/g, '');
  it('fmtMoney: تقريب بلا كسور، سالب، NaN/نص = صفر', () => {
    expect(digits(ui.fmtMoney(1234.4))).toBe('1234'); expect(digits(ui.fmtMoney(0.4))).toBe('0'); expect(ui.fmtMoney(NaN)).toBe(ui.fmtMoney(0)); expect(ui.fmtMoney('abc')).toBe(ui.fmtMoney(0)); expect(ui.fmtMoney(null)).toBe(ui.fmtMoney(0));
    expect(ui.fmtMoney(-50)).toMatch(/-|−/); expect(ui.fmtMoney(1234)).toMatch(/EGP/);
  });
  it('fmtNum: عدد الكسور المطلوب', () => { expect(ui.fmtNum(1.2345, 2)).toBe('1.23'); expect(ui.fmtNum(2, 1)).toBe('2'); expect(ui.fmtNum(undefined)).toBe('0'); });
  it('fmtDate/fmtDay: قيم فاسدة = "—"، وبتقبل Date وtimestamp ومستند Firestore', () => {
    for (const bad of [null, undefined, '', 'not a date', NaN]) { expect(ui.fmtDate(bad)).toBe('—'); expect(ui.fmtDay(bad)).toBe('—'); }
    const ts = Date.UTC(2026, 0, 15, 10, 30); expect(ui.fmtDate(ts)).toMatch(/2026/); expect(ui.fmtDate(new Date(ts))).toMatch(/2026/); expect(ui.fmtDay({ toDate: () => new Date(ts) })).toMatch(/2026/);
    expect(ui.fmtDay(ts)).not.toMatch(/:/); // من غير ساعة
  });
  it('orderNo', () => { expect(ui.orderNo('abcdef123456')).toBe('#ABCDEF'); expect(ui.orderNo('ab')).toBe('#AB'); expect(ui.orderNo(123456789)).toBe('#123456'); });
  it('ratingText', () => { expect(ui.ratingText({ ratingCount: 10, ratingSum: 45 })).toBe('★ 4.5 (10)'); expect(ui.ratingText({ ratingCount: 0 })).toBe(t('common.noRating')); expect(ui.ratingText(null)).toBe(t('common.noRating')); expect(ui.ratingText({})).toBe(t('common.noRating')); });
  it('label: لغة حالية ← عربي ← المفتاح', () => { setLang('en'); expect(ui.label({ ar: 'أ', en: 'A' }, 'k')).toBe('A'); expect(ui.label({ ar: 'أ' }, 'k')).toBe('أ'); expect(ui.label(null, 'k')).toBe('k'); setLang('ar'); expect(ui.label({ ar: 'أ', en: 'A' }, 'k')).toBe('أ'); setLang('en'); });
  it('errMsg: كود معروف يترجم، ومجهول/فاسد = رسالة عامة (مش المفتاح الخام ولا تسريب)', () => {
    const generic = t('err.generic'); expect(ui.errMsg({ code: 'zzz_unknown_code' })).toBe(generic); expect(ui.errMsg(null)).not.toMatch(/^err\./); expect(ui.errMsg({ message: '<script>' })).toBe(generic); expect(ui.errMsg({ code: 'auth/some-new-firebase-code' })).toBe(generic);
    const known = Object.keys(DICT.en).find((k) => k.startsWith('err.') && k !== 'err.generic'); expect(ui.errMsg({ code: known.slice(4) })).toBe(t(known));
  });
});

describe('i18n', () => {
  it('عربي وإنجليزي: نفس المفاتيح بالظبط (لا ترجمة ناقصة)', () => {
    const ar = Object.keys(DICT.ar).sort(), en = Object.keys(DICT.en).sort(); expect(ar.length).toBeGreaterThan(1000); expect(ar).toEqual(en);
  });
  it('نفس المتغيّرات {var} في الترجمتين لكل مفتاح، ولا قيمة فاضية', () => {
    const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(), bad = [];
    for (const k of Object.keys(DICT.ar)) { if (ph(DICT.ar[k]) !== ph(DICT.en[k])) bad.push(k); if (!String(DICT.ar[k]).trim() || !String(DICT.en[k]).trim()) bad.push('empty:' + k); }
    expect(bad).toEqual([]);
  });
  it('t: مفتاح مجهول = المفتاح نفسه، متغيّرات، متغيّر ناقص = فاضي، لغة غير معروفة = عربي', () => {
    expect(t('no.such.key')).toBe('no.such.key'); const k = Object.keys(DICT.en).find((x) => /\{\w+\}/.test(DICT.en[x]));
    const name = DICT.en[k].match(/\{(\w+)\}/)[1]; expect(t(k, { [name]: 'ZZ' })).toContain('ZZ'); expect(t(k, {})).not.toMatch(/\{\w+\}/);
    setLang('fr'); expect(document.documentElement.lang).toBe('ar'); expect(document.documentElement.dir).toBe('rtl'); setLang('en'); expect(document.documentElement.dir).toBe('ltr');
  });
});

describe('map.js', () => {
  it('distKm: صفر، متماثلة، القاهرة-الإسكندرية ≈ 180كم', () => {
    expect(map.distKm([30, 31], [30, 31])).toBe(0); const a = [30.0444, 31.2357], b = [31.2001, 29.9187]; expect(map.distKm(a, b)).toBeCloseTo(map.distKm(b, a), 9); expect(map.distKm(a, b)).toBeGreaterThan(170); expect(map.distKm(a, b)).toBeLessThan(190);
  });
  it('gmapsLink', () => { expect(map.gmapsLink(30.5, 31.25)).toBe('https://www.google.com/maps/dir/?api=1&destination=30.5,31.25&travelmode=driving'); });
});

describe('landing-content.cleanSite (إعدادات الصفحة الرئيسية من الأدمن)', () => {
  it('مدخلات فاسدة = قيم افتراضية آمنة', () => { for (const bad of [null, undefined, 5, 'x', [], {}]) { const r = lc.cleanSite(bad); expect(r.design).toBe('a'); expect(r.mode).toBe('auto'); expect(r.hide).toEqual([]); expect(r.texts).toEqual({}); } });
  it('بيرفض روابط غير https وبيقص النصوص الطويلة ويتجاهل حقول مجهولة', () => {
    const r = lc.cleanSite({ design: 'b', mode: 'dark', logoUrl: 'javascript:alert(1)', seo: { title: 'x'.repeat(500), description: 'y'.repeat(500) }, texts: { 'no.such.field': 'zzz' }, isAdmin: true });
    expect(r.design).toBe('b'); expect(r.mode).toBe('dark'); expect(r.logoUrl).toBeFalsy(); expect(r.seo.title.length).toBe(70); expect(r.seo.description.length).toBe(200); expect(r.texts).toEqual({}); expect('isAdmin' in r).toBe(false);
    expect(lc.cleanSite({ logoUrl: 'https://cdn.example.com/a.png' }).logoUrl).toBe('https://cdn.example.com/a.png'); expect(lc.cleanSite({ logoUrl: 'http://x.test/a.png' }).logoUrl).toBeFalsy();
  });
  it('hide: أقسام معروفة فقط وبدون تكرار', () => { const s = lc.LP_SECTIONS[0]; expect(lc.cleanSite({ hide: [s, s, 'bogus', 5] }).hide).toEqual([s]); });
  it('lpDefaultMode', () => { expect(lc.lpDefaultMode({ mode: 'dark', design: 'a' })).toBe('dark'); expect(lc.lpDefaultMode({ mode: 'auto', design: 'b' })).toBe('dark'); expect(lc.lpDefaultMode({ mode: 'auto', design: 'a' })).toBe('light'); });
});
