# الملفات المتغيّرة (38) — كل ملف كامل بمساره

| الملف | الإجراء | أول سطر (للتحقق من اللصق) |
|---|---|---|
| `SEO.md` | استبدال | `# SEO — اللي اتعمل واللي عليك` |
| `functions/_lib/blog.js` | ملف جديد | `// نظام المقالات (SEO): تخزين في Firestore، توليد بالذكاء الاصطناعي (Gemini أو Claude) كمس` |
| `functions/_lib/files.js` | استبدال | `// تخزين الصور في Firestore (مستند لكل صورة: بيانات الوصول + المحتوى base64). الصور بتتضغط` |
| `functions/_lib/landing.js` | استبدال | `// الصفحة الرئيسية من السيرفر: HTML كامل للتصميمين (SEO + محركات الذكاء الاصطناعي بتقرا من` |
| `functions/_lib/logic.js` | استبدال | `import { HttpError } from './core.js';` |
| `functions/_lib/pages.js` | استبدال | `// صفحات المحتوى الثابتة للسيو (كل صفحة بنية بحث مستقلة): /how-it-works و /for-drivers و /` |
| `functions/_lib/secHeaders.js` | استبدال | `// رؤوس الأمان العامة لردود الـFunctions. السبب: ملف public/_headers بيتطبّق على الملفات ا` |
| `functions/api/[[route]].js` | استبدال | `// كل المنطق الحساس (الصلاحيات، السعر، Escrow، العمولة، المحفظة، النزاعات) بيتنفذ هنا على ` |
| `functions/blog/[slug].js` | ملف جديد | `// صفحة مقال: GET /blog/<slug> — HTML كامل من السيرفر (Article JSON-LD + FAQPage + breadcr` |
| `functions/blog/img/[id].js` | ملف جديد | `// صورة مقال عامة: GET /blog/img/<id> — ملفات نوع blog فقط (اللي الأدمن رفعها)` |
| `functions/blog/index.js` | ملف جديد | `// فهرس المدونة: GET /blog — HTML كامل من السيرفر للـSEO (المقالات المنشورة فقط، بكاش قصير` |
| `functions/index.js` | استبدال | `// الصفحة الرئيسية "/" من السيرفر: HTML كامل للتصميم الفعّال (بإعدادات الأدمن) عشان جوجل و` |
| `functions/sitemap.xml.js` | استبدال | `// خريطة الموقع الديناميكية: GET /sitemap.xml — الصفحات الأساسية + كل طرق النقل + (لو الصف` |
| `playwright.config.mjs` | استبدال | `import { defineConfig, devices } from '@playwright/test';` |
| `public/_headers` | استبدال | `/*` |
| `public/css/app.css` | استبدال | `/* اشحنلي — نظام تصميم: أسفلت + أصفر خط الطريق + بوليصة شحن */` |
| `public/css/landing.css` | استبدال | `/* الصفحة الرئيسية — التصميمان (a: فاتح أصلاً، b: ليلي أصلاً) وكل واحد له وضع نهاري وليلي.` |
| `public/index.html` | استبدال | `<!doctype html>` |
| `public/js/api.js` | استبدال | `import { auth } from './firebase.js';` |
| `public/js/app.js` | استبدال | `import { auth, onAuthStateChanged, signOut } from './firebase.js';` |
| `public/js/firebase.js` | استبدال | `// Firebase هنا للدخول (Auth) فقط. كل البيانات على Cloudflare D1 عبر /api/*` |
| `public/js/i18n-admin.js` | استبدال | `// نصوص لوحة الأدمن` |
| `public/js/i18n.js` | استبدال | `import { APP } from './config.js';` |
| `public/js/install.js` | ملف جديد | `// تثبيت الموقع كتطبيق على الموبايل (PWA): زرار «ثبّت التطبيق» في الفوتر + شريط على الموبا` |
| `public/js/pages/admin-blog.js` | ملف جديد | `// لوحة الأدمن: المقالات (SEO). توليد بالذكاء الاصطناعي كمسودات، جدولة تلقائية، تعديل/إضاف` |
| `public/js/pages/admin.js` | استبدال | `import { api, poll } from '../api.js';` |
| `public/js/pages/auth.js` | استبدال | `import { vehicleSelect, wireVehicleSelect } from '../vpicker.js';` |
| `public/js/pages/customer.js` | استبدال | `import { api, poll } from '../api.js';` |
| `public/js/pages/driver-dash.js` | استبدال | `// لوحة بيانات السواق: كل حاجة تخصه في صفحة واحدة (قراءة فقط) — البيانات كلها من driver/da` |
| `public/js/pages/welcome.js` | استبدال | `// كارت ترحيب العميل اللي معندوش طلبات: خطوات + نقاط ثقة حقيقية بس (مفيش أرقام ولا تقييمات` |
| `test/e2e/changes.spec.mjs` | ملف جديد | `// اختبارات المتصفح لتعديلات v0.4: اللوجو ← الرئيسية، التسجيل كشركة شحن، «طلباتي» والترحيب` |
| `test/e2e/fake-firebase/firebase-auth.js` | استبدال | `// بديل اختباري لـ firebase-auth: الحسابات والتوكنات بيتولّدوا من سيرفر الاختبار (test/e2e` |
| `test/unit/blog.spec.mjs` | ملف جديد | `// اختبار نظام المقالات: دوال نقية (سلاج/Markdown آمن/يوتيوب/JSON) + تكامل حقيقي فوق API و` |
| `test/unit/install.spec.mjs` | ملف جديد | `// اختيار طريقة تثبيت التطبيق حسب الجهاز/المتصفح` |
| `test/unit/orders-limit.spec.mjs` | ملف جديد | `// حد قايمة «طلباتي» بيتظبط من الأدمن (الإعدادات) ومحصور بين 20 و300` |
| `test/unit/seo-checklist.spec.mjs` | ملف جديد | `// قايمة الـ20 نقطة SEO: كل نقطة بتتفحص بكود على الصفحات الفعلية (رئيسية + محتوى + طرق + م` |
| `test/unit/seo.spec.mjs` | استبدال | `// اختبار SEO شامل: بيستدعي كل function صفحة فعلياً (من غير شبكة) ويتأكد من العناصر اللي م` |
| `test/welcome.test.mjs` | استبدال | `// كارت ترحيب العميل الجديد: نصوص عربي/إنجليزي، من غير أرقام أو ادعاءات، وبيظهر للي معندوش` |

## يدوي (مش في الـzip)
- ارفع `functions/_lib/routes.js` و`functions/_lib/secHeaders.js` من `missing-files.zip` لو لسه ناقصين. (secHeaders.js اتعدّل: استخدم النسخة اللي في الـzip الرئيسي.)
- احذف `public/llms.txt` من المستودع.
