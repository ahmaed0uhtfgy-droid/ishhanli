import { api, poll } from '../api.js';
import { state } from '../state.js';
import { t } from '../i18n.js';
import { $, $$, html, raw, render, toast, errMsg, busy, spinner, stamp, orderNo, fmtMoney, fmtNum, fmtDate, ratingText, trustBadge, confirmDialog, promptDialog, openModal } from '../ui.js';
import { hydrate, imgTag } from '../storage.js';

const TABS = ['overview', 'payments', 'users', 'orders', 'withdrawals', 'disputes', 'refunds', 'reports', 'settings', 'blacklist'];
const onError = (e) => toast(errMsg(e), true);
const imgs = (refs) => html`<div class="photos">${(refs || []).filter(Boolean).map((r) => raw(imgTag(r)))}</div>`;
const roleKey = (u) => 'auth.role' + (u.role === 'driver' ? 'Driver' : 'Customer');

export function renderAdmin(el, tab) {
  if (!TABS.includes(tab)) tab = 'overview';
  render(el, html`<div class="page-head"><h1>${t('admin.title')}</h1></div>
    <nav class="tabs">${TABS.map((k) => html`<a href="#/admin/${k}" data-tab="${k}" class="${k === tab ? 'on' : ''}">${t('admin.tab.' + k)}<span class="dot" hidden></span></a>`)}</nav><div id="body">${spinner()}</div>`);
  // شارات الأعداد المعلّقة (استعلامات خفيفة على index الحالة) — كل 20 ثانية
  const badges = poll(() => api('admin/badges'), 20000, ({ badges: b }) => {
    for (const [k, n] of Object.entries(b)) { const d = $(`[data-tab="${k}"] .dot`, el); if (d) { d.textContent = n; d.hidden = !n; } }
  }, { dedupe: true });
  const body = $('#body', el);
  const stop = { overview, payments, users, orders, withdrawals, disputes, refunds, reports, settings, blacklist }[tab](body, badges);
  return () => { badges(); stop?.(); };
}

// =====================================================================  نظرة عامة (إحصائيات SQL على كل الطلبات)
function overview(body) {
  return poll(() => api('admin/stats'), 120000, (s) => {
    const days = [...Array(14)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - (13 - i)); return d.toLocaleDateString('en-CA'); }); // YYYY-MM-DD
    const per = Object.fromEntries(s.perDay.map((x) => [x.d, x.n]));
    const perDay = days.map((d) => per[d] || 0), mx = Math.max(1, ...perDay), T = s.totals;
    render(body, html`<div class="stack">
      <div class="tiles">
        <div class="tile"><b>${T.total}</b><span>${t('admin.ordersTotal')}</span></div>
        <div class="tile"><b>${T.active}</b><span>${t('admin.ordersActive')}</span></div>
        <div class="tile"><b>${fmtMoney(T.revenue)}</b><span>${t('admin.revenue')}</span></div>
        <div class="tile"><b>${fmtMoney(T.commission)}</b><span>${t('admin.commissions')}</span></div>
        <div class="tile"><b>${fmtMoney(T.held)}</b><span>${t('admin.escrowHeld')}</span></div>
        <div class="tile"><b>${fmtMoney(s.refundsDue)}</b><span>${t('admin.refundsDue')}</span></div>
        <div class="tile"><b>${s.activeDrivers}</b><span>${t('admin.activeDrivers')}</span></div>
        <div class="tile"><b>${s.activeCustomers}</b><span>${t('admin.activeCustomers')}</span></div>
      </div>
      <div class="grid-2">
        <div class="card"><h3>${t('admin.last14')}</h3><div class="bars" role="img" aria-label="${t('admin.last14')}">${perDay.map((n) => raw(`<div data-n="${n}" style="height:${Math.max(3, (n / mx) * 100)}%"></div>`))}</div></div>
        <div class="card"><h3>${t('admin.topDrivers')}</h3>${s.topDrivers.length ? html`<table><tbody>${s.topDrivers.map((d) => html`<tr><td>${d.name}</td><td class="num">${d.n} ${t('admin.trips')}</td><td class="num">${fmtMoney(d.earned)}</td></tr>`)}</tbody></table>` : html`<p class="muted">—</p>`}</div>
      </div><p class="hint">${t('admin.statsNote')}</p></div>`);
  }, { dedupe: true, onError });
}

