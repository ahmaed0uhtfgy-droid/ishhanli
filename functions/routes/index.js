// فهرس طرق النقل: GET /routes — HTML كامل من السيرفر للـSEO
import { DEFAULTS, loadSettings } from '../_lib/logic.js';
import { PAGE_SEC, renderShell } from '../_lib/pages.js';
import { routesIndexContent } from '../_lib/routes.js';
import { cleanSite, SITE_DEFAULTS } from '../../public/js/landing-content.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 });
  let settings = DEFAULTS;
  try { if (env.FIREBASE_SERVICE_ACCOUNT) settings = await loadSettings(env); } catch (e) { console.error('routes_settings_failed', e?.message || e); }
  const html = renderShell({ ...routesIndexContent(settings), site: cleanSite(settings.site ?? SITE_DEFAULTS) });
  return new Response(request.method === 'HEAD' ? null : html, { headers: { ...PAGE_SEC, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600' } });
}
