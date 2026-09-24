# اشحنلي: مجاني بالكامل — Cloudflare Pages Functions + Firestore عبر REST API

بدون أي كارت خالص. الباكند رجع Cloudflare (زي الأصل)، وقاعدة البيانات Firestore، والصور base64 جوه Firestore
(مفيش Storage ولا R2 — الاتنين بقوا محتاجين كارت).

## الفرق التقني عن نسخة Cloud Functions
Cloudflare Workers مالوش `firebase-admin`. فبدل SDK جاهز، بنكلم Firestore مباشرة عبر REST API، بمصادقة
حساب خدمة (Service Account) بنوقّعها إحنا بأيدينا باستخدام Web Crypto (المتاحة جوه Workers). كل ده متلخّص في:
- `src/_lib/gcp.js` — بيولّد Google OAuth2 access token من مفتاح حساب الخدمة.
- `src/_lib/firestore.js` — عميل REST خفيف بيقلّد شكل استخدام `firebase-admin/firestore` (نفس
  `where/orderBy/limit`, نفس `runTransaction`, نفس `FieldValue.increment`...) عشان باقي الكود ميتغيّرش.
- `src/_lib/core.js` — تحقق يدوي من Firebase ID Token (بمفاتيح Google العامة JWK).
- `src/worker.js` هو الملف الرئيسي: نفس منطق كل الـ 49 route بالظبط، لكن بشكل **Worker واحد** بيقدّم
  الموقع الثابت (`public/`) وبيرد على `/api/*` مع بعض — ده الشكل الحديث اللي Cloudflare بيوصّي بيه دلوقتي
  ("Workers with Static Assets") بدل نظام "Pages" القديم اللي بقى في وضع صيانة بس.
- `wrangler.jsonc` بيربط الاتنين: `main` بيشاور على `src/worker.js`، و`assets.directory` بيشاور على `public/`.

## خطوات الإعداد

### 1) حساب الخدمة (كنت بتجهزه)
لما تخلص إنشاء الـ Service Account والمفتاح (JSON) من الخطوة اللي فاتت، ارجع لصفحته في Google Cloud Console
وضيفله رول تاني (غير Cloud Datastore User اللي أخدته):
- **Firebase Cloud Messaging API Admin** — عشان يقدر يبعت إشعارات Push.

### 2) مشروع Cloudflare Pages
لو أصلاً عندك مشروع Pages شغال من قبل بنفس الاسم، استخدمه. لو محتاج جديد:
```
npm install -g wrangler
wrangler login
cd (مجلد المشروع)
wrangler pages project create ishhanli
```

### 3) حط مفتاح حساب الخدمة كـ Secret (مش في الكود خالص)
```
wrangler pages secret put FIREBASE_SERVICE_ACCOUNT_JSON --project-name=ishhanli
```
هيطلب منك تلزق محتوى ملف الـ JSON كامل (افتحه بأي محرر نصوص وانسخ كل حاجة جواه) والصقه، Enter.
**متحطش الملف ده في الكود أو GitHub خالص** — هو المفتاح اللي بيفتح قاعدة بياناتك بالكامل.

### 4) انشر
عن طريق ربط Git بـ Cloudflare (Workers Builds) — مفيش أوامر يدوية، كل push هيعمل نشر تلقائي.
أو محليًا لو حابب تجرب: `npm install && npm run deploy` (بيشغّل `wrangler deploy`).

### 5) فحص الربط
افتح `https://<موقعك>/api/health`.

### 6) أول حساب أدمن
زي الأصل بالظبط: سجّل حساب عادي من التطبيق، بعدين من **Firebase Console → Firestore Database → users →
(مستندك)** غيّر يدوياً `role` لـ `"admin"` و `status` لـ `"active"`.

### 7) الفهارس المركّبة (Composite Indexes)
أول مرة كل استعلام هيتنفذ (تسجيل، طلب جديد، ...) ممكن يرجع خطأ فيه **رابط مباشر** لإنشاء الفهرس المطلوب —
افتحه، سيبه يخلص (دقايق)، وجرب تاني. ده طبيعي ومتوقع أول استخدام.

## حدود مهمة تعرفها (نتيجة إننا بدون كارت خالص)
1. **حد الكتابة اليومي المجاني في Firestore: 20 ألف كتابة/يوم** (وربنا كان عندك في D1 100 ألف). كل تحديث
   حالة طلب، كل رسالة شات، كل رفع صورة = كتابة. لحجم اختبار/إطلاق أولي كافي جداً، بس لو الاستخدام زاد
   محتاج تراجع الأرقام (Firebase Console → Firestore → Usage).
2. **الصور محدودة بحجم أصغر شوية** (تقريبًا 650 كيلوبايت بعد فك الترميز) عشان حد مستند Firestore ميتخطاش
   1 ميجا. كافي لصور موبايل مضغوطة عادية.
3. **الـ transactions بتتعمل بمكالمات REST يدوية** (مش SDK جاهز مُختبَر من Google) — المنطق اتبنى بعناية
   وبيتبع نفس قواعد Firestore الرسمية بالظبط، لكن لو واجهتك أي رسالة خطأ غريبة وقت الاختبار (خصوصاً في
   لحظات التزامن زي "سواقين بيقبلوا نفس الطلب في نفس اللحظة")، ابعتلي نص الخطأ بالظبط وهصلحها فورًا.
4. **لو الاستخدام كبر بجد مستقبلاً**: وقتها الانتقال لـ Blaze (نسخة Cloud Functions اللي بنيناها قبل كده)
   هيبقى قرار سهل ومباشر — نفس منطق العمل، بس بنية أثبت وأداء أفضل.

## اختبار محلي
```
npm run dev
```
هيشغّل `wrangler pages dev` — لازم تظبط secret محلي كمان (`.dev.vars` file فيه `FIREBASE_SERVICE_ACCOUNT_JSON=...`).
