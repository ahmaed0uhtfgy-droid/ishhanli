// أساسيات مشتركة + التحقق من Firebase ID Token يدوياً (بدل admin.auth().verifyIdToken() اللي مش متاحة هنا).
// المبدأ: نفس اللي firebase-admin بيعمله جوّه — نتأكد من توقيع الـ JWT بمفاتيح Google العامة (JWK)،
// ونتحقق من aud/iss/exp يدوياً.
export class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

export const newId = () => { // بديل بسيط لـ crypto.randomUUID متاح في Workers، بنشيل الشرط ونقصّر
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  return [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
};

const b64urlToBuf = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s); const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
};
const jsonFromB64url = (s) => JSON.parse(new TextDecoder().decode(b64urlToBuf(s)));

let jwkCache = { at: 0, keys: {} };
async function getGoogleJwk(kid) {
  if (Date.now() - jwkCache.at > 3600e3 || !jwkCache.keys[kid]) {
    const res = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
    const { keys } = await res.json();
    jwkCache = { at: Date.now(), keys: Object.fromEntries(keys.map((k) => [k.kid, k])) };
  }
  return jwkCache.keys[kid];
}

/** يتحقق من الـ ID Token المبعوت من المتصفح (Authorization: Bearer ...) لمشروع Firebase المحدد */
export async function verifyIdToken(idToken, projectId) {
  try {
    const parts = String(idToken).split('.');
    if (parts.length !== 3) throw 0;
    const header = jsonFromB64url(parts[0]), payload = jsonFromB64url(parts[1]);
    if (header.alg !== 'RS256') throw 0;
    const jwk = await getGoogleJwk(header.kid);
    if (!jwk) throw 0;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBuf(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) throw 0;
    const now = Date.now() / 1000;
    if (payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}`) throw 0;
    if (payload.exp < now || payload.iat > now + 60 || !payload.sub) throw 0;
    return { uid: payload.sub, email: payload.email || '', phone_number: payload.phone_number || '' };
  } catch {
    throw new HttpError(401, 'invalid_token');
  }
}
