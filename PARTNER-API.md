# ربط موقع شريك (متاجر) باشحنلي — دليل المطوّر

الموقع الشريك بيكلّم اشحنلي **من السيرفر بتاعه فقط** (مش من المتصفح، عشان المفتاح ما يتكشفش).

## الإعداد
1. الأدمن يفتح **لوحة الأدمن ← المواقع المربوطة ← إضافة موقع شريك** (اسم + رابط https).
2. المفتاح بيظهر **مرة واحدة** (شكله `<id>.<secret>`). انسخه وخزّنه كمتغير بيئة سري في سيرفر الموقع الشريك (مثلاً `ISHHANLI_PARTNER_KEY`). لو ضاع: «مفتاح جديد» (القديم بيبطل فوراً).
3. كل الطلبات `POST https://ishhanli.pages.dev/api/partner-api/<route>` بالهيدرز:
   `Authorization: Bearer <المفتاح>` و`Content-Type: application/json`. الحد: 120 طلب/دقيقة لكل موقع.

## الخطوات
**1) شركات الشحن المتاحة** — `partner-api/companies` (جسم فاضي `{}`)
→ `{ "companies": [{ "id": "…", "name": "شركة النيل", "paused": false }] }` (`paused: true` = الشركة متوقفة مؤقتاً بسبب رسومها).

**2) التاجر اختار شركة** — `partner-api/link`
```json
{ "merchantRef": "store-77", "merchantName": "متجر الأمل", "companyId": "<id من الخطوة 1>" }
```
→ `{ "id": "…", "status": "pending" }`. الشركة بتتبلّغ وبتوافق/ترفض من حسابها في اشحنلي (صفحة «رسوم الشركة»).

**3) متابعة الموافقة** — `partner-api/link/status` بنفس `merchantRef` و`companyId`
→ `{ "status": "none" | "pending" | "active" | "rejected" | "revoked" }`. اعتبر التاجر «شغّال مع الشركة» لما تكون `active` بس.

**4) طلب من التاجر لشركته** — `partner-api/order` (لازم الربط `active`)
```json
{ "merchantRef": "store-77", "companyId": "…", "externalOrderId": "ORD-1001", "amount": 450, "summary": "شحنة ملابس 3 كراتين" }
```
- `amount`: عدد صحيح بالجنيه (1 → 100,000,000). `externalOrderId` فريد لكل موقع: لو اتبعت مرتين الرد `duplicate: true` ومايتحسبش تاني.
- الرد: `{ "ok": true, "id": "…", "counted": true }` (`counted` = اتضاف على عدّاد رسوم الشركة).
- أخطاء: `not_linked` (403) الربط مش مؤكّد، `company_blocked` (409) الشركة متوقفة لحد ما تسدّد رسومها، `company_not_found` (404)، `bad_input` (400).

**5) إلغاء طلب** — `partner-api/order/cancel` → `{ "externalOrderId": "ORD-1001" }`. بيتشال من عدّادات الشركة.

## مثال (Node)
```js
const r = await fetch('https://ishhanli.pages.dev/api/partner-api/order', {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.ISHHANLI_PARTNER_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ merchantRef: 'store-77', companyId, externalOrderId: 'ORD-1001', amount: 450 }),
});
const out = await r.json(); // out.error لو فشل
```

## ملاحظات
- الطلب هنا **بيتسجّل ويتحسب على الشركة**؛ مفيش تسعير/تتبع داخل اشحنلي لطلبات المتاجر (ده بيتم في الموقع الشريك).
- الأدمن يقدر يوقف الموقع كله أو يقفل «الحساب على الرسوم» له أو يلغي أي رابط من اللوحة.
