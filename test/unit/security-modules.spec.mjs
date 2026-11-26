import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomBase32, b32decode, totpCode, verifyTotp, totpMatch, otpauthURL } from '../../functions/_lib/totp.js';
import { driverPublic, driverPage, driversIndexPage } from '../../functions/_lib/publicProfile.js';
import { renderMsg, orderNo, pushEnabled } from '../../functions/_lib/push.js';
import { buildLanding, injectShell } from '../../functions/_lib/landing.js';
import { renderPage, PAGE_PATHS } from '../../functions/_lib/pages.js';
import { buildLlms } from '../../functions/_lib/llms.js';
import { DEFAULTS } from '../../functions/_lib/logic.js';

afterEach(() => vi.useRealTimers());
const text = async (x) => (typeof x === 'string' ? x : x && typeof x.text === 'function' ? await x.text() : String(x));

// RFC 6238 Appendix B (SHA-1): السر ASCII "12345678901234567890" = Base32 التالي. الكود 6 أرقام = آخر 6 من القيم 8 أرقام في الـRFC
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']];

describe('TOTP (RFC 6238)', () => {
  it.each(RFC)('المتجه الرسمي T=%i → %s', async (t, code) => { expect(await totpCode(RFC_SECRET, Math.floor(t / 30))).toBe(code); });
  it('b32decode: RFC 4648 + يتجاهل المسافات/=/حروف صغيرة', () => {
    expect(new TextDecoder().decode(b32decode('MZXW6YTBOI======'))).toBe('foobar'); expect(new TextDecoder().decode(b32decode('mzxw 6ytb oi'))).toBe('foobar');
    expect(b32decode('').length).toBe(0); expect(b32decode(null).length).toBe(0); expect(b32decode('!!!').length).toBe(0);
  });
  it('randomBase32: الطول والأبجدية وعدم التكرار', () => { const a = randomBase32(), b = randomBase32(); expect(a).toMatch(/^[A-Z2-7]{32}$/); expect(a).not.toBe(b); expect(randomBase32(16)).toHaveLength(16); });
  it('verifyTotp: الكود الحالي ونافذة ±1 فقط', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1234567890_000);
    const c = Math.floor(1234567890 / 30);
    expect(await verifyTotp(RFC_SECRET, await totpCode(RFC_SECRET, c))).toBe(true);
    expect(await verifyTotp(RFC_SECRET, await totpCode(RFC_SECRET, c - 1))).toBe(true);
    expect(await verifyTotp(RFC_SECRET, await totpCode(RFC_SECRET, c + 1))).toBe(true);
    expect(await verifyTotp(RFC_SECRET, await totpCode(RFC_SECRET, c - 2))).toBe(false);
    expect(await verifyTotp(RFC_SECRET, await totpCode(RFC_SECRET, c + 2))).toBe(false);
  });
  it('verifyTotp: مدخلات فاسدة = false (مش خطأ)', async () => {
    for (const code of ['', null, undefined, '12345', '1234567', 'abcdef', 123456]) expect(await verifyTotp(RFC_SECRET, code)).toBe(false);
    expect(await verifyTotp('', '123456')).toBe(false); expect(await verifyTotp(null, '123456')).toBe(false);
  });
  it('totpMatch بيرجّع رقم الخطوة (لمنع إعادة استخدام الكود) أو null', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1234567890_000); const c = Math.floor(1234567890 / 30);
    expect(await totpMatch(RFC_SECRET, await totpCode(RFC_SECRET, c))).toBe(c); expect(await totpMatch(RFC_SECRET, await totpCode(RFC_SECRET, c - 1))).toBe(c - 1);
    expect(await totpMatch(RFC_SECRET, '000000')).toBeNull(); // وقت ثابت فالنتيجة حتمية
    expect(await totpMatch(RFC_SECRET, 'x')).toBeNull(); expect(await totpMatch(null, '123456')).toBeNull();
  });
  it('الكود بيقبل مسافات/فواصل (مثلاً "287 082")', async () => { vi.useFakeTimers(); vi.setSystemTime(59_000); expect(await verifyTotp(RFC_SECRET, '287 082')).toBe(true); });
  it('otpauthURL', () => { const u = otpauthURL('ABC', 'a b@x.com'); expect(u).toBe('otpauth://totp/Ashhanli:a%20b%40x.com?secret=ABC&issuer=Ashhanli&algorithm=SHA1&digits=6&period=30'); expect(otpauthURL('ABC')).toContain(':admin?'); });
});

