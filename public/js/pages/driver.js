import { api, poll } from '../api.js';
import { state } from '../state.js';
import { t } from '../i18n.js';
import { $, html, render, toast, errMsg, busy, spinner, waybill, stamp, orderNo, fmtMoney, fmtNum, fmtDate, ratingText, label, openModal, trustBadge } from '../ui.js';
import { getPos } from '../geo.js';
import { chime, unlockAudio } from '../sound.js';
import { pushSupport, enablePush } from '../push.js';

const TABS = [['available', 'driver.tabAvail'], ['jobs', 'driver.tabJobs'], ['wallet', 'driver.tabWallet']];
const onError = (e) => toast(errMsg(e), true);
let driverOnline = false; // حالة "متاح" (بتتشارك بين شريط الحضور وتنبيه الطلب الجديد)

// نفس منطق السيرفر: العربية تخدم إيه؟ (بضاعة حسب الحجم، أو ركاب حسب فئة العربية)
const CARGO_CAP = { car: ['small'], van: ['small'], microbus: ['small'], minibus: [], pickup: ['small'], half_ton: ['small', 'medium'], truck: ['small', 'medium', 'large'] };
const PAX_CAP = { car: ['car'], van: ['car', 'van'], microbus: ['car', 'van', 'microbus'], minibus: ['car', 'van', 'microbus', 'minibus'] };
const canServe = (v, o) => {
  if (o.service === 'passengers') { const cap = PAX_CAP[v]; return !!cap && (!['car', 'van', 'microbus', 'minibus'].includes(o.vehicleClass) || cap.includes(o.vehicleClass)); }
  const cap = CARGO_CAP[v]; return !cap || !['small', 'medium', 'large'].includes(o.size) || cap.includes(o.size);
};

export function renderDriver(el, tab) {
  render(el, html`<div class="page-head"><h1>${t('driver.title')}</h1><span class="muted">${ratingText(state.profile)}</span></div>
    <div id="trust"></div>
    <div id="presence"></div>
    <nav class="tabs" aria-label="driver">${TABS.map(([k, l]) => html`<a href="#/driver${k === 'available' ? '' : '/' + k}" class="${tab === k ? 'on' : ''}">${t(l)}</a>`)}</nav><div id="body">${spinner()}</div>`);
  const body = $('#body', el), stopPresence = presenceBar($('#presence', el));
  const paintTrust = (tr) => render($('#trust', el), tr ? trustCard(tr) : '');
  paintTrust(state.profile.trust);
  api('me').then((r) => { if (r.profile?.trust) { Object.assign(state.profile, { trust: r.profile.trust, ratingSum: r.profile.ratingSum, ratingCount: r.profile.ratingCount, completedOrders: r.profile.completedOrders }); paintTrust(r.profile.trust); } }).catch(() => {});
  const stopTab = tab === 'jobs' ? jobs(body) : tab === 'wallet' ? wallet(body) : available(body);
  return () => { stopPresence(); stopTab?.(); };
}

// ---------- مستوى الثقة وتقدّم السواق ----------
function trustCard(tr) {
  const s = tr.stats, n = tr.next;
  const req = (name, cur, target, ok) => html`<div class="req ${ok ? 'ok' : ''}"><span>${name}</span><b>${cur} / ${target}</b></div>`;
  return html`<details class="card flat" style="margin-bottom:1rem" ${tr.level === 'new' ? 'open' : ''}>
    <summary class="row"><b>${t('trust.title')}</b> ${trustBadge(tr)}<span class="muted small">${s.trips} ${t('admin.trips')} · ${s.ratingCount ? '★ ' + s.ratingAvg : '—'} · ${t('trust.cancelRate')} ${s.cancelPct}%</span></summary>
    <div style="margin-top:.6rem">${tr.commissionPct != null ? html`<p style="margin:0 0 .5rem">${t('trust.commission')}: <b>${tr.commissionPct}%</b></p><p class="hint">${t('trust.perks')}</p>` : ''}${n ? html`<p class="hint">${t('trust.next')}: <b>${t('trust.level.' + n.level)}</b></p>
      ${req(t('trust.req.trips'), s.trips, n.trips, s.trips >= n.trips)}${req(t('trust.req.ratings'), s.ratingCount, n.ratings, s.ratingCount >= n.ratings)}
      ${req(t('trust.req.avg'), s.ratingCount ? s.ratingAvg : '—', n.avg + '+', s.ratingCount > 0 && s.ratingAvg >= n.avg)}${req(t('trust.req.cancel'), s.cancelPct + '%', '≤ ' + n.maxCancelPct + '%', s.cancelPct <= n.maxCancelPct)}` : html`<p>${t('trust.top')}</p>`}</div></details>`;
}

