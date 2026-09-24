import { auth, onAuthStateChanged, signOut } from './firebase.js';
import { api } from './api.js';
import { clearImgCache } from './storage.js';
import { firebaseConfig } from './config.js';
import { pushSupport, enablePush, unregisterPush } from './push.js';
import { state } from './state.js';
import { t, applyI18n, setLang, getLang, initLang } from './i18n.js';
import { $, html, raw, render, toast, errMsg, spinner, enableZoom } from './ui.js';
import { renderLogin, renderRegister, renderForgot, renderStatus } from './pages/auth.js';
import { renderCustomerHome, renderNewOrder } from './pages/customer.js';
import { renderOrder } from './pages/order.js';
import { renderDriver } from './pages/driver.js';
import { renderAdmin } from './pages/admin.js';

let view = $('#view');
const landing = $('#landing'), topbar = $('#topbar');
const HOME = { customer: '/customer', driver: '/driver', admin: '/admin' };
const LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#f5b800"/><path d="M6 24 26 8" stroke="#1e2a3a" stroke-width="4" stroke-dasharray="5 4" stroke-linecap="round"/></svg>';
let cleanup = null;

const parseHash = () => {
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  return { parts: path.split('/').filter(Boolean), query: new URLSearchParams(qs || '') };
};
const go = (path) => { location.hash = '#' + path; };

function renderTopbar() {
  const p = state.profile, here = location.hash.split('?')[0] || '#/';
  const links = !p ? [] : p.role === 'customer' ? [['/customer', 'nav.myOrders'], ['/customer/new', 'nav.newOrder']]
    : p.role === 'driver' ? [['/driver', 'nav.available'], ['/driver/jobs', 'nav.jobs'], ['/driver/wallet', 'nav.wallet']]
      : p.role === 'admin' ? [['/admin', 'nav.admin']] : [];
  const showBell = p && (p.status === 'active' || p.role === 'admin') && pushSupport() === 'default';
  render(topbar, html`<div class="wrap">
    <a class="brand" href="#/">${raw(LOGO)}<span>${t('brand')}</span></a>
    <nav class="nav" aria-label="main">${links.map(([href, k]) => html`<a href="#${href}" class="${here === '#' + href || (href === '/admin' && here.startsWith('#/admin')) ? 'on' : ''}">${t(k)}</a>`)}</nav>
    <span class="grow"></span>
    ${p ? html`<span class="who">${p.name}</span>` : ''}
    ${showBell ? html`<button class="btn ghost sm" id="bell" type="button">${t('push.enable')}</button>` : ''}
    <button class="btn ghost sm" id="lang" type="button">${getLang() === 'ar' ? 'EN' : 'عربي'}</button>
    ${state.user ? html`<button class="btn ghost sm" id="logout" type="button">${t('nav.logout')}</button>` : html`<a class="btn primary sm" href="#/login">${t('nav.login')}</a>`}
  </div>`);
}
topbar.addEventListener('click', async (e) => {
  if (e.target.closest('#lang')) { setLang(getLang() === 'ar' ? 'en' : 'ar'); applyI18n(document); renderTopbar(); route(); }
  if (e.target.closest('#bell')) {
    const r = await enablePush({ ask: true }).catch(() => 'error');
    const key = { granted: 'push.enabled', denied: 'push.denied', unsupported: 'push.unsupported', not_configured: 'push.notConfigured' }[r] || 'push.error';
    toast(t(key), r !== 'granted'); renderTopbar();
  }
  if (e.target.closest('#logout')) { await unregisterPush(); await signOut(auth); go('/'); }
});

async function loadSettings() {
  try { state.settings = (await api('settings')).settings; } catch (e) {
    console.error(e); toast(errMsg(e), true);
    // بديل فارغ عشان الصفحات ما تدخلش في حلقة إعادة تحميل لو السيرفر مش متظبط لسه
    state.settings = { categories: {}, sizes: {}, instapay: { handle: '', name: '' }, newDriver: {}, minWithdraw: 100, _failed: true };
  }
}
window.addEventListener('app:settings', loadSettings);

