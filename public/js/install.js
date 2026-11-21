// تثبيت الموقع كتطبيق على الموبايل (PWA): زرار «ثبّت التطبيق» في الفوتر + شريط على الموبايل + شرح خطوات حسب الجهاز.
// أندرويد/كروم: بنستخدم beforeinstallprompt لو وصل (بنلقطه بدري في app.js). آيفون: مفيش API، فبنشرح الخطوات. التطبيقات الداخلية (فيسبوك/إنستجرام…): بنقول يفتح المتصفح.
import { t } from './i18n.js';
import { html, openModal, toast } from './ui.js';

const DISMISS_KEY = 'installDismissedAt', DISMISS_MS = 14 * 864e5;
/** نوع الجهاز/المتصفح ← طريقة التثبيت. دالة نقية (بتتختبر): installed | prompt | inapp | ios | android | desktop */
export function installMode(ua = '', { standalone = false, hasPrompt = false, touchPoints = 0, platform = '' } = {}) {
  if (standalone) return 'installed';
  if (/FBAN|FBAV|FB_IAB|Instagram|Line\/|TikTok|musical_ly|BytedanceWebview|Snapchat|Twitter|MicroMessenger|; wv\)/i.test(ua)) return 'inapp';
  if (hasPrompt) return 'prompt';
  const ios = /iPhone|iPad|iPod/i.test(ua) || (platform === 'MacIntel' && touchPoints > 1);
  if (ios) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
const mode = () => installMode(navigator.userAgent, { standalone: isStandalone(), hasPrompt: !!window.__bip, touchPoints: navigator.maxTouchPoints || 0, platform: navigator.platform || '' });
const isMobileScreen = () => (navigator.maxTouchPoints || 0) > 0 && window.matchMedia?.('(max-width: 900px)').matches;
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };

const steps = (m) => ({
  ios: ['install.ios.1', 'install.ios.2', 'install.ios.3', 'install.ios.4'],
  android: ['install.and.1', 'install.and.2', 'install.and.3', 'install.and.4'],
  desktop: ['install.desk.1', 'install.desk.2'],
  inapp: ['install.inapp.1', 'install.inapp.2'],
  prompt: ['install.and.2', 'install.and.3', 'install.and.4'],
}[m] || []);

export function openGuide() {
  const m = mode();
  if (m === 'installed') { toast(t('install.already')); return; }
  const list = steps(m);
  const { close } = openModal(html`<div class="stack"><h3>${t('install.title')}</h3><p class="muted">${t('install.why')}</p>
    <ol class="install-steps">${list.map((k) => html`<li>${t(k)}</li>`)}</ol>
    <div class="row"><button class="btn primary" type="button" data-close>${t('install.ok')}</button></div></div>`);
  document.querySelector('.modal [data-close]')?.addEventListener('click', close);
}

/** الضغط على «ثبّت»: لو المتصفح بيدعم النافذة الأصلية نفتحها، وإلا نعرض الشرح */
export async function install() {
  const m = mode();
  if (m === 'prompt' && window.__bip) {
    const ev = window.__bip; window.__bip = null;
    try { await ev.prompt(); const r = await ev.userChoice; if (r?.outcome === 'accepted') { toast(t('install.done')); removeBar(); } } catch { openGuide(); }
    return;
  }
  openGuide();
}

const removeBar = () => document.querySelector('.install-bar')?.remove();
function showBar() {
  if (document.querySelector('.install-bar') || mode() === 'installed' || !isMobileScreen()) return;
  const bar = document.createElement('div'); bar.className = 'install-bar'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', t('install.title'));
  const txt = document.createElement('span'); txt.className = 'grow'; txt.textContent = t('install.bar');
  const go = document.createElement('button'); go.type = 'button'; go.className = 'btn primary sm'; go.textContent = t('install.btn'); go.addEventListener('click', () => { removeBar(); install(); });
  const x = document.createElement('button'); x.type = 'button'; x.className = 'install-x'; x.setAttribute('aria-label', t('install.later')); x.textContent = '×'; x.addEventListener('click', () => { store.set(DISMISS_KEY, String(Date.now())); removeBar(); });
  bar.append(txt, go, x); document.body.append(bar);
}

export function initInstall() {
  if (mode() === 'installed') { document.querySelectorAll('[data-install]').forEach((b) => b.remove()); return; }
  document.querySelectorAll('[data-install]').forEach((b) => { b.hidden = false; });
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-install]'); if (b) { e.preventDefault(); install(); } });
  window.addEventListener('appinstalled', () => { removeBar(); document.querySelectorAll('[data-install]').forEach((b) => b.remove()); toast(t('install.done')); });
  const at = Number(store.get(DISMISS_KEY) || 0);
  if (!(at && Date.now() - at < DISMISS_MS)) setTimeout(showBar, 6000); // بعد 6 ثواني من الخمول: fixed فمفيش تحريك للصفحة (CLS)
}
