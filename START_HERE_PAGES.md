# اشحنلي — نسخة Cloudflare Pages (بداية جديدة)

اتحوّل المشروع من "Worker" لـ "Pages" (Advanced Mode). نفس الكود بالظبط، بس بشكل مختلف يتوافق مع Pages.

## هيكل المشروع
```
public/            ← كل ملفات الموقع + _worker.js (كود السيرفر كله)
  _worker.js        ← نفس كود src/worker.js القديم (بيتعامل مع كل /api/* والصفحات)
  js/ css/ ...       ← ملفات الموقع الثابتة
_lib/               ← نفس ملفات src/_lib القديمة (بدون تغيير في المنطق)
package.json
```

## خطوات الإعداد من الصفر

### 1. امسح مشروع الـ Worker القديم (اختياري)
Cloudflare Dashboard ← Workers & Pages ← **ishhanli-app** ← Settings ← Danger Zone ← Delete.

### 2. ارفع المشروع على GitHub
ارفع محتويات المجلد ده (public/, _lib/, package.json) في **جذر** الريبو، بنفس الطريقة اللي عملتها قبل كده.

### 3. اعمل مشروع Pages جديد
1. Cloudflare Dashboard ← **Workers & Pages** ← **Create** ← تبويب **Pages** ← **Connect to Git**.
2. اختار نفس الريبو (`ishhanli`)، فرع `main`.
3. إعدادات البناء:
   - **Framework preset:** None
   - **Build command:** (سيبها فاضية)
   - **Build output directory:** `public`
4. اضغط **Save and Deploy**.

### 4. ضيف الـ Secret (زي بالظبط ما عملت في الـ Worker)
1. المشروع الجديد ← **Settings** ← **Environment variables** (أو **Functions** حسب الواجهة).
2. أضف Secret:
   - الاسم: `FIREBASE_SERVICE_ACCOUNT_JSON`
   - القيمة: نفس ملف الـ JSON بتاع Service Account اللي استخدمته قبل كده.
3. تأكد إنه مضاف لبيئة **Production**.
4. احفظ (هيعمل نشرة جديدة تلقائيًا).

### 5. جرّب
افتح رابط المشروع الجديد (هيكون شكله `https://ishhanli-app.pages.dev` أو زي ما تسميه)، وجرب `/api/health`.

## ملاحظات مهمة
- **الرابط هيتغير** من `*.workers.dev` لـ `*.pages.dev`. لازم تضيف الدومين الجديد في:
  Firebase Console ← Authentication ← Settings ← **Authorized domains**.
- **`public/js/config.js`** فيه بالفعل القيم الصح (`projectId: 'ishhanli-509519'`) — مفيش داعي تعدّل فيه.
- **المنطق البرمجي (`_worker.js` + `_lib/`) متطابق تمامًا** مع نسخة الـ Worker القديمة، غير اسم المتغيرات اللي اتغيرت بسبب اختلاف مسار الملفات بس.
- لو ظهرت رسالة `config_error` أو `invalid_token`، اتبع نفس خطوات التشخيص اللي استخدمناها قبل كده (رسائل الخطأ التفصيلية موجودة برضه في الكود الجديد).
