// صفحات قانونية ثابتة: شروط الاستخدام وسياسة الخصوصية. متاحة للزوار ولأي مستخدم مسجّل.
// المحتوى كله من جدول الترجمة (i18n) عشان يتبدّل مع تغيير اللغة.
import { t } from '../i18n.js';
import { html, render } from '../ui.js';

const TERMS = ['use', 'account', 'pricing', 'cancel', 'duties', 'suspend', 'changes'];
const PRIVACY = ['collect', 'use', 'share', 'store', 'retention', 'local', 'contact'];

export function renderLegal(view, which) {
  const isPrivacy = which === 'privacy';
  const doc = isPrivacy ? 'privacy' : 'terms';
  const keys = isPrivacy ? PRIVACY : TERMS;
  render(view, html`<div class="page-head"><h1>${t('legal.' + doc)}</h1></div>
    <div class="card stack legal">
      <p class="small muted">${t('legal.updated')}</p>
      ${keys.map((k, i) => html`<section><h2>${i + 1}. ${t(`legal.${doc}.${k}.t`)}</h2><p>${t(`legal.${doc}.${k}.d`)}</p></section>`)}
      <p class="small"><a href="#/terms">${t('legal.terms')}</a> · <a href="#/privacy">${t('legal.privacy')}</a></p>
    </div>`);
  return () => {};
}
