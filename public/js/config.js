// ⚙️ عدّل القيم دي فقط: Firebase Console → Project settings → Your apps → Web app → Config
// (Firebase بيُستخدم لتسجيل الدخول فقط — البيانات كلها على Cloudflare D1)
export const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  appId: 'YOUR_APP_ID',
  messagingSenderId: 'YOUR_SENDER_ID',   // للإشعارات (Project settings → Cloud Messaging)
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
