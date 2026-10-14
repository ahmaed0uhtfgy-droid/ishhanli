import { auth, onAuthStateChanged, signOut } from './firebase.js';
import { api, twofa } from './api.js';
import { clearImgCache } from './storage.js';
import { firebaseConfig } from './config.js';
import { pushSupport, enablePush, unregisterPush } from './push.js';
import { state } from './state.js';
import { t, applyI18n, setLang, getLang, initLang } from './i18n.js';
import { $, html, raw, render, toast, errMsg, spinner, enableZoom, busy, openModal } from './ui.js';
import { renderLogin, renderRegister, renderForgot, renderStatus } from './pages/auth.js';
import { renderCustomerHome, renderNewOrder } from './pages/customer.js';
import { renderOrder } from './pages/order.js';
import { renderReceipt } from './pages/receipt.js';
import { renderDriver } from './pages/driver.js';
import { renderAdmin } from './pages/admin.js';
import { renderAccount } from './pages/account.js';
import { renderLegal } from './pages/legal.js';
import { initErrorReporting } from './report.js';

let view = $('#view');
const landing = $('#landing'), topbar = $('#topbar');
const HOME = { customer: '/customer', driver: '/driver', admin: '/customer' }; // الأدمن بيدخل كمستخدم عادي، وزرار «لوحة التحكم» في الشريط يوديه للأدمن
const LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#f5b800"/><path d="M6 24 26 8" stroke="#1e2a3a" stroke-width="4" stroke-dasharray="5 4" stroke-linecap="round"/></svg>';
let cleanup = null;

const parseHash = () => {
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  return { parts: path.split('/').filter(Boolean), query: new URLSearchParams(qs || '') };
};
const go = (path) => { location.hash = '#' + path; };

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

function renderTopbar() {
  const p = state.profile, here = location.hash.split('?')[0] || '#/';
  const roleLinks = !p ? [] : p.role === 'customer' ? [['/customer', 'nav.myOrders'], ['/customer/new', 'nav.newOrder']]
    : p.role === 'driver' ? [['/driver', 'nav.available'], ['/driver/jobs', 'nav.jobs'], ['/driver/wallet', 'nav.wallet']]
      : p.role === 'admin' ? [['/customer', 'nav.myOrders'], ['/customer/new', 'nav.newOrder'], ['/admin', 'nav.admin']] : [];
  const links = [...roleLinks, ...(p ? [['/account', 'nav.account']] : []), ['/about', 'nav.about']];
  const showBell = p && (p.status === 'active' || p.role === 'admin') && pushSupport() === 'default';
  render(topbar, html`<div class="wrap">
    <a class="brand" href="#/">${raw(LOGO)}<span>${t('brand')}</span></a>
    <nav class="nav" aria-label="main">${links.map(([href, k]) => html`<a href="#${href}" class="${here === '#' + href || (href === '/admin' && here.startsWith('#/admin')) ? 'on' : ''}${href === '/admin' ? ' nav-admin' : ''}">${t(k)}</a>`)}</nav>
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

  if (a === 'about') { landing.hidden = false; view.hidden = true; fillCompany(); requestAnimationFrame(() => document.getElementById('about')?.scrollIntoView()); return; } // صفحة تعريفية لكل الناس (زائر أو مسجّل)
  if (!state.user) { // زائر
    if (!a) { landing.hidden = false; view.hidden = true; fillCompany(); return; }
    show();
    if (a === 'login') return void (cleanup = renderLogin(view));
    if (a === 'register') return void (cleanup = renderRegister(view, query));
    if (a === 'forgot') return void (cleanup = renderForgot(view));
    if (a === 'terms' || a === 'privacy') return void (cleanup = renderLegal(view, a));
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
  else if (a === 'driver' && p.role === 'driver') cleanup = renderDriver(view, b || 'available');
  else if (a === 'admin' && p.role === 'admin') cleanup = renderAdminGated(view, b || 'overview');
  else if (a === 'terms' || a === 'privacy') cleanup = renderLegal(view, a);
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
initLang(); applyI18n(document); enableZoom(document.body); renderTopbar(); initErrorReporting();

onAuthStateChanged(auth, (user) => {
  state.user = user; state.profile = null; state.settings = null; state.profileError = false; state.pushChecked = false;
  if (!user) { clearImgCache(); state.ready = true; return route(); }
  state.ready = false; loadProfile();
});
