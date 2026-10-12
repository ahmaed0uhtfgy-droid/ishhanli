// صفحات السواقين العامة (SEO) — HTML من السيرفر للزوار ومحركات البحث.
// الخصوصية أولاً: بنعرض بيانات آمنة بس (اسم مختصر، نوع العربية، مستوى الثقة، تقييم مجمّع، عدد الرحلات).
// ممنوع تماماً: الموبايل، الإيميل، الرقم القومي، المستندات، العناوين. والتفعيل بيد الأدمن (settings.publicProfiles).
import { F } from './db.js';
import { loadSettings } from './logic.js';
import { trustOf } from './trust.js';

const AR_VEHICLE = { car: 'سيارة ملاكي', van: 'فان', microbus: 'ميكروباص', minibus: 'ميني باص', pickup: 'ربع نقل', half_ton: 'نص نقل', truck: 'نقل ثقيل' };
const AR_LEVEL = { new: 'جديد', trusted: 'موثوق', pro: 'محترف', elite: 'نخبة' };
const AR_BADGE = { verified: 'موثّق', phone: 'موبايل مُؤكّد', top_rated: 'الأعلى تقييماً', reliable: 'منتظم' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** اسم مختصر للعرض العام: الاسم الأول + أول حرف من التالي. */
const maskName = (name) => {
  const p = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return 'سواق';
  return p.length > 1 ? `${p[0]} ${p[1][0]}.` : p[0];
};

/** يحوّل مستند users لكائن عام آمن (مفيش أي بيانات شخصية). */
export function driverPublic(u) {
  const tr = trustOf(u);
  return {
    id: u.uid,
    name: maskName(u.name),
    vehicle: AR_VEHICLE[u.vehicle_type] || u.vehicle_type || '',
    level: tr.level, levelAr: AR_LEVEL[tr.level] || tr.level,
    badges: tr.badges.map((b) => AR_BADGE[b]).filter(Boolean),
    rating: tr.stats.ratingAvg, ratings: tr.stats.ratingCount, trips: tr.stats.trips,
    since: u.created_at ? new Date(u.created_at).toISOString().slice(0, 10) : null,
  };
}

const isPublicDriver = (u) => !!u && u.role === 'driver' && u.status === 'active';

const STYLE = `:root{--bg:#0f1115;--card:#171a20;--fg:#eef1f5;--mut:#9aa4b2;--acc:#16a34a;--line:#262b33}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.7 system-ui,"Segoe UI",Tahoma,sans-serif}
a{color:var(--acc)}.wrap{max-width:760px;margin:0 auto;padding:28px 18px 60px}
header{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--line)}
h1{font-size:1.6rem;margin:.2em 0}h2{font-size:1.15rem;margin:1.2em 0 .4em}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin:14px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.stat{background:#12151b;border:1px solid var(--line);border-radius:12px;padding:12px;text-align:center}
.stat b{display:block;font-size:1.5rem}.stat span{color:var(--mut);font-size:.85rem}
.badge{display:inline-block;background:#12351f;color:#7ee2a8;border:1px solid #1f6b3a;border-radius:999px;padding:3px 10px;font-size:.8rem;margin:2px}
.mut{color:var(--mut)}.lvl{font-weight:700;color:#f5c451}
.btn{display:inline-block;background:var(--acc);color:#04210f;font-weight:700;text-decoration:none;padding:10px 18px;border-radius:10px;margin-top:10px}
ul.clean{list-style:none;padding:0;margin:0}ul.clean li{padding:10px 0;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:10px}
footer{color:var(--mut);font-size:.85rem;padding:20px 18px;text-align:center;border-top:1px solid var(--line);margin-top:30px}`;

const page = ({ title, desc, canonical, origin, body, jsonld }) => `<!doctype html>
<html lang="ar" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="profile"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(canonical)}">
<meta property="og:site_name" content="اشحنلي"><meta name="twitter:card" content="summary">
<link rel="icon" href="/favicon.svg">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ''}
<style>${STYLE}</style></head>
<body><header><a href="/" style="color:var(--fg);text-decoration:none;font-weight:800">اشحنلي</a></header>
<main class="wrap">${body}<p style="margin-top:22px"><a class="btn" href="${esc(origin)}/#/register">سجّل مجاناً في اشحنلي</a></p></main>
<footer>اشحنلي — نقل بضائع بسعر فوري وفلوس محجوزة لحد التسليم. البيانات المعروضة عامة ومختصرة.</footer>
</body></html>`;

const html = (body, status = 200, extra = {}) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=600', ...extra } });

export const notFound = () => html('<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>غير موجود</title><body style="font-family:system-ui;text-align:center;padding:60px;background:#0f1115;color:#eef1f5"><h1>الصفحة غير متوفرة</h1><p><a href="/" style="color:#16a34a">العودة للرئيسية</a></p></body></html>', 404, { 'Cache-Control': 'no-store' });

/** يجيب مستند السواق العام أو null (لو مش سواق مفعّل). */
export async function loadPublicDriver(env, id) {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(String(id || ''))) return null;
  const u = await F.get(env, `users/${id}`);
  return isPublicDriver(u) ? u : null;
}

