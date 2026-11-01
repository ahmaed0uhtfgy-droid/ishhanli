// اختيار نوع العربية بالرسمة (تسجيل السواق + أسطول الشركة): بيحل محل القايمة المنسدلة، والقيمة في حقل مخفي بنفس الاسم
import { html, raw } from './ui.js';
import { t } from './i18n.js';
import { vehicleSvg } from './vehicles.js';

export const vehicleSelect = (name, keys, value = keys[0]) => html`<div class="stack" style="gap:.3rem"><b>${t('auth.vehicleType')}</b>
  <input type="hidden" name="${name}" value="${value}">
  <div class="vpick" data-vsel role="radiogroup" aria-label="${t('auth.vehicleType')}">${keys.map((k) => html`<button type="button" role="radio" aria-checked="${k === value}" data-v="${k}" class="${k === value ? 'on' : ''}"><span class="vimg">${raw(vehicleSvg(k, t('vehicle.' + k)))}</span><span>${t('vehicle.' + k)}</span></button>`)}</div></div>`;

export function wireVehicleSelect(root) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-vsel] [data-v]'); if (!b) return;
    const box = b.closest('[data-vsel]'), inp = box.parentElement.querySelector('input[type=hidden]');
    inp.value = b.dataset.v;
    box.querySelectorAll('[data-v]').forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); });
  });
}
