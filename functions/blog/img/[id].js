// صورة مقال عامة: GET /blog/img/<id> — ملفات نوع blog فقط (اللي الأدمن رفعها)
import { PAGE_SEC } from '../../_lib/pages.js';
import { blogImage } from '../../_lib/blog.js';
import { notFound } from '../../_lib/publicProfile.js';

export async function onRequest({ request, env, params }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 });
  if (!env.FIREBASE_SERVICE_ACCOUNT) return notFound();
  let res = null; try { res = await blogImage(env, params?.id); } catch (e) { console.error('blog_img_failed', e?.message || e); }
  if (!res) return notFound();
  const h = new Headers(res.headers); h.set('X-Frame-Options', PAGE_SEC['X-Frame-Options']);
  return new Response(request.method === 'HEAD' ? null : res.body, { headers: h });
}
