import { api, poll } from '../api.js';
import { state } from '../state.js';
import { t } from '../i18n.js';
import { $, $$, html, raw, render, toast, errMsg, busy, spinner, skeleton, stamp, orderNo, fmtMoney, fmtNum, fmtDate, label, ratingText, trustBadge, confirmDialog, promptDialog, openModal, starsInput, printNode } from '../ui.js';
import { getPos } from '../geo.js';
import { createMap, pinIcon, drawRoute, gmapsLink, distKm } from '../map.js';
import { uploadImage, hydrate, imgTag } from '../storage.js';
import { moneySteps } from '../money.js';

const ACTIVE = ['heading_pickup', 'picked_up', 'in_transit'];
const HELD = ['paid', 'heading_pickup', 'picked_up', 'in_transit', 'delivered'];
const RECEIPT_STATUS = ['paid', 'heading_pickup', 'picked_up', 'in_transit', 'delivered', 'completed', 'resolved'];
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
const dueOf = (o) => (o.amountDue ?? o.price); // المبلغ المطلوب دفعه فعلاً (بعد خصم الكوبون لو موجود)

const isP = (o) => o?.service === 'passengers';
const stepLabel = (s, o) => { const k = 'pstep.' + s; return isP(o) && t(k) !== k ? t(k) : t('step.' + s); };
const LV = { new: 0, trusted: 1, pro: 2, elite: 3 };

