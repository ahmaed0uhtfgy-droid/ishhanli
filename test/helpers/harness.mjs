// أداة مشتركة لاختبارات التكامل (Vitest): تشغّل الـAPI الحقيقي (functions/api/[[route]].js) فوق Firestore وهمي في الذاكرة،
// بتوكنات Firebase موقّعة بمفتاح RSA حقيقي. ولا بيلمس أي قاعدة بيانات حقيقية ولا إنترنت.
import { webcrypto as crypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { onRequest } from '../../functions/api/[[route]].js';
import { JWKS_URL } from '../../functions/_lib/core.js';
import { makeFirestore } from '../fake-firestore.mjs';

export const PROJECT = 'demo-ishhanli';
const b64u = (b) => Buffer.from(b).toString('base64url');
const rsa = () => crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);

export async function boot(extraEnv = {}) {
  const keys = await rsa();
  const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const sa = await rsa();
  const pem = '-----BEGIN PRIVATE KEY-----\n' + Buffer.from(await crypto.subtle.exportKey('pkcs8', sa.privateKey)).toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n';
  const FS = makeFirestore(PROJECT);
  const env = { FIREBASE_PROJECT_ID: PROJECT, FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'sa@demo.iam', private_key: pem, project_id: PROJECT }), SETTINGS_TTL_MS: '0', STAMP_TTL_MS: '0', PUSH_DISABLED: '1', METRICS_DISABLED: '1', API_RATE_DISABLED: '1', ...extraEnv };

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url === JWKS_URL) return Response.json({ keys: [jwk] });
    if (url.includes('router.project-osrm.org')) throw new Error('offline');
    if (url.startsWith('https://firestore.googleapis.com/')) { const r = await FS.handle(init?.method || 'GET', url, init?.body ? JSON.parse(init.body) : null); return new Response(JSON.stringify(r.body), { status: r.http }); }
    if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'fake', expires_in: 3600 });
    throw new Error('network blocked in tests: ' + url);
  };

  async function sign(payload, { alg = 'RS256', kid = 'k1', key = keys.privateKey } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const h = b64u(JSON.stringify({ alg, kid, typ: 'JWT' }));
    const p = b64u(JSON.stringify({ aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, iat: now, exp: now + 3600, ...payload }));
    const sig = alg === 'none' ? '' : b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, Buffer.from(`${h}.${p}`)));
    return `${h}.${p}.${sig}`;
  }
  const idToken = (uid, extra = {}) => sign({ sub: uid, email: `${uid}@x.com`, ...extra });

  async function raw(route, { method = 'POST', token, body, headers = {}, e = env } = {}) {
    const h = { ...headers }; if (token) h.Authorization = 'Bearer ' + token;
    const req = new Request(`https://x.test/api/${route}`, { method, headers: h, body: method === 'GET' || method === 'HEAD' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body ?? {})) });
    const bg = [];
    const res = await onRequest({ request: req, env: e, params: { route: route.split('/') }, waitUntil: (p) => bg.push(p) });
    const text = await res.text(); await Promise.all(bg);
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  async function call(uid, route, body = {}) { const r = await raw(route, { token: await idToken(uid), body }); return { ...(r.json || {}), status: r.status }; }
  const user = (uid, o = {}) => FS.put(`users/${uid}`, { uid, role: 'customer', status: 'active', name: uid, phone: '010' + String(Math.abs([...uid].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 1e8).padStart(8, '0'), rating_sum: 0, rating_count: 0, completed_orders: 0, cancel_count: 0, created_at: Date.now(), ...o });
  const restore = () => { globalThis.fetch = realFetch; };
  return { FS, env, call, raw, idToken, sign, user, restore, keys };
}

/** كل أسماء مسارات الـAPI (من الكود نفسه) — عشان مصفوفات الصلاحيات والـfuzz تغطي أي مسار جديد تلقائياً */
export function routeNames() {
  const src = readFileSync(new URL('../../functions/api/[[route]].js', import.meta.url), 'utf8');
  const start = src.indexOf('const ROUTES'); const body = src.slice(start);
  const names = new Set();
  for (const m of body.matchAll(/^  async (?:'([a-zA-Z0-9/_-]+)'|([a-zA-Z0-9_]+))\(/gm)) names.add(m[1] || m[2]);
  return [...names];
}
