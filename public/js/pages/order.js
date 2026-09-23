import { api, poll } from '../api.js';
import { state } from '../state.js';
import { t } from '../i18n.js';
import { $, $$, html, raw, render, toast, errMsg, busy, spinner, stamp, orderNo, fmtMoney, fmtNum, fmtDate, label, ratingText, trustBadge, confirmDialog, promptDialog, openModal, starsInput } from '../ui.js';
import { getPos } from '../geo.js';
import { createMap, pinIcon } from '../map.js';
import { uploadImage, hydrate, imgTag } from '../storage.js';

const ACTIVE = ['heading_pickup', 'picked_up', 'in_transit'];
const HELD = ['paid', 'heading_pickup', 'picked_up', 'in_transit', 'delivered'];
const STEPS = ['open', 'accepted', 'paid', 'picked_up', 'in_transit', 'delivered', 'completed'];
const STEPS_PRE = ['pay', 'visible', 'accepted', 'picked_up', 'in_transit', 'delivered', 'completed'];
const STEP_OF_PRE = { awaiting_payment: 0, payment_review: 0, open: 1, paid: 2, heading_pickup: 2, picked_up: 3, in_transit: 4, delivered: 5, completed: 6, resolved: 6 };
const CHAT_OPEN = ['accepted', 'payment_review', 'paid', 'heading_pickup', 'picked_up', 'in_transit', 'delivered', 'disputed'];
const STEP_OF = { open: 0, accepted: 1, payment_review: 1, paid: 2, heading_pickup: 2, picked_up: 3, in_transit: 4, delivered: 5, completed: 6, resolved: 6 };
const NEXT_LABEL = { heading_pickup: 'order.actHeading', picked_up: 'order.actPicked', in_transit: 'order.actTransit', delivered: 'order.actDelivered' };
const NEXT_LABEL_P = { picked_up: 'order.actPickedP', delivered: 'order.actDeliveredP' }; // رحلات الركاب
const NEXT_OF = { paid: 'heading_pickup', heading_pickup: 'picked_up', picked_up: 'in_transit', in_transit: 'delivered' };
const REPORT_REASONS = ['abuse', 'harassment', 'unsafe', 'fraud', 'no_show', 'other'];
const REASONS = ['damaged', 'delay', 'not_as_described', 'payment', 'no_show', 'other'];

const isP = (o) => o?.service === 'passengers';
const stepLabel = (s, o) => { const k = 'pstep.' + s; return isP(o) && t(k) !== k ? t(k) : t('step.' + s); };
const LV = { new: 0, trusted: 1, pro: 2, elite: 3 };

