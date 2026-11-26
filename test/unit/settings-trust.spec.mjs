import { describe, it, expect } from 'vitest';
import { sanitizeSettings, DEFAULTS, effectiveCommissionPct, lateKinds, dueOf } from '../../functions/_lib/logic.js';
import { trustOf, DEFAULT_TRUST } from '../../functions/_lib/trust.js';
import { esc } from '../../functions/_lib/landing.js';

const base = () => JSON.parse(JSON.stringify(DEFAULTS));
const bad = (mut) => { const b = base(); mut(b); try { sanitizeSettings(b); } catch { return true; } return false; };

describe('sanitizeSettings', () => {
  it('الإعدادات الافتراضية تعدّي وتبقى ثابتة (idempotent)', () => { const a = sanitizeSettings(base()); expect(sanitizeSettings(a)).toEqual(a); });
  it('يرفض أرقام خارج النطاق/NaN/نص', () => {
    expect(bad((b) => { b.perKm = -1; })).toBe(true); expect(bad((b) => { b.perKm = NaN; })).toBe(true); expect(bad((b) => { b.perKm = 'abc'; })).toBe(true);
    expect(bad((b) => { b.commissionPct = 101; })).toBe(true); expect(bad((b) => { b.roadFactor = 0.5; })).toBe(true); expect(bad((b) => { b.minWithdraw = 0; })).toBe(true);
    expect(bad((b) => { b.perKm = Infinity; })).toBe(true);
  });
  it('يرفض جسم فاضي/ناقص', () => { expect(() => sanitizeSettings({})).toThrow(); });
  it('مجموع نسب الإلغاء ≤ 100', () => { expect(bad((b) => { b.cancelPaidDriverPct = 60; b.cancelPaidPlatformPct = 50; })).toBe(true); });
  it('جداول الفئات: مفتاح غلط/فاضي/معامل خارج النطاق', () => {
    expect(bad((b) => { b.categories = {}; })).toBe(true); expect(bad((b) => { b.categories = { 'BAD KEY': { mult: 1 } }; })).toBe(true); expect(bad((b) => { b.categories = { ok: { mult: 0 } }; })).toBe(true); expect(bad((b) => { b.categories = null; })).toBe(true);
  });
  it('دليل العربيات: الأوزان المفعّلة لازم تتصاعد وحجم موجود', () => {
    expect(bad((b) => { b.vehicleGuide.pickup.maxKg = 9000; b.vehicleGuide.half_ton.maxKg = 100; })).toBe(true);
    expect(bad((b) => { b.vehicleGuide.pickup.size = 'ghost'; })).toBe(true);
  });
  it('قواعد الثقة لازم تتدرّج', () => { expect(bad((b) => { b.trustRules = { trusted: { avg: 5, ratings: 1 }, pro: { avg: 4, ratings: 1 }, elite: { avg: 4.5, ratings: 1 } }; })).toBe(true); });
  it('نسبة COD والدفع المباشر لها سقف', () => { expect(bad((b) => { b.codCommissionPct = 31; })).toBe(true); expect(bad((b) => { b.dcPct = 51; })).toBe(true); });
  it('يقصّ النصوص الطويلة ويتجاهل حقول مجهولة', () => {
    const b = base(); b.company = { name: 'x'.repeat(500), about: 'y'.repeat(2000) }; b.__proto__x = 1; b.isAdmin = true;
    const r = sanitizeSettings(b); expect(r.company.name.length).toBe(160); expect(r.company.about.length).toBe(800); expect('isAdmin' in r).toBe(false);
  });
  it('الأعلام المنطقية تقبل true فقط (لا "true" نصية)', () => { const b = base(); b.testPayments = 'true'; b.dcEnabled = 1; const r = sanitizeSettings(b); expect(r.testPayments).toBe(false); expect(r.dcEnabled).toBe(false); });
  it('codBlockScope يقبل all أو cod فقط', () => { const b = base(); b.codBlockScope = 'evil'; expect(sanitizeSettings(b).codBlockScope).toBe('cod'); });
});

