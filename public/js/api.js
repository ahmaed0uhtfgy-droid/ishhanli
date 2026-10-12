import { auth } from './firebase.js';

/** جلسة التحقق بخطوتين (TOTP) للأدمن — بتتخزن للتاب الحالي بس */
export const twofa = {
  get: () => { try { return sessionStorage.getItem('sf2fa') || ''; } catch { return ''; } },
  set: (t) => { try { sessionStorage.setItem('sf2fa', t || ''); } catch { /* ignore */ } },
  clear: () => { try { sessionStorage.removeItem('sf2fa'); } catch { /* ignore */ } },
};

/** استدعاء API السيرفر (Cloudflare Pages Functions + D1) مع Firebase ID Token */
export async function api(route, body = {}) {
  const user = auth.currentUser;
  if (!user) { const e = new Error('unauthenticated'); e.code = 'unauthenticated'; throw e; }
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await user.getIdToken()) };
  const t2 = twofa.get(); if (t2) headers['x-2fa'] = t2;
  let r;
  try {
    r = await fetch('/api/' + route, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch { const e = new Error('network'); e.code = 'network'; throw e; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error || 'server_error'); e.code = j.error || 'server_error'; e.status = r.status;
    if (e.code === 'account_not_active') window.dispatchEvent(new Event('app:profile-stale')); // حالة الحساب اتغيّرت (تجميد/حظر)
    if (e.code === 'totp_required') { twofa.clear(); window.dispatchEvent(new Event('app:2fa-required')); } // جلسة التحقق بخطوتين خلصت
    throw e;
  }
  return j;
}

export { poll } from './poll.js';
