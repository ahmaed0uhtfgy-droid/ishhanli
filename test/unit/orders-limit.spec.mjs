// حد قايمة «طلباتي» بيتظبط من الأدمن (الإعدادات) ومحصور بين 20 و300
import { describe, it, expect } from 'vitest';
import { DEFAULTS, sanitizeSettings } from '../../functions/_lib/logic.js';
describe('ordersListLimit', () => {
  it('الافتراضي 100', () => expect(DEFAULTS.ordersListLimit).toBe(100));
  it('قيمة سليمة بتتحفظ كما هي', () => expect(sanitizeSettings({ ...DEFAULTS, ordersListLimit: 250 }).ordersListLimit).toBe(250));
  it('برّه الحدود: يتحصر أو يترفض (مش يعدّي)', () => {
    for (const v of [5, 301, -1]) { let out; try { out = sanitizeSettings({ ...DEFAULTS, ordersListLimit: v }).ordersListLimit; } catch { out = 'rejected'; } expect(out === 'rejected' || (out >= 20 && out <= 300), String(v)).toBe(true); }
  });
});