// =====================================================================  المدفوعات (مراجعة إثبات التحويل)
function payments(body) {
  const p = poll(() => api('orders/list', { status: 'payment_review' }), 12000, ({ orders: rows }) => {
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
    <input id="fq" placeholder="${t('admin.searchUsers')}" style="max-width:260px"></div><div id="tbl">${spinner()}</div>`);
  let all = [], timer = null;
  const paint = () => render($('#tbl', body), html`<div class="table-wrap"><table><thead><tr><th>${t('auth.name')}</th><th>${t('admin.role')}</th><th>${t('auth.phone')}</th><th>${t('admin.status')}</th><th>${t('admin.rating')}</th><th>${t('trust.title')}</th><th>${t('admin.joined')}</th><th></th></tr></thead>
    <tbody>${all.map((u) => html`<tr><td>${u.name}</td><td>${t(roleKey(u))}</td><td dir="ltr">${u.phone}</td><td>${stamp(u.status)}</td><td>${ratingText(u)}</td><td>${u.trust ? trustBadge(u.trust) : '—'}</td><td class="small">${fmtDate(u.createdAt)}</td><td><button class="btn sm ${u.status === 'pending' ? 'primary' : 'ghost'}" data-id="${u.id}">${t('admin.review')}</button></td></tr>`)}</tbody></table></div>`);
  async function load() {
    try { all = (await api('admin/users', { role: $('#fr', body).value, status: $('#fs', body).value, q: $('#fq', body).value })).users; paint(); }
    catch (e) { render($('#tbl', body), html`<div class="empty">${errMsg(e)}</div>`); }
  }
  ['#fr', '#fs'].forEach((s) => $(s, body).addEventListener('change', load));
  $('#fq', body).addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 350); });
  body.addEventListener('click', (e) => { const b = e.target.closest('[data-id]'); if (b) userModal(all.find((u) => u.id === b.dataset.id), async () => { await load(); badges.now(); }); });
  load();
  return () => clearTimeout(timer);
}

function userModal(u, reload) {
  if (!u) return;
  const docsRefs = [['auth.idPhoto', u.idRef], ['auth.license', u.licenseRef], ['auth.vehicleReg', u.vehicleRegRef], ['auth.vehiclePhoto', u.vehiclePhotoRef]].filter(([, r]) => r);
  const { el, close } = openModal(html`<div class="row"><h3 class="grow">${u.name}</h3>${stamp(u.status)}</div>
    <dl class="kv"><dt>${t('admin.role')}</dt><dd>${t(roleKey(u))}</dd><dt>${t('auth.phone')}</dt><dd dir="ltr">${u.phone} ${u.phoneVerified ? '✓' : ''}</dd>
      <dt>${t('auth.nationalId')}</dt><dd dir="ltr">${u.nationalId || '—'}</dd><dt>${t('auth.email')}</dt><dd dir="ltr">${u.email}</dd><dt>${t('auth.area')}</dt><dd>${u.area || '—'}</dd>
      ${u.vehicleType ? html`<dt>${t('auth.vehicleType')}</dt><dd>${t('vehicle.' + u.vehicleType)}</dd>` : ''}
      ${u.trust ? html`<dt>${t('trust.title')}</dt><dd>${trustBadge(u.trust)}</dd>` : ''}<dt>${t('admin.trips')}</dt><dd>${u.completedOrders || 0}</dd><dt>${t('admin.cancels')}</dt><dd>${u.cancelCount || 0}</dd><dt>${t('admin.rating')}</dt><dd>${ratingText(u)}</dd>
      ${u.statusReason ? html`<dt>${t('status.reason')}</dt><dd>${u.statusReason}</dd>` : ''}</dl>
    <h3 style="margin-top:1rem">${t('admin.documents')}</h3>
    <div class="stack">${docsRefs.map(([k, r]) => html`<div><div class="muted small">${t(k)}</div>${imgs([r])}</div>`)}</div>
    <label class="f" style="margin-top:1rem">${t('admin.reason')}<input id="reason"></label>
    <label class="row" style="margin-top:.5rem"><input type="checkbox" id="bl"> <span class="small">${t('admin.addBlacklist')}</span></label>
    <div class="row end"><button class="btn ghost" data-s="close">${t('common.close')}</button>
      ${u.status !== 'active' ? html`<button class="btn ok" data-s="active">${t('admin.approve')}</button>` : ''}
      ${u.status === 'pending' ? html`<button class="btn danger" data-s="rejected">${t('admin.reject')}</button>` : ''}
      ${u.status !== 'banned' ? html`<button class="btn danger" data-s="banned">${t('admin.ban')}</button>` : ''}</div>`, { wide: true });
  hydrate(el);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-s]'); if (!b) return; if (b.dataset.s === 'close') return close();
    busy(b, async () => {
      await api('admin/user', { uid: u.id, status: b.dataset.s, reason: $('#reason', el).value, blacklist: $('#bl', el).checked });
      toast(t('common.done')); close(); reload();
    });
  });
}

// =====================================================================  كل الطلبات
function orders(body) {
  render(body, html`<div class="row" style="margin-bottom:1rem"><select id="fs" style="max-width:220px"><option value="">${t('admin.allStatus')}</option>${['awaiting_payment', 'open', 'accepted', 'payment_review', 'paid', 'heading_pickup', 'picked_up', 'in_transit', 'delivered', 'completed', 'disputed', 'resolved', 'cancelled'].map((s) => html`<option value="${s}">${t('status.' + s)}</option>`)}</select></div><div id="tbl">${spinner()}</div>`);
  const sel = $('#fs', body);
  const p = poll(() => api('orders/list', { status: sel.value, limit: 200 }), 15000, ({ orders: rows }) => {
    render($('#tbl', body), html`<div class="table-wrap"><table><thead><tr><th>#</th><th>${t('admin.status')}</th><th>${t('order.customer')}</th><th>${t('order.driver')}</th><th>${t('order.price')}</th><th>${t('admin.date')}</th><th></th></tr></thead>
      <tbody>${rows.map((o) => html`<tr><td>${orderNo(o.id)}</td><td>${stamp(o.status)}</td><td>${o.customerName}</td><td>${o.driverName || '—'}</td><td class="num">${fmtMoney(o.price)}</td><td class="small">${fmtDate(o.createdAt)}</td><td><a class="btn sm ghost" href="#/order/${o.id}">${t('admin.open')}</a></td></tr>`)}</tbody></table></div>`);
  }, { dedupe: true, onError });
  sel.addEventListener('change', () => p.now());
  return p;
}

// =====================================================================  طلبات السحب
function withdrawals(body) {
  const p = poll(() => api('admin/withdrawals'), 15000, ({ withdrawals: rows }) => {
    render(body, rows.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('admin.date')}</th><th>${t('order.driver')}</th><th>${t('wallet.amount')}</th><th>${t('wallet.method')}</th><th>${t('wallet.account')}</th><th>${t('admin.status')}</th><th></th></tr></thead>
      <tbody>${rows.map((w) => html`<tr><td class="small">${fmtDate(w.createdAt)}</td><td>${w.name}<div class="small muted" dir="ltr">${w.phone}</div></td><td class="num"><b>${fmtMoney(w.amount)}</b></td><td>${t('method.' + w.method)}</td><td dir="ltr">${w.account}</td><td>${stamp(w.status)}</td>
      <td>${w.status === 'pending' ? html`<div class="row"><button class="btn sm ok" data-a="paid" data-id="${w.id}">${t('admin.markPaid')}</button><button class="btn sm danger" data-a="reject" data-id="${w.id}">${t('admin.reject')}</button></div>` : w.note || ''}</td></tr>`)}</tbody></table></div>` : html`<div class="empty">${t('admin.noneWithdrawals')}</div>`);
  }, { dedupe: true, onError });
  body.addEventListener('click', (e) => {
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
  const p = poll(() => api('admin/refunds'), 15000, ({ refunds: rows }) => {
    render(body, rows.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('admin.date')}</th><th>${t('order.customer')}</th><th>#</th><th>${t('wallet.amount')}</th><th>${t('admin.reason')}</th><th>${t('admin.status')}</th><th></th></tr></thead>
      <tbody>${rows.map((r) => html`<tr><td class="small">${fmtDate(r.createdAt)}</td><td>${r.customerName}<div class="small muted" dir="ltr">${r.customerPhone}</div></td><td><a href="#/order/${r.orderId}">${orderNo(r.orderId)}</a></td><td class="num"><b>${fmtMoney(r.amount)}</b></td><td>${t('refund.reason.' + r.reason)}</td>
      <td><span class="stamp s-${r.status === 'paid' ? 'active' : 'pending'}">${t(r.status === 'paid' ? 'refund.done' : 'refund.wait')}</span></td>
      <td>${r.status === 'pending' ? html`<button class="btn sm ok" data-id="${r.id}" data-amount="${r.amount}">${t('admin.markRefunded')}</button>` : r.note || ''}</td></tr>`)}</tbody></table></div>` : html`<div class="empty">${t('admin.noneRefunds')}</div>`);
  }, { dedupe: true, onError });
  body.addEventListener('click', (e) => {
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
  const p = poll(() => api('admin/reports'), 10000, ({ reports: rs, sos }) => {
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
  const p = poll(() => api('admin/disputes'), 15000, ({ disputes: rows }) => {
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
    <div class="card stack"><h3>${t('admin.passengers')}</h3>
      <label class="row"><input type="checkbox" name="passengersEnabled" ${S.passengersEnabled ? 'checked' : ''}> <span>${t('admin.s.passengersEnabled')}</span></label><p class="hint">${t('admin.paxLegal')}</p>
      ${kvRows('passengerClasses', S.passengerClasses, true)}</div>
    <div class="card stack"><h3>${t('admin.levelDiscount')}</h3><p class="hint">${t('admin.levelDiscountHint')}</p>
      <div class="grid-3">${num('levelDiscountPct.trusted', 'disc.trusted', 0.5, 0)}${num('levelDiscountPct.pro', 'disc.pro', 0.5, 0)}${num('levelDiscountPct.elite', 'disc.elite', 0.5, 0)}</div></div>
    <div class="card stack"><h3>${t('admin.cancelFees')}</h3><p class="hint">${t('admin.cancelFeesHint')}</p>
      <div class="grid-2">${num('cancelPaidDriverPct', 'cancelPaidDriver', 1, 0)}${num('cancelPaidPlatformPct', 'cancelPaidPlatform', 1, 0)}</div>
      <div class="grid-2">${num('cancelHeadingDriverPct', 'cancelHeadingDriver', 1, 0)}${num('cancelHeadingPlatformPct', 'cancelHeadingPlatform', 1, 0)}</div></div>
    <div class="card stack"><h3>${t('admin.rules')}</h3><div class="grid-3">${num('geofenceMeters', 'geofence', 10)}${num('maxCancellations', 'maxCancel', 1, 1)}${num('minWithdraw', 'minWithdraw', 1, 1)}</div>
      <div class="grid-3">${num('offerMinPct', 'offerMin', 1, 10)}${num('offerMaxPct', 'offerMax', 1, 100)}${num('dispatchRadiusKm', 'dispatchRadius', 1, 1)}</div>
      <div class="grid-3">${num('dispatchMaxDrivers', 'dispatchMax', 1, 1)}${num('prepaidGraceMin', 'prepaidGrace', 1, 0)}</div>
      <label class="row"><input type="checkbox" name="offersEnabled" ${S.offersEnabled !== false ? 'checked' : ''}> <span>${t('admin.s.offersEnabled')}</span></label>
      <label class="row"><input type="checkbox" name="autoApproveCustomers" ${S.autoApproveCustomers ? 'checked' : ''}> <span>${t('admin.s.autoApprove')}</span></label></div>
    <div class="card stack"><h3>${t('admin.instapay')}</h3><div class="grid-2"><label class="f">${t('admin.s.handle')}<input name="instapay.handle" dir="ltr" value="${S.instapay?.handle || ''}"></label><label class="f">${t('admin.s.holder')}<input name="instapay.name" value="${S.instapay?.name || ''}"></label></div></div>
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
          maxCancellations: n('maxCancellations'), minWithdraw: n('minWithdraw'), autoApproveCustomers: f.elements.autoApproveCustomers.checked,
          offersEnabled: f.elements.offersEnabled.checked, offerMinPct: n('offerMinPct'), offerMaxPct: n('offerMaxPct'), dispatchRadiusKm: n('dispatchRadiusKm'), dispatchMaxDrivers: n('dispatchMaxDrivers'), prepaidGraceMin: n('prepaidGraceMin'),
          cancelPaidDriverPct: n('cancelPaidDriverPct'), cancelPaidPlatformPct: n('cancelPaidPlatformPct'), cancelHeadingDriverPct: n('cancelHeadingDriverPct'), cancelHeadingPlatformPct: n('cancelHeadingPlatformPct'),
          newDriver: { orders: n('newDriver.orders'), commissionPct: n('newDriver.commissionPct') },
          instapay: { handle: f.elements['instapay.handle'].value.trim(), name: f.elements['instapay.name'].value.trim() },
          categories: readKv('categories'), sizes: readKv('sizes'),
          passengersEnabled: f.elements.passengersEnabled.checked, passengerClasses: readKv('passengerClasses'),
          levelDiscountPct: { trusted: n('levelDiscountPct.trusted'), pro: n('levelDiscountPct.pro'), elite: n('levelDiscountPct.elite') },
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
  const p = poll(() => api('admin/blacklist'), 30000, ({ items: rows }) => {
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
