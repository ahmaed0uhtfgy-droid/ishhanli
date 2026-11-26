# الاختبارات — دليل التشغيل

| الأمر | بيعمل إيه |
|---|---|
| `npm ci` | تثبيت الأدوات (Node ≥ 22.12) |
| `npm test` | الأساسي: القديمة (legacy) + Vitest + E2E بدون متصفح (بيشتغل في أي مكان) |
| `npm run test:unit` | Vitest فقط (وحدات + تكامل + أمان + فلوس) |
| `npm run test:coverage` | Vitest مع تغطية |
| `npx playwright install chromium` ثم `npm run test:e2e` | E2E كامل بالمتصفح (كروم ديسكتوب + موبايل) |
| `npm run e2e:server` | سيرفر الاختبار المحلي (بيانات وهمية في الذاكرة) على http://127.0.0.1:4173 |
| `npm run test:perf` | سلّم ضغط k6 (محتاج k6 مثبّت وسيرفر الاختبار شغّال) |
| `npm run check:syntax` | فحص صياغة كل ملفات JS |

كل الاختبارات بتشتغل على Firestore وهمي وFirebase Auth بديل، فمفيش أي لمس لبيانات حقيقية.

## لو مش قادر تنزّل متصفح Playwright (شبكة مقفولة)
حدّد متصفح جاهز بمتغيّرات بيئة: `PW_CHROMIUM=/path/to/chromium` و(اختياري) `PW_CHROMIUM_ARGS='["--no-sandbox"]'` ثم `npm run test:e2e`.

## نشر تلقائي (GitHub Actions)
ملف `.github/workflows/ci.yml` بيشغّل كل حاجة مع كل push وPR، وبينشر على Cloudflare Pages بس لو الكل نجح وعلى فرع `main`.
المطلوب مرة واحدة: Settings → Secrets and variables → Actions → New repository secret:
`CLOUDFLARE_API_TOKEN` (صلاحية Cloudflare Pages: Edit) و`CLOUDFLARE_ACCOUNT_ID`.
مهم: لو مشروع Cloudflare Pages مربوط بـGitHub (Git integration)، هو بينشر لوحده من غير ما يستنى الاختبارات.
عشان النشر يبقى فعلاً مشروط بالاختبارات: Cloudflare → المشروع → Settings → Builds → عطّل Automatic deployments.
وفعّل في GitHub: Settings → Branches → Branch protection على main → Require status checks (الـ3 jobs).

## تحذيرات
- نتايج k6 على السيرفر المحلي مش رقم الإنتاج. CPU profile عند 400 مستخدم (تشغيلة واحدة): كود التطبيق (`functions/`) ≈ 5% من وقت المعالج، والباقي معظمه قراءة الملفات الثابتة من القرص في سيرفر الاختبار نفسه + مشاركة نواة واحدة مع k6. يعني التباطؤ اللي بيظهر محلياً غالباً من سيرفر الاختبار مش من التطبيق، ومفيهوش Cloudflare ولا Firestore الحقيقي.
- متشغّلش k6 بأحمال عالية على الموقع الحقيقي (كوتا Firestore المجانية).

شوف `QUOTA.md` لحماية الكوتا وإعداداتها.

## فحص الأداء والـSEO والـaccessibility
- accessibility (axe-core، WCAG 2.1 A+AA، عربي/إنجليزي/ليلي): بيشتغل ضمن `npm run test:e2e` (ملف `test/e2e/a11y.spec.mjs`) وبيفشل لو فيه مشكلة serious/critical.
- Lighthouse (يدوي): شغّل `npm run e2e:server` ثم `npx lighthouse http://127.0.0.1:4173 --view`. السيرفر ده بيشغّل نفس `functions/index.js` للصفحة الرئيسية ويطبّق `_headers` وgzip، فالنتيجة أقرب للإنتاج. أرقام الأداء بتتأثر بسرعة جهازك.
- Dependabot (`.github/dependabot.yml`) بيفتح PR أسبوعي لتحديثات الأمان.

- `test/unit/seo.spec.mjs`: حارس الـSEO (كل الصفحات + الـsitemap). شوف `SEO.md` للدليل الكامل. فحص workerd (`npm run test:workerd`) بيغطي /routes و/sitemap.xml.