export function renderOrder(el, id) {
  let role = state.profile.role; const uid = state.user.uid; // الأدمن على طلب هو عمله بيتعامل كعميل
  const home = role === 'admin' ? '/admin/orders' : role === 'driver' ? '/driver/jobs' : '/customer';
  render(el, html`<div class="page-head"><h1 id="title">${t('order.title')} ${orderNo(id)}</h1><div class="row"><span id="rlink"></span><a class="btn ghost sm" href="#${home}">${t('common.back')}</a></div></div>
    <div class="order-layout"><div class="stack"><div class="stack" id="left">${skeleton(3)}</div><div id="chat"></div></div>
    <div class="map-col"><div id="map" class="map tall"></div><div id="routeInfo" class="route-info"></div><p class="hint" id="liveHint"></p></div></div>`);

  const left = $('#left', el), hint = $('#liveHint', el);
  let fleet = []; // سواقين الشركة (لو الحساب شركة): بنختار منهم مين هيستلم الشحنة
  if (role === 'driver' && state.profile.accountType === 'company') api('fleet/list').then((r) => { fleet = r.drivers; if (order) paint(order); }).catch(() => {});
  let tripTimer, codeInfo, offerSort = 'price', map = null, order = null, truck = null, poller = null, lastVersion = null, watchId = null, lastSent = 0, getStars = () => 0;

  let ab = null; // [نقطة الاستلام، نقطة التسليم]
  const truckTo = (lat, lng) => {
    if (!map) return;
    if (!truck) { truck = L.marker([lat, lng], { icon: pinIcon('truck'), zIndexOffset: 1000 }).addTo(map); if (ab) map.fitBounds([ab[0], ab[1], [lat, lng]], { padding: [50, 50] }); } else truck.setLatLng([lat, lng]);
  };
  function drawMap(o) {
    if (map) return;
    map = createMap($('#map', el), { center: [o.pickup.lat, o.pickup.lng], zoom: 12 });
    const a = [o.pickup.lat, o.pickup.lng], b = [o.dropoff.lat, o.dropoff.lng]; ab = [a, b];
    L.marker(a, { icon: pinIcon('a') }).addTo(map).bindTooltip(t('order.pickup'), { permanent: true, direction: 'top', offset: [0, -42], className: 'pin-tip' });
    L.marker(b, { icon: pinIcon('b') }).addTo(map).bindTooltip(t('order.dropoff'), { permanent: true, direction: 'top', offset: [0, -42], className: 'pin-tip' });
    map.fitBounds([a, b], { padding: [50, 50] });
    const info = $('#routeInfo', el);
    const paint = (r) => render(info, html`<div class="legend"><span><i class="dot dot-a"></i>${t('order.pickup')}</span><span><i class="dot dot-b"></i>${t('order.dropoff')}</span><span>🚚 ${t('map.driver')}</span></div>
      ${r ? html`<div class="route-chip"><b>${r.km.toFixed(1)} ${t('map.km')}</b> · ${t('map.about')} <b>${r.min} ${t('map.min')}</b></div>` : ''}
      <div class="row wrap map-btns"><a class="btn ghost sm" target="_blank" rel="noopener" href="${gmapsLink(a[0], a[1])}">${t('map.navPickup')}</a><a class="btn ghost sm" target="_blank" rel="noopener" href="${gmapsLink(b[0], b[1])}">${t('map.navDropoff')}</a></div>`);
    paint(null);
    drawRoute(map, a, b).then(paint); // المسار الفعلي على الطرق + المسافة والزمن
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
    truckTo(loc.lat, loc.lng);
    const tgt = ab && (['paid', 'heading_pickup'].includes(o.status) ? ab[0] : ab[1]), left = tgt ? distKm([loc.lat, loc.lng], tgt) : null; // المسافة المتبقية للوجهة الحالية (خط مستقيم تقريبي)
    hint.textContent = `${t('order.lastSeen')}: ${fmtDate(loc.at)}${left != null ? ` · ${t('map.driverLeft', { km: left.toFixed(1) })}` : ''}`;
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
  function manifestHtml(o) {
    if (isP(o)) return '';
    return html`<div class="manifest"><h4>${t('manifest.title')}</h4><p class="manifest-desc">${o.description || '—'}</p>
      <div class="muted small">${t('manifest.items')}: <b>${fmtNum(o.itemsCount || 1, 0)}</b> · ${t('manifest.value')}: <b>${fmtMoney(o.declaredValue || 0)}</b></div>${photos(o.photos || [])}
      <label class="row" style="gap:.5rem;margin-top:.6rem"><input type="checkbox" id="agree"> <span>${t('manifest.agree')}</span></label><p class="hint">${t('manifest.mismatchHint', { amount: fmtMoney(state.settings.mismatchCompensation || 0) })}</p></div>`;
  }
  function driverOpenHtml(o) {
    if (o.payMode === 'before') return html`<div class="action good"><p>${t('order.prepaidFixed', { price: fmtMoney(o.price) })}</p>${manifestHtml(o)}<button class="btn primary block" data-act="accept">${t('order.acceptPrepaid')}</button></div>`;
    const S = state.settings, canInstant = o.instant !== false, my = o.myOffer?.status === 'pending' ? o.myOffer : null;
    const lo = Math.max(Math.ceil(S.minPrice || 0), Math.ceil((o.price * (S.offerMinPct || 70)) / 100)), hi = Math.ceil((o.price * (S.offerMaxPct || 200)) / 100);
    return html`<div class="action"><p>${t('order.driverOpenMsg')}</p>${manifestHtml(o)}
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
          <div class="pay-box"><div class="muted small">${t('order.payAmount')}</div><b>${fmtMoney(dueOf(o))}</b>
            ${o.discount ? html`<div class="small"><s class="muted">${fmtMoney(o.price)}</s> · ${t('coupon.applied')} ${fmtMoney(o.discount)}</div>` : ''}
            <div class="small">${t('order.payTo')}: <b dir="ltr">${ip.handle}</b> — ${ip.name}</div></div>
          <label class="f" style="margin-top:.8rem">${t('order.proof')}<input type="file" id="proof" accept="image/*"></label>
          <label class="f" style="margin-top:.5rem">${t('order.payRef')}<input id="payref" maxlength="40"></label>
          <div class="row" style="margin-top:.8rem"><button class="btn primary grow" data-act="pay">${t('order.sendProof')}</button><button class="btn ghost sm" data-act="cancel">${t('order.cancel')}</button></div>
          ${state.settings.testPayments && state.settings.testPaymentsAllowed ? html`<div class="action warn" style="margin-top:.8rem"><p class="small">${t('order.testBanner')}</p><button class="btn ok block" data-act="payTest">${t('order.payTest')}</button></div>` : ''}</div>`;
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
          ${nx === 'delivered' && !isP(o) && (state.settings.deliveryCode || o.guard === 'high') && state.settings.deliveryCodeAvailable ? html`<label class="f">${t('code.driverAsk')}<input id="dcode" inputmode="numeric" autocomplete="off" maxlength="7" dir="ltr" placeholder="000 000"></label><label class="row" style="gap:.5rem"><input type="checkbox" id="nocode"> <span class="small">${t('code.noCode')}</span></label>` : ''}
          ${nx === 'picked_up' && !isP(o) && state.settings.startCode && state.settings.deliveryCodeAvailable ? html`<label class="f">${t('code.startAsk')}<input id="scode" inputmode="numeric" autocomplete="off" maxlength="7" dir="ltr" placeholder="000 000"></label><label class="row" style="gap:.5rem"><input type="checkbox" id="snocode"> <span class="small">${t('code.startNoCode')}</span></label>` : ''}
          ${needPhoto ? html`<label class="f">${isP(o) ? t('order.photoOptional') : t(nx === 'picked_up' ? 'order.photoPickup' : 'order.photoDelivery')}<input type="file" id="handover" accept="image/*" capture="environment"></label><p class="hint">${t('order.gpsRule')}</p>` : ''}
          <button class="btn primary block" data-act="next" data-next="${nx}" style="margin-top:.6rem">${t(isP(o) && NEXT_LABEL_P[nx] ? NEXT_LABEL_P[nx] : NEXT_LABEL[nx])}</button>
          <div class="row" style="margin-top:.6rem">${dispute}${['paid', 'heading_pickup'].includes(s) ? html`<button class="btn ghost sm" data-act="cancel">${t('order.driverWithdraw')}</button>` : ''}${['paid', 'heading_pickup'].includes(s) && !isP(o) && o.escrowStatus === 'held' ? html`<button class="btn ghost sm" data-act="mismatch">${t('mismatch.btn')}</button>` : ''}</div></div>`;
      }
      if (s === 'delivered') return html`<div class="action info"><p>${t('order.waitConfirm')}</p>${dispute}</div>`;
    }
    if (role === 'admin') {
      if (s === 'payment_review') return html`<div class="action"><h3>${t('admin.reviewPayment')}</h3><p>${t('order.payAmount')}: <b>${fmtMoney(dueOf(o))}</b>${o.discount ? html` <span class="muted small">(${t('coupon.applied')} ${fmtMoney(o.discount)})</span>` : ''} — ${t('order.payRef')}: <b>${o.paymentRef || '—'}</b></p>
        <div class="row"><button class="btn ok" data-act="admPay" data-a="confirm">${t('admin.confirmPay')}</button><button class="btn danger" data-act="admPay" data-a="reject">${t('admin.rejectPay')}</button></div></div>`;
      if (['open', 'accepted', 'awaiting_payment'].includes(s) && o.escrowStatus !== 'held') return html`<div class="action"><h3>${t('admin.overridePrice')}</h3><div class="row"><input type="number" id="newPrice" min="1" value="${o.price}" style="max-width:160px"><input id="priceNote" class="grow" placeholder="${t('admin.priceNote')}"><button class="btn primary" data-act="admPrice">${t('common.save')}</button></div></div>`;
      if (s === 'disputed') return html`<div class="action bad">${t('order.disputed')} — <a href="#/admin/disputes">${t('admin.tab.disputes')}</a></div>`;
    }
    if (s === 'disputed') return html`<div class="action bad"><p>${t('order.disputed')}</p></div>`;
    if (s === 'cancelled') return html`<div class="action bad"><p>${t('order.cancelledMsg')}${o.cancelReason ? ': ' + (o.cancelReason === 'no_driver' ? t('refund.reason.no_driver') : o.cancelReason === 'goods_mismatch' ? t('order.cancelReason.goods_mismatch') : o.cancelReason) : ''}</p>${o.cancelFee ? html`<p>${t('order.cancelFeeInfo', { driver: fmtMoney(o.driverNet), platform: fmtMoney(o.commission), refund: fmtMoney(o.customerRefund) })}</p>` : ''}${o.refund ? html`<p><b>${t('refund.title')}:</b> ${t('refund.' + o.refund.status, { amount: fmtMoney(o.refund.amount) })}</p>` : ''}</div>`;
    if (s === 'resolved') return html`<div class="action good"><p>${t('order.resolvedMsg')}: <b>${t('dispute.decision.' + o.resolution)}</b></p></div>`;
    if (s === 'completed') {
      const my = role === 'customer' ? o.rateByCustomer : role === 'driver' ? o.rateByDriver : null;
      return html`<div class="action good"><h3>${t('order.done')}</h3>
        ${role === 'driver' ? html`<p>${t('order.youEarned')}: <b>${fmtMoney(o.driverNet)}</b> <span class="muted small">(${t('order.commission')}: ${fmtMoney(o.commission)})</span></p>` : ''}
        ${role === 'admin' ? html`<p>${t('order.commission')}: <b>${fmtMoney(o.commission)}</b> — ${t('order.driverNet')}: ${fmtMoney(o.driverNet)}</p>` : ''}
        ${role !== 'admin' && !my ? html`<div class="stack"><div>${t('order.rate')}</div><div id="stars" class="stars"></div>${role === 'customer' ? html`<div class="quick-q" id="quickq">${['onTime', 'intact', 'polite'].map((k) => html`<div class="qrow"><span>${t('rate.q.' + k)}</span><span class="yn" role="radiogroup" aria-label="${t('rate.q.' + k)}"><label><input type="radio" name="q_${k}" value="1" checked> ${t('common.yes')}</label><label><input type="radio" name="q_${k}" value="0"> ${t('common.no')}</label></span></div>`)}</div>` : ''}<textarea id="rcomment" maxlength="300" placeholder="${t('order.rateHint')}"></textarea><button class="btn primary" data-act="rate">${t('order.sendRating')}</button></div>`
          : my ? html`<p>${t('order.yourRating')}: ${'★'.repeat(my.stars)}</p>` : ''}
        ${role === 'customer' ? html`<button class="btn ghost sm" data-act="share">${t('order.share')}</button>` : ''}</div>`;
    }
    return '';
  }

  function handlerHtml(o) { // الشركة بتحدد السواق التابع ليها اللي هيستلم الشحنة (قبل الاستلام)
    if (!(role === 'driver' && o.driverId === uid && state.profile.accountType === 'company' && ['accepted', 'payment_review', 'paid', 'heading_pickup'].includes(o.status))) return '';
    const h = o.handler;
    return html`<div class="action"><h3>${t('fleet.handlerTitle')}</h3>
      ${h ? html`<p>${t('fleet.currentHandler')}: <b>${h.name}</b> — <span dir="ltr">${h.plate}</span></p>` : html`<p class="err">${t('fleet.handlerRequired')}</p>`}
      ${fleet.length ? html`<div class="row"><select id="handlerSel" class="grow">${fleet.map((d) => html`<option value="${d.id}" ${h && h.fleetDriverId === d.id ? 'selected' : ''}>${d.name} — ${d.plate}</option>`)}</select><button class="btn primary" data-act="setHandler">${t('fleet.assign')}</button></div>` : html`<p class="hint"><a href="#/driver/fleet">${t('fleet.addFirst')}</a></p>`}</div>`;
  }
  function detailsHtml(o) {
    const showDriver = o.driverId && (role !== 'driver');
    const showCustomer = role === 'admin' || (role === 'driver' && o.driverId === uid);
    const showCustPhone = role === 'admin' || (role === 'driver' && HELD.concat(['completed', 'disputed']).includes(o.status));
    return html`<div class="card"><dl class="kv">
      ${kv(t('order.pickup'), o.pickup.address || '—')}${kv(t('order.dropoff'), o.dropoff.address || '—')}
      ${isP(o) ? html`${kv(t('order.service'), t('service.passengers'))}${kv(t('order.vehicleClass'), label(state.settings.passengerClasses?.[o.vehicleClass], o.vehicleClass))}${kv(t('order.passengers'), o.passengers)}` : html`${kv(t('order.category'), label(state.settings.categories?.[o.category], o.category))}${kv(t('order.size'), label(state.settings.sizes?.[o.size], o.size))}
      ${kv(t('order.weight'), `${fmtNum(o.weightKg, 0)} ${t('common.kg')}`)}${o.vehiclePick ? kv(t('order.vehiclePick'), vehicleName(o.vehiclePick)) : ''}${typeof o.companion === 'boolean' ? kv(t('order.companion'), html`<b>${t(o.companion ? 'companion.yes' : 'companion.no')}</b>`) : ''}`}${kv(t('order.distance'), `${fmtNum(o.distanceKm)} ${t('common.km')}${o.distanceSource === 'estimate' ? ' ~' : ''}`)}
      ${kv(t('order.when'), fmtDate(o.scheduledAt))}
      ${o.payMode === 'before' ? kv(t('order.payMode'), t('order.prepaid')) : ''}${kv(t('order.price'), html`<b>${fmtMoney(o.price)}</b>${o.priceOverridden ? html` <span class="muted small">(${t('order.priceAdjusted')}${o.priceNote ? ': ' + o.priceNote : ''})</span>` : ''}${o.priceNegotiated ? html` <span class="muted small">(${t('order.priceNegotiated')})</span>` : ''}`)}
      ${o.discount ? html`${kv(t('coupon.discount'), html`<span style="color:var(--nile)">− ${fmtMoney(o.discount)}</span>${o.couponCode ? html` <span class="muted small">(${o.couponCode})</span>` : ''}`)}${kv(t('coupon.due'), html`<b>${fmtMoney(dueOf(o))}</b>`)}` : ''}
      ${o.description ? kv(t('order.notes'), o.description) : ''}
      ${showDriver ? kv(t('order.driver'), html`${o.driverName} — ${tel(o.driverPhone)} <span class="muted small">(${t('vehicle.' + o.driverVehicle) === 'vehicle.' + o.driverVehicle ? o.driverVehicle : t('vehicle.' + o.driverVehicle)})</span>${o.driverTrust ? html`<div style="margin-top:.2rem">${trustBadge(o.driverTrust)}</div>` : ''}`) : ''}
      ${showDriver && role === 'customer' && (o.handler?.vehiclePhotoRef || o.driverVehiclePhoto) ? kv(t('order.vehiclePhoto'), photos([o.handler?.vehiclePhotoRef || o.driverVehiclePhoto])) : ''}
      ${o.paymentMethod === 'test' ? kv(t('order.payMethod'), t('order.testPay')) : ''}
      ${o.handler ? kv(t('fleet.handler'), html`${o.handler.name} — ${tel(o.handler.phone)} <span class="muted small" dir="ltr">(${o.handler.plate})</span>${o.handler.companyName && role !== 'customer' ? html` <span class="muted small">· ${o.handler.companyName}</span>` : ''}`) : ''}
      ${showCustomer ? kv(t('order.customer'), html`${o.customerName}${showCustPhone ? html` — ${tel(o.customerPhone)}` : ''}`) : ''}
    </dl></div>
    ${o.handler && role === 'admin' ? html`<div class="card stack"><h3>${t('fleet.handlerDocs')}</h3><dl class="kv"><dt>${t('fleet.name')}</dt><dd>${o.handler.name}</dd><dt>${t('auth.nationalId')}</dt><dd dir="ltr">${o.handler.nationalId}</dd><dt>${t('auth.phone')}</dt><dd dir="ltr">${o.handler.phone}</dd><dt>${t('fleet.plate')}</dt><dd dir="ltr">${o.handler.plate}</dd></dl>${photos([o.handler.idRef, o.handler.licenseRef, o.handler.vehiclePhotoRef].filter(Boolean))}
      ${(o.handlerHistory || []).length > 1 ? html`<div class="muted small">${t('fleet.handlerHistory')}</div><ul class="log">${o.handlerHistory.map((x) => html`<li><span>${x.name} — ${x.plate}</span><span class="muted">${fmtDate(x.at)}</span></li>`)}</ul>` : ''}</div>` : ''}
    <div class="card stack"><h3>${t('order.photos')}</h3>
      ${o.photos?.length ? html`<div><div class="muted small">${t('order.cargoPhotos')}</div>${photos(o.photos)}</div>` : ''}
      ${o.pickupPhoto ? html`<div><div class="muted small">${t('order.pickupPhoto')}</div>${photos([o.pickupPhoto])}</div>` : ''}
      ${o.deliveryPhoto ? html`<div><div class="muted small">${t('order.deliveryPhoto')}</div>${photos([o.deliveryPhoto])}</div>` : ''}
      ${o.paymentProof && role !== 'driver' ? html`<div><div class="muted small">${t('order.proof')}</div>${photos([o.paymentProof])}</div>` : ''}</div>
    <details class="card"><summary><b>${t('order.log')}</b></summary><ul class="log" style="margin-top:.6rem">${(o.log || []).map((l) => html`<li><span>${t('status.' + l.status)}${l.note ? ' — ' + l.note : ''}${l.lat && role !== 'driver' ? html` <a href="https://www.openstreetmap.org/?mlat=${l.lat}&mlon=${l.lng}#map=17/${l.lat}/${l.lng}" target="_blank" rel="noopener">📍</a>` : ''}</span><span class="muted">${fmtDate(l.at)}</span></li>`)}</ul></details>`;
  }

  // حراسة القيمة: الشحنة العالية (لو الأدمن فعّلها) كود تسليمها إجباري ومفيش تحرير تلقائي — ظاهرة للسواق قبل ما يقبل
  const guardHtml = (o) => o.guard === 'high' ? html`<div class="action"><p><b>${t('guard.title')}</b> — ${t('guard.body')}</p></div>` : '';
  // ---------- مواعيد الاستلام/التسليم ونقاط التأخير (تتبّع اختياري: العميل هو اللي بيحدد مدة التأخير المسموح) ----------
  const TIMES_ST = ['accepted', 'payment_review', 'paid', 'heading_pickup', 'picked_up', 'in_transit'];
  const localIn = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  function timesHtml(o) {
    if (o.graceMin == null || !o.driverId) return '';
    const mine = role === 'driver' && o.driverId === uid, cust = role === 'customer' && o.customerId === uid;
    const pu = o.agreed?.pickupAt ?? o.scheduledAt, de = o.agreed?.deliveryAt ?? o.deliveryAt, p = o.timeProposal;
    const markHtml = (kind) => {
      const m = o.lateMarks?.[kind]; if (!m) return '';
      if (m.state === 'asked') return cust
        ? html`<div class="action bad"><p>${t('late.ask.' + kind)}</p><div class="row"><button class="btn danger sm" type="button" data-act="lateDecide" data-kind="${kind}" data-point="1">${t('late.recordPoint')}</button><button class="btn ghost sm" type="button" data-act="lateDecide" data-kind="${kind}" data-point="0">${t('late.forgive')}</button></div><p class="hint">${t('late.askHint')}</p></div>`
        : html`<div class="action"><p>${t('late.waiting.' + kind)}</p></div>`;
      return html`<p class="muted small" style="margin:.2rem 0">${t('late.' + kind)}: ${t(m.state === 'point' ? 'late.pointed' : 'late.forgiven')}</p>`;
    };
    const proposed = (x) => html`${x.pickupAt != null ? html`<div>${t('late.pickupAt')}: <b>${fmtDate(x.pickupAt)}</b></div>` : ''}${x.deliveryAt != null ? html`<div>${t('late.deliveryAtShort')}: <b>${fmtDate(x.deliveryAt)}</b></div>` : ''}`;
    const canPropose = mine && TIMES_ST.includes(o.status) && (o.proposalCount || 0) < 5;
    const beforePickup = !['picked_up', 'in_transit'].includes(o.status);
    return html`<div class="card stack"><h3>${t('late.title')}</h3>
      <dl class="kv">${kv(t('late.pickupAt'), html`${fmtDate(pu)}${o.agreed?.pickupAt != null ? html` <span class="muted small">(${t('late.agreed')})</span>` : ''}`)}${de ? kv(t('late.deliveryAtShort'), html`${fmtDate(de)}${o.agreed?.deliveryAt != null ? html` <span class="muted small">(${t('late.agreed')})</span>` : ''}`) : ''}${kv(t('late.graceShort'), `${fmtNum(o.graceMin, 0)} ${t('late.min')}`)}</dl>
      ${markHtml('pickup')}${markHtml('delivery')}
      ${p ? (cust
        ? html`<div class="action"><h3>${t('late.proposalTitle')}</h3>${proposed(p)}<div class="row" style="margin-top:.5rem"><button class="btn ok sm" type="button" data-act="answerTimes" data-accept="1">${t('late.accept')}</button><button class="btn ghost sm" type="button" data-act="answerTimes" data-accept="0">${t('late.decline')}</button></div></div>`
        : html`<div class="action"><p>${t(mine ? 'late.proposalWaiting' : 'late.proposalPending')}</p>${proposed(p)}</div>`) : ''}
      ${canPropose ? html`<div class="stack"><b>${t('late.proposeTitle')}</b>
        <div class="grid-2">${beforePickup ? html`<label class="f">${t('late.pickupAt')}<input type="datetime-local" id="propPickup" value="${localIn(pu)}"></label>` : ''}<label class="f">${t('late.deliveryAtShort')}<input type="datetime-local" id="propDelivery" value="${de ? localIn(de) : ''}"></label></div>
        <button class="btn primary sm" type="button" data-act="proposeTimes">${t('late.send')}</button><p class="hint">${t('late.proposeHint')}</p></div>` : ''}</div>`;
  }
  // ---------- كود التسليم (العميل بيدّيه للمستلم والسواق بيدخله عند التسليم) ----------
  const CODE_ST = ['accepted', 'paid', 'heading_pickup', 'picked_up', 'in_transit'];
  function ensureCode(o) { // بيتجاب مرة واحدة لما العميل يفتح طلب نشط (الكود مش بيتخزّن ولا بيجي مع بيانات الطلب)
    if (role !== 'customer' || o.customerId !== uid || codeInfo !== undefined || !CODE_ST.includes(o.status) || !state.settings.deliveryCodeAvailable || !(state.settings.deliveryCode || state.settings.startCode || o.guard === 'high')) return;
    codeInfo = null; api('orders/code', { orderId: o.id }).then((r) => { codeInfo = r; if (order) paint(order); }).catch(() => { codeInfo = { active: false }; });
  }
  function codeHtml(o) {
    if (role !== 'customer' || !codeInfo) return '';
    const card = (k, code) => html`<div class="card code-card" aria-label="${t('code.' + k + '.title')}"><div class="grow"><b>${t('code.' + k + '.title')}</b><p class="muted small" style="margin:.2rem 0 0">${t('code.' + k + '.hint')}</p></div><div class="code-digits num" dir="ltr">${code.slice(0, 3)} ${code.slice(3)}</div></div>`;
    return html`${codeInfo.startCode && ['accepted', 'paid', 'heading_pickup'].includes(o.status) ? card('start', codeInfo.startCode) : ''}${codeInfo.active && CODE_ST.includes(o.status) ? card('delivery', codeInfo.code) : ''}`;
  }
  // ---------- عدّاد الرحلة (عند العميل والسواق): من لحظة الاستلام لحد المهلة المتوقعة ----------
  function tripHtml(o) {
    if (!o.startedAt || !['picked_up', 'in_transit'].includes(o.status) || role === 'admin') return '';
    return html`<div class="card trip ${o.late ? 'late' : ''}"><div class="row"><b class="grow">${t('trip.title')}</b>${o.startVerified === 'code' ? html`<span class="stamp s-active">${t('trip.startedWithCode')}</span>` : o.startVerified === 'none' ? html`<span class="stamp s-open">${t('trip.startedNoCode')}</span>` : ''}</div>
      <div class="trip-clock num" id="tripClock" data-start="${o.startedAt}" data-deadline="${o.deadlineAt || 0}" aria-live="off">—</div>
      <p class="muted small" style="margin:0">${t('trip.deadline')}: ${o.deadlineAt ? fmtDate(o.deadlineAt) : '—'}</p>${o.late ? html`<p class="late-msg">${t('trip.late')}</p>` : ''}</div>`;
  }
  const fmtClock = (ms) => { const s = Math.floor(Math.abs(ms) / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`; };
  function startClock() {
    clearInterval(tripTimer); const el = left.querySelector('#tripClock'); if (!el) return;
    const tick = () => { const st = +el.dataset.start, dl = +el.dataset.deadline, n = Date.now(); el.textContent = fmtClock(n - st) + (dl ? (n > dl ? ' · ' + t('trip.over') + ' ' + fmtClock(n - dl) : ' · ' + t('trip.left') + ' ' + fmtClock(dl - n)) : ''); };
    tick(); tripTimer = setInterval(tick, 1000);
  }
  // ---------- رابط متابعة للمستلم ----------
  function shareHtml(o) {
    if (role !== 'customer' || o.customerId !== uid || !['accepted', 'paid', 'heading_pickup', 'picked_up', 'in_transit', 'delivered'].includes(o.status)) return '';
    return html`<div class="card stack"><div><b>${t('track.title')}</b><p class="muted small" style="margin:.2rem 0 0">${t('track.hint')}</p></div>
      <div class="row"><button class="btn ghost sm" type="button" data-act="shareTrack">${t('track.share')}</button><button class="btn ghost sm" type="button" data-act="unshareTrack">${t('track.stop')}</button></div></div>`;
  }
  // ---------- «فين فلوسي؟»: 3 مراحل واضحة للعميل (دفع ← حجز ← تحويل/استرجاع) ----------
  function moneyHtml(o) {
    if (role !== 'customer') return '';
    const steps = moneySteps(o); if (!steps) return '';
    const paidAt = (o.log || []).find((l) => l.status === 'paid')?.at;
    return html`<div class="card money" aria-label="${t('money.title')}"><div class="row"><h3 class="grow" style="margin:0">${t('money.title')}</h3><b class="num">${fmtMoney(dueOf(o))}</b></div>
      <ol class="money-steps">${steps.map((s) => html`<li class="${s.state}"><span class="mk" aria-hidden="true"></span><div><b>${t('money.' + s.key)}</b><div class="muted small">${t(s.text)}${s.key === 'paid' && paidAt && s.state === 'done' ? html` · ${fmtDate(paidAt)}` : ''}</div></div></li>`)}</ol></div>`;
  }
  // ---------- اطلب نفس الشحنة تاني (بعد ما الطلب يخلص أو يتلغي) ----------
  function reorderHtml(o) {
    if (role !== 'customer' || !['completed', 'cancelled', 'resolved'].includes(o.status)) return '';
    return html`<div class="row" style="margin-top:1rem"><button class="btn primary" type="button" data-act="reorder">${t('order.reorder')}</button></div>`;
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
    role = state.profile.role === 'admin' && o.customerId === uid ? 'customer' : state.profile.role; // الأدمن على طلب هو عمله بيتعامل كعميل
    render($('#title', el), html`${t('order.title')} ${orderNo(o.id)} ${stamp(o.status, o.service)}`);
    render($('#rlink', el), RECEIPT_STATUS.includes(o.status) ? html`<a class="btn ghost sm" href="#/receipt/${o.id}">${t('receipt.open')}</a>` : '');
    render(left, html`${stepsHtml(o)}<div id="actions">${actionsHtml(o)}${handlerHtml(o)}</div>${codeHtml(o)}${tripHtml(o)}${guardHtml(o)}${timesHtml(o)}${o.late ? html`<div class="action bad"><p>${t('trip.late')}</p></div>` : ''}${role === 'admin' ? html`<div class="row"><button class="btn ghost sm" type="button" data-act="evidence">${t('evidence.btn')}</button></div>` : ''}${moneyHtml(o)}${shareHtml(o)}${reorderHtml(o)}${safetyHtml(o)}${detailsHtml(o)}`);
    hydrate(left); ensureCode(o); startClock();
    const st = $('#stars', left); if (st) getStars = starsInput(st);
    drawMap(o); syncTracking(o); syncChat(o);
  }

  // ---------- الإجراءات ----------
  const call = async (route, body, okMsg) => { const r = await api(route, { orderId: id, ...body }); if (okMsg) toast(t(okMsg)); await poller?.now(); return r; };
  const requireFile = (inputId) => { const f = $('#' + inputId, left)?.files?.[0]; if (!f) throw Object.assign(new Error('bad_file'), { code: 'bad_file' }); return f; };
  const actions = {
    accept: () => { if (!isP(order) && !$('#agree', left)?.checked) { toast(t('err.must_agree'), true); return; } return call('orders/accept', { agree: true }, 'order.acceptedToast'); },
    offer: () => { if (!isP(order) && !$('#agree', left)?.checked) { toast(t('err.must_agree'), true); return; } return call('offers/create', { agree: true, price: $('#offerPrice', left).value, note: $('#offerNote', left).value }, 'offer.sent'); },
    async mismatch() { // الشحنة مش زي الوصف: السواق يرفض الاستلام ويخد التعويض والباقي يترد للعميل
      const reason = await promptDialog(t('mismatch.ask', { amount: fmtMoney(state.settings.mismatchCompensation || 0) }), { area: true, required: true });
      if (!reason || reason.trim().length < 5) return;
      const body = { reason: reason.trim() }; try { body.loc = await getPos(); } catch { /* السيرفر بيطلبه لو التحقق بالموقع مفعّل */ }
      await call('orders/mismatch', body, 'mismatch.done');
    },
    async proposeTimes() { // السواق يقترح تعديل المواعيد (العميل هو اللي يوافق)
      const pk = $('#propPickup', left)?.value, dl = $('#propDelivery', left)?.value;
      if (!pk && !dl) { toast(t('late.proposeEmpty'), true); return; }
      await call('orders/propose_times', { ...(pk ? { pickupAt: new Date(pk).toISOString() } : {}), ...(dl ? { deliveryAt: new Date(dl).toISOString() } : {}) }, 'late.proposedToast');
    },
    answerTimes: (b) => call('orders/answer_times', { accept: b.dataset.accept === '1' }, b.dataset.accept === '1' ? 'late.agreedToast' : 'late.declinedToast'),
    async lateDecide(b) { // العميل بعد تأخير السواق: نقطة تأخير أو مسامحة
      const point = b.dataset.point === '1';
      if (point && !(await confirmDialog(t('late.confirmPoint'), { ok: t('late.recordPoint') }))) return;
      await call('orders/late_decision', { kind: b.dataset.kind, point }, point ? 'late.pointToast' : 'late.forgiveToast');
    },
    async evidence() { // ملف أدلة للأدمن: تحميل JSON + نسخة قابلة للطباعة
      const r = await api('admin/evidence', { orderId: id }), e = r.evidence;
      const url = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `evidence-${orderNo(id)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
      const p = (u) => u ? `${u.name} · ${u.phone} · ${u.nationalId || '—'}` : '—', tr = e.trail || [];
      printNode(t('evidence.title') + ' ' + orderNo(id), html`<h2>${t('evidence.title')} ${orderNo(id)}</h2>
        <p><b>${t('evidence.customer')}:</b> ${p(e.customer)}</p><p><b>${t('evidence.driver')}:</b> ${p(e.driver)}${e.handler ? ' — ' + p(e.handler) : ''}</p>
        <h3>${t('manifest.title')}</h3><p>${e.agreement.description}</p><p>${t('manifest.items')}: ${e.agreement.itemsCount} · ${t('manifest.value')}: ${fmtMoney(e.agreement.declaredValue)} · ${t('evidence.agreedAt')}: ${e.agreement.driverAgreedAt ? fmtDate(e.agreement.driverAgreedAt) : '—'}</p>
        <p>${t('evidence.codes')}: ${e.codes.startVerified || '—'} / ${e.codes.deliveryVerified || '—'}${e.codes.deliveredWithoutCode ? ' (' + t('evidence.noCode') + ')' : ''}</p>
        <h3>${t('evidence.timeline')}</h3><ul>${(e.order.log || []).map((l) => html`<li>${fmtDate(l.at)} — ${l.status} — ${l.by || ''} ${l.note || ''}</li>`)}</ul>
        <h3>${t('evidence.gps')}</h3><p>${tr.length} ${t('evidence.points')}${tr.length ? html` — <a href="https://www.google.com/maps?q=${tr[tr.length - 1].lat},${tr[tr.length - 1].lng}">${t('evidence.lastPoint')}</a>` : ''}</p>
        <h3>${t('evidence.disputes')}</h3><ul>${(e.disputes || []).map((d) => html`<li>${d.reason} — ${d.details || ''}</li>`)}</ul>
        <p style="word-break:break-all"><small>SHA-256: ${r.integrity}</small></p>`);
      toast(t('evidence.done'));
    },
    offerWithdraw: () => call('offers/withdraw', {}, 'offer.withdrawn'),
    async offerAccept(b) { if (await confirmDialog(t('offer.accept') + '؟', { ok: t('offer.accept') })) await call('offers/accept', { offerId: b.dataset.id }, 'offer.acceptedToast'); },
    offerReject: (b) => call('offers/reject', { offerId: b.dataset.id }, 'common.done'),
    setHandler: () => call('orders/handler', { fleetDriverId: $('#handlerSel', left).value }, 'common.done'),
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
        const paid = dueOf(order); // الرسوم بتتحسب على المبلغ المدفوع فعلاً (بعد الكوبون)
        const d = Math.round((paid * dp) / 100), pl = Math.min(paid - d, Math.round((paid * pp) / 100));
        if (!(await confirmDialog(t('order.cancelFeeAsk', { driver: fmtMoney(d), platform: fmtMoney(pl), refund: fmtMoney(paid - d - pl) }), { danger: true, ok: t('order.cancelFee') }))) return;
        await call('orders/cancel', {}, 'order.cancelFeeToast'); return;
      }
      if (role === 'customer' && order.escrowStatus === 'held') { // مدفوع مقدماً => استرجاع
        if (!(await confirmDialog(t('order.cancelRefundAsk', { amount: fmtMoney(dueOf(order)) }), { danger: true, ok: t('order.cancelRefund') }))) return;
        await call('orders/cancel', {}, 'order.cancelRefundToast'); return;
      }
      const reason = await promptDialog(t('order.cancelAsk'));
      if (reason === null) return;
      await call('orders/cancel', { reason }, 'order.cancelledToast');
      if (role === 'driver') location.hash = '#/driver/jobs';
    },
    async payTest() { await call('orders/pay-test', {}, 'order.payTestDone'); },
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
        if (nx === 'delivered' && $('#dcode', left)) { if ($('#nocode', left).checked) { body.noCode = true; body.noCodeReason = 'customer_unreachable'; } else body.code = $('#dcode', left).value; }
        if (nx === 'picked_up' && $('#scode', left)) { if ($('#snocode', left).checked) { body.noCode = true; body.noCodeReason = 'customer_unreachable'; } else body.code = $('#scode', left).value; }
      } else { try { body.loc = await getPos(); } catch { /* اختياري */ } }
      await call('orders/status', body, 'order.updated');
    },
    async confirm() { if (await confirmDialog(t(isP(order) ? 'order.confirmAskP' : 'order.confirmAsk'), { ok: t(isP(order) ? 'order.confirmReceiptP' : 'order.confirmReceipt') })) await call('orders/confirm', {}, 'order.confirmed'); },
    async rate() { const stars = getStars(); if (!stars) throw Object.assign(new Error('bad_input'), { code: 'bad_input' }); const q = {}; if (role === 'customer') for (const k of ['onTime', 'intact', 'polite']) q[k] = left.querySelector(`input[name="q_${k}"]:checked`)?.value === '1';
      await call('orders/rate', { stars, comment: $('#rcomment', left).value, ...q }, 'order.thanks'); },
    async share() {
      const data = { title: t('brand'), text: t('order.shareText'), url: location.origin };
      if (navigator.share) await navigator.share(data).catch(() => {}); else { await navigator.clipboard?.writeText(`${data.text} ${data.url}`); toast(t('order.copied')); }
    },
    async shareTrack() {
      const r = await api('orders/share', { orderId: id }); const url = `${location.origin}/#/track/${r.token}`;
      if (navigator.share) await navigator.share({ title: t('brand'), text: t('track.shareText'), url }).catch(() => {});
      else { await navigator.clipboard?.writeText(url); toast(t('track.copied')); }
    },
    async unshareTrack() { await api('orders/unshare', { orderId: id }); toast(t('track.stopped')); },
    dispute: () => openDispute(),
    reorder() { state.reorder = order; location.hash = '#/customer/new'; },
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
      <div class="stack"><label class="f">${t('dispute.reason')}<select id="dr">${(role === 'customer' && ['picked_up', 'in_transit', 'delivered'].includes(order.status) ? [...REASONS, 'missing'] : REASONS).map((r) => html`<option value="${r}">${t('dispute.reason.' + r)}</option>`)}</select></label>
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

  return () => { poller(); clearInterval(tripTimer); chatCtl?.stop(); if (watchId !== null) navigator.geolocation.clearWatch(watchId); map?.remove(); };
}
