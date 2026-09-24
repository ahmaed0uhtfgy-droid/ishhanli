// توليد Google OAuth2 access token من حساب خدمة (Service Account) باستخدام Web Crypto —
// شغال جوه Cloudflare Workers من غير أي مكتبة Node (firebase-admin/google-auth-library مش متاحين هنا).
// الفكرة: نبني JWT موقّع بالمفتاح الخاص (RS256)، ونبادله بـ access token من Google.
const b64url = (buf) => {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new TextEncoder().encode(buf);
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64ToBuf = (s) => { const bin = atob(s); const buf = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i); return buf.buffer; };

let cachedKey = null; // { pem, cryptoKey } — استيراد المفتاح الخاص عملية مكلفة، بنعمله مرة واحدة لكل isolate
async function importPrivateKey(pem) {
  if (cachedKey && cachedKey.pem === pem) return cachedKey.cryptoKey;
  const clean = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '');
  const der = b64ToBuf(clean);
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  cachedKey = { pem, cryptoKey: key };
  return key;
}

const tokenCache = new Map(); // scope-string -> { token, exp }

/** sa = { client_email, private_key, project_id } (المحتوى الخام لملف الـ JSON بتاع Service Account) */
export async function getAccessToken(sa, scopes) {
  const scopeKey = scopes.join(' ');
  const cached = tokenCache.get(scopeKey);
  if (cached && cached.exp - Date.now() > 60000) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = { iss: sa.client_email, scope: scopeKey, aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const key = await importPrivateKey(sa.private_key);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${b64url(sig)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  const json = await res.json();
  if (!res.ok) throw new Error('gcp_auth_failed: ' + JSON.stringify(json));
  tokenCache.set(scopeKey, { token: json.access_token, exp: Date.now() + json.expires_in * 1000 });
  return json.access_token;
}

export const SCOPES = {
  firestore: ['https://www.googleapis.com/auth/datastore'],
  messaging: ['https://www.googleapis.com/auth/firebase.messaging'],
};
