// صفحة ملف سواق عامة: GET /drivers/:id — HTML من السيرفر للـSEO. بتشتغل بس لو الأدمن فعّل settings.publicProfiles.
import { loadSettings } from '../_lib/logic.js';
import { loadPublicDriver, driverPage, notFound } from '../_lib/publicProfile.js';

export async function onRequest({ request, env, params }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 });
  const origin = new URL(request.url).origin;
  try {
    if (!env.FIREBASE_SERVICE_ACCOUNT) throw new Error('no_service_account');
    if (!(await loadSettings(env)).publicProfiles) return Response.redirect(`${origin}/`, 302);
    const u = await loadPublicDriver(env, [].concat(params.id || []).join('/'));
    if (!u) return notFound();
    return driverPage(env, u, origin);
  } catch (e) {
    console.error('driver_page_failed', e?.message || e);
    return notFound();
  }
}
