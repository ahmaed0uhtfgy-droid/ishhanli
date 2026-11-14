// كارت ترحيب العميل اللي معندوش طلبات: خطوات + نقاط ثقة حقيقية بس (مفيش أرقام ولا تقييمات).
import { t } from '../i18n.js';
import { html } from '../ui.js';

const STEPS = ['s1', 's2', 's3'], TRUST = ['t1', 't2', 't3'];

export const welcomeCard = () => html`<section class="card welcome stack" aria-labelledby="welcome-h">
  <div><h2 id="welcome-h">${t('welcome.title')}</h2><p class="muted">${t('welcome.lead')}</p></div>
  <ol class="welcome-steps">${STEPS.map((k, i) => html`<li><span class="welcome-n" aria-hidden="true">${i + 1}</span><div><b>${t(`welcome.${k}.t`)}</b><p class="small muted">${t(`welcome.${k}.d`)}</p></div></li>`)}</ol>
  <a class="btn primary welcome-cta" href="#/customer/new">${t('welcome.cta')}</a>
  <ul class="welcome-trust">${TRUST.map((k) => html`<li><b>${t(`welcome.${k}.t`)}</b><span class="small muted">${t(`welcome.${k}.d`)}</span></li>`)}</ul>
</section>`;
