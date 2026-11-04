// توثيق ملكية الموقع في Google Search Console (ملف HTML). بيتقدّم من function عشان Cloudflare Pages ما يحوّلش الرابط (.html -> بدون امتداد) فيرجع 200 مباشرة.
export function onRequest() {
  return new Response('google-site-verification: google5463541af54b53ef.html', { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
}