describe('trustOf', () => {
  it('سواق جديد: مستوى new ومتوسط 0', () => { const t = trustOf({}); expect(t.level).toBe('new'); expect(t.stats.ratingAvg).toBe(0); expect(t.next.level).toBe('trusted'); });
  it('الحدود بالظبط (>=)', () => {
    expect(trustOf({ rating_count: 3, rating_sum: 12 }).level).toBe('trusted');
    expect(trustOf({ rating_count: 3, rating_sum: 11.9 }).level).toBe('new');
    expect(trustOf({ rating_count: 10, rating_sum: 45 }).level).toBe('pro');
    expect(trustOf({ rating_count: 20, rating_sum: 94 }).level).toBe('elite');
    expect(trustOf({ rating_count: 20, rating_sum: 94 }).next).toBeNull();
  });
  it('نسبة الإلغاء بدون قسمة على صفر', () => { expect(trustOf({ cancel_count: 0, completed_orders: 0 }).stats.cancelPct).toBe(0); expect(trustOf({ cancel_count: 1, completed_orders: 3 }).stats.cancelPct).toBe(25); });
  it('الشارات', () => {
    const b = trustOf({ status: 'active', phone_verified: true, rating_count: 20, rating_sum: 97, completed_orders: 15, cancel_count: 0 }).badges;
    expect(b).toEqual(['verified', 'phone', 'top_rated', 'reliable']);
    expect(trustOf({ status: 'pending' }).badges).toEqual([]);
  });
  it('حدود الأدمن المخصصة تتطبق', () => { expect(trustOf({ rating_count: 1, rating_sum: 5 }, { trustRules: { trusted: { avg: 4, ratings: 1 }, pro: { avg: 4.5, ratings: 10 }, elite: { avg: 4.7, ratings: 20 } } }).level).toBe('trusted'); });
  it('DEFAULT_TRUST متدرّج', () => { expect(DEFAULT_TRUST.trusted.avg).toBeLessThanOrEqual(DEFAULT_TRUST.pro.avg); expect(DEFAULT_TRUST.pro.avg).toBeLessThanOrEqual(DEFAULT_TRUST.elite.avg); });
});

describe('effectiveCommissionPct', () => {
  const s = { levelDiscountPct: { trusted: 2, pro: 4, elite: 6 }, newDriver: { orders: 3, commissionPct: 5 }, trustRules: DEFAULT_TRUST };
  it('سواق جديد بعمولة مخفضة (الأقل)', () => { expect(effectiveCommissionPct(s, 12, { completed_orders: 0 })).toBe(5); expect(effectiveCommissionPct(s, 3, { completed_orders: 0 })).toBe(3); });
  it('بعد أول رحلات: العمولة − خصم المستوى، ولا تنزل عن صفر', () => {
    expect(effectiveCommissionPct(s, 12, { completed_orders: 10, rating_count: 20, rating_sum: 95 })).toBe(6);
    expect(effectiveCommissionPct(s, 3, { completed_orders: 10, rating_count: 20, rating_sum: 95 })).toBe(0);
  });
  it('driverRow فاضي لا يكسر', () => { expect(effectiveCommissionPct(s, 12, null)).toBe(5); });
});

describe('lateKinds / dueOf', () => {
  const T = 10_000_000, o = (x) => ({ graceMin: 10, driverId: 'd', acceptedAt: T - 99999999, status: 'paid', scheduledAt: T, ...x });
  it('بدون graceMin أو سواق: لا تتبّع', () => { expect(lateKinds(o({ graceMin: null }), T * 2)).toEqual([]); expect(lateKinds(o({ driverId: null }), T * 2)).toEqual([]); });
  it('قبل الحد: لا تأخير. بعد الحد: pickup', () => { expect(lateKinds(o(), T + 10 * 60000)).toEqual([]); expect(lateKinds(o(), T + 10 * 60000 + 1)).toEqual(['pickup']); });
  it('علامة سابقة تمنع التكرار', () => { expect(lateKinds(o({ lateMarks: { pickup: 1 } }), T * 2)).toEqual([]); });
  it('لو التزم السواق بعد فوات الميعاد: مش ذنبه', () => { expect(lateKinds(o({ acceptedAt: T + 99 * 60000 }), T * 2)).toEqual([]); });
  it('dueOf يفضّل agreed على الأصلي', () => { expect(dueOf({ agreed: { pickupAt: 5 }, scheduledAt: 9 }, 'pickup')).toBe(5); expect(dueOf({ deliveryAt: 7 }, 'delivery')).toBe(7); expect(dueOf({}, 'pickup')).toBeNull(); });
});

describe('esc (HTML escape)', () => {
  it('يهرّب الرموز الخطرة', () => { expect(esc('<img src=x onerror="a()">&\'')).toBe('&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;'); });
  it('null/undefined/أرقام', () => { expect(esc(null)).toBe(''); expect(esc(undefined)).toBe(''); expect(esc(0)).toBe('0'); });
});
