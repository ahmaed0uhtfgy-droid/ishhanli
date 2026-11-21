// اختيار طريقة تثبيت التطبيق حسب الجهاز/المتصفح
import { describe, it, expect } from 'vitest';
import { installMode } from '../../public/js/install.js';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const FB = 'Mozilla/5.0 (Linux; Android 13; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/430.0]';
const IG_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0';
const DESK = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
describe('installMode', () => {
  it('متثبّت بالفعل (standalone) يغلب كل حاجة', () => expect(installMode(IPHONE, { standalone: true, hasPrompt: true })).toBe('installed'));
  it('أندرويد كروم ومعاه beforeinstallprompt', () => expect(installMode(ANDROID, { hasPrompt: true })).toBe('prompt'));
  it('أندرويد من غير prompt: شرح القايمة', () => expect(installMode(ANDROID, {})).toBe('android'));
  it('آيفون Safari: شرح المشاركة', () => expect(installMode(IPHONE, {})).toBe('ios'));
  it('iPad بيعرّف نفسه Mac بس فيه لمس', () => expect(installMode(DESK.replace('Windows NT 10.0; Win64; x64', 'Macintosh; Intel Mac OS X 10_15_7'), { platform: 'MacIntel', touchPoints: 5 })).toBe('ios'));
  it('تطبيقات داخلية (فيسبوك/إنستجرام): افتح في المتصفح', () => { expect(installMode(FB, { hasPrompt: true })).toBe('inapp'); expect(installMode(IG_IOS, {})).toBe('inapp'); });
  it('ديسكتوب', () => { expect(installMode(DESK, {})).toBe('desktop'); expect(installMode(DESK, { hasPrompt: true })).toBe('prompt'); });
});
