import { api, poll } from '../api.js';
import { gpoll } from '../sync.js';
import { state } from '../state.js';
import { t } from '../i18n.js';
import { $, $$, html, raw, render, toast, errMsg, busy, spinner, skeleton, waybill, orderNo, fmtMoney, fmtNum, label } from '../ui.js';
import { createMap, pinIcon, geocode, reverse } from '../map.js';
import { uploadImage } from '../storage.js';
import { recommendVehicle, VEHICLE_KEYS } from '../estimate.js';
import { vehicleSvg } from '../vehicles.js';

export function renderCustomerHome(el) {
  render(el, html`<div class="page-head"><h1>${t('nav.myOrders')}</h1><a class="btn primary" href="#/customer/new">${t('nav.newOrder')}</a></div><div id="list" class="stack">${skeleton(3)}</div>`);
  const list = $('#list', el), prev = new Map(); let first = true;
  return gpoll(['orders'], () => api('orders/list', state.profile.role === 'admin' ? { scope: 'mine' } : {}), 15000, ({ orders }) => {
    for (const o of orders) { const p = prev.get(o.id); if (!first && p && p !== o.status) toast(`${orderNo(o.id)} — ${t('status.' + o.status)}`); prev.set(o.id, o.status); }
    first = false;
    render(list, orders.length ? html`${orders.map((o) => waybill(o))}` : html`<div class="empty"><p>${t('customer.empty')}</p><a class="btn primary" href="#/customer/new">${t('nav.newOrder')}</a></div>`);
  }, { dedupe: true, onError: (e) => toast(errMsg(e), true) });
}

const localInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export function renderNewOrder(el) {
  const S = state.settings, cats = Object.entries(S.categories || {}), sizes = Object.entries(S.sizes || {}), classes = Object.entries(S.passengerClasses || {});
  if (!cats.length || !sizes.length) { render(el, html`<div class="empty">${t('err.settings')}</div>`); return () => {}; }
  const vkeys = S.vehicleGuideOn === false ? [] : VEHICLE_KEYS.filter((k) => S.vehicleGuide?.[k]?.maxKg > 0 && S.sizes?.[S.vehicleGuide[k].size]); // عربيات مفعّلة وحجمها موجود
  let vpick = null;
  const pts = {}; let mode = 'pickup', service = 'cargo', quote = null, qTimer = null, qSeq = 0;
  const saved = Array.isArray(state.profile?.addresses) ? state.profile.addresses : [];

  render(el, html`<div class="page-head"><h1>${t('nav.newOrder')}</h1></div>
  <div class="order-layout">
    <form id="f" class="card stack" novalidate>
      ${S.passengersEnabled && classes.length ? html`<div><div class="seg" role="group" aria-label="${t('new.serviceLabel')}"><button type="button" data-svc="cargo" class="on">${t('service.cargo')}</button><button type="button" data-svc="passengers">${t('service.passengers')}</button></div></div>` : ''}
      <div><div class="seg" role="group" aria-label="${t('new.pickMode')}"><button type="button" data-mode="pickup" class="on">${t('order.pickup')}</button><button type="button" data-mode="dropoff">${t('order.dropoff')}</button></div>
        <p class="hint">${t('new.mapHint')}</p></div>
      <div><div class="row"><input id="q" class="grow" placeholder="${t('new.search')}" aria-label="${t('new.search')}"><button type="button" class="btn ghost" id="qbtn">${t('common.search')}</button></div><div id="results"></div></div>
      ${saved.length ? html`<div class="grid-2">
        <label class="f">${t('account.pickSaved')}<select id="sA"><option value="">—</option>${saved.map((x, i) => html`<option value="${i}">${x.label}</option>`)}</select></label>
        <label class="f">${t('account.dropSaved')}<select id="sB"><option value="">—</option>${saved.map((x, i) => html`<option value="${i}">${x.label}</option>`)}</select></label>
      </div>` : ''}
      <label class="f">${t('order.pickup')}<input name="pAddr" placeholder="${t('new.addr')}"></label>
      <label class="f">${t('order.dropoff')}<input name="dAddr" placeholder="${t('new.addr')}"></label>
      ${S.passengersEnabled && classes.length ? html`<div class="grid-2" data-only="passengers" hidden><label class="f">${t('new.vehicleClass')}<select name="vehicleClass">${classes.map(([k, c]) => html`<option value="${k}">${label(c, k)}</option>`)}</select></label><label class="f">${t('new.passengers')}<input type="number" name="passengers" min="1" max="${classes[0][1].seats}" value="2" inputmode="numeric"></label></div><p class="hint" data-only="passengers" hidden>${t('new.paxNote')} ${t('new.prepayPax')}</p>` : ''}
      <div class="grid-2" data-only="cargo">
        <label class="f">${t('order.category')}<select name="category">${cats.map(([k, c]) => html`<option value="${k}">${label(c, k)}</option>`)}</select></label>
        <label class="f">${t('order.size')}<select name="size">${sizes.map(([k, c]) => html`<option value="${k}">${label(c, k)}</option>`)}</select></label>
      </div>
      <div class="grid-2">
        <label class="f" data-only="cargo">${t('order.weight')} (${t('common.kg')})<input type="number" name="weightKg" min="1" max="50000" inputmode="numeric" required></label>
        <label class="f">${t('order.when')}<input type="datetime-local" name="scheduledAt" value="${localInput(new Date(Date.now() + 3600e3))}" required></label>
      </div>
      ${vkeys.length ? html`<div class="stack" data-only="cargo" style="gap:.3rem"><b>${t('vpick.title')}</b><div id="vpick" class="vpick" role="group" aria-label="${t('vpick.title')}"></div><p class="hint">${t('vpick.hint')}</p></div>` : ''}
      ${S.codEnabled === true ? html`<div class="stack" data-only="cargo" style="gap:.3rem"><label class="f">${t('cod.formLabel')}<input name="codAmount" type="number" min="1" max="${S.codMaxAmount}" step="1" inputmode="numeric" placeholder="${t('cod.formPlaceholder', { max: fmtNum(S.codMaxAmount, 0) })}"></label><p class="hint">${t('cod.formHint')}</p></div>` : ''}
      ${S.companionAsk !== false ? html`<label class="row" data-only="cargo"><input type="checkbox" name="companion"> <span>${t('companion.ask')}</span></label><p class="hint" data-only="cargo" style="margin-top:-.4rem">${t('companion.hint')}</p>` : ''}
      <div class="stack" style="gap:.3rem"><div class="grid-2">
        <label class="f">${t('late.deliveryAt')}<input type="datetime-local" name="deliveryAt"></label>
        <label class="f">${t('late.grace')}<input type="number" name="graceMin" min="0" max="10080" inputmode="numeric" placeholder="30"></label>
      </div><p class="hint">${t('late.formHint')}</p></div>
      ${S.dcEnabled ? html`<p class="hint">${t('new.directNote')}</p>` : html`<label class="row" data-only="cargo"><input type="checkbox" name="prepay"> <span>${t('new.prepay')}</span></label>`}
      ${S.offersEnabled === false ? '' : html`<label class="row" data-only="cargo"><input type="checkbox" name="offersOnly"> <span>${t('new.offersOnly')}</span></label><p class="hint" data-only="cargo" style="margin-top:-.4rem">${t('new.offersHint')}</p>`}
      <div data-only="cargo" class="stack manifest-in"><label class="f">${t('manifest.desc')}<textarea name="description" maxlength="1000" placeholder="${t('manifest.descHint')}"></textarea></label>
        <div class="grid-2"><label class="f">${t('manifest.items')}<input type="number" name="itemsCount" min="1" max="10000" value="1" inputmode="numeric"></label>
        <label class="f">${t('manifest.value')} (${t('common.egp')})<input type="number" name="declaredValue" min="0" inputmode="numeric" placeholder="0"></label></div>
        <p class="hint" id="guardHint" hidden></p>
        <p class="hint">${t('manifest.bindingHint')}</p></div>
      <label class="f" data-only="passengers">${t('order.notes')}<textarea name="descriptionTrip" maxlength="500" placeholder="${t('new.notesHint')}"></textarea></label>
      <label class="f" data-only="cargo">${t('new.photos')}<input type="file" name="photos" accept="image/*" multiple><span class="hint">${t('new.photosHint')}</span></label>
      <div id="previews" class="photos" data-only="cargo"></div>
      <label class="f" ${S.dcEnabled ? 'hidden' : ''}>${t('coupon.label')}<input name="coupon" maxlength="20" placeholder="${t('coupon.placeholder')}" autocomplete="off" style="text-transform:uppercase"></label>
      <div id="quote" class="action" aria-live="polite">${t('new.needPoints')}</div>
      <p class="err" id="err" role="alert"></p>
      <button class="btn primary block" type="submit" id="submit">${t('new.submit')}</button>
      <p class="hint" id="progress"></p>
    </form>
    <div class="map-col"><div id="map" class="map tall"></div></div>
  </div>`);

  const f = $('#f', el), quoteBox = $('#quote', el), err = $('#err', el);
  const map = createMap($('#map', el));
  const markers = {}, addrInput = { pickup: f.pAddr, dropoff: f.dAddr };
  const setMode = (m) => { mode = m; el.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m)); };

  function setPoint(kind, lat, lng, address) {
    pts[kind] = { lat, lng, address: address ?? pts[kind]?.address ?? '' };
    if (address !== undefined) addrInput[kind].value = address;
    if (!markers[kind]) {
      markers[kind] = L.marker([lat, lng], { icon: pinIcon(kind === 'pickup' ? 'a' : 'b'), draggable: true }).addTo(map);
      markers[kind].on('dragend', async () => { const ll = markers[kind].getLatLng(); setPoint(kind, ll.lat, ll.lng, ''); fillAddress(kind); });
    } else markers[kind].setLatLng([lat, lng]);
    if (pts.pickup && pts.dropoff) map.fitBounds(L.latLngBounds([pts.pickup, pts.dropoff]).pad(0.3));
    scheduleQuote();
  }
  async function fillAddress(kind) {
    const { lat, lng } = pts[kind], a = await reverse(lat, lng);
    if (a && pts[kind] && pts[kind].lat === lat && pts[kind].lng === lng && !addrInput[kind].value) { pts[kind].address = a; addrInput[kind].value = a; }
  }
  map.on('click', (e) => { const kind = mode; setPoint(kind, e.latlng.lat, e.latlng.lng, ''); fillAddress(kind); if (kind === 'pickup' && !pts.dropoff) setMode('dropoff'); });
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });
  f.pAddr.addEventListener('input', () => { if (pts.pickup) pts.pickup.address = f.pAddr.value; });
  f.dAddr.addEventListener('input', () => { if (pts.dropoff) pts.dropoff.address = f.dAddr.value; });

  // عناوين محفوظة: تعبئة الاستلام/التسليم بضغطة
  if (saved.length) {
    const useSaved = (kind, i) => { const a = saved[i]; if (!a || !Number.isFinite(a.lat) || !Number.isFinite(a.lng)) return; map.setView([a.lat, a.lng], Math.max(map.getZoom(), 13)); setPoint(kind, a.lat, a.lng, a.address); };
    $('#sA', el).addEventListener('change', (e) => { if (e.target.value !== '') useSaved('pickup', +e.target.value); });
    $('#sB', el).addEventListener('change', (e) => { if (e.target.value !== '') useSaved('dropoff', +e.target.value); });
  }

  // البحث عن مكان
  const runSearch = async () => {
    const q = $('#q', el).value.trim(); if (q.length < 3) return;
    const box = $('#results', el); render(box, spinner());
    const res = await geocode(q).catch(() => []);
    render(box, res.length ? html`<div class="results">${res.map((r, i) => html`<button type="button" data-i="${i}">${r.name}</button>`)}</div>` : html`<p class="hint">${t('new.noResults')}</p>`);
    box.onclick = (ev) => {
      const b = ev.target.closest('[data-i]'); if (!b) return; const r = res[+b.dataset.i];
      map.setView([r.lat, r.lng], 15); setPoint(mode, r.lat, r.lng, r.name.split('،').slice(0, 3).join('،')); if (mode === 'pickup' && !pts.dropoff) setMode('dropoff'); render(box, '');
    };
  };
  $('#qbtn', el).addEventListener('click', runSearch);
  $('#q', el).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } });

  // عرض السعر التلقائي (بيتحسب على السيرفر — مش ممكن العميل يتلاعب فيه)
  function scheduleQuote() { clearTimeout(qTimer); qTimer = setTimeout(doQuote, 350); }
  async function doQuote() {
    if (!pts.pickup || !pts.dropoff) { quote = null; quoteBox.textContent = t('new.needPoints'); return; }
    const seq = ++qSeq; render(quoteBox, spinner());
    try {
      const r = await api('quote', service === 'passengers'
        ? { service, pickup: pts.pickup, dropoff: pts.dropoff, vehicleClass: f.vehicleClass.value, coupon: f.coupon.value.trim() }
        : { pickup: pts.pickup, dropoff: pts.dropoff, category: f.category.value, size: f.size.value, coupon: f.coupon.value.trim() });
      if (seq !== qSeq) return; quote = r;
      const disc = r.discount ? html`<p class="hint" style="margin:.4rem 0 0;color:var(--nile)">${t('coupon.applied')} ${fmtMoney(r.discount)} · ${t('coupon.due')} <b>${fmtMoney(r.amountDue)}</b></p>` : '';
      const cerr = r.couponError ? html`<p class="hint" style="margin:.4rem 0 0;color:var(--brick)">${t('err.' + r.couponError)}</p>` : '';
      render(quoteBox, html`<div class="row"><div class="grow"><div class="muted small">${t('new.estPrice')}</div><b style="font:700 1.9rem var(--font-display)">${fmtMoney(r.price)}</b></div>
        <div class="muted small">${fmtNum(r.distanceKm)} ${t('common.km')}${r.source === 'estimate' ? ' ~' : ''}</div></div>
        <p class="hint" style="margin:.5rem 0 0">${t('new.priceNote')}${r.source === 'estimate' ? ' ' + t('new.approxDist') : ''}</p>${disc}${cerr}`);
    } catch (e) { if (seq === qSeq) { quote = null; quoteBox.textContent = errMsg(e); } }
  }
  f.category.addEventListener('change', scheduleQuote); f.size.addEventListener('change', scheduleQuote);
  f.coupon.addEventListener('input', scheduleQuote); // كود الخصم بيغيّر السعر المطلوب (بيتحقق منه على السيرفر)

  // شحن بضاعة <-> نقل ركاب (لو الأدمن فعّل الركاب)
  const syncSeats = () => { const c = S.passengerClasses?.[f.vehicleClass?.value]; if (c && f.passengers) { f.passengers.max = c.seats; if (+f.passengers.value > c.seats) f.passengers.value = c.seats; } };
  function setService(sv) {
    service = sv;
    $$('[data-svc]', el).forEach((b) => b.classList.toggle('on', b.dataset.svc === sv));
    $$('[data-only]', el).forEach((x) => { x.hidden = x.dataset.only !== sv; });
    syncSeats(); scheduleQuote();
  }
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-svc]'); if (b) setService(b.dataset.svc); });
  // ترشيح العربية (اختياري): بيتحسب من الوزن، والاختيار بيضبط الحجم (السعر بيتحسب من الحجم على السيرفر)
  const vname = (k) => (t('vehicle.' + k) === 'vehicle.' + k ? k : t('vehicle.' + k));
  function drawVpick() {
    const box = $('#vpick', el); if (!box) return;
    const rec = recommendVehicle(S.vehicleGuide, f.weightKg.value);
    render(box, html`${vkeys.map((k) => html`<button type="button" data-vp="${k}" class="${vpick === k ? 'on' : ''}" aria-pressed="${vpick === k}"><span class="vimg">${raw(vehicleSvg(k, vname(k)))}</span>${rec === k && +f.weightKg.value > 0 ? html`<span class="rec">★ ${t('vpick.recommended')}</span>` : ''}<span>${vname(k)}</span><small>${t('vpick.upTo')} ${fmtNum(S.vehicleGuide[k].maxKg, 0)} ${t('common.kg')}</small></button>`)}${S.passengersEnabled && classes.length ? html`<button type="button" data-vp="__pax"><span class="vimg">${raw(vehicleSvg('passengers', t('vpick.passengers')))}</span><span>${t('vpick.passengers')}</span><small>${t('vpick.passengersSub')}</small></button>` : ''}`);
  }
  $('#vpick', el)?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-vp]'); if (!b) return;
    if (b.dataset.vp === '__pax') { setService('passengers'); return; } // كارت نقل الركاب بيحوّل للخدمة (لو الأدمن مفعّلها)
    vpick = vpick === b.dataset.vp ? null : b.dataset.vp; // ضغطة تانية = إلغاء الاختيار
    if (vpick) { f.size.value = S.vehicleGuide[vpick].size; scheduleQuote(); }
    drawVpick();
  });
  f.size.addEventListener('change', () => { if (vpick && S.vehicleGuide[vpick].size !== f.size.value) { vpick = null; drawVpick(); } }); // تغيير الحجم يدوي = الاختيار مابقاش مطابق
  f.weightKg.addEventListener('input', drawVpick); drawVpick();

  // الدفع المقدم بيلغي العروض (السعر بيبقى ثابت)
  f.declaredValue?.addEventListener('input', () => { // حراسة القيمة: نبّه العميل لو الشحنة هتتحسب «عالية القيمة»
    const g = $('#guardHint', el), high = S.valueGuardOn === true && (+f.declaredValue.value || 0) >= (S.valueGuardFrom || 0);
    g.hidden = !high; if (high) g.textContent = t(S.deliveryCodeAvailable ? 'guard.formHint' : 'guard.formNoSecret');
  });
  f.prepay?.addEventListener('change', () => { if (f.offersOnly) { f.offersOnly.disabled = f.prepay.checked; if (f.prepay.checked) f.offersOnly.checked = false; } });
  f.vehicleClass?.addEventListener('change', () => { syncSeats(); scheduleQuote(); });

  // «اطلب تاني»: تعبئة من طلب سابق (النقاط والنوع والوزن) — الصور والموعد والكوبون بتتجدد
  const prev = state.reorder; state.reorder = null;
  if (prev?.pickup && prev?.dropoff && Number.isFinite(prev.pickup.lat) && Number.isFinite(prev.dropoff.lat)) {
    const sv = prev.service === 'passengers' && S.passengersEnabled && classes.length ? 'passengers' : 'cargo';
    if (sv === 'passengers') { setService('passengers'); if (S.passengerClasses?.[prev.vehicleClass]) f.vehicleClass.value = prev.vehicleClass; if (f.passengers && prev.passengers) f.passengers.value = prev.passengers; syncSeats(); }
    else { if (S.categories?.[prev.category]) f.category.value = prev.category; if (S.sizes?.[prev.size]) f.size.value = prev.size; if (prev.weightKg) f.weightKg.value = prev.weightKg; }
    if (prev.description) (sv === 'passengers' ? f.descriptionTrip : f.description).value = prev.description;
    setPoint('pickup', prev.pickup.lat, prev.pickup.lng, prev.pickup.address || ''); setPoint('dropoff', prev.dropoff.lat, prev.dropoff.lng, prev.dropoff.address || '');
    setMode('dropoff'); toast(t('order.reorderHint'));
  }

  // معاينة الصور
  let urls = [];
  f.photos.addEventListener('change', () => {
    urls.forEach(URL.revokeObjectURL);
    const files = [...f.photos.files].slice(0, 5);
    urls = files.map((x) => URL.createObjectURL(x));
    render($('#previews', el), html`${urls.map((u) => html`<img src="${u}" alt="">`)}`);
  });

  f.addEventListener('submit', (e) => {
    e.preventDefault(); err.textContent = '';
    const files = [...f.photos.files].slice(0, 5);
    if (!pts.pickup || !pts.dropoff) { err.textContent = t('new.needPoints'); return; }
    const trip = service === 'passengers';
    if (!trip && !files.length) { err.textContent = t('new.needPhoto'); return; }
    if (!trip && !f.weightKg.value) { err.textContent = t('new.needWeight'); return; }
    if (!trip && f.description.value.trim().length < 10) { err.textContent = t('manifest.needDesc'); return; }
    busy($('#submit', el), async () => {
      try {
        const refs = [];
        for (let i = 0; !trip && i < files.length; i++) { $('#progress', el).textContent = `${t('auth.uploading')} ${i + 1}/${files.length}`; refs.push(await uploadImage(files[i], 'cargo')); }
        $('#progress', el).textContent = t('auth.saving');
        const r = await api('orders/create', {
          pickup: pts.pickup, dropoff: pts.dropoff,
          prepay: !trip && !!f.prepay?.checked,
          ...(trip ? { service: 'passengers', vehicleClass: f.vehicleClass.value, passengers: f.passengers.value } : { service: 'cargo', category: f.category.value, size: f.size.value, weightKg: f.weightKg.value, itemsCount: f.itemsCount.value || 1, declaredValue: f.declaredValue.value || 0, ...(vpick ? { vehiclePick: vpick } : {}), ...(f.companion ? { companion: f.companion.checked } : {}), ...(f.codAmount && f.codAmount.value ? { codAmount: f.codAmount.value } : {}) }),
          description: trip ? f.descriptionTrip.value : f.description.value.trim(), photos: refs, instant: !(f.offersOnly && f.offersOnly.checked), scheduledAt: new Date(f.scheduledAt.value).toISOString(),
          ...(f.graceMin.value !== '' ? { graceMin: f.graceMin.value } : {}), ...(f.deliveryAt.value ? { deliveryAt: new Date(f.deliveryAt.value).toISOString() } : {}), // تتبّع التأخير (اختياري)
          coupon: f.coupon.value.trim(),
        });
        toast(t('new.created')); location.hash = `#/order/${r.id}`;
      } catch (er) { err.textContent = errMsg(er); $('#progress', el).textContent = ''; }
    });
  });

  return () => { clearTimeout(qTimer); urls.forEach(URL.revokeObjectURL); map.remove(); };
}
