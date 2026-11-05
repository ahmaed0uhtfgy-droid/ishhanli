import { api, poll } from '../api.js';
import { gpoll } from '../sync.js';
import { state } from '../state.js';
import { t, getLang } from '../i18n.js';
import '../i18n-admin.js'; // نصوص الأدمن بتتحمّل مع صفحة الأدمن بس
import { cleanSite, lpFacts, lpSlots, lpText, LP_FIELDS, LP_GROUPS, LP_SECTIONS } from '../landing-content.js';
import { $, $$, html, raw, render, toast, errMsg, busy, spinner, stamp, orderNo, fmtMoney, fmtNum, fmtDate, fmtDay, ratingText, trustBadge, confirmDialog, promptDialog, openModal, label } from '../ui.js';
import { hydrate, imgTag } from '../storage.js';
import { toCsv, downloadCsv, downloadJson } from '../csv.js';

const TABS = ['overview', 'finance', 'payments', 'users', 'joins', 'orders', 'withdrawals', 'disputes', 'refunds', 'reports', 'coupons', 'referrals', 'cod', 'dc', 'fines', 'settings', 'blacklist', 'audit', 'monitoring'];
const LEGACY_TABS = ['payments', 'withdrawals', 'disputes', 'refunds', 'cod']; // تبويبات نظام الضمان القديم: مخفية لما الدفع المباشر شغّال (إلا لو الأدمن فعّل إظهارها)
const legacyHidden = () => state.settings?.dcEnabled !== false && state.settings?.adminShowLegacy !== true;
const onError = (e) => toast(errMsg(e), true);
const imgs = (refs) => html`<div class="photos">${(refs || []).filter(Boolean).map((r) => raw(imgTag(r)))}</div>`;
const roleKey = (u) => (u.accountType === 'company' ? 'auth.roleCompany' : 'auth.role' + (u.role === 'driver' ? 'Driver' : 'Customer'));

export function renderAdmin(el, tab) {
  const shown = legacyHidden() ? TABS.filter((k) => !LEGACY_TABS.includes(k)) : TABS;
  if (!shown.includes(tab)) tab = 'overview';
  render(el, html`<div class="page-head"><h1>${t('admin.title')}</h1></div>
    <nav class="tabs">${shown.map((k) => html`<a href="#/admin/${k}" data-tab="${k}" class="${k === tab ? 'on' : ''}">${t('admin.tab.' + k)}<span class="dot" hidden></span></a>`)}</nav><div id="body">${spinner()}</div>`);
  // شارات الأعداد المعلّقة (استعلامات خفيفة على index الحالة) — كل 20 ثانية
  const badges = gpoll(['orders', 'users', 'withdrawals', 'disputes', 'refunds', 'reports'], () => api('admin/badges'), 20000, ({ badges: b }) => {
    for (const [k, n] of Object.entries(b)) { const d = $(`[data-tab="${k}"] .dot`, el); if (d) { d.textContent = n; d.hidden = !n; } }
    const dj = $('[data-tab="joins"] .dot', el); if (dj) { dj.textContent = b.users || 0; dj.hidden = !b.users; } // طلبات الانضمام = الحسابات المعلّقة
  }, { dedupe: true });
  const body = $('#body', el);
  const stop = { overview, finance, payments, users, joins, orders, withdrawals, disputes, refunds, reports, coupons, referrals, cod, dc, fines, settings, blacklist, audit, monitoring }[tab](body, badges);
  return () => { badges(); stop?.(); };
}

// =====================================================================  نظرة عامة (إحصائيات SQL على كل الطلبات)
function overview(body) {
  return gpoll(['orders', 'users', 'refunds'], () => api('admin/stats'), 120000, (s) => {
    const days = [...Array(14)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - (13 - i)); return d.toLocaleDateString('en-CA'); }); // YYYY-MM-DD
    const per = Object.fromEntries(s.perDay.map((x) => [x.d, x.n]));
    const perDay = days.map((d) => per[d] || 0), mx = Math.max(1, ...perDay), T = s.totals, money = (n) => (n == null ? '—' : fmtMoney(n));
    render(body, html`<div class="stack">
      ${(s.warnings || []).length ? html`<div class="action warn"><b>${t('admin.indexMissing')}</b><p class="hint">${t('admin.indexMissingHint')}</p>${s.warnings.map((w) => { const url = (w.detail.match(/https?:\/\/\S+/) || [])[0]; return html`<p class="small" dir="ltr" style="word-break:break-all">${w.what}: ${url ? html`<a href="${url}" target="_blank" rel="noopener">${url}</a>` : w.detail}</p>`; })}</div>` : ''}
      <div class="tiles">
        <div class="tile"><b>${T.total}</b><span>${t('admin.ordersTotal')}</span></div>
        <div class="tile"><b>${T.active}</b><span>${t('admin.ordersActive')}</span></div>
        <div class="tile"><b>${money(T.revenue)}</b><span>${t('admin.revenue')}</span></div>
        <div class="tile"><b>${money(T.commission)}</b><span>${t('admin.commissions')}</span></div>
        ${legacyHidden() ? '' : html`<div class="tile"><b>${money(T.held)}</b><span>${t('admin.escrowHeld')}</span></div>
        <div class="tile"><b>${money(s.refundsDue)}</b><span>${t('admin.refundsDue')}</span></div>`}
        <div class="tile"><b>${s.activeDrivers}</b><span>${t('admin.activeDrivers')}</span></div>
        <div class="tile"><b>${s.activeCustomers}</b><span>${t('admin.activeCustomers')}</span></div>
      </div>
      <div class="grid-2">
        <div class="card"><h3>${t('admin.last14')}</h3><div class="bars" role="img" aria-label="${t('admin.last14')}">${perDay.map((n) => raw(`<div data-n="${n}" style="height:${Math.max(3, (n / mx) * 100)}%"></div>`))}</div></div>
        <div class="card"><h3>${t('admin.topDrivers')}</h3>${s.topDrivers.length ? html`<table><tbody>${s.topDrivers.map((d) => html`<tr><td>${d.name}</td><td class="num">${d.n} ${t('admin.trips')}</td><td class="num">${fmtMoney(d.earned)}</td></tr>`)}</tbody></table>` : html`<p class="muted">—</p>`}</div>
      </div><p class="hint">${t('admin.statsNote')}</p></div>`);
  }, { dedupe: true, onError });
}

// =====================================================================  تقرير مالي لفترة (بتجميع Firestore، من غير Polling)
function finance(body) {
  const ymd = (d) => d.toLocaleDateString('en-CA'), today = new Date(), start = new Date(); start.setDate(start.getDate() - 29);
  let last = null;
  render(body, html`<div class="stack"><form class="row" id="ff" style="align-items:end;gap:.75rem"><label>${t('admin.fin.from')}<input type="date" name="from" value="${ymd(start)}" required></label><label>${t('admin.fin.to')}<input type="date" name="to" value="${ymd(today)}" required></label>
    <button class="btn" type="submit">${t('admin.fin.show')}</button><button class="btn ghost sm" type="button" id="csv" hidden>${t('admin.exportCsv')}</button></form><div id="fres"></div><p class="hint">${t('admin.fin.note')}</p></div>`);
  const f = $('#ff', body), csvBtn = $('#csv', body);
  f.addEventListener('submit', (e) => { e.preventDefault(); busy($('button[type=submit]', f), async () => {
    const from = new Date(f.from.value + 'T00:00:00').getTime(), end = new Date(f.to.value + 'T00:00:00'); end.setDate(end.getDate() + 1); // اليوم الأخير شامل
    if (!(from < end.getTime())) return toast(t('admin.fin.badRange'), true);
    const r = last = await api('admin/finance', { from, to: end.getTime() });
    csvBtn.hidden = false;
    render($('#fres', body), html`<div class="tiles">
      <div class="tile"><b>${r.orders}</b><span>${t('admin.fin.orders')}</span></div><div class="tile"><b>${fmtMoney(r.settledGross)}</b><span>${t('admin.fin.gross')}</span></div>
      <div class="tile"><b>${fmtMoney(r.commission)}</b><span>${t('admin.fin.commission')}</span></div><div class="tile"><b>${fmtMoney(r.driverNet)}</b><span>${t('admin.fin.driverNet')}</span></div>
      <div class="tile"><b>${fmtMoney(r.customerRefund)}</b><span>${t('admin.fin.refund')}</span></div><div class="tile"><b>${r.refunds.n} · ${fmtMoney(r.refunds.amount)}</b><span>${t('admin.fin.refReq')}</span></div>
      <div class="tile"><b>${r.withdrawals.n} · ${fmtMoney(r.withdrawals.amount)}</b><span>${t('admin.fin.wdReq')}</span></div></div>`);
  }); });
  csvBtn.addEventListener('click', () => { if (!last) return; const r = last, d = (ms) => new Date(ms).toISOString().slice(0, 10);
    downloadCsv(`finance-${d(r.from)}_${d(r.to - 1)}.csv`, toCsv([{ h: t('admin.fin.metric'), v: (x) => x[0] }, { h: t('admin.fin.value'), v: (x) => x[1] }], [
      [t('admin.fin.from'), d(r.from)], [t('admin.fin.to'), d(r.to - 1)], [t('admin.fin.orders'), r.orders], [t('admin.fin.gross'), r.settledGross], [t('admin.fin.commission'), r.commission], [t('admin.fin.driverNet'), r.driverNet],
      [t('admin.fin.refund'), r.customerRefund], [t('admin.fin.refReq') + ' (#)', r.refunds.n], [t('admin.fin.refReq'), r.refunds.amount], [t('admin.fin.wdReq') + ' (#)', r.withdrawals.n], [t('admin.fin.wdReq'), r.withdrawals.amount]])); });
}

// =====================================================================  المدفوعات (مراجعة إثبات التحويل)
function payments(body) {
  const p = gpoll(['orders'], () => api('orders/list', { status: 'payment_review' }), 12000, ({ orders: rows }) => {
    render(body, rows.length ? html`<div class="stack">${rows.map((o) => html`<div class="card"><div class="row"><b>${orderNo(o.id)}</b><span>${o.customerName}</span><span class="grow"></span><b style="font:700 1.4rem var(--font-display)">${fmtMoney(o.price)}</b></div>
      <p class="muted small">${t('order.payRef')}: <b>${o.paymentRef || '—'}</b> — ${fmtDate(o.paymentSubmittedAt)}</p>${imgs([o.paymentProof])}
      <div class="row" style="margin-top:.8rem"><button class="btn ok" data-act="confirm" data-id="${o.id}">${t('admin.confirmPay')}</button><button class="btn danger" data-act="reject" data-id="${o.id}">${t('admin.rejectPay')}</button><a class="btn ghost" href="#/order/${o.id}">${t('admin.open')}</a></div></div>`)}</div>` : html`<div class="empty">${t('admin.nonePayments')}</div>`);
    hydrate(body);
  }, { dedupe: true, onError });
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    busy(b, async () => {
      let note = '';
      if (b.dataset.act === 'reject') { note = await promptDialog(t('admin.rejectReason'), { required: true }); if (note === null) return; }
      await api('admin/payment', { orderId: b.dataset.id, action: b.dataset.act, note }); toast(t('common.done')); await p.now();
    });
  });
  return p;
}

