// لوحة بيانات السواق: كل حاجة تخصه في صفحة واحدة (قراءة فقط) — البيانات كلها من driver/dashboard
import { api } from '../api.js';
import { t } from '../i18n.js';
import { html, render, skeleton, errMsg, fmtMoney, fmtNum, fmtDate, stamp, orderNo, trustBadge } from '../ui.js';

const bar = (pct, cls = '') => html`<div class="pbar ${cls}" role="img" aria-label="${pct ?? 0}%"><i class="pbar-fill" data-w="${Math.max(0, Math.min(100, pct ?? 0))}"></i></div>`;
const kpi = (label, value, sub) => html`<div class="card kpi"><div class="muted small">${label}</div><div class="kpi-v num">${value}</div>${sub ? html`<div class="muted small">${sub}</div>` : ''}</div>`;
const yn = (ok) => html`<span class="${ok ? 'ok-t' : 'no-t'}">${ok ? '✓' : '✗'}</span>`;

export function renderDriverDash(view) {
  render(view, html`<div class="page-head"><h1>${t('dash.title')}</h1></div><div id="dash">${skeleton(3)}</div>`);
  const box = view.querySelector('#dash'); let dead = false, timer = null;
  async function load() {
    let d, lt; try { [d, lt] = await Promise.all([api('driver/dashboard', {}), api('late/list', {}).catch(() => null)]); } catch (e) { if (!dead) render(box, html`<div class="card"><p>${errMsg(e)}</p></div>`); return; }
    if (dead) return;
    const p = d.profile, w = d.wallet, e = d.earnings, o = d.orders, r = d.ratings, tr = d.trust, pr = d.protection, S = tr.stats, n = tr.next;
    const lateTxt = o.sample ? Math.round((o.lateCount / o.sample) * 100) + '%' : '—';
    render(box, html`
      ${p.walletFrozen ? html`<div class="action bad"><p><b>${t('dash.frozen')}</b></p></div>` : ''}
      ${p.status !== 'active' ? html`<div class="action"><p>${t('dash.notActive')}</p></div>` : ''}
      <div class="card row"><div class="grow"><h2 style="margin:0">${p.companyName || p.name}</h2><div class="muted small" dir="ltr">${p.phone}</div></div>${stamp(p.status)}${trustBadge(tr)}</div>

      <div class="grid-4">${kpi(t('dash.balance'), fmtMoney(w.balance), w.pendingWithdrawals ? t('dash.pendingWd', { amount: fmtMoney(w.pendingWithdrawals) }) : '')}
        ${kpi(t('dash.earn30'), fmtMoney(e.d30.net), t('dash.trips', { n: fmtNum(e.d30.trips, 0) }))}
        ${kpi(t('dash.completed'), fmtNum(o.completed, 0), t('dash.activeNow', { n: fmtNum(o.activeCount, 0), max: fmtNum(o.maxActive, 0) }))}
        ${kpi(t('dash.rating'), r.avg ? '★ ' + r.avg : '—', t('dash.ratingCount', { n: fmtNum(r.count, 0) }))}</div>

      <section class="card stack"><h3>${t('dash.earnings')}</h3>
        <div class="dtbl-wrap"><table class="dtbl"><thead><tr><th></th><th>${t('dash.trips0')}</th><th>${t('dash.gross')}</th><th>${t('dash.commission')}</th><th>${t('dash.net')}</th></tr></thead><tbody>
          ${[['d1', 'dash.last24'], ['d7', 'dash.last7'], ['d30', 'dash.last30']].map(([k, l]) => html`<tr><td>${t(l)}</td><td class="num">${fmtNum(e[k].trips, 0)}</td><td class="num">${fmtMoney(e[k].gross)}</td><td class="num">${fmtMoney(e[k].commission)}</td><td class="num"><b>${fmtMoney(e[k].net)}</b></td></tr>`)}
          <tr><td>${t('dash.allTime')}</td><td class="num">${fmtNum(e.all.trips, 0)}</td><td>—</td><td>—</td><td class="num"><b>${fmtMoney(e.all.net)}</b></td></tr></tbody></table></div>
        <p class="muted small">${t('dash.paidOut')}: <b>${fmtMoney(w.paidWithdrawals)}</b> · ${t('dash.pendingWdLbl')}: <b>${fmtMoney(w.pendingWithdrawals)}</b> · <a href="#/driver/wallet">${t('nav.wallet')}</a></p></section>

      <section class="card stack"><h3>${t('dash.orders')}</h3>
        ${o.active.length ? html`<ul class="plain">${o.active.map((x) => html`<li class="row"><a class="grow" href="#/order/${x.id}"><b>${x.no}</b> · ${x.pickup || '—'} ← ${x.dropoff || '—'}</a>${x.late ? html`<span class="stamp s-cancelled">${t('trip.late.short')}</span>` : ''}${stamp(x.status)}<b class="num">${fmtMoney(x.price)}</b></li>`)}</ul>` : html`<p class="muted">${t('dash.noActive')} <a href="#/driver">${t('nav.available')}</a></p>`}
        <div class="grid-4 sm">${kpi(t('dash.cancelledByYou'), fmtNum(o.cancelledByYou, 0))}${kpi(t('dash.disputes'), `${fmtNum(o.disputesOpen, 0)} / ${fmtNum(o.disputesTotal, 0)}`, t('dash.disputesHint'))}${kpi(t('dash.lateRate'), lateTxt, t('dash.lateHint', { n: fmtNum(o.sample, 0) }))}${kpi(t('dash.mismatchUsed'), t('trust.of', { cur: fmtNum(pr.mismatchUsed, 0), target: fmtNum(pr.mismatchLimit, 0) }), t('dash.mismatchHint'))}</div></section>

      <section class="card stack"><h3>${t('dash.ratings')}</h3>
        ${r.quick ? html`<div class="stack-sm">${[['onTime', r.quick.onTime], ['intact', r.quick.intact], ['polite', r.quick.polite]].map(([k, v]) => html`<div class="qbar"><span>${t('dash.q.' + k)}</span>${bar(v)}<b class="num">${v}%</b></div>`)}<p class="muted small">${t('dash.quickBasis', { n: fmtNum(r.quick.n, 0) })}</p></div>` : html`<p class="muted">${t('dash.noQuick')}</p>`}
        ${r.recent.length ? html`<ul class="plain">${r.recent.map((x) => html`<li><div class="row"><b>${x.no}</b><span>${'★'.repeat(x.stars)}</span><span class="muted small">${fmtDate(x.at)}</span></div>${x.comment ? html`<p style="margin:.2rem 0 0">${x.comment}</p>` : ''}</li>`)}</ul>` : ''}</section>

      ${lt ? html`<section class="card stack"><h3>${t('late.driverTitle')}</h3><p>${t('late.points')}: <b class="num">${fmtNum(lt.points, 0)}</b></p><p class="muted small">${t('late.driverHint')}</p>
        ${lt.items.length ? html`<ul class="plain">${lt.items.map((i) => html`<li class="row"><a class="grow" href="#/order/${i.orderId}"><b>${i.no}</b> · ${t('late.' + i.kind)}</a><span class="muted small">${fmtDate(i.dueAt)} (+${fmtNum(i.graceMin, 0)} ${t('late.min')})</span></li>`)}</ul>` : ''}</section>` : ''}

      <section class="card stack"><h3>${t('dash.levelTitle')}</h3>
        <div class="row"><b>${t('trust.commission')}: <bdi>${tr.commissionPct}%</bdi></b><span class="muted small">${t('trust.perks')}</span></div>
        ${n ? html`<p class="hint">${t('trust.next')}: <b>${t('trust.level.' + n.level)}</b></p>
          ${[[t('trust.req.ratings'), S.ratingCount, n.ratings, t('trust.of', { cur: fmtNum(S.ratingCount, 0), target: fmtNum(n.ratings, 0) })]].map(([name, cur, target, txt]) => html`<div class="qbar"><span>${name}</span>${bar(Math.min(100, (cur / target) * 100), cur >= target ? 'ok' : '')}<b><bdi>${txt}</bdi></b></div>`)}
          <div class="qbar"><span>${t('trust.req.avg')}</span>${bar(S.ratingCount ? Math.min(100, (S.ratingAvg / n.avg) * 100) : 0, S.ratingCount && S.ratingAvg >= n.avg ? 'ok' : '')}<b><bdi>${S.ratingCount ? t('trust.avgNeed', { cur: S.ratingAvg, target: n.avg }) : t('trust.noRatingNeed', { target: n.avg })}</bdi></b></div>` : html`<p>${t('trust.top')}</p>`}</section>

      <section class="card stack"><h3>${t('dash.account')}</h3>
        <ul class="plain checks2"><li>${yn(p.status === 'active')} ${t('dash.acc.reviewed')}</li><li>${yn(p.phoneVerified)} ${t('dash.acc.phone')}</li><li>${yn(p.docs.id)} ${t('dash.acc.id')}</li><li>${yn(p.docs.license)} ${t('dash.acc.license')}</li><li>${yn(p.docs.vehicleReg)} ${t('dash.acc.vehicleReg')}</li><li>${yn(p.docs.vehiclePhoto)} ${t('dash.acc.vehiclePhoto')}</li></ul>
        <p class="muted small">${t('dash.since')}: ${fmtDate(p.createdAt)}${p.vehicleType ? ' · ' + t('dash.vehicle') + ': ' + p.vehicleType : ''}</p></section>`);
    box.querySelectorAll('.pbar-fill').forEach((el) => { el.style.width = el.dataset.w + '%'; }); // العرض بيتحط بالـDOM (الـCSP بتمنع style inline في القوالب)
  }
  load(); timer = setInterval(() => { if (!document.hidden) load(); }, 60000);
  return () => { dead = true; clearInterval(timer); };
}
