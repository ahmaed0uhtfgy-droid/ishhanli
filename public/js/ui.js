import { t, getLang } from './i18n.js';
import { state } from './state.js';

// ---------- قوالب HTML بتعمل escape تلقائي (حماية من XSS) ----------
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const one = (v) => (v instanceof Raw ? v.s : esc(v));
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < vals.length) { const v = vals[i]; out += Array.isArray(v) ? v.map(one).join('') : one(v); } });
  return new Raw(out);
}
export const render = (el, r) => { el.innerHTML = r instanceof Raw ? r.s : String(r); return el; };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- تنسيق ----------
const loc = () => (getLang() === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB');
export const fmtMoney = (n) => new Intl.NumberFormat(loc(), { style: 'currency', currency: 'EGP', maximumFractionDigits: 0 }).format(Number(n) || 0);
export const fmtNum = (n, d = 1) => new Intl.NumberFormat(loc(), { maximumFractionDigits: d }).format(Number(n) || 0);
export const toDate = (v) => (!v ? null : v.toDate ? v.toDate() : v instanceof Date ? v : new Date(v));
export const fmtDate = (v) => { const d = toDate(v); return d && !isNaN(d) ? d.toLocaleString(loc(), { dateStyle: 'medium', timeStyle: 'short' }) : '—'; };
export const orderNo = (id) => '#' + String(id).slice(0, 6).toUpperCase();
export const ratingText = (u) => (u?.ratingCount ? `★ ${(u.ratingSum / u.ratingCount).toFixed(1)} (${u.ratingCount})` : t('common.noRating'));
export const label = (o, key) => (o && o[getLang()]) || o?.ar || key;
// رحلات الركاب ليها صياغة مختلفة لبعض الحالات (pstatus.*)؛ لو مفيش ترجمة بنرجع للنص العادي
export const stamp = (s, service) => {
  const pk = 'pstatus.' + s;
  return html`<span class="stamp s-${s}">${service === 'passengers' && t(pk) !== pk ? t(pk) : t('status.' + s)}</span>`;
};

export function errMsg(e) {
  const code = e?.code || e?.message || 'server_error';
  const k = 'err.' + String(code).replace(/^auth\//, 'auth_').replace(/[^a-zA-Z0-9_]/g, '_');
  const m = t(k);
  return m === k ? t('err.generic') : m;
}

// ---------- Toast ----------
export function toast(msg, bad = false) {
  const el = document.createElement('div'); el.className = 'toast' + (bad ? ' bad' : ''); el.textContent = msg;
  $('#toasts').append(el); setTimeout(() => el.remove(), bad ? 6000 : 3800);
}

// ---------- Modal ----------
export function openModal(content, { wide = false } = {}) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  const m = document.createElement('div'); m.className = 'modal' + (wide ? ' wide' : ''); m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true');
  render(m, content); bg.append(m); document.body.append(bg);
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  bg.addEventListener('mousedown', (e) => e.target === bg && close());
  m.querySelector('input,select,textarea,button')?.focus();
  return { el: m, close };
}
export function confirmDialog(msg, { danger = false, ok = t('common.confirm') } = {}) {
  return new Promise((res) => {
    const { el, close } = openModal(html`<p>${msg}</p><div class="row end"><button class="btn ghost" data-v="0">${t('common.cancel')}</button><button class="btn ${danger ? 'danger' : 'primary'}" data-v="1">${ok}</button></div>`);
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) { close(); res(b.dataset.v === '1'); } });
  });
}
export function promptDialog(msg, { area = false, required = false, value = '' } = {}) {
  return new Promise((res) => {
    const { el, close } = openModal(html`<label class="f">${msg}${area ? html`<textarea>${value}</textarea>` : html`<input value="${value}">`}</label><p class="err"></p><div class="row end"><button class="btn ghost" data-v="0">${t('common.cancel')}</button><button class="btn primary" data-v="1">${t('common.ok')}</button></div>`);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]'); if (!b) return;
      const v = el.querySelector('input,textarea').value.trim();
      if (b.dataset.v === '1' && required && !v) { el.querySelector('.err').textContent = t('err.bad_input'); return; }
      close(); res(b.dataset.v === '1' ? v : null);
    });
  });
}

/** يعطّل الزرار أثناء العملية ويعرض الأخطاء كـ toast */
export async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { console.error(e); toast(errMsg(e), true); } finally { if (btn) btn.disabled = false; }
}
export const spinner = () => html`<div class="center-load"><span class="spin" role="progressbar" aria-label="${t('common.loading')}"></span></div>`;

// ---------- بوليصة الشحن (كارت الطلب) ----------
export function waybill(o, { href = `#/order/${o.id}` } = {}) {
  return html`<a class="waybill" href="${href}">
    <div class="wb-head"><span class="wb-no">${orderNo(o.id)}</span><span class="row" style="gap:.4rem">${o.payMode === 'before' ? html`<span class="stamp s-active">${t('order.prepaid')}</span>` : ''}${o.offerCount ? html`<span class="stamp s-pending">${o.offerCount} ${t('offer.count')}</span>` : ''}${stamp(o.status, o.service)}</span></div>
    <div class="route"><div class="stop a"><span>${o.pickup?.address || t('order.pickup')}</span></div><i class="road"></i><div class="stop b"><span>${o.dropoff?.address || t('order.dropoff')}</span></div></div>
    <div class="wb-foot">${o.service === 'passengers' ? html`<span>${label(state.settings?.passengerClasses?.[o.vehicleClass], o.vehicleClass)}</span><span>${o.passengers} ${t('order.passengersUnit')}</span><span>${fmtNum(o.distanceKm)} ${t('common.km')}</span>` : html`<span>${label(state.settings?.categories?.[o.category], o.category)}</span><span>${fmtNum(o.distanceKm)} ${t('common.km')}</span><span>${fmtNum(o.weightKg, 0)} ${t('common.kg')}</span>`}<span>${fmtDate(o.scheduledAt)}</span><span class="price">${fmtMoney(o.price)}</span></div>
  </a>`;
}

/** مستوى الثقة + الشارات (بيجي محسوب من السيرفر) */
export function trustBadge(tr) {
  if (!tr) return '';
  return html`<span class="trust"><span class="lvl lvl-${tr.level}">${t('trust.level.' + tr.level)}</span>${(tr.badges || []).map((k) => html`<span class="bdg" title="${t('trust.badge.' + k + '.hint')}">${t('trust.badge.' + k)}</span>`)}</span>`;
}

export function starsInput(root, onChange) {
  let v = 0;
  root.innerHTML = [1, 2, 3, 4, 5].map((i) => `<button type="button" data-s="${i}" aria-label="${i}">★</button>`).join('');
  root.addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (!b) return; v = +b.dataset.s; $$('button', root).forEach((x) => x.classList.toggle('on', +x.dataset.s <= v)); onChange?.(v); });
  return () => v;
}

/** يفتح صورة كبيرة عند الضغط على أي thumbnail */
export function enableZoom(root) {
  root.addEventListener('click', (e) => {
    const img = e.target.closest('img[data-zoom]'); if (!img || !img.src) return;
    openModal(html`<img src="${img.src}" alt="" style="width:100%;border-radius:8px">`, { wide: true });
  });
}
