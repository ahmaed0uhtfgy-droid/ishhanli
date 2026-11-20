// خريطة الموقع الديناميكية: GET /sitemap.xml — الصفحات الأساسية + كل طرق النقل + (لو الصفحات العامة للسواقين مفعّلة) السواقين.
// ديناميكية عشان أي صفحة جديدة تتضاف لوحدها من غير تعديل يدوي، ومن غير ملف ثابت يتقادم.
import { F } from './_lib/db.js';
import { loadSettings } from './_lib/logic.js';
import { PAGE_SEC, PAGE_PATHS } from './_lib/pages.js';
import { ROUTES, routePath, CONTENT_LASTMOD } from './_lib/routes.js';
import { LP_ORIGIN } from '../public/js/landing-content.js';
import { publishedList, blogPath } from './_lib/blog.js';

const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
export const buildSitemap = (urls) => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${xml(LP_ORIGIN + u.path)}</loc><lastmod>${u.lastmod || CONTENT_LASTMOD}</lastmod><changefreq>${u.changefreq || 'monthly'}</changefreq><priority>${u.priority ?? 0.6}</priority></url>`).join('\n')}\n</urlset>\n`;

export async function onRequest({ request, env }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 });
  const urls = [{ path: '/', priority: 1.0, changefreq: 'weekly' }, ...Object.values(PAGE_PATHS).map((p) => ({ path: p, priority: p === '/for-drivers' || p === '/for-companies' ? 0.7 : 0.8 })), { path: '/routes', priority: 0.8 }, ...ROUTES.map((r) => ({ path: routePath(r), priority: 0.6 }))];
  try {
    if (env.FIREBASE_SERVICE_ACCOUNT) {
      const s = await loadSettings(env);
      if (s.publicProfiles) {
        urls.push({ path: '/drivers', priority: 0.6, changefreq: 'weekly' });
        const rows = await F.query(env, 'users', { eq: { role: 'driver', status: 'active' }, limit: 300 });
        rows.sort((a, b) => (b.completed_orders || 0) - (a.completed_orders || 0) || String(a.uid || a.id).localeCompare(String(b.uid || b.id))).slice(0, 60).forEach((u) => urls.push({ path: `/drivers/${u.uid || u.id}`, priority: 0.4, changefreq: 'weekly' }));
      }
    }
  } catch (e) { console.error('sitemap_drivers_failed', e?.message || e); }
  try { // المقالات المنشورة (لو فيه)
    if (env.FIREBASE_SERVICE_ACCOUNT) {
      const arts = await publishedList(env);
      if (arts.length) { urls.push({ path: '/blog', priority: 0.7, changefreq: 'daily', lastmod: new Date(arts[0].updatedAt || arts[0].publishedAt).toISOString().slice(0, 10) }); for (const a of arts.slice(0, 500)) urls.push({ path: blogPath(a), priority: 0.6, changefreq: 'monthly', lastmod: new Date(a.updatedAt || a.publishedAt).toISOString().slice(0, 10) }); }
    }
  } catch (e) { console.error('sitemap_blog_failed', e?.message || e); } // السواقين اختياريين: لو فشلوا نرجّع الباقي
  return new Response(request.method === 'HEAD' ? null : buildSitemap(urls), { headers: { ...PAGE_SEC, 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400' } });
}
