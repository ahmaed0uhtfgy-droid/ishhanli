import { describe, it, expect } from 'vitest';
import { toCsv } from '../../public/js/csv.js';
import { moneySteps } from '../../public/js/money.js';
import { estimate, straightKm, CITIES, priceFromKm } from '../../public/js/estimate.js';
import { rulesSections } from '../../public/js/rules.js';
import { vehicleSvg, vehicleImgKey, VEHICLE_SHAPES } from '../../public/js/vehicles.js';
import { analyzePixels, judge } from '../../public/js/docCheck.js';

describe('toCsv', () => {
  const cols = [{ h: 'name', v: (r) => r.n }, { h: 'amt', v: (r) => r.a }];
  it('BOM + CRLF + عنوان', () => { const t = toCsv(cols, [{ n: 'a', a: 1 }]); expect(t.startsWith('\ufeff')).toBe(true); expect(t.split('\r\n')).toEqual(['\ufeffname,amt', 'a,1']); });
  it('حقن الصيغ: = + - @ في النصوص تتحصّن، الأرقام السالبة لا', () => {
    const t = toCsv(cols, [{ n: '=HYPERLINK("x")', a: -5 }, { n: '+1', a: 0 }, { n: '@cmd', a: 1 }, { n: '-2', a: 1 }]);
    const lines = t.split('\r\n'); expect(lines[1]).toBe('"\'=HYPERLINK(""x"")",-5'); expect(lines[2].startsWith("'+1")).toBe(true); expect(lines[3].startsWith("'@")).toBe(true); expect(lines[4].startsWith("'-2")).toBe(true);
  });
  it('فواصل وأسطر وعلامات اقتباس وقيم فاضية', () => { const t = toCsv(cols, [{ n: 'a,b', a: null }, { n: 'x\ny', a: undefined }]); expect(t.split('\r\n')[1]).toBe('"a,b",'); expect(t).toContain('"x\ny",'); expect(toCsv(cols, [{ n: 'say "hi"', a: '' }])).toContain('"say ""hi"""'); });
  it('صفوف فاضية = عنوان فقط', () => { expect(toCsv(cols, [])).toBe('\ufeffname,amt'); });
});

describe('moneySteps', () => {
  it('لسه ما اتدفعش / دفع مباشر / null: لا كارت', () => { expect(moneySteps({ status: 'open' })).toBeNull(); expect(moneySteps({ status: 'paid', direct: true })).toBeNull(); expect(moneySteps(null)).toBeNull(); expect(moneySteps(undefined)).toBeNull(); });
  it('تحت المراجعة', () => { const s = moneySteps({ status: 'payment_review' }); expect(s.map((x) => x.state)).toEqual(['now', 'wait', 'wait']); });
  it('محجوز', () => { expect(moneySteps({ status: 'in_transit', escrowStatus: 'held' }).map((x) => x.state)).toEqual(['done', 'now', 'wait']); });
  it('محرَّر / مسترد', () => { expect(moneySteps({ status: 'completed', escrowStatus: 'released' })[2]).toMatchObject({ state: 'done', text: 'money.out.released' }); expect(moneySteps({ status: 'cancelled', escrowStatus: 'refunded' })[2].text).toBe('money.out.refunded'); });
  it('نزاع', () => { expect(moneySteps({ status: 'disputed', escrowStatus: 'held' })[1].state).toBe('now'); });
});