describe('الصفحات العامة للسواقين: خصوصية و XSS', () => {
  const user = { uid: 'u1', role: 'driver', status: 'active', name: 'أحمد محمد علي', phone: '01012345678', email: 'a@x.com', national_id: '28501011234567', vehicle_type: 'pickup', rating_sum: 45, rating_count: 10, completed_orders: 12, created_at: 1_700_000_000_000, wallet_frozen: false, license_ref: 'secret-ref' };
  it('driverPublic: قائمة بيضاء فقط (مفيش موبايل/إيميل/رقم قومي/مراجع ملفات) والاسم مختصر', () => {
    const o = driverPublic(user, DEFAULTS), j = JSON.stringify(o);
    expect(Object.keys(o).sort()).toEqual(['badges', 'id', 'level', 'levelAr', 'name', 'rating', 'ratings', 'since', 'trips', 'vehicle']);
    for (const secret of ['01012345678', 'a@x.com', '28501011234567', 'secret-ref', 'علي']) expect(j).not.toContain(secret);
    expect(o.name).toBe('أحمد م.');
  });
  it('اسم عدائي: مفيش </script> ولا وسوم خام في صفحة السواق', async () => {
    const evil = { ...user, name: '</script><img src=x onerror=alert(1)> y' };
    const html = await text(driverPage({}, evil, 'https://x.test', DEFAULTS));
    expect(html).not.toMatch(/<img src=x/); expect(html.match(/<\/script>/g)?.length ?? 0).toBeLessThanOrEqual(1); // فقط إغلاق JSON-LD الشرعي
    expect(html).not.toContain('01012345678');
  });
  it('فهرس السواقين بيهرّب الأسماء ولا يعرض بيانات شخصية', async () => {
    const html = await text(driversIndexPage([driverPublic({ ...user, name: '<b>x</b> <i>y</i>' }, DEFAULTS)], 'https://x.test'));
    expect(html).not.toContain('<b>x</b>'); expect(html).not.toContain('01012345678');
  });
});

describe('push helpers', () => {
  it('orderNo', () => { expect(orderNo('abcdef123')).toBe('#ABCDEF'); expect(orderNo(12)).toBe('#12'); });
  it('pushEnabled يحتاج السر ولا يكون معطّل', () => { expect(pushEnabled({})).toBe(false); expect(pushEnabled({ FIREBASE_SERVICE_ACCOUNT: 'x' })).toBe(true); expect(pushEnabled({ FIREBASE_SERVICE_ACCOUNT: 'x', PUSH_DISABLED: '1' })).toBe(false); });
  it('renderMsg: عربي/إنجليزي، متغيّرات، نوع مجهول = null', () => {
    expect(renderMsg('withdrawal_rejected', 'ar', { amount: 50 }).body).toContain('50'); expect(renderMsg('withdrawal_rejected', 'en', { amount: 50 }).title).toBe('Withdrawal rejected');
    expect(renderMsg('withdrawal_rejected', 'fr', { amount: 1 }).title).toBe('تم رفض طلب السحب'); expect(renderMsg('nope', 'ar')).toBeNull();
    expect(renderMsg('withdrawal_rejected', 'ar', {}).body).not.toContain('{amount}');
  });
});

describe('صفحات التسويق (SSR): هروب المحتوى المتحكم فيه من الأدمن', () => {
  const evilCompany = { name: '<script>alert(1)</script>', about: '"><img src=x onerror=alert(2)>', phone: '"onmouseover="x', whatsapp: '', email: '', address: '', hours: '' };
  it('buildLanding', () => { const r = buildLanding({ settings: DEFAULTS, company: evilCompany }); const j = JSON.stringify(r); expect(j).not.toContain('<script>alert(1)'); expect(j).not.toMatch(/<img src=x/); });
  it('renderPage لكل الأنواع', async () => {
    for (const kind of Object.keys(PAGE_PATHS)) { const html = await text(renderPage(kind, { settings: DEFAULTS, company: evilCompany })); expect(html, kind).not.toContain('<script>alert(1)'); expect(html, kind).not.toMatch(/<img src=x/); expect(html.length).toBeGreaterThan(500); }
  });
  it('buildLlms (نص عادي): مفيش undefined/[object Object]', () => { for (const full of [false, true]) { const t = buildLlms({ ...DEFAULTS, company: { name: 'اشحنلي' } }, { SITE_URL: 'https://x.test' }, full); expect(typeof t).toBe('string'); expect(t).not.toMatch(/undefined|\[object Object\]|NaN/); } });
  it('injectShell لا يكسر لو الـshell فاضي', () => { expect(() => injectShell('<html><head></head><body></body></html>', buildLanding({ settings: DEFAULTS }))).not.toThrow(); });
});
