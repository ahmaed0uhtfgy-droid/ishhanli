import { auth, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, deleteUser, RecaptchaVerifier, linkWithPhoneNumber } from '../firebase.js';
import { api, poll } from '../api.js';
import { APP } from '../config.js';
import { state } from '../state.js';
import { t, getLang } from '../i18n.js';
import { $, html, render, toast, errMsg, busy, promptDialog } from '../ui.js';
import { uploadImage } from '../storage.js';

const VEHICLES = ['pickup', 'half_ton', 'truck', 'van', 'car', 'microbus', 'minibus'];

export function renderLogin(el) {
  render(el, html`<div class="auth card stack">
    <h1>${t('auth.loginTitle')}</h1>
    <form id="f" class="stack" novalidate>
      <label class="f">${t('auth.email')}<input type="email" name="email" autocomplete="email" required></label>
      <label class="f">${t('auth.password')}<input type="password" name="password" autocomplete="current-password" required></label>
      <p class="err" id="err" role="alert"></p>
      <button class="btn primary block" type="submit">${t('nav.login')}</button>
    </form>
    <div class="row"><a href="#/forgot">${t('auth.forgot')}</a><span class="grow"></span><a href="#/register">${t('auth.noAccount')}</a></div>
  </div>`);
  $('#f', el).addEventListener('submit', (e) => {
    e.preventDefault(); const f = e.target;
    busy($('button', f), async () => {
      try { await signInWithEmailAndPassword(auth, f.email.value.trim(), f.password.value); } catch (er) { $('#err', el).textContent = errMsg(er); }
    });
  });
  return () => {};
}

export function renderForgot(el) {
  render(el, html`<div class="auth card stack">
    <h1>${t('auth.forgotTitle')}</h1>
    <form id="f" class="stack"><label class="f">${t('auth.email')}<input type="email" name="email" required></label>
    <p class="err" id="err" role="alert"></p><button class="btn primary block" type="submit">${t('auth.sendReset')}</button></form>
    <a href="#/login">${t('auth.back')}</a></div>`);
  $('#f', el).addEventListener('submit', (e) => {
    e.preventDefault();
    busy($('button', e.target), async () => {
      try { await sendPasswordResetEmail(auth, e.target.email.value.trim()); toast(t('auth.resetSent')); } catch (er) { $('#err', el).textContent = errMsg(er); }
    });
  });
  return () => {};
}

async function verifyPhone(phone) {
  const verifier = new RecaptchaVerifier(auth, 'recaptcha', { size: 'invisible' });
  const conf = await linkWithPhoneNumber(auth.currentUser, '+2' + phone, verifier); // 01xxxxxxxxx -> +201xxxxxxxxx
  const code = await promptDialog(t('auth.otpPrompt'), { required: true });
  if (!code) throw Object.assign(new Error('otp_cancelled'), { code: 'otp_cancelled' });
  await conf.confirm(code);
  await auth.currentUser.getIdToken(true); // عشان التوكن يشيل phone_number
}

