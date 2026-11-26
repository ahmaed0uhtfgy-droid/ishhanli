import { describe, it, expect } from 'vitest';
import { calcPrice, calcPassengerPrice, split, cancelSplit, couponDiscount, haversineM, dcDue, dcPayable, fineCredit, kmFeeOf, dcBlocked, dcFeesOn, codSplit, codPeriodOf, codPeriodBounds, codStatements, codBlocked, recommendVehicle, canServe, guardOf, DEFAULTS } from '../../functions/_lib/logic.js';
import { HttpError } from '../../functions/_lib/core.js';

const S = { perKm: 10, minPrice: 50, categories: { general: { mult: 1 }, fragile: { mult: 1.5 } }, sizes: { small: { mult: 1 }, large: { mult: 2 } }, vehicleGuide: {}, passengerClasses: { car: { mult: 1, seats: 4 } } };
const code = (fn) => { try { fn(); } catch (e) { return e instanceof HttpError ? e.message || e.code : 'other:' + e.message; } return null; };

describe('calcPrice', () => {
  it('المعادلة العامة: كم × سعر × معاملات، مقرّب لأعلى', () => { expect(calcPrice(S, 12.3, 'fragile', 'large').price).toBe(Math.ceil(10 * 12.3 * 1.5 * 2)); });
  it('الحد الأدنى', () => { expect(calcPrice(S, 0, 'general', 'small').price).toBe(50); expect(calcPrice(S, 1, 'general', 'small').price).toBe(50); });
  it('مسافة سالبة لا تنزل عن الحد الأدنى', () => { expect(calcPrice(S, -100, 'general', 'small').price).toBe(50); });
  it('فئة أو حجم مجهول يرمي 400', () => { expect(() => calcPrice(S, 5, 'nope', 'small')).toThrow(); expect(() => calcPrice(S, 5, 'general', 'nope')).toThrow(); });
  it('تسعير خاص للعربية', () => {
    const s = { ...S, vehiclePricing: { pickup: { base: 20, perKm: 5, minPrice: 30, kmFee: 0 } } };
    expect(calcPrice(s, 10, 'general', 'small', 'pickup').price).toBe(70);
    expect(calcPrice(s, 0, 'general', 'small', 'pickup').price).toBe(30);
  });
});

describe('calcPassengerPrice', () => {
  it('يحسب ويحترم الحد الأدنى', () => { expect(calcPassengerPrice(S, 10, 'car').price).toBe(100); expect(calcPassengerPrice(S, 1, 'car').price).toBe(50); });
  it('فئة مجهولة تُرفض', () => { expect(() => calcPassengerPrice(S, 5, 'bus')).toThrow(); });
});

