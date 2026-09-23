// أساسيات مشتركة: أخطاء HTTP + التحقق من Firebase ID Token (Auth فقط — قاعدة البيانات على Cloudflare D1)
const enc = new TextEncoder();
const dec = new TextDecoder();

export class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
export const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);

const fromB64u = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); s += '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let jwks = { keys: null, exp: 0 };

async function verifyKey(kid) {
  if (!jwks.keys || Date.now() > jwks.exp || !jwks.keys[kid]) {
    const r = await fetch(JWKS_URL);
    if (!r.ok) throw new HttpError(500, 'jwks_fetch_failed');
    const { keys } = await r.json();
    const map = {};
    for (const k of keys) map[k.kid] = await crypto.subtle.importKey('jwk', k, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    jwks = { keys: map, exp: Date.now() + 3600e3 };
  }
  return jwks.keys[kid];
}

/** يتحقق من توقيع الـ ID Token ومن (aud, iss, exp). مفيش حاجة سرية مطلوبة: المفاتيح عامة. */
export async function verifyIdToken(idToken, projectId) {
  try {
    const [h, p, s] = String(idToken).split('.');
    if (!h || !p || !s) throw 0;
    const header = JSON.parse(dec.decode(fromB64u(h)));
    const payload = JSON.parse(dec.decode(fromB64u(p)));
    if (header.alg !== 'RS256') throw 0;
    const key = await verifyKey(header.kid);
    if (!key) throw 0;
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64u(s), enc.encode(`${h}.${p}`));
    const now = Math.floor(Date.now() / 1000);
    if (!ok || payload.exp <= now || payload.iat > now + 300 || payload.aud !== projectId
      || payload.iss !== `https://securetoken.google.com/${projectId}` || !payload.sub) throw 0;
    return { uid: payload.sub, email: payload.email || '', phone_number: payload.phone_number || '' };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(401, 'invalid_token');
  }
}