// =====================================================================  المستخدمين (الفلترة على السيرفر)
function users(body, badges) {
  render(body, html`<div class="row" style="margin-bottom:1rem"><select id="fr" style="max-width:160px"><option value="">${t('admin.allRoles')}</option><option value="customer">${t('auth.roleCustomer')}</option><option value="driver">${t('auth.roleDriver')}</option></select>
    <select id="fs" style="max-width:170px"><option value="">${t('admin.allStatus')}</option>${['pending', 'active', 'rejected', 'banned', 'suspended'].map((s) => html`<option value="${s}">${t('status.' + s)}</option>`)}</select>
    <input id="fq" placeholder="${t('admin.searchUsers')}" style="max-width:200px"><input id="fd" type="date" style="max-width:150px" aria-label="${t('admin.fin.from')}" title="${t('admin.fin.from')}"><input id="fto" type="date" style="max-width:150px" aria-label="${t('admin.fin.to')}" title="${t('admin.fin.to')}"></div><div id="tbl">${spinner()}</div>`);
  let all = [], timer = null;
  const inRange = () => { const f = $('#fd', body).value, tt = $('#fto', body).value; const fms = f ? new Date(f + 'T00:00:00').getTime() : 0, tms = tt ? new Date(tt + 'T23:59:59.999').getTime() : 0; return (ms) => (!fms || (ms || 0) >= fms) && (!tms || (ms || 0) <= tms); };
  const paint = () => { const ok = inRange(), rows = all.filter((u) => ok(u.createdAt)); render($('#tbl', body), rows.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('auth.name')}</th><th>${t('admin.role')}</th><th>${t('auth.phone')}</th><th>${t('admin.status')}</th><th>${t('admin.rating')}</th><th>${t('trust.title')}</th><th>${t('admin.joined')}</th><th></th></tr></thead>
    <tbody>${rows.map((u) => html`<tr><td>${u.name}${u.latePoints > 0 ? html` <span class="stamp s-pending">${t('late.pts', { n: u.latePoints })}</span>` : ''}</td><td>${t(roleKey(u))}</td><td dir="ltr">${u.phone}</td><td>${stamp(u.status)}</td><td>${ratingText(u)}</td><td>${u.trust ? trustBadge(u.trust) : '—'}</td><td class="small">${fmtDate(u.createdAt)}</td><td><button class="btn sm ${u.status === 'pending' ? 'primary' : 'ghost'}" data-id="${u.id}">${t('admin.review')}</button></td></tr>`)}</tbody></table></div>` : html`<div class="empty">${t('admin.noneUsers')}</div>`); };
  async function load() {
    try { all = (await api('admin/users', { role: $('#fr', body).value, status: $('#fs', body).value, q: $('#fq', body).value })).users; paint(); }
    catch (e) { render($('#tbl', body), html`<div class="empty">${errMsg(e)}</div>`); }
  }
  ['#fr', '#fs'].forEach((s) => $(s, body).addEventListener('change', load));
  ['#fd', '#fto'].forEach((s) => $(s, body).addEventListener('change', paint)); // فلتر التاريخ في الذاكرة (من غير فهارس مركّبة)
  $('#fq', body).addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 350); });
  body.addEventListener('click', (e) => { const b = e.target.closest('[data-id]'); if (b) userModal(all.find((u) => u.id === b.dataset.id), async () => { await load(); badges.now(); }); });
  load();
  return () => clearTimeout(timer);
}

// =====================================================================  طلبات الانضمام (سواقين وشركات شحن معلّقين) — مستنداتهم ظاهرة مباشرة للمراجعة
function joins(body, badges) {
  let cur = [];
  const p = gpoll(['users'], () => api('admin/users', { status: 'pending' }), 20000, ({ users: rows }) => {
    cur = rows.filter((u) => u.status === 'pending');
    render(body, cur.length ? html`<div class="stack">${cur.map((u) => html`<div class="card stack">
      <div class="row"><h3 class="grow">${u.accountType === 'company' ? (u.companyName || u.name) : u.name}</h3><span class="stamp s-pending">${t(roleKey(u))}</span></div>
      <dl class="kv"><dt>${t('auth.name')}</dt><dd>${u.name}</dd><dt>${t('auth.phone')}</dt><dd dir="ltr">${u.phone}</dd><dt>${t('auth.nationalId')}</dt><dd dir="ltr">${u.nationalId}</dd>
        ${u.role === 'driver' && u.vehicleType ? html`<dt>${t('auth.vehicleType')}</dt><dd>${t('vehicle.' + u.vehicleType)}</dd>` : ''}<dt>${t('admin.joinedAt')}</dt><dd>${fmtDate(u.createdAt)}</dd></dl>
      ${imgs([u.idRef, u.licenseRef, u.vehicleRegRef, u.vehiclePhotoRef, u.selfieRef, u.commercialRegRef, u.taxCardRef].filter(Boolean))}
      <div class="row"><button class="btn ok" data-d="active" data-id="${u.id}">${t('admin.approve')}</button><button class="btn danger" data-d="rejected" data-id="${u.id}">${t('admin.reject')}</button><button class="btn ghost sm" data-open="${u.id}">${t('admin.review')}</button></div></div>`)}</div>` : html`<div class="empty">${t('admin.noJoins')}</div>`);
    hydrate(body);
  }, { dedupe: true, onError });
  body.addEventListener('click', (e) => {
    const o = e.target.closest('[data-open]');
    if (o) return void userModal(cur.find((u) => u.id === o.dataset.open), async () => { await p.now?.(); badges.now(); });
    const b = e.target.closest('[data-d]'); if (!b) return;
    busy(b, async () => {
      try {
        let reason = '';
        if (b.dataset.d === 'rejected') { reason = await promptDialog(t('admin.rejectReason'), { required: true }); if (reason === null) return; }
        await api('admin/user', { uid: b.dataset.id, status: b.dataset.d, reason, blacklist: false });
        toast(t('common.done')); await p.now?.(); badges.now();
      } catch (er) { onError(er); }
    });
  });
  return p;
}

function userModal(u, reload) {
  if (!u) return;
  const docsRefs = [['auth.idPhoto', u.idRef], ['auth.license', u.licenseRef], ['auth.vehicleReg', u.vehicleRegRef], ['auth.vehiclePhoto', u.vehiclePhotoRef], ['auth.selfieId', u.selfieRef], ['auth.officialDoc', u.commercialRegRef], ['auth.taxCard', u.taxCardRef]].filter(([, r]) => r);
  const { el, close } = openModal(html`<div class="row"><h3 class="grow">${u.name}</h3>${stamp(u.status)}</div>
    <dl class="kv"><dt>${t('admin.role')}</dt><dd>${t(roleKey(u))}</dd><dt>${t('auth.phone')}</dt><dd dir="ltr">${u.phone} ${u.phoneVerified ? '✓' : ''}</dd>
      <dt>${t('auth.nationalId')}</dt><dd dir="ltr">${u.nationalId}</dd><dt>${t('auth.email')}</dt><dd dir="ltr">${u.email}</dd><dt>${t('auth.area')}</dt><dd>${u.area || '—'}</dd>
      ${u.vehicleType ? html`<dt>${t('auth.vehicleType')}</dt><dd>${t('vehicle.' + u.vehicleType)}</dd>` : ''}${u.companyName ? html`<dt>${t('auth.companyName')}</dt><dd>${u.companyName}</dd>` : ''}
      ${u.trust ? html`<dt>${t('trust.title')}</dt><dd>${trustBadge(u.trust)}</dd>` : ''}<dt>${t('admin.trips')}</dt><dd>${u.completedOrders || 0}</dd><dt>${t('admin.cancels')}</dt><dd>${u.cancelCount || 0}</dd>${u.role === 'driver' ? html`<dt>${t('late.points')}</dt><dd>${u.latePoints || 0}</dd>` : ''}<dt>${t('admin.rating')}</dt><dd>${ratingText(u)}</dd>
      ${u.statusReason ? html`<dt>${t('status.reason')}</dt><dd>${u.statusReason}</dd>` : ''}</dl>
    <h3 style="margin-top:1rem">${t('admin.documents')}</h3>
    <div class="stack">${docsRefs.map(([k, r]) => html`<div><div class="muted small">${t(k)}</div>${imgs([r])}</div>`)}</div>
    ${u.accountType === 'company' ? html`<h3 style="margin-top:1rem">${t('fleet.listTitle')}</h3><div id="fleetBox">${spinner()}</div>` : ''}
    ${u.role === 'driver' ? html`<h3 style="margin-top:1rem">${t('late.adminTitle')}</h3><div id="lateBox">${spinner()}</div>` : ''}
    <label class="f" style="margin-top:1rem">${t('admin.reason')}<input id="reason"></label>
    <label class="row" style="margin-top:.5rem"><input type="checkbox" id="bl"> <span class="small">${t('admin.addBlacklist')}</span></label>
    <div class="action" style="margin-top:1rem"><h3>${t('admin.profileEdit')}</h3>
      <p class="hint">${t('admin.profileEditLast')}: ${u.profileEditedAt ? fmtDate(u.profileEditedAt) : '—'}</p>
      <label class="f" style="max-width:260px">${t('admin.profileEditCustom')}<input id="peDays" type="number" min="0" max="365" value="${u.profileEditDays ?? ''}" placeholder="—"></label>
      <div class="row" style="margin-top:.5rem"><button class="btn ghost sm" type="button" data-pe="save">${t('common.save')}</button><button class="btn ok sm" type="button" data-pe="unlock">${t('admin.profileEditUnlock')}</button></div>
      <p class="err" id="peerr" role="alert"></p></div>
    <div class="row end"><button class="btn ghost" data-s="close">${t('common.close')}</button>
      ${u.status !== 'active' ? html`<button class="btn ok" data-s="active">${t('admin.approve')}</button>` : ''}
      ${u.status === 'pending' ? html`<button class="btn danger" data-s="rejected">${t('admin.reject')}</button>` : ''}
      ${u.status !== 'banned' ? html`<button class="btn danger" data-s="banned">${t('admin.ban')}</button>` : ''}</div>`, { wide: true });
  hydrate(el);
  if (u.role === 'driver') api('late/list', { uid: u.id }).then((r) => { // نقاط التأخير اللي العميل سجّلها (الحظر من الزرار اللي تحت، والمسح من هنا)
    render($('#lateBox', el), html`<p>${t('late.points')}: <b>${r.points}</b> ${state.settings?.latePointsLimit > 0 && r.points >= state.settings.latePointsLimit ? html`<span class="stamp s-banned">${t('late.reviewNeeded')}</span>` : ''}</p>
      ${r.items.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('order.title')}</th><th>${t('late.kind')}</th><th>${t('late.due')}</th><th>${t('late.graceShort')}</th><th>${t('late.when')}</th></tr></thead>
        <tbody>${r.items.map((i) => html`<tr><td><a href="#/order/${i.orderId}">${orderNo(i.orderId)}</a></td><td>${t('late.' + i.kind)}</td><td class="small">${fmtDate(i.dueAt)}</td><td>${fmtNum(i.graceMin, 0)} ${t('late.min')}</td><td class="small">${fmtDate(i.at)}</td></tr>`)}</tbody></table></div>` : html`<p class="muted small">${t('late.none')}</p>`}
      ${r.points ? html`<button class="btn ghost sm" type="button" data-late="clear">${t('late.clear')}</button>` : ''}`);
  }).catch(() => {});
  if (u.accountType === 'company') api('admin/fleet', { uid: u.id }).then(({ drivers }) => { // سواقين الشركة ببياناتهم ومستنداتهم (حتى الموقوفين: السجل بيفضل)
    render($('#fleetBox', el), drivers.length ? html`<div class="stack">${drivers.map((d) => html`<div class="card stack"><div class="row"><b class="grow">${d.name}</b>${d.active ? '' : html`<span class="stamp s-banned">${t('fleet.removed')}</span>`}</div>
      <div class="muted small" dir="ltr">${d.phone} · ${d.nationalId} · ${d.plate}</div>${imgs([d.idRef, d.licenseRef, d.vehiclePhotoRef])}</div>`)}</div>` : html`<div class="empty">${t('fleet.empty')}</div>`);
    hydrate($('#fleetBox', el));
  }).catch((er) => { const b = $('#fleetBox', el); if (b) b.textContent = errMsg(er); });
  el.addEventListener('click', (e) => {
    const pe = e.target.closest('[data-pe]');
    if (pe) return void busy(pe, async () => {
      try {
        if (pe.dataset.pe === 'unlock') await api('admin/profile-edit', { uid: u.id, unlock: true });
        else { const raw = $('#peDays', el).value.trim(); await api('admin/profile-edit', { uid: u.id, days: raw === '' ? null : Number(raw) }); }
        toast(t('common.done')); close(); reload();
      } catch (er) { $('#peerr', el).textContent = errMsg(er); }
    });
    const lc = e.target.closest('[data-late]');
    if (lc) return void busy(lc, async () => {
      if (!(await confirmDialog(t('late.clearConfirm'), { ok: t('late.clear') }))) return;
      try { await api('admin/late_clear', { uid: u.id, note: $('#reason', el).value.trim() }); toast(t('common.done')); close(); reload(); } catch (er) { toast(errMsg(er), true); }
    });
    const b = e.target.closest('[data-s]'); if (!b) return; if (b.dataset.s === 'close') return close();
    busy(b, async () => {
      await api('admin/user', { uid: u.id, status: b.dataset.s, reason: $('#reason', el).value, blacklist: $('#bl', el).checked });
      toast(t('common.done')); close(); reload();
    });
  });
}

