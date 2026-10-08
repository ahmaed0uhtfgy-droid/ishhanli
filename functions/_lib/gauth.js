// توكن OAuth لحساب خدمة Google (Firebase Admin). بيتستخدم لـ Firestore (قاعدة البيانات) ولـ FCM (الإشعارات).
// السر الوحيد على السيرفر: FIREBASE_SERVICE_ACCOUNT (محتوى ملف JSON كامل). بيتحفظ كـ Secret في كلود فلر مش في الكود.
import { HttpError } from './core.js';

const enc = new TextEncoder();
const b64u = (buf) => { const a = new Uint8Array(buf); let s = ''; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); };
const b64uStr = (s) => b64u(enc.encode(s));
const fromB64 = (s) => { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };

export function serviceAccount(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT) throw new HttpError(500, 'missing_service_account');
  try {
    const sa = typeof env.FIREBASE_SERVICE_ACCOUNT === 'string' ? JSON.parse(env.FIREBASE_SERVICE_ACCOUNT) : env.FIREBASE_SERVICE_ACCOUNT;
    if (!sa.client_email || !sa.private_key) throw 0;
    return sa;
  } catch { throw new HttpError(500, 'bad_service_account'); }
}

const cache = new Map(); // scope -> { token, exp }
export async function googleToken(env, scope) {
  const sa = serviceAccount(env), ck = `${sa.client_email}|${scope}`;
  const hit = cache.get(ck);
  if (hit && Date.now() < hit.exp - 60e3) return hit.token;
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = `${b64uStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64uStr(JSON.stringify({
    iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600,
  }))}`;
  const der = fromB64(sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(unsigned));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64u(sig)}` }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) { console.error('google_oauth_failed', r.status, j?.error); throw new HttpError(500, 'google_oauth_failed'); }
  cache.set(ck, { token: j.access_token, exp: Date.now() + j.expires_in * 1000 });
  return j.access_token;
}
export const resetTokenCache = () => cache.clear();
