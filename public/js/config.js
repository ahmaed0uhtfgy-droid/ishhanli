// ⚙️ عدّل القيم دي فقط: Firebase Console → Project settings → Your apps → Web app → Config
// (Firebase بيُستخدم لتسجيل الدخول + قاعدة البيانات Firestore (من السيرفر بس) + الإشعارات. السيرفر والمنطق على Cloudflare)
export const firebaseConfig = {
  apiKey: 'AIzaSyA3apC9FdfBzHgHafchojQwQT1i1tSXHHw',
  authDomain: 'ishhanli.firebaseapp.com',
  projectId: 'ishhanli',
  appId: '1:288713296891:web:39a65a07e32547e48d195e',
  messagingSenderId: '288713296891',   // للإشعارات (Project settings → Cloud Messaging)
};

// مضاعف فاصل التحديث الدوري. 2 = مناسب للخطة المجانية (Spark: 50 ألف قراءة/يوم) مع التحديث الذكي (sync). حطه 1 لو رقّيت لـ Blaze.
export const POLL_SCALE = 2;
globalThis.POLL_SCALE = POLL_SCALE;

export const APP = {
  // تحقق OTP بالـ SMS عبر Firebase Phone Auth (بيتحاسب لكل رسالة على خطة Blaze). الافتراضي: مراجعة الأدمن يدوياً.
  // مفتاح الإشعارات: Firebase Console → Project settings → Cloud Messaging → Web Push certificates → Generate key pair
  vapidKey: 'YOUR_VAPID_KEY',
  phoneOTP: false,
  defaultLang: 'ar',
  mapCenter: [30.0444, 31.2357], // القاهرة
  mapZoom: 11,
};
