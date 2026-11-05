// صفحة «قواعد التعامل»: متاحة للزوار وأي مستخدم. الأرقام من إعدادات المنصة الحالية.
import { t } from '../i18n.js';
import '../i18n-info.js';
import { html, render } from '../ui.js';
import { state } from '../state.js';
import { rulesSections } from '../rules.js';

export function renderRules(view) {
  const groups = rulesSections(state.settings || {});
  render(view, html`<div class="page-head"><h1>${t('rules.title')}</h1></div>
    <div class="card stack legal rules">
      <p class="muted">${t('rules.sub')}</p>
      <nav class="rules-nav" aria-label="${t('rules.title')}">${groups.map((g) => html`<a href="#rules-${g.id}" data-rules-jump="${g.id}">${t('rules.group.' + g.id)}</a>`)}</nav>
      ${groups.map((g) => html`<section id="rules-${g.id}" class="rules-group"><h2>${t('rules.group.' + g.id)}</h2>
        <ol>${g.rules.map((r) => html`<li><b>${t(`rules.${r.id}.t`)}</b><p>${t(`rules.${r.id}.d`, r.vars)}</p></li>`)}</ol></section>`)}
      <p class="small muted">${t('rules.foot')}</p>
      <p class="small"><a href="#/terms">${t('legal.terms')}</a> · <a href="#/privacy">${t('legal.privacy')}</a></p>
    </div>`);
  // التنقل بين المجموعات من غير ما الـhash يتغيّر (الراوتر شغّال بالـhash)
  const h = (e) => { const a = e.target.closest('[data-rules-jump]'); if (!a) return; e.preventDefault(); view.querySelector('#rules-' + a.dataset.rulesJump)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  view.addEventListener('click', h);
  return () => view.removeEventListener('click', h);
}
