// صفحة الحساب: تعديل الاسم/المنطقة/اللغة + إدارة العناوين المحفوظة + حالة الإشعارات.
// كل التعديلات بتتحقق منها على السيرفر (account/update) — المتصفح مش بيكتب في Firestore مباشرة.
import { api, twofa } from '../api.js';
import { state } from '../state.js';
import { t, setLang, applyI18n, getLang } from '../i18n.js';
import { $, $$, html, render, toast, busy, confirmDialog, openModal, spinner, fmtDate, fmtMoney, errMsg } from '../ui.js';
import { createMap, pinIcon, geocode, reverse } from '../map.js';
import { enablePush, pushSupport } from '../push.js';
import { auth, EmailAuthProvider, reauthenticateWithCredential, updatePassword } from '../firebase.js';

/** نافذة إضافة/تعديل عنوان على الخريطة. بترجّع العنوان أو null لو اتلغت. */
function openAddressModal(existing) {
  return new Promise((resolve) => {
    const { el, close } = openModal(html`<div class="stack">
      <h3>${existing ? t('account.editAddr') : t('account.addAddr')}</h3>
      <label class="f">${t('account.addrLabel')}<input id="alabel" maxlength="30" value="${existing?.label || ''}"></label>
      <div class="row"><input id="aq" class="grow" placeholder="${t('new.search')}"><button type="button" class="btn ghost" id="aqbtn">${t('common.search')}</button></div>
      <div id="ares"></div>
      <label class="f">${t('account.addrAddress')}<input id="aaddr" maxlength="200" value="${existing?.address || ''}"></label>
      <p class="hint">${t('account.pickMap')}</p>
      <div id="amap" class="map" style="height:220px"></div>
      <p class="err" id="aerr" role="alert"></p>
      <div class="row end"><button type="button" class="btn ghost" data-v="0">${t('common.cancel')}</button><button type="button" class="btn primary" data-v="1">${t('account.saveAddr')}</button></div>
    </div>`);

    const hasPt = existing && Number.isFinite(existing.lat) && Number.isFinite(existing.lng);
    let pt = hasPt ? { lat: existing.lat, lng: existing.lng } : null;
    const map = createMap($('#amap', el), hasPt ? { center: [pt.lat, pt.lng], zoom: 15 } : {});
    let marker = null;
    const setPt = (lat, lng) => {
      pt = { lat, lng };
      if (!marker) { marker = L.marker([lat, lng], { icon: pinIcon('a'), draggable: true }).addTo(map); marker.on('dragend', () => { const ll = marker.getLatLng(); setPt(ll.lat, ll.lng); fillAddr(); }); }
      else marker.setLatLng([lat, lng]);
    };
    if (hasPt) setPt(pt.lat, pt.lng);
    map.on('click', (e) => { setPt(e.latlng.lat, e.latlng.lng); fillAddr(); });
    async function fillAddr() {
      if (!pt) return;
      const a = await reverse(pt.lat, pt.lng);
      if (a && !$('#aaddr', el).value) $('#aaddr', el).value = a;
    }

    const runSearch = async () => {
      const q = $('#aq', el).value.trim(); if (q.length < 3) return;
      const box = $('#ares', el); render(box, spinner());
      const res = await geocode(q).catch(() => []);
      render(box, res.length ? html`<div class="results">${res.map((r, i) => html`<button type="button" data-i="${i}">${r.name}</button>`)}</div>` : html`<p class="hint">${t('new.noResults')}</p>`);
      box.onclick = (ev) => {
        const b = ev.target.closest('[data-i]'); if (!b) return; const r = res[+b.dataset.i];
        map.setView([r.lat, r.lng], 15); setPt(r.lat, r.lng); $('#aaddr', el).value = r.name.split('،').slice(0, 3).join('،'); render(box, ''); fillAddr();
      };
    };
    $('#aqbtn', el).addEventListener('click', runSearch);
    $('#aq', el).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } });

    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]'); if (!b) return;
      if (b.dataset.v === '0') { close(); resolve(null); return; }
      const label = $('#alabel', el).value.trim();
      if (!label) { $('#aerr', el).textContent = t('err.bad_input'); return; }
      if (!pt) { $('#aerr', el).textContent = t('account.pickMap'); return; }
      close();
      resolve({ label: label.slice(0, 30), address: $('#aaddr', el).value.trim().slice(0, 200), lat: pt.lat, lng: pt.lng });
    });
  });
}

