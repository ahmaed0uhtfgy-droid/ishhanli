// تبويب «المواقع المربوطة» للأدمن: مواقع شريكة (متاجر) بتكلّم اشحنلي من السيرفر بمفتاح خاص. إنشاء/تعديل/تدوير مفتاح، وإيقاف/تفعيل روابط المتاجر مع الشركات، وآخر الطلبات.
import { api } from '../api.js';
import { t } from '../i18n.js';
import { html, render, toast, errMsg, fmtMoney, fmtDate, confirmDialog, promptDialog } from '../ui.js';

export function renderAdminPartners(body) {
  let dead = false, shownKey = null;
  async function load() {
    let d; try { d = await api('admin/partner/list', {}); } catch (e) { if (!dead) render(body, html`<div class="card"><p>${errMsg(e)}</p></div>`); return; }
    if (dead) return;
    render(body, html`${shownKey ? html`<div class="card stack"><div class="action info"><b>${t('admin.pt.keyOnce')}</b><p dir="ltr" style="word-break:break-all;user-select:all"><code>${shownKey}</code></p></div></div>` : ''}
      <div class="card stack"><h3>${t('admin.pt.title')}</h3><p class="muted small">${t('admin.pt.hint')}</p>
      ${d.sites.length ? d.sites.map((x) => html`<div class="row" style="padding:.4rem 0;border-bottom:1px solid var(--rule)"><b class="grow">${x.name}${x.enabled ? '' : html` <span class="no-t"><b>${t('admin.pt.off')}</b></span>`}<br><span class="muted small" dir="ltr">${x.url}</span><br><span class="muted small">${x.countFees ? t('admin.pt.counts') : t('admin.pt.noCount')} · ID: <bdi>${x.id}</bdi></span></b>
        <button class="btn sm" data-pt="toggle" data-id="${x.id}" data-name="${x.name}" data-url="${x.url}" data-en="${x.enabled}" data-cnt="${x.countFees}">${x.enabled ? t('admin.pt.disable') : t('admin.pt.enable')}</button>
        <button class="btn sm" data-pt="count" data-id="${x.id}" data-name="${x.name}" data-url="${x.url}" data-en="${x.enabled}" data-cnt="${x.countFees}">${x.countFees ? t('admin.pt.stopCount') : t('admin.pt.startCount')}</button>
        <button class="btn sm danger" data-pt="rotate" data-id="${x.id}">${t('admin.pt.rotate')}</button></div>`) : html`<div class="empty">${t('admin.cf.none')}</div>`}
      <h4>${t('admin.pt.add')}</h4><div class="grid-2"><label class="f">${t('admin.pt.name')}<input id="ptName" maxlength="80"></label><label class="f">${t('admin.pt.url')}<input id="ptUrl" dir="ltr" placeholder="https://" maxlength="200"></label></div>
      <button class="btn primary" data-pt="add">${t('admin.pt.addBtn')}</button></div>
      <div class="card stack"><h3>${t('admin.pt.links')}</h3>
      ${d.links.length ? d.links.map((l) => html`<div class="row small" style="padding:.3rem 0;border-bottom:1px solid var(--rule)"><span class="grow"><b>${l.merchant}</b> ← ${l.site} → <bdi>${l.companyId}</bdi> · ${fmtDate(l.createdAt)}</span><span class="${l.status === 'active' ? 'ok-t' : 'no-t'}"><b>${t('admin.pt.st.' + l.status)}</b></span>
        ${l.status === 'active' ? html`<button class="btn sm danger" data-pt="link" data-id="${l.id}" data-act="revoke">${t('admin.pt.revoke')}</button>` : l.status === 'revoked' ? html`<button class="btn sm" data-pt="link" data-id="${l.id}" data-act="activate">${t('admin.pt.activate')}</button>` : ''}</div>`) : html`<div class="empty">${t('admin.cf.none')}</div>`}</div>
      <div class="card stack"><h3>${t('admin.pt.orders')}</h3>
      ${d.orders.length ? d.orders.map((o) => html`<div class="row small"><span class="grow"><b>${o.merchant}</b> · ${o.site} · <bdi>${o.externalId}</bdi> · ${fmtMoney(o.amount)} · ${fmtDate(o.createdAt)}</span><span class="${o.status === 'active' ? 'ok-t' : 'no-t'}"><b>${o.status === 'active' ? (o.counted ? t('admin.pt.counted') : t('admin.pt.notCounted')) : t('admin.pt.st.cancelled')}</b></span></div>`) : html`<div class="empty">${t('admin.cf.none')}</div>`}</div>`);
  }
  const save = (x, patch) => api('admin/partner/save', { id: x.id, name: x.name, url: x.url, enabled: x.en === 'true', countFees: x.cnt === 'true', ...patch });
  const onClick = async (e) => {
    const b = e.target.closest('[data-pt]'); if (!b) return;
    try {
      const k = b.dataset.pt;
      if (k === 'add') {
        const name = body.querySelector('#ptName').value.trim(), url = body.querySelector('#ptUrl').value.trim();
        if (name.length < 2 || !/^https:\/\//i.test(url)) { toast(t('admin.pt.bad'), true); return; }
        shownKey = (await api('admin/partner/save', { name, url, enabled: true, countFees: true })).key;
      } else if (k === 'toggle') await save(b.dataset, { enabled: b.dataset.en !== 'true' });
      else if (k === 'count') await save(b.dataset, { countFees: b.dataset.cnt !== 'true' });
      else if (k === 'rotate') {
        if (!(await confirmDialog(t('admin.pt.rotateAsk'), { ok: t('admin.pt.rotate') }))) return;
        shownKey = (await api('admin/partner/rotate', { id: b.dataset.id })).key;
      } else if (k === 'link') {
        if (!(await confirmDialog(t('admin.pt.' + b.dataset.act + 'Ask'), { ok: t('admin.pt.' + b.dataset.act) }))) return;
        await api('admin/partner/link', { id: b.dataset.id, action: b.dataset.act });
      }
      toast(t('admin.dc.done')); load();
    } catch (err) { toast(errMsg(err), true); }
  };
  body.addEventListener('click', onClick); load();
  return () => { dead = true; body.removeEventListener('click', onClick); };
}
