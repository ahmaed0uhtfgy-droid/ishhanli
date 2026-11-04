// صفحات قانونية ثابتة: شروط الاستخدام وسياسة الخصوصية. متاحة للزوار ولأي مستخدم مسجّل.
// المحتوى كله من جدول الترجمة (i18n) عشان يتبدّل مع تغيير اللغة.
import { t } from '../i18n.js';
import { html, render } from '../ui.js';
import { siteFacts } from '../facts.js';

const TERMS = ['use', 'account', 'pricing', 'cancel', 'duties', 'suspend', 'changes'];
const PRIVACY = ['collect', 'use', 'share', 'store', 'retention', 'local', 'contact'];

export function renderLegal(view, which) {
  const isPrivacy = which === 'privacy';
  const doc = isPrivacy ? 'privacy' : 'terms';
  const keys = isPrivacy ? PRIVACY : TERMS, direct = siteFacts().direct; // الدفع المباشر: نصوص الشروط بتتغيّر (مفيش مبلغ محجوز ولا نزاعات)
  const dk = (k) => (!isPrivacy && direct && ['use', 'pricing', 'cancel'].includes(k) ? `legal.terms.${k}.d.direct` : `legal.${doc}.${k}.d`);
  render(view, html`<div class="page-head"><h1>${t('legal.' + doc)}</h1></div>
    <div class="card stack legal">
      <p class="small muted">${t('legal.updated')}</p>
      ${keys.map((k, i) => html`<section><h2>${i + 1}. ${t(`legal.${doc}.${k}.t`)}</h2><p>${t(dk(k))}</p></section>`)}
      <p class="small"><a href="#/rules">${t('footer.rules')}</a> · <a href="#/terms">${t('legal.terms')}</a> · <a href="#/privacy">${t('legal.privacy')}</a></p>
    </div>`);
  return () => {};
}
