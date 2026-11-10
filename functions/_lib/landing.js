// الصفحة الرئيسية من السيرفر: HTML كامل للتصميمين (SEO + محركات الذكاء الاصطناعي بتقرا من غير JavaScript).
// النصوص كلها من landing-content.js (حقائق من إعدادات النظام) + تعديلات الأدمن (site.texts). الحركة والتفاعل بيتضافوا بعدين من public/js/landing.js.
import { LP_ORIGIN, LP_SECTIONS, SITE_DEFAULTS, cleanSite, lpDefaultMode, lpFacts, lpSlots, lpText } from '../../public/js/landing-content.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const em = (s) => esc(s).replace(/\*([^*]+)\*/g, '<em>$1</em>');
const plain = (s) => String(s).replace(/\*([^*]+)\*/g, '$1');
const digits = (s) => String(s || '').replace(/[^0-9+]/g, '');
const https = (s) => (/^https:\/\/[^\s"'<>]+$/i.test(String(s || '').trim()) ? String(s).trim() : '');

const ICON = {
  cargo: '<svg viewBox="0 0 64 64" aria-hidden="true"><path class="i1" d="M6 14h32v28H6z"/><path class="i2" d="M38 22h12l10 12v8H38z"/><circle class="i2 ring" cx="18" cy="46" r="6"/><circle class="i2 ring" cx="50" cy="46" r="6"/></svg>',
  pass: '<svg viewBox="0 0 64 64" aria-hidden="true"><rect class="i2" x="8" y="22" width="48" height="22" rx="8"/><path class="i1" d="M16 22l6-10h20l6 10z"/><circle class="i1 ring" cx="20" cy="46" r="6"/><circle class="i1 ring" cx="44" cy="46" r="6"/></svg>',
  driver: '<svg viewBox="0 0 64 64" aria-hidden="true"><circle class="i1" cx="32" cy="22" r="11"/><path class="i2" d="M10 54c2-14 12-20 22-20s20 6 22 20z"/></svg>',
  company: '<svg viewBox="0 0 64 64" aria-hidden="true"><rect class="i2" x="14" y="8" width="28" height="48" rx="3"/><rect class="i1" x="42" y="22" width="12" height="34" rx="3"/><g class="i3"><rect x="20" y="15" width="6" height="6"/><rect x="30" y="15" width="6" height="6"/><rect x="20" y="27" width="6" height="6"/><rect x="30" y="27" width="6" height="6"/><rect x="20" y="39" width="6" height="6"/><rect x="30" y="39" width="6" height="6"/></g></svg>',
};
const ART = [
  '<svg viewBox="0 0 200 140" aria-hidden="true"><rect x="10" y="10" width="180" height="120" rx="12" fill="#F7F4EC" opacity=".12"/><path d="M30 100 C60 40 100 120 130 60 S170 40 175 35" stroke="#DCC38A" stroke-width="4" fill="none" stroke-dasharray="8 8"/><circle cx="30" cy="100" r="9" fill="#F7F4EC"/><path d="M175 18c-9 0-15 7-15 15 0 11 15 24 15 24s15-13 15-24c0-8-6-15-15-15z" fill="#B8964E"/><circle cx="175" cy="33" r="5" fill="#173B48"/></svg>',
  '<svg viewBox="0 0 200 140" aria-hidden="true"><rect x="40" y="30" width="120" height="84" rx="12" fill="#F7F4EC"/><path d="M40 52h120" stroke="#2B515E" stroke-width="10"/><rect x="54" y="80" width="40" height="10" rx="5" fill="#B8964E"/><circle cx="140" cy="86" r="16" fill="none" stroke="#2B515E" stroke-width="5"/><path d="M132 86l6 6 11-12" stroke="#B8964E" stroke-width="5" fill="none" stroke-linecap="round"/></svg>',
  '<svg viewBox="0 0 200 140" aria-hidden="true"><rect x="20" y="96" width="160" height="14" rx="7" fill="#F7F4EC" opacity=".2"/><path d="M40 84h70V50H78l-10 10H40z" fill="#B8964E"/><path d="M110 56h28l16 18v10h-44z" fill="#F7F4EC"/><circle cx="66" cy="92" r="12" fill="#173B48" stroke="#F7F4EC" stroke-width="5"/><circle cx="138" cy="92" r="12" fill="#173B48" stroke="#F7F4EC" stroke-width="5"/><circle cx="168" cy="34" r="16" fill="#DCC38A"/><path d="M160 34l6 6 11-12" stroke="#173B48" stroke-width="5" fill="none" stroke-linecap="round"/></svg>',
];
const ROAD = 'M1040 190 C 900 190 900 380 740 380 S 560 200 430 280 S 300 520 160 480';
const NUM = ['١', '٢', '٣', '٤'];

/** مولّد الصفحة: بيرجع كل الأجزاء اللي محتاجها القالب */
export function buildLanding({ settings = {}, site: rawSite, company = {}, env = {} } = {}) {
  const site = cleanSite(rawSite ?? SITE_DEFAULTS), f = lpFacts(settings, env), slots = lpSlots(f), ov = site.texts;
  const hidden = new Set(site.hide), show = (id) => !hidden.has(id);
  const has = (id) => !!slots[id];
  const val = (id) => (ov[id] ? ov[id] : lpText(slots[id].key, slots[id].vars, 'ar'));
  const attrs = (id) => (ov[id] ? '' : ` data-i18n="${slots[id].key}" data-i18n-em${slots[id].vars ? ` data-i18n-vars='${esc(JSON.stringify(slots[id].vars))}'` : ''}`);
  const el = (tag, id, cls = '', extra = '') => `<${tag}${cls ? ` class="${cls}"` : ''}${extra}${attrs(id)}>${em(val(id))}</${tag}>`;
  const k = (key, vars) => `<span data-i18n="${key}"${vars ? ` data-i18n-vars='${esc(JSON.stringify(vars))}'` : ''}>${esc(lpText(key, vars, 'ar'))}</span>`;
  const logo = site.logoUrl || '/img/logo.webp';
  const img = (cls = '', extra = '') => `<img class="${cls}" src="${esc(logo)}" alt="${esc(lpText('lp.logo.alt'))}" data-i18n-alt="lp.logo.alt" width="330" height="298" decoding="async"${extra}>`;
  const REG_C = '/#/register?role=customer', REG_D = '/#/register?role=driver';

  const nav = [['how', 'lp.nav.how', 1], ['services', 'lp.nav.services', show('services')], ['price', 'lp.nav.price', 1], ['trust', 'lp.nav.trust', show('trust')], ['faq', 'lp.nav.faq', show('faq')]].filter((x) => x[2]);
  const navHtml = nav.map(([id, key]) => `<a href="#/${id}" data-scroll="${id}">${k(key)}</a>`).join('');
  const tools = `<button class="lp-tool" type="button" data-lp="lang" aria-label="English / عربي">EN</button><button class="lp-tool" type="button" data-lp="mode" data-i18n-aria="lp.mode.toggle" aria-label="${esc(lpText('lp.mode.toggle'))}" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9c0-.5-.5-.7-.9-.5A6 6 0 0 1 12.5 3.9c.2-.4 0-.9-.5-.9z" fill="currentColor"/></svg></button>`;
  const loginA = `<a class="lp-link" href="/#/login" data-lp="login">${k('lp.nav.login')}</a>`;

  // ---------- أجزاء مشتركة ----------
  const stats = [`<div><strong data-n="${f.minPrice}">${f.minPrice}</strong><small>${k('lp.stat.min')}</small></div>`,
    f.geo ? `<div><strong data-n="${f.geo}">${f.geo}</strong><small>${k('lp.stat.geo')}</small></div>` : `<div><strong data-n="3">3</strong><small>${k('lp.stat.steps')}</small></div>`,
    `<div><strong data-n="2">2</strong><small>${k('lp.stat.photos')}</small></div>`].join('');
  const priceMin = `<p class="lp-pmin" data-i18n="lp.price.min" data-i18n-vars='${esc(JSON.stringify({ n: f.minPrice }))}'>${esc(lpText('lp.price.min', { n: f.minPrice }))}</p>`;
  const services = [['cargo', 'svc.cargo'], ['driver', 'svc.driver'], ['company', 'svc.company']];
  if (has('svc.pass.t')) services.splice(1, 0, ['pass', 'svc.pass']);
  const trust = [1, 2, 3, 4].map((n) => `<div class="lp-tc"><h3${attrs(`trust.${n}t`)}>${em(val(`trust.${n}t`))}</h3><p${attrs(`trust.${n}d`)}>${em(val(`trust.${n}d`))}</p></div>`).join('');
  const faq = [1, 2, 3, 4].map((n) => `<details class="lp-faq-i"><summary${attrs(`faq.${n}q`)}>${em(val(`faq.${n}q`))}</summary><p${attrs(`faq.${n}a`)}>${em(val(`faq.${n}a`))}</p></details>`).join('');
  const mq = [`<span>${k('lp.mq.1')}</span>`, `<span>${k('lp.mq.2')}</span>`, `<span>${k(f.direct ? 'lp.mq.3.direct' : 'lp.mq.3.escrow')}</span>`, `<span>${k('lp.mq.4')}</span>`, `<span>${k('lp.mq.5')}</span>`].join('');
  const c = company || {}, social = [['Facebook', c.facebook], ['Instagram', c.instagram], ['TikTok', c.tiktok], ['YouTube', c.youtube]].filter(([, u]) => https(u));
  const rows = [c.phone && ['التليفون', `<a href="tel:${esc(digits(c.phone))}" dir="ltr">${esc(c.phone)}</a>`, 'Phone'],
    c.whatsapp && ['واتساب', `<a href="https://wa.me/${esc(digits(c.whatsapp).replace('+', ''))}" target="_blank" rel="noopener" dir="ltr">${esc(c.whatsapp)}</a>`, 'WhatsApp'],
    c.email && ['الإيميل', `<a href="mailto:${esc(c.email)}" dir="ltr">${esc(c.email)}</a>`, 'Email'], c.address && ['العنوان', esc(c.address), 'Address'], c.hours && ['مواعيد العمل', esc(c.hours), 'Working hours']].filter(Boolean);
  const hasContact = !!(rows.length || social.length || c.about);
  const contact = show('contact') && hasContact ? `<section class="lp-sec lp-contact" id="contact"><div class="lp-in"><${'h2'} class="lp-h"${attrs('contact.title')}>${em(val('contact.title'))}</h2>
    ${c.about ? `<p class="lp-about">${esc(c.about)}</p>` : ''}
    ${rows.length || social.length ? `<dl class="lp-kv">${rows.map(([a, v, en]) => `<dt data-lp-en="${en}">${a}</dt><dd>${v}</dd>`).join('')}${social.length ? `<dt data-lp-en="Follow us">تابعنا</dt><dd class="lp-soc">${social.map(([n, u]) => `<a href="${esc(https(u))}" target="_blank" rel="noopener">${n}</a>`).join('')}</dd>` : ''}</dl>` : ''}</div></section>` : '';
  const foot = `<footer class="lp-foot"><a class="lp-brand" href="/">${img('lp-logo-s')}<span data-i18n="brand">اشحنلي</span></a>
    <nav class="lp-fnav" aria-label="روابط"><a href="/how-it-works">${k('lp.nav.how')}</a><a href="/pricing" data-i18n="lp.foot.pricing">أسعار النقل</a><a href="/vehicles" data-i18n="lp.foot.vehicles">أنواع العربيات</a><a href="/for-drivers">${k('lp.join.d.cta')}</a><a href="/for-companies">${k('lp.join.c.title')}</a><a href="/#/rules" data-i18n="footer.rules">قواعد التعامل</a><a href="/#/terms" data-i18n="footer.terms">شروط الاستخدام</a><a href="/#/privacy" data-i18n="footer.privacy">سياسة الخصوصية</a></nav>
    <small data-i18n="footer.note">منصة نقل بضائع — مصر</small></footer>`;
  const estimate = show('estimate') ? `<section class="lp-sec lp-est" id="estimate-sec" aria-label="${esc(lpText('lp.est.title'))}"><div class="lp-in"><h2 class="lp-h" data-i18n="lp.est.title">${esc(lpText('lp.est.title'))}</h2><div id="estimate"></div></div></section>` : '<div id="estimate" hidden></div>';
  const joinC = show('join');
  const about = show('about') ? `<section class="lp-sec lp-about2" id="about"><div class="lp-in">${el('h2', 'about.title', 'lp-h')}${el('p', 'about.p', 'lp-pt')}<div class="lp-ag"><div class="lp-ac">${el('h3', 'about.ct')}<ul>${[1, 2, 3].map((n) => el('li', `about.c${n}`)).join('')}</ul></div><div class="lp-ac">${el('h3', 'about.dt')}<ul>${[1, 2, 3].map((n) => el('li', `about.d${n}`)).join('')}</ul></div></div></div></section>` : '';

  let body;
  if (site.design === 'b') {
    const svc = services.map(([ic, p], i) => `<div class="lpb-row" data-i="${i}" data-ic="${ic}"><span class="n">${NUM[i]}</span>${el('h3', `${p}.t`)}${el('p', `${p}.d`)}<span class="lpb-ico" aria-hidden="true">${ICON[ic]}</span></div>`).join('');
    const stack = ['s1', 's2', 's3', 's4'].map((s, i) => `<div class="lpb-sc ${s}"><b aria-hidden="true">${NUM[i]}</b><div><h3${attrs(`trust.${i + 1}t`)}>${em(val(`trust.${i + 1}t`))}</h3><p${attrs(`trust.${i + 1}d`)}>${em(val(`trust.${i + 1}d`))}</p></div></div>`).join('');
    body = `<div class="lp lpb" data-design="b">
<header class="lp-head lpb-head"><a class="lpb-pill" href="#/top" data-scroll="top"><span class="lpb-cream">${img()}</span><b data-i18n="brand">اشحنلي</b></a><nav class="lp-nav" aria-label="main">${navHtml}</nav><div class="lp-act">${tools}${loginA}<a class="lp-btn g sm" href="${REG_C}" data-lp="order">${k('lp.nav.order')}</a></div></header>
<section class="lpb-hero" id="top"><div class="lpb-big" aria-hidden="true">اشحنلي</div><div class="lpb-badge" id="lpBd">${img('', ' fetchpriority="high"')}</div>
  ${el('h1', 'hero.h1', 'lpb-h1', ' id="lpH1"')}${el('p', 'hero.sub', 'lpb-sub')}
  <div class="lp-cta"><a class="lp-btn g" href="${REG_C}" data-lp="order">${em(val('hero.cta1'))} ←</a><a class="lp-btn o" href="${REG_D}">${em(val('hero.cta2'))}</a></div></section>
<div class="lp-mq lpb-mq" aria-hidden="true"><div id="lpMq">${mq}</div></div>
<section class="lpb-stm"><p id="lpStm"${attrs('stm.text')}>${em(val('stm.text'))}</p></section>
${about}
<section class="lpb-route" id="how"><span class="lpb-ph" data-i18n="lp.how.tag">${esc(lpText('lp.how.tag'))}</span>
  <svg class="lpb-map" viewBox="0 0 1200 700" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><g class="grid" stroke-width="1"><path d="M0 100H1200M0 220H1200M0 340H1200M0 460H1200M0 580H1200M150 0V700M330 0V700M510 0V700M690 0V700M870 0V700M1050 0V700"/></g>
    <path class="rd0" d="${ROAD}" fill="none" stroke-width="14" stroke-linecap="round"/><path class="rd" d="${ROAD}" fill="none" stroke-width="4" stroke-dasharray="2 14" stroke-linecap="round"/><path id="lpRdp" class="rdp" d="${ROAD}" fill="none" stroke-width="6" stroke-linecap="round"/>
    <g transform="translate(1040 190)"><circle r="22" fill="#B8964E"/><circle r="9" class="dot"/></g><g transform="translate(160 480)"><path d="M0-52c-18 0-30 14-30 30 0 22 30 50 30 50s30-28 30-50c0-16-12-30-30-30z" fill="#F7F4EC" stroke="#B8964E" stroke-width="3"/><circle cy="-22" r="10" fill="#2B515E"/></g>
    <g id="lpTrk"><g transform="translate(-30 -28)"><rect x="0" y="6" width="38" height="30" rx="4" fill="#B8964E"/><path d="M38 14h14l10 12v10H38z" fill="#F7F4EC"/><circle cx="14" cy="38" r="7" fill="#0B1F27" stroke="#F7F4EC" stroke-width="3"/><circle cx="50" cy="38" r="7" fill="#0B1F27" stroke="#F7F4EC" stroke-width="3"/></g></g></svg>
  <div class="lpb-cap">${[1, 2, 3].map((n) => `<div id="lpC${n}"><h2${attrs(`how.s${n}t`)}>${em(val(`how.s${n}t`))}</h2><p${attrs(`how.s${n}d`)}>${em(val(`how.s${n}d`))}</p></div>`).join('')}</div></section>
${estimate}
${show('services') ? `<section class="lp-sec lpb-svc" id="services"><div class="lp-in">${el('h2', 'svc.title', 'lp-h')}${svc}</div></section><div id="lpPv" aria-hidden="true"></div>` : ''}
${show('trust') ? `<section class="lp-sec lpb-stack" id="trust"><div class="lp-in">${el('h2', 'trust.title', 'lp-h')}${stack}</div></section>` : ''}
<section class="lpb-price" id="price"><div class="lp-in lp-center">${el('h2', 'price.title', 'lp-h')}${el('p', 'price.text', 'lp-pt')}<div class="lpb-f" id="lpF"><p${attrs('price.formula')}>${em(val('price.formula'))}</p></div>${priceMin}<div class="lp-stats">${stats}</div></div></section>
${joinC ? `<section class="lp-sec lpb-join"><div class="lp-in lpb-jg"><div class="lpb-jc"><h2${attrs('join.d.title')}>${em(val('join.d.title'))}</h2><p${attrs('join.d.text')}>${em(val('join.d.text'))}</p><a class="lp-btn g" href="${REG_D}">${em(val('join.d.cta'))} ←</a></div><div class="lpb-jc"><h2${attrs('join.c.title')}>${em(val('join.c.title'))}</h2><p${attrs('join.c.text')}>${em(val('join.c.text'))}</p><a class="lp-btn o" href="${REG_D}">${em(val('join.c.cta'))} ←</a></div></div></section>` : ''}
${show('faq') ? `<section class="lp-sec lpb-fq" id="faq"><div class="lp-in lp-narrow">${el('h2', 'faq.title', 'lp-h')}${faq}</div></section>` : ''}
${contact}
<section class="lpb-fin"><h2${attrs('fin.title')}>${em(val('fin.title'))}</h2><div class="lp-cta"><a class="lp-btn g" href="${REG_C}" data-lp="order">${em(val('hero.cta1'))} ←</a><a class="lp-btn o" href="${REG_D}">${em(val('hero.cta2'))}</a></div></section>
${foot}</div>`;
  } else {
    const svc = services.map(([ic, p]) => `<div class="lpa-card"><span class="lpa-ic" aria-hidden="true">${ICON[ic]}</span>${el('h3', `${p}.t`)}${el('p', `${p}.d`)}</div>`).join('');
    const steps = [1, 2, 3].map((n) => `<div class="lpa-step"><div class="art"><span class="num" aria-hidden="true">${NUM[n - 1]}</span>${ART[n - 1]}</div><div class="txt"><h3${attrs(`how.s${n}t`)}>${em(val(`how.s${n}t`))}</h3><p${attrs(`how.s${n}d`)}>${em(val(`how.s${n}d`))}</p></div></div>`).join('');
    body = `<div class="lp lpa" data-design="a">
<header class="lp-head lpa-head"><a class="lp-brand" href="#/top" data-scroll="top">${img('lp-logo-s')}<span data-i18n="brand">اشحنلي</span></a><nav class="lp-nav" aria-label="main">${navHtml}</nav><div class="lp-act">${tools}${loginA}<a class="lp-btn fill sm" href="${REG_C}" data-lp="order">${k('lp.nav.order')}</a></div></header>
<section class="lpa-hero" id="top"><div class="lpa-hin"><div>${el('span', 'hero.eyebrow', 'lpa-eyebrow')}${el('h1', 'hero.h1', 'lpa-h1', ' id="lpH1"')}${el('p', 'hero.sub', 'lpa-lead')}
  <div class="lp-cta"><a class="lp-btn fill" href="${REG_C}" data-lp="order">${em(val('hero.cta1'))} ←</a><a class="lp-btn ghost" href="${REG_D}">${em(val('hero.cta2'))}</a></div></div>
  <div class="lpa-mark"><div class="halo2"></div><div class="halo" id="lpHalo"></div>${img('', ' id="lpMark" fetchpriority="high"')}</div></div>
  <div class="lpa-road" aria-hidden="true"><svg viewBox="0 0 1200 150" preserveAspectRatio="none"><g id="lpPyr" fill="#DCC38A" opacity=".55"><path d="M120 110 L210 38 L300 110Z"/><path d="M250 110 L310 62 L370 110Z" fill="#B8964E" opacity=".7"/><path d="M880 110 L970 44 L1060 110Z"/></g><rect class="rb" y="110" width="1200" height="40"/><line id="lpDash" x1="0" y1="131" x2="2400" y2="131" stroke="#DCC38A" stroke-width="3" stroke-dasharray="40 30"/></svg></div>
  <div class="lpa-hint" aria-hidden="true" data-i18n="lp.hero.scroll">${esc(lpText('lp.hero.scroll'))}</div></section>
<section class="lpa-stm"><p id="lpStm"${attrs('stm.text')}>${em(val('stm.text'))}</p></section>
${about}
<section class="lpa-how" id="how"><div class="lpa-track" id="lpTrack"><div class="lpa-hhead">${el('span', 'how.tag', 'lpa-eyebrow')}${el('h2', 'how.title')}</div>${steps}</div></section>
<section class="lpa-giant" aria-hidden="true"><div class="out" id="lpGiant">اشحنلي · اشحنلي · اشحنلي · اشحنلي</div></section>
<div class="lp-mq lpa-mq" aria-hidden="true"><div id="lpMq">${mq}</div></div>
${estimate}
${show('services') ? `<section class="lp-sec lpa-svc" id="services"><div class="lp-in">${el('h2', 'svc.title', 'lp-h')}<div class="lpa-grid">${svc}</div></div></section>` : ''}
<section class="lp-sec lpa-price" id="price"><div class="lp-in lpa-pg"><div>${el('h2', 'price.title', 'lp-h')}${el('p', 'price.text', 'lp-pt')}${priceMin}<div class="lp-stats">${stats}</div></div><div class="lpa-formula" id="lpF"><p${attrs('price.formula')}>${em(val('price.formula'))}</p></div></div></section>
${show('trust') ? `<section class="lp-sec lpa-trust" id="trust"><div class="lp-in lpa-tg"><div class="lpa-badge" id="lpBd">${img()}</div><div>${el('h2', 'trust.title', 'lp-h')}<div class="lpa-tl">${trust}</div></div></div></section>` : ''}
${joinC ? `<section class="lpa-join"><div class="j1"><h2${attrs('join.d.title')}>${em(val('join.d.title'))}</h2><p${attrs('join.d.text')}>${em(val('join.d.text'))}</p><a class="lp-btn fill" href="${REG_D}">${em(val('join.d.cta'))} ←</a></div><div class="j2"><h2${attrs('join.c.title')}>${em(val('join.c.title'))}</h2><p${attrs('join.c.text')}>${em(val('join.c.text'))}</p><a class="lp-btn ghost" href="${REG_D}">${em(val('join.c.cta'))} ←</a></div></section>` : ''}
${show('faq') ? `<section class="lp-sec lpa-faq" id="faq"><div class="lp-in lp-narrow">${el('h2', 'faq.title', 'lp-h')}${faq}</div></section>` : ''}
${contact}
${foot}</div>`;
  }

  // أرقام التسعير العامة لحاسبة السعر (نفس الأرقام اللي بتظهر للعميل وقت الطلب)
  const pub = { categories: settings.categories, sizes: settings.sizes, perKm: settings.perKm, minPrice: settings.minPrice, roadFactor: settings.roadFactor, vehiclePricing: settings.vehiclePricing, vehicleGuide: settings.vehicleGuide, facts: f };
  body += `<script type="application/json" id="lpPub">${JSON.stringify(pub).replace(/</g, '\\u003c')}</script>`;

  // ---------- SEO ----------
  const title = site.seo.title || 'اشحنلي | منصة نقل بضائع في مصر — اطلب سواق نقل بسعر فوري';
  const desc = site.seo.description || 'اشحنلي منصة مصرية تربط أصحاب البضائع والأثاث بسواقين نقل موثّقين: حدد الاستلام والتسليم، اعرف السعر فوراً، وتابع شحنتك لحد التسليم. وللسواق: سجّل واستقبل طلبات النقل.';
  const faqLd = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [1, 2, 3, 4].map((n) => ({ '@type': 'Question', name: plain(val(`faq.${n}q`)), acceptedAnswer: { '@type': 'Answer', text: plain(val(`faq.${n}a`)) } })) };
  const org = { '@type': 'Organization', '@id': `${LP_ORIGIN}/#org`, name: c.name || 'اشحنلي', alternateName: 'Ishhanli', url: `${LP_ORIGIN}/`, logo: { '@type': 'ImageObject', url: `${LP_ORIGIN}/img/logo.png`, width: 330, height: 298 }, image: `${LP_ORIGIN}/img/og.jpg`, description: desc, areaServed: { '@type': 'Country', name: 'Egypt' } };
  if (c.phone || c.email) org.contactPoint = { '@type': 'ContactPoint', contactType: 'customer service', areaServed: 'EG', availableLanguage: ['ar', 'en'], ...(c.phone ? { telephone: c.phone } : {}), ...(c.email ? { email: c.email } : {}) };
  if (social.length) org.sameAs = social.map(([, u]) => https(u));
  if (c.address) org.address = { '@type': 'PostalAddress', streetAddress: c.address, addressCountry: 'EG' };
  const serviceLd = { '@context': 'https://schema.org', '@type': 'Service', '@id': `${LP_ORIGIN}/#service`, name: 'اشحنلي — نقل البضائع', serviceType: 'Freight and goods transport', provider: { '@id': `${LP_ORIGIN}/#org` }, areaServed: { '@type': 'Country', name: 'Egypt' }, description: plain(val('price.text')),
    ...(f.minPrice > 0 ? { offers: { '@type': 'Offer', priceCurrency: 'EGP', priceSpecification: { '@type': 'PriceSpecification', minPrice: f.minPrice, priceCurrency: 'EGP' }, description: 'السعر يُحسب تلقائياً من المسافة ونوع الحمولة، وفيه حد أدنى للسعر' } } : {}) };
  const graph = { '@context': 'https://schema.org', '@graph': [org, { '@type': 'WebSite', '@id': `${LP_ORIGIN}/#site`, url: `${LP_ORIGIN}/`, name: 'اشحنلي', inLanguage: 'ar', publisher: { '@id': `${LP_ORIGIN}/#org` } }] };
  const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;
  const head = `<title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <link rel="canonical" href="${LP_ORIGIN}/">
  <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">
  ${site.seo.google ? `<meta name="google-site-verification" content="${esc(site.seo.google)}">` : ''}${site.seo.bing ? `<meta name="msvalidate.01" content="${esc(site.seo.bing)}">` : ''}
  <meta property="og:type" content="website"><meta property="og:site_name" content="اشحنلي"><meta property="og:locale" content="ar_EG"><meta property="og:url" content="${LP_ORIGIN}/">
  <meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="${LP_ORIGIN}/img/og.jpg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${esc(lpText('lp.logo.alt'))}">
  <meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${LP_ORIGIN}/img/og.jpg">
  <link rel="preload" as="image" href="${esc(logo)}" fetchpriority="high">
  ${ld(graph)}\n  ${ld(serviceLd)}\n  ${ld(faqLd)}`;
  return { head, body, site, facts: f, title, mode: lpDefaultMode(site), design: site.design };
}

/** بيركّب الصفحة الجاهزة جوه قالب index.html (الـshell) */
export function injectShell(shell, L, opts = {}) {
  let out = shell.replace(/<title>[\s\S]*?<\/title>/i, '').replace('<!--LP_HEAD-->', L.head).replace('<!--LP_BODY-->', L.body);
  // أداء الموبايل: الصفحة الرئيسية بتضمّن CSS الحرج (أساسيات app.css + landing.css) جوه الـHTML وبتحمّل باقي app.css من غير حجب العرض.
  // opts.css = { base, landing } بيجيبهم functions/index.js من ملفات الـCSS نفسها، فالملفات تفضل المصدر الوحيد.
  if (opts.css && opts.css.base && opts.css.landing) {
    const LINK_L = '<link rel="stylesheet" href="/css/landing.css">', LINK_A = '<link rel="stylesheet" href="/css/app.css">';
    if (out.includes(LINK_L) && out.includes(LINK_A)) {
      // نفس ترتيب الـcascade الأصلي بالظبط: [الأساسيات] ثم app.css (غير حاجب) ثم landing.css
      out = out.replace(LINK_A, () => `<style>${opts.css.base}</style><link rel="stylesheet" href="/css/app.css" media="print" id="appcss"><noscript><link rel="stylesheet" href="/css/app.css"></noscript>`)
        .replace(LINK_L, () => `<style>${opts.css.landing}</style>`);
    }
  }
  out = out.replace(/<html([^>]*)>/i, (m, a) => `<html${a.replace(/\sdata-(theme|lp-title|design)="[^"]*"/g, '')} data-lp-title="1" data-design="${L.design}" data-theme="${L.mode}">`);
  // الـtopbar والفوتر مخفيين على الصفحة الرئيسية؛ نحط الكلاس من السيرفر عشان الصفحة ما تنزل 64px لحد ما JS يضيفه (CLS)
  out = out.replace(/<body(?![^>]*\bclass=)([^>]*)>/i, '<body class="on-landing"$1>');
  return out;
}
export { LP_SECTIONS };
