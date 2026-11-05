// صفحة «رسوم المنصة» للسواق: كام كسبت، فاضل قد إيه للحد، ولو اتوقف: حوّل على الرقم اللي حدده الأدمن وابعت صورة التحويل (الإدارة بتراجع وتفعّل الحساب)
import { api } from '../api.js';
import { t } from '../i18n.js';
import { html, render, skeleton, errMsg, fmtMoney, fmtNum, fmtDate, orderNo, toast, busy } from '../ui.js';
import { uploadImage } from '../storage.js';

const pctOf = (d) => (d.limit > 0 ? Math.max(0, Math.min(100, Math.round((d.gross / d.limit) * 100))) : 0);

/** بانر صغير للصفحات التانية: أحمر لو متوقف، أصفر لو قرّب (80%+) */
export const dcBanner = (d) => {
  if (!d || !d.enabled) return '';
  if (d.blocked) return html`<div class="action bad"><b>${t('dc.blockedTitle')}</b><p>${t('fees.blockedShort', { due: fmtMoney(d.due) })}</p><a class="btn primary" href="#/driver/fees">${t('fees.payNow')}</a></div>`;
  if (d.limit > 0 && pctOf(d) >= 80) return html`<div class="action info"><p>${t('fees.nearLimit', { left: fmtMoney(Math.max(0, d.limit - d.gross)) })} <a href="#/driver/fees">${t('fees.open')}</a></p></div>`;
  return '';
};

const payBox = (d) => {
  const w = d.pay.wallet, ip = d.pay.instapay;
  const hasW = !!w?.wallet, hasI = !!ip?.handle;
  return html`<div class="pay-box stack"><div class="muted small">${t('dc.payAmount')}</div><b>${fmtMoney(d.due)}</b>
    ${hasW ? html`<div class="row"><span class="grow">${t('fees.cashNumber')}: <b dir="ltr" id="feesNum">${w.wallet}</b>${w.walletName ? ' — ' + w.walletName : ''}</span><button class="btn sm" type="button" data-copy="${w.wallet}">${t('fees.copy')}</button></div>` : ''}
    ${hasI ? html`<div class="small">${t('dc.method.instapay')}: <b dir="ltr">${ip.handle}</b>${ip.name ? ' — ' + ip.name : ''}</div>` : ''}
    ${!hasW && !hasI ? html`<p class="no-t small">${t('fees.noNumber')}</p>` : ''}</div>`;
};

