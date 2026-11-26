// سيرفر اختبار محلي للـE2E والأداء: بيقدّم public/ + الـAPI الحقيقي (functions/api) فوق Firestore وهمي + Firebase Auth وهمي.
// مفيش اتصال بأي خدمة حقيقية، فمفيش خطر على بيانات الإنتاج. التشغيل: node test/e2e/server.mjs   (PORT=4173 افتراضي)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boot } from '../helpers/harness.mjs';

const ROOT = fileURLToPath(new URL('../../public/', import.meta.url));
const FAKE = fileURLToPath(new URL('./fake-firebase/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml' };

// نفس رؤوس _headers الحقيقية (الأمان + الكاش) على الصفحات الثابتة، عشان أي انتهاك CSP ونتايج الأداء تكون قريبة من الإنتاج
const HEADER_RULES = (() => { const rules = []; let cur = null; for (const l of readFileSync(join(ROOT, '_headers'), 'utf8').split('\n')) { if (/^\S/.test(l)) { cur = { pat: l.trim(), h: {} }; rules.push(cur); } else if (cur && l.includes(':')) { const i = l.indexOf(':'); cur.h[l.slice(0, i).trim()] = l.slice(i + 1).trim(); } } return rules; })();
const headersFor = (p) => { const out = {}; for (const r of HEADER_RULES) { const pre = r.pat.replace(/\*$/, ''); if (r.pat === '/*' || (r.pat.endsWith('*') ? p.startsWith(pre) : p === r.pat)) Object.assign(out, r.h); } return out; };
const GZ = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.xml', '.webmanifest']);

export async function startServer(port = Number(process.env.PORT) || 4173) {
  const h = await boot({ ALLOW_TEST_PAYMENTS: '1' });
  // إعدادات الاختبار: ضمان (escrow) بدل الدفع المباشر عشان مسار الدفع كامل يتجرّب، وتسجيل العميل تلقائي
  h.FS.put('settings/pricing', { v: JSON.stringify({ dcEnabled: false, autoApproveCustomers: true, testPayments: true, vehiclePricing: Object.fromEntries(['pickup', 'half_ton', 'jumbo', 'truck'].map((k) => [k, { base: 0, perKm: 0, minPrice: 0, kmFee: 0 }])) }) });
  const accounts = new Map(); // email -> { uid, password }
  const addAccount = (email, password, uid) => accounts.set(email.toLowerCase(), { uid, password });
  h.user('uid-admin', { role: 'admin', name: 'Admin E2E', phone: '01000000001' }); addAccount('admin@e2e.test', 'Admin#12345', 'uid-admin');

  const send = (res, code, body, type = 'application/json', extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra }); res.end(body); };
  const readBody = (req) => new Promise((ok) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = decodeURIComponent(url.pathname);
      if (p === '/__e2e/health') return send(res, 200, '{"ok":true}');
      if (p === '/__e2e/auth' && req.method === 'POST') {
        const { op, email = '', password = '' } = JSON.parse((await readBody(req)).toString() || '{}'); const key = String(email).trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(key)) return send(res, 400, '{"code":"auth/invalid-email"}');
        if (op === 'signup') { if (accounts.has(key)) return send(res, 400, '{"code":"auth/email-already-in-use"}'); const uid = 'u' + [...key].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36) + accounts.size; addAccount(key, password, uid); return send(res, 200, JSON.stringify({ uid, email: key })); }
        if (op === 'signin') { const a = accounts.get(key); if (!a || a.password !== password) return send(res, 400, '{"code":"auth/invalid-credential"}'); return send(res, 200, JSON.stringify({ uid: a.uid, email: key })); }
        return send(res, 400, '{"code":"auth/internal-error"}');
      }
      if (p === '/__e2e/token') return send(res, 200, JSON.stringify({ token: await h.idToken(url.searchParams.get('uid') || 'nobody', { email: url.searchParams.get('email') || undefined }) }));
      if (p === '/__e2e/seed' && req.method === 'POST') { // مستخدمين جاهزين لاختبار الأداء (k6): عملاء مفعّلين
        const n = Math.min(200, Number(url.searchParams.get('n')) || 20);
        for (let i = 0; i < n; i++) h.user(`perf-c${i}`, { role: 'customer', name: 'perf ' + i, phone: '0101' + String(1000000 + i) });
        return send(res, 200, JSON.stringify({ uids: Array.from({ length: n }, (_, i) => `perf-c${i}`) }));
      }
      if (p === '/__e2e/state' && req.method === 'GET') return send(res, 200, JSON.stringify({ users: h.FS.list('users').length, orders: h.FS.list('orders').length }));
      if (p.startsWith('/__fake/')) { const f = join(FAKE, normalize(p.slice(8)).replace(/^(\.\.[/\\])+/, '')); return send(res, 200, await readFile(f), 'text/javascript; charset=utf-8'); }
      if (p.startsWith('/api/')) {
        const { onRequest } = await import('../../functions/api/[[route]].js');
        const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
        const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
        const bg = []; const r = await onRequest({ request: new Request('http://x' + req.url, { method: req.method, headers, body }), env: h.env, params: { route: p.slice(5).split('/') }, waitUntil: (x) => bg.push(x) });
        const buf = Buffer.from(await r.arrayBuffer()); await Promise.all(bg);
        res.writeHead(r.status, Object.fromEntries(r.headers)); return res.end(buf);
      }
      // الصفحة الرئيسية "/" في الإنتاج بتتولّد من functions/index.js (SEO + CSS حرج + إعدادات الأدمن): بنشغّل نفس الكود هنا مع بديل لـenv.ASSETS
      if (p === '/' && ['GET', 'HEAD'].includes(req.method)) {
        const { onRequest: landing } = await import('../../functions/index.js');
        const assets = { fetch: async (rq) => { const ap = new URL(rq.url).pathname; const f = join(ROOT, normalize(ap === '/' ? '/index.html' : ap)); const buf = await readFile(f).catch(() => null); return buf ? new Response(buf, { status: 200, headers: { 'content-type': MIME[extname(f)] || 'application/octet-stream' } }) : new Response('nf', { status: 404 }); } };
        const r = await landing({ request: new Request('http://' + (req.headers.host || 'x') + req.url, { method: req.method }), env: { ...h.env, ASSETS: assets } });
        let body = Buffer.from(await r.arrayBuffer()); const extra = Object.fromEntries([...r.headers].filter(([k]) => !['content-length', 'content-encoding'].includes(k))); // رؤوس الـfunction نفسها فقط (من غير _headers) عشان نختبر إن الكود بيحطها بنفسه
        if (/gzip/.test(req.headers['accept-encoding'] || '')) { body = gzipSync(body); extra['Content-Encoding'] = 'gzip'; extra.Vary = 'Accept-Encoding'; }
        return send(res, r.status, body, 'text/html; charset=utf-8', extra);
      }
      // باقي الـFunctions (صفحات التسويق، /drivers، llms.txt، .well-known...) بنفس قاعدة Pages: ملف في functions/ = مسار
      if (['GET', 'HEAD'].includes(req.method) && !p.startsWith('/api/') && p !== '/') {
        const FN = fileURLToPath(new URL('../../functions/', import.meta.url)); const clean = normalize(p).replace(/^(\.\.[/\\])+/, '').replace(/\/+$/, '');
        let file = null, params = {};
        const cands = [join(FN, clean + '.js'), join(FN, clean, 'index.js')];
        for (const c of cands) if (!file && (await stat(c).catch(() => null))?.isFile()) file = c;
        const seg = clean.split('/').filter(Boolean); // مسار ديناميكي: functions/<dir>/[param].js
        if (!file && seg.length === 2) { const dir = join(FN, seg[0]); const dyn = (await import('node:fs/promises')).readdir ? (await (await import('node:fs/promises')).readdir(dir).catch(() => [])).find((n) => /^\[[a-zA-Z]+\]\.js$/.test(n)) : null; if (dyn) { file = join(dir, dyn); params = { [dyn.slice(1, -4)]: seg[1] }; } }
        if (file && !file.includes('_lib')) {
          const mod = await import(pathToFileURL(file).href);
          const assets = { fetch: async (rq) => { const ap = new URL(rq.url).pathname; const f = join(ROOT, normalize(ap)); const buf = await readFile(f).catch(() => null); return buf ? new Response(buf, { status: 200, headers: { 'content-type': MIME[extname(f)] || 'application/octet-stream' } }) : new Response('nf', { status: 404 }); } };
          const r = await mod.onRequest({ request: new Request('http://' + (req.headers.host || 'x') + req.url, { method: req.method }), env: { ...h.env, ASSETS: assets }, params });
          let body = Buffer.from(await r.arrayBuffer()); const extra = Object.fromEntries([...r.headers].filter(([k]) => !['content-length', 'content-encoding'].includes(k)));
          if (/gzip/.test(req.headers['accept-encoding'] || '')) { body = gzipSync(body); extra['Content-Encoding'] = 'gzip'; extra.Vary = 'Accept-Encoding'; }
          return send(res, r.status, body, r.headers.get('content-type') || 'text/html; charset=utf-8', extra);
        }
      }
      // ملفات ثابتة (مع fallback لـ index.html للمسارات المجهولة)
      let f = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!f.startsWith(ROOT)) return send(res, 403, 'forbidden', 'text/plain');
      let st = await stat(f).catch(() => null); if (st?.isDirectory()) { f = join(f, 'index.html'); st = await stat(f).catch(() => null); }
      if (!st) { const nf = join(ROOT, '404.html'); if (await stat(nf).catch(() => null)) return send(res, 404, await readFile(nf), 'text/html; charset=utf-8', headersFor('/404.html')); f = join(ROOT, 'index.html'); } // نفس سلوك Pages: لو فيه 404.html بيرجع 404 حقيقي بدل SPA fallback
      let body = await readFile(f); const extra = headersFor(p === '/' ? '/' : p), ext = extname(f);
      if (GZ.has(ext) && /gzip/.test(req.headers['accept-encoding'] || '')) { body = gzipSync(body); extra['Content-Encoding'] = 'gzip'; extra.Vary = 'Accept-Encoding'; }
      return send(res, 200, body, MIME[ext] || 'application/octet-stream', { ...extra, ...(extra['Cache-Control'] ? {} : {}) });
    } catch (e) { console.error('[e2e-server]', e); send(res, 500, JSON.stringify({ error: 'server_error', message: String(e?.message) })); }
  });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  return { server, port, h, close: () => new Promise((ok) => server.close(ok)) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const s = await startServer(); console.log(`e2e server ready on http://127.0.0.1:${s.port}`);
}
