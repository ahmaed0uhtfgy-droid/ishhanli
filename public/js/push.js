// إشعارات Push عبر Firebase Cloud Messaging (مجاني). بتشتغل على أندرويد/كمبيوتر مباشرة، وعلى آيفون بعد "إضافة للشاشة الرئيسية" (iOS 16.4+).
import { app, auth } from './firebase.js';
import { api } from './api.js';
import { APP, firebaseConfig } from './config.js';

const V = 'https://www.gstatic.com/firebasejs/10.14.1';
const configured = () => !/^YOUR_/.test(APP.vapidKey || 'YOUR_') && !/^YOUR_/.test(firebaseConfig.messagingSenderId || 'YOUR_');
const keyOf = (token) => `${auth.currentUser?.uid}:${token}`;

/** 'unsupported' | 'not_configured' | 'default' | 'granted' | 'denied' */
export function pushSupport() {
  if (!('serviceWorker' in navigator) || !('Notification' in window) || !('PushManager' in window)) return 'unsupported';
  if (!configured()) return 'not_configured';
  return Notification.permission;
}

/** بيطلب الإذن (لو ask) ويسجّل جهاز المستخدم عند السيرفر. بيرجّع الحالة النهائية. */
export async function enablePush({ ask = true } = {}) {
  const s = pushSupport();
  if (['unsupported', 'not_configured', 'denied'].includes(s)) return s;
  if (s === 'default') {
    if (!ask) return s;
    if ((await Notification.requestPermission()) !== 'granted') return Notification.permission;
  }
  const { getMessaging, getToken, isSupported } = await import(`${V}/firebase-messaging.js`);
  if (!(await isSupported())) return 'unsupported';
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const token = await getToken(getMessaging(app), { vapidKey: APP.vapidKey, serviceWorkerRegistration: reg });
  if (!token) return 'error';
  if (localStorage.getItem('pushKey') !== keyOf(token)) { await api('push/register', { token }); localStorage.setItem('pushKey', keyOf(token)); localStorage.setItem('pushToken', token); }
  return 'granted';
}

/** عند تسجيل الخروج: نفصل الجهاز عن الحساب عشان إشعارات المستخدم مايوصلوش لشخص تاني على نفس الجهاز */
export async function unregisterPush() {
  try {
    const token = localStorage.getItem('pushToken');
    if (token) await api('push/unregister', { token });
  } catch { /* best effort */ }
  localStorage.removeItem('pushKey'); localStorage.removeItem('pushToken');
}