export function renderDriverFees(view) {
  render(view, html`<div class="page-head"><h1>${t('fees.title')}</h1></div><div id="fees">${skeleton(3)}</div>`);
  const box = view.querySelector('#fees'); let dead = false, timer = null;
  async function load() {
    let d; try { d = await api('dc/summary', {}); } catch (e) { if (!dead) render(box, html`<div class="action bad"><p>${errMsg(e)}</p></div>`); return; }
    if (dead) return;
    if (!d.enabled) { render(box, html`<p class="muted">${t('fees.off')}</p>`); return; }
    const methods = [...(d.pay.wallet?.wallet ? ['wallet'] : []), ...(d.pay.instapay?.handle ? ['instapay'] : [])];
    render(box, html`
      ${d.blocked ? html`<div class="action bad"><b>${t('dc.blockedTitle')}</b><p>${t('dc.blockedMsg')}</p></div>` : html`<div class="action good"><p>${t('fees.active')}</p></div>`}
      <section class="card stack">
        <div class="grid-4"><div class="card kpi"><div class="muted small">${t('dc.gross')}</div><div class="kpi-v num">${fmtMoney(d.gross)}</div><div class="muted small">${t('dc.limit')}: ${fmtMoney(d.limit)}</div></div>
          <div class="card kpi"><div class="muted small">${t('fine.payable')}</div><div class="kpi-v num">${fmtMoney(d.due)}</div><div class="muted small">${d.pct}%</div></div></div>
        <div class="pbar ${d.blocked ? 'bad' : ''}" role="img" aria-label="${pctOf(d)}%"><i class="pbar-fill" data-w="${pctOf(d)}"></i></div>
        <p class="muted small">${t('dc.hint', { pct: d.pct, limit: fmtNum(d.limit, 0) })}</p>
      </section>
      <section class="card stack"><h3>${t('dc.payTitle')}</h3>
        ${d.pending ? html`<div class="action info"><p>${t('dc.pendingMsg', { amount: fmtMoney(d.pending.amount) })}</p></div>`
          : d.due > 0 ? html`<ol class="howto small"><li>${t('fees.s1')}</li><li>${t('fees.s2')}</li><li>${t('fees.s3')}</li></ol>${payBox(d)}
            ${methods.length ? html`<label class="f">${t('dc.method')}<select id="dcMethod">${methods.map((m) => html`<option value="${m}">${t('dc.method.' + m)}</option>`)}</select></label>
            <label class="f">${t('dc.proof')}<input type="file" id="dcProof" accept="image/*"></label>
            <label class="f">${t('dc.ref')}<input id="dcRef" maxlength="40" dir="ltr" autocomplete="off"></label>
            <button class="btn primary block" id="dcSend">${t('dc.send')}</button>` : ''}`
          : d.gross > 0 ? html`<button class="btn primary block" id="dcCover">${t('dc.cover')}</button>` : html`<p class="muted small">${t('dc.noDue')}</p>`}
      </section>
      ${d.history.length ? html`<section class="card stack"><h3>${t('dc.history')}</h3><ul class="plain">${d.history.map((x) => html`<li class="row"><span class="grow">${fmtDate(x.decidedAt || x.createdAt)} · <b>${fmtMoney(x.amount)}</b>${x.status === 'rejected' && x.note ? html` · <span class="no-t">${x.note}</span>` : ''}</span><span class="${x.status === 'paid' ? 'ok-t' : 'no-t'}"><b>${t('dc.st.' + x.status)}</b></span></li>`)}</ul></section>` : ''}
      ${d.entries.length ? html`<section class="card stack"><h3>${t('dc.entries')}</h3><ul class="plain">${d.entries.map((x) => html`<li class="row small"><a class="grow" href="#/order/${x.orderId}">${orderNo(x.orderId)}</a><span>${fmtDate(x.at)}</span><b>${fmtMoney(x.gross)}</b></li>`)}</ul></section>` : ''}`);
    box.querySelectorAll('.pbar-fill').forEach((el) => { el.style.width = el.dataset.w + '%'; });
  }
  view.addEventListener('click', async (e) => {
    const cp = e.target.closest('[data-copy]');
    if (cp) { try { await navigator.clipboard.writeText(cp.dataset.copy); toast(t('fees.copied')); } catch { /* المتصفح مانع النسخ */ } return; }
    const cv = e.target.closest('#dcCover');
    if (cv) { busy(cv, async () => { try { await api('dc/pay', {}); toast(t('fine.done')); load(); } catch (err) { toast(errMsg(err), true); } }); return; }
    const sb = e.target.closest('#dcSend'); if (!sb) return;
    const file = view.querySelector('#dcProof')?.files?.[0], reference = view.querySelector('#dcRef')?.value.trim();
    if (!file || !reference) { toast(t('dc.needProof'), true); return; }
    busy(sb, async () => {
      try { const proofRef = await uploadImage(file, 'payment'); await api('dc/pay', { method: view.querySelector('#dcMethod').value, proofRef, reference }); toast(t('dc.sent')); load(); }
      catch (err) { toast(errMsg(err), true); }
    });
  });
  const typing = () => !!(view.querySelector('#dcProof')?.files?.length || view.querySelector('#dcRef')?.value);
  load(); timer = setInterval(() => { if (!document.hidden && !typing()) load(); }, 30000);
  return () => { dead = true; clearInterval(timer); };
}
