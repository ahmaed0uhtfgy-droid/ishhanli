// كارت «الخطوات الجاية» في صفحة الطلب وهو مفتوح (open) للعميل. تنبيه الإشعارات بيظهر بس لو لسه ما اتفعّلش (default) أو اتحظر (denied)،
// ومايظهرش لو مفعّلة أو المتصفح مش بيدعمها أو الإدارة ما فعّلتهاش. الحالة بتتبعت من صفحة الطلب (نتيجة pushSupport الموجودة).
import { t } from '../i18n.js';
import { html } from '../ui.js';

const STEPS = ['s1', 's2', 's3'];

export const showNextSteps = (o, role) => role === 'customer' && o?.status === 'open';

export const nextStepsCard = (pushState) => html`<section class="card nextsteps stack" aria-labelledby="nextsteps-h">
  <h3 id="nextsteps-h" style="margin:0">${t('order.next.title')}</h3>
  <ol class="welcome-steps">${STEPS.map((k, i) => html`<li><span class="welcome-n" aria-hidden="true">${i + 1}</span><div><b>${t(`order.next.${k}`)}</b></div></li>`)}</ol>
  ${pushState === 'default' ? html`<div class="nextsteps-push"><p class="small grow" style="margin:0">${t('order.next.push')}</p><button class="btn primary sm" type="button" data-act="enablePush">${t('push.enable')}</button></div>` : ''}
  ${pushState === 'denied' ? html`<div class="nextsteps-push"><p class="small grow" style="margin:0">${t('order.next.pushDenied')}</p></div>` : ''}
</section>`;