// =====================================================================  كل الطلبات (بحث + عرض المزيد + تصدير)
function orders(body) {
  let limit = 100, q = '', last = [], tm;
  render(body, html`<div class="row" style="margin-bottom:1rem"><select id="fs" style="max-width:220px"><option value="">${t('admin.allStatus')}</option>${['awaiting_payment', 'open', 'accepted', 'payment_review', 'paid', 'heading_pickup', 'picked_up', 'in_transit', 'delivered', 'completed', 'disputed', 'resolved', 'cancelled'].map((s) => html`<option value="${s}">${t('status.' + s)}</option>`)}</select>
    <input id="qs" type="search" placeholder="${t('admin.searchOrders')}" style="max-width:240px"><input id="od" type="date" style="max-width:150px" aria-label="${t('admin.fin.from')}" title="${t('admin.fin.from')}"><input id="ot" type="date" style="max-width:150px" aria-label="${t('admin.fin.to')}" title="${t('admin.fin.to')}"><button class="btn ghost sm" id="csv">${t('admin.exportCsv')}</button></div><div id="tbl">${spinner()}</div><div class="row" id="more" hidden style="justify-content:center;margin-top:1rem"><button class="btn ghost" id="moreb">${t('admin.loadMore')}</button></div>`);
  const sel = $('#fs', body), qs = $('#qs', body), more = $('#more', body);
  const inRange = () => { const f = $('#od', body).value, tt = $('#ot', body).value; const fms = f ? new Date(f + 'T00:00:00').getTime() : 0, tms = tt ? new Date(tt + 'T23:59:59.999').getTime() : 0; return (ms) => (!fms || (ms || 0) >= fms) && (!tms || (ms || 0) <= tms); };
  const p = gpoll(['orders'], () => api('orders/list', { status: sel.value, q, limit }), 15000, ({ orders: rows }) => {
    const ok = inRange(), shown = rows.filter((o) => ok(o.createdAt));
    last = shown; // التصدير بيطلع النتائج المعروضة (بعد فلتر التاريخ)
    more.hidden = !(rows.length >= limit && limit < 300 && !q);
    render($('#tbl', body), shown.length ? html`<div class="table-wrap"><table><thead><tr><th>#</th><th>${t('admin.status')}</th><th>${t('order.customer')}</th><th>${t('order.driver')}</th><th>${t('order.price')}</th><th>${t('admin.date')}</th><th></th></tr></thead>
      <tbody>${shown.map((o) => html`<tr><td>${orderNo(o.id)}</td><td>${stamp(o.status, o.service, o.direct)}</td><td>${o.customerName}</td><td>${o.driverName || '—'}</td><td class="num">${fmtMoney(o.price)}</td><td class="small">${fmtDate(o.createdAt)}</td><td><a class="btn sm ghost" href="#/order/${o.id}">${t('admin.open')}</a></td></tr>`)}</tbody></table></div>` : html`<div class="empty">${t('admin.noneOrders')}</div>`);
  }, { dedupe: true, onError });
  ['#od', '#ot'].forEach((s) => $(s, body).addEventListener('change', () => p.now()));
  sel.addEventListener('change', () => { limit = 100; p.now(); });
  qs.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => { q = qs.value.trim(); limit = 100; p.now(); }, 350); }); // بحث بعد ما تبطّل تكتب
  $('#moreb', body).addEventListener('click', () => { limit = Math.min(300, limit + 100); p.now(); });
  $('#csv', body).addEventListener('click', () => downloadCsv('orders.csv', toCsv([
    { h: '#', v: (o) => orderNo(o.id) }, { h: t('admin.status'), v: (o) => t('status.' + o.status) }, { h: t('order.customer'), v: (o) => o.customerName }, { h: t('auth.phone'), v: (o) => o.customerPhone },
    { h: t('order.driver'), v: (o) => o.driverName }, { h: t('order.price'), v: (o) => o.price }, { h: t('admin.date'), v: (o) => new Date(o.createdAt).toISOString() },
  ], last)));
  return p;
}

// =====================================================================  طلبات السحب (تحديد عدّة طلبات وتأكيدها مرة واحدة + تصدير)
function withdrawals(body) {
  const sel = new Set(); let last = [];
  const upd = () => { const b = $('#batch', body); if (b) { b.disabled = !sel.size; b.textContent = t('admin.payBatch', { n: sel.size }); } };
  const p = gpoll(['withdrawals'], () => api('admin/withdrawals'), 15000, ({ withdrawals: rows }) => {
    last = rows;
    for (const id of [...sel]) if (!rows.some((w) => w.id === id && w.status === 'pending')) sel.delete(id); // اللي اتعالج مبقاش متحدد
    render(body, rows.length ? html`<div class="row" style="margin-bottom:1rem"><button class="btn ok" id="batch" disabled>${t('admin.payBatch', { n: sel.size })}</button><button class="btn ghost sm" id="csv">${t('admin.exportCsv')}</button></div>
      <div class="table-wrap"><table><thead><tr><th></th><th>${t('admin.date')}</th><th>${t('order.driver')}</th><th>${t('wallet.amount')}</th><th>${t('wallet.method')}</th><th>${t('wallet.account')}</th><th>${t('admin.status')}</th><th></th></tr></thead>
      <tbody>${rows.map((w) => html`<tr><td>${w.status === 'pending' ? html`<input type="checkbox" data-sel="${w.id}" ${sel.has(w.id) ? 'checked' : ''} aria-label="${t('admin.selectPending')}">` : ''}</td><td class="small">${fmtDate(w.createdAt)}</td><td>${w.name}<div class="small muted" dir="ltr">${w.phone}</div></td><td class="num"><b>${fmtMoney(w.amount)}</b></td><td>${t('method.' + w.method)}</td><td dir="ltr">${w.account}</td><td>${stamp(w.status)}</td>
      <td>${w.status === 'pending' ? html`<div class="row"><button class="btn sm ok" data-a="paid" data-id="${w.id}">${t('admin.markPaid')}</button><button class="btn sm danger" data-a="reject" data-id="${w.id}">${t('admin.reject')}</button></div>` : w.note || ''}</td></tr>`)}</tbody></table></div>` : html`<div class="empty">${t('admin.noneWithdrawals')}</div>`);
    upd();
  }, { dedupe: true, onError });
  body.addEventListener('change', (e) => { const c = e.target.closest('[data-sel]'); if (!c) return; if (c.checked) sel.add(c.dataset.sel); else sel.delete(c.dataset.sel); upd(); });
  body.addEventListener('click', (e) => {
    if (e.target.closest('#csv')) return downloadCsv('withdrawals.csv', toCsv([
      { h: t('admin.date'), v: (w) => new Date(w.createdAt).toISOString() }, { h: t('order.driver'), v: (w) => w.name }, { h: t('auth.phone'), v: (w) => w.phone }, { h: t('wallet.amount'), v: (w) => w.amount },
      { h: t('wallet.method'), v: (w) => t('method.' + w.method) }, { h: t('wallet.account'), v: (w) => w.account }, { h: t('admin.status'), v: (w) => w.status },
    ], last));
    const bb = e.target.closest('#batch');
    if (bb) return busy(bb, async () => { // تأكيد تحويل عدّة طلبات مرة واحدة (بنكلّم السيرفر طلب طلب، وبنعرض كام نجح وكام فشل)
      const ids = [...sel], total = last.filter((w) => sel.has(w.id)).reduce((a, w) => a + w.amount, 0);
      if (!ids.length || !(await confirmDialog(t('admin.confirmBatch', { n: ids.length, total: fmtMoney(total) })))) return;
      let ok = 0, fail = 0;
      for (const id of ids) { try { await api('admin/withdrawal', { id, action: 'paid', note: '' }); ok++; sel.delete(id); } catch { fail++; } }
      toast(t('admin.batchDone', { ok, fail }), fail > 0); await p.now();
    });
    const b = e.target.closest('[data-a]'); if (!b) return;
    busy(b, async () => {
      let note = '';
      if (b.dataset.a === 'reject') { note = await promptDialog(t('admin.rejectReason'), { required: true }); if (note === null) return; }
      else if (!(await confirmDialog(t('admin.confirmTransfer')))) return;
      await api('admin/withdrawal', { id: b.dataset.id, action: b.dataset.a, note }); toast(t('common.done')); await p.now();
    });
  });
  return p;
}

// =====================================================================  الاسترجاع (تحويل يدوي على InstaPay)
function refunds(body) {
  let last = [];
  const p = gpoll(['refunds'], () => api('admin/refunds'), 15000, ({ refunds: rows }) => {
    last = rows;
    render(body, rows.length ? html`<div class="row" style="margin-bottom:1rem"><button class="btn ghost sm" id="csv">${t('admin.exportCsv')}</button></div><div class="table-wrap"><table><thead><tr><th>${t('admin.date')}</th><th>${t('order.customer')}</th><th>#</th><th>${t('wallet.amount')}</th><th>${t('admin.reason')}</th><th>${t('admin.status')}</th><th></th></tr></thead>
      <tbody>${rows.map((r) => html`<tr><td class="small">${fmtDate(r.createdAt)}</td><td>${r.customerName}<div class="small muted" dir="ltr">${r.customerPhone}</div></td><td><a href="#/order/${r.orderId}">${orderNo(r.orderId)}</a></td><td class="num"><b>${fmtMoney(r.amount)}</b></td><td>${t('refund.reason.' + r.reason)}</td>
      <td><span class="stamp s-${r.status === 'paid' ? 'active' : 'pending'}">${t(r.status === 'paid' ? 'refund.done' : 'refund.wait')}</span></td>
      <td>${r.status === 'pending' ? html`<button class="btn sm ok" data-id="${r.id}" data-amount="${r.amount}">${t('admin.markRefunded')}</button>` : r.note || ''}</td></tr>`)}</tbody></table></div>` : html`<div class="empty">${t('admin.noneRefunds')}</div>`);
  }, { dedupe: true, onError });
  body.addEventListener('click', (e) => {
    if (e.target.closest('#csv')) return downloadCsv('refunds.csv', toCsv([
      { h: t('admin.date'), v: (r) => new Date(r.createdAt).toISOString() }, { h: t('order.customer'), v: (r) => r.customerName }, { h: t('auth.phone'), v: (r) => r.customerPhone }, { h: '#', v: (r) => orderNo(r.orderId) },
      { h: t('wallet.amount'), v: (r) => r.amount }, { h: t('admin.reason'), v: (r) => r.reason }, { h: t('admin.status'), v: (r) => r.status },
    ], last));
    const b = e.target.closest('[data-id]'); if (!b) return;
    busy(b, async () => {
      const note = await promptDialog(t('admin.confirmRefund', { amount: fmtMoney(b.dataset.amount) }) + ' — ' + t('order.payRef'));
      if (note === null) return;
      await api('admin/refund', { id: b.dataset.id, note }); toast(t('common.done')); await p.now();
    });
  });
  return p;
}

// =====================================================================  البلاغات والطوارئ
function reports(body, badges) {
  const tel = (p) => (p ? html`<a href="tel:${String(p).replace(/[^0-9+]/g, '')}" dir="ltr">${p}</a>` : '—');
  const who = (x) => html`${x?.name || '—'} ${tel(x?.phone)}`;
  const p = gpoll(['reports'], () => api('admin/reports'), 10000, ({ reports: rs, sos }) => {
    render(body, html`<div class="stack">
      <h3>${t('admin.sosTitle')}</h3>
      ${sos.length ? sos.map((e) => html`<div class="card ${e.status === 'open' ? 'sos-card' : 'flat'}"><div class="row"><b>${orderNo(e.orderId)}</b><a class="small" href="#/order/${e.orderId}">${t('admin.open')}</a><span class="grow"></span>
        <span class="stamp s-${e.status === 'open' ? 'disputed' : 'completed'}">${e.status === 'open' ? t('admin.sosTitle') : t('admin.handled')}</span></div>
        <dl class="kv"><dt>${t('admin.sosBy')}</dt><dd>${who(e.by)}</dd><dt>${t('order.customer')}</dt><dd>${who(e.customer)}</dd><dt>${t('order.driver')}</dt><dd>${who(e.driver)}</dd>
        <dt>${t('admin.location')}</dt><dd>${e.lat != null ? html`<a href="https://www.openstreetmap.org/?mlat=${e.lat}&mlon=${e.lng}#map=17/${e.lat}/${e.lng}" target="_blank" rel="noopener">${fmtNum(e.lat, 4)}, ${fmtNum(e.lng, 4)}</a>` : '—'} · ${fmtDate(e.updatedAt)}</dd>
        ${e.pickup?.address ? html`<dt>${t('order.pickup')}</dt><dd>${e.pickup.address}</dd>` : ''}${e.note ? html`<dt>${t('admin.reason')}</dt><dd>${e.note}</dd>` : ''}</dl>
        ${e.status === 'open' ? html`<button class="btn ok sm" data-sos="${e.id}">${t('admin.handled')}</button>` : ''}</div>`) : html`<p class="muted">—</p>`}
      <h3 style="margin-top:1rem">${t('admin.reportsTitle')}</h3>
      ${rs.length ? rs.map((r) => html`<div class="card"><div class="row"><b>${orderNo(r.orderId)}</b><a class="small" href="#/order/${r.orderId}">${t('admin.open')}</a><span class="grow"></span>${stamp(r.status === 'open' ? 'pending' : r.status === 'resolved' ? 'active' : 'rejected')}</div>
        <p><b>${t('report.reason.' + r.reason)}</b> <span class="muted small">· ${fmtDate(r.createdAt)}</span></p>${r.details ? html`<p>${r.details}</p>` : ''}
        <dl class="kv"><dt>${t('admin.reporter')}</dt><dd>${who(r.reporter)}</dd><dt>${t('admin.reportedUser')}</dt><dd>${who(r.target)}</dd></dl>
        ${r.context?.chat?.length ? html`<details class="muted small"><summary>${t('chat.title')} (${r.context.chat.length})</summary><ul class="log">${r.context.chat.map((m) => html`<li><span><b>${t('chat.' + m.from)}:</b> ${m.body}</span><span>${fmtDate(m.at)}</span></li>`)}</ul></details>` : ''}
        ${r.adminNote ? html`<p class="small"><b>${t('admin.reason')}:</b> ${r.adminNote}</p>` : ''}
        ${r.status === 'open' ? html`<div class="row" style="margin-top:.6rem"><button class="btn ok sm" data-rep="${r.id}" data-a="resolve">${t('admin.resolve')}</button><button class="btn ghost sm" data-rep="${r.id}" data-a="dismiss">${t('admin.dismiss')}</button>
          <button class="btn ghost sm" data-user="${r.target.uid}" data-s="pending">${t('admin.suspendUser')}</button><button class="btn danger sm" data-user="${r.target.uid}" data-s="banned">${t('admin.banUser')}</button></div>` : ''}</div>`) : html`<div class="empty">${t('admin.noneReports')}</div>`}</div>`);
  }, { dedupe: true, onError });
  body.addEventListener('click', (e) => {
    const sos = e.target.closest('[data-sos]'), rep = e.target.closest('[data-rep]'), usr = e.target.closest('[data-user]');
    const done = async () => { toast(t('common.done')); await p.now(); badges?.now?.(); };
    if (sos) busy(sos, async () => { const note = await promptDialog(t('admin.noteHint')); if (note === null) return; await api('admin/sos-handle', { id: sos.dataset.sos, note }); await done(); });
    if (rep) busy(rep, async () => { const note = await promptDialog(t('admin.noteHint')); if (note === null) return; await api('admin/report', { id: rep.dataset.rep, action: rep.dataset.a, note }); await done(); });
    if (usr) busy(usr, async () => { const note = await promptDialog(t('admin.reason'), { required: true }); if (note === null) return; await api('admin/user', { uid: usr.dataset.user, status: usr.dataset.s, reason: note }); await done(); });
  });
  return p;
}

