import { auth } from './firebase.js';

/** استدعاء API السيرفر (Cloudflare Pages Functions + D1) مع Firebase ID Token */
export async function api(route, body = {}) {
  const user = auth.currentUser;
  if (!user) { const e = new Error('unauthenticated'); e.code = 'unauthenticated'; throw e; }
  let r;
  try {
    r = await fetch('/api/' + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await user.getIdToken()) },
      body: JSON.stringify(body),
    });
  } catch { const e = new Error('network'); e.code = 'network'; throw e; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error || 'server_error'); e.code = j.error || 'server_error'; e.status = r.status; e.detail = j.detail || null;
    if (e.code === 'account_not_active') window.dispatchEvent(new Event('app:profile-stale')); // حالة الحساب اتغيّرت (تجميد/حظر)
    throw e;
  }
  return j;
}

export { poll } from './poll.js';