describe('estimate', () => {
  const S = { perKm: 10, minPrice: 50, roadFactor: 1.3, categories: { general: { mult: 1 } }, sizes: { small: { mult: 1 } }, vehicleGuide: {} };
  it('نفس المدينة/مدينة مجهولة → null', () => { expect(estimate(S, 'cairo', 'cairo', 'general', 'small')).toBeNull(); expect(estimate(S, 'cairo', 'nowhere', 'general', 'small')).toBeNull(); });
  it('القاهرة→الإسكندرية: مسافة وسعر منطقيين', () => { const r = estimate(S, 'cairo', 'alex', 'general', 'small'); expect(r.km).toBeGreaterThan(200); expect(r.km).toBeLessThan(270); expect(r.price).toBeGreaterThanOrEqual(r.km * 10); });
  it('فئة مجهولة → null', () => { expect(estimate(S, 'cairo', 'alex', 'x', 'small')).toBeNull(); });
  it('straightKm متماثلة وكل المدن إحداثياتها داخل مصر', () => {
    expect(straightKm(CITIES.cairo, CITIES.alex)).toBeCloseTo(straightKm(CITIES.alex, CITIES.cairo), 6);
    for (const [k, c] of Object.entries(CITIES)) { expect(c[2], k).toBeGreaterThan(21); expect(c[2], k).toBeLessThan(32); expect(c[3], k).toBeGreaterThan(24); expect(c[3], k).toBeLessThan(37); }
  });
  it('تقدير العميل = حساب السيرفر (نفس المعادلة)', async () => {
    const { calcPrice } = await import('../../functions/_lib/logic.js');
    const s = { ...S, vehiclePricing: { pickup: { base: 20, perKm: 5, minPrice: 30 } }, vehicleGuide: { pickup: { maxKg: 500, size: 'small' } } };
    for (const km of [0, 1, 7.3, 100, 999]) expect(priceFromKm(s, km, 'general', 'small')).toBe(calcPrice(s, km, 'general', 'small').price);
  });
});

describe('rulesSections', () => {
  it('يشتغل من غير إعدادات', () => { const r = rulesSections(); expect(r.map((x) => x.id)).toEqual(['all', 'customer', 'driver', 'company']); r.forEach((g) => expect(g.rules.length).toBeGreaterThan(0)); });
  it('قواعد شرطية تظهر وتختفي', () => {
    const ids = (S, g) => rulesSections(S).find((x) => x.id === g).rules.map((r) => r.id);
    expect(ids({}, 'customer')).not.toContain('c14'); expect(ids({ codEnabled: true }, 'customer')).toContain('c14');
    expect(ids({ dcEnabled: true, finesEnabled: true }, 'driver')).toContain('d17'); expect(ids({ finesEnabled: true }, 'driver')).not.toContain('d17');
  });
  it('قيم فاسدة ترجع للافتراضي', () => { const r = rulesSections({ maxCancellations: 'abc', prepaidGraceMin: '' }); expect(r[1].rules[0].vars.max).toBe(5); expect(r[1].rules[0].vars.grace).toBe(30); });
});

describe('vehicles', () => {
  it('كل شكل يرجّع svg سليم، ونوع مجهول يرجع half_ton', () => { for (const k of VEHICLE_SHAPES) expect(vehicleSvg(k)).toMatch(/^<svg[\s\S]*<\/svg>$/); expect(vehicleImgKey('nope')).toBe('half_ton'); });
  it('label يتنضّف من الرموز الخطرة', () => { const s = vehicleSvg('car', '"><script>x</script>'); expect(s).not.toContain('<script'); expect(/aria-label="([^"]*)"/.exec(s)[1]).toBe('scriptx/script'); });
});

describe('docCheck.judge / analyzePixels', () => {
  const img = (fn, w = 40, h = 40) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = fn(x, y); const i = (y * w + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; } return analyzePixels(d, w, h); };
  it('سودا → dark، بيضا → bright، لون واحد → blank', () => { expect(judge(img(() => [5, 5, 5]))).toBe('dark'); expect(judge(img(() => [250, 250, 250]))).toBe('bright'); expect(judge(img(() => [120, 120, 120]))).toBe('blank'); });
  it('نص/شبكة عالية التباين تتقبل', () => { expect(judge(img((x, y) => ((x >> 1) + (y >> 1)) % 2 ? [20, 20, 20] : [220, 220, 220]))).toBeNull(); });
  it('لون بشرة كامل → selfie', () => { expect(judge({ mean: 120, sd: 50, edge: 0.3, lapVar: 500, skin: 0.9 })).toBe('selfie'); });
  it('تدرّج ناعم → blurry أو blank (مش مقبول)', () => { expect(judge(img((x) => [60 + x * 3, 60 + x * 3, 60 + x * 3]))).not.toBeNull(); });
});