// =====================================================================  النزاعات
function disputes(body) {
  const p = gpoll(['disputes', 'orders'], () => api('admin/disputes'), 15000, ({ disputes: rows }) => {
    if (!rows.length) { render(body, html`<div class="empty">${t('admin.noneDisputes')}</div>`); return; }
    render(body, html`<div class="stack">${rows.map((d) => html`<div class="card"><div class="row"><b>${orderNo(d.orderId)}</b><a href="#/order/${d.orderId}" class="small">${t('admin.open')}</a><span class="grow"></span>${stamp(d.status)}</div>
      <p><b>${t('dispute.reason.' + d.reason)}</b> — <span class="muted small">${t('dispute.openedBy')}: ${t('auth.role' + (d.openedByRole === 'driver' ? 'Driver' : 'Customer'))} · ${fmtDate(d.createdAt)}</span></p>
      ${d.details ? html`<p>${d.details}</p>` : ''}${d.evidence?.length ? imgs(d.evidence) : ''}
      ${d.chat?.length ? html`<details class="muted small"><summary>${t('chat.title')} (${d.chat.length})</summary><ul class="log">${d.chat.map((m) => html`<li><span><b>${t('chat.' + m.from)}:</b> ${m.body}</span><span>${fmtDate(m.at)}</span></li>`)}</ul></details>` : ''}
      ${d.order ? html`<details class="muted small"><summary>${t('dispute.orderContext')}</summary><dl class="kv" style="margin:.6rem 0"><dt>${t('order.price')}</dt><dd>${fmtMoney(d.order.price)}</dd><dt>${t('order.customer')}</dt><dd>${d.order.customerName} <span dir="ltr">${d.order.customerPhone}</span></dd><dt>${t('order.driver')}</dt><dd>${d.order.driverName} <span dir="ltr">${d.order.driverPhone}</span></dd></dl>
        ${imgs([...(d.order.photos || []), d.order.pickupPhoto, d.order.deliveryPhoto])}<ul class="log">${(d.order.log || []).map((l) => html`<li><span>${t('status.' + l.status)}${l.lat ? html` <a href="https://www.openstreetmap.org/?mlat=${l.lat}&mlon=${l.lng}#map=17/${l.lat}/${l.lng}" target="_blank" rel="noopener">📍</a>` : ''}</span><span>${fmtDate(l.at)}</span></li>`)}</ul></details>` : ''}
      ${d.status === 'open' ? html`<div class="action" style="margin-top:1rem"><div class="grid-2"><label class="f">${t('dispute.decision')}<select data-f="dec"><option value="refund">${t('dispute.decision.refund')}</option><option value="release">${t('dispute.decision.release')}</option><option value="split">${t('dispute.decision.split')}</option></select></label>
        <label class="f" data-f="pctw" hidden>${t('dispute.customerPct')}<input type="number" data-f="pct" min="1" max="99" value="50"></label></div>
        <label class="f" style="margin-top:.6rem">${t('dispute.note')}<textarea data-f="note" maxlength="500"></textarea></label><button class="btn primary" style="margin-top:.6rem" data-resolve="${d.id}">${t('dispute.resolve')}</button></div>`
        : html`<div class="action good" style="margin-top:1rem"><b>${t('dispute.decision.' + d.decision)}</b>${d.decision === 'split' ? ` (${d.customerPct}% ${t('dispute.toCustomer')})` : ''} — ${t('dispute.refundDue')}: <b>${fmtMoney(d.customerRefund)}</b> · ${t('order.driverNet')}: <b>${fmtMoney(d.driverNet)}</b>
        ${d.note ? html`<p class="small">${d.note}</p>` : ''}${d.customerRefund > 0 ? (d.refundPaid ? html`<p class="small">✓ ${t('dispute.refundDone')}</p>` : html`<button class="btn sm ok" data-refund="${d.id}">${t('dispute.markRefunded')}</button>`) : ''}</div>`}</div>`)}</div>`);
    hydrate(body);
  }, { dedupe: true, onError });
  body.addEventListener('change', (e) => { if (e.target.matches('[data-f=dec]')) e.target.closest('.action').querySelector('[data-f=pctw]').hidden = e.target.value !== 'split'; });
  body.addEventListener('click', (e) => {
    const r = e.target.closest('[data-resolve]'), f = e.target.closest('[data-refund]');
    if (r) { const c = r.closest('.action'); busy(r, async () => {
      if (!(await confirmDialog(t('dispute.confirmResolve'), { danger: true }))) return;
      await api('admin/dispute', { id: r.dataset.resolve, decision: $('[data-f=dec]', c).value, customerPct: $('[data-f=pct]', c).value, note: $('[data-f=note]', c).value }); toast(t('common.done')); await p.now();
    }); }
    if (f) busy(f, async () => { await api('admin/dispute-refund', { id: f.dataset.refund }); toast(t('common.done')); await p.now(); });
  });
  return p;
}

// =====================================================================  الإعدادات (تسعير + عمولة) — الفحص النهائي على السيرفر
// =====================================================================  الدفع عند الاستلام (كشوف السواقين + التحويل للمرسلين)
// =====================================================================  غرامات العملاء وتعويض السواقين: اعتراضات + قرارات + تصحيح
function fines(body) {
  let dead = false;
  const claimRow = (x, actions) => html`<div class="card stack"><div class="row"><b class="grow">${orderNo(x.orderId)} · ${t('fine.kind.' + x.kind)}</b><b>${fmtMoney(x.amount)}</b><span class="${['applied', 'open', 'customer_paid'].includes(x.status) ? 'no-t' : 'ok-t'}"><b>${t('fine.claim.' + x.status)}</b></span></div>
    <p class="muted small">${t('admin.dc.title')}: <b>${x.driverName || x.driverId}</b> → <b>${x.customerName || x.customerId}</b> · ${fmtDate(x.createdAt)}${x.status === 'applied' ? html` · ${t('fine.driverCredit')}: ${fmtMoney(x.credit)} · ${fmtMoney(x.remaining)}` : ''}</p>${x.objectNote ? html`<p class="small"><b>${t('fine.objectBtn')}:</b> ${x.objectNote}</p>` : ''}
    ${actions ? html`<div class="row">${actions}</div>` : ''}</div>`;
  const btns = (x) => html`${x.status === 'applied' ? html`<button class="btn ok sm" data-fn="waive" data-id="${x.id}">${t('admin.fines.waive')}</button><button class="btn ghost sm" data-fn="settle" data-id="${x.id}">${t('admin.fines.settle')}</button>` : ''}${['open', 'customer_paid', 'applied'].includes(x.status) ? html`<button class="btn danger sm" data-fn="reject" data-id="${x.id}">${t('admin.fines.reject')}</button>` : ''}`;
  async function load() {
    let d; try { d = await api('admin/fines/list', {}); } catch (e) { if (!dead) render(body, html`<div class="card"><p>${errMsg(e)}</p></div>`); return; }
    if (dead) return;
    render(body, html`<div class="card stack"><h3>${t('admin.fines.title')}</h3><p class="hint">${t('admin.fines.hint')}</p></div>
      <div class="card stack"><h3>${t('admin.fines.objected')}</h3>${d.objected.length ? d.objected.map((x) => claimRow(x, btns(x))) : html`<div class="empty">${t('admin.fines.noObjected')}</div>`}</div>
      <div class="card stack"><h3>${t('admin.fines.customers')}</h3>${d.customers.length ? d.customers.map((u) => html`<div class="row" style="padding:.4rem 0;border-bottom:1px solid var(--rule)"><b class="grow">${u.name || u.id}<br><span class="muted small" dir="ltr">${u.phone || ''}</span></b><b>${fmtMoney(u.due)}</b><button class="btn sm ghost" data-fn="adjust" data-uid="${u.id}" data-due="${u.due}">${t('admin.fines.adjust')}</button></div>`) : html`<div class="empty">${t('admin.fines.noCustomers')}</div>`}</div>
      <div class="card stack"><h3>${t('admin.fines.recent')}</h3>${d.recent.length ? d.recent.map((x) => claimRow(x, btns(x))) : html`<div class="empty">${t('fine.none')}</div>`}</div>`);
    hydrate(body);
  }
  const onClick = async (e) => {
    const b = e.target.closest('[data-fn]'); if (!b) return;
    try {
      if (b.dataset.fn === 'adjust') {
        const v = await promptDialog(t('admin.fines.adjustAsk') + ` (${b.dataset.due})`, { required: true }); if (v === null) return;
        const due = Number(v); if (!Number.isInteger(due) || due < 0) { toast(t('err.bad_input'), true); return; }
        const note = await promptDialog(t('admin.fines.adjustNote'), { required: true }); if (!note) return;
        await api('admin/fines/adjust', { uid: b.dataset.uid, due, note });
      } else {
        const note = await promptDialog(t('admin.fines.reasonAsk'), { required: b.dataset.fn === 'reject' }); if (note === null || (b.dataset.fn === 'reject' && !note)) return;
        await api('admin/fines/decide', { id: b.dataset.id, action: b.dataset.fn, note: note || '' });
      }
      toast(t('admin.dc.done')); load();
    } catch (err) { onError(err); }
  };
  body.addEventListener('click', onClick); load();
  return () => { dead = true; body.removeEventListener('click', onClick); };
}

// =====================================================================  عمولات السواقين (الدفع المباشر): مراجعة صور التحويل + أرصدة السواقين + تصحيح يدوي
function dc(body) {
  let dead = false;
  async function load() {
    let d; try { d = await api('admin/dc/list', {}); } catch (e) { if (!dead) render(body, html`<div class="card"><p>${errMsg(e)}</p></div>`); return; }
    if (dead) return;
    render(body, html`<div class="card stack"><h3>${t('admin.dc.title')}</h3>
      ${d.enabled ? '' : html`<div class="action info">${t('admin.dc.off')}</div>`}
      <p class="muted small">${t('admin.dc.rate', { pct: d.pct, limit: fmtNum(d.limit, 0) })}</p></div>
      <div class="card stack"><h3>${t('admin.dc.pending')}</h3>
      ${d.pending.length ? d.pending.map((p) => html`<div class="card stack"><div class="row"><b class="grow">${p.name || p.driverId}</b><b>${fmtMoney(p.amount)}</b></div>
        <p class="muted small">${t('dc.method.' + p.method)} · ${t('dc.ref')}: <b dir="ltr">${p.reference}</b> · ${t('admin.dc.gross')}: ${fmtMoney(p.gross)} (${p.pct}%) · ${fmtDate(p.createdAt)}</p>${imgs([p.proof])}
        <div class="row"><button class="btn ok" data-dc="confirm" data-id="${p.id}" data-amount="${p.amount}" data-gross="${p.gross}">${t('admin.dc.confirm')}</button><button class="btn danger" data-dc="reject" data-id="${p.id}">${t('admin.dc.reject')}</button></div></div>`) : html`<div class="empty">${t('admin.dc.none')}</div>`}</div>
      <div class="card stack"><h3>${t('admin.dc.drivers')}</h3>
      ${d.drivers.length ? d.drivers.map((x) => html`<div class="row" style="padding:.4rem 0;border-bottom:1px solid var(--rule)"><b class="grow">${x.name || x.id}${x.blocked ? html` <span class="no-t"><b>${t('admin.dc.blocked')}</b></span>` : ''}<br><span class="muted small" dir="ltr">${x.phone || ''}</span></b>
        <span class="small">${t('admin.dc.earned')}: <b>${fmtMoney(x.gross)}</b> · ${t('admin.dc.due')}: <b>${fmtMoney(x.due)}</b>${x.km > 0 ? html` · ${t('admin.dc.km')}: <b>${fmtNum(x.km)}</b>${x.kmFee > 0 ? html` (${fmtMoney(x.kmFee)})` : ''}` : ''}${x.kmTotal > 0 ? html` · ${t('admin.dc.kmTotal')}: <b>${fmtNum(x.kmTotal)}</b>` : ''}${x.credit > 0 ? html` · ${t('admin.dc.credit')}: <b>${fmtMoney(x.credit)}</b>` : ''}${x.finesHeld > 0 ? html` · ${t('admin.dc.held')}: <b>${fmtMoney(x.finesHeld)}</b>` : ''}</span><button class="btn sm ghost" data-dc="adjust" data-uid="${x.id}" data-gross="${x.gross}">${t('admin.dc.adjust')}</button></div>`) : html`<div class="empty">${t('admin.dc.noDrivers')}</div>`}</div>
      <div class="card stack"><h3>${t('admin.dc.recent')}</h3>
      ${d.recent.length ? d.recent.map((p) => html`<div class="row small"><span class="grow"><b>${p.name || p.driverId}</b> · ${fmtMoney(p.amount)} · ${t('dc.method.' + p.method)} · <bdi>${p.reference}</bdi> · ${fmtDate(p.decidedAt || p.createdAt)}${p.note ? ' · ' + p.note : ''}</span><span class="${p.status === 'paid' ? 'ok-t' : 'no-t'}"><b>${t('dc.st.' + p.status)}</b></span></div>`) : html`<div class="empty">${t('admin.dc.none')}</div>`}</div>`);
    hydrate(body);
  }
  const onClick = async (e) => {
    const b = e.target.closest('[data-dc]'); if (!b) return;
    try {
      if (b.dataset.dc === 'confirm') {
        if (!(await confirmDialog(t('admin.dc.confirmAsk', { amount: fmtMoney(+b.dataset.amount), gross: fmtMoney(+b.dataset.gross) }), { ok: t('admin.dc.confirm') }))) return;
        const note = await promptDialog(t('admin.dc.note')); if (note === null) return;
        await api('admin/dc/confirm', { id: b.dataset.id, action: 'confirm', note: note || '' });
      } else if (b.dataset.dc === 'reject') {
        const note = await promptDialog(t('admin.dc.rejectReason'), { required: true }); if (!note) return;
        await api('admin/dc/confirm', { id: b.dataset.id, action: 'reject', note });
      } else if (b.dataset.dc === 'adjust') {
        const v = await promptDialog(t('admin.dc.adjustAsk') + ` (${b.dataset.gross})`, { required: true }); if (v === null) return;
        const gross = Number(v); if (!Number.isInteger(gross) || gross < 0) { toast(t('err.bad_input'), true); return; }
        const note = await promptDialog(t('admin.dc.adjustNote'), { required: true }); if (!note) return;
        await api('admin/dc/adjust', { uid: b.dataset.uid, gross, note });
      }
      toast(t('admin.dc.done')); load();
    } catch (err) { onError(err); }
  };
  body.addEventListener('click', onClick); load();
  return () => { dead = true; body.removeEventListener('click', onClick); };
}

