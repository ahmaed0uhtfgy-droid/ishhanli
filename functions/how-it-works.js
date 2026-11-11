// صفحة السيو: /how-it-works (HTML كامل من السيرفر من حقائق النظام)
import { DEFAULTS, loadSettings } from './_lib/logic.js';
import { renderPage, PAGE_SEC } from './_lib/pages.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 });
  let settings = DEFAULTS;
  try { if (env.FIREBASE_SERVICE_ACCOUNT) settings = await loadSettings(env); } catch (e) { console.error('page_settings_failed', e?.message || e); }
  const html = renderPage('how', { settings, site: settings.site, company: settings.company, env });
  return new Response(request.method === 'HEAD' ? null : html, { headers: { ...PAGE_SEC, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=600' } });
}