export function renderAccount(el) {
  const p = state.profile || {};
  let addresses = Array.isArray(p.addresses) ? p.addresses.slice() : [];
  const edit = p.edit || {}, locked = !!edit.locked;

  render(el, html`<div class="page-head"><h1>${t('account.title')}</h1></div>
    <div class="stack" style="max-width:680px">
      <form id="pf" class="card stack" novalidate>
        <h2>${t('account.profile')}</h2>
        ${edit.enabled ? html`<p class="hint">${t('account.editRule', { days: edit.days })}</p>` : ''}
        ${locked ? html`<p class="action bad">${t('account.editLocked', { date: fmtDate(edit.nextAt) })}</p>` : ''}
        <label class="f">${t('auth.name')}<input name="name" value="${p.name || ''}" autocomplete="name" required minlength="2"></label>
        <div class="grid-2">
          <label class="f">${t('auth.area')}<input name="area" value="${p.area || ''}" placeholder="${t('auth.areaHint')}"></label>
          <label class="f">${t('account.lang')}<select name="lang"><option value="ar">العربية</option><option value="en">English</option></select></label>
        </div>
        <p class="err" id="perr" role="alert"></p>
        <button class="btn primary" type="submit" id="psave">${t('common.save')}</button>
      </form>

      <div class="card stack">
        <div class="row"><h2 class="grow">${t('account.addresses')}</h2><button class="btn ghost sm" id="addAddr" type="button">${t('account.addAddr')}</button></div>
        <p class="hint">${t('account.addrHint')}</p>
        <div id="alist"></div>
      </div>

      <div class="card stack">
        <h2>${t('account.notifications')}</h2>
        <p class="hint">${t('account.notifHint')}</p>
        <button class="btn ghost" id="notif" type="button"></button>
      </div>

      <div class="card stack">
        <h2>${t('account.password')}</h2>
        <p class="hint">${t('account.passwordHint')}</p>
        <form id="pwf" class="stack" novalidate>
          <label class="f">${t('account.currentPass')}<input type="password" name="cur" autocomplete="current-password" required></label>
          <div class="grid-2">
            <label class="f">${t('account.newPass')}<input type="password" name="np" autocomplete="new-password" minlength="6" required></label>
            <label class="f">${t('account.confirmPass')}<input type="password" name="cp" autocomplete="new-password" minlength="6" required></label>
          </div>
          <p class="err" id="pwerr" role="alert"></p>
          <button class="btn primary" type="submit" id="pwsave">${t('account.changePass')}</button>
        </form>
      </div>

      ${p.role === 'admin' ? html`<div class="card stack">
        <h2>${t('account.twofa')}</h2>
        <p class="hint">${t('account.twofaHint')}</p>
        <div id="tfaBody">${spinner()}</div>
      </div>` : ''}

      ${state.settings?.referralEnabled && p.referralCode ? html`<div class="card stack">
        <h2>${t('account.referral')}</h2>
        <p class="hint">${t('account.referralHint', { r: fmtMoney(state.settings.referralBonusReferrer || 0), d: fmtMoney(state.settings.referralBonusReferred || 0) })}</p>
        <label class="f">${t('account.referralCode')}<input id="refcode" readonly value="${p.referralCode}" dir="ltr"></label>
        <button class="btn ghost" id="refcopy" type="button">${t('account.referralCopy')}</button>
      </div>` : ''}
    </div>`);

  const pf = $('#pf', el);
  pf.lang.value = p.lang === 'en' ? 'en' : 'ar';
  if (locked) pf.querySelectorAll('input, select, button').forEach((x) => { x.disabled = true; });

  function drawList() {
    render($('#alist', el), addresses.length ? html`<div class="stack">${addresses.map((a, i) => html`<div class="card row" style="align-items:center;gap:.6rem">
      <div class="grow"><b>${a.label}</b><div class="muted small">${a.address || '—'}</div></div>
      <button class="btn ghost sm" data-edit="${i}" type="button">${t('account.editAddr')}</button>
      <button class="btn ghost sm" data-del="${i}" type="button">${t('account.delAddr')}</button>
    </div>`)}</div>` : html`<p class="hint">${t('account.noAddr')}</p>`);
  }

  async function persist(next, btn) {
    await busy(btn, async () => {
      const r = await api('account/update', { addresses: next });
      state.profile = r.profile; addresses = next; drawList(); toast(t('common.done'));
      window.dispatchEvent(new Event('app:refresh')); // نحدّث حالة القفل فوراً بعد أي تعديل ناجح
    });
  }

  drawList();
  if (locked) {
    $('#addAddr', el).disabled = true;
    $$('[data-edit], [data-del]', el).forEach((x) => { x.disabled = true; });
  }
  $('#addAddr', el).addEventListener('click', async () => {
    if (addresses.length >= 10) return toast(t('account.addrMax'), true);
    const a = await openAddressModal(null);
    if (a) await persist([...addresses, a], $('#addAddr', el));
  });
  el.addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) { const i = +ed.dataset.edit; const a = await openAddressModal(addresses[i]); if (a) { const next = addresses.slice(); next[i] = a; await persist(next, ed); } return; }
    const dl = e.target.closest('[data-del]');
    if (dl) { const i = +dl.dataset.del; if (await confirmDialog(t('account.delAddr') + '?', { danger: true })) await persist(addresses.filter((_, j) => j !== i), dl); }
  });

  pf.addEventListener('submit', (e) => {
    e.preventDefault();
    busy($('#psave', el), async () => {
      const r = await api('account/update', { name: pf.name.value, area: pf.area.value, lang: pf.lang.value });
      state.profile = r.profile;
      setLang(r.profile.lang || getLang()); applyI18n(document);
      toast(t('common.done'));
      window.dispatchEvent(new Event('app:refresh'));
    });
  });

  const notif = $('#notif', el);
  const drawNotif = () => {
    const s = pushSupport();
    const key = { granted: 'account.notifGranted', denied: 'account.notifDenied', unsupported: 'account.notifUnsupported', not_configured: 'account.notifNotConfigured' }[s] || 'account.notifEnable';
    notif.textContent = t(key);
    notif.disabled = s !== 'default';
  };
  notif.addEventListener('click', async () => {
    const r = await enablePush({ ask: true }).catch(() => 'error');
    if (r === 'granted') toast(t('account.notifGranted'));
    else toast(t({ denied: 'account.notifDenied', unsupported: 'account.notifUnsupported', not_configured: 'account.notifNotConfigured' }[r] || 'err.generic'), true);
    drawNotif();
  });
  drawNotif();

  const rc = $('#refcopy', el);
  if (rc) rc.addEventListener('click', async () => {
    const link = `${location.origin}/#/register?ref=${encodeURIComponent(p.referralCode || '')}`;
    try { await navigator.clipboard.writeText(link); toast(t('account.referralCopied')); }
    catch { try { const inp = $('#refcode', el); inp.focus(); inp.select(); document.execCommand('copy'); toast(t('account.referralCopied')); } catch { toast(link); } }
  });

  // تغيير كلمة السر: إعادة مصادقة بالكلمة الحالية ثم تحديثها (Firebase Auth مباشرة)
  const pwf = $('#pwf', el);
  pwf.addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('#pwerr', el); err.textContent = '';
    const cur = pwf.cur.value, np = pwf.np.value, cp = pwf.cp.value;
    if (np.length < 6) { err.textContent = t('err.auth_weak_password'); return; }
    if (np !== cp) { err.textContent = t('account.passMismatch'); return; }
    busy($('#pwsave', el), async () => {
      try {
        const u = auth.currentUser;
        if (!u || !u.email) throw Object.assign(new Error('no_user'), { code: 'no_user' });
        await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, cur));
        await updatePassword(u, np);
        pwf.reset();
        toast(t('account.passChanged'));
      } catch (er) { err.textContent = errMsg(er); }
    });
  });

  // التحقق بخطوتين (TOTP) — للأدمن فقط
  const tfaBody = $('#tfaBody', el);
  if (tfaBody) {
    const drawTfa = (st) => {
      if (!st || !st.enabled) {
        render(tfaBody, html`<p class="muted">${t('account.twofaOff')}</p>
          <button class="btn primary" id="tfaOn" type="button">${t('account.twofaEnable')}</button>`);
        $('#tfaOn', tfaBody).addEventListener('click', () => busy($('#tfaOn', tfaBody), async () => {
          const r = await api('admin/2fa/setup', {});
          render(tfaBody, html`<p class="hint">${t('account.twofaScan')}</p>
            <label class="f">${t('account.twofaSecret')}<input readonly dir="ltr" value="${r.secret}"></label>
            <div class="row"><button class="btn ghost sm" id="tsecopy" type="button">${t('account.twofaCopy')}</button></div>
            <p class="hint small" dir="ltr" style="word-break:break-all">${r.otpauth}</p>
            <label class="f">${t('account.twofaEnterCode')}<input id="tfaCode" inputmode="numeric" maxlength="6" placeholder="000000"></label>
            <p class="err" id="tfaErr" role="alert"></p>
            <button class="btn primary" id="tfaConfirm" type="button">${t('common.confirm')}</button>`);
          $('#tsecopy', tfaBody).addEventListener('click', async () => { try { await navigator.clipboard.writeText(r.secret); toast(t('account.twofaCopied')); } catch { /* ignore */ } });
          $('#tfaConfirm', tfaBody).addEventListener('click', () => busy($('#tfaConfirm', tfaBody), async () => {
            try { await api('admin/2fa/enable', { code: $('#tfaCode', tfaBody).value.trim() }); toast(t('account.twofaOnMsg')); drawTfa({ enabled: true }); }
            catch (e) { $('#tfaErr', tfaBody).textContent = e.code === 'totp_bad_code' ? t('admin.twofa.bad') : errMsg(e); }
          }));
        }));
      } else {
        render(tfaBody, html`<p class="ok">${t('account.twofaOnMsg')}</p>
          <label class="f">${t('account.twofaEnterCode')}<input id="tfaCode" inputmode="numeric" maxlength="6" placeholder="000000"></label>
          <p class="err" id="tfaErr" role="alert"></p>
          <button class="btn ghost" id="tfaOff" type="button">${t('account.twofaDisable')}</button>`);
        $('#tfaOff', tfaBody).addEventListener('click', () => busy($('#tfaOff', tfaBody), async () => {
          try { await api('admin/2fa/disable', { code: $('#tfaCode', tfaBody).value.trim() }); twofa.clear(); toast(t('account.twofaOffMsg')); drawTfa({ enabled: false }); }
          catch (e) { $('#tfaErr', tfaBody).textContent = e.code === 'totp_bad_code' ? t('admin.twofa.bad') : errMsg(e); }
        }));
      }
    };
    api('admin/2fa/status').then(drawTfa).catch((e) => render(tfaBody, html`<p class="hint">${errMsg(e)}</p>`));
  }

  return () => {};
}