function cod(body) {
  let dead = false;
  const stCls = (x) => (x === 'overdue' ? 'no-t' : x === 'paid' ? 'ok-t' : 'muted');
  async function load() {
    let d; try { d = await api('admin/cod/list', {}); } catch (e) { if (!dead) render(body, html`<div class="card"><p>${errMsg(e)}</p></div>`); return; }
    if (dead) return;
    render(body, html`<div class="card stack"><h3>${t('admin.cod.title')}</h3>
      ${d.enabled ? '' : html`<div class="action info">${t('admin.cod.off')}</div>`}
      <p class="muted small">${t('cod.driverHint', { days: d.periodDays, grace: d.graceDays })} · ${t('cod.commission')}: <bdi>${d.pct}%</bdi></p>
      ${d.truncated ? html`<p class="muted small">${t('admin.cod.truncated')}</p>` : ''}</div>
      <div class="card stack"><h3>${t('admin.cod.drivers')}</h3>
      ${d.drivers.length ? html`<div class="tbl-wrap">${d.drivers.map((dr) => html`<div class="stack" style="gap:.3rem;padding:.5rem 0;border-bottom:1px solid var(--rule)">
        <div class="row"><b class="grow">${dr.name || dr.driverId}</b>${dr.blocked ? html`<span class="no-t"><b>${t('admin.cod.blocked')}</b></span>` : ''}<span class="muted small">${t('cod.collectedLbl')}: <b>${fmtMoney(dr.collected)}</b></span></div>
        ${dr.statements.map((x) => html`<div class="row small"><span class="grow">${fmtDay(x.start)} → ${fmtDay(x.end - 1)} · ${t('cod.collectedLbl')}: <b>${fmtMoney(x.collected)}</b> (${fmtNum(x.count, 0)})${x.commission > 0 ? html` · ${t('cod.commission')}: ${fmtMoney(x.commission)}` : ''}${x.ref ? html` · <bdi>${x.ref}</bdi>` : ''}</span><span class="${stCls(x.status)}"><b>${t('cod.st.' + x.status)}</b></span>${x.status !== 'paid' ? html`<button class="btn sm primary" data-cod-confirm="${dr.driverId}|${x.period}|${x.collected}">${t('admin.cod.confirm')}</button>` : ''}</div>`)}</div>`)}</div>` : html`<p class="muted">${t('admin.cod.empty')}</p>`}</div>
      <div class="card stack"><h3>${t('admin.cod.payouts')}</h3>
      ${d.payouts.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>${t('admin.cod.col.order')}</th><th>${t('admin.cod.col.customer')}</th><th>${t('admin.cod.col.amount')}</th><th>${t('admin.cod.col.commission')}</th><th>${t('admin.cod.col.net')}</th><th>${t('admin.cod.col.status')}</th><th></th></tr></thead><tbody>
        ${d.payouts.map((p) => html`<tr><td><a href="#/order/${p.orderId}">${p.no}</a></td><td>${p.customerName || p.customerId}</td><td>${fmtMoney(p.amount)}</td><td>${fmtMoney(p.commission)}</td><td><b>${fmtMoney(p.net)}</b></td><td class="${p.status === 'paid' ? 'ok-t' : ''}">${t('admin.cod.st.' + p.status)}${p.ref ? html` <bdi class="muted small">${p.ref}</bdi>` : ''}</td><td>${p.status === 'due' ? html`<button class="btn sm primary" data-cod-payout="${p.orderId}">${t('admin.cod.payout')}</button>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">${t('admin.cod.empty')}</p>`}</div>`);
  }
  const onClick = async (e) => {
    const c = e.target.closest('[data-cod-confirm]'), p = e.target.closest('[data-cod-payout]');
    try {
      if (c) {
        const [driverId, period, amount] = c.dataset.codConfirm.split('|');
        if (!(await confirmDialog(t('admin.cod.confirmAsk', { amount: fmtMoney(+amount) }), { ok: t('admin.cod.confirm') }))) return;
        const note = await promptDialog(t('admin.cod.note')); if (note === null) return;
        await api('admin/cod/confirm', { driverId, period, note: note || '' }); toast(t('admin.cod.done')); load();
      } else if (p) {
        const ref = await promptDialog(t('admin.cod.payoutRef'), { required: true }); if (!ref) return;
        await api('admin/cod/payout', { orderId: p.dataset.codPayout, ref }); toast(t('admin.cod.done')); load();
      }
    } catch (err) { onError(err); }
  };
  body.addEventListener('click', onClick); load();
  return () => { dead = true; body.removeEventListener('click', onClick); };
}

// =====================================================================  الإحالة والحوافز
function referrals(body) {
  return gpoll(['referrals'], () => api('admin/referrals'), 30000, ({ config, pending, rewarded, paid, rows }) => {
    const roleName = (rl) => t('auth.role' + (rl === 'driver' ? 'Driver' : 'Customer'));
    render(body, html`<div class="stack">
      <div class="tiles">
        <div class="tile"><b>${fmtNum(pending)}</b><span>${t('admin.ref.pending')}</span></div>
        <div class="tile"><b>${fmtNum(rewarded)}</b><span>${t('admin.ref.rewarded')}</span></div>
        <div class="tile"><b>${fmtMoney(paid.referrer)}</b><span>${t('admin.ref.paidReferrer')}</span></div>
        <div class="tile"><b>${fmtMoney(paid.referred)}</b><span>${t('admin.ref.paidReferred')}</span></div>
      </div>
      ${config.enabled ? '' : html`<p class="action info">${t('admin.refOff')}</p>`}
      <div class="card"><p class="hint">${t('admin.ref.hint', { r: fmtMoney(config.bonusReferrer), d: fmtMoney(config.bonusReferred) })} <a href="#/admin/settings">${t('admin.tab.settings')}</a></p></div>
      ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('admin.ref.when')}</th><th>${t('admin.ref.user')}</th><th>${t('admin.ref.by')}</th><th>${t('admin.ref.status')}</th><th>${t('admin.ref.bonus')}</th></tr></thead>
        <tbody>${rows.map((r) => html`<tr><td class="small">${fmtDate(r.createdAt)}</td><td>${r.userName} <span class="mut small">(${roleName(r.role)})</span></td><td>${r.referrerName} <span class="mut small">(${roleName(r.referrerRole)})</span></td><td>${r.status === 'rewarded' ? html`<span class="stamp s-active">${t('admin.ref.rewarded')}</span>` : html`<span class="stamp s-pending">${t('admin.ref.pending')}</span>`}</td><td class="small">${r.status === 'rewarded' ? html`${fmtMoney(r.bonusReferrer)} / ${fmtMoney(r.bonusReferred)}` : '—'}</td></tr>`)}</tbody></table></div>` : html`<div class="empty">${t('admin.ref.none')}</div>`}
    </div>`);
  }, { dedupe: true, onError });
}

// ---- واجهة الموقع (الصفحة الرئيسية): التصميم الفعّال، الوضع الافتراضي، الأقسام، النصوص، السيو ----
const SITE_SEC = { estimate: ['حاسبة السعر', 'Price estimator'], services: ['الخدمات', 'Services'], trust: ['الثقة', 'Trust'], join: ['السواقين والشركات', 'Drivers and companies'], faq: ['الأسئلة الشائعة', 'FAQ'], contact: ['التواصل (بيظهر لو فيه بيانات)', 'Contact (shown when data exists)'] };
export function siteCard(S) {
  const en = getLang() === 'en', site = cleanSite(S.site), L = (ar, e) => (en ? e : ar);
  const slots = lpSlots(lpFacts(S, { DELIVERY_CODE_SECRET: S.deliveryCodeAvailable }));
  const dflt = (id) => (slots[id] ? lpText(slots[id].key, slots[id].vars, 'ar').replace(/\*/g, '') : '');
  return html`<div class="card stack" id="siteCard"><h3>${L('واجهة الموقع (الصفحة الرئيسية)', 'Website front page')}</h3>
    <p class="hint">${L('اختار التصميم الفعّال ووضعه الافتراضي، واظهر/اخفي الأقسام، وعدّل النصوص. الحقل الفاضي = النص التلقائي من النظام (وبيتغيّر لوحده لو غيّرت إعدادات الدفع أو الخدمات). التعديل بيظهر خلال دقيقة تقريباً.', 'Choose the active design and its default mode, show or hide sections and edit texts. An empty field uses the automatic text from the system (it follows your payment and service settings). Changes show within about a minute.')}</p>
    <div class="grid-3"><label class="f">${L('التصميم الفعّال', 'Active design')}<select name="site.design"><option value="a" ${site.design === 'a' ? 'selected' : ''}>${L('التصميم 1 (فاتح)', 'Design 1 (light)')}</option><option value="b" ${site.design === 'b' ? 'selected' : ''}>${L('التصميم 2 (ليلي)', 'Design 2 (dark)')}</option></select></label>
      <label class="f">${L('الوضع الافتراضي للزائر', 'Default visitor mode')}<select name="site.mode"><option value="auto" ${site.mode === 'auto' ? 'selected' : ''}>${L('تلقائي (وضع التصميم الأصلي)', 'Auto (the design’s own mode)')}</option><option value="light" ${site.mode === 'light' ? 'selected' : ''}>${L('نهاري', 'Light')}</option><option value="dark" ${site.mode === 'dark' ? 'selected' : ''}>${L('ليلي', 'Dark')}</option></select></label>
      <label class="f">${L('رابط اللوجو (https، اختياري)', 'Logo URL (https, optional)')}<input name="site.logoUrl" dir="ltr" maxlength="300" value="${site.logoUrl}" placeholder="/img/logo.png"></label></div>
    <p class="hint"><a href="/?preview=a" target="_blank" rel="noopener">${L('معاينة التصميم 1', 'Preview design 1')}</a> · <a href="/?preview=b" target="_blank" rel="noopener">${L('معاينة التصميم 2', 'Preview design 2')}</a> ${L('(من غير تفعيل، وبدون فهرسة)', '(without activating; not indexed)')}</p>
    <div class="row" style="flex-wrap:wrap;gap:1rem">${LP_SECTIONS.map((id) => html`<label class="row"><input type="checkbox" name="site.show.${id}" ${site.hide.includes(id) ? '' : 'checked'}> <span>${L(SITE_SEC[id][0], SITE_SEC[id][1])}</span></label>`)}</div>
    <div class="grid-2"><label class="f">${L('عنوان الصفحة في جوجل (حتى 70 حرف)', 'Google title (up to 70 chars)')}<input name="site.seo.title" maxlength="70" value="${site.seo.title}"></label>
      <label class="f">${L('وصف الصفحة في جوجل (حتى 200 حرف)', 'Google description (up to 200 chars)')}<input name="site.seo.description" maxlength="200" value="${site.seo.description}"></label></div>
    <div class="grid-2"><label class="f">${L('رمز توثيق Google Search Console (قيمة content فقط)', 'Google Search Console verification token (the content value only)')}<input name="site.seo.google" dir="ltr" maxlength="100" value="${site.seo.google}"></label>
      <label class="f">${L('رمز توثيق Bing Webmaster (قيمة content فقط)', 'Bing Webmaster verification token (the content value only)')}<input name="site.seo.bing" dir="ltr" maxlength="100" value="${site.seo.bing}"></label></div>
    ${LP_GROUPS.map(([g, ar, e]) => html`<details><summary>${L(ar, e)}</summary><div class="stack" style="margin-top:.6rem">${LP_FIELDS.filter((x) => x.group === g).map((x) => html`<label class="f">${L(x.ar, x.en)}${x.long ? html`<textarea name="site.t.${x.id}" rows="3" maxlength="600" placeholder="${dflt(x.id)}">${site.texts[x.id] || ''}</textarea>` : html`<input name="site.t.${x.id}" maxlength="160" placeholder="${dflt(x.id)}" value="${site.texts[x.id] || ''}">`}</label>`)}</div></details>`)}
    <p class="hint">${L('نصيحة: حط *كلمة* بين نجمتين لإبرازها. النص المعدّل بيظهر بنفس الشكل في العربي والإنجليزي.', 'Tip: wrap *a word* in stars to highlight it. An edited text is shown as typed in both languages.')}</p></div>`;
}
export const readSite = (f) => ({ design: f.elements['site.design'].value, mode: f.elements['site.mode'].value, logoUrl: f.elements['site.logoUrl'].value.trim(), hide: LP_SECTIONS.filter((id) => !f.elements['site.show.' + id].checked),
  seo: { title: f.elements['site.seo.title'].value.trim(), description: f.elements['site.seo.description'].value.trim(), google: f.elements['site.seo.google'].value.trim(), bing: f.elements['site.seo.bing'].value.trim() }, texts: Object.fromEntries(LP_FIELDS.map((x) => [x.id, f.elements['site.t.' + x.id].value.trim()])) });