describe('split / cancelSplit', () => {
  it('المجموع دايماً = المبلغ (أعداد صحيحة)', () => {
    for (const [a, p] of [[100, 12], [99, 12], [1, 12], [0, 12], [1234, 7.5], [50, 100], [50, 0]]) { const r = split(a, p); expect(r.commission + r.net).toBe(a); expect(Number.isInteger(r.commission)).toBe(true); }
  });
  it('cancelSplit مجموعه = السعر ولا شيء سالب', () => {
    for (const price of [0, 1, 7, 99, 100, 1001]) for (const [d, p] of [[10, 5], [30, 10], [100, 100], [60, 60], [0, 0]]) {
      const r = cancelSplit(price, d, p); expect(r.driver + r.platform + r.refund).toBe(price);
      expect(r.driver).toBeGreaterThanOrEqual(0); expect(r.platform).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('couponDiscount', () => {
  const now = 1_000_000, ok = { active: true, type: 'percent', value: 10 };
  it('نسبة وقيمة ثابتة', () => { expect(couponDiscount(ok, 200, now)).toBe(20); expect(couponDiscount({ active: true, type: 'amount', value: 30 }, 200, now)).toBe(30); });
  it('لا يتخطى السعر ولا يصبح سالب', () => { expect(couponDiscount({ active: true, type: 'amount', value: 500 }, 200, now)).toBe(200); expect(couponDiscount({ active: true, type: 'amount', value: -5 }, 200, now)).toBe(0); });
  it('سقف الخصم', () => { expect(couponDiscount({ ...ok, value: 50, max_discount: 15 }, 200, now)).toBe(15); });
  it('غير نشط/نوع غلط/منتهي/مستنفد/حد أدنى', () => {
    expect(() => couponDiscount(null, 100, now)).toThrow();
    expect(() => couponDiscount({ ...ok, active: false }, 100, now)).toThrow();
    expect(() => couponDiscount({ ...ok, type: 'x' }, 100, now)).toThrow();
    expect(() => couponDiscount({ ...ok, expires_at: now }, 100, now)).toThrow();
    expect(() => couponDiscount({ ...ok, max_uses: 2, used_count: 2 }, 100, now)).toThrow();
    expect(() => couponDiscount({ ...ok, min_price: 500 }, 100, now)).toThrow();
  });
});

describe('haversineM', () => {
  it('صفر لنفس النقطة', () => { expect(haversineM({ lat: 30, lng: 31 }, { lat: 30, lng: 31 })).toBe(0); });
  it('القاهرة-الإسكندرية ≈ 180 كم (±10)', () => { const d = haversineM({ lat: 30.0444, lng: 31.2357 }, { lat: 31.2001, lng: 29.9187 }) / 1000; expect(d).toBeGreaterThan(170); expect(d).toBeLessThan(190); });
  it('متماثلة', () => { const a = { lat: 10, lng: 20 }, b = { lat: -5, lng: 40 }; expect(haversineM(a, b)).toBeCloseTo(haversineM(b, a), 6); });
});

describe('الدفع المباشر (dc)', () => {
  it('dcDue يتعامل مع قيم فاسدة', () => { expect(dcDue(1000, 2)).toBe(20); expect(dcDue(-5, 2)).toBe(0); expect(dcDue('x', 2)).toBe(0); expect(dcDue(100, undefined)).toBe(0); });
  it('fineCredit أقل من الغرامة دائماً', () => { for (const a of [1, 15, 30, 99, 1000]) expect(fineCredit(a, 99)).toBeLessThan(a); expect(fineCredit(100, 500)).toBe(99); expect(fineCredit(-1, 50)).toBe(0); });
  it('dcPayable: التعويض لا يتخطى العمولة', () => { const r = dcPayable(1000, 10, 500, 0); expect(r).toMatchObject({ commission: 100, creditUsed: 100, amount: 0 }); });
  it('dcPayable: الغرامات المحصّلة تُضاف', () => { expect(dcPayable(1000, 10, 0, 40).amount).toBe(140); });
  it('dcPayable: مدخلات سالبة/NaN آمنة', () => { const r = dcPayable(-1, NaN, -5, -9, -3); expect(r.amount).toBe(0); });
  it('kmFeeOf و dcBlocked و dcFeesOn', () => {
    const s = { dcEnabled: true, dcPct: 2, dcPerKm: 1, dcLimit: 100, vehiclePricing: { pickup: { kmFee: 3 } } };
    expect(kmFeeOf(s, 10, 'pickup')).toBe(30); expect(kmFeeOf(s, 10, 'jumbo')).toBe(10); expect(kmFeeOf(s, -4, null)).toBe(0);
    expect(dcBlocked(100, s)).toBe(true); expect(dcBlocked(99, s)).toBe(false); expect(dcBlocked(1e9, { ...s, dcEnabled: false })).toBe(false); expect(dcFeesOn({ ...s, dcPct: 0, dcPerKm: 0, vehiclePricing: {} })).toBe(false);
  });
});

describe('COD', () => {
  it('codSplit: حدود النسبة والمبلغ', () => { expect(codSplit(1000, 5)).toEqual({ amount: 1000, commission: 50, net: 950 }); expect(codSplit(1000, 99).commission).toBe(300); expect(codSplit(-5, 5)).toEqual({ amount: 0, commission: 0, net: 0 }); expect(codSplit('x', 5).net).toBe(0); });
  it('الفترة: المفتاح والحدود متسقة', () => { const ts = 1_700_000_000_000, p = codPeriodOf(ts, 7), b = codPeriodBounds(p.key); expect(b.start).toBe(p.start); expect(b.end).toBe(p.end); expect(ts >= p.start && ts < p.end).toBe(true); });
  it('codPeriodBounds يرفض مفاتيح فاسدة', () => { for (const k of ['', null, 'x', '0d-1', '32d-1', '7d-', '7d-9999999', '7d--1']) expect(codPeriodBounds(k)).toBeNull(); });
  it('الكشوفات: open → due → overdue / paid', () => {
    const s = { codGraceDays: 3 }, p = codPeriodOf(1_700_000_000_000, 7), e = [{ period: p.key, amount: 100, commission: 5, net: 95 }], DAY = 864e5;
    expect(codStatements(e, {}, s, p.end - 1)[0].status).toBe('open');
    expect(codStatements(e, {}, s, p.end + 1)[0].status).toBe('due');
    expect(codStatements(e, {}, s, p.end + 4 * DAY)[0].status).toBe('overdue');
    expect(codStatements(e, { [p.key]: { status: 'paid' } }, s, p.end + 99 * DAY)[0].status).toBe('paid');
    expect(codBlocked(codStatements(e, {}, s, p.end + 4 * DAY))).toBe(true); expect(codBlocked([])).toBe(false); expect(codBlocked(undefined)).toBe(false);
  });
  it('codStatements يتجاهل مدخلات من غير فترة ويتحمّل null', () => { expect(codStatements(null, null, null, 0)).toEqual([]); expect(codStatements([{ amount: 1 }], {}, {}, 0)).toEqual([]); });
});

describe('ترشيح العربية والقدرة', () => {
  const g = { pickup: { maxKg: 500 }, half_ton: { maxKg: 1000 }, jumbo: { maxKg: 0 }, truck: { maxKg: 5000 } };
  it('أول عربية تكفي', () => { expect(recommendVehicle(g, 400)).toBe('pickup'); expect(recommendVehicle(g, 501)).toBe('half_ton'); expect(recommendVehicle(g, 1001)).toBe('truck'); });
  it('وزن أكبر من الكل → الأكبر، وقيم فاسدة → الأكبر', () => { expect(recommendVehicle(g, 1e9)).toBe('truck'); expect(recommendVehicle(g, NaN)).toBe('truck'); expect(recommendVehicle(g, -1)).toBe('truck'); });
  it('بدون عربيات مفعّلة → null', () => { expect(recommendVehicle({}, 5)).toBeNull(); expect(recommendVehicle(null, 5)).toBeNull(); });
  it('canServe', () => {
    expect(canServe('pickup', { size: 'large' })).toBe(false); expect(canServe('truck', { size: 'xlarge' })).toBe(true); expect(canServe('pickup', { size: 'custom' })).toBe(true);
    expect(canServe('car', { service: 'passengers', vehicleClass: 'minibus' })).toBe(false); expect(canServe('minibus', { service: 'passengers', vehicleClass: 'car' })).toBe(true); expect(canServe('truck', { service: 'passengers', vehicleClass: 'car' })).toBe(false);
  });
  it('guardOf', () => { expect(guardOf({ valueGuardOn: true, valueGuardFrom: 100 }, 100)).toBe('high'); expect(guardOf({ valueGuardOn: true, valueGuardFrom: 100 }, 99)).toBeNull(); expect(guardOf({ valueGuardOn: false, valueGuardFrom: 1 }, 1e9)).toBeNull(); });
});

describe('DEFAULTS', () => { it('أسعار وعمولة منطقية', () => { expect(DEFAULTS.perKm).toBeGreaterThan(0); expect(DEFAULTS.commissionPct).toBeGreaterThanOrEqual(0); expect(DEFAULTS.commissionPct).toBeLessThanOrEqual(100); }); });
