// الافتراضي الجديد: الدفع المباشر هو الأساسي (مفيش ضمان/حجز فلوس إلا لو الأدمن رجّعه)
import assert from 'node:assert/strict';
import { DEFAULTS, calcPrice } from '../functions/_lib/logic.js';
assert.equal(DEFAULTS.dcEnabled, true, 'الدفع المباشر هو الافتراضي');
console.log('✓ DEFAULTS.dcEnabled = true');
const ks = ['pickup', 'half_ton', 'jumbo', 'truck'], sz = DEFAULTS.vehicleGuide;
assert.deepEqual(ks.map((k) => sz[k].size), ['small', 'medium', 'large', 'xlarge'], 'كل نوع ليه حجمه');
assert.ok(sz.jumbo.maxKg > sz.half_ton.maxKg && sz.jumbo.maxKg < sz.truck.maxKg, 'الجامبو بين النص نقل والنقل الثقيل');
const prices = ks.map((k) => calcPrice(DEFAULTS, 145, 'goods', sz[k].size, k).price);
assert.ok(prices.every((p, i) => i === 0 || p > prices[i - 1]), 'السعر بيزيد مع حجم العربية: ' + prices);
assert.equal(new Set(ks.map((k) => JSON.stringify(DEFAULTS.vehiclePricing[k]))).size, 4, 'كل نوع بتسعيرة مختلفة');
console.log('✓ كل نوع عربية بتسعيرته (145 كم):', prices.join(' < '));
console.log('✅ default tests passed');
