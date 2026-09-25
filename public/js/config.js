// ⚙️ عدّل القيم دي فقط: Firebase Console → Project settings → Your apps → Web app → Config
// (Firebase بيُستخدم لتسجيل الدخول فقط — البيانات كلها على Cloudflare D1)
export const firebaseConfig = {
  apiKey: 'AIzaSyA3apC9FdfBzHgHafchojQwQT1i1tSXHHw',
  authDomain: 'ishhanli-509519.firebaseapp.com',
  projectId: 'ishhanli-509519',
  appId: '1:288713296891:web:39a65a07e32547e48d195e',
  messagingSenderId: '288713296891',   // للإشعارات (Project settings → Cloud Messaging)
};

export const APP = {
  // تحقق OTP بالـ SMS عبر Firebase Phone Auth (بيتحاسب لكل رسالة على خطة Blaze). الافتراضي: مراجعة الأدمن يدوياً.
  // مفتاح الإشعارات: Firebase Console → Project settings → Cloud Messaging → Web Push certificates → Generate key pair
  vapidKey: 'YOUR_VAPID_KEY',
  phoneOTP: false,
  defaultLang: 'ar',
  mapCenter: [30.0444, 31.2357], // القاهرة
  mapZoom: 11,
};
