// الصفحة الرئيسية "/" من السيرفر: HTML كامل للتصميم الفعّال (بإعدادات الأدمن) عشان جوجل ومحركات الذكاء الاصطناعي تقراه من غير JavaScript.
// لو Firestore مش متاح بنرسم بالقيم الافتراضية (الصفحة ما تقعش أبداً). التطبيق (SPA) بيكمّل شغله فوق نفس الصفحة.
import { DEFAULTS, loadSettings } from './_lib/logic.js';
import { buildLanding, injectShell } from './_lib/landing.js';

// CSS الحرج للصفحة الرئيسية: أساسيات app.css (لحد قسم الهيدر) + landing.css كاملة. لو أي حاجة اتغيّرت أو فشلت بنرجع للـ<link> العادي.
let cssCache = { at: 0, v: null };
async function criticalCss(env, request) {
  if (cssCache.v && Date.now() - cssCache.at < 300000) return cssCache.v;
  try {
    const get = async (path) => { const r = await env.ASSETS.fetch(new Request(new URL(path, request.url))); return r.ok ? await r.text() : ''; };
    const [app, landing] = await Promise.all([get('/css/app.css'), get('/css/landing.css')]);
    const cut = app.indexOf('/* ---------- الهيدر');
    let base = cut > 0 ? app.slice(0, cut) : '';
    // متغيّرات الوضع الليلي (بلوك واحد في app.css) لازم تكون في الـCSS الحرج، وإلا الليلي يومّض فاتح لحد ما app.css يوصل
    const d0 = app.indexOf('html[data-theme="dark"] {'), d1 = d0 >= 0 ? app.indexOf('}', d0) : -1;
    if (base && d0 > cut && d1 > d0 && d1 - d0 < 2500) base += '\n' + app.slice(d0, d1 + 1);
    cssCache = { at: Date.now(), v: base && base.length < 9000 && landing ? { base, landing } : null };
  } catch (e) { console.error('critical_css_failed', e?.message || e); cssCache = { at: Date.now(), v: null }; }
  return cssCache.v;
}

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
    return new Response(request.method === 'HEAD' ? null : injectShell(await res.text(), L, { css: isPv ? null : await criticalCss(env, request) }), { status: 200, headers: h });
  } catch (e) { console.error('landing_render_failed', e?.message || e); return env.ASSETS.fetch(request); }
}
