// صفحة متابعة المستلم (عامة، من غير تسجيل دخول): الرمز في الرابط، والسيرفر بيرجّع أقل قدر ممكن من البيانات.
import { t } from '../i18n.js';
import { html, render, spinner } from '../ui.js';
import { createMap, pinIcon } from '../map.js';

const STEPS = ['open', 'accepted', 'picked_up', 'delivering', 'completed']; // نفس المراحل الخمس في كل مكان
const STEP_OF = { accepted: 1, paid: 1, heading_pickup: 1, picked_up: 2, in_transit: 3, delivered: 3 };
const stepIdx = (s) => STEP_OF[s] ?? 1;

export function renderTrack(view, token) {
  render(view, html`<div class="page-head"><h1>${t('track.pageTitle')}</h1></div><div id="trk" class="stack">${spinner()}</div>`);
  const box = view.querySelector('#trk'); let map = null, truck = null, dst = null, timer = null, dead = false;
  async function load() {
    let r, st;
    try { const res = await fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: token }) }); st = res.status; r = await res.json(); } catch { st = 0; }
    if (dead) return;
    if (st === 404) { render(box, html`<div class="card"><p>${t('track.notFound')}</p></div>`); return stop(); }
    if (st === 429) { render(box, html`<div class="card"><p>${t('err.too_many_requests')}</p></div>`); return; }
    if (st !== 200) { render(box, html`<div class="card"><p>${t('err.network')}</p></div>`); return; }
    if (r.final) { render(box, html`<div class="card"><h3>${t('track.final.' + (r.status === 'completed' || r.status === 'resolved' ? 'done' : 'ended'))}</h3></div>`); return stop(); }
    const i = stepIdx(r.status);
    render(box, html`<div class="card stack"><div class="row"><b class="grow">${t('status.' + r.status)}</b>${r.driver ? html`<span class="muted">${r.driver}${r.vehicleType ? ' · ' + (t('vehicle.' + r.vehicleType) === 'vehicle.' + r.vehicleType ? r.vehicleType : t('vehicle.' + r.vehicleType)) : ''}</span>` : ''}</div>
      <div class="steps-bar">${STEPS.map((s, k) => html`<div class="${k < i ? 'done' : k === i ? 'on' : ''}">${t('step.' + s)}</div>`)}</div>
      <p class="muted small">${r.location ? t('track.approx') : t('track.noLoc')}</p></div><div id="tmap" class="map tall"></div>`);
    if (r.dropoff || r.location) {
      const c = r.location || r.dropoff; map = createMap(box.querySelector('#tmap'), { center: [c.lat, c.lng], zoom: 13 });
      if (r.dropoff) dst = L.marker([r.dropoff.lat, r.dropoff.lng], { icon: pinIcon('b') }).addTo(map);
      if (r.location) { truck = L.marker([r.location.lat, r.location.lng], { icon: pinIcon('truck') }).addTo(map); if (r.dropoff) map.fitBounds([[r.location.lat, r.location.lng], [r.dropoff.lat, r.dropoff.lng]], { padding: [50, 50] }); }
    }
  }
  const stop = () => { clearInterval(timer); timer = null; };
  load(); timer = setInterval(load, 20000);
  return () => { dead = true; stop(); try { map?.remove(); } catch { /* ignore */ } };
}
