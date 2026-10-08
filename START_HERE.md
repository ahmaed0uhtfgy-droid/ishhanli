# ابدأ من هنا (من المتصفح، من غير ترمنال)

1. **Firebase:** Authentication ← فعّل Email/Password. Firestore Database ← Create database (Production). تبويب Rules ← الصق محتوى `firestore.rules` ← Publish. Project settings ← Service accounts ← Generate new private key (ملف JSON — سر!).
2. **GitHub:** امسح الريبو القديم وارفع محتوى المشروع (الملفات نفسها في الروت).
3. **Cloudflare:** امسح الـ Worker القديم `ishhanli`. Workers & Pages ← Create ← **Pages** ← Connect to Git. Build command **فاضي**، Output directory **`public`**.
4. **سر الخدمة:** Pages project ← Settings ← Variables and Secrets ← Add ← **Secret** ← الاسم `FIREBASE_SERVICE_ACCOUNT` ← الصق محتوى JSON كامل. بعدها Deployments ← Retry deployment.
5. **Firebase:** Authentication ← Settings ← Authorized domains ← أضف `ishhanli.pages.dev`.
6. افتح `https://ishhanli.pages.dev/api/health` ← لازم `"ok": true`.
7. سجّل حساب من الموقع، وبعدين Firestore ← `users` ← مستند الـ UID بتاعك ← `role = admin` و`status = active`.

التفاصيل والـ troubleshooting في `README.md`.