// الملف الشخصي من السيرفر (Polling). بيتحدّث عند الدخول وبعد التسجيل وعند تغيّر حالة الحساب.
async function loadProfile() {
  try { state.profile = (await api('me')).profile; state.profileError = false; }
  catch (e) { console.error(e); state.profile = null; state.profileError = true; state.profileErrorDetail = e.detail || e.code || ''; }
  state.ready = true; route();
}
window.addEventListener('app:profile-stale', loadProfile);

function route() {
  if (!state.ready || state.registering) return;
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  const { parts, query } = parseHash(), [a, b] = parts, p = state.profile;
  renderTopbar();
  // عنصر <main> جديد في كل تنقّل: بيمسح أي event listeners قديمة تلقائياً
  const show = () => { const v = document.createElement('main'); v.id = 'view'; v.className = 'wrap'; view.replaceWith(v); view = v; landing.hidden = true; window.scrollTo(0, 0); };

  if (!state.user) { // زائر
    if (!a) { landing.hidden = false; view.hidden = true; return; }
    show();
    if (a === 'login') return void (cleanup = renderLogin(view));
    if (a === 'register') return void (cleanup = renderRegister(view, query));
    if (a === 'forgot') return void (cleanup = renderForgot(view));
    return go('/login');
  }
  if (state.profileError) { // السيرفر مش متاح: ما نعتبرش إن الحساب ناقص
    show(); render(view, html`<div class="auth card stack"><p>${t('err.network')}</p>${state.profileErrorDetail ? html`<p class="hint" dir="ltr" style="word-break:break-word">${state.profileErrorDetail}</p>` : ''}<button class="btn primary" id="retry">${t('common.retry')}</button></div>`);
    $('#retry', view).addEventListener('click', () => { state.ready = false; loadProfile(); }); return;
  }
  if (!p) { // حساب Auth موجود لكن التسجيل ما اكتملش
    if (a !== 'register') return go('/register');
    show(); return void (cleanup = renderRegister(view, query));
  }
  if (p.role !== 'admin' && p.status !== 'active') { show(); return void (cleanup = renderStatus(view, p)); }
  if (!state.pushChecked) { state.pushChecked = true; enablePush({ ask: false }).then(renderTopbar).catch(() => {}); } // لو الإذن متاح من قبل نجدّد تسجيل الجهاز بصمت
  if (!a || ['login', 'register', 'forgot'].includes(a)) return go(HOME[p.role] || '/');
  show();
  if (!state.settings) { render(view, spinner()); loadSettings().then(route); return; }
  if (a === 'order' && b) cleanup = renderOrder(view, b);
  else if (a === 'customer' && p.role === 'customer') cleanup = b === 'new' ? renderNewOrder(view) : renderCustomerHome(view);
  else if (a === 'driver' && p.role === 'driver') cleanup = renderDriver(view, b || 'available');
  else if (a === 'admin' && p.role === 'admin') cleanup = renderAdmin(view, b || 'overview');
  else go(HOME[p.role] || '/');
}

window.addEventListener('hashchange', route);
window.addEventListener('app:refresh', route);
window.addEventListener('unhandledrejection', (e) => console.error(e.reason));

if (/^YOUR_/.test(firebaseConfig.apiKey) || /^YOUR_/.test(firebaseConfig.projectId)) { // مساعدة للإعداد: لسه ما عدّلتش config.js
  const b = document.createElement('div'); b.className = 'action bad'; b.style.cssText = 'margin:0;border-radius:0;text-align:center;position:sticky;top:0;z-index:3000';
  b.textContent = '⚠️ ' + 'config.js — Firebase config not set / لم يتم ضبط إعدادات Firebase'; document.body.prepend(b);
}
initLang(); applyI18n(document); enableZoom(document.body); renderTopbar();

onAuthStateChanged(auth, (user) => {
  state.user = user; state.profile = null; state.settings = null; state.profileError = false; state.pushChecked = false;
  if (!user) { clearImgCache(); state.ready = true; return route(); }
  state.ready = false; loadProfile();
});
