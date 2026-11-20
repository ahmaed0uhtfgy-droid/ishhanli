// صفحات طرق النقل بين المدن (SEO للبحث الطويل: "نقل بضائع من القاهرة إلى الإسكندرية").
// كل رقم في الصفحة (المسافة، الأسعار) بيتحسب من نفس مصدر الحاسبة والسيرفر: المدن وpriceFromKm في public/js/estimate.js + إعدادات الأدمن الحالية،
// فمفيش أرقام ثابتة بتتقادم، والصفحة بتتحدّث لوحدها لو الأدمن غيّر الأسعار.
import { CITIES, straightKm, priceFromKm, VEHICLE_KEYS } from '../../public/js/estimate.js';
import { LP_ORIGIN } from '../../public/js/landing-content.js';
import { esc } from './landing.js';

export const CONTENT_LASTMOD = '2026-11-16'; // آخر تاريخ اتغيّر فيه محتوى الصفحات الثابتة (بيتحدّث يدوي مع أي تعديل محتوى)
export const HUBS = ['cairo', 'alex']; // كل الأزواج اللي فيها القاهرة أو الإسكندرية = 35 صفحة (صفحة واحدة لكل زوج، بتغطي الاتجاهين)
const VEH = { pickup: 'ربع نقل', half_ton: 'نص نقل', jumbo: 'جامبو', truck: 'نقل ثقيل' };
const slugOf = (k) => CITIES[k][1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const routeSlug = (a, b) => `${slugOf(a)}-to-${slugOf(b)}`;

export const ROUTES = (() => {
  const keys = Object.keys(CITIES), out = [];
  for (const a of keys.filter((k) => k !== 'cairo')) out.push(['cairo', a]);
  for (const b of keys.filter((k) => k !== 'cairo' && k !== 'alex')) out.push(['alex', b]);
  return out.map(([a, b]) => ({ a, b, slug: routeSlug(a, b) }));
})();
const BY_SLUG = new Map(ROUTES.map((r) => [r.slug, r]));
export const findRoute = (slug) => BY_SLUG.get(String(slug || '').toLowerCase()) || null;
export const routePath = (r) => `/routes/${r.slug}`;

const fmt = (n) => Number(n).toLocaleString('en-US');
const catKey = (S) => (S.categories?.goods ? 'goods' : Object.keys(S.categories || {})[0]);

/** حقائق الطريق من الإعدادات: مسافة، مدة تقديرية، وسعر كل عربية مفعّلة */
export function routeFacts(S, a, b) {
  const A = CITIES[a], B = CITIES[b];
  const km = Math.max(1, Math.round(straightKm(A, B) * (S.roadFactor || 1.3)));
  const hours = km <= 40 ? 1 : Math.round(km / 55); // تقدير بسرعة متوسطة للنقل (مع التوقفات)
  const cat = catKey(S), guide = S.vehicleGuide || {};
  const vehicles = VEHICLE_KEYS.filter((k) => guide[k]?.maxKg > 0).map((k) => ({ key: k, label: VEH[k], maxKg: guide[k].maxKg, price: priceFromKm(S, km, cat, guide[k].size, k) })).filter((v) => v.price > 0);
  return { from: A[0], to: B[0], km, hours, vehicles, low: vehicles.length ? Math.min(...vehicles.map((v) => v.price)) : 0, high: vehicles.length ? Math.max(...vehicles.map((v) => v.price)) : 0 };
}

const hoursText = (h) => (h <= 1 ? 'حوالي ساعة أو أقل' : h === 2 ? 'حوالي ساعتين' : `حوالي ${h} ساعات`);

export function routeRelated(r, n = 6) {
  // 1) التوأم: نفس الوجهة من المحور التاني (القاهرة ↔ الإسكندرية) 2) أقرب وجهات لنفس نقطة البداية. بيضمن إن كل صفحة طريق ليها روابط داخلة كفاية
  const twinRoute = ROUTES.find((x) => x.b === r.b && x.a === (r.a === 'cairo' ? 'alex' : 'cairo')) || null; // نفس الوجهة من المحور التاني
  const B = CITIES[r.b];
  const near = ROUTES.filter((x) => x.slug !== r.slug && x.slug !== twinRoute?.slug && x.a === r.a).sort((p, q) => straightKm(CITIES[p.b], B) - straightKm(CITIES[q.b], B) || p.slug.localeCompare(q.slug));
  return [twinRoute, ...near].filter(Boolean).slice(0, n);
}

/** محتوى صفحة طريق واحد (جاهز لـrenderShell) */
export function routeContent(S, r) {
  const f = routeFacts(S, r.a, r.b), url = `${LP_ORIGIN}${routePath(r)}`;
  const priced = f.low > 0;
  const title = `نقل بضائع من ${f.from} إلى ${f.to} | السعر والمسافة — اشحنلي`;
  const desc = priced
    ? `سعر نقل بضائع من ${f.from} إلى ${f.to} على اشحنلي: يبدأ من ${fmt(f.low)} جنيه تقريباً لمسافة حوالي ${f.km} كم. قارن أسعار العربيات واطلب سواق نقل وتابع شحنتك على الخريطة.`
    : `نقل بضائع من ${f.from} إلى ${f.to} على اشحنلي: مسافة حوالي ${f.km} كم. اطلب سواق نقل وتابع شحنتك على الخريطة.`;
  const h1 = `نقل بضائع من ${f.from} إلى ${f.to}`;
  const lead = `المسافة بين ${f.from} و${f.to} حوالي ${f.km} كم بالطريق (تقدير)، وبتاخد ${hoursText(f.hours)} تقريباً. ${priced ? `السعر التقديري بيبدأ من ${fmt(f.low)} جنيه حسب العربية.` : ''} الخدمة شغّالة بالاتجاهين: من ${f.from} إلى ${f.to} ومن ${f.to} إلى ${f.from}.`.replace(/\s+/g, ' ').trim();
  const table = priced
    ? `<table class="lpp-t"><caption>أسعار تقديرية لنقل بضائع عامة من ${esc(f.from)} إلى ${esc(f.to)}</caption><thead><tr><th scope="col">العربية</th><th scope="col">أقصى حمولة</th><th scope="col">السعر التقديري</th></tr></thead><tbody>${f.vehicles.map((v) => `<tr><th scope="row">${esc(v.label)}</th><td>${fmt(v.maxKg)} كجم</td><td>${fmt(v.price)} جنيه</td></tr>`).join('')}</tbody></table>`
      + '<p>الأسعار دي تقدير للبضائع العامة بالمسافة التقريبية بين المدينتين. السعر النهائي بيتحسب من المسافة الفعلية على الخريطة ونوع الحمولة وقت الطلب، وبتشوفه قبل ما تأكد.</p>'
    : '';
  const related = routeRelated(r), rel = related.map((x) => { const g = routeFacts(S, x.a, x.b); return `<li><a href="${routePath(x)}">نقل بضائع من ${esc(g.from)} إلى ${esc(g.to)}</a> — حوالي ${g.km} كم</li>`; }).join('');
  const body = `<h2>تكلفة نقل بضائع من ${esc(f.from)} إلى ${esc(f.to)}</h2>${table || `<p>اطلب السعر فوراً من حاسبة اشحنلي قبل ما تطلب.</p>`}`
    + `<h2>المسافة والمدة</h2><p>بين ${esc(f.from)} و${esc(f.to)} حوالي ${f.km} كم، والمدة التقديرية ${esc(hoursText(f.hours))} بسرعة النقل المعتادة، وممكن تزيد حسب الزحمة ووقت التحميل والتنزيل.</p>`
    + `<h2>إزاي تطلب نقل شحنتك</h2><ol><li>سجّل حساب عميل على اشحنلي.</li><li>حدّد نقطة الاستلام في ${esc(f.from)} والتسليم في ${esc(f.to)} (أو العكس) ونوع الشحنة ووزنها، وشوف السعر قبل الطلب.</li><li>تابع الشحنة على الخريطة لحد ما توصل.</li></ol>`
    + (rel ? `<h2>طرق نقل قريبة</h2><ul>${rel}</ul><p><a href="/routes">كل طرق النقل بين المحافظات</a></p>` : '');
  const faq = [
    [`كام سعر نقل بضائع من ${f.from} إلى ${f.to}؟`, priced ? `السعر التقديري بيبدأ من ${fmt(f.low)} جنيه لأصغر عربية ويوصل لحوالي ${fmt(f.high)} جنيه للنقل الثقيل لمسافة حوالي ${f.km} كم. السعر النهائي بيتحسب من المسافة الفعلية ونوع الحمولة وبتشوفه قبل الطلب.` : `بتشوف السعر فوراً من حاسبة اشحنلي قبل ما تطلب، وبيتحسب من المسافة الفعلية على الخريطة.`],
    [`كام المسافة بين ${f.from} و${f.to}؟`, `حوالي ${f.km} كم بالطريق (تقدير)، والمدة ${hoursText(f.hours)} تقريباً.`],
    [`أختار أنهي عربية لشحنتي؟`, f.vehicles.length ? `حسب وزن الشحنة: ${f.vehicles.map((v) => `${v.label} لحد ${fmt(v.maxKg)} كجم`).join('، ')}. المنصة بترشّح لك العربية المناسبة وقت الطلب وتقدر تختار غيرها.` : `المنصة بترشّح لك العربية المناسبة حسب وزن الشحنة وقت الطلب.`],
    [`بتنقلوا من ${f.to} إلى ${f.from} كمان؟`, `أيوه، الخدمة شغّالة بالاتجاهين بنفس طريقة الحساب.`],
  ];
  const extraLd = priced ? `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Service', '@id': `${url}#service`, name: h1, serviceType: 'نقل بضائع', provider: { '@id': `${LP_ORIGIN}/#org` }, areaServed: [{ '@type': 'City', name: f.from }, { '@type': 'City', name: f.to }], offers: { '@type': 'AggregateOffer', priceCurrency: 'EGP', lowPrice: f.low, highPrice: f.high, offerCount: f.vehicles.length } }).replace(/</g, '\\u003c')}</script>` : '';
  return { title, desc, h1, lead, body, faq, cta: ['احسب سعر شحنتك', '/#/price'], path: routePath(r), crumbs: [['اشحنلي', '/'], ['طرق النقل', '/routes'], [h1, routePath(r)]], extraLd };
}

/** صفحة فهرس الطرق /routes */
export function routesIndexContent(S) {
  const group = (hub) => ROUTES.filter((r) => r.a === hub).map((r) => { const f = routeFacts(S, r.a, r.b); return `<li><a href="${routePath(r)}">نقل بضائع من ${esc(f.from)} إلى ${esc(f.to)}</a> — حوالي ${f.km} كم${f.low ? ` — يبدأ من ${fmt(f.low)} جنيه` : ''}</li>`; }).join('');
  const title = 'طرق نقل البضائع بين المحافظات في مصر | اشحنلي';
  const desc = 'كل طرق نقل البضائع على اشحنلي بين القاهرة والإسكندرية وباقي المحافظات: المسافة التقريبية والسعر التقديري لكل عربية، واطلب سواق نقل في دقايق.';
  const body = `<h2>من القاهرة</h2><ul>${group('cairo')}</ul><h2>من الإسكندرية</h2><ul>${group('alex')}</ul><p>الأسعار تقديرية وبتتحدّث تلقائي من أسعار المنصة الحالية، والسعر النهائي بيتحسب من المسافة الفعلية على الخريطة وقت الطلب.</p>`;
  const itemLd = `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'ItemList', name: 'طرق نقل البضائع', itemListElement: ROUTES.map((r, i) => ({ '@type': 'ListItem', position: i + 1, url: `${LP_ORIGIN}${routePath(r)}` })) }).replace(/</g, '\\u003c')}</script>`;
  return { title, desc, h1: 'طرق نقل البضائع بين المحافظات', lead: 'اختار الطريق اللي محتاجه وشوف المسافة والسعر التقديري لكل عربية.', body, faq: null, cta: ['احسب سعر شحنتك', '/#/price'], path: '/routes', extraLd: itemLd };
}

const EXAMPLE_SLUGS = ['cairo-to-alexandria', 'cairo-to-mansoura', 'cairo-to-suez', 'cairo-to-assiut', 'cairo-to-aswan', 'alexandria-to-mansoura'];
/** جدول أمثلة أسعار لعدة طرق (لصفحة الأسعار): كل صف رابط لصفحة الطريق */
export function routesExampleTable(S, slugs = EXAMPLE_SLUGS) {
  const rows = slugs.map(findRoute).filter(Boolean).map((r) => ({ r, f: routeFacts(S, r.a, r.b) })).filter((x) => x.f.low > 0);
  if (!rows.length) return '';
  return `<table class="lpp-t"><caption>أمثلة أسعار تقديرية لنقل بضائع عامة بين المدن</caption><thead><tr><th scope="col">الطريق</th><th scope="col">المسافة التقريبية</th><th scope="col">السعر التقديري (حسب العربية)</th></tr></thead><tbody>${rows.map(({ r, f }) => `<tr><th scope="row"><a href="${routePath(r)}">${esc(f.from)} ← ${esc(f.to)}</a></th><td>${f.km} كم</td><td>من ${fmt(f.low)} إلى ${fmt(f.high)} جنيه</td></tr>`).join('')}</tbody></table>`;
}
/** مثال سعر لكل عربية على طريق القاهرة–الإسكندرية (لصفحة العربيات) */
export function vehicleExample(S) {
  const r = findRoute('cairo-to-alexandria'), f = routeFacts(S, r.a, r.b);
  if (!f.vehicles.length) return '';
  return `<p>مثال على طريق <a href="${routePath(r)}">${esc(f.from)} ← ${esc(f.to)}</a> (حوالي ${f.km} كم): ${f.vehicles.map((v) => `${esc(v.label)} ${fmt(v.price)} جنيه`).join('، ')} — تقدير لبضائع عامة، والسعر النهائي بيتحسب وقت الطلب.</p>`;
}
