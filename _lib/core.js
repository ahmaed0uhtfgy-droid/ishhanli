// أساسيات مشتركة + التحقق من Firebase ID Token يدوياً (بدل admin.auth().verifyIdToken() اللي مش متاحة هنا).
// المبدأ: نفس اللي firebase-admin بيعمله جوّه — نتأكد من توقيع الـ JWT بمفاتيح Google العامة (JWK)،
// ونتحقق من aud/iss/exp يدوياً.
export class HttpError extends Error {
  constructor(status, code, detail) { super(code); this.status = status; this.code = code; this.detail = detail; }
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
  let parts, header, payload;
  try {
    parts = String(idToken).split('.');
    if (parts.length !== 3) throw new HttpError(401, 'invalid_token', 'token is not a JWT (3 parts expected)');
    header = jsonFromB64url(parts[0]); payload = jsonFromB64url(parts[1]);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(401, 'invalid_token', 'could not decode token header/payload: ' + e.message);
  }
  if (header.alg !== 'RS256') throw new HttpError(401, 'invalid_token', `unexpected alg "${header.alg}", expected RS256`);
  let jwk;
  try { jwk = await getGoogleJwk(header.kid); } catch (e) { throw new HttpError(401, 'invalid_token', 'could not fetch Google public keys: ' + e.message); }
  if (!jwk) throw new HttpError(401, 'invalid_token', `no matching Google public key for kid "${header.kid}" (token may be stale — try logging out/in)`);
  try {
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBuf(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) throw new HttpError(401, 'invalid_token', 'signature verification failed');
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(401, 'invalid_token', 'signature verification error: ' + e.message);
  }
  const now = Date.now() / 1000;
  // السبب الأشهر لفشل التوكن: project_id في ملف الـ Service Account مش نفسه projectId في config.js
  if (payload.aud !== projectId) throw new HttpError(401, 'invalid_token', `project mismatch: token aud="${payload.aud}" but server project_id="${projectId}" — make sure the Service Account JSON and public/js/config.js belong to the SAME Firebase project`);
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new HttpError(401, 'invalid_token', `unexpected issuer "${payload.iss}"`);
  if (payload.exp < now) throw new HttpError(401, 'invalid_token', 'token expired — try logging out/in');
  if (payload.iat > now + 60) throw new HttpError(401, 'invalid_token', 'token issued in the future (check server clock/timezone)');
  if (!payload.sub) throw new HttpError(401, 'invalid_token', 'token missing sub claim');
  return { uid: payload.sub, email: payload.email || '', phone_number: payload.phone_number || '' };
}
