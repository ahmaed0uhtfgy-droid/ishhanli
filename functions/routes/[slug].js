// صفحة طريق نقل: GET /routes/cairo-to-alexandria — HTML كامل من السيرفر للـSEO (الأسعار من إعدادات الأدمن الحالية)
import { DEFAULTS, loadSettings } from '../_lib/logic.js';
import { PAGE_SEC, renderShell } from '../_lib/pages.js';
import { findRoute, routeContent } from '../_lib/routes.js';
import { cleanSite, SITE_DEFAULTS } from '../../public/js/landing-content.js';
import { notFound } from '../_lib/publicProfile.js';

export async function onRequest({ request, env, params }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 });
  const r = findRoute(params?.slug);
  if (!r) return notFound();
  let settings = DEFAULTS;
  try { if (env.FIREBASE_SERVICE_ACCOUNT) settings = await loadSettings(env); } catch (e) { console.error('route_settings_failed', e?.message || e); }
  const html = renderShell({ ...routeContent(settings, r), site: cleanSite(settings.site ?? SITE_DEFAULTS) });
  return new Response(request.method === 'HEAD' ? null : html, { headers: { ...PAGE_SEC, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600' } });
}
