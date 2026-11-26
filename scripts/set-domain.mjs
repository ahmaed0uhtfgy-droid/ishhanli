// نقل الموقع لدومين مخصص: بيغيّر الدومين الأساسي (canonical, JSON-LD, og:url, sitemap, robots, llms) في كل الأماكن مرة واحدة.
// الاستخدام:  node scripts/set-domain.mjs https://yourdomain.com [--dry]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FILES = ['public/js/landing-content.js', 'public/robots.txt', 'public/llms.txt'];
export function normalizeOrigin(input) {
  let u; try { u = new URL(String(input)); } catch { throw new Error('الدومين مش صحيح. مثال: https://yourdomain.com'); }
  if (u.protocol !== 'https:') throw new Error('لازم https://');
  if (u.pathname !== '/' || u.search || u.hash) throw new Error('اكتب الدومين من غير مسار (مثال: https://yourdomain.com)');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(u.hostname)) throw new Error('اسم الدومين غير صحيح');
  return u.origin; // من غير سلاش في الآخر
}
export const currentOrigin = (src) => /export (?:const|let) LP_ORIGIN = '([^']+)'/.exec(src)?.[1];
export const rewrite = (text, from, to) => text.split(from).join(to);
/** landing-content.js: بنبدّل سطر LP_ORIGIN بس، ونضيف الدومين القديم لقايمة KNOWN_OLD (عشان نصوص المقالات القديمة تتبدّل وقت العرض) */
export const rewriteLanding = (text, from, to) => text.replace(`LP_ORIGIN = '${from}'`, `LP_ORIGIN = '${to}'`).replace(/const KNOWN_OLD = \[([^\]]*)\]/, (m, inner) => `const KNOWN_OLD = [${[...inner.split(',').map((x) => x.trim()).filter(Boolean), `'${from}'`].filter((x, i, a) => a.indexOf(x) === i).join(', ')}]`);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dry = process.argv.includes('--dry'); const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  try {
    if (!arg) throw new Error('اكتب الدومين الجديد. مثال: node scripts/set-domain.mjs https://yourdomain.com');
    const to = normalizeOrigin(arg); const from = currentOrigin(readFileSync('public/js/landing-content.js', 'utf8'));
    if (!from) throw new Error('مش لاقي LP_ORIGIN في public/js/landing-content.js');
    if (from === to) { console.log(`الدومين already ${to} — مفيش تغيير.`); process.exit(0); }
    for (const f of FILES) { const t = readFileSync(f, 'utf8'), n = t.split(from).length - 1; console.log(`${dry ? '(dry) ' : ''}${f}: ${n} موضع`); if (!dry && n) writeFileSync(f, f.endsWith('landing-content.js') ? rewriteLanding(t, from, to) : rewrite(t, from, to)); }
    console.log(`\n${dry ? 'تجربة فقط. ' : ''}${from} → ${to}\nمهم بعد النشر: 1) Firebase Console → Authentication → Settings → Authorized domains: ضيف ${new URL(to).hostname} (وإلا تسجيل الدخول هيفشل). 2) Search Console: ضيف الدومين الجديد وابعت ${to}/sitemap.xml. 3) في Cloudflare Pages ضيف الدومين المخصص (Custom domains).`);
  } catch (e) { console.error('✗', e.message); process.exit(1); }
}
