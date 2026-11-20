// بديل اختباري لـ firebase-auth: الحسابات والتوكنات بيتولّدوا من سيرفر الاختبار (test/e2e/server.mjs) بتوقيع مفتاح اختبار.
const KEY = '__e2e_user';
const listeners = new Set();
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
let cur = load();
const err = (code) => Object.assign(new Error(code), { code });
const post = async (op, body) => { const r = await fetch('/__e2e/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, ...body }) }); const j = await r.json(); if (!r.ok) throw err(j.code || 'auth/internal-error'); return j; };
const mk = (u) => u && ({ uid: u.uid, email: u.email, emailVerified: true, phoneNumber: null, displayName: null, providerData: [{ providerId: 'password' }], getIdToken: async () => (await (await fetch('/__e2e/token?uid=' + encodeURIComponent(u.uid) + '&email=' + encodeURIComponent(u.email))).json()).token, delete: async () => { await signOut(auth); } });
const auth = { get currentUser() { return mk(cur); } };
const emit = () => listeners.forEach((cb) => cb(mk(cur)));
const set = (u) => { cur = u; if (u) localStorage.setItem(KEY, JSON.stringify(u)); else localStorage.removeItem(KEY); emit(); };
export const getAuth = () => auth;
export const initializeAuth = () => auth;
export const indexedDBLocalPersistence = {}, browserLocalPersistence = {}, browserSessionPersistence = {}, browserPopupRedirectResolver = {};
export const onAuthStateChanged = (_a, cb) => { listeners.add(cb); queueMicrotask(() => cb(mk(cur))); return () => listeners.delete(cb); };
export const signInWithEmailAndPassword = async (_a, email, password) => { const u = await post('signin', { email, password }); set(u); return { user: mk(u) }; };
export const createUserWithEmailAndPassword = async (_a, email, password) => { if (String(password).length < 6) throw err('auth/weak-password'); const u = await post('signup', { email, password }); set(u); return { user: mk(u) }; };
export const signOut = async () => { set(null); };
export const sendPasswordResetEmail = async () => {};
export const deleteUser = async () => { set(null); };
export const updatePassword = async () => {};
export const reauthenticateWithCredential = async () => {};
export const EmailAuthProvider = { credential: (email, password) => ({ email, password }) };
export class GoogleAuthProvider { setCustomParameters() {} }
export class RecaptchaVerifier { render() { return Promise.resolve(0); } clear() {} }
export const linkWithPhoneNumber = async () => { throw err('auth/operation-not-allowed'); };
export const signInWithPopup = async () => { throw err('auth/popup-closed-by-user'); };
export const signInWithRedirect = async () => { throw err('auth/operation-not-allowed'); };