// ---------- متاح لاستقبال الطلبات (زي أوبر) ----------
function presenceBar(box) {
  let online = false, timer = null;
  const hintKey = () => {
    if (!online) return null;
    const s = pushSupport();
    return s === 'granted' ? null : s === 'denied' ? 'push.denied' : s === 'unsupported' ? 'push.unsupported' : s === 'not_configured' ? 'push.notConfigured' : 'presence.needPush';
  };
  const paint = () => { const h = hintKey(); render(box, html`<div class="presence ${online ? 'on' : ''}"><div class="grow"><b>${t(online ? 'presence.on' : 'presence.off')}</b>
    <div class="small muted">${t(online ? 'presence.onHint' : 'presence.offHint')}</div></div><button class="switch" type="button" role="switch" aria-checked="${online}" aria-label="${t('presence.toggle')}"></button></div>
    ${h ? html`<p class="hint" style="margin:-.5rem 0 1rem">${t(h)}</p>` : ''}`); };
  const send = async (on) => { const loc = await getPos().catch(() => null); return api('driver/presence', { online: on, ...(loc || {}) }); };
  // بنجدّد الموقع كل دقيقتين والصفحة مفتوحة (المتصفح مابيسمحش بتتبع الخلفية)؛ الإشعارات بتفضل توصل حتى لو الصفحة اتقفلت
  const sync = () => { clearInterval(timer); if (online) timer = setInterval(() => { if (!document.hidden) send(true).catch(() => {}); }, 120000); };
  box.addEventListener('click', (e) => {
    const b = e.target.closest('.switch'); if (!b) return;
    busy(b, async () => {
      const next = !online; unlockAudio();
      if (next) await enablePush({ ask: true }).catch(() => {}); // بيطلب إذن الإشعارات أول ما السواق يبقى متاح
      await send(next); online = driverOnline = next; paint(); sync();
    });
  });
  paint();
  api('driver/presence', {}).then((r) => { online = driverOnline = r.online; paint(); sync(); }).catch(() => {});
  return () => clearInterval(timer);
}

// ---------- تنبيه طلب جديد (نافذة + صوت + عدّاد 30 ثانية) ----------
let alertOpen = false;
function newOrderAlert(o) {
  if (alertOpen) return; alertOpen = true; chime();
  const S = state.settings, prepaid = o.payMode === 'before', canInstant = o.instant !== false, canOffer = S.offersEnabled !== false && !prepaid; // المدفوع مقدماً: سعر ثابت
  let left = 30;
  const { el, close } = openModal(html`<div class="alert-order"><div class="row"><h3 class="grow">${t('alert.title')}</h3>${prepaid ? html`<span class="stamp s-active">${t('order.prepaid')}</span>` : ''}<span class="stamp s-open" id="cd">${left}</span></div>
    <div class="route"><div class="stop a"><span>${o.pickup?.address || t('order.pickup')}</span></div><i class="road"></i><div class="stop b"><span>${o.dropoff?.address || t('order.dropoff')}</span></div></div>
    <div class="row"><b style="font:700 1.7rem var(--font-display)">${fmtMoney(o.price)}</b><span class="muted grow">${fmtNum(o.distanceKm)} ${t('common.km')} · ${o.service === 'passengers' ? `${label(S.passengerClasses?.[o.vehicleClass], o.vehicleClass)} · ${o.passengers} ${t('order.passengersUnit')}` : `${label(S.sizes?.[o.size], o.size)} · ${fmtNum(o.weightKg, 0)} ${t('common.kg')}`}</span></div>
    <div class="row" style="margin-top:1rem"><button class="btn ghost" data-a="skip">${t('alert.skip')}</button><a class="btn ghost" href="#/order/${o.id}" data-a="view">${t('admin.open')}</a>
    ${canInstant ? html`<button class="btn primary grow" data-a="accept">${t('order.accept')}</button>` : canOffer ? html`<a class="btn primary grow" href="#/order/${o.id}" data-a="view">${t('offer.propose')}</a>` : ''}</div></div>`);
  const done = () => { clearInterval(tick); alertOpen = false; };
  const tick = setInterval(() => {
    if (!el.isConnected) return done(); // اتقفلت بـ Esc أو بالضغط برا
    left--; const cd = el.querySelector('#cd'); if (cd) cd.textContent = left;
    if (left <= 0) { close(); done(); }
  }, 1000);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    if (b.dataset.a === 'accept') busy(b, async () => { await api('orders/accept', { orderId: o.id }); close(); done(); toast(t('order.acceptedToast')); location.hash = `#/order/${o.id}`; });
    else { close(); done(); } // تخطي، أو "فتح" (الرابط بيودّي لصفحة الطلب)
  });
}

