// TOTP (RFC 6238) + Base32 (RFC 4648) للتحقق بخطوتين للأدمن — من غير أي مكتبة خارجية.
// بيستخدم WebCrypto (HMAC-SHA1) المتاح في Cloudflare Workers.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** سرّ عشوائي بصيغة Base32 (32 حرف ≈ 160 بت) */
export function randomBase32(len = 32) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += B32[bytes[i] & 31];
  return out;
}

/** فك تشفير Base32 (بيتجاهل المسافات و= والأحرف الغلط) */
export function b32decode(s) {
  const src = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of src) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}

async function hmacSha1(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, msgBytes));
}

/** كود TOTP لعدّاد معيّن (6 أرقام) */
export async function totpCode(secret, counter) {
  const key = b32decode(secret);
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 0xff; c = Math.floor(c / 256); }
  const h = await hmacSha1(key, msg);
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return String(bin % 1e6).padStart(6, '0');
}

/** التحقق من الكود بمقارنة ثابتة الوقت + سماح بنافذة ±window خطوة (30 ثانية) */
export async function verifyTotp(secret, code, window = 1, step = 30) {
  const c = String(code || '').replace(/\D/g, '');
  if (!secret || c.length !== 6) return false;
  const counter = Math.floor(Date.now() / 1000 / step);
  let ok = false;
  for (let i = -window; i <= window; i++) {
    const expect = await totpCode(secret, counter + i);
    // مقارنة ثابتة الوقت (تجنّب تسريب معلومات بالتوقيت)
    let diff = 0;
    for (let k = 0; k < 6; k++) diff |= expect.charCodeAt(k) ^ c.charCodeAt(k);
    if (diff === 0) ok = true;
  }
  return ok;
}

/** رابط otpauth لإضافته في تطبيق المصادقة (Google Authenticator / Authy …) */
export function otpauthURL(secret, label, issuer = 'Ashhanli') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label || 'admin')}`
    + `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