function settings(body) {
  const S = state.settings;
  const kvRow = (k, v = {}, seats = false) => html`<tr><td><input data-k value="${k}" ${k ? 'readonly' : ''} placeholder="key" style="min-width:110px"></td><td><input data-ar value="${v.ar || ''}"></td><td><input data-en value="${v.en || ''}" dir="ltr"></td><td><input data-m type="number" step="0.05" min="0.1" value="${v.mult ?? 1}" style="width:90px"></td>${seats ? html`<td><input data-seats type="number" min="1" max="100" value="${v.seats ?? 4}" style="width:80px"></td>` : ''}<td><button type="button" class="btn ghost sm" data-del>✕</button></td></tr>`;
  const kvRows = (name, obj, seats = false) => html`<div class="table-wrap"><table data-kv="${name}" data-seats="${seats ? 1 : 0}"><thead><tr><th>${t('admin.key')}</th><th>عربي</th><th>English</th><th>${t('admin.mult')}</th>${seats ? html`<th>${t('admin.seats')}</th>` : ''}<th></th></tr></thead><tbody>
    ${Object.entries(obj || {}).map(([k, v]) => kvRow(k, v, seats))}</tbody></table></div><button type="button" class="btn ghost sm" data-add="${name}" style="margin-top:.5rem">+ ${t('admin.addRow')}</button>`;
  const num = (n, k, step = 'any', min = 0) => html`<label class="f">${t('admin.s.' + k)}<input type="number" name="${n}" step="${step}" min="${min}" value="${n.split('.').reduce((o, p) => o?.[p], S) ?? ''}" required></label>`;
  render(body, html`<form id="sf" class="stack"><div class="card stack"><h3>${t('admin.pricing')}</h3><div class="formula" style="margin:0">${t('landing.formula')}</div>
    <div class="grid-3">${num('perKm', 'perKm')}${num('minPrice', 'minPrice')}${num('commissionPct', 'commissionPct')}</div>
    <div class="grid-3">${num('newDriver.orders', 'newDriverOrders', 1)}${num('newDriver.commissionPct', 'newDriverPct')}${num('roadFactor', 'roadFactor', 0.05, 1)}</div></div>
    <div class="card stack"><h3>${t('admin.categories')}</h3>${kvRows('categories', S.categories)}</div>
    <div class="card stack"><h3>${t('admin.sizes')}</h3>${kvRows('sizes', S.sizes)}</div>
    <div class="card stack"><h3>${t('admin.vguide.title')}</h3><p class="hint">${t('admin.vguide.hint')}</p>
      <label class="row"><input type="checkbox" name="companionAsk" ${S.companionAsk !== false ? 'checked' : ''}> <span>${t('admin.s.companionAsk')}</span></label>
      <label class="row"><input type="checkbox" name="vehicleGuideOn" ${S.vehicleGuideOn !== false ? 'checked' : ''}> <span>${t('admin.s.vehicleGuideOn')}</span></label>
      <div class="grid-2">${['pickup', 'half_ton', 'jumbo', 'truck'].map((k) => html`<div class="stack"><b>${t('vehicle.' + k)}</b>
        <label class="f">${t('admin.vguide.maxKg')}<input type="number" name="vg.${k}.maxKg" min="0" max="100000" step="1" inputmode="numeric" value="${S.vehicleGuide?.[k]?.maxKg ?? 0}" required></label>
        <label class="f">${t('admin.vguide.size')}<select name="vg.${k}.size">${Object.entries(S.sizes || {}).map(([sk, sv]) => html`<option value="${sk}" ${S.vehicleGuide?.[k]?.size === sk ? 'selected' : ''}>${label(sv, sk)}</option>`)}</select></label></div>`)}</div></div>
    <div class="card stack"><h3>${t('admin.cod.settingsTitle')}</h3><p class="hint">${t('admin.cod.settingsHint')}</p>
      <label class="row"><input type="checkbox" name="codEnabled" ${S.codEnabled === true ? 'checked' : ''}> <span>${t('admin.s.codEnabled')}</span></label>
      <div class="grid-2"><label class="f">${t('admin.s.codPct')}<input type="number" name="codCommissionPct" min="0" max="30" step="0.1" inputmode="decimal" value="${S.codCommissionPct ?? 0}" required></label>
        <label class="f">${t('admin.s.codMax')}<input type="number" name="codMaxAmount" min="100" max="1000000" step="1" inputmode="numeric" value="${S.codMaxAmount ?? 5000}" required></label>
        <label class="f">${t('admin.s.codPeriod')}<input type="number" name="codPeriodDays" min="1" max="31" step="1" inputmode="numeric" value="${S.codPeriodDays ?? 7}" required></label>
        <label class="f">${t('admin.s.codGrace')}<input type="number" name="codGraceDays" min="0" max="30" step="1" inputmode="numeric" value="${S.codGraceDays ?? 3}" required></label></div>
      <label class="f">${t('admin.s.codScope')}<select name="codBlockScope"><option value="cod" ${S.codBlockScope !== 'all' ? 'selected' : ''}>${t('admin.s.codScope.cod')}</option><option value="all" ${S.codBlockScope === 'all' ? 'selected' : ''}>${t('admin.s.codScope.all')}</option></select></label></div>
    <div class="card stack"><h3>${t('admin.vp.title')}</h3><p class="hint">${t('admin.vp.hint')}</p>
      ${['pickup', 'half_ton', 'jumbo', 'truck'].map((k) => { const cur = S.vehiclePricing?.[k] || {}, gz = S.sizes?.[S.vehicleGuide?.[k]?.size]; return html`<div class="stack" style="gap:.3rem;border-top:1px solid var(--rule);padding-top:.5rem"><b>${t('vehicle.' + k)}</b>
        <p class="hint">${t('admin.vp.current', { perKm: fmtNum((S.perKm || 0) * Number(gz?.mult || 1)), min: fmtNum(S.minPrice || 0) })}</p>
        <div class="grid-2">${[['base', cur.base], ['perKm', cur.perKm], ['minPrice', cur.minPrice], ['kmFee', cur.kmFee]].map(([f, v]) => html`<label class="f">${t('admin.vp.' + f)}<input type="number" name="vp.${k}.${f}" min="0" max="${f === 'perKm' || f === 'kmFee' ? 10000 : 1000000}" step="0.1" inputmode="decimal" value="${v ?? 0}" required></label>`)}</div></div>`; })}
      <label class="f">${t('admin.s.dcPerKm')}<input type="number" name="dcPerKm" min="0" max="10000" step="0.1" inputmode="decimal" value="${S.dcPerKm ?? 0}" required></label>
      <label class="row"><input type="checkbox" name="fineCreditToWallet" ${S.fineCreditToWallet === true ? 'checked' : ''}> <span>${t('admin.s.fineCreditToWallet')}</span></label></div>
    <div class="card stack"><h3>${t('admin.fines.settingsTitle')}</h3><p class="hint">${t('admin.fines.settingsHint')}</p>
      <label class="row"><input type="checkbox" name="finesEnabled" ${S.finesEnabled === true ? 'checked' : ''}> <span>${t('admin.s.finesEnabled')}</span></label>
      <div class="grid-2">${[['fineFreeCancelMin', 1440, 1], ['fineWaitMin', 1440, 1], ['fineEnRouteAmount', 100000, 1], ['fineArrivedAmount', 100000, 1], ['fineClaimHours', 720, 1], ['fineObjectHours', 720, 1], ['fineDriverSharePct', 99, 0.5], ['fineCollectorPct', 50, 0.5], ['fineMonthlyCap', 1000000, 1], ['fineMaxClaimsPerDay', 1000, 1], ['fineBlockLimit', 1000000, 1], ['samePickupMeters', 5000, 1], ['samePickupMax', 50, 1]].map(([k, max, step]) => html`<label class="f">${t('admin.s.' + k)}<input type="number" name="${k}" min="0" max="${max}" step="${step}" inputmode="decimal" value="${S[k] ?? 0}" required></label>`)}</div></div>
    <div class="card stack"><h3>${t('admin.radius.title')}</h3><p class="hint">${t('admin.radius.hint')}</p>
      <label class="f">${t('admin.s.jobsRadiusKm')}<input type="number" name="jobsRadiusKm" min="0" max="500" step="0.5" inputmode="decimal" value="${S.jobsRadiusKm ?? 15}" required></label></div>
    <div class="card stack"><h3>${t('admin.dc.settingsTitle')}</h3><p class="hint">${t('admin.dc.settingsHint')}</p>
      <label class="row"><input type="checkbox" name="dcEnabled" ${S.dcEnabled === true ? 'checked' : ''}> <span>${t('admin.s.dcEnabled')}</span></label>
      <label class="row"><input type="checkbox" name="adminShowLegacy" ${S.adminShowLegacy === true ? 'checked' : ''}> <span>${t('admin.s.showLegacy')}</span></label>
      <div class="grid-2"><label class="f">${t('admin.s.dcPct')}<input type="number" name="dcPct" min="0" max="50" step="0.1" inputmode="decimal" value="${S.dcPct ?? 2}" required></label>
        <label class="f">${t('admin.s.dcLimit')}<input type="number" name="dcLimit" min="1" max="100000000" step="1" inputmode="numeric" value="${S.dcLimit ?? 1000}" required></label>
        <label class="f">${t('admin.s.dcAutoHours')}<input type="number" name="dcAutoCompleteHours" min="0" max="720" step="1" inputmode="numeric" value="${S.dcAutoCompleteHours ?? 24}" required></label>
        <label class="f">${t('admin.s.dcWallet')}<input name="dcPay.wallet" maxlength="40" dir="ltr" value="${S.dcPay?.wallet || ''}"></label>
        <label class="f">${t('admin.s.dcWalletName')}<input name="dcPay.walletName" maxlength="80" value="${S.dcPay?.walletName || ''}"></label></div></div>
    <div class="card stack"><h3>${t('admin.passengers')}</h3>
      <label class="row"><input type="checkbox" name="passengersEnabled" ${S.passengersEnabled ? 'checked' : ''}> <span>${t('admin.s.passengersEnabled')}</span></label><p class="hint">${t('admin.paxLegal')}</p>
      ${kvRows('passengerClasses', S.passengerClasses, true)}</div>
    <div class="card stack"><h3>${t('admin.levelDiscount')}</h3><p class="hint">${t('admin.levelDiscountHint')}</p>
      <div class="grid-3">${num('levelDiscountPct.trusted', 'disc.trusted', 0.5, 0)}${num('levelDiscountPct.pro', 'disc.pro', 0.5, 0)}${num('levelDiscountPct.elite', 'disc.elite', 0.5, 0)}</div></div>
      <div class="card stack"><h3>${t('admin.trustRules')}</h3><p class="hint">${t('admin.trustRulesHint')}</p>
        <div class="grid-3">${['trusted', 'pro', 'elite'].map((k) => html`<div class="stack"><b>${t('trust.level.' + k)}</b>${num(`trustRules.${k}.avg`, 'trustAvg', 0.1, 1)}${num(`trustRules.${k}.ratings`, 'trustRatings', 1, 1)}</div>`)}</div></div>
    <div class="card stack"><h3>${t('admin.cancelFees')}</h3><p class="hint">${t('admin.cancelFeesHint')}</p>
      <div class="grid-2">${num('cancelPaidDriverPct', 'cancelPaidDriver', 1, 0)}${num('cancelPaidPlatformPct', 'cancelPaidPlatform', 1, 0)}</div>
      <div class="grid-2">${num('cancelHeadingDriverPct', 'cancelHeadingDriver', 1, 0)}${num('cancelHeadingPlatformPct', 'cancelHeadingPlatform', 1, 0)}</div></div>
    <div class="card stack"><h3>${t('admin.rules')}</h3><div class="grid-3">${num('geofenceMeters', 'geofence', 10)}${num('maxCancellations', 'maxCancel', 1, 1)}${num('minWithdraw', 'minWithdraw', 1, 1)}${num('latePointsLimit', 'latePoints', 1, 0)}</div>
      <div class="grid-3">${num('offerMinPct', 'offerMin', 1, 10)}${num('offerMaxPct', 'offerMax', 1, 100)}${num('dispatchRadiusKm', 'dispatchRadius', 1, 1)}</div>
      <div class="grid-3">${num('dispatchMaxDrivers', 'dispatchMax', 1, 1)}${num('prepaidGraceMin', 'prepaidGrace', 1, 0)}${num('autoReleaseHours', 'autoRelease', 1, 0)}</div>
      <h4>${t('admin.s.guardTitle')}</h4><div class="grid-3">${num('mismatchCompensation', 'mismatchComp', 1, 0)}${num('mismatchMaxPer30d', 'mismatchMax', 1, 1)}${num('maxActiveJobs', 'maxActive', 1, 1)}${num('avgSpeedKmh', 'avgSpeed', 1, 10)}${num('deliveryBufferMin', 'deliveryBuffer', 1, 0)}${num('stallMinutes', 'stallMin', 1, 0)}</div>
      <label class="row"><input type="checkbox" name="startCode" ${S.startCode ? 'checked' : ''}> <span>${t('admin.s.startCode')}</span></label>
      <p class="hint">${t('admin.s.autoReleaseHint')}</p>
      <label class="row"><input type="checkbox" name="deliveryCode" ${S.deliveryCode ? 'checked' : ''}> <span>${t('admin.s.deliveryCode')}</span></label>${S.deliveryCodeAvailable ? '' : html`<p class="hint">${t('admin.s.deliveryCodeNeedsEnv')}</p>`}
      <label class="row"><input type="checkbox" name="valueGuardOn" ${S.valueGuardOn ? 'checked' : ''}> <span>${t('admin.s.valueGuard')}</span></label>
      <div class="grid-3">${num('valueGuardFrom', 'valueGuardFrom', 1, 1)}</div><p class="hint">${t('admin.s.valueGuardHint')}</p>
      <label class="row"><input type="checkbox" name="offersEnabled" ${S.offersEnabled !== false ? 'checked' : ''}> <span>${t('admin.s.offersEnabled')}</span></label>
      <label class="row"><input type="checkbox" name="testPayments" ${S.testPayments ? 'checked' : ''}> <span>${t('admin.s.testPayments')}</span></label>${S.testPaymentsAllowed ? '' : html`<p class="hint">${t('admin.s.testNeedsEnv')}</p>`}
      <label class="row"><input type="checkbox" name="autoApproveCustomers" ${S.autoApproveCustomers ? 'checked' : ''}> <span>${t('admin.s.autoApprove')}</span></label></div>
    <div class="card stack"><h3>${t('admin.company.title')}</h3><p class="hint">${t('admin.company.hint')}</p>
      ${['name', 'phone', 'whatsapp', 'email', 'address', 'hours', 'facebook', 'instagram', 'tiktok', 'youtube'].map((k) => html`<label class="f">${t('admin.company.' + k)}<input name="company.${k}" maxlength="160" ${['phone', 'whatsapp', 'email', 'facebook', 'instagram', 'tiktok', 'youtube'].includes(k) ? 'dir="ltr"' : ''} value="${S.company?.[k] || ''}"></label>`)}
      <label class="f">${t('admin.company.about')}<textarea name="company.about" rows="4" maxlength="800">${S.company?.about || ''}</textarea></label></div>
    ${siteCard(S)}
    <div class="card stack"><h3>${t('admin.instapay')}</h3><div class="grid-2"><label class="f">${t('admin.s.handle')}<input name="instapay.handle" dir="ltr" value="${S.instapay?.handle || ''}"></label><label class="f">${t('admin.s.holder')}<input name="instapay.name" value="${S.instapay?.name || ''}"></label></div></div>
    <div class="card stack"><h3>${t('admin.profileEdit')}</h3><p class="hint">${t('admin.profileEditHint')}</p>
      <label class="row"><input type="checkbox" name="profileEditEnabled" ${S.profileEditEnabled !== false ? 'checked' : ''}> <span>${t('admin.s.profileEditEnabled')}</span></label>
      <label class="f" style="max-width:240px">${t('admin.s.profileEditCooldown')}<input type="number" name="profileEditCooldownDays" min="0" max="365" value="${S.profileEditCooldownDays ?? 15}" required></label></div>
    <div class="card stack"><h3>${t('admin.publicProfiles')}</h3><p class="hint">${t('admin.publicProfilesHint')}</p>
      <label class="row"><input type="checkbox" name="publicProfiles" ${S.publicProfiles ? 'checked' : ''}> <span>${t('admin.s.publicProfiles')}</span></label></div>
    <div class="card stack"><h3>${t('admin.referral')}</h3><p class="hint">${t('admin.referralHint')}</p>
      <label class="row"><input type="checkbox" name="referralEnabled" ${S.referralEnabled ? 'checked' : ''}> <span>${t('admin.s.referralEnabled')}</span></label>
      <div class="grid-2">
        <label class="f">${t('admin.s.referralBonusReferrer')}<input type="number" name="referralBonusReferrer" min="0" max="1000000" value="${S.referralBonusReferrer ?? 0}" required></label>
        <label class="f">${t('admin.s.referralBonusReferred')}<input type="number" name="referralBonusReferred" min="0" max="1000000" value="${S.referralBonusReferred ?? 0}" required></label>
      </div>
      <p class="hint">${t('admin.referralGo')} <a href="#/admin/referrals">${t('admin.tab.referrals')}</a></p></div>
    <p class="err" id="serr" role="alert"></p><div><button class="btn primary" type="submit">${t('common.save')}</button></div></form>`);
  const f = $('#sf', body);
  body.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]'), del = e.target.closest('[data-del]');
    if (add) { const tb = $(`table[data-kv=${add.dataset.add}]`, body); $('tbody', tb).insertAdjacentHTML('beforeend', kvRow('', {}, tb.dataset.seats === '1').s); }
    if (del) del.closest('tr').remove();
  });
  const readKv = (name) => Object.fromEntries($$(`table[data-kv=${name}] tbody tr`, body).map((tr) => {
    const k = $('[data-k]', tr).value.trim();
    return [k, { ar: $('[data-ar]', tr).value.trim() || k, en: $('[data-en]', tr).value.trim() || k, mult: Number($('[data-m]', tr).value), ...($('[data-seats]', tr) ? { seats: Number($('[data-seats]', tr).value) } : {}) }];
  }));
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    busy($('button[type=submit]', f), async () => {
      try {
        const n = (k) => Number(f.elements[k].value);
        const r = await api('admin/settings/save', {
          perKm: n('perKm'), minPrice: n('minPrice'), commissionPct: n('commissionPct'), roadFactor: n('roadFactor'), geofenceMeters: n('geofenceMeters'),
          maxCancellations: n('maxCancellations'), latePointsLimit: n('latePointsLimit'), minWithdraw: n('minWithdraw'), autoApproveCustomers: f.elements.autoApproveCustomers.checked, testPayments: f.elements.testPayments.checked,
          deliveryCode: f.elements.deliveryCode.checked, valueGuardOn: f.elements.valueGuardOn.checked, valueGuardFrom: n('valueGuardFrom'), autoReleaseHours: n('autoReleaseHours'),
          startCode: f.elements.startCode.checked, mismatchCompensation: n('mismatchCompensation'), mismatchMaxPer30d: n('mismatchMaxPer30d'), maxActiveJobs: n('maxActiveJobs'),
          avgSpeedKmh: n('avgSpeedKmh'), deliveryBufferMin: n('deliveryBufferMin'), stallMinutes: n('stallMinutes'),
          offersEnabled: f.elements.offersEnabled.checked, offerMinPct: n('offerMinPct'), offerMaxPct: n('offerMaxPct'), dispatchRadiusKm: n('dispatchRadiusKm'), dispatchMaxDrivers: n('dispatchMaxDrivers'), prepaidGraceMin: n('prepaidGraceMin'),
          cancelPaidDriverPct: n('cancelPaidDriverPct'), cancelPaidPlatformPct: n('cancelPaidPlatformPct'), cancelHeadingDriverPct: n('cancelHeadingDriverPct'), cancelHeadingPlatformPct: n('cancelHeadingPlatformPct'),
          newDriver: { orders: n('newDriver.orders'), commissionPct: n('newDriver.commissionPct') },
          instapay: { handle: f.elements['instapay.handle'].value.trim(), name: f.elements['instapay.name'].value.trim() },
          site: readSite(f),
          company: Object.fromEntries(['name', 'about', 'phone', 'whatsapp', 'email', 'address', 'hours', 'facebook', 'instagram', 'tiktok', 'youtube'].map((k) => [k, f.elements['company.' + k].value.trim()])),
          categories: readKv('categories'), sizes: readKv('sizes'),
          companionAsk: f.elements.companionAsk.checked, vehicleGuideOn: f.elements.vehicleGuideOn.checked,
          codEnabled: f.elements.codEnabled.checked, codCommissionPct: n('codCommissionPct'), codMaxAmount: n('codMaxAmount'), codPeriodDays: n('codPeriodDays'), codGraceDays: n('codGraceDays'), codBlockScope: f.elements.codBlockScope.value,
          dcPerKm: n('dcPerKm'), fineCreditToWallet: f.elements.fineCreditToWallet.checked, vehiclePricing: Object.fromEntries(['pickup', 'half_ton', 'jumbo', 'truck'].map((k) => [k, Object.fromEntries(['base', 'perKm', 'minPrice', 'kmFee'].map((f) => [f, n(`vp.${k}.${f}`)]))])),
          finesEnabled: f.elements.finesEnabled.checked, ...Object.fromEntries(['fineFreeCancelMin', 'fineWaitMin', 'fineEnRouteAmount', 'fineArrivedAmount', 'fineClaimHours', 'fineObjectHours', 'fineDriverSharePct', 'fineCollectorPct', 'fineMonthlyCap', 'fineMaxClaimsPerDay', 'fineBlockLimit', 'samePickupMeters', 'samePickupMax'].map((k) => [k, n(k)])),
          dcEnabled: f.elements.dcEnabled.checked, adminShowLegacy: f.elements.adminShowLegacy.checked, dcPct: n('dcPct'), dcLimit: n('dcLimit'), dcAutoCompleteHours: n('dcAutoCompleteHours'), jobsRadiusKm: n('jobsRadiusKm'), dcPay: { wallet: f.elements['dcPay.wallet'].value.trim(), walletName: f.elements['dcPay.walletName'].value.trim() },
          vehicleGuide: Object.fromEntries(['pickup', 'half_ton', 'jumbo', 'truck'].map((k) => [k, { maxKg: n(`vg.${k}.maxKg`), size: f.elements[`vg.${k}.size`].value }])),
          passengersEnabled: f.elements.passengersEnabled.checked, passengerClasses: readKv('passengerClasses'),
          levelDiscountPct: { trusted: n('levelDiscountPct.trusted'), pro: n('levelDiscountPct.pro'), elite: n('levelDiscountPct.elite') },
    trustRules: Object.fromEntries(['trusted', 'pro', 'elite'].map((k) => [k, { avg: n(`trustRules.${k}.avg`), ratings: n(`trustRules.${k}.ratings`) }])),
          profileEditEnabled: f.elements.profileEditEnabled.checked, profileEditCooldownDays: n('profileEditCooldownDays'),
          publicProfiles: f.elements.publicProfiles.checked,
          referralEnabled: f.elements.referralEnabled.checked, referralBonusReferrer: n('referralBonusReferrer'), referralBonusReferred: n('referralBonusReferred'),
        });
        state.settings = r.settings; $('#serr', body).textContent = ''; toast(t('admin.saved'));
      } catch (er) { $('#serr', body).textContent = errMsg(er); }
    });
  });
}

