// الصفحة الرئيسية "/" من السيرفر: HTML كامل للتصميم الفعّال (بإعدادات الأدمن) عشان جوجل ومحركات الذكاء الاصطناعي تقراه من غير JavaScript.
// لو Firestore مش متاح بنرسم بالقيم الافتراضية (الصفحة ما تقعش أبداً). التطبيق (SPA) بيكمّل شغله فوق نفس الصفحة.
import { DEFAULTS, loadSettings } from './_lib/logic.js';
import { buildLanding, injectShell } from './_lib/landing.js';

export async function onRequest({ request, env }) {
  const res = await env.ASSETS.fetch(request);
  if ((request.method !== 'GET' && request.method !== 'HEAD') || !res.ok || !(res.headers.get('content-type') || '').includes('text/html')) return res;
  let settings = DEFAULTS;
  try { if (env.FIREBASE_SERVICE_ACCOUNT) settings = await loadSettings(env); } catch (e) { console.error('landing_settings_failed', e?.message || e); }
  try {
    const pv = new URL(request.url).searchParams.get('preview'), isPv = pv === 'a' || pv === 'b'; // معاينة تصميم من لوحة الأدمن: /?preview=a أو b (من غير فهرسة ولا كاش)
    const L = buildLanding({ settings, site: isPv ? { ...settings.site, design: pv } : settings.site, company: settings.company, env });
    if (isPv) L.head = L.head.replace('index,follow,max-image-preview:large,max-snippet:-1', 'noindex,nofollow');
    const h = new Headers(res.headers);
    h.set('Content-Type', 'text/html; charset=utf-8'); h.set('Cache-Control', isPv ? 'no-store' : 'public, max-age=0, s-maxage=60, stale-while-revalidate=300'); h.delete('Content-Length'); h.delete('ETag');
    return new Response(request.method === 'HEAD' ? null : injectShell(await res.text(), L), { status: 200, headers: h });
  } catch (e) { console.error('landing_render_failed', e?.message || e); return env.ASSETS.fetch(request); }
}
