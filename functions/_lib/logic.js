import { HttpError } from './core.js';
import { F } from './db.js';
import { trustOf, DEFAULT_TRUST } from './trust.js';
import { cleanSite, SITE_DEFAULTS } from '../../public/js/landing-content.js';

// القيم الافتراضية (أرقام تجريبية — الأدمن بيعدّلها من لوحة التحكم ولا تحتاج تعديل كود)
// بيانات الشركة اللي بتظهر في الصفحة الرئيسية العامة (الأدمن يعدّلها من الإعدادات)
export const COMPANY_KEYS = ['name', 'about', 'phone', 'whatsapp', 'email', 'address', 'hours', 'facebook', 'instagram', 'tiktok', 'youtube'];
const COMPANY_DEFAULT = { name: 'اشحنلي', about: '', phone: '', whatsapp: '', email: '', address: '', hours: '', facebook: '', instagram: '', tiktok: '', youtube: '' };
export const DEFAULTS = {
  company: COMPANY_DEFAULT,
  site: SITE_DEFAULTS,     // واجهة الصفحة الرئيسية: التصميم الفعّال والوضع الافتراضي والنصوص والأقسام (الأدمن)
  perKm: 10,               // جنيه لكل كيلومتر
  minPrice: 150,           // حد أدنى للسعر
  commissionPct: 12,       // عمولة الموقع %
  roadFactor: 1.3,         // معامل تقريب المسافة لو خدمة الطرق مش متاحة
  geofenceMeters: 300,     // أقصى بُعد للسواق عن نقطة الاستلام/التسليم عند تغيير الحالة (0 = تعطيل)
  maxCancellations: 5,     // تجميد الحساب تلقائياً بعد الوصول للعدد ده
  valueGuardOn: false,     // حراسة القيمة (مقفولة افتراضياً): الشحنة اللي قيمتها المعلنة >= valueGuardFrom بتبقى «عالية»: كود تسليم إجباري + مفيش تحرير تلقائي (مفيش قيد على السواقين)
  valueGuardFrom: 20000,   // حد القيمة المعلنة بالجنيه
  latePointsLimit: 5,      // عدد نقاط التأخير اللي بعده السواق يظهر للأدمن للمراجعة (حظر أو مسح) — 0 = تعطيل. مفيش تجميد تلقائي ولا تأثير على الثقة/العمولة
  minWithdraw: 100,        // أقل مبلغ سحب
  testPayments: true, // وضع الدفع التجريبي: العميل يقدر يتخطى الدفع الحقيقي (للتجربة). الأدمن يقفله من الإعدادات قبل الإطلاق.
  autoApproveCustomers: true, // العميل بيتفعّل تلقائياً (الأدمن يقدر يقفلها من الإعدادات)؛ السواق دايماً مراجعة يدوية
  // إلغاء العميل بعد قبول سواق على طلب مدفوع: نسبة تعويض للسواق + نسبة للمنصة، والباقي يرجع للعميل (% من سعر الطلب)
  cancelPaidDriverPct: 10, cancelPaidPlatformPct: 5,          // السواق قبل ولسه ما بدأش الطريق
  cancelHeadingDriverPct: 30, cancelHeadingPlatformPct: 10,   // السواق في الطريق للاستلام
  prepaidGraceMin: 30,     // طلب مدفوع مقدماً ماحدش قبله: بيتلغي ويتسجّل استرجاع تلقائي بعد ميعاده بالمدة دي (دقايق)
  offersEnabled: true,     // السواق يقدر يقترح سعر مختلف والعميل يقبل/يرفض
  mismatchCompensation: 0,   // تعويض السواق (جنيه) لو راح يستلم ولقى الشحنة مش زي وصف العميل ورفض يستلمها؛ الباقي بيترد للعميل (0 = من غير تعويض)
  mismatchMaxPer30d: 3,      // أقصى عدد بلاغات «مش زي الوصف» للسواق في 30 يوم (حماية من إساءة الاستخدام)
  maxActiveJobs: 1,          // أقصى عدد طلبات شغّالة في نفس الوقت للسواق الفرد (الشركات: سواق واحد من الأسطول لكل طلب)
  startCode: false,          // كود بداية الرحلة: العميل بيدّيه للسواق وقت التحميل (بيحتاج DELIVERY_CODE_SECRET)
  avgSpeedKmh: 40,           // متوسط سرعة لتقدير مدة الرحلة
  deliveryBufferMin: 60,     // وقت إضافي على مدة الرحلة قبل ما الطلب يتعلّم «متأخر»
  stallMinutes: 30,          // لو السواق واقف بعد الاستلام المدة دي ننبّه العميل (0 = مقفول)
  deliveryCode: false,     // كود تسليم: العميل بيدّي كود للمستلم والسواق يدخله عند التسليم (بيحتاج سر DELIVERY_CODE_SECRET في Cloudflare)
  autoReleaseHours: 0,     // تحرير الفلوس تلقائياً للسواق بعد التسليم بالساعات لو العميل ما أكّدش ولا فتح نزاع (0 = مقفول)
  offerMinPct: 70,         // أقل عرض = % من السعر المقترح (وما ينزلش عن الحد الأدنى للسعر)
  offerMaxPct: 200,        // أعلى عرض = % من السعر المقترح
  dispatchRadiusKm: 25,    // نطاق إشعار السواقين المتاحين حول نقطة الاستلام
  dispatchMaxDrivers: 10,  // أقصى عدد سواقين بيوصلهم إشعار الطلب الجديد (الأقرب أولاً)
  newDriver: { orders: 10, commissionPct: 5 }, // عمولة مخفضة لأول N طلب للسواق الجديد
  instapay: { handle: 'yourname@instapay', name: 'اسم صاحب الحساب' },
  categories: {
    furniture:   { ar: 'أثاث',              en: 'Furniture',          mult: 1.3 },
    electronics: { ar: 'أجهزة إلكترونية',   en: 'Electronics',        mult: 1.2 },
    goods:       { ar: 'بضاعة تجارية',      en: 'Commercial goods',   mult: 1.0 },
    building:    { ar: 'مواد بناء',         en: 'Building materials', mult: 1.5 },
    food:        { ar: 'مواد غذائية',       en: 'Food items',         mult: 1.1 },
    parcel:      { ar: 'طرود وتوصيل للمنازل', en: 'Parcels & home delivery', mult: 1.0 },
    other:       { ar: 'أخرى',              en: 'Other',              mult: 1.0 },
  },
  // نقل أفراد/مجموعات (حجز عربية بالكامل): مقفول افتراضياً — نقل الركاب ليه تراخيص وتنظيمات مختلفة، الأدمن هو اللي يفعّله
  passengersEnabled: false,
  passengerClasses: {
    car:      { ar: 'سيارة (حتى 4 ركاب)',      en: 'Car (up to 4)',          mult: 1.0, seats: 4 },
    van:      { ar: 'فان (حتى 7 ركاب)',        en: 'Van (up to 7)',          mult: 1.3, seats: 7 },
    microbus: { ar: 'ميكروباص (حتى 14 راكب)',  en: 'Minibus (up to 14)',     mult: 1.8, seats: 14 },
    minibus:  { ar: 'ميني باص (حتى 28 راكب)',  en: 'Midi bus (up to 28)',    mult: 2.6, seats: 28 },
  },
  trustRules: DEFAULT_TRUST,                              // شروط مستوى الثقة بالنجوم: متوسط النجوم + أقل عدد تقييمات لكل مستوى
  levelDiscountPct: { trusted: 1, pro: 2, elite: 3 },   // خصم من عمولة الموقع (نقاط مئوية) حسب مستوى ثقة السواق
  sizes: {
    small:  { ar: 'صغير (ربع نقل / سيارة)', en: 'Small (pickup / car)',  mult: 1.0 },
    medium: { ar: 'متوسط (نص نقل)',          en: 'Medium (half-ton)',     mult: 1.4 },
    large:  { ar: 'كبير (نقل ثقيل)',         en: 'Large (heavy truck)',   mult: 2.0 },
    xlarge: { ar: 'جامبو (حمولة كبيرة جداً)', en: 'Jumbo (extra large load)', mult: 3.0 },
  },
  // الدفع عند الاستلام (COD): مخفي ومقفول افتراضياً. العمولة صفر في الأول، وبعدها نسبة من إجمالي المبالغ المحصّلة في فترة محاسبة. السواق اللي ما يسدّدش حسابه بعد المهلة بيتوقف تلقائياً لحد ما الأدمن يأكد السداد.
  codEnabled: false, codCommissionPct: 0, codPeriodDays: 7, codGraceDays: 3, codMaxAmount: 5000,
  codBlockScope: 'cod',    // 'cod' = السواق المتأخر ما ياخدش طلبات دفع عند الاستلام جديدة بس · 'all' = ما ياخدش أي طلبات
  // نظام الدفع المباشر + عمولة المنصة (مقفول افتراضياً = نظام الضمان القديم زي ما هو). لما الأدمن يفعّله: العميل بيدفع للسواق مباشرة، والمنصة بتسجّل كل شحنة ناجحة،
  // ولما إجمالي مكسب السواق (غير المسدَّد) يوصل للحد بيتوقف عن قبول طلبات جديدة لحد ما يسدّد نسبة المنصة (محفظة/إنستا باي + صورة التحويل + تأكيد الأدمن). نسبة 0 = من غير عمولة.
  dcEnabled: false, dcPct: 2, dcLimit: 1000, dcPay: { wallet: '', walletName: '' },
  // تسعير مستقل لكل نوع عربية (ربع نقل / نص نقل / نقل / جامبو): سعر فتح + سعر الكيلو + حد أدنى (0 = نستخدم المعادلة العامة: سعر الكيلو العام × معامل الحجم).
  // kmFee = رسوم المنصة على كل كيلومتر من مشاوير العربية دي (0 = نستخدم dcPerKm العام).
  vehiclePricing: Object.fromEntries(['pickup', 'half_ton', 'truck', 'jumbo'].map((k) => [k, { base: 0, perKm: 0, minPrice: 0, kmFee: 0 }])),
  dcPerKm: 0,                // رسوم المنصة على كل كيلومتر مكتمل (جنيه/كم) بجانب النسبة — 0 = مقفولة
  fineCreditToWallet: false, // تعويض المنصة للسواق يتحوّل لرصيد محفظة قابل للسحب بدل خصم من العمولة (مفيد لو العمولة 0)
  dcAutoCompleteHours: 24, // الدفع المباشر: الطلب اللي السواق استلمه وفضل مفتوح المدة دي من غير تأكيد تسليم بيتكمّل تلقائي (0 = مقفول)
  // ---- تعويض السواق وغرامة العميل (الدفع المباشر) — كل الأرقام والمدد من الأدمن، والميزة مقفولة افتراضياً ----
  finesEnabled: false,
  fineFreeCancelMin: 2,     // دقائق بعد قبول السواق يقدر العميل يلغي فيها من غير غرامة
  fineWaitMin: 10,          // مهلة انتظار السواق بعد وصوله قبل ما يقدر يبلّغ «العميل مش موجود»
  fineEnRouteAmount: 15,    // غرامة إلغاء العميل والسواق في الطريق (جنيه)
  fineArrivedAmount: 30,    // غرامة عدم الحضور / الإلغاء بعد وصول السواق (جنيه)
  fineClaimHours: 12,       // مهلة التسوية المباشرة بين السواق والعميل قبل ما المنصة تطبّق الإعفاء والغرامة
  fineObjectHours: 24,      // مهلة اعتراض العميل بعد تطبيق الغرامة (0 = من غير اعتراض)
  fineDriverSharePct: 50,   // تعويض المنصة للسواق كنسبة من الغرامة — دايماً أقل من اللي ممكن ياخده من العميل مباشرة
  fineCollectorPct: 0,      // نسبة من الغرامة المحصّلة يحتفظ بيها السواق اللي حصّلها (الباقي بيتحوّل للمنصة)
  fineMonthlyCap: 100,      // أقصى إعفاء من عمولة المنصة للسواق الواحد خلال 30 يوم (0 = من غير سقف)
  fineMaxClaimsPerDay: 5,   // أقصى مطالبات للسواق في 24 ساعة (0 = من غير حد)
  fineBlockLimit: 0,        // غرامات العميل لو وصلت الحد ده ما يطلبش لحد ما تتسوّى (0 = من غير منع)
  samePickupMeters: 300,    // نطاق «نفس نقطة الاستلام» لطلبات نفس العميل
  samePickupMax: 1,         // أقصى طلبات شغّالة (قبل الاستلام) من نفس العميل في نفس النقطة (0 = من غير حد)
  jobsRadiusKm: 15,        // السواق بيشوف الطلبات اللي نقطة استلامها في الدايرة دي من موقعه (0 = من غير حد)
  companionAsk: true,      // سؤال العميل في الطلب: هترافق الشحنة ولا لأ؟ (الأدمن يقفله)
  vehicleGuideOn: true,    // ترشيح العربية المناسبة (اختياري للعميل) حسب وزن الشحنة
  vehicleGuide: {          // لكل عربية: أقصى وزن بالكجم (0 = متوقفة) والحجم المرتبط بيها (بيحدد السعر). مرتّبة من الأصغر للأكبر
    pickup:   { maxKg: 800,   size: 'small' },
    half_ton: { maxKg: 2000,  size: 'medium' },
    truck:    { maxKg: 8000,  size: 'large' },
    jumbo:    { maxKg: 50000, size: 'xlarge' },
  },
  // تعديل بيانات الحساب: مرة كل N يوم — الأدمن بيقلّلها/يزوّدها أو يعطّلها، ويقدر يفتح القفل لمستخدم معيّن
  profileEditEnabled: true,
  profileEditCooldownDays: 15,
  // صفحات السواقين العامة (SEO): مقفولة افتراضياً — الأدمن هو اللي يفعّلها. الصفحات بتعرض بيانات آمنة بس (بدون موبايل).
  publicProfiles: false,
  // الإحالة والحوافز: مقفولة افتراضياً. الأدمن يحدد المكافأة للمُحيل وللمُحال (جنيه)، وبتتصرف مرة واحدة عند أول طلب مكتمل للمُحال.
  referralEnabled: false,
  referralBonusReferrer: 0,
  referralBonusReferred: 0,
};

