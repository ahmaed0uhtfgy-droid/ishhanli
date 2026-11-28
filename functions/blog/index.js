// فهرس المدونة: GET /blog — HTML كامل من السيرفر للـSEO (المقالات المنشورة فقط، بكاش قصير)
import { DEFAULTS } from '../_lib/logic.js';
import { PAGE_SEC, renderShell } from '../_lib/pages.js';
import { publishedList, indexContent } from '../_lib/blog.js';
import { notFound } from '../_lib/publicProfile.js';
import { cleanSite, SITE_DEFAULTS } from '../../public/js/landing-content.js';
import { loadSettings } from '../_lib/logic.js';

export async function onRequest({ request, env }) {
  const rawPage = new URL(request.url).searchParams.get('page'), page = rawPage === null ? 1 : Number(rawPage);
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 });
  let list = [], settings = DEFAULTS;
  try { if (env.FIREBASE_SERVICE_ACCOUNT) { settings = await loadSettings(env); list = await publishedList(env); } } catch (e) { console.error('blog_index_failed', e?.message || e); }
  if (!Number.isInteger(page) || page < 1) return notFound();
  const content = indexContent(list, page);
  if (page > content.pages) return notFound(); // صفحة ترقيم مش موجودة = 404 حقيقي مش صفحة فاضية
  let html = renderShell({ ...content, site: cleanSite(settings.site ?? SITE_DEFAULTS) });
  if (!list.length) html = html.replace('content="index,follow,max-image-preview:large"', 'content="noindex,follow"'); // صفحة فاضية: ما تتفهرسش لحد ما يبقى فيها مقالات
  return new Response(request.method === 'HEAD' ? null : html, { headers: { ...PAGE_SEC, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600' } });
}
