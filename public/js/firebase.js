// Firebase هنا للدخول (Auth) فقط. كل البيانات على Cloudflare D1 عبر /api/*
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence, browserPopupRedirectResolver,
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  sendPasswordResetEmail, deleteUser, RecaptchaVerifier, linkWithPhoneNumber,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { firebaseConfig } from './config.js';

export const app = initializeApp(firebaseConfig);
// أداء: getAuth العادي على الموبايل بيحمّل iframe.js (≈93KB) من firebaseapp.com + طلب getProjectConfig أول ما الصفحة تفتح، حتى لو الزائر مش هيسجّل دخول بجوجل.
// فبنعمل initializeAuth من غير popupRedirectResolver (نفس أماكن التخزين بنفس الترتيب)، ونمرّر الـresolver صراحةً وقت الضغط على «دخول بجوجل» بس.
// استثناء: لو المستخدم رجع من signInWithRedirect (علامة fbRedirect في sessionStorage) بنستخدم getAuth الكامل عشان Firebase يكمّل نتيجة التحويل.
const pendingRedirect = () => { try { return sessionStorage.getItem('fbRedirect') === '1'; } catch { return false; } };
export const auth = pendingRedirect() ? getAuth(app) : initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence] });
try { sessionStorage.removeItem('fbRedirect'); } catch { /* ignore */ }
export const popupResolver = browserPopupRedirectResolver;
export const markRedirect = () => { try { sessionStorage.setItem('fbRedirect', '1'); } catch { /* ignore */ } };
export { onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, sendPasswordResetEmail, deleteUser, RecaptchaVerifier, linkWithPhoneNumber, EmailAuthProvider, reauthenticateWithCredential, updatePassword, GoogleAuthProvider, signInWithPopup, signInWithRedirect };