export function renderRegister(el, query) {
  let role = query.get('role') === 'driver' ? 'driver' : 'customer';
  const needsAccount = !auth.currentUser;
  const file = (name, key, req = true) => html`<label class="f">${t(key)}<input type="file" name="${name}" accept="image/*" ${req ? 'required' : ''}></label>`;
  render(el, html`<div class="auth card stack">
    <h1>${t('auth.registerTitle')}</h1>
    ${needsAccount ? '' : html`<div class="action info">${t('auth.completeProfile')}</div>`}
    <div class="role-pick" role="group" aria-label="${t('auth.iAm')}">
      <button type="button" data-role="customer"><b>${t('auth.roleCustomer')}</b><span class="hint">${t('auth.roleCustomerHint')}</span></button>
      <button type="button" data-role="driver"><b>${t('auth.roleDriver')}</b><span class="hint">${t('auth.roleDriverHint')}</span></button>
    </div>
    <form id="f" class="stack" novalidate>
      <label class="f">${t('auth.name')}<input name="name" autocomplete="name" required minlength="2"></label>
      <div class="grid-2">
        <label class="f">${t('auth.phone')}<input name="phone" inputmode="tel" autocomplete="tel" placeholder="01xxxxxxxxx" required></label>
        <label class="f" id="nidWrap" hidden>${t('auth.nationalId')}<input name="nationalId" inputmode="numeric" maxlength="14" placeholder="14 ${t('auth.digits')}"></label>
      </div>
      <label class="f">${t('auth.area')}<input name="area" placeholder="${t('auth.areaHint')}"></label>
      ${needsAccount ? html`<div class="grid-2">
        <label class="f">${t('auth.email')}<input type="email" name="email" autocomplete="email" required></label>
        <label class="f">${t('auth.password')}<input type="password" name="password" autocomplete="new-password" minlength="6" required></label></div>` : ''}
      <div id="driverOnly" class="stack" hidden>
        ${file('idFile', 'auth.idPhoto', false)}
        <label class="f">${t('auth.vehicleType')}<select name="vehicleType">${VEHICLES.map((v) => html`<option value="${v}">${t('vehicle.' + v)}</option>`)}</select></label>
        ${file('licenseFile', 'auth.license', false)}${file('vehicleRegFile', 'auth.vehicleReg', false)}${file('vehiclePhotoFile', 'auth.vehiclePhoto', false)}
        <p class="hint">${t('auth.driverReview')}</p>
      </div>
      <label class="row"><input type="checkbox" name="terms" required> <span>${t('auth.terms')}</span></label>
      <p class="err" id="err" role="alert"></p>
      <button class="btn primary block" type="submit" id="submit">${t('auth.submit')}</button>
      <p class="hint" id="progress"></p>
    </form>
    ${needsAccount ? html`<a href="#/login">${t('auth.haveAccount')}</a>` : ''}
  </div>`);

  const f = $('#f', el), err = $('#err', el);
  const paint = () => { el.querySelectorAll('[data-role]').forEach((b) => b.classList.toggle('on', b.dataset.role === role)); $('#driverOnly', el).hidden = role !== 'driver'; $('#nidWrap', el).hidden = role !== 'driver'; };
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-role]'); if (b) { role = b.dataset.role; paint(); } });
  paint();

  f.addEventListener('submit', (e) => {
    e.preventDefault(); err.textContent = '';
    if (!f.terms.checked) { err.textContent = t('err.terms'); return; }
    if (role === 'driver' && !(f.licenseFile.files[0] && f.vehicleRegFile.files[0] && f.vehiclePhotoFile.files[0])) { err.textContent = t('err.driverDocs'); return; }
    if (role === 'driver' && !f.idFile.files[0]) { err.textContent = t('err.bad_file'); return; }
    busy($('#submit', el), async () => {
      const say = (k) => { $('#progress', el).textContent = t(k); };
      state.registering = true; let created = false;
      try {
        if (!auth.currentUser) { await createUserWithEmailAndPassword(auth, f.email.value.trim(), f.password.value); created = true; }
        say('auth.uploading');
        const body = { role, name: f.name.value, phone: f.phone.value, area: f.area.value, lang: getLang() };
        if (role === 'driver') {
          body.nationalId = f.nationalId.value;
          body.idRef = await uploadImage(f.idFile.files[0], 'id');
          body.vehicleType = f.vehicleType.value;
          body.licenseRef = await uploadImage(f.licenseFile.files[0], 'license');
          body.vehicleRegRef = await uploadImage(f.vehicleRegFile.files[0], 'vehicle');
          body.vehiclePhotoRef = await uploadImage(f.vehiclePhotoFile.files[0], 'vehiclePhoto');
        }
        if (APP.phoneOTP && !auth.currentUser.phoneNumber) await verifyPhone(String(f.phone.value).replace(/\D/g, ''));
        say('auth.saving');
        await api('register', body);
        toast(t('auth.registered'));
        state.profile = (await api('me')).profile;
        state.registering = false; window.dispatchEvent(new Event('app:refresh'));
      } catch (er) {
        state.registering = false; $('#progress', el).textContent = '';
        if (created && ['blacklisted', 'duplicate', 'bad_phone', 'bad_national_id'].includes(er.code)) { try { await deleteUser(auth.currentUser); } catch { /* ignore */ } }
        err.textContent = errMsg(er);
      }
    });
  });
  return () => {};
}

export function renderStatus(el, p) {
  const s = p.status;
  render(el, html`<div class="auth card stack">
    <div class="row"><h1 class="grow">${t('status.title_' + s)}</h1><span class="stamp s-${s}">${t('status.' + s)}</span></div>
    <p>${t('status.msg_' + s)}</p>
    ${p.statusReason ? html`<div class="action bad"><b>${t('status.reason')}:</b> ${p.statusReason}</div>` : ''}
    <p class="hint">${t('status.contact')}</p>
  </div>`);
  // الحساب المعلّق بيتحدّث تلقائياً أول ما الأدمن يفعّله
  return poll(() => api('me'), 20000, (r) => {
    if (r.profile && r.profile.status !== p.status) { state.profile = r.profile; window.dispatchEvent(new Event('app:refresh')); }
  });
}