/** صفحة ملف سواق واحدة. */
export function driverPage(env, u, origin) {
  const d = driverPublic(u);
  const url = `${origin}/drivers/${d.id}`;
  const title = `${d.name} — سواق ${d.vehicle || ''} على اشحنلي`.trim();
  const desc = `ملف عام للسواق ${d.name}: ${d.vehicle ? 'عربية ' + d.vehicle + '، ' : ''}التقييم ${d.rating || '—'}/5 من ${d.ratings} تقييم، و${d.trips} رحلة مكتملة على منصة اشحنلي.`;
  const body = `<h1>${esc(d.name)}</h1>
  <p class="mut">سواق على منصة اشحنلي${d.vehicle ? ' · ' + esc(d.vehicle) : ''}${d.since ? ' · عضو من ' + esc(d.since) : ''}</p>
  <p><span class="lvl">مستوى الثقة: ${esc(d.levelAr)}</span></p>
  ${d.badges.length ? `<p>${d.badges.map((b) => `<span class="badge">${esc(b)}</span>`).join('')}</p>` : ''}
  <div class="grid">
    <div class="stat"><b>${d.rating || '—'}</b><span>متوسط التقييم (${d.ratings})</span></div>
    <div class="stat"><b>${d.trips}</b><span>رحلة مكتملة</span></div>
    <div class="stat"><b>${esc(d.levelAr)}</b><span>مستوى الثقة</span></div>
  </div>
  <div class="card"><h2>عن هذا السواق</h2><p>${esc(d.name)} سواق على اشحنلي${d.vehicle ? ` بعربية ${esc(d.vehicle)}` : ''}. التقييم ${d.rating || '—'} من 5 بناءً على ${d.ratings} تقييم من عملاء حقيقيين، وإجمالي ${d.trips} رحلة مكتملة. الملف العام مش بيعرض أي بيانات تواصل — التعامل كله جوه المنصة.</p></div>
  <p class="mut">لطلب نقل مع سواق موثّق: <a href="${esc(origin)}/#/new">انشر طلبك</a> وشوف العروض.</p>`;
  const jsonld = {
    '@context': 'https://schema.org', '@type': 'Person', name: d.name, jobTitle: 'سواق طرود ونقل',
    url, knowsLanguage: 'ar', worksFor: { '@type': 'Organization', name: 'اشحنلي', url: origin },
    ...(d.ratings ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: d.rating, reviewCount: d.ratings, bestRating: 5 } } : {}),
  };
  return html(page({ title, desc, canonical: url, origin, body, jsonld }));
}

/** صفحة فهرس السواقين العامين (أعلى 60 حسب الرحلات المكتملة). */
export function driversIndexPage(drivers, origin) {
  const title = 'سواقين اشحنلي — أفضل السواقين الموثّقين';
  const desc = 'تعرف على سواقين اشحنلي الموثّقين ومستوى ثقتهم وتقييماتهم، واطلب نقل بضائعك بأمان مع فلوس محجوزة لحد التسليم.';
  const body = `<h1>سواقين اشحنلي</h1>
  <p class="mut">قائمة عامة بالسواقين المفعّلين (أعلى ${drivers.length} حسب الرحلات المكتملة). بدون أي بيانات تواصل.</p>
  <div class="card">${drivers.length ? `<ul class="clean">${drivers.map((d) => `<li><span><a href="/drivers/${esc(d.id)}">${esc(d.name)}</a>${d.vehicle ? ` <span class="mut">· ${esc(d.vehicle)}</span>` : ''}</span><span class="mut">★ ${d.rating || '—'} · ${d.trips} رحلة</span></li>`).join('')}</ul>` : '<p class="mut">مفيش سواقين معروضين حالياً.</p>'}</div>`;
  const jsonld = { '@context': 'https://schema.org', '@type': 'ItemList', name: title, itemListElement: drivers.map((d, i) => ({ '@type': 'ListItem', position: i + 1, url: `${origin}/drivers/${d.id}`, name: d.name })) };
  return html(page({ title, desc, canonical: `${origin}/drivers`, origin, body, jsonld }));
}

/** مثال: هل الصفحات العامة مفعّلة؟ */
export async function publicProfilesOn(env) { return (await loadSettings(env)).publicProfiles; }
