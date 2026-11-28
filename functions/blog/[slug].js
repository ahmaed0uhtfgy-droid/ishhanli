// صفحة مقال: GET /blog/<slug> — HTML كامل من السيرفر (Article JSON-LD + FAQPage + breadcrumbs)
import { DEFAULTS, loadSettings } from '../_lib/logic.js';
import { PAGE_SEC, renderShell } from '../_lib/pages.js';
import { publishedBySlug, publishedList, articleContent, relatedFor } from '../_lib/blog.js';
import { cleanSite, SITE_DEFAULTS } from '../../public/js/landing-content.js';
import { notFound } from '../_lib/publicProfile.js';

export async function onRequest({ request, env, params }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 });
  if (!env.FIREBASE_SERVICE_ACCOUNT) return notFound();
  let slug = String(params?.slug || ''); try { slug = decodeURIComponent(slug); } catch { return notFound(); }
  let a = null, related = [], settings = DEFAULTS;
  try { a = await publishedBySlug(env, slug); if (a) { settings = await loadSettings(env); related = relatedFor(a, await publishedList(env), 4); } } catch (e) { console.error('blog_article_failed', e?.message || e); }
  if (!a) return notFound();
  const content = articleContent(a, related);
  const html = renderShell({ ...content, site: cleanSite(settings.site ?? SITE_DEFAULTS) });
  const csp = a.video ? PAGE_SEC['Content-Security-Policy'] + '; frame-src https://www.youtube-nocookie.com' : PAGE_SEC['Content-Security-Policy']; // فيديو يوتيوب (بدون كوكيز) بس لو المقال فيه فيديو
  return new Response(request.method === 'HEAD' ? null : html, { headers: { ...PAGE_SEC, 'Content-Security-Policy': csp, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600' } });
}
