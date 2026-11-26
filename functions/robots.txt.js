// robots.txt ديناميكي: نفس محتوى public/robots.txt لكن سطر Sitemap بيتبع دومين الموقع الحالي (SITE_ORIGIN)
import { LP_ORIGIN } from '../public/js/landing-content.js';

const FALLBACK = 'User-agent: *\nAllow: /\nDisallow: /api/\n';
export async function onRequest({ request, env }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 });
  let body = FALLBACK;
  try { const r = await env.ASSETS.fetch(new Request(new URL('/robots.txt', request.url))); if (r.ok) body = await r.text(); } catch { /* نستخدم الافتراضي */ }
  body = body.replace(/^Sitemap:.*$/gim, '').trimEnd() + `\n\nSitemap: ${LP_ORIGIN}/sitemap.xml\n`;
  return new Response(request.method === 'HEAD' ? null : body, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=3600' } });
}
