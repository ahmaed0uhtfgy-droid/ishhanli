// الصفحة الرئيسية في المتصفح: بتربط الأزرار (لغة/وضع ليلي/تمرير) وحالة الدخول، وبتشغّل الحركة وتوقفها حسب ظهور الصفحة.
import { getLang, setLang, applyI18n } from './i18n.js';
import { startFx, motionOK } from './landing-fx.js';

let fx = null, starting = false, token = 0, bound = null;
const rootEl = () => document.querySelector('#landing .lp');
const LABELS = { 'Phone': 'التليفون', 'WhatsApp': 'واتساب', 'Email': 'الإيميل', 'Address': 'العنوان', 'Working hours': 'مواعيد العمل', 'Follow us': 'تابعنا' };

export const lpPublicPricing = () => { try { return JSON.parse(document.getElementById('lpPub')?.textContent || 'null'); } catch { return null; } };

function hydrate(root, { user, home }) {
  const en = getLang() === 'en', theme = document.documentElement.dataset.theme === 'dark';
  root.querySelector('[data-lp=lang]')?.replaceChildren(en ? 'عربي' : 'EN');
  root.querySelector('[data-lp=mode]')?.setAttribute('aria-pressed', String(theme));
  const login = root.querySelector('[data-lp=login]');
  if (login) { login.setAttribute('data-i18n', user ? 'lp.nav.account' : 'lp.nav.login'); login.setAttribute('href', user ? '/#' + (home || '/') : '/#/login'); }
  const out = root.querySelector('[data-lp=logout]'); if (out) out.hidden = !user; // زرار الخروج ظاهر لما المستخدم يكون داخل
  applyI18n(root);
  root.querySelectorAll('[data-lp-en]').forEach((dt) => { dt.textContent = en ? dt.dataset.lpEn : LABELS[dt.dataset.lpEn]; });
}

function bind(root) {
  if (bound === root) return; bound = root;
  root.addEventListener('click', (e) => {
    const sc = e.target.closest('[data-scroll]');
    if (sc) {
      e.preventDefault(); const id = sc.dataset.scroll;
      if (fx) fx.scrollTo(id); else { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: motionOK() ? 'smooth' : 'auto', block: 'start' }); }
      return;
    }
    const tool = e.target.closest('[data-lp]')?.dataset.lp;
    if (tool === 'logout') { window.dispatchEvent(new Event('app:logout')); return; }
    if (tool === 'mode') { window.dispatchEvent(new CustomEvent('app:set-theme', { detail: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' })); root.querySelector('[data-lp=mode]')?.setAttribute('aria-pressed', String(document.documentElement.dataset.theme === 'dark')); }
    if (tool === 'lang') { stop(); setLang(getLang() === 'ar' ? 'en' : 'ar'); applyI18n(document); window.dispatchEvent(new Event('app:refresh')); }
  });
}

function stop() { token++; if (fx) { fx.stop(); fx = null; } starting = false; }

/** الصفحة الرئيسية بقت ظاهرة: بنربطها ونشغّل الحركة (مرة واحدة لحد ما تتشال) */
export function showLanding({ user, home } = {}) {
  const root = rootEl(); if (!root) return;
  document.body.classList.add('on-landing'); window.dispatchEvent(new Event('app:theme-refresh'));
  bind(root); hydrate(root, { user, home });
  if (fx || starting) return;
  starting = true; const my = ++token;
  startFx(root).then((h) => { if (my !== token || document.getElementById('landing')?.hidden) { h?.stop(); return; } fx = h; starting = false; }).catch((e) => { console.warn(e); starting = false; });
}
export function hideLanding() { document.body.classList.remove('on-landing'); window.dispatchEvent(new Event('app:theme-refresh')); stop(); }
