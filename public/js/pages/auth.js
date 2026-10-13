import { auth, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, deleteUser, RecaptchaVerifier, linkWithPhoneNumber, GoogleAuthProvider, signInWithPopup, signInWithRedirect } from '../firebase.js';
import { api, poll } from '../api.js';
import { gpoll } from '../sync.js';
import { APP } from '../config.js';
import { state } from '../state.js';
import { t, getLang } from '../i18n.js';
import { $, html, render, toast, errMsg, busy, promptDialog } from '../ui.js';
import { uploadImage } from '../storage.js';

// تسجيل الدخول بجوجل: نافذة منبثقة، ولو المتصفح منعها (غالباً موبايل) بنحوّل لإعادة توجيه. الحساب الجديد بيروح لصفحة «أكمل بياناتك».
const GOOGLE_BTN = () => html`<button class="btn ghost block" type="button" id="gbtn"><svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" style="vertical-align:middle;margin-inline-end:.5rem"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.4-4.1 7-10.1 7-17.6z"/><path fill="#FBBC05" d="M10.5 28.7A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.8l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>${t('auth.google')}</button>`;
async function googleSignIn(btn, errEl) {
  errEl.textContent = '';
  await busy(btn, async () => {
    const provider = new GoogleAuthProvider(); provider.setCustomParameters({ prompt: 'select_account' });
    try {
      await signInWithPopup(auth, provider);
      api('me').then((r) => r.profile && api('auth/login')).catch(() => {}); // حساب جوجل الجديد ملوش ملف لسه: مفيش تسجيل دخول
    } catch (er) {
      if (er?.code === 'auth/popup-blocked') { await signInWithRedirect(auth, provider); return; }
      if (er?.code === 'auth/popup-closed-by-user' || er?.code === 'auth/cancelled-popup-request') return; // المستخدم قفل النافذة: مش خطأ
      console.error('google sign-in failed', er?.code, er?.message);
      errEl.textContent = errMsg(er) + ' (' + String(er?.code || er?.message || 'unknown').slice(0, 60) + ')';
    }
  });
}

const VEHICLES = ['pickup', 'half_ton', 'truck', 'van', 'car', 'microbus', 'minibus'];

