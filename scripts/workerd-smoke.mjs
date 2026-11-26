// فحص دخان على بيئة Cloudflare الحقيقية (workerd عبر `wrangler pages dev`): نفس الـFunctions اللي هتتنشر.
// باقي الاختبارات بتشتغل على Node، فده بيمسك أي حاجة مش متوافقة مع runtime الإنتاج. من غير أسرار ولا Firestore.
import { spawn } from 'node:child_process';
import { SECURITY_HEADERS } from '../functions/_lib/secHeaders.js';

const PORT = Number(process.env.WORKERD_PORT) || 8791, base = `http://127.0.0.1:${PORT}`;
const child = spawn('npx', ['wrangler', 'pages', 'dev', '--port', String(PORT), '--ip', '127.0.0.1'], { detached: true, stdio: 'ignore', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
const stop = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } };
process.on('exit', stop); process.on('SIGINT', () => { stop(); process.exit(130); });

let fails = 0; const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) fails++; };
const get = async (p, init) => fetch(base + p, { redirect: 'manual', ...init });

async function ready() { for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/api/health')).ok) return true; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 2000)); } return false; }

if (!(await ready())) { console.error('✗ wrangler pages dev ما اشتغلش خلال دقيقتين'); stop(); process.exit(1); }
try {
  const home = await get('/', { headers: { 'accept-encoding': 'identity' } }); const html = await home.text();
  check(home.status === 200, '/ بيرجع 200'); check(/text\/html/.test(home.headers.get('content-type') || ''), '/ HTML');
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) check(home.headers.get(k) === v, `/ فيه ${k}`);
  check(/<meta name="description"/.test(html) && /rel="canonical"/.test(html), '/ فيه meta description وcanonical (SSR شغّال)');
  for (const p of ['/pricing', '/how-it-works', '/vehicles', '/for-drivers', '/for-companies']) { const r = await get(p); check(r.status === 200 && !!r.headers.get('content-security-policy') && r.headers.get('x-frame-options') === 'DENY', `${p} 200 + CSP + X-Frame-Options`); }
  { const r = await get('/drivers'); check([200, 302, 404].includes(r.status) && !!r.headers.get('content-security-policy') && r.headers.get('x-frame-options') === 'DENY', `/drivers (${r.status}، مقفول من غير secret/إعداد) + CSP + X-Frame-Options`); }
  { const r = await get('/routes'); const b = await r.text(); check(r.status === 200 && (b.match(/href="\/routes\//g) || []).length >= 30 && !!r.headers.get('content-security-policy'), '/routes فهرس الطرق 200 + روابط الطرق + CSP'); }
  { const r = await get('/routes/cairo-to-alexandria'); const b = await r.text(); check(r.status === 200 && /"@type":"Service"/.test(b) && /"@type":"FAQPage"/.test(b) && /<h1[^>]*>[^<]*القاهرة[^<]*الإسكندرية/.test(b), '/routes/cairo-to-alexandria 200 + Service + FAQPage + H1'); }
  { const r = await get('/routes/no-such-route'); check(r.status === 404, '/routes/<مجهول> → 404'); }
  { const r = await get('/sitemap.xml'); const b = await r.text(); check(r.status === 200 && /application\/xml/.test(r.headers.get('content-type') || '') && (b.match(/<loc>/g) || []).length >= 40, `/sitemap.xml XML فيه ${(b.match(/<loc>/g) || []).length} رابط`); }
  const h = await get('/api/health'); const hj = await h.json(); check(h.status === 200 && h.headers.get('cache-control') === 'no-store' && h.headers.get('x-content-type-options') === 'nosniff' && 'ok' in hj, '/api/health JSON + no-store + nosniff');
  const nf = await get('/api/no-such-route', { method: 'POST' }); check([404, 500].includes(nf.status), `مسار API مجهول مش بيعلّق (${nf.status})`);
  const css = await get('/css/app.css'); check(css.status === 200 && css.headers.get('cache-control') === 'no-cache', '/css/app.css بيتقدّم مع Cache-Control: no-cache من _headers');
  const lf = await get('/vendor/leaflet-1.9.4/leaflet.js'); check(lf.status === 200, 'Leaflet المستضاف متاح');
  for (const p of ['/definitely-not-here.png', '/no-such-page', '/.env', '/wp-admin/']) { const r = await get(p); const b = await r.text(); check(r.status === 404 && /الصفحة غير موجودة/.test(b) && /noindex/.test(b), `${p} → 404 حقيقي (مش 200)`); }
} catch (e) { console.error('✗ استثناء:', e.message); fails++; }
stop(); console.log(fails ? `\nFAILED: ${fails}` : '\nALL OK (workerd)'); process.exit(fails ? 1 : 0);