export function renderOrder(el, id) {
  const role = state.profile.role, uid = state.user.uid;
  const home = role === 'admin' ? '/admin/orders' : role === 'driver' ? '/driver/jobs' : '/customer';
  render(el, html`<div class="page-head"><h1 id="title">${t('order.title')} ${orderNo(id)}</h1><a class="btn ghost sm" href="#${home}">${t('common.back')}</a></div>
    <div class="order-layout"><div class="stack"><div class="stack" id="left">${spinner()}</div><div id="chat"></div></div>
    <div class="map-col"><div id="map" class="map tall"></div><p class="hint" id="liveHint"></p></div></div>`);

  const left = $('#left', el), hint = $('#liveHint', el);
  let offerSort = 'price', map = null, order = null, truck = null, poller = null, lastVersion = null, watchId = null, lastSent = 0, getStars = () => 0;

  const truckTo = (lat, lng) => {
    if (!map) return;
    if (!truck) truck = L.marker([lat, lng], { icon: pinIcon('truck') }).addTo(map); else truck.setLatLng([lat, lng]);
  };
  function drawMap(o) {
    if (map) return;
    map = createMap($('#map', el), { center: [o.pickup.lat, o.pickup.lng], zoom: 12 });
    const a = [o.pickup.lat, o.pickup.lng], b = [o.dropoff.lat, o.dropoff.lng];
    L.marker(a, { icon: pinIcon('a') }).addTo(map).bindTooltip(t('order.pickup'));
    L.marker(b, { icon: pinIcon('b') }).addTo(map).bindTooltip(t('order.dropoff'));
    L.polyline([a, b], { color: '#c99400', weight: 3, dashArray: '8 8' }).addTo(map);
    map.fitBounds([a, b], { padding: [40, 40] });
  }

  // ---------- تتبع مباشر ----------
  // السواق: بيبعت موقعه للسيرفر كل ~15 ثانية. العميل/الأدمن: الموقع جاي مع كل تحديث للطلب (طلب واحد بس).
  function syncTracking(o) {
    const driving = role === 'driver' && o.driverId === uid && ACTIVE.includes(o.status);
    if (driving && watchId === null && navigator.geolocation) {
      hint.textContent = t('order.sharingLoc');
      watchId = navigator.geolocation.watchPosition((p) => {
        truckTo(p.coords.latitude, p.coords.longitude);
        if (Date.now() - lastSent < 15000) return; lastSent = Date.now();
        api('orders/location', { orderId: id, lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy || 0) }).catch(() => {});
      }, () => { hint.textContent = t('err.geo_denied'); }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    } else if (!driving && watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; hint.textContent = ''; }
  }
  function showLocation(o, loc) {
    if (role === 'driver' || !ACTIVE.includes(o.status)) return;
    if (!loc) { hint.textContent = t('order.waitingLoc'); return; }
    truckTo(loc.lat, loc.lng); hint.textContent = `${t('order.lastSeen')}: ${fmtDate(loc.at)}`;
  }

  // ---------- عرض ----------
  const kv = (k, v) => html`<dt>${k}</dt><dd>${v}</dd>`;
  const photos = (refs) => html`<div class="photos">${(refs || []).map((r) => raw(imgTag(r)))}</div>`;
  const tel = (p) => raw(`<a href="tel:${String(p).replace(/[^0-9+]/g, '')}" dir="ltr">${String(p).replace(/[^0-9+]/g, '')}</a>`);

  // ---------- عروض الأسعار ----------
  const vehicleName = (v) => (t('vehicle.' + v) === 'vehicle.' + v ? v || '' : t('vehicle.' + v));
  function offersHtml(o) {
    if (!o.offers?.length) return '';
    const list = [...o.offers].sort(offerSort === 'trust'
      ? (a, b) => (LV[b.trust?.level] - LV[a.trust?.level]) || a.price - b.price   // الأعلى ثقة أولاً
      : (a, b) => a.price - b.price || (LV[b.trust?.level] - LV[a.trust?.level])); // الأرخص أولاً (والمستوى الأعلى عند التساوي)
    return html`<div class="row" style="margin-top:.8rem"><h3 class="grow" style="margin:0">${t('offer.list')} (${o.offers.length})</h3>${role === 'customer' && list.length > 1 ? html`<div class="seg"><button type="button" data-act="sort" data-s="price" class="${offerSort === 'price' ? 'on' : ''}">${t('offer.sortPrice')}</button><button type="button" data-act="sort" data-s="trust" class="${offerSort === 'trust' ? 'on' : ''}">${t('offer.sortTrust')}</button></div>` : ''}</div><div class="stack" style="margin-top:.6rem">${list.map((f) => {
      const diff = f.price - o.price;
      return html`<div class="offer-card"><div class="row"><div class="grow"><b>${f.driverName}</b>
        <div style="margin:.15rem 0">${trustBadge(f.trust)}</div><div class="muted small">${vehicleName(f.vehicleType)} · ${ratingText(f)} · ${f.completedOrders || 0} ${t('admin.trips')}</div>${f.note ? html`<div class="small">${f.note}</div>` : ''}</div>
        <div><b class="price">${fmtMoney(f.price)}</b>${diff ? html`<div class="small muted">${diff > 0 ? '+' : ''}${fmtMoney(diff)}</div>` : ''}</div></div>
        ${role === 'customer' ? html`<div class="row end"><button class="btn ghost sm" data-act="offerReject" data-id="${f.id}">${t('offer.reject')}</button><button class="btn ok sm" data-act="offerAccept" data-id="${f.id}">${t('offer.accept')}</button></div>` : ''}</div>`;
    })}</div>`;
  }
  function driverOpenHtml(o) {
    if (o.payMode === 'before') return html`<div class="action good"><p>${t('order.prepaidFixed', { price: fmtMoney(o.price) })}</p><button class="btn primary block" data-act="accept">${t('order.acceptPrepaid')}</button></div>`;
    const S = state.settings, canInstant = o.instant !== false, my = o.myOffer?.status === 'pending' ? o.myOffer : null;
    const lo = Math.max(Math.ceil(S.minPrice || 0), Math.ceil((o.price * (S.offerMinPct || 70)) / 100)), hi = Math.ceil((o.price * (S.offerMaxPct || 200)) / 100);
    return html`<div class="action"><p>${t('order.driverOpenMsg')}</p>
      ${canInstant ? html`<button class="btn primary block" data-act="accept">${t('order.acceptAt', { price: fmtMoney(o.price) })}</button>` : html`<p class="hint">${t('offer.offersOnly')}</p>`}
      ${S.offersEnabled === false ? '' : html`<div class="offer-box">
        ${my ? html`<p style="margin:0">${t('offer.yours')}: <b>${fmtMoney(my.price)}</b> — ${t('offer.waiting')}</p>` : ''}
        <label class="f">${t('offer.price')} <span class="muted small">(${t('offer.range')}: ${fmtNum(lo, 0)}–${fmtNum(hi, 0)})</span><input type="number" id="offerPrice" min="${lo}" max="${hi}" step="1" value="${my ? my.price : o.price}"></label>
        <input id="offerNote" maxlength="200" placeholder="${t('offer.note')}" aria-label="${t('offer.note')}" value="${my?.note || ''}">
        <div class="row"><button class="btn ${canInstant ? 'ghost' : 'primary'} grow" data-act="offer">${my ? t('offer.update') : t('offer.send')}</button>${my ? html`<button class="btn ghost sm" data-act="offerWithdraw">${t('offer.withdraw')}</button>` : ''}</div></div>`}</div>`;
  }

  function stepsHtml(o) {
    if (o.status === 'cancelled') return '';
    const pre = o.payMode === 'before', map = pre ? STEP_OF_PRE : STEP_OF;
    const idx = o.status === 'disputed' ? (map[o.prevStatus] ?? 2) : (map[o.status] ?? 0);
    return html`<ol class="steps" aria-label="${t('order.progress')}">${(pre ? STEPS_PRE : STEPS).map((s, i) => html`<li class="${i < idx ? 'done' : i === idx ? 'done now' : ''}">${stepLabel(s, o)}</li>`)}</ol>`;
  }

  function actionsHtml(o) {
    const s = o.status, mine = o.driverId === uid;
    const dispute = html`<button class="btn ghost sm" data-act="dispute">${t('order.openDispute')}</button>`;
    if (role === 'customer') {
      if (s === 'open' && o.escrowStatus === 'held') { // مدفوع مقدماً وظاهر للسواقين
        const until = new Date((o.scheduledAt || 0) + ((state.settings.prepaidGraceMin ?? 30) * 60000));
        return html`<div class="action good"><p>${t('order.prepaidOpen')}</p><p class="hint">${t('order.prepaidExpiry', { time: fmtDate(until) })}</p><button class="btn ghost sm" data-act="cancel">${t('order.cancelRefund')}</button></div>`;
      }
      if (s === 'open') return html`<div class="action info"><p>${t('order.waitDriver')}</p>${offersHtml(o)}<button class="btn ghost sm" data-act="cancel">${t('order.cancel')}</button></div>`;
      if (s === 'accepted' || s === 'awaiting_payment') {
        const ip = state.settings.instapay || {};
        return html`<div class="action"><h3>${t('order.payTitle')}</h3><p>${t(o.payMode === 'before' ? 'order.payIntroPre' : 'order.payIntro')}</p>
          ${o.paymentRejectReason ? html`<p class="err">${t('order.payRejected')}: ${o.paymentRejectReason}</p>` : ''}
          <div class="pay-box"><div class="muted small">${t('order.payAmount')}</div><b>${fmtMoney(o.price)}</b>
            <div class="small">${t('order.payTo')}: <b dir="ltr">${ip.handle}</b> — ${ip.name}</div></div>
          <label class="f" style="margin-top:.8rem">${t('order.proof')}<input type="file" id="proof" accept="image/*"></label>
          <label class="f" style="margin-top:.5rem">${t('order.payRef')}<input id="payref" maxlength="40"></label>
          <div class="row" style="margin-top:.8rem"><button class="btn primary grow" data-act="pay">${t('order.sendProof')}</button><button class="btn ghost sm" data-act="cancel">${t('order.cancel')}</button></div></div>`;
      }
      if (s === 'payment_review') return html`<div class="action info">${t('order.reviewing')}</div>`;
      if (HELD.includes(s) && s !== 'delivered') return html`<div class="action info"><p>${t('order.held')}</p><div class="row">${dispute}${['paid', 'heading_pickup'].includes(s) && o.escrowStatus === 'held' ? html`<button class="btn ghost sm" data-act="cancel">${t('order.cancelFee')}</button>` : ''}</div></div>`;
      if (s === 'delivered') return html`<div class="action good"><h3>${t(isP(o) ? 'order.deliveredTitleP' : 'order.deliveredTitle')}</h3><p>${t(isP(o) ? 'order.deliveredMsgP' : 'order.deliveredMsg')}</p><div class="row"><button class="btn ok grow" data-act="confirm">${t(isP(o) ? 'order.confirmReceiptP' : 'order.confirmReceipt')}</button>${dispute}</div></div>`;
    }
    if (role === 'driver') {
      if (s === 'open') return driverOpenHtml(o);
      if (!mine) return '';
      if (s === 'accepted') return html`<div class="action info"><p>${t('order.waitPay')}</p><button class="btn ghost sm" data-act="cancel">${t('order.cancel')}</button></div>`;
      const nx = NEXT_OF[s];
      if (nx) {
        const needPhoto = nx === 'picked_up' || nx === 'delivered';
        return html`<div class="action"><h3>${t('order.nextStep')}</h3>
          ${needPhoto ? html`<label class="f">${isP(o) ? t('order.photoOptional') : t(nx === 'picked_up' ? 'order.photoPickup' : 'order.photoDelivery')}<input type="file" id="handover" accept="image/*" capture="environment"></label><p class="hint">${t('order.gpsRule')}</p>` : ''}
          <button class="btn primary block" data-act="next" data-next="${nx}" style="margin-top:.6rem">${t(isP(o) && NEXT_LABEL_P[nx] ? NEXT_LABEL_P[nx] : NEXT_LABEL[nx])}</button>
          <div class="row" style="margin-top:.6rem">${dispute}${['paid', 'heading_pickup'].includes(s) ? html`<button class="btn ghost sm" data-act="cancel">${t('order.driverWithdraw')}</button>` : ''}</div></div>`;
      }
      if (s === 'delivered') return html`<div class="action info"><p>${t('order.waitConfirm')}</p>${dispute}</div>`;
    }
    if (role === 'admin') {
      if (s === 'payment_review') return html`<div class="action"><h3>${t('admin.reviewPayment')}</h3><p>${t('order.payAmount')}: <b>${fmtMoney(o.price)}</b> — ${t('order.payRef')}: <b>${o.paymentRef || '—'}</b></p>
        <div class="row"><button class="btn ok" data-act="admPay" data-a="confirm">${t('admin.confirmPay')}</button><button class="btn danger" data-act="admPay" data-a="reject">${t('admin.rejectPay')}</button></div></div>`;
      if (['open', 'accepted', 'awaiting_payment'].includes(s) && o.escrowStatus !== 'held') return html`<div class="action"><h3>${t('admin.overridePrice')}</h3><div class="row"><input type="number" id="newPrice" min="1" value="${o.price}" style="max-width:160px"><input id="priceNote" class="grow" placeholder="${t('admin.priceNote')}"><button class="btn primary" data-act="admPrice">${t('common.save')}</button></div></div>`;
      if (s === 'disputed') return html`<div class="action bad">${t('order.disputed')} — <a href="#/admin/disputes">${t('admin.tab.disputes')}</a></div>`;
    }
    if (s === 'disputed') return html`<div class="action bad"><p>${t('order.disputed')}</p></div>`;
    if (s === 'cancelled') return html`<div class="action bad"><p>${t('order.cancelledMsg')}${o.cancelReason ? ': ' + (o.cancelReason === 'no_driver' ? t('refund.reason.no_driver') : o.cancelReason) : ''}</p>${o.cancelFee ? html`<p>${t('order.cancelFeeInfo', { driver: fmtMoney(o.driverNet), platform: fmtMoney(o.commission), refund: fmtMoney(o.customerRefund) })}</p>` : ''}${o.refund ? html`<p><b>${t('refund.title')}:</b> ${t('refund.' + o.refund.status, { amount: fmtMoney(o.refund.amount) })}</p>` : ''}</div>`;
    if (s === 'resolved') return html`<div class="action good"><p>${t('order.resolvedMsg')}: <b>${t('dispute.decision.' + o.resolution)}</b></p></div>`;
    if (s === 'completed') {
      const my = role === 'customer' ? o.rateByCustomer : role === 'driver' ? o.rateByDriver : null;
      return html`<div class="action good"><h3>${t('order.done')}</h3>
        ${role === 'driver' ? html`<p>${t('order.youEarned')}: <b>${fmtMoney(o.driverNet)}</b> <span class="muted small">(${t('order.commission')}: ${fmtMoney(o.commission)})</span></p>` : ''}
        ${role === 'admin' ? html`<p>${t('order.commission')}: <b>${fmtMoney(o.commission)}</b> — ${t('order.driverNet')}: ${fmtMoney(o.driverNet)}</p>` : ''}
        ${role !== 'admin' && !my ? html`<div class="stack"><div>${t('order.rate')}</div><div id="stars" class="stars"></div><textarea id="rcomment" maxlength="300" placeholder="${t('order.rateHint')}"></textarea><button class="btn primary" data-act="rate">${t('order.sendRating')}</button></div>`
          : my ? html`<p>${t('order.yourRating')}: ${'★'.repeat(my.stars)}</p>` : ''}
        ${role === 'customer' ? html`<button class="btn ghost sm" data-act="share">${t('order.share')}</button>` : ''}</div>`;
    }
    return '';
  }

  function detailsHtml(o) {
    const showDriver = o.driverId && (role !== 'driver');
    const showCustomer = role === 'admin' || (role === 'driver' && o.driverId === uid);
    const showCustPhone = role === 'admin' || (role === 'driver' && HELD.concat(['completed', 'disputed']).includes(o.status));
    return html`<div class="card"><dl class="kv">
      ${kv(t('order.pickup'), o.pickup.address || '—')}${kv(t('order.dropoff'), o.dropoff.address || '—')}
      ${isP(o) ? html`${kv(t('order.service'), t('service.passengers'))}${kv(t('order.vehicleClass'), label(state.settings.passengerClasses?.[o.vehicleClass], o.vehicleClass))}${kv(t('order.passengers'), o.passengers)}` : html`${kv(t('order.category'), label(state.settings.categories?.[o.category], o.category))}${kv(t('order.size'), label(state.settings.sizes?.[o.size], o.size))}
      ${kv(t('order.weight'), `${fmtNum(o.weightKg, 0)} ${t('common.kg')}`)}`}${kv(t('order.distance'), `${fmtNum(o.distanceKm)} ${t('common.km')}${o.distanceSource === 'estimate' ? ' ~' : ''}`)}
      ${kv(t('order.when'), fmtDate(o.scheduledAt))}
      ${o.payMode === 'before' ? kv(t('order.payMode'), t('order.prepaid')) : ''}${kv(t('order.price'), html`<b>${fmtMoney(o.price)}</b>${o.priceOverridden ? html` <span class="muted small">(${t('order.priceAdjusted')}${o.priceNote ? ': ' + o.priceNote : ''})</span>` : ''}${o.priceNegotiated ? html` <span class="muted small">(${t('order.priceNegotiated')})</span>` : ''}`)}
      ${o.description ? kv(t('order.notes'), o.description) : ''}
      ${showDriver ? kv(t('order.driver'), html`${o.driverName} — ${tel(o.driverPhone)} <span class="muted small">(${t('vehicle.' + o.driverVehicle) === 'vehicle.' + o.driverVehicle ? o.driverVehicle : t('vehicle.' + o.driverVehicle)})</span>${o.driverTrust ? html`<div style="margin-top:.2rem">${trustBadge(o.driverTrust)}</div>` : ''}`) : ''}
      ${showCustomer ? kv(t('order.customer'), html`${o.customerName}${showCustPhone ? html` — ${tel(o.customerPhone)}` : ''}`) : ''}
    </dl></div>
    <div class="card stack"><h3>${t('order.photos')}</h3>
      ${o.photos?.length ? html`<div><div class="muted small">${t('order.cargoPhotos')}</div>${photos(o.photos)}</div>` : ''}
      ${o.pickupPhoto ? html`<div><div class="muted small">${t('order.pickupPhoto')}</div>${photos([o.pickupPhoto])}</div>` : ''}
      ${o.deliveryPhoto ? html`<div><div class="muted small">${t('order.deliveryPhoto')}</div>${photos([o.deliveryPhoto])}</div>` : ''}
      ${o.paymentProof && role !== 'driver' ? html`<div><div class="muted small">${t('order.proof')}</div>${photos([o.paymentProof])}</div>` : ''}</div>
    <details class="card"><summary><b>${t('order.log')}</b></summary><ul class="log" style="margin-top:.6rem">${(o.log || []).map((l) => html`<li><span>${t('status.' + l.status)}${l.note ? ' — ' + l.note : ''}${l.lat && role !== 'driver' ? html` <a href="https://www.openstreetmap.org/?mlat=${l.lat}&mlon=${l.lng}#map=17/${l.lat}/${l.lng}" target="_blank" rel="noopener">📍</a>` : ''}</span><span class="muted">${fmtDate(l.at)}</span></li>`)}</ul></details>`;
  }

  // ---------- الأمان: بلاغ + زر طوارئ (ركاب أثناء الرحلة) ----------
  function safetyHtml(o) {
    if (!(o.driverId && (o.customerId === uid || o.driverId === uid))) return '';
    const sos = isP(o) && ['heading_pickup', 'picked_up', 'in_transit'].includes(o.status);
    return html`<div class="row" style="justify-content:flex-end">${sos ? html`<button class="btn danger" data-act="sos">${t('sos.button')}</button>` : ''}<button class="btn ghost sm" data-act="report">${t('report.open')}</button></div>`;
  }
  function openReport(reason = 'other') {
    const { el: m, close } = openModal(html`<h3>${t('report.title')}</h3><p class="hint">${t('report.intro')}</p>
      <div class="stack"><label class="f">${t('report.reason')}<select id="rr">${REPORT_REASONS.map((r) => html`<option value="${r}">${t('report.reason.' + r)}</option>`)}</select></label>
      <label class="f">${t('report.details')}<textarea id="rd" maxlength="1000"></textarea></label><p class="err" id="rerr" role="alert"></p></div>
      <div class="row end"><button class="btn ghost" data-x="0">${t('common.cancel')}</button><button class="btn danger" data-x="1">${t('report.submit')}</button></div>`);
    $('#rr', m).value = reason;
    m.addEventListener('click', (e) => {
      const b = e.target.closest('[data-x]'); if (!b) return; if (b.dataset.x === '0') return close();
      busy(b, async () => {
        try { await api('reports/create', { orderId: id, reason: $('#rr', m).value, details: $('#rd', m).value }); toast(t('report.sent')); close(); }
        catch (er) { $('#rerr', m).textContent = errMsg(er); }
      });
    });
  }
  function openSos() {
    const { el: m, close } = openModal(html`<div class="alert-order" style="border-top-color:var(--brick)"><h3 style="color:var(--brick)">${t('sos.title')}</h3><p>${t('sos.intro')}</p>
      <div class="stack"><a class="btn danger block" href="tel:122">${t('sos.police')}</a><a class="btn danger block" href="tel:123">${t('sos.ambulance')}</a>
      <button class="btn primary block" data-x="notify">${t('sos.notify')}</button><p class="ok-msg" id="sosMsg" role="status"></p></div>
      <div class="row end" style="margin-top:.8rem"><button class="btn ghost" data-x="close">${t('common.close')}</button></div></div>`);
    m.addEventListener('click', (e) => {
      const b = e.target.closest('[data-x]'); if (!b) return; if (b.dataset.x === 'close') return close();
      busy(b, async () => { const loc = await getPos().catch(() => null); await api('sos/trigger', { orderId: id, ...(loc || {}) }); $('#sosMsg', m).textContent = t('sos.sent'); });
    });
  }

  // ---------- الشات (بيفتح بعد ما سواق يتحدد) ----------
  let chatCtl = null, chatKey = null;
  function chatPanel(box, { orderId, other, readonly, open, onReport }) {
    let after = 0, isOpen = open, shown = 0;
    render(box, html`<div class="card stack"><div class="row"><h3 class="grow" style="margin:0">${t('chat.title')}</h3>${readonly ? '' : html`<button type="button" class="btn ghost sm" data-report>${t('report.chat')}</button>`}</div><div id="msgs" class="chat-msgs" role="log" aria-live="polite"><div class="chat-empty">${t('chat.empty', { name: other || '' })}</div></div>
      ${readonly ? html`<p class="hint">${t('chat.readonly')}</p>` : html`<form id="cf" class="row" novalidate><input name="text" class="grow" maxlength="500" autocomplete="off" placeholder="${t('chat.placeholder')}" aria-label="${t('chat.placeholder')}"><button class="btn primary" type="submit">${t('chat.send')}</button></form><p class="hint" id="cclosed" hidden>${t('chat.closed')}</p>`}</div>`);
    const msgs = $('#msgs', box), form = $('#cf', box);
    const lock = () => { if (form) { form.hidden = !isOpen; $('#cclosed', box).hidden = isOpen; } };
    const add = (m) => {
      if (!shown++) msgs.innerHTML = '';
      const d = document.createElement('div'); d.className = 'msg ' + (m.mine ? 'me' : 'them');
      d.innerHTML = html`<span class="who">${m.mine ? t('chat.you') : t('chat.' + m.from)}</span><p>${m.body}</p><time>${fmtDate(m.at)}</time>`.s; msgs.append(d);
    };
    const p = poll(() => api('chat/list', { orderId, after }), () => (isOpen ? 6000 : 60000), (r) => {
      isOpen = r.open; lock();
      for (const m of r.messages) { after = Math.max(after, m.seq); add(m); }
      if (r.messages.length) msgs.scrollTop = msgs.scrollHeight;
    }, { onError: (e) => (e.code === 'chat_closed' ? false : undefined) });
    lock();
    box.addEventListener('click', (e) => { if (e.target.closest('[data-report]')) onReport?.(); });
    form?.addEventListener('submit', (e) => {
      e.preventDefault(); const inp = form.elements.text, text = inp.value.trim(); if (!text) return;
      busy($('button', form), async () => { await api('chat/send', { orderId, body: text }); inp.value = ''; await p.now(); });
    });
    return { stop: p, setOpen: (v) => { isOpen = v; lock(); } };
  }
  function syncChat(o) {
    const can = o.driverId && (role === 'admin' || o.customerId === uid || o.driverId === uid);
    const key = can ? `${o.id}:${o.driverId}` : null;
    if (key === chatKey) { chatCtl?.setOpen(CHAT_OPEN.includes(o.status)); return; }
    chatCtl?.stop(); chatCtl = null; chatKey = key; $('#chat', el).innerHTML = '';
    if (can) chatCtl = chatPanel($('#chat', el), { orderId: o.id, other: role === 'driver' ? o.customerName : o.driverName, readonly: role === 'admin', open: CHAT_OPEN.includes(o.status), onReport: () => openReport('abuse') });
  }

  function paint(o) {
    render($('#title', el), html`${t('order.title')} ${orderNo(o.id)} ${stamp(o.status, o.service)}`);
    render(left, html`${stepsHtml(o)}<div id="actions">${actionsHtml(o)}</div>${safetyHtml(o)}${detailsHtml(o)}`);
    hydrate(left);
    const st = $('#stars', left); if (st) getStars = starsInput(st);
    drawMap(o); syncTracking(o); syncChat(o);
  }

  // ---------- الإجراءات ----------
  const call = async (route, body, okMsg) => { const r = await api(route, { orderId: id, ...body }); if (okMsg) toast(t(okMsg)); await poller?.now(); return r; };
  const requireFile = (inputId) => { const f = $('#' + inputId, left)?.files?.[0]; if (!f) throw Object.assign(new Error('bad_file'), { code: 'bad_file' }); return f; };
  const actions = {
    accept: () => call('orders/accept', {}, 'order.acceptedToast'),
    offer: () => call('offers/create', { price: $('#offerPrice', left).value, note: $('#offerNote', left).value }, 'offer.sent'),
    offerWithdraw: () => call('offers/withdraw', {}, 'offer.withdrawn'),
    async offerAccept(b) { if (await confirmDialog(t('offer.accept') + '؟', { ok: t('offer.accept') })) await call('offers/accept', { offerId: b.dataset.id }, 'offer.acceptedToast'); },
    offerReject: (b) => call('offers/reject', { offerId: b.dataset.id }, 'common.done'),
    sort(b) { offerSort = b.dataset.s; paint(order); },
    report: () => openReport(),
    sos: () => openSos(),
    async cancel() {
      if (role === 'driver') { // السواق يعتذر: الطلب بيرجع لسواقين تانيين
        if (!(await confirmDialog(t('order.driverWithdrawAsk'), { danger: true, ok: t('order.driverWithdraw') }))) return;
        await call('orders/cancel', {}, 'order.driverWithdrawn'); location.hash = '#/driver/jobs'; return;
      }
      if (role === 'customer' && ['paid', 'heading_pickup'].includes(order.status) && order.escrowStatus === 'held') { // إلغاء برسوم بعد قبول السواق
        const S = state.settings, h = order.status === 'heading_pickup';
        const dp = h ? S.cancelHeadingDriverPct : S.cancelPaidDriverPct, pp = h ? S.cancelHeadingPlatformPct : S.cancelPaidPlatformPct;
        const d = Math.round((order.price * dp) / 100), pl = Math.min(order.price - d, Math.round((order.price * pp) / 100));
        if (!(await confirmDialog(t('order.cancelFeeAsk', { driver: fmtMoney(d), platform: fmtMoney(pl), refund: fmtMoney(order.price - d - pl) }), { danger: true, ok: t('order.cancelFee') }))) return;
        await call('orders/cancel', {}, 'order.cancelFeeToast'); return;
      }
      if (role === 'customer' && order.escrowStatus === 'held') { // مدفوع مقدماً => استرجاع
        if (!(await confirmDialog(t('order.cancelRefundAsk', { amount: fmtMoney(order.price) }), { danger: true, ok: t('order.cancelRefund') }))) return;
        await call('orders/cancel', {}, 'order.cancelRefundToast'); return;
      }
      const reason = await promptDialog(t('order.cancelAsk'));
      if (reason === null) return;
      await call('orders/cancel', { reason }, 'order.cancelledToast');
      if (role === 'driver') location.hash = '#/driver/jobs';
    },
    async pay() {
      const ref = await uploadImage(requireFile('proof'), 'payment');
      await call('orders/pay', { proofRef: ref, reference: $('#payref', left).value }, 'order.proofSent');
    },
    async next(b) {
      const nx = b.dataset.next; const body = { next: nx };
      if (nx === 'picked_up' || nx === 'delivered') {
        const file = $('#handover', left)?.files?.[0]; // إجبارية للبضاعة، واختيارية للركاب
        if (file) body.photoRef = await uploadImage(file, 'handover'); else if (!isP(order)) throw Object.assign(new Error('bad_file'), { code: 'bad_file' });
        body.loc = await getPos();
      } else { try { body.loc = await getPos(); } catch { /* اختياري */ } }
      await call('orders/status', body, 'order.updated');
    },
    async confirm() { if (await confirmDialog(t(isP(order) ? 'order.confirmAskP' : 'order.confirmAsk'), { ok: t(isP(order) ? 'order.confirmReceiptP' : 'order.confirmReceipt') })) await call('orders/confirm', {}, 'order.confirmed'); },
    async rate() { const stars = getStars(); if (!stars) throw Object.assign(new Error('bad_input'), { code: 'bad_input' }); await call('orders/rate', { stars, comment: $('#rcomment', left).value }, 'order.thanks'); },
    async share() {
      const data = { title: t('brand'), text: t('order.shareText'), url: location.origin };
      if (navigator.share) await navigator.share(data).catch(() => {}); else { await navigator.clipboard?.writeText(`${data.text} ${data.url}`); toast(t('order.copied')); }
    },
    dispute: () => openDispute(),
    async admPay(b) {
      const a = b.dataset.a; let note = '';
      if (a === 'reject') { note = await promptDialog(t('admin.rejectReason'), { required: true }); if (note === null) return; }
      await call('admin/payment', { action: a, note }, 'common.done');
    },
    async admPrice() { await call('admin/order-price', { price: $('#newPrice', left).value, note: $('#priceNote', left).value }, 'common.done'); },
  };
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b || !actions[b.dataset.act]) return;
    busy(b, () => actions[b.dataset.act](b));
  });

  function openDispute() {
    const { el: m, close } = openModal(html`<h3>${t('dispute.title')}</h3><p class="hint">${t('dispute.intro')}</p>
      <div class="stack"><label class="f">${t('dispute.reason')}<select id="dr">${REASONS.map((r) => html`<option value="${r}">${t('dispute.reason.' + r)}</option>`)}</select></label>
      <label class="f">${t('dispute.details')}<textarea id="dd" maxlength="1000"></textarea></label>
      <label class="f">${t('dispute.evidence')}<input type="file" id="de" accept="image/*" multiple></label><p class="err" id="derr"></p></div>
      <div class="row end"><button class="btn ghost" data-x="0">${t('common.cancel')}</button><button class="btn danger" data-x="1">${t('dispute.submit')}</button></div>`);
    m.addEventListener('click', (e) => {
      const b = e.target.closest('[data-x]'); if (!b) return; if (b.dataset.x === '0') return close();
      busy(b, async () => {
        try {
          const evidence = []; for (const f of [...$('#de', m).files].slice(0, 5)) evidence.push(await uploadImage(f, 'evidence'));
          await call('disputes/create', { reason: $('#dr', m).value, details: $('#dd', m).value, evidence }, 'dispute.sent'); close();
        } catch (er) { $('#derr', m).textContent = errMsg(er); }
      });
    });
  }

  // تحديث دوري (Polling): أسرع أثناء التنفيذ وأبطأ بعد ما الطلب يخلص
  const notFound = () => render(left, html`<div class="empty">${t('order.notFound')}</div>`);
  poller = poll(() => api('orders/get', { orderId: id }),
    () => (order && ACTIVE.includes(order.status) ? 6000 : order?.status === 'open' ? 8000 : order && ['completed', 'cancelled', 'resolved'].includes(order.status) ? 60000 : 12000),
    ({ order: o, location }) => {
      order = o;
      // نعيد الرسم فقط لو الطلب أو عروضه اتغيّرت (يحمي الفورم من المسح)
      const sig = `${o.version}|${(o.offers || []).map((f) => f.id + ':' + f.price).join(',')}|${o.myOffer ? o.myOffer.id + o.myOffer.status + o.myOffer.price : ''}`;
      if (sig !== lastVersion) { lastVersion = sig; paint(o); }
      showLocation(o, location);
    },
    { onError: (e) => { if (['forbidden', 'order_not_found'].includes(e.code)) { notFound(); return false; } toast(errMsg(e), true); } });

  return () => { poller(); chatCtl?.stop(); if (watchId !== null) navigator.geolocation.clearWatch(watchId); map?.remove(); };
}
