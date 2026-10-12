# ما تم تنفيذه — اشحنلي (تحديثات 2026-10-12)

هذا الأرشيف يحتوي **كل ملفات المشروع** بعد الإضافات والتعديلات الأخيرة (بدون `node_modules` أو `.wrangler` أو أي أسرار).

## ملفات جديدة
- `functions/_lib/totp.js` — توليد/التحقق من TOTP (RFC 6238) + Base32 بـ WebCrypto (بدون مكتبات).
- `test/e2e.smoke.mjs` — فحص دخان E2E بدون تبعيات خارجية (الصفحات العامة + الملفات + `/api/health`).
- `.github/workflows/ci.yml` — تشغيل الاختبارات + فحص E2E في CI.
- `functions/_lib/metrics.js`, `functions/_lib/publicProfile.js`, `functions/drivers/*` — من المراحل السابقة.

## تعديلات رئيسية
- `functions/api/[[route]].js`: مسارات التحقق بخطوتين (`admin/2fa/*`)، سجل الدخول (`auth/login`)، عرض السجل للأدمن (`admin/logins`)، النسخة الاحتياطية (`admin/export`)، إجبار 2FA داخل `need()`، الحدّ المركزي للطلبات (`API_RATE_PER_MIN` / `API_RATE_DISABLED`)، إصلاحات وتحسينات مسارات الإحالة/الكوبونات/التقارير/المراقبة.
- `functions/_lib/db.js`: إضافة `totpEnabled` في `userOut`.
- `public/js/firebase.js`: تصدير `EmailAuthProvider`, `reauthenticateWithCredential`, `updatePassword`.
- `public/js/api.js`: إرسال هيدر `x-2fa` + حدث `app:2fa-required` عند انتهاء جلسة التحقق.
- `public/js/app.js`: بوابة التحقق بخطوتين للأدمن قبل فتح اللوحة.
- `public/js/pages/account.js`: قسم تغيير كلمة السر + كارد التحقق بخطوتين (أدمن) + كارد الإحالة.
- `public/js/pages/admin.js`: تصدير نسخة احتياطية JSON + كارد «آخر عمليات الدخول» + تاب الإحالات.
- `public/js/pages/auth.js`: تسجيل الدخول في سجل الدخول + حقل كود الإحالة.
- `public/js/csv.js`: `downloadJson`.
- `public/js/i18n.js`: مفاتيح جديدة (كلمة السر، 2FA، النسخة الاحتياطية، السجل، أخطاء TOTP…).
- `public/js/pages/customer.js`, `receipt.js`, `legal.js`, `config.js`: من المراحل السابقة.
- `README.md`: تحديث قائمة المنفّذ/المؤجّل.
- `test/server.test.mjs`: كتل اختبار للنسخة الاحتياطية، سجل الدخول، التحقق بخطوتين، الحدّ المركزي.
- `package.json`: سكربت `npm run e2e`.

## الأوامر
- التثبيت: `npm install`
- التشغيل محليًا: `npm run dev` → http://localhost:8788
- الاختبارات: `npm test`
- فحص E2E (يحتاج السيرفر شغال): `npm run e2e`

## محجوب خارجيًا (يحتاج إعداد من عندك)
بوابة الدفع/الكيان القانوني، Cron لتحرير Escrow تلقائي، Durable Objects، `vapidKey` للإشعارات، App Check، النسخ الاحتياطي التلقائي (Blaze).

> ملاحظة أمنية: ملف الأسرار `.dev.vars` **غير مضمّن** في هذا الأرشيف.
