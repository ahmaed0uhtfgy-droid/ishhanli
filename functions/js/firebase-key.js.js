// مفتاح Firebase للويب (apiKey) بيتقدّم من هنا مش من ملف في المستودع، فمايتكتبش في GitHub ومايتنبّهش عليه فحص الأسرار.
// ملحوظة: أي مفتاح ويب لازم يوصل للمتصفح وقت التشغيل (Firebase Auth بيحتاجه) — الحماية الحقيقية هي تقييده في Google Cloud Console بدومين الموقع وخدمات Firebase بس.
// الإعداد: Cloudflare Pages → Settings → Variables and Secrets → FIREBASE_WEB_API_KEY (Production + Preview).
export function onRequest({ env }) {
  const key = String(env.FIREBASE_WEB_API_KEY || '').trim();
  const ok = /^[A-Za-z0-9_-]{20,80}$/.test(key); // شكل مفتاح جوجل: حروف وأرقام و_ و- بس (بيمنع أي حقن في الـJS)
  return new Response(`export const apiKey = ${JSON.stringify(ok ? key : '')};\n`, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' } });
}
