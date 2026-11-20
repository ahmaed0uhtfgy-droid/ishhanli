// رؤوس الأمان العامة لردود الـFunctions. السبب: ملف public/_headers بيتطبّق على الملفات الثابتة بس، مش على ردود Pages Functions
// (توثيق Cloudflare). الصفحة الرئيسية "/" هي مدخل التطبيق كله (SPA) وبتتولّد من function، فلازم الرؤوس تتحط في الكود.
// مصدر الحقيقة = القاعدة /* في public/_headers؛ واختبار (test/unit/headers-sync.spec.mjs) بيفشل لو الاتنين اختلفوا.
export const SECURITY_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(self), camera=(self), microphone=(), payment=()",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' https://www.gstatic.com https://apis.google.com https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https://*.googleapis.com https://router.project-osrm.org https://nominatim.openstreetmap.org; frame-src https://*.firebaseapp.com https://accounts.google.com https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
});

/** بيرجّع نسخة من الرد فيها رؤوس الأمان الناقصة (ما بيمسحش رؤوس موجودة أصلاً) */
export function withSecurityHeaders(res) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!h.has(k)) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
