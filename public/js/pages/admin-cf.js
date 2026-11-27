// تبويب «رسوم الشركات» للأدمن: عدّادين لكل شركة (إجمالي + دورة)، مراجعة إثباتات السداد (تأكيد/رفض)، وتعديل العدّادات يدوي. الإعدادات نفسها في تبويب الإعدادات.
import { api } from '../api.js';
import { t } from '../i18n.js';
import { html, render, toast, errMsg, fmtMoney, fmtNum, fmtDate, confirmDialog, promptDialog } from '../ui.js';
import { hydrate, imgTag } from '../storage.js';
import { raw } from '../ui.js';

const rateText = (d) => (d.type === 'percent' ? t('admin.cf.ratePct', { v: fmtNum(d.value, 1), limit: fmtNum(d.limit, 0) }) : t('admin.cf.rateFixed', { v: fmtMoney(d.value), limit: fmtNum(d.limit, 0) }));

export function renderAdminCf(body) {
  let dead = false;
  async function load() {
    let d; try { d = await api('admin/cf/list', {}); } catch (e) { if (!dead) render(body, html`<div class="card"><p>${errMsg(e)}</p></div>`); return; }
    if (dead) return;
    render(body, html`<div class="card stack"><h3>${t('admin.cf.title')}</h3>
      ${d.enabled ? html`<p class="muted small">${rateText(d)}</p>` : html`<div class="action info">${t('admin.cf.off')}</div>`}</div>
      <div class="card stack"><h3>${t('admin.cf.pending')}</h3>
      ${d.pending.length ? d.pending.map((p) => html`<div class="card stack"><div class="row"><b class="grow">${p.name || p.companyId}</b><b>${fmtMoney(p.amount)}</b></div>
        <p class="muted small">${t('dc.method.' + p.method)} · ${t('dc.ref')}: <b dir="ltr">${p.reference}</b> · ${t('admin.cf.cycle')}: ${fmtMoney(p.cycle)} · ${fmtDate(p.createdAt)}</p><div class="photos">${raw(imgTag(p.proof))}</div>
        <div class="row"><button class="btn ok" data-cf="confirm" data-id="${p.id}" data-amount="${p.amount}">${t('admin.cf.confirm')}</button><button class="btn danger" data-cf="reject" data-id="${p.id}">${t('admin.cf.reject')}</button></div></div>`) : html`<div class="empty">${t('admin.cf.none')}</div>`}</div>
      <div class="card stack"><h3>${t('admin.cf.companies')}</h3>
      ${d.companies.length ? d.companies.map((x) => html`<div class="row" style="padding:.4rem 0;border-bottom:1px solid var(--rule)"><b class="grow">${x.name || x.id}${x.blocked ? html` <span class="no-t"><b>${t('admin.cf.blocked')}</b></span>` : ''}<br><span class="muted small" dir="ltr">${x.phone || ''}</span></b>
        <span class="small">${t('admin.cf.cycle')}: <b>${fmtMoney(x.cycle)}</b> · ${t('admin.cf.total')}: <b>${fmtMoney(x.total)}</b> · ${t('admin.cf.due')}: <b>${fmtMoney(x.due)}</b></span>
        <button class="btn sm" data-cf="adjust" data-uid="${x.id}" data-cycle="${x.cycle}" data-total="${x.total}">${t('admin.cf.adjust')}</button></div>`) : html`<div class="empty">${t('admin.cf.none')}</div>`}</div>
      <div class="card stack"><h3>${t('admin.cf.recent')}</h3>
      ${d.recent.length ? d.recent.map((p) => html`<div class="row small"><span class="grow"><b>${p.name || p.companyId}</b> · ${fmtMoney(p.amount)} · ${t('dc.method.' + p.method)} · <bdi>${p.reference}</bdi> · ${fmtDate(p.decidedAt || p.createdAt)}${p.note ? ' · ' + p.note : ''}</span><span class="${p.status === 'paid' ? 'ok-t' : 'no-t'}"><b>${t('dc.st.' + p.status)}</b></span></div>`) : html`<div class="empty">${t('admin.cf.none')}</div>`}</div>`);
    hydrate(body);
  }
  const onClick = async (e) => {
    const b = e.target.closest('[data-cf]'); if (!b) return;
    try {
      if (b.dataset.cf === 'confirm') {
        if (!(await confirmDialog(t('admin.cf.confirmAsk', { amount: fmtMoney(+b.dataset.amount) }), { ok: t('admin.cf.confirm') }))) return;
        const note = await promptDialog(t('admin.dc.note')); if (note === null) return;
        await api('admin/cf/confirm', { id: b.dataset.id, action: 'confirm', note: note || '' });
      } else if (b.dataset.cf === 'reject') {
        const note = await promptDialog(t('admin.dc.rejectReason'), { required: true }); if (!note) return;
        await api('admin/cf/confirm', { id: b.dataset.id, action: 'reject', note });
      } else if (b.dataset.cf === 'adjust') {
        const c = await promptDialog(t('admin.cf.adjustCycle') + ` (${b.dataset.cycle})`, { required: true }); if (c === null) return;
        const tt = await promptDialog(t('admin.cf.adjustTotal') + ` (${b.dataset.total})`, { required: true }); if (tt === null) return;
        const cycle = Number(c), total = Number(tt);
        if (!Number.isInteger(cycle) || cycle < 0 || !Number.isInteger(total) || total < 0) { toast(t('err.bad_input'), true); return; }
        const note = await promptDialog(t('admin.dc.adjustNote'), { required: true }); if (!note) return;
        await api('admin/cf/adjust', { uid: b.dataset.uid, cycle, total, note });
      }
      toast(t('admin.dc.done')); load();
    } catch (err) { toast(errMsg(err), true); }
  };
  body.addEventListener('click', onClick); load();
  return () => { dead = true; body.removeEventListener('click', onClick); };
}