const num = (v, d, min = 0, max = 1e9) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.min(max, Math.max(min, Number(v))) : d);

// الإعدادات بتتقرا في كل طلب تقريباً، فبنخزنها في ذاكرة الـ isolate لمدة قصيرة لتوفير قراءات Firestore (الكوتا المجانية 50 ألف قراءة/يوم).
// بتتحدّث فوراً في نفس الـ isolate لما الأدمن يحفظ (clearSettingsCache)، وفي الباقي خلال SETTINGS_TTL_MS (افتراضي 15 ثانية).
let settingsCache = { v: null, exp: 0 };
export const clearSettingsCache = () => { settingsCache = { v: null, exp: 0 }; };
export async function loadSettings(env) {
  const ttl = Number(env.SETTINGS_TTL_MS ?? 15000);
  let row;
  if (ttl > 0 && settingsCache.v !== null && Date.now() < settingsCache.exp) row = settingsCache.v || null;
  else { row = await F.get(env, 'settings/pricing'); if (ttl > 0) settingsCache = { v: row || false, exp: Date.now() + ttl }; }
  let d = {}; try { d = row ? JSON.parse(row.v) : {}; } catch { /* إعدادات تالفة => الافتراضي */ }
  const D = DEFAULTS;
  return {
    perKm: num(d.perKm, D.perKm), minPrice: num(d.minPrice, D.minPrice),
    commissionPct: num(d.commissionPct, D.commissionPct, 0, 100), roadFactor: num(d.roadFactor, D.roadFactor, 1, 3),
    geofenceMeters: num(d.geofenceMeters, D.geofenceMeters, 0, 100000),
    maxCancellations: num(d.maxCancellations, D.maxCancellations, 1, 1000),
    latePointsLimit: Math.floor(num(d.latePointsLimit, D.latePointsLimit, 0, 1000)),
    valueGuardOn: d.valueGuardOn === true, valueGuardFrom: Math.floor(num(d.valueGuardFrom, D.valueGuardFrom, 1, 1e9)),
    minWithdraw: num(d.minWithdraw, D.minWithdraw, 1),
    testPayments: typeof d.testPayments === 'boolean' ? d.testPayments : D.testPayments,
    autoApproveCustomers: typeof d.autoApproveCustomers === 'boolean' ? d.autoApproveCustomers : D.autoApproveCustomers,
    prepaidGraceMin: Math.floor(num(d.prepaidGraceMin, D.prepaidGraceMin, 0, 1440)),
    ...(() => { // نسب الإلغاء: كل مرحلة مجموعها لا يتعدى 100%
      const pair = (dk, pk) => { const dp = num(d[dk], D[dk], 0, 100); return [dp, Math.min(num(d[pk], D[pk], 0, 100), 100 - dp)]; };
      const [pd, pp] = pair('cancelPaidDriverPct', 'cancelPaidPlatformPct'), [hd, hp] = pair('cancelHeadingDriverPct', 'cancelHeadingPlatformPct');
      return { cancelPaidDriverPct: pd, cancelPaidPlatformPct: pp, cancelHeadingDriverPct: hd, cancelHeadingPlatformPct: hp };
    })(),
    mismatchCompensation: Math.floor(num(d.mismatchCompensation, D.mismatchCompensation, 0, 100000)), mismatchMaxPer30d: Math.floor(num(d.mismatchMaxPer30d, D.mismatchMaxPer30d, 1, 100)),
    maxActiveJobs: Math.floor(num(d.maxActiveJobs, D.maxActiveJobs, 1, 50)), startCode: d.startCode === true, avgSpeedKmh: num(d.avgSpeedKmh, D.avgSpeedKmh, 10, 120),
    deliveryBufferMin: Math.floor(num(d.deliveryBufferMin, D.deliveryBufferMin, 0, 1440)), stallMinutes: Math.floor(num(d.stallMinutes, D.stallMinutes, 0, 720)),
    deliveryCode: d.deliveryCode === true, autoReleaseHours: Math.floor(num(d.autoReleaseHours, D.autoReleaseHours, 0, 720)),
    offersEnabled: d.offersEnabled !== false, offerMinPct: num(d.offerMinPct, D.offerMinPct, 10, 100), offerMaxPct: num(d.offerMaxPct, D.offerMaxPct, 100, 1000),
    dispatchRadiusKm: num(d.dispatchRadiusKm, D.dispatchRadiusKm, 1, 500), dispatchMaxDrivers: Math.floor(num(d.dispatchMaxDrivers, D.dispatchMaxDrivers, 1, 20)),
    newDriver: { orders: num(d.newDriver?.orders, D.newDriver.orders, 0, 1000), commissionPct: num(d.newDriver?.commissionPct, D.newDriver.commissionPct, 0, 100) },
    instapay: { handle: d.instapay?.handle || D.instapay.handle, name: d.instapay?.name || D.instapay.name },
    company: Object.fromEntries(COMPANY_KEYS.map((k) => [k, typeof d.company?.[k] === 'string' ? d.company[k] : COMPANY_DEFAULT[k]])),
    categories: d.categories && Object.keys(d.categories).length ? d.categories : D.categories,
    sizes: (() => { const z = d.sizes && Object.keys(d.sizes).length ? d.sizes : D.sizes; return z.xlarge ? z : { ...z, xlarge: D.sizes.xlarge }; })(), // الجامبو حجم أساسي: لو مش متخزّن بيتضاف تلقائياً
    codEnabled: d.codEnabled === true, codCommissionPct: Math.round(num(d.codCommissionPct, D.codCommissionPct, 0, 30) * 10) / 10,
    codPeriodDays: Math.floor(num(d.codPeriodDays, D.codPeriodDays, 1, 31)), codGraceDays: Math.floor(num(d.codGraceDays, D.codGraceDays, 0, 30)),
    codMaxAmount: Math.floor(num(d.codMaxAmount, D.codMaxAmount, 100, 1000000)), codBlockScope: d.codBlockScope === 'all' ? 'all' : 'cod',
    dcEnabled: d.dcEnabled === true, dcPct: Math.round(num(d.dcPct, D.dcPct, 0, 50) * 10) / 10, dcLimit: Math.floor(num(d.dcLimit, D.dcLimit, 1, 1e8)),
    finesEnabled: d.finesEnabled === true, fineFreeCancelMin: Math.floor(num(d.fineFreeCancelMin, D.fineFreeCancelMin, 0, 1440)), fineWaitMin: Math.floor(num(d.fineWaitMin, D.fineWaitMin, 0, 1440)),
    fineEnRouteAmount: Math.floor(num(d.fineEnRouteAmount, D.fineEnRouteAmount, 0, 100000)), fineArrivedAmount: Math.floor(num(d.fineArrivedAmount, D.fineArrivedAmount, 0, 100000)),
    fineClaimHours: Math.floor(num(d.fineClaimHours, D.fineClaimHours, 0, 720)), fineObjectHours: Math.floor(num(d.fineObjectHours, D.fineObjectHours, 0, 720)),
    fineDriverSharePct: num(d.fineDriverSharePct, D.fineDriverSharePct, 0, 99), fineCollectorPct: num(d.fineCollectorPct, D.fineCollectorPct, 0, 50),
    fineMonthlyCap: Math.floor(num(d.fineMonthlyCap, D.fineMonthlyCap, 0, 1e6)), fineMaxClaimsPerDay: Math.floor(num(d.fineMaxClaimsPerDay, D.fineMaxClaimsPerDay, 0, 1000)), fineBlockLimit: Math.floor(num(d.fineBlockLimit, D.fineBlockLimit, 0, 1e6)),
    samePickupMeters: Math.floor(num(d.samePickupMeters, D.samePickupMeters, 0, 5000)), samePickupMax: Math.floor(num(d.samePickupMax, D.samePickupMax, 0, 50)),
    vehiclePricing: Object.fromEntries(PRICE_VEHICLES.map((k) => { const v = d.vehiclePricing?.[k] || {}; return [k, { base: num(v.base, 0, 0, 1e6), perKm: num(v.perKm, 0, 0, 10000), minPrice: num(v.minPrice, 0, 0, 1e6), kmFee: num(v.kmFee, 0, 0, 10000) }]; })),
    dcPerKm: num(d.dcPerKm, 0, 0, 10000), fineCreditToWallet: d.fineCreditToWallet === true,
    dcAutoCompleteHours: Math.floor(num(d.dcAutoCompleteHours, D.dcAutoCompleteHours, 0, 720)), jobsRadiusKm: Math.round(num(d.jobsRadiusKm, D.jobsRadiusKm, 0, 500) * 10) / 10,
    dcPay: { wallet: typeof d.dcPay?.wallet === 'string' ? d.dcPay.wallet.slice(0, 40) : '', walletName: typeof d.dcPay?.walletName === 'string' ? d.dcPay.walletName.slice(0, 80) : '' },
    companionAsk: d.companionAsk !== false, vehicleGuideOn: d.vehicleGuideOn !== false,
    vehicleGuide: Object.fromEntries(VEHICLE_KEYS.map((k) => [k, { maxKg: Math.floor(num(d.vehicleGuide?.[k]?.maxKg, D.vehicleGuide[k].maxKg, 0, 100000)), size: typeof d.vehicleGuide?.[k]?.size === 'string' ? d.vehicleGuide[k].size : D.vehicleGuide[k].size }])),
    passengersEnabled: d.passengersEnabled === true,
    passengerClasses: d.passengerClasses && Object.keys(d.passengerClasses).length ? d.passengerClasses : D.passengerClasses,
    trustRules: Object.fromEntries(['trusted', 'pro', 'elite'].map((k) => [k, { avg: num(d.trustRules?.[k]?.avg, D.trustRules[k].avg, 1, 5), ratings: Math.floor(num(d.trustRules?.[k]?.ratings, D.trustRules[k].ratings, 1, 100000)) }])),
    levelDiscountPct: { trusted: num(d.levelDiscountPct?.trusted, D.levelDiscountPct.trusted, 0, 50), pro: num(d.levelDiscountPct?.pro, D.levelDiscountPct.pro, 0, 50), elite: num(d.levelDiscountPct?.elite, D.levelDiscountPct.elite, 0, 50) },
    profileEditEnabled: d.profileEditEnabled !== false,
    profileEditCooldownDays: Math.floor(num(d.profileEditCooldownDays, D.profileEditCooldownDays, 0, 365)),
    publicProfiles: d.publicProfiles === true,
    referralEnabled: d.referralEnabled === true,
    referralBonusReferrer: num(d.referralBonusReferrer, D.referralBonusReferrer, 0, 1e6),
    referralBonusReferred: num(d.referralBonusReferred, D.referralBonusReferred, 0, 1e6),
    site: cleanSite(d.site),
  };
}

