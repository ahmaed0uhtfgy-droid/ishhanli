import { auth, onAuthStateChanged, signOut } from './firebase.js';
import { api, twofa } from './api.js';
import { clearImgCache } from './storage.js';
import { firebaseConfig } from './config.js';
import { pushSupport, enablePush, unregisterPush } from './push.js';
import { state } from './state.js';
import { t, applyI18n, setLang, getLang, initLang } from './i18n.js';
import { $, html, raw, render, toast, errMsg, spinner, enableZoom, busy, openModal } from './ui.js';
import { renderLogin, renderRegister, renderForgot, renderStatus } from './pages/auth.js';
import { initEstimate } from './pages/estimate-widget.js';
import { showLanding, hideLanding, lpPublicPricing } from './landing.js';
import { initErrorReporting } from './report.js';
// app.css بيتحمّل غير حاجب على الصفحة الرئيسية (الـHTML فيه CSS الحرج)؛ نفعّله أول ما التطبيق يشتغل.
{ const ac = document.getElementById('appcss'); if (ac) ac.media = 'all'; }

// الصفحات التقيلة (الأدمن، السواق، الطلب...) بتتحمّل عند أول دخول عليها بس: الزائر والصفحة الرئيسية ما بيحمّلوهاش. بتفضل ترجّع دالة تنضيف زي ما كانت.
let leafletP = null; // Leaflet (الخرائط) بيتحمّل بس لما صفحة محتاجاه، مش على الصفحة الرئيسية
const loadLeaflet = () => window.L?.map ? Promise.resolve() : // window.L?.map مش window.L بس: lenis.min.js بيسرّب متغيّر عالمي اسمه L (function) فكان بيتفسّر غلط إن Leaflet اتحمّل
   (leafletP ||= new Promise((ok, no) => { if (!document.querySelector('link[data-leaflet]')) { const lk = document.createElement('link'); lk.rel = 'stylesheet'; lk.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'; lk.dataset.leaflet = '1'; document.head.appendChild(lk); }
  const sc = document.createElement('script'); sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'; sc.onload = ok; sc.onerror = () => { leafletP = null; no(new Error('leaflet')); }; document.head.appendChild(sc); }));
const lazy = (load, name, map = false) => (...args) => {
  let inner = null, dead = false;
  if (args[0] instanceof Element) render(args[0], spinner());
  Promise.all([load(), map ? loadLeaflet() : null]).then(([m]) => { if (!dead) inner = m[name](...args); }).catch((e) => {
    console.error(e);
    if (!dead && args[0] instanceof Element) { render(args[0], html`<div class="auth card stack"><p>${t('err.network')}</p><button class="btn primary" id="retryPage">${t('common.retry')}</button></div>`); args[0].querySelector('#retryPage')?.addEventListener('click', () => window.dispatchEvent(new Event('app:refresh'))); }
  });
  return () => { dead = true; if (typeof inner === 'function') inner(); };
};
const renderCustomerHome = lazy(() => import('./pages/customer.js'), 'renderCustomerHome', true);
const renderNewOrder = lazy(() => import('./pages/customer.js'), 'renderNewOrder', true);
const renderOrder = lazy(() => import('./pages/order.js'), 'renderOrder', true);
const renderReceipt = lazy(() => import('./pages/receipt.js'), 'renderReceipt');
const renderDriver = lazy(() => import('./pages/driver.js'), 'renderDriver', true);
const renderAdmin = lazy(() => import('./pages/admin.js'), 'renderAdmin');
const renderAccount = lazy(() => import('./pages/account.js'), 'renderAccount', true);
const renderTrack = lazy(() => import('./pages/track.js'), 'renderTrack', true);
const renderDriverDash = lazy(() => import('./pages/driver-dash.js'), 'renderDriverDash');
const renderLegal = lazy(() => import('./pages/legal.js'), 'renderLegal');
const renderRules = lazy(() => import('./pages/rules.js'), 'renderRules');
const renderDriverFees = lazy(() => import('./pages/driver-fees.js'), 'renderDriverFees');

let view = $('#view');
const landing = $('#landing'), topbar = $('#topbar');
const HOME = { customer: '/customer', driver: '/driver', admin: '/customer' }; // الأدمن بيدخل كمستخدم عادي، وزرار «لوحة التحكم» في الشريط يوديه للأدمن
const LOGO = '<img src="/icons/favicon-48.png" width="32" height="32" alt="" decoding="async">';
let cleanup = null;

const parseHash = () => {
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  return { parts: path.split('/').filter(Boolean), query: new URLSearchParams(qs || '') };
};
const go = (path) => { location.hash = '#' + path; };
const LP_IDS = new Set(['top', 'how', 'services', 'price', 'trust', 'faq', 'contact']); // روابط الصفحة الرئيسية الداخلية (#/how …)

// ---------- التحقق بخطوتين للأدمن (TOTP) ----------
function askTotp() {
  return new Promise((resolve) => {
    const { el, close } = openModal(html`<div class="stack">
      <h3>${t('admin.twofa.title')}</h3><p class="hint">${t('admin.twofa.hint')}</p>
      <label class="f">${t('admin.twofa.code')}<input id="tc" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000"></label>
      <p class="err" id="terr" role="alert"></p>
      <div class="row"><button class="btn primary" id="tok" type="button">${t('common.confirm')}</button><button class="btn ghost" id="tlogout" type="button">${t('nav.logout')}</button></div></div>`);
    const ok = $('#tok', el), inp = $('#tc', el), err = $('#terr', el);
    inp.focus();
    ok.addEventListener('click', () => busy(ok, async () => {
      try { const r = await api('admin/2fa/verify', { code: inp.value.trim() }); twofa.set(r.token); close(); resolve(true); }
      catch (e) { err.textContent = e.code === 'totp_bad_code' ? t('admin.twofa.bad') : errMsg(e); }
    }));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok.click(); });
    $('#tlogout', el).addEventListener('click', async () => { close(); await signOut(auth); go('/'); resolve(false); });
  });
}
async function ensureAdmin2fa() {
  let s;
  try { s = await api('admin/2fa/status'); } catch { return true; } // لو فشلت الحالة نفسها نكمّل؛ الـAPI هيرفض لو التحقق مطلوب
  if (!s.enabled || s.verified) return true;
  return await askTotp();
}
window.addEventListener('app:2fa-required', async () => { if (await askTotp()) route(); });

// ===== صندوق الإشعارات (الجرس) =====
const inbox = { items: [], unread: 0, open: false, menu: false, seen: null, timer: null };
const ICON = {
  bell: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  moon: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  logout: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>',
  chev: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  lang: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
};
const initial = (n) => [...String(n || '?').trim()][0] || '?';
const ago = (ms) => { const d = Math.round((ms - Date.now()) / 1000), rtf = new Intl.RelativeTimeFormat(getLang(), { numeric: 'auto' }), a = Math.abs(d); return a < 60 ? rtf.format(0, 'second') : a < 3600 ? rtf.format(Math.round(d / 60), 'minute') : a < 86400 ? rtf.format(Math.round(d / 3600), 'hour') : rtf.format(Math.round(d / 86400), 'day'); };
async function loadInbox({ quiet = true } = {}) {
  if (!state.user || !state.profile) return;
  try {
    const r = await api('inbox/list', {}), prev = inbox.unread, first = inbox.seen === null;
    inbox.items = r.items; inbox.unread = r.unread; inbox.seen = true;
    if (!first && r.unread > prev && quiet && r.items[0]) toast(r.items[0].title); // إشعار جديد وصل والمستخدم على الموقع
    if (!first && r.unread === prev && !inbox.open) return; // مفيش تغيير: ما نعيدش رسم الشريط
    renderTopbar();
  } catch (e) { /* الجرس مش حرج: نسكت لو السيرفر مش متاح */ }
}
function startInbox() {
  clearInterval(inbox.timer); inbox.seen = null; inbox.items = []; inbox.unread = 0;
  if (!state.user || !state.profile) return;
  loadInbox(); inbox.timer = setInterval(() => { if (!document.hidden) loadInbox(); }, 45000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadInbox(); });
const closePops = () => { if (inbox.open || inbox.menu) { inbox.open = inbox.menu = false; renderTopbar(); } };
// ملاحظة مهمة: render() بيستبدل innerHTML، فبعد ما معالج الشريط يعيد الرسم الزرار المضغوط بيتشال من الـDOM، و e.target.closest('#topbar …') بيرجّع null
// فكانت القايمة بتتقفل في نفس الضغطة (قايمة الحساب والجرس مكانوش بيتفتحوا). composedPath بيتحسب وقت الضغط فبيفضل صحيح.
document.addEventListener('click', (e) => { if (!e.composedPath().some((n) => n.classList?.contains('tb-act') || n.classList?.contains('tb-user'))) closePops(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePops(); });

function renderTopbar() {
  const p = state.profile, here = location.hash.split('?')[0] || '#/';
  const roleLinks = !p ? [] : p.role === 'customer' ? [['/customer', 'nav.myOrders'], ['/customer/new', 'nav.newOrder']]
    : p.role === 'driver' ? [['/driver', 'nav.available'], ['/driver/jobs', 'nav.jobs'], ...(state.settings?.dcEnabled === false ? [['/driver/wallet', 'nav.wallet']] : []), ...(state.settings?.dcEnabled === false ? [] : [['/driver/fees', 'nav.fees']]), ['/driver/dashboard', 'nav.dash']]
      : p.role === 'admin' ? [['/customer', 'nav.myOrders'], ['/customer/new', 'nav.newOrder'], ['/admin', 'nav.admin']] : [];
  const links = [...roleLinks, ...(p ? [] : [['/about', 'nav.about']])]; // «عن اشحنلي» للمسجّل جوه قايمة الحساب (الشريط أنضف)
  const canPush = p && (p.status === 'active' || p.role === 'admin') && pushSupport() === 'default';
  const bellPanel = !inbox.open ? '' : html`<div class="pop notif-pop" role="dialog" aria-label="${t('notif.title')}">
      <div class="pop-head"><b>${t('notif.title')}</b>${inbox.unread ? html`<button class="link-btn" id="markAll" type="button">${t('notif.markAll')}</button>` : ''}</div>
      <div class="pop-body">${inbox.items.length ? inbox.items.map((n) => html`<button type="button" class="notif-item ${n.read ? '' : 'unread'}" data-id="${n.id}" data-url="${n.url}"><span class="dot" aria-hidden="true"></span><span class="nt"><b>${n.title}</b><span>${n.body}</span><time>${ago(n.at)}</time></span></button>`) : html`<p class="pop-empty">${t('notif.empty')}</p>`}</div>
      ${canPush ? html`<div class="pop-foot"><button class="btn sm primary block" id="pushOn" type="button">${t('notif.enablePush')}</button></div>` : ''}
    </div>`;
  const push = pushSupport(), chevL = raw('<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>');
  const seg = (attr, cur, opts) => html`<span class="segp" role="group">${opts.map(([v, label]) => html`<button type="button" class="${v === cur ? 'on' : ''}" ${attr}="${v}" aria-pressed="${v === cur}">${label}</button>`)}</span>`;
  const userMenu = !inbox.menu ? '' : html`<div class="pop user-pop" role="menu">
      <div class="pop-head um-head"><span class="avatar big" aria-hidden="true">${initial(p.name)}</span><span class="um-who"><b>${p.name}</b><span class="muted small">${t('auth.role' + (p.accountType === 'company' ? 'Company' : p.role === 'driver' ? 'Driver' : p.role === 'admin' ? 'Admin' : 'Customer'))}</span></span></div>
      <div class="um-grp">${t('nav.account')}</div>
      <a class="menu-item" role="menuitem" href="#/account"><span>${t('menu.profile')}<small>${t('menu.profileSub')}</small></span>${chevL}</a>
      ${push === 'default' ? html`<div class="menu-item"><span>${t('menu.notif')}</span><button class="btn sm primary" id="pushOn" type="button">${t('menu.notifEnable')}</button></div>`
        : push === 'granted' ? html`<div class="menu-item"><span>${t('menu.notif')}</span><span class="muted small">${t('menu.notifOn')}</span></div>` : ''}
      <div class="um-grp">${t('menu.look')}</div>
      <div class="menu-item fsz-row"><span>${t('menu.lang')}</span>${seg('data-set-lang', getLang(), [['ar', 'عربي'], ['en', 'EN']])}</div>
      <div class="menu-item fsz-row"><span>${t('menu.theme')}</span>${seg('data-set-theme', theme, [['light', t('menu.light')], ['dark', t('menu.dark')]])}</div>
      <div class="menu-item fsz-row"><span>${t('menu.font')}</span><span class="segp"><button type="button" id="fdown" aria-label="${t('ui.fontDown')}">A−</button><button type="button" id="fup" aria-label="${t('ui.fontUp')}">A+</button></span></div>
      <div class="um-grp">${t('menu.info')}</div>
      <a class="menu-item" role="menuitem" href="#/about">${t('nav.about')}</a>
      <a class="menu-item" role="menuitem" href="#/rules">${t('footer.rules')}</a>
      <a class="menu-item" role="menuitem" href="#/terms">${t('footer.terms')}</a>
      <a class="menu-item" role="menuitem" href="#/privacy">${t('footer.privacy')}</a>
      <button class="menu-item danger" role="menuitem" data-logout type="button">${raw(ICON.logout)}<span>${t('nav.logout')}</span></button>
    </div>`;
  render(topbar, html`<div class="wrap">
    <a class="brand" href="#/">${raw(LOGO)}<span>${t('brand')}</span></a>
    <nav class="nav" aria-label="main">${links.map(([href, k]) => html`<a href="#${href}" class="${here === '#' + href || (href === '/admin' && here.startsWith('#/admin')) ? 'on' : ''}${href === '/admin' ? ' nav-admin' : ''}${href === '/customer/new' ? ' nav-cta' : ''}">${t(k)}</a>`)}</nav>
    <div class="tb-tools">
      ${p ? html`<div class="tb-act"><button class="icon-btn" id="inboxBtn" type="button" aria-haspopup="dialog" aria-expanded="${inbox.open}" aria-label="${t('notif.title')}">${raw(ICON.bell)}${inbox.unread ? html`<b class="badge">${inbox.unread > 9 ? '9+' : inbox.unread}</b>` : ''}</button>${bellPanel}</div>` : ''}
      ${p ? '' : html`<button class="icon-btn" id="theme" type="button" aria-label="${t('ui.theme')}" aria-pressed="${theme === 'dark'}" title="${t('ui.theme')}">${raw(ICON.moon)}</button>
      <button class="icon-btn lang-btn" id="lang" type="button" aria-label="${getLang() === 'ar' ? 'English' : 'العربية'}"><span aria-hidden="true">${getLang() === 'ar' ? 'EN' : 'ع'}</span></button>`}
      ${p ? html`<div class="tb-user"><button class="avatar-btn" id="userBtn" type="button" aria-haspopup="menu" aria-expanded="${inbox.menu}" aria-label="${p.name}"><span class="avatar">${initial(p.name)}</span><span class="who">${p.name}</span><span class="chev">${raw(ICON.chev)}</span></button>${userMenu}</div>${inbox.menu ? html`<div class="scrim" aria-hidden="true"></div>` : ''}<button class="icon-btn tb-out" data-logout type="button" title="${t('nav.logout')}" aria-label="${t('nav.logout')}">${raw(ICON.logout)}<span class="tb-out-t">${t('nav.logout')}</span></button>`
        : state.user ? html`<button class="btn ghost sm" data-logout type="button">${t('nav.logout')}</button>` : html`<a class="btn primary sm" href="#/login">${t('nav.login')}</a>`}
    </div>
  </div>`);
}
async function doLogout() { await unregisterPush(); clearInterval(inbox.timer); inbox.menu = false; await signOut(auth); go('/'); }
window.addEventListener('app:logout', doLogout); // من زرار الخروج في الصفحة الرئيسية
topbar.addEventListener('click', async (e) => {
  if (e.target.closest('#fup')) setFont(+1); if (e.target.closest('#fdown')) setFont(-1);
  if (e.target.closest('#theme')) { setTheme(theme === 'dark' ? 'light' : 'dark'); e.target.closest('#theme').setAttribute('aria-pressed', String(theme === 'dark')); }
  if (e.target.closest('#lang')) { setLang(getLang() === 'ar' ? 'en' : 'ar'); applyI18n(document); inbox.open = inbox.menu = false; renderTopbar(); route(); loadInbox(); }
  if (e.target.closest('#inboxBtn')) { inbox.open = !inbox.open; inbox.menu = false; renderTopbar(); if (inbox.open) loadInbox({ quiet: false }); return; }
  const sl = e.target.closest('[data-set-lang]'); if (sl) { if (getLang() !== sl.dataset.setLang) { setLang(sl.dataset.setLang); applyI18n(document); inbox.open = false; renderTopbar(); route(); loadInbox(); } return; }
  const st = e.target.closest('[data-set-theme]'); if (st) { setTheme(st.dataset.setTheme); renderTopbar(); return; }
  if (e.target.closest('#userBtn')) { inbox.menu = !inbox.menu; inbox.open = false; renderTopbar(); return; }
  if (e.target.closest('#markAll')) { try { await api('inbox/read', {}); } catch { /* تجاهل */ } inbox.items.forEach((n) => { n.read = true; }); inbox.unread = 0; renderTopbar(); return; }
  const it = e.target.closest('.notif-item');
  if (it) {
    const url = it.dataset.url || '/', n = inbox.items.find((x) => x.id === it.dataset.id);
    if (n && !n.read) { n.read = true; inbox.unread = Math.max(0, inbox.unread - 1); api('inbox/read', { id: n.id }).catch(() => {}); }
    inbox.open = false; renderTopbar();
    const h = url.includes('#') ? url.slice(url.indexOf('#')) : '#/'; if (location.hash === h) route(); else location.hash = h;
    return;
  }
  if (e.target.closest('#pushOn')) {
    const r = await enablePush({ ask: true }).catch(() => 'error');
    const key = { granted: 'push.enabled', denied: 'push.denied', unsupported: 'push.unsupported', not_configured: 'push.notConfigured' }[r] || 'push.error';
    toast(t(key), r !== 'granted'); renderTopbar();
  }
  if (e.target.closest('[data-logout]')) await doLogout();
  if (e.target.closest('.menu-item[href]')) { inbox.menu = false; renderTopbar(); }
});

async function loadSettings() {
  try { state.settings = (await api('settings')).settings; } catch (e) {
    console.error(e); toast(errMsg(e), true);
    // بديل فارغ عشان الصفحات ما تدخلش في حلقة إعادة تحميل لو السيرفر مش متظبط لسه
    state.settings = { categories: {}, sizes: {}, instapay: { handle: '', name: '' }, newDriver: {}, minWithdraw: 100, _failed: true };
  }
}
window.addEventListener('app:settings', loadSettings);

// بيانات الشركة في الصفحة الرئيسية العامة (من غير تسجيل دخول): بتتجاب من /api/about وبتتعرض للحقول المملوءة بس
let company = null;
async function fillCompany() {
  const box = document.getElementById('companyInfo'); if (!box) return;
  if (!company) { try { company = (await (await fetch('/api/about')).json()).company || {}; } catch { company = {}; } }
  const c = company, about = document.getElementById('aboutText');
  if (about && c.about) { about.removeAttribute('data-i18n'); about.textContent = c.about; } // نبذة الأدمن بتحل محل الافتراضي
  const digits = (s) => String(s || '').replace(/[^0-9+]/g, ''), https = (s) => (/^https:\/\/\S+$/i.test(String(s || '').trim()) ? String(s).trim() : '');
  const rows = [
    c.phone && [t('landing.cPhone'), html`<a href="tel:${digits(c.phone)}" dir="ltr">${c.phone}</a>`],
    c.whatsapp && [t('landing.cWhats'), html`<a href="https://wa.me/${digits(c.whatsapp).replace('+', '')}" target="_blank" rel="noopener" dir="ltr">${c.whatsapp}</a>`],
    c.email && [t('landing.cEmail'), html`<a href="mailto:${c.email}" dir="ltr">${c.email}</a>`],
    c.address && [t('landing.cAddress'), c.address],
    c.hours && [t('landing.cHours'), c.hours],
  ].filter(Boolean);
  const social = [['Facebook', c.facebook], ['Instagram', c.instagram], ['TikTok', c.tiktok], ['YouTube', c.youtube]].filter(([, u]) => https(u));
  render(box, rows.length || social.length ? html`<dl class="kv">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}
    ${social.length ? html`<dt>${t('landing.cFollow')}</dt><dd class="row wrap" style="gap:.75rem">${social.map(([n, u]) => html`<a href="${https(u)}" target="_blank" rel="noopener">${n}</a>`)}</dd>` : ''}</dl>` : html`<p class="hint">${t('landing.contactSoon')}</p>`);
}

// الملف الشخصي من السيرفر (Polling). بيتحدّث عند الدخول وبعد التسجيل وعند تغيّر حالة الحساب.
async function loadProfile() {
  try { state.profile = (await api('me')).profile; state.profileError = false; }
  catch (e) { console.error(e); state.profile = null; state.profileError = true; }
  state.ready = true; route(); startInbox();
}
window.addEventListener('app:profile-stale', loadProfile);

function route() {
  if (!state.ready || state.registering) return;
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  const { parts, query } = parseHash(), [a, b] = parts, p = state.profile;
  renderTopbar();
  // عنصر <main> جديد في كل تنقّل: بيمسح أي event listeners قديمة تلقائياً
  const show = () => { const v = document.createElement('main'); v.id = 'view'; v.className = 'wrap'; view.replaceWith(v); view = v; landing.hidden = true; hideLanding(); window.scrollTo(0, 0); };
  const showLand = () => { landing.hidden = false; view.hidden = true; showLanding({ user: state.user, home: HOME[state.profile?.role] || '/' }); initEstimate($('#estimate'), lpPublicPricing()); };

  if (a === 'about' || (a && LP_IDS.has(a) && !b)) { showLand(); fillCompany(); requestAnimationFrame(() => document.getElementById(a === 'about' ? 'contact' : a)?.scrollIntoView()); return; } // صفحة تعريفية لكل الناس (زائر أو مسجّل)
  if (!state.user) { // زائر
    if (!a) { showLand(); fillCompany(); return; }
    show();
    if (a === 'login') return void (cleanup = renderLogin(view));
    if (a === 'register') return void (cleanup = renderRegister(view, query));
    if (a === 'forgot') return void (cleanup = renderForgot(view));
    if (a === 'terms' || a === 'privacy') return void (cleanup = renderLegal(view, a));
    if (a === 'rules') return void (cleanup = renderRules(view));
    if (a === 'track' && b) return void (cleanup = renderTrack(view, b));
    return go('/login');
  }
  if (state.profileError) { // السيرفر مش متاح: ما نعتبرش إن الحساب ناقص
    show(); render(view, html`<div class="auth card stack"><p>${t('err.network')}</p><button class="btn primary" id="retry">${t('common.retry')}</button></div>`);
    $('#retry', view).addEventListener('click', () => { state.ready = false; loadProfile(); }); return;
  }
  if (!p) { // حساب Auth موجود لكن التسجيل ما اكتملش
    if (a !== 'register') return go('/register');
    if (view.querySelector('#driverOnly')) return; // فورم التسجيل معروض بالفعل: ما نعيدش رسمه عشان ما نمسحش اللي اتكتب ولا رسالة الخطأ
    show(); return void (cleanup = renderRegister(view, query));
  }
  if (p.role !== 'admin' && p.status !== 'active') { show(); return void (cleanup = renderStatus(view, p)); }
  if (!state.pushChecked) { state.pushChecked = true; enablePush({ ask: false }).then(renderTopbar).catch(() => {}); } // لو الإذن متاح من قبل نجدّد تسجيل الجهاز بصمت
  if (!a || ['login', 'register', 'forgot'].includes(a)) return go(HOME[p.role] || '/');
  show();
  if (!state.settings) { render(view, spinner()); loadSettings().then(route); return; }
  if (a === 'account') cleanup = renderAccount(view);
  else if (a === 'order' && b) cleanup = renderOrder(view, b);
  else if (a === 'receipt' && b) cleanup = renderReceipt(view, b);
  else if (a === 'customer' && (p.role === 'customer' || p.role === 'admin')) cleanup = b === 'new' ? renderNewOrder(view) : renderCustomerHome(view);
  else if (a === 'driver' && b === 'dashboard' && p.role === 'driver') cleanup = renderDriverDash(view);
    else if (a === 'driver' && b === 'fees' && p.role === 'driver') cleanup = renderDriverFees(view);
    else if (a === 'driver' && p.role === 'driver') cleanup = renderDriver(view, b || 'available');
  else if (a === 'admin' && p.role === 'admin') cleanup = renderAdminGated(view, b || 'overview');
  else if (a === 'terms' || a === 'privacy') cleanup = renderLegal(view, a);
    else if (a === 'rules') cleanup = renderRules(view);
    else if (a === 'track' && b) cleanup = renderTrack(view, b);
  else go(HOME[p.role] || '/');
}

// بوابة الأدمن: نتأكد من التحقق بخطوتين قبل ما نرسم التابات
function renderAdminGated(el, tab) {
  let cancelled = false, inner = null;
  render(el, spinner());
  ensureAdmin2fa().then((ok) => { if (!cancelled && ok && location.hash.startsWith('#/admin')) inner = renderAdmin(el, tab); });
  return () => { cancelled = true; if (typeof inner === 'function') inner(); };
}

window.addEventListener('hashchange', route);
window.addEventListener('app:refresh', route);
window.addEventListener('unhandledrejection', (e) => console.error(e.reason));

if (/^YOUR_/.test(firebaseConfig.apiKey) || /^YOUR_/.test(firebaseConfig.projectId)) { // مساعدة للإعداد: لسه ما عدّلتش config.js
  const b = document.createElement('div'); b.className = 'action bad'; b.style.cssText = 'margin:0;border-radius:0;text-align:center;position:sticky;top:0;z-index:3000';
  b.textContent = '⚠️ ' + 'config.js — Firebase config not set / لم يتم ضبط إعدادات Firebase'; document.body.prepend(b);
}
// الوضع الليلي (اختياري من الزرار، مش تلقائي): بيغيّر متغيّرات الألوان في app.css (html[data-theme=dark])، والصور والدبابيس والمسار بألوانها الطبيعية
let theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'; // الافتراضي من السيرفر (إعداد الأدمن) لحد ما الزائر يختار
try { const sv = localStorage.getItem('theme'); if (sv === 'dark' || sv === 'light') theme = sv; } catch { /* ignore */ }
const applyTheme = () => { document.documentElement.dataset.theme = theme; const land = document.body.classList.contains('on-landing'); document.querySelector('meta[name="theme-color"]')?.setAttribute('content', land ? (theme === 'dark' ? '#0B1F27' : '#F7F4EC') : (theme === 'dark' ? '#07161c' : '#0F2E3A')); }; // لون شريط المتصفح في الموبايل
function setTheme(v) { theme = v === 'dark' ? 'dark' : 'light'; try { localStorage.setItem('theme', theme); } catch { /* ignore */ } applyTheme(); }
applyTheme();
window.addEventListener('app:set-theme', (e) => { setTheme(e.detail); renderTopbar(); }); // من أزرار الصفحة الرئيسية
window.addEventListener('app:theme-refresh', applyTheme);
// حجم الخط (للقراءة المريحة): 4 مستويات بتتحفظ على الجهاز
const FONT = [100, 112.5, 125, 140];
let fontLv = 0; try { fontLv = Math.min(FONT.length - 1, Math.max(0, +localStorage.getItem('fontLv') || 0)); } catch { /* ignore */ }
const applyFont = () => { document.documentElement.style.fontSize = FONT[fontLv] + '%'; };
function setFont(d) { fontLv = Math.min(FONT.length - 1, Math.max(0, fontLv + d)); try { localStorage.setItem('fontLv', String(fontLv)); } catch { /* ignore */ } applyFont(); }
applyFont();
// شريط انقطاع الإنترنت: بدل ما الأزرار تفشل بصمت
const offBar = document.createElement('div'); offBar.className = 'offline-bar'; offBar.setAttribute('role', 'status'); offBar.hidden = true; document.body.prepend(offBar);
const syncNet = () => { const off = !navigator.onLine; offBar.hidden = !off; offBar.textContent = off ? t('net.offline') : ''; };
window.addEventListener('offline', syncNet);
window.addEventListener('online', () => { syncNet(); toast(t('net.online')); window.dispatchEvent(new Event('app:refresh')); });
initLang(); applyI18n(document); syncNet(); enableZoom(document.body); renderTopbar(); initErrorReporting();

onAuthStateChanged(auth, (user) => {
  state.user = user; state.profile = null; state.settings = null; state.profileError = false; state.pushChecked = false;
  if (!user) { clearImgCache(); state.ready = true; return route(); }
  state.ready = false; loadProfile();
});