// ---------- الطلبات المتاحة (تحديث كل 10 ثواني) ----------
function available(body) {
  const sizes = Object.entries(state.settings.sizes || {});
  render(body, html`<div class="row" style="margin-bottom:1rem"><label class="f" style="min-width:220px">${t('driver.filterSize')}<select id="size"><option value="">${t('common.all')}</option>${sizes.map(([k, s]) => html`<option value="${k}">${label(s, k)}</option>`)}</select></label></div><div id="list" class="stack"></div>`);
  let all = [], seen = null;
  const list = $('#list', body), sel = $('#size', body);
  const paint = () => {
    const rows = all.filter((o) => !sel.value || o.size === sel.value);
    render(list, rows.length ? html`${rows.map((o) => waybill(o))}` : html`<div class="empty">${t('driver.noneAvail')}</div>`);
  };
  sel.addEventListener('change', paint);
  return poll(() => api('orders/list', { scope: 'available' }), 10000, ({ orders }) => {
    if (seen) {
      const fresh = orders.filter((o) => !seen.has(o.id));
      const fits = fresh.filter((o) => canServe(state.profile.vehicleType, o));
      if (driverOnline && fits.length) newOrderAlert(fits[0]); // متاح + الطلب يناسب عربيته => تنبيه زي أوبر
      else fresh.forEach((o) => toast(`${t('driver.newOrder')} ${orderNo(o.id)} — ${fmtMoney(o.price)}`));
    }
    seen = new Set(orders.map((o) => o.id)); all = orders; paint();
  }, { dedupe: true, onError });
}

// ---------- شغلي ----------
function jobs(body) {
  const prev = new Map(); let first = true;
  return poll(() => api('orders/list', { scope: 'mine' }), 15000, ({ orders: rows }) => {
    for (const o of rows) { const p = prev.get(o.id); if (!first && p && p !== o.status) toast(`${orderNo(o.id)} — ${t('status.' + o.status)}`); prev.set(o.id, o.status); }
    first = false;
    const done = ['completed', 'cancelled', 'resolved'], act = rows.filter((o) => !done.includes(o.status)), old = rows.filter((o) => done.includes(o.status));
    render(body, rows.length ? html`<div class="stack">${act.length ? html`<h3>${t('driver.active')}</h3>${act.map((o) => waybill(o))}` : ''}${old.length ? html`<h3>${t('driver.history')}</h3>${old.map((o) => waybill(o))}` : ''}</div>` : html`<div class="empty">${t('driver.noJobs')}</div>`);
  }, { dedupe: true, onError });
}

// ---------- المحفظة ----------
function wallet(body) {
  const S = state.settings;
  render(body, html`<div class="grid-2"><div class="stack"><div id="bal">${spinner()}</div>
    <form id="wf" class="card stack"><h3>${t('wallet.withdraw')}</h3>
      <label class="f">${t('wallet.amount')} (${t('common.egp')})<input type="number" name="amount" min="${S.minWithdraw || 100}" step="1" required></label>
      <label class="f">${t('wallet.method')}<select name="method"><option value="instapay">${t('method.instapay')}</option><option value="vodafone">${t('method.vodafone')}</option><option value="bank">${t('method.bank')}</option></select></label>
      <label class="f">${t('wallet.account')}<input name="account" required minlength="5" maxlength="60" placeholder="${t('wallet.accountHint')}"></label>
      <p class="hint">${t('wallet.minNote')} ${fmtMoney(S.minWithdraw || 100)} — ${t('wallet.reviewNote')}</p><p class="err" id="werr" role="alert"></p>
      <button class="btn primary" type="submit">${t('wallet.request')}</button></form></div>
    <div class="stack"><div id="wds"></div><div id="txs"></div></div></div>`);
  const p = poll(() => api('wallet'), 20000, ({ wallet: w, tx, withdrawals: rows }) => {
    render($('#bal', body), html`<div class="tiles"><div class="tile"><b>${fmtMoney(w.balance)}</b><span>${t('wallet.balance')}</span></div><div class="tile"><b>${fmtMoney(w.totalEarned)}</b><span>${t('wallet.earned')}</span></div></div>`);
    render($('#wds', body), html`<h3>${t('wallet.requests')}</h3>${rows.length ? html`<div class="table-wrap"><table><tbody>${rows.map((x) => html`<tr><td>${fmtDate(x.createdAt)}</td><td>${t('method.' + x.method)}</td><td class="num">${fmtMoney(x.amount)}</td><td>${stamp(x.status)}</td><td class="small">${x.note || ''}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">—</p>`}`);
    render($('#txs', body), html`<h3>${t('wallet.history')}</h3>${tx.length ? html`<div class="table-wrap"><table><tbody>${tx.map((x) => html`<tr><td>${fmtDate(x.at)}</td><td>${t('tx.' + x.type)}${x.orderId ? html` <a href="#/order/${x.orderId}">${orderNo(x.orderId)}</a>` : ''}</td><td class="num" style="color:${x.amount < 0 ? 'var(--brick)' : 'var(--nile)'}">${x.amount > 0 ? '+' : ''}${fmtMoney(x.amount)}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">—</p>`}`);
  }, { dedupe: true, onError });
  $('#wf', body).addEventListener('submit', (e) => {
    e.preventDefault(); const f = e.target;
    busy($('button', f), async () => {
      try { await api('withdrawals/create', { amount: f.amount.value, method: f.method.value, account: f.account.value }); toast(t('wallet.sent')); f.reset(); $('#werr', body).textContent = ''; await p.now(); }
      catch (er) { $('#werr', body).textContent = errMsg(er); }
    });
  });
  return p;
}