// =====================================================================  القائمة السوداء
function blacklist(body) {
  render(body, html`<form id="bf" class="card row" style="margin-bottom:1rem"><select name="type" style="max-width:150px"><option value="phone">${t('auth.phone')}</option><option value="nid">${t('auth.nationalId')}</option></select>
    <input name="value" class="grow" required placeholder="${t('admin.blValue')}" dir="ltr"><input name="reason" placeholder="${t('admin.reason')}" class="grow"><button class="btn primary" type="submit">${t('admin.add')}</button></form><p class="err" id="berr"></p><div id="tbl"></div>`);
  const p = gpoll(['blacklist'], () => api('admin/blacklist'), 30000, ({ items: rows }) => {
    render($('#tbl', body), rows.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('admin.type')}</th><th>${t('admin.blValue')}</th><th>${t('admin.reason')}</th><th>${t('admin.date')}</th><th></th></tr></thead><tbody>${rows.map((r) => html`<tr><td>${t(r.type === 'phone' ? 'auth.phone' : 'auth.nationalId')}</td><td dir="ltr">${r.value}</td><td>${r.reason || '—'}</td><td class="small">${fmtDate(r.at)}</td><td><button class="btn sm ghost" data-del="${r.id}">✕</button></td></tr>`)}</tbody></table></div>` : html`<div class="empty">${t('admin.noneBlacklist')}</div>`);
  }, { dedupe: true, onError });
  $('#bf', body).addEventListener('submit', (e) => {
    e.preventDefault(); const f = e.target;
    busy($('button', f), async () => {
      try { await api('admin/blacklist/add', { type: f.type.value, value: f.value.value, reason: f.reason.value }); f.reset(); $('#berr', body).textContent = ''; toast(t('common.done')); await p.now(); }
      catch (er) { $('#berr', body).textContent = errMsg(er); }
    });
  });
  body.addEventListener('click', (e) => { const b = e.target.closest('[data-del]'); if (b) busy(b, async () => { if (await confirmDialog(t('common.sure'), { danger: true })) { await api('admin/blacklist/remove', { id: b.dataset.del }); await p.now(); } }); });
  return p;
}

// =====================================================================  كوبونات الخصم (يتحكم فيها الأدمن)
function coupons(body) {
  let cur = null, rows = []; // الكوبون اللي بيتعدّل حالياً (null = إنشاء جديد) + آخر قائمة
  render(body, html`<div class="stack">
    <form id="cf" class="card">
      <h3 id="ctitle">${t('admin.coupon.new')}</h3>
      <div class="grid-2">
        <label class="f">${t('admin.coupon.code')}<input name="code" required maxlength="20" dir="ltr" placeholder="SAVE10" style="text-transform:uppercase"></label>
        <label class="f">${t('admin.coupon.type')}<select name="type"><option value="percent">${t('admin.coupon.percent')}</option><option value="amount">${t('admin.coupon.amount')}</option></select></label>
        <label class="f">${t('admin.coupon.value')}<input name="value" type="number" min="1" required></label>
        <label class="f">${t('admin.coupon.maxDiscount')}<input name="maxDiscount" type="number" min="0" value="0"><span class="hint">${t('admin.coupon.maxDiscountHint')}</span></label>
        <label class="f">${t('admin.coupon.minPrice')}<input name="minPrice" type="number" min="0" value="0"><span class="hint">${t('admin.coupon.minPriceHint')}</span></label>
        <label class="f">${t('admin.coupon.maxUses')}<input name="maxUses" type="number" min="0" value="0"><span class="hint">${t('admin.coupon.zeroUnlimited')}</span></label>
        <label class="f">${t('admin.coupon.perUser')}<input name="perUser" type="number" min="0" value="0"><span class="hint">${t('admin.coupon.zeroUnlimited')}</span></label>
        <label class="f">${t('admin.coupon.expires')}<input name="expires" type="date"><span class="hint">${t('admin.coupon.expiresHint')}</span></label>
      </div>
      <label class="row" style="gap:.5rem;margin:.5rem 0"><input type="checkbox" name="active" checked style="width:auto"> ${t('admin.coupon.active')}</label>
      <p class="err" id="cerr"></p>
      <div class="row"><button class="btn primary" type="submit">${t('common.save')}</button><button class="btn ghost" type="button" id="ccancel" hidden>${t('common.cancel')}</button></div>
    </form>
    <div id="ctbl"></div></div>`);
  const f = $('#cf', body), err = $('#cerr', body), title = $('#ctitle', body), cancel = $('#ccancel', body);
  const fill = (c) => { // تعبئة النموذج للتعديل أو تصفيره
    cur = c;
    f.code.value = c?.code ?? ''; f.type.value = c?.type ?? 'percent'; f.value.value = c?.value ?? '';
    f.maxDiscount.value = c?.maxDiscount ?? 0; f.minPrice.value = c?.minPrice ?? 0;
    f.maxUses.value = c?.maxUses ?? 0; f.perUser.value = c?.perUser ?? 0;
    f.expires.value = c?.expiresAt ? new Date(c.expiresAt).toISOString().slice(0, 10) : '';
    f.active.checked = c ? c.active : true;
    f.code.disabled = !!c; // الكود ثابت بعد الإنشاء
    title.textContent = c ? t('admin.coupon.edit') : t('admin.coupon.new');
    cancel.hidden = !c;
  };
  const p = gpoll(['coupons'], () => api('admin/coupons'), 60000, ({ coupons: list }) => {
    rows = list;
    render($('#ctbl', body), rows.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('admin.coupon.code')}</th><th>${t('admin.coupon.type')}</th><th>${t('admin.coupon.value')}</th><th>${t('admin.coupon.used')}</th><th>${t('admin.coupon.perUserShort')}</th><th>${t('admin.coupon.status')}</th><th></th></tr></thead>
      <tbody>${rows.map((c) => html`<tr><td dir="ltr"><b>${c.code}</b></td><td>${t(c.type === 'percent' ? 'admin.coupon.percent' : 'admin.coupon.amount')}</td><td class="num">${c.type === 'percent' ? `${c.value}%` : fmtMoney(c.value)}${c.maxDiscount ? html` <span class="muted small">≤ ${fmtMoney(c.maxDiscount)}</span>` : ''}${c.minPrice ? html` <div class="muted small">≥ ${fmtMoney(c.minPrice)}</div>` : ''}</td>
        <td class="num">${c.usedCount}${c.maxUses ? ` / ${c.maxUses}` : ''}</td><td class="num">${c.perUser || '∞'}</td>
        <td>${c.active ? html`<span class="stamp s-active">${t('admin.coupon.on')}</span>` : html`<span class="stamp s-banned">${t('admin.coupon.off')}</span>`}${c.expiresAt ? html` <div class="muted small">${fmtDate(c.expiresAt)}</div>` : ''}</td>
        <td><button class="btn sm ghost" data-edit="${c.code}">${t('common.edit')}</button> <button class="btn sm ghost" data-del="${c.code}">✕</button></td></tr>`)}</tbody></table></div>` : html`<div class="empty">${t('admin.coupon.none')}</div>`);
  }, { dedupe: true, onError });
  f.addEventListener('submit', (e) => {
    e.preventDefault(); busy($('button[type=submit]', f), async () => {
      err.textContent = '';
      try {
        await api('admin/coupon', {
          ...(cur ? { id: cur.code } : { code: f.code.value }),
          type: f.type.value, value: f.value.value,
          maxDiscount: f.maxDiscount.value || 0, minPrice: f.minPrice.value || 0,
          maxUses: f.maxUses.value || 0, perUser: f.perUser.value || 0,
          active: f.active.checked,
          expiresAt: f.expires.value ? new Date(f.expires.value + 'T23:59:59').getTime() : 0,
        });
        fill(null); toast(t('common.done')); await p.now();
      } catch (er) { err.textContent = errMsg(er); }
    });
  });
  cancel.addEventListener('click', () => fill(null));
  body.addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit]'), dl = e.target.closest('[data-del]');
    if (ed) { const c = rows.find((x) => x.code === ed.dataset.edit); if (c) { fill(c); f.scrollIntoView({ behavior: 'smooth', block: 'start' }); } return; }
    if (dl) busy(dl, async () => { if (await confirmDialog(t('admin.coupon.deleteAsk', { code: dl.dataset.del }), { danger: true, ok: t('common.delete') })) { await api('admin/coupon', { action: 'delete', id: dl.dataset.del }); await p.now(); } });
  });
  return p;
}