export function haversineM(a, b) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** المسافة بالكيلومتر: OSRM (مجاني) وبديله الخط المستقيم × roadFactor */
export async function distanceKm(a, b, settings) {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`, { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    if (j.code === 'Ok' && j.routes?.[0]?.distance > 0) return { km: Math.round(j.routes[0].distance / 100) / 10, source: 'osrm' };
  } catch { /* fallback below */ }
  return { km: Math.round((haversineM(a, b) * settings.roadFactor) / 100) / 10, source: 'estimate' };
}

/** السعر = (سعر الكم × المسافة) × معامل الفئة × معامل الحجم — مع حد أدنى ثابت، ومقرّب لأعلى جنيه */
/** أنواع العربيات اللي ليها تسعير مستقل (نفس مفاتيح دليل العربيات) */
export const PRICE_VEHICLES = ['pickup', 'half_ton', 'truck', 'jumbo'];
/** العربية المرتبطة بحجم معيّن في دليل العربيات (أول واحدة مفعّلة حجمها كده) */
export const vehicleOfSize = (s, size) => PRICE_VEHICLES.find((k) => s.vehicleGuide?.[k]?.maxKg > 0 && s.vehicleGuide[k].size === size) || null;
/** السعر: لو للعربية تسعير خاص (سعر كيلو > 0): (سعر الفتح + سعر الكيلو × المسافة) × معامل نوع الشحنة، وبحد أدنى العربية. وإلا المعادلة العامة (سعر الكيلو العام × معامل النوع × معامل الحجم). */
export function calcPrice(s, km, category, size, vehicle = null) {
  const c = s.categories[category], z = s.sizes[size];
  if (!c || !z) throw new HttpError(400, 'bad_category');
  const vk = vehicle || vehicleOfSize(s, size), vp = vk ? s.vehiclePricing?.[vk] : null;
  if (vp && Number(vp.perKm) > 0) {
    const raw = (Number(vp.base || 0) + Number(vp.perKm) * km) * Number(c.mult), min = Number(vp.minPrice) > 0 ? Number(vp.minPrice) : s.minPrice;
    return { price: Math.max(Math.ceil(min), Math.ceil(raw)), raw: Math.round(raw), catMult: Number(c.mult), sizeMult: Number(z.mult), vehicle: vk };
  }
  const raw = s.perKm * km * Number(c.mult) * Number(z.mult);
  return { price: Math.max(Math.ceil(s.minPrice), Math.ceil(raw)), raw: Math.round(raw), catMult: Number(c.mult), sizeMult: Number(z.mult) };
}

/** نظام الدفع المباشر: عمولة المنصة المستحقة على إجمالي مكسب السواق (جنيه صحيح، مقرّبة) */
export const dcDue = (gross, pct) => Math.max(0, Math.round((Math.max(0, Number(gross) || 0) * (Number(pct) || 0)) / 100));
/** تعويض المنصة للسواق = نسبة من الغرامة (أقل من الغرامة دايماً عشان السواق يفضّل يحصّلها من العميل مباشرة) */
export const fineCredit = (amount, pct) => Math.max(0, Math.floor(((Number(amount) || 0) * Math.min(99, Math.max(0, Number(pct) || 0))) / 100)); // floor: التعويض أقل من الغرامة دايماً
/** المبلغ المطلوب من السواق للمنصة = العمولة المستحقة − رصيد التعويض (بحد أقصى العمولة) + الغرامات اللي حصّلها ولسه ما حوّلهاش */
export const dcPayable = (gross, pct, credit, held, kmFee = 0) => {
  const commission = dcDue(gross, pct) + Math.max(0, Math.round(Number(kmFee) || 0)), creditUsed = Math.min(commission, Math.max(0, Math.floor(Number(credit) || 0))), fines = Math.max(0, Math.floor(Number(held) || 0));
  return { commission, creditUsed, fines, amount: commission - creditUsed + fines };
};
/** السواق بيتوقف لما إجمالي مكسبه غير المسدَّد يوصل للحد أو يعدّيه (الحد نفسه = متوقف). النظام مقفول أو النسبة 0 = مفيش توقيف. */
/** فيه رسوم للمنصة على السواقين أصلاً؟ (نسبة أو رسوم كيلومتر عامة أو لأي عربية) */
export const dcFeesOn = (s) => s.dcEnabled === true && (s.dcPct > 0 || s.dcPerKm > 0 || PRICE_VEHICLES.some((k) => s.vehiclePricing?.[k]?.kmFee > 0));
/** رسوم المنصة على كيلومترات مشوار: كيلومتر × سعر الكيلو للعربية (أو العام)، بجنيه صحيح */
export const kmFeeOf = (s, km, vehicle) => { const vp = vehicle ? s.vehiclePricing?.[vehicle] : null, rate = vp?.kmFee > 0 ? vp.kmFee : s.dcPerKm || 0; return Math.max(0, Math.round((Number(km) || 0) * rate)); };
export const dcBlocked = (gross, s) => dcFeesOn(s) && (Number(gross) || 0) >= s.dcLimit;

/** توزيع المبلغ: عمولة الموقع (مقرّبة لجنيه) والباقي للسواق — أرقام صحيحة دايماً */
export function split(amount, pct) {
  const commission = Math.round((amount * pct) / 100);
  return { commission, net: amount - commission };
}

/** تنظيف وفحص الإعدادات القادمة من لوحة الأدمن (الفحص على السيرفر مش الواجهة بس) */
export function sanitizeSettings(b) {
  const bad = () => new HttpError(400, 'bad_input');
  const n = (v, min, max) => { const x = Number(v); if (!Number.isFinite(x) || x < min || x > max) throw bad(); return x; };
  const table = (t, seats = false) => {
    if (!t || typeof t !== 'object') throw bad();
    const out = {};
    for (const [k, v] of Object.entries(t)) {
      if (!/^[a-z0-9_]{2,20}$/.test(k) || !v) throw bad();
      out[k] = { ar: String(v.ar || k).slice(0, 60), en: String(v.en || k).slice(0, 60), mult: n(v.mult, 0.1, 50) };
      if (seats) out[k].seats = Math.floor(n(v.seats, 1, 100));
    }
    if (!Object.keys(out).length || Object.keys(out).length > 30) throw bad();
    return out;
  };
  return {
    perKm: n(b.perKm, 0, 10000), minPrice: n(b.minPrice, 0, 1e6), commissionPct: n(b.commissionPct, 0, 100), roadFactor: n(b.roadFactor, 1, 3),
    geofenceMeters: n(b.geofenceMeters, 0, 100000), maxCancellations: Math.floor(n(b.maxCancellations, 1, 1000)), latePointsLimit: Math.floor(n(b.latePointsLimit ?? 5, 0, 1000)), valueGuardOn: b.valueGuardOn === true, valueGuardFrom: Math.floor(n(b.valueGuardFrom ?? 20000, 1, 1e9)), minWithdraw: Math.floor(n(b.minWithdraw, 1, 1e7)),
    testPayments: b.testPayments === true,
    autoApproveCustomers: b.autoApproveCustomers === true,
    prepaidGraceMin: Math.floor(n(b.prepaidGraceMin ?? 30, 0, 1440)),
    ...(() => {
      const one = (dk, pk, dd, pd) => { const dp = n(b[dk] ?? dd, 0, 100), pp = n(b[pk] ?? pd, 0, 100); if (dp + pp > 100) throw bad(); return { [dk]: dp, [pk]: pp }; };
      return { ...one('cancelPaidDriverPct', 'cancelPaidPlatformPct', 10, 5), ...one('cancelHeadingDriverPct', 'cancelHeadingPlatformPct', 30, 10) };
    })(),
    mismatchCompensation: Math.floor(n(b.mismatchCompensation ?? 0, 0, 100000)), mismatchMaxPer30d: Math.floor(n(b.mismatchMaxPer30d ?? 3, 1, 100)),
    maxActiveJobs: Math.floor(n(b.maxActiveJobs ?? 1, 1, 50)), startCode: b.startCode === true, avgSpeedKmh: n(b.avgSpeedKmh ?? 40, 10, 120),
    deliveryBufferMin: Math.floor(n(b.deliveryBufferMin ?? 60, 0, 1440)), stallMinutes: Math.floor(n(b.stallMinutes ?? 30, 0, 720)),
    deliveryCode: b.deliveryCode === true, autoReleaseHours: Math.floor(n(b.autoReleaseHours ?? 0, 0, 720)),
    offersEnabled: b.offersEnabled !== false, offerMinPct: n(b.offerMinPct, 10, 100), offerMaxPct: n(b.offerMaxPct, 100, 1000),
    dispatchRadiusKm: n(b.dispatchRadiusKm, 1, 500), dispatchMaxDrivers: Math.floor(n(b.dispatchMaxDrivers, 1, 20)),
    newDriver: { orders: Math.floor(n(b.newDriver?.orders, 0, 1000)), commissionPct: n(b.newDriver?.commissionPct, 0, 100) },
    instapay: { handle: String(b.instapay?.handle || '').slice(0, 80), name: String(b.instapay?.name || '').slice(0, 80) },
    company: Object.fromEntries(COMPANY_KEYS.map((k) => [k, String(b.company?.[k] ?? COMPANY_DEFAULT[k]).trim().slice(0, k === 'about' ? 800 : 160)])),
    categories: table(b.categories), sizes: table(b.sizes),
    codEnabled: b.codEnabled === true, codCommissionPct: Math.round(n(b.codCommissionPct ?? DEFAULTS.codCommissionPct, 0, 30) * 10) / 10,
    codPeriodDays: Math.floor(n(b.codPeriodDays ?? DEFAULTS.codPeriodDays, 1, 31)), codGraceDays: Math.floor(n(b.codGraceDays ?? DEFAULTS.codGraceDays, 0, 30)),
    codMaxAmount: Math.floor(n(b.codMaxAmount ?? DEFAULTS.codMaxAmount, 100, 1000000)), codBlockScope: b.codBlockScope === 'all' ? 'all' : 'cod',
    dcEnabled: b.dcEnabled === true, dcPct: Math.round(n(b.dcPct ?? DEFAULTS.dcPct, 0, 50) * 10) / 10, dcLimit: Math.floor(n(b.dcLimit ?? DEFAULTS.dcLimit, 1, 1e8)),
    finesEnabled: b.finesEnabled === true, fineFreeCancelMin: Math.floor(n(b.fineFreeCancelMin ?? DEFAULTS.fineFreeCancelMin, 0, 1440)), fineWaitMin: Math.floor(n(b.fineWaitMin ?? DEFAULTS.fineWaitMin, 0, 1440)),
    fineEnRouteAmount: Math.floor(n(b.fineEnRouteAmount ?? DEFAULTS.fineEnRouteAmount, 0, 100000)), fineArrivedAmount: Math.floor(n(b.fineArrivedAmount ?? DEFAULTS.fineArrivedAmount, 0, 100000)),
    fineClaimHours: Math.floor(n(b.fineClaimHours ?? DEFAULTS.fineClaimHours, 0, 720)), fineObjectHours: Math.floor(n(b.fineObjectHours ?? DEFAULTS.fineObjectHours, 0, 720)),
    fineDriverSharePct: n(b.fineDriverSharePct ?? DEFAULTS.fineDriverSharePct, 0, 99), fineCollectorPct: n(b.fineCollectorPct ?? DEFAULTS.fineCollectorPct, 0, 50),
    fineMonthlyCap: Math.floor(n(b.fineMonthlyCap ?? DEFAULTS.fineMonthlyCap, 0, 1e6)), fineMaxClaimsPerDay: Math.floor(n(b.fineMaxClaimsPerDay ?? DEFAULTS.fineMaxClaimsPerDay, 0, 1000)), fineBlockLimit: Math.floor(n(b.fineBlockLimit ?? DEFAULTS.fineBlockLimit, 0, 1e6)),
    samePickupMeters: Math.floor(n(b.samePickupMeters ?? DEFAULTS.samePickupMeters, 0, 5000)), samePickupMax: Math.floor(n(b.samePickupMax ?? DEFAULTS.samePickupMax, 0, 50)),
    vehiclePricing: (() => { const vi = b.vehiclePricing && typeof b.vehiclePricing === 'object' ? b.vehiclePricing : {}; return Object.fromEntries(PRICE_VEHICLES.map((k) => { const v = vi[k] && typeof vi[k] === 'object' ? vi[k] : {}; return [k, { base: n(v.base ?? 0, 0, 1e6), perKm: n(v.perKm ?? 0, 0, 10000), minPrice: n(v.minPrice ?? 0, 0, 1e6), kmFee: n(v.kmFee ?? 0, 0, 10000) }]; })); })(),
    dcPerKm: n(b.dcPerKm ?? 0, 0, 10000), fineCreditToWallet: b.fineCreditToWallet === true,
    dcAutoCompleteHours: Math.floor(n(b.dcAutoCompleteHours ?? DEFAULTS.dcAutoCompleteHours, 0, 720)), jobsRadiusKm: Math.round(n(b.jobsRadiusKm ?? DEFAULTS.jobsRadiusKm, 0, 500) * 10) / 10,
    dcPay: { wallet: String(b.dcPay?.wallet ?? '').trim().slice(0, 40), walletName: String(b.dcPay?.walletName ?? '').trim().slice(0, 80) },
    companionAsk: b.companionAsk !== false, vehicleGuideOn: b.vehicleGuideOn !== false,
    vehicleGuide: (() => { // أقصى وزن لكل عربية (0 = متوقفة)، الأوزان المفعّلة لازم تتصاعد، والحجم لازم يكون موجود في جدول الأحجام
      const g = b.vehicleGuide ?? DEFAULTS.vehicleGuide, sizes = table(b.sizes), r = {}; let last = 0;
      for (const k of VEHICLE_KEYS) {
        const kg = Math.floor(n(g?.[k]?.maxKg, 0, 100000)), size = String(g?.[k]?.size ?? '');
        if (!sizes[size]) throw bad();
        if (kg > 0) { if (kg <= last) throw bad(); last = kg; }
        r[k] = { maxKg: kg, size };
      }
      return r;
    })(),
    passengersEnabled: b.passengersEnabled === true, passengerClasses: table(b.passengerClasses ?? DEFAULTS.passengerClasses, true),
    trustRules: (() => { // النجوم وعدد التقييمات لكل مستوى، ومرتّبين (النخبة >= المحترف >= الموثوق) عشان المستويات تفضل منطقية
      const t = b.trustRules ?? DEFAULTS.trustRules, r = {};
      for (const k of ['trusted', 'pro', 'elite']) r[k] = { avg: n(t?.[k]?.avg, 1, 5), ratings: Math.floor(n(t?.[k]?.ratings, 1, 100000)) };
      if (!(r.trusted.avg <= r.pro.avg && r.pro.avg <= r.elite.avg && r.trusted.ratings <= r.pro.ratings && r.pro.ratings <= r.elite.ratings)) throw bad();
      return r;
    })(),
    levelDiscountPct: { trusted: n(b.levelDiscountPct?.trusted ?? 0, 0, 50), pro: n(b.levelDiscountPct?.pro ?? 0, 0, 50), elite: n(b.levelDiscountPct?.elite ?? 0, 0, 50) },
    profileEditEnabled: b.profileEditEnabled !== false, profileEditCooldownDays: Math.floor(n(b.profileEditCooldownDays ?? 15, 0, 365)),
    publicProfiles: b.publicProfiles === true,
    referralEnabled: b.referralEnabled === true,
    referralBonusReferrer: Math.floor(n(b.referralBonusReferrer ?? 0, 0, 1e6)),
    referralBonusReferred: Math.floor(n(b.referralBonusReferred ?? 0, 0, 1e6)),
    site: cleanSite(b.site),
  };
}

// العربية تخدم إيه؟ (بضاعة حسب الحجم، أو ركاب حسب فئة العربية). أي حجم/فئة مخصصة من الأدمن = مسموح.
export const VEHICLE_KEYS = ['pickup', 'half_ton', 'truck', 'jumbo']; // عربيات البضاعة اللي بيرشّحها النظام (من الأصغر للأكبر)
const CARGO_CAP = { car: ['small'], van: ['small'], microbus: ['small'], minibus: [], pickup: ['small'], half_ton: ['small', 'medium'], truck: ['small', 'medium', 'large', 'xlarge'], jumbo: ['small', 'medium', 'large', 'xlarge'] };
const PAX_CAP = { car: ['car'], van: ['car', 'van'], microbus: ['car', 'van', 'microbus'], minibus: ['car', 'van', 'microbus', 'minibus'] };
export function canServe(vehicleType, o) {
  if (o.service === 'passengers') {
    const cap = PAX_CAP[vehicleType];
    return !!cap && (!['car', 'van', 'microbus', 'minibus'].includes(o.vehicleClass) || cap.includes(o.vehicleClass));
  }
  const cap = CARGO_CAP[vehicleType];
  return !cap || !['small', 'medium', 'large', 'xlarge'].includes(o.size) || cap.includes(o.size);
}

/** سعر رحلة الركاب = سعر الكيلومتر × المسافة × معامل فئة العربية (بحد أدنى) */
export function calcPassengerPrice(s, km, vehicleClass) {
  const c = s.passengerClasses[vehicleClass];
  if (!c) throw new HttpError(400, 'bad_category');
  const raw = s.perKm * km * Number(c.mult);
  return { price: Math.max(Math.ceil(s.minPrice), Math.ceil(raw)), raw: Math.round(raw), classMult: Number(c.mult), seats: c.seats };
}

/**
 * عمولة الموقع الفعلية على سواق: العمولة الأساسية للطلب − خصم مستوى الثقة، وأول رحلات السواق الجديد بعمولة مخفضة (الأقل بينهم).
 * driverRow = مستند users (بنفس أسماء الأعمدة snake_case).
 */
export function effectiveCommissionPct(s, basePct, driverRow) {
  let pct = Math.max(0, basePct - (s.levelDiscountPct[trustOf(driverRow || {}, s).level] || 0));
  if ((driverRow?.completed_orders || 0) < s.newDriver.orders) pct = Math.min(pct, s.newDriver.commissionPct);
  return pct;
}

/** تقسيم مبلغ طلب ملغي بعد قبول السواق: تعويض السواق + نصيب المنصة + الباقي للعميل (أرقام صحيحة، ومجموعها = السعر) */
export function cancelSplit(price, driverPct, platformPct) {
  const driver = Math.round((price * driverPct) / 100);
  const platform = Math.min(price - driver, Math.round((price * platformPct) / 100));
  return { driver, platform, refund: price - driver - platform };
}

/**
 * قيمة خصم الكوبون على سعر معيّن بعد التحقق من صلاحيته (نوع/قيمة/تاريخ/حد استهلاك/حد أدنى).
 * بيرمي HttpError برمز واضح لو الكوبون مش ساري، وبيرجّع رقم صحيح 0..price.
 */
export function couponDiscount(coupon, price, nowMs = Date.now()) {
  if (!coupon || coupon.active !== true) throw new HttpError(400, 'coupon_invalid');
  if (!['percent', 'amount'].includes(coupon.type)) throw new HttpError(400, 'coupon_invalid');
  if (coupon.expires_at && nowMs >= coupon.expires_at) throw new HttpError(400, 'coupon_expired');
  if (coupon.max_uses > 0 && (coupon.used_count || 0) >= coupon.max_uses) throw new HttpError(400, 'coupon_used_up');
  if (coupon.min_price > 0 && price < coupon.min_price) throw new HttpError(400, 'coupon_min_price');
  let d = coupon.type === 'percent' ? Math.round((price * Number(coupon.value || 0)) / 100) : Math.round(Number(coupon.value || 0));
  if (coupon.max_discount > 0) d = Math.min(d, coupon.max_discount);
  return Math.max(0, Math.min(d, price));
}

// ---------- تتبّع مواعيد الاستلام/التسليم (اختياري: العميل بيكتب «مدة التأخير المسموح» في الطلب) ----------
// الميعاد الفعلي = اللي العميل وافق عليه بعد اقتراح السواق، وإلا اللي العميل كتبه أصلاً. من غير مدة (graceMin) مفيش تتبّع.
export const dueOf = (o, kind) => (kind === 'pickup' ? (o.agreed?.pickupAt ?? o.scheduledAt ?? null) : (o.agreed?.deliveryAt ?? o.deliveryAt ?? null));
/** أنهي مواعيد (استلام/تسليم) اتأخر فيها السواق ولسه ماتسألش العميل عنها. `t` = الوقت الحالي. بترجّع [] لو مفيش تتبّع أو مفيش تأخير. */
export function lateKinds(o, t) {
  if (o.graceMin == null || !o.driverId) return [];
  // السواق ملزَم من أحدث وقت بين: قبوله، وتأكيد الدفع، وموافقة العميل على المواعيد — لو التزم بعد ما الميعاد فات أصلاً مش ذنبه
  const commit = Math.max(o.acceptedAt || 0, o.paidAt || 0, o.agreed?.at || 0), out = [];
  for (const kind of ['pickup', 'delivery']) {
    if (o.lateMarks?.[kind]) continue; // اتسأل/اتحسم قبل كده: مرة واحدة لكل ميعاد
    const due = dueOf(o, kind); if (!due) continue;
    const limit = due + o.graceMin * 60000;
    if (commit > limit) continue;
    const actual = kind === 'pickup' ? o.pickedUpAt : o.deliveredAt; // لو حصل فعلاً بنحاسب على وقته الحقيقي
    const waiting = kind === 'pickup' ? ['paid', 'heading_pickup'].includes(o.status) : ['paid', 'heading_pickup', 'picked_up', 'in_transit'].includes(o.status);
    const at = actual || (waiting ? t : null);
    if (at != null && at > limit) out.push(kind);
  }
  return out;
}

// ---------- حراسة القيمة (مفعّلة من الأدمن) ----------
// فوق حد القيمة المعلنة الشحنة بتبقى «عالية»: كود التسليم إجباري للطلب ده + مفيش تحرير تلقائي. أي سواق يقدر يشوفها ويقبلها (مفيش قيد على السواقين).
// المستوى بيتحسب مرة عند الإنشاء وبيتخزّن في الطلب، فتغيير الحد بعدها مابيأثرش على طلبات شغّالة.
export const guardOf = (s, declaredValue) => (s.valueGuardOn === true && Number(declaredValue) >= s.valueGuardFrom ? 'high' : null);


/** ترشيح العربية: أول عربية مفعّلة وزنها يكفي، ولو الوزن أكبر من الكل يترشّح أكبر عربية مفعّلة. null لو مفيش عربية مفعّلة. */
export function recommendVehicle(guide, weightKg) {
  const on = VEHICLE_KEYS.filter((k) => guide?.[k]?.maxKg > 0), kg = Number(weightKg);
  if (!on.length) return null;
  return (Number.isFinite(kg) && kg > 0 && on.find((k) => kg <= guide[k].maxKg)) || on[on.length - 1];
}

// ===== الدفع عند الاستلام (COD): منطق صافي =====
const DAY = 86400e3;
/** فترة المحاسبة اللي فيها وقت معيّن. المفتاح `${أيام}d-${رقم}` بيتخزّن مع كل مبلغ محصّل، فتغيير طول الفترة بعدين مابيبوّظش القديم. */
export function codPeriodOf(ts, days) { const d = Math.max(1, Math.floor(days)), idx = Math.floor(ts / (d * DAY)); return { key: `${d}d-${idx}`, start: idx * d * DAY, end: (idx + 1) * d * DAY }; }
export function codPeriodBounds(key) { const m = /^(\d{1,2})d-(\d{1,6})$/.exec(String(key ?? '')); if (!m) return null; const d = +m[1], i = +m[2]; if (d < 1 || d > 31) return null; return { days: d, idx: i, start: i * d * DAY, end: (i + 1) * d * DAY }; }
/** تقسيم المبلغ المحصّل: عمولة المنصة (بالنسبة المثبّتة وقت التحصيل) والباقي للمرسل. العمولة بتتقرّب لأقرب جنيه. */
export function codSplit(amount, pct) { const a = Math.max(0, Math.floor(Number(amount) || 0)), p = Math.min(30, Math.max(0, Number(pct) || 0)); const commission = Math.min(a, Math.round((a * p) / 100)); return { amount: a, commission, net: a - commission }; }
/** كشف الحساب لكل فترة من المبالغ المحصّلة + حالة السداد (pays: خريطة period → {status}). due = موعد السداد (آخر الفترة + المهلة). */
export function codStatements(entries, pays, s, nowTs) {
  const by = new Map();
  for (const e of entries || []) {
    if (!e.period) continue;
    const g = by.get(e.period) || { period: e.period, count: 0, collected: 0, commission: 0, net: 0 };
    g.count += 1; g.collected += e.amount || 0; g.commission += e.commission || 0; g.net += e.net || 0; by.set(e.period, g);
  }
  const grace = Math.max(0, Number(s?.codGraceDays) || 0) * DAY;
  return [...by.values()].map((g) => {
    const b = codPeriodBounds(g.period), pay = pays?.[g.period] || null, dueAt = b ? b.end + grace : 0;
    const status = pay?.status === 'paid' ? 'paid' : !b || nowTs < b.end ? 'open' : pay?.status === 'reported' ? (nowTs > dueAt ? 'overdue' : 'reported') : nowTs > dueAt ? 'overdue' : 'due';
    return { ...g, start: b?.start ?? 0, end: b?.end ?? 0, dueAt, status, ref: pay?.ref ?? null };
  }).sort((x, y) => y.start - x.start);
}
/** السواق متوقف لو عنده فترة متأخرة (عدّى موعد السداد وما اتأكدش). */
export const codBlocked = (statements) => (statements || []).some((x) => x.status === 'overdue');
