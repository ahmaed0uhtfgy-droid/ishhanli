// فهرس السواقين العام: GET /drivers — HTML من السيرفر للـSEO. بيتفعّل مع settings.publicProfiles.
import { F } from '../_lib/db.js';
import { loadSettings } from '../_lib/logic.js';
import { driversIndexPage, driverPublic, notFound } from '../_lib/publicProfile.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 });
  const origin = new URL(request.url).origin;
  try {
    if (!env.FIREBASE_SERVICE_ACCOUNT) throw new Error('no_service_account');
    if (!(await loadSettings(env)).publicProfiles) return Response.redirect(`${origin}/`, 302);
    // مساواة فقط (بدون فهارس مركّبة)؛ الترتيب في الذاكرة. سقف 300 قراءة، وبنعرض أعلى 60 حسب الرحلات.
    const rows = await F.query(env, 'users', { eq: { role: 'driver', status: 'active' }, limit: 300 });
    const drivers = rows.map((u) => ({ d: driverPublic(u), t: u.completed_orders || 0 }))
      .sort((a, b) => (b.t - a.t) || String(a.d.id).localeCompare(String(b.d.id))).slice(0, 60).map((x) => x.d);
    return driversIndexPage(drivers, origin);
  } catch (e) {
    console.error('drivers_index_failed', e?.message || e);
    return notFound();
  }
}
