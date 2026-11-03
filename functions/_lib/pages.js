// صفحات المحتوى الثابتة للسيو (كل صفحة بنية بحث مستقلة): /how-it-works و /for-drivers و /for-companies.
// نفس مصدر الحقائق بتاع الصفحة الرئيسية (إعدادات النظام) ونفس تعديلات الأدمن للنصوص، من غير أي كلام ثابت عن الدفع أو العمولة.
import { LP_ORIGIN, SITE_DEFAULTS, cleanSite, lpFacts, lpSlots, lpText } from '../../public/js/landing-content.js';
import { esc } from './landing.js';

const plain = (s) => String(s).replace(/\*([^*]+)\*/g, '$1');
export const PAGE_PATHS = { how: '/how-it-works', pricing: '/pricing', vehicles: '/vehicles', drivers: '/for-drivers', companies: '/for-companies' };
const VEH = { pickup: 'ربع نقل', half_ton: 'نص نقل', truck: 'نقل ثقيل', jumbo: 'جامبو' };
const kg = (n) => `${Number(n).toLocaleString('en-US')} كجم`;

export function renderPage(kind, { settings = {}, site: rawSite, company = {}, env = {} } = {}) {
  const site = cleanSite(rawSite ?? SITE_DEFAULTS), f = lpFacts(settings, env), slots = lpSlots(f);
  const val = (id) => plain(site.texts[id] || (slots[id] ? lpText(slots[id].key, slots[id].vars, 'ar') : ''));
  const T = (key, vars) => lpText(key, vars, 'ar');
  const P = (s) => `<p>${esc(s)}</p>`, H = (s) => `<h2>${esc(s)}</h2>`, LI = (a) => `<ul>${a.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  let title, desc, h1, lead, body = '', faq = null, cta;
  if (kind === 'how') {
    title = 'إزاي بتشتغل اشحنلي | نقل بضائع في مصر'; desc = 'اعرف خطوات طلب نقل بضائع على اشحنلي: السعر قبل الطلب، الدفع، تتابع الشحنة على الخريطة، وإزاي بتتعامل لو حصلت مشكلة.';
    h1 = 'إزاي بتشتغل اشحنلي'; lead = val('hero.sub');
    body = [1, 2, 3].map((n) => `<section class="lpp-step"><b aria-hidden="true">${n}</b><div><h2>${esc(val(`how.s${n}t`))}</h2>${P(val(`how.s${n}d`))}</div></section>`).join('')
      + H(val('price.title')) + P(val('price.text')) + `<p class="lpp-f">${esc(val('price.formula'))}</p>` + (f.minPrice > 0 ? P(T('lp.price.min', { n: f.minPrice })) : '')
      + H(val('trust.title')) + LI([`${val('trust.1t')}: ${val('trust.1d')}`, `${val('trust.2t')}: ${val('trust.2d')}`, `${val('trust.3t')}: ${val('trust.3d')}`, `${val('trust.4t')}: ${val('trust.4d')}`]);
    faq = [1, 2, 3, 4].map((n) => [val(`faq.${n}q`), val(`faq.${n}a`)]); cta = ['اطلب نقل دلوقتي', '/#/register?role=customer'];
  } else if (kind === 'pricing') {
    title = 'أسعار نقل البضائع في مصر | إزاي بيتحسب سعر الشحنة على اشحنلي'; desc = 'اعرف إزاي بيتحسب سعر نقل البضائع والأثاث على اشحنلي: المسافة ونوع الحمولة والعربية، وأقل سعر للشحنة، وتقدر تحسب سعر شحنتك فوراً قبل ما تطلب.';
    h1 = 'إزاي بيتحسب سعر نقل شحنتك'; lead = val('price.text');
    const cats = Object.values(settings.categories || {}).filter((c) => c?.ar), sizes = Object.values(settings.sizes || {}).filter((c) => c?.ar);
    body = `<p class="lpp-f">${esc(val('price.formula'))}</p>` + (f.minPrice > 0 ? P(T('lp.price.min', { n: f.minPrice })) : '')
      + H('معامل نوع الحمولة') + P('السعر بيتأثر بنوع الحمولة اللي بتنقلها، وده المعامل المستخدم لكل نوع حالياً:') + (cats.length ? LI(cats.map((c) => `${c.ar}: ${c.mult}`)) : '')
      + (f.vehiclePricing ? H('العربية المختارة') + P('بتتحدد العربية حسب وزن الشحنة، ولكل عربية سعر فتح وسعر كيلومتر خاص بيها.') : (sizes.length ? H('معامل الحجم') + P('وبيتحسب كمان حسب حجم الشحنة:') + LI(sizes.map((c) => `${c.ar}: ${c.mult}`)) : ''))
      + (f.offers ? H('عروض الأسعار') + P('لو السواق شايف سعر مختلف، بيقدر يقترحه عليك وأنت تقبله أو ترفضه.') : '')
      + H('احسب سعر شحنتك فوراً') + P('حاسبة السعر في الصفحة الرئيسية بتديك تقدير فوري بين المدن قبل ما تطلب، والسعر النهائي بيتحسب من المسافة الفعلية على الخريطة.');
    cta = ['احسب سعر شحنتك', '/#/price'];
  } else if (kind === 'vehicles') {
    title = 'أنواع عربيات نقل البضائع وحمولة كل نوع | اشحنلي'; desc = 'تعرف على أنواع عربيات النقل المتاحة على اشحنلي (ربع نقل، نص نقل، نقل ثقيل، جامبو) وأقصى وزن لكل نوع، عشان تختار العربية المناسبة لشحنتك.';
    h1 = 'أنواع عربيات النقل وحمولة كل نوع'; lead = 'اختار العربية على حسب وزن وحجم شحنتك. دي العربيات المتاحة وأقصى وزن لكل نوع:';
    const guide = Object.entries(settings.vehicleGuide || {}).filter(([k, v]) => Number(v?.maxKg) > 0 && VEH[k]);
    const sizes = settings.sizes || {}, cats = Object.values(settings.categories || {}).filter((c) => c?.ar);
    body = (guide.length ? `<ul>${guide.map(([k, v]) => `<li><strong>${esc(VEH[k])}</strong>: أقصى وزن ${kg(v.maxKg)}${sizes[v.size]?.ar ? ` — ${esc(sizes[v.size].ar)}` : ''}</li>`).join('')}</ul>` : '')
      + (settings.vehicleGuideOn !== false ? H('إزاي أختار العربية؟') + P('وقت الطلب بتدخل وزن الشحنة تقريباً، والمنصة بترشّح لك العربية المناسبة، وتقدر تختار غيرها.') : '')
      + (cats.length ? H('أنواع الحمولة اللي بننقلها') + LI(cats.map((c) => c.ar)) : '')
      + H('السعر') + P(val('price.text'));
    cta = ['اطلب نقل دلوقتي', '/#/register?role=customer'];
  } else if (kind === 'drivers') {
    title = 'اشتغل كسواق نقل مع اشحنلي | التسجيل والمستندات'; desc = `سجّل كسواق نقل في اشحنلي: المستندات المطلوبة، المراجعة قبل التفعيل، ${f.direct ? 'والعمولة' : 'العمولة وطرق سحب الأرباح'}.`;
    h1 = val('join.d.title'); lead = val('join.d.text');
    body = H('التسجيل والمراجعة') + P(val('trust.1d')) + P('بعد التسجيل بتتراجع مستنداتك يدوي، وأول ما حسابك يتفعّل بتشوف الطلبات المتاحة.')
      + H('المطلوب منك في كل شحنة') + LI([val('trust.3d'), val('trust.4d')])
      + (f.offers ? H('الأسعار') + P('تقدر تقبل الطلب بالسعر المعروض، أو تقترح سعر مختلف يقبله العميل أو يرفضه.') : '')
      + H('العمولة') + P(val('faq.4a'));
    cta = [val('join.d.cta'), '/#/register?role=driver'];
  } else {
    title = 'لشركات الشحن: سجّل شركتك في اشحنلي'; desc = 'سجّل شركة الشحن بالسجل التجاري والبطاقة الضريبية، وأضف سواقينك بمستنداتهم، وحدد مين يستلم كل شحنة.';
    h1 = val('join.c.title'); lead = val('join.c.text');
    body = H('التسجيل والمراجعة') + P(T('lp.svc.company.d')) + P('بعد التسجيل بتتراجع مستندات الشركة يدوي قبل التفعيل.')
      + H('المطلوب منكم في كل شحنة') + LI([val('trust.3d'), val('trust.4d')])
      + H('العمولة') + P(val('faq.4a'));
    cta = [val('join.c.cta'), '/#/register?role=driver'];
  }
  const url = `${LP_ORIGIN}${PAGE_PATHS[kind]}`, logo = site.logoUrl || '/img/logo.png';
  const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;
  const crumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'اشحنلي', item: `${LP_ORIGIN}/` }, { '@type': 'ListItem', position: 2, name: h1, item: url }] };
  const faqLd = faq ? ld({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) }) : '';
  const nav = [['/how-it-works', 'إزاي بتشتغل'], ['/pricing', 'الأسعار'], ['/vehicles', 'العربيات'], ['/for-drivers', 'للسواقين'], ['/for-companies', 'للشركات']].map(([h, l]) => `<a href="${h}">${l}</a>`).join('');
  return `<!doctype html>
<html lang="ar" dir="rtl" data-theme="light">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${url}"><meta name="robots" content="index,follow,max-image-preview:large">
<meta property="og:type" content="article"><meta property="og:site_name" content="اشحنلي"><meta property="og:locale" content="ar_EG"><meta property="og:url" content="${url}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="${LP_ORIGIN}/img/og.jpg">
<meta name="twitter:card" content="summary_large_image"><meta name="theme-color" content="#F7F4EC"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="icon" type="image/png" sizes="48x48" href="/icons/favicon-48.png"><link rel="apple-touch-icon" href="/icons/icon-180.png">
<link rel="stylesheet" href="/css/landing.css"><link rel="preload" as="font" type="font/woff2" crossorigin href="/fonts/cairo-arabic-600-normal.woff2">
${ld(crumbs)}${faqLd}</head>
<body class="lpp-body"><div class="lp lpa lpp">
<header class="lpp-head"><a class="lp-brand" href="/"><img class="lp-logo-s" src="${esc(logo)}" alt="شعار اشحنلي" width="44" height="40"><span>اشحنلي</span></a><nav aria-label="main">${nav}</nav><a class="lp-btn fill sm" href="/#/login">دخول</a></header>
<main class="lpp-main"><h1>${esc(h1)}</h1><p class="lpp-lead">${esc(lead)}</p>${body}
${faq ? `<h2>أسئلة شائعة</h2>${faq.map(([q, a]) => `<details class="lp-faq-i"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}` : ''}
<p class="lpp-cta"><a class="lp-btn fill" href="${cta[1]}">${esc(cta[0])} ←</a></p></main>
<footer class="lp-foot"><a class="lp-brand" href="/"><span>اشحنلي</span></a><nav class="lp-fnav" aria-label="روابط"><a href="/">الرئيسية</a>${nav}<a href="/#/rules">قواعد التعامل</a><a href="/#/terms">شروط الاستخدام</a><a href="/#/privacy">سياسة الخصوصية</a></nav><small>منصة نقل بضائع — مصر</small></footer></div></body></html>`;
}
