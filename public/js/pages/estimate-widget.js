import { t, getLang } from '../i18n.js';
import { html, render, label, fmtMoney } from '../ui.js';
import { state } from '../state.js';
import { CITIES, estimate } from '../estimate.js';

// كارت تقدير السعر في الصفحة الرئيسية للزوار
export function initEstimate(el, pub) {
  const S = pub || state.settings; if (!el || !S?.categories || !S?.sizes) return;
  const en = getLang() === 'en', nm = (k) => CITIES[k][en ? 1 : 0];
  const opt = (obj) => Object.keys(obj).map((k) => html`<option value="${k}">${label(obj[k], k)}</option>`);
  render(el, html`<div class="wrap"><div class="card stack est"><h2>${t('est.title')}</h2><p class="muted">${t('est.sub')}</p>
    <div class="est-grid"><label class="f">${t('order.pickup')}<select id="eFrom">${Object.keys(CITIES).map((k) => html`<option value="${k}">${nm(k)}</option>`)}</select></label>
      <label class="f">${t('order.dropoff')}<select id="eTo">${Object.keys(CITIES).map((k) => html`<option value="${k}">${nm(k)}</option>`)}</select></label>
      <label class="f">${t('order.category')}<select id="eCat">${opt(S.categories)}</select></label>
      <label class="f">${t('order.size')}<select id="eSize">${opt(S.sizes)}</select></label></div>
    <div class="est-res" aria-live="polite" id="eRes"></div><p class="hint">${t('est.note')}</p></div></div>`);
  const $ = (id) => el.querySelector(id); $('#eFrom').value = 'cairo'; $('#eTo').value = 'alex';
  const calc = () => {
    const r = estimate(S, $('#eFrom').value, $('#eTo').value, $('#eCat').value, $('#eSize').value);
    render($('#eRes'), r ? html`<div><small class="muted">${t('est.about')} ${r.km} ${t('common.km')}</small><div class="est-price num">${fmtMoney(r.price)}</div></div><a class="btn primary" href="#/register?role=customer">${t('landing.ctaCustomer')}</a>` : html`<span class="muted">${t('est.pick')}</span>`);
  };
  el.querySelectorAll('select').forEach((s) => s.addEventListener('change', calc)); calc();
}
