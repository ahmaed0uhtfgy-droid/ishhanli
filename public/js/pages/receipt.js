import { api, poll } from '../api.js';
import { state } from '../state.js';
import { t } from '../i18n.js';
import { $, html, render, toast, errMsg, spinner, stamp, orderNo, fmtMoney, fmtNum, fmtDate, label, printNode } from '../ui.js';

const PAID = ['payment_review', 'paid', 'heading_pickup', 'picked_up', 'in_transit', 'delivered', 'completed', 'resolved'];
const isP = (o) => o?.service === 'passengers';

// إيصال/فاتورة الرحلة: صفحة قابلة للطباعة (حفظ PDF من المتصفح) للعميل/السواق/الأدمن.
export function renderReceipt(el, id) {
  render(el, html`<div class="page-head no-print"><h1 id="rtitle">${t('receipt.title')}</h1>
    <div class="row"><button class="btn primary sm" id="rprint" disabled>${t('receipt.print')}</button><a class="btn ghost sm" href="#/order/${id}">${t('common.back')}</a></div></div>
    <div id="rcpt">${spinner()}</div>`);
  const box = $('#rcpt', el), btn = $('#rprint', el);
  let order = null;
  const stop = poll(() => api('orders/get', { orderId: id }), () => 60000, ({ order: o }) => {
    order = o;
    render(box, receiptHtml(o));
    render($('#rtitle', el), html`${t('receipt.title')} ${orderNo(o.id)}`);
    btn.disabled = false;
  }, { onError: (e) => { render(box, html`<div class="empty">${t('receipt.notFound')}</div>`); if (!['forbidden', 'order_not_found'].includes(e.code)) toast(errMsg(e), true); return false; } });
  btn.addEventListener('click', () => { if (order) printNode(t('receipt.title') + ' ' + orderNo(order.id), receiptHtml(order)); });
  return stop;
}

function receiptHtml(o) {
  const pax = isP(o);
  const row = (k, v) => html`<tr><th>${k}</th><td>${v}</td></tr>`;
  const escrow = o.escrowStatus === 'held' ? t('receipt.escrowHeld') : o.escrowStatus === 'released' ? t('receipt.escrowReleased') : t('receipt.escrowNone');
  const settled = ['completed', 'resolved'].includes(o.status);
  return html`<div class="card invoice">
    <div class="rc-head"><div><div class="rc-brand">${t('brand')} <b>·</b></div><div class="muted small">${t('receipt.subtitle')}</div></div>
      <div style="text-align:end"><div class="rc-total">${orderNo(o.id)}</div><div class="small">${fmtDate(o.createdAt)}</div><div>${stamp(o.status, o.service)}</div></div></div>
    <h2>${t('receipt.trip')}</h2>
    <table>${row(t('order.pickup'), o.pickup?.address || '—')}${row(t('order.dropoff'), o.dropoff?.address || '—')}
      ${pax ? row(t('order.vehicleClass'), label(state.settings?.passengerClasses?.[o.vehicleClass], o.vehicleClass)) : row(t('order.category'), label(state.settings?.categories?.[o.category], o.category))}
      ${pax ? row(t('order.passengers'), o.passengers) : row(t('order.size'), label(state.settings?.sizes?.[o.size], o.size))}
      ${pax ? '' : row(t('order.weight'), `${fmtNum(o.weightKg, 0)} ${t('common.kg')}`)}
      ${row(t('order.distance'), `${fmtNum(o.distanceKm)} ${t('common.km')}`)}${row(t('order.when'), fmtDate(o.scheduledAt))}
      ${o.description ? row(t('order.notes'), o.description) : ''}</table>
    <h2>${t('receipt.parties')}</h2>
    <table>${row(t('order.customer'), o.customerName || '—')}
      ${row(t('order.driver'), o.driverName ? html`${o.driverName}${o.driverPhone ? html` — <span dir="ltr">${o.driverPhone}</span>` : ''}` : '—')}
      ${o.driverVehicle ? row(t('auth.vehicleType'), t('vehicle.' + o.driverVehicle) === 'vehicle.' + o.driverVehicle ? o.driverVehicle : t('vehicle.' + o.driverVehicle)) : ''}</table>
    <h2>${t('receipt.amounts')}</h2>
    <table>${row(t('order.price'), html`<span class="num">${fmtMoney(o.price)}</span>`)}
      ${o.discount ? row(t('coupon.discount') + (o.couponCode ? ` (${o.couponCode})` : ''), html`<span class="num" style="color:var(--nile)">− ${fmtMoney(o.discount)}</span>`) : ''}
      ${o.discount ? row(t('coupon.due'), html`<b class="num">${fmtMoney(o.amountDue ?? o.price - o.discount)}</b>`) : ''}
      ${settled ? row(t('order.commission'), html`<span class="num">${fmtMoney(o.commission)}</span>`) : ''}
      ${settled ? row(t('order.driverNet'), html`<span class="num">${fmtMoney(o.driverNet)}</span>`) : ''}
      ${row(t('receipt.escrow'), PAID.includes(o.status) || o.escrowStatus === 'held' ? escrow : t('receipt.escrowNone'))}
      ${o.paymentRef ? row(t('order.payRef'), html`<span dir="ltr">${o.paymentRef}</span>`) : ''}
      ${row(t('receipt.issued'), fmtDate(Date.now()))}</table>
    <p class="rc-foot">${t('receipt.electronic')}</p></div>`;
}