// =====================================================================  سجل عمليات الأدمن (أمن ومساءلة)
function audit(body) {
  const tgt = (e) => { const id = e.targetId; if (!id) return '—'; if (e.targetType === 'order') return orderNo(id); if (e.targetType === 'user') return id; return `${e.targetType || ''} ${id}`.trim(); };
  const label = (a) => { const k = 'audit.' + a; return t(k) === k ? a : t(k); }; // لو مفتاح الترجمة مش موجود نعرض الكود الخام
  return gpoll(['audit'], () => api('admin/audit'), 20000, ({ entries }) => {
    render(body, entries.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('admin.a.when')}</th><th>${t('admin.a.who')}</th><th>${t('admin.a.what')}</th><th>${t('admin.a.target')}</th><th>${t('admin.a.note')}</th></tr></thead>
      <tbody>${entries.map((e) => html`<tr><td class="small">${fmtDate(e.at)}</td><td>${e.adminName || e.adminUid || '—'}</td><td>${label(e.action)}</td><td class="small">${tgt(e)}</td><td class="small">${e.note || '—'}</td></tr>`)}</tbody></table></div>
      <p class="hint">${t('admin.a.hint')}</p>` : html`<div class="empty">${t('admin.a.none')}</div>`);
  }, { dedupe: true, onError });
}

// =====================================================================  المراقبة (استهلاك Firestore + الأخطاء)
function monitoring(body) {
  const load = () => Promise.all([api('admin/metrics'), api('admin/errors'), api('admin/logins')]).then(([m, e, l]) => ({ ...m, ...e, ...l }));
  body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act="backup"]'); if (!b) return;
    await busy(b, async () => {
      const data = await api('admin/export', {});
      const stamp = new Date().toISOString().slice(0, 10);
      downloadJson(`ashhanli-backup-${stamp}.json`, JSON.stringify(data, null, 1));
      toast(t('admin.bk.done', { n: fmtNum(Object.values(data.counts || {}).reduce((a, n) => a + n, 0)) }));
    });
  });
  return gpoll([], load, 30000, ({ limit, days, errors, entries }) => {
    const today = days.find((d) => d.day === new Date().toISOString().slice(0, 10)) || { reads: 0, writes: 0, errors: 0 };
    const over = today.reads >= limit;
    render(body, html`<div class="stack">
      <div class="tiles">
        <div class="tile"><b>${fmtNum(today.reads)}</b><span>${t('admin.mon.reads')}</span></div>
        <div class="tile"><b>${fmtNum(today.writes)}</b><span>${t('admin.mon.writes')}</span></div>
        <div class="tile"><b>${fmtNum(today.errors)}</b><span>${t('admin.mon.errors')}</span></div>
        <div class="tile"><b>${fmtNum(limit)}</b><span>${t('admin.mon.limit')}</span></div>
      </div>
      ${over ? html`<p class="err">${t('admin.mon.alarm')}</p>` : ''}
      <div class="card"><h3>${t('admin.mon.today')}</h3><p class="hint">${t('admin.mon.note')}</p></div>
      <div class="card"><h3>${t('admin.mon.last30')}</h3>${days.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('admin.mon.day')}</th><th>${t('admin.mon.reads')}</th><th>${t('admin.mon.writes')}</th><th>${t('admin.mon.errors')}</th></tr></thead>
        <tbody>${days.map((d) => html`<tr><td dir="ltr">${d.day}</td><td class="num ${d.reads >= limit ? 'err' : ''}">${fmtNum(d.reads)}</td><td class="num">${fmtNum(d.writes)}</td><td class="num">${fmtNum(d.errors)}</td></tr>`)}</tbody></table></div>` : html`<div class="empty">${t('admin.mon.daysNone')}</div>`}</div>
      <div class="card"><h3>${t('admin.mon.errTitle')}</h3>${errors.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('admin.mon.when')}</th><th>${t('admin.mon.source')}</th><th>${t('admin.mon.route')}</th><th>${t('admin.mon.user')}</th><th>${t('admin.mon.message')}</th></tr></thead>
        <tbody>${errors.map((e) => html`<tr><td class="small">${fmtDate(e.at)}</td><td>${t(e.source === 'client' ? 'admin.mon.srcClient' : 'admin.mon.srcServer')}</td><td class="small" dir="ltr">${e.route || '—'}</td><td class="small" dir="ltr">${e.uid || '—'}</td><td class="small">${e.message || '—'}</td></tr>`)}</tbody></table></div>` : html`<div class="empty">${t('admin.mon.errNone')}</div>`}</div>
      <div class="card stack"><h3>${t('admin.bk.title')}</h3><p class="hint">${t('admin.bk.hint')}</p>
        <div><button class="btn ghost" type="button" data-act="backup">${t('admin.bk.btn')}</button></div></div>
      <div class="card"><h3>${t('admin.lg.title')}</h3><p class="hint">${t('admin.lg.hint')}</p>${(entries || []).length ? html`<div class="table-wrap"><table><thead><tr><th>${t('admin.lg.when')}</th><th>${t('admin.lg.who')}</th><th>${t('admin.lg.role')}</th><th>${t('admin.lg.device')}</th></tr></thead>
        <tbody>${entries.map((e) => html`<tr><td class="small">${fmtDate(e.at)}</td><td class="small">${e.name || e.email || e.uid}</td><td class="small">${e.role ? t('auth.role' + (e.role === 'driver' ? 'Driver' : e.role === 'admin' ? 'Admin' : 'Customer')) : '—'}</td><td class="small" dir="ltr">${(e.ua || '—').slice(0, 60)}</td></tr>`)}</tbody></table></div>` : html`<div class="empty">${t('admin.lg.none')}</div>`}</div>
    </div>`);
  }, { every: 1, dedupe: true, onError });
}