export function renderLogin(el) {
  render(el, html`<div class="auth card stack">
    <h1>${t('auth.loginTitle')}</h1>
    <form id="f" class="stack" novalidate>
      <label class="f">${t('auth.email')}<input type="email" name="email" autocomplete="email" required></label>
      <label class="f">${t('auth.password')}<input type="password" name="password" autocomplete="current-password" required></label>
      <p class="err" id="err" role="alert"></p>
      <button class="btn primary block" type="submit">${t('nav.login')}</button>
      <p class="hint" style="text-align:center">${t('auth.or')}</p>
      ${GOOGLE_BTN()}
    </form>
    <div class="row"><a href="#/forgot">${t('auth.forgot')}</a><span class="grow"></span><a href="#/register">${t('auth.noAccount')}</a></div>
  </div>`);
  $('#gbtn', el).addEventListener('click', () => googleSignIn($('#gbtn', el), $('#err', el)));
  $('#f', el).addEventListener('submit', (e) => {
    e.preventDefault(); const f = e.target;
    busy($('button[type=submit]', f), async () => {
      try { await signInWithEmailAndPassword(auth, f.email.value.trim(), f.password.value); api('auth/login').catch(() => {}); } catch (er) { $('#err', el).textContent = errMsg(er); }
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
  const refPre = (query.get('ref') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); // كود إحالة من رابط المشاركة
  const file = (name, key, req = true) => html`<label class="f">${t(key)}<input type="file" name="${name}" accept="image/*" ${req ? 'required' : ''}></label>`;
  render(el, html`<div class="auth card stack">
    <h1>${t('auth.registerTitle')}</h1>
    ${needsAccount ? html`${GOOGLE_BTN()}<p class="hint" style="text-align:center">${t('auth.orEmail')}</p>` : html`<div class="action info">${t('auth.completeProfile')}</div>`}
    <div class="role-pick" role="group" aria-label="${t('auth.iAm')}">
      <button type="button" data-role="customer"><b>${t('auth.roleCustomer')}</b><span class="hint">${t('auth.roleCustomerHint')}</span></button>
      <button type="button" data-role="driver"><b>${t('auth.roleDriver')}</b><span class="hint">${t('auth.roleDriverHint')}</span></button>
    </div>
    <form id="f" class="stack" novalidate>
      <label class="f">${t('auth.name')}<input name="name" autocomplete="name" required minlength="2"></label>
      <div class="grid-2">
        <label class="f">${t('auth.phone')}<input name="phone" inputmode="tel" autocomplete="tel" placeholder="01xxxxxxxxx" required></label>
        <label class="f">${t('auth.nationalId')}<input name="nationalId" inputmode="numeric" maxlength="14" placeholder="14 ${t('auth.digits')}" required></label>
      </div>
      <label class="f">${t('auth.area')}<input name="area" placeholder="${t('auth.areaHint')}"></label>
      <label class="f">${t('auth.referral')}<input name="referral" value="${refPre}" dir="ltr" maxlength="12" placeholder="${t('auth.referralHint')}"></label>
      ${needsAccount ? html`<div class="grid-2">
        <label class="f">${t('auth.email')}<input type="email" name="email" autocomplete="email" required></label>
        <label class="f">${t('auth.password')}<input type="password" name="password" autocomplete="new-password" minlength="6" required></label></div>` : ''}
      ${file('idFile', 'auth.idPhoto')}
      <div id="driverOnly" class="stack" hidden>
        <label class="f">${t('auth.vehicleType')}<select name="vehicleType">${VEHICLES.map((v) => html`<option value="${v}">${t('vehicle.' + v)}</option>`)}</select></label>
        <label class="row"><input type="checkbox" name="isCompany"> <span>${t('auth.asCompany')}</span></label>
        <div id="companyOnly" class="stack" hidden>
          <label class="f">${t('auth.companyName')}<input name="companyName" maxlength="80"></label>
          ${file('commercialRegFile', 'auth.commercialReg', false)}${file('taxCardFile', 'auth.taxCard', false)}
          <p class="hint">${t('auth.companyHint')}</p>
        </div>
        <div id="indivDocs" class="stack">${file('licenseFile', 'auth.license', false)}${file('vehicleRegFile', 'auth.vehicleReg', false)}${file('vehiclePhotoFile', 'auth.vehiclePhoto', false)}</div>
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
  if (needsAccount) $('#gbtn', el).addEventListener('click', () => googleSignIn($('#gbtn', el), err));
  const isCo = () => role === 'driver' && f.isCompany.checked;
  const paint = () => { el.querySelectorAll('[data-role]').forEach((b) => b.classList.toggle('on', b.dataset.role === role)); $('#driverOnly', el).hidden = role !== 'driver'; $('#companyOnly', el).hidden = !isCo(); $('#indivDocs', el).hidden = isCo(); };
  f.isCompany.addEventListener('change', paint);
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-role]'); if (b) { role = b.dataset.role; paint(); } });
  paint();

  f.addEventListener('submit', (e) => {
    e.preventDefault(); err.textContent = '';
    if (!f.terms.checked) { err.textContent = t('err.terms'); return; }
    if (isCo()) { if (f.companyName.value.trim().length < 2 || !(f.commercialRegFile.files[0] && f.taxCardFile.files[0])) { err.textContent = t('err.companyDocs'); return; } }
    else if (role === 'driver' && !(f.licenseFile.files[0] && f.vehicleRegFile.files[0] && f.vehiclePhotoFile.files[0])) { err.textContent = t('err.driverDocs'); return; }
    if (!f.idFile.files[0]) { err.textContent = t('err.bad_file'); return; }
    busy($('#submit', el), async () => {
      const say = (k) => { $('#progress', el).textContent = t(k); };
      state.registering = true; let created = false;
      try {
        if (!auth.currentUser) { await createUserWithEmailAndPassword(auth, f.email.value.trim(), f.password.value); created = true; }
        say('auth.uploading');
        const body = { role, name: f.name.value, phone: f.phone.value, nationalId: f.nationalId.value, area: f.area.value, lang: getLang() };
        const ref = String(f.referral.value || '').trim(); if (ref) body.referral = ref; // كود إحالة (اختياري)
        body.idRef = await uploadImage(f.idFile.files[0], 'id');
        if (role === 'driver') {
          body.vehicleType = f.vehicleType.value;
          if (isCo()) { // شركة شحن: مستنداتها بدل مستندات السواق الفرد
            body.accountType = 'company'; body.companyName = f.companyName.value.trim();
            body.commercialRegRef = await uploadImage(f.commercialRegFile.files[0], 'company');
            body.taxCardRef = await uploadImage(f.taxCardFile.files[0], 'company');
          } else {
            body.licenseRef = await uploadImage(f.licenseFile.files[0], 'license');
            body.vehicleRegRef = await uploadImage(f.vehicleRegFile.files[0], 'vehicle');
            body.vehiclePhotoRef = await uploadImage(f.vehiclePhotoFile.files[0], 'vehiclePhoto');
          }
        }
        if (APP.phoneOTP && !auth.currentUser.phoneNumber) await verifyPhone(String(f.phone.value).replace(/\D/g, ''));
        say('auth.saving');
        await api('register', body);
        toast(t('auth.registered'));
        state.profile = (await api('me')).profile;
        api('auth/login').catch(() => {});
        state.registering = false; window.dispatchEvent(new Event('app:refresh'));
      } catch (er) {
        state.registering = false; $('#progress', el).textContent = '';
        if (created && ['blacklisted', 'duplicate', 'bad_phone', 'bad_national_id'].includes(er.code)) { try { await deleteUser(auth.currentUser); } catch { /* ignore */ } }
        console.error('register failed', er?.code, er?.message, er);
        const msg = errMsg(er) + ' (' + String(er?.code || er?.message || 'unknown').slice(0, 60) + ')'; // الكود بيساعد في تشخيص السبب
        err.textContent = msg; toast(msg, true); // toast كمان: الفورم ممكن يتعاد رسمه ويمسح رسالة الخطأ
      }
    });
  });
  return () => {};
}

export function renderStatus(el, p) {
  const s = p.status, drv = p.role === 'driver' && s === 'pending'; // السواق المعلّق: رسالة أوضح بتقوله مستنيين إيه
  render(el, html`<div class="auth card stack">
    <div class="row"><h1 class="grow">${t(drv ? 'status.title_pending_driver' : 'status.title_' + s)}</h1><span class="stamp s-${s}">${t('status.' + s)}</span></div>
    <p>${t(drv ? 'status.msg_pending_driver' : 'status.msg_' + s)}</p>
    ${p.statusReason ? html`<div class="action bad"><b>${t('status.reason')}:</b> ${p.statusReason}</div>` : ''}
    <p class="hint">${t('status.contact')}</p>
  </div>`);
  // الحساب المعلّق بيتحدّث تلقائياً أول ما الأدمن يفعّله
  return gpoll(['users'], () => api('me'), 20000, (r) => {
    if (r.profile && r.profile.status !== p.status) { state.profile = r.profile; window.dispatchEvent(new Event('app:refresh')); }
  });
}
