// محتوى الصفحة الرئيسية — وحدة بيانات صرفة (من غير DOM) بيستخدمها السيرفر (الرسم للـSEO) والمتصفح (الترجمة ولوحة الأدمن) والاختبارات.
// القاعدة: أي جملة فيها حقيقة عن النظام بتتحدد من إعدادات النظام الفعلية (lpFacts) مش مكتوبة ثابتة. لو الميزة مقفولة، الجملة بتختفي أو بتتبدّل.
export const LP_ORIGIN = 'https://ishhanli.pages.dev';
export const LP_SECTIONS = ['about', 'estimate', 'services', 'trust', 'join', 'faq', 'contact']; // الأقسام اللي الأدمن يقدر يخفيها

// [المفتاح, عربي, English] — {name} متغيّرات، و*كلمة* = إبراز (em). مفاتيح lp.* بتتسجّل في i18n.js
export const LP_ROWS = [
  ['lp.nav.how', 'إزاي بتشتغل', 'How it works'], ['lp.nav.services', 'الخدمات', 'Services'], ['lp.nav.price', 'السعر', 'Pricing'],
  ['lp.nav.trust', 'الثقة', 'Trust'], ['lp.nav.faq', 'أسئلة', 'FAQ'], ['lp.nav.contact', 'تواصل', 'Contact'],
  ['lp.nav.login', 'دخول', 'Log in'], ['lp.nav.account', 'حسابي', 'My account'], ['lp.nav.order', 'اطلب نقل', 'Request transport'],
  ['lp.mode.toggle', 'تبديل الوضع الليلي والنهاري', 'Toggle dark and light mode'], ['lp.nav.menu', 'القائمة', 'Menu'], ['lp.hero.scroll', 'اسحب لتحت', 'Scroll down'],
  ['lp.logo.alt', 'شعار اشحنلي: شاحنة بداخلها عين حورس', 'Ishhanli logo: a truck with the Eye of Horus'],

  ['lp.hero.eyebrow', 'نقل بضائع في مصر', 'Freight transport in Egypt'],
  ['lp.hero.h1.escrow', 'انقل حمولتك بسعر *واضح*، وفلوسك محجوزة لحد ما توصل', 'Move your cargo at a *clear* price, with your money held until it arrives'],
  ['lp.hero.h1.direct', 'انقل حمولتك بسعر *واضح* مع سواق موثّق', 'Move your cargo at a *clear* price with a verified driver'],
  ['lp.hero.sub.escrow', 'حدد الاستلام والتسليم على الخريطة، شوف السعر فوراً، وسواق موثّق يستلم منك. المبلغ بيفضل محجوز لحد ما تأكد إن الشحنة وصلت.', 'Pin pickup and drop-off on the map, see the price instantly, and a verified driver collects your cargo. The payment stays held until you confirm it arrived.'],
  ['lp.hero.sub.escrowAuto', 'حدد الاستلام والتسليم على الخريطة، شوف السعر فوراً، وسواق موثّق يستلم منك. المبلغ بيفضل محجوز لحد ما تأكد إن الشحنة وصلت، أو بعد {h} ساعة لو التسليم اتأكد بالكود أو الموقع ومفيش نزاع.', 'Pin pickup and drop-off on the map, see the price instantly, and a verified driver collects your cargo. The payment stays held until you confirm arrival, or for {h} hours after a delivery verified by code or location with no dispute.'],
  ['lp.hero.sub.direct', 'حدد الاستلام والتسليم على الخريطة، شوف السعر فوراً، وسواق موثّق يستلم منك. بتدفع للسواق مباشرة.', 'Pin pickup and drop-off on the map, see the price instantly, and a verified driver collects your cargo. You pay the driver directly.'],
  ['lp.hero.cta1', 'اطلب نقل دلوقتي', 'Request a shipment'], ['lp.hero.cta2', 'اشتغل كسواق', 'Drive with us'],

  ['lp.stm', 'السعر قدامك من الأول، ومستندات السواق بتتراجع يدوي قبل التفعيل، وكل شحنة مربوطة باسم السواق اللي استلمها.', 'The price is in front of you from the start, driver documents are reviewed by hand before activation, and every shipment is tied to the driver who took it.'],

  ['lp.about.title', 'اشحنلي: منصة بتربط العميل بسواق النقل في مصر', 'Ishhanli: a platform linking customers with transport drivers in Egypt'],
  ['lp.about.p', 'اشحنلي منصة مصرية لنقل البضائع والأثاث، بتجمع أصحاب الشحنات وسواقين النقل الموثّقين في مكان واحد. العميل بيطلب النقل ويعرف السعر قبل ما يأكد، والسواق بيستقبل الطلبات المتاحة ويشتغل بمستنداته الموثّقة، والمنصة هي اللي بتربط بينهم وتتابع الشحنة لحد التسليم.', 'Ishhanli is an Egyptian platform for moving goods and furniture. It brings shipment owners and verified transport drivers together in one place: the customer requests transport and sees the price before confirming, the driver receives available jobs with verified documents, and the platform connects them and follows the shipment until delivery.'],
  ['lp.about.ct', 'لو عندك شحنة', 'If you have a shipment'],
  ['lp.about.c1', 'حدد الاستلام والتسليم على الخريطة واعرف سعر النقل فوراً.', 'Pin pickup and drop-off on the map and see the transport price instantly.'],
  ['lp.about.c2', 'اختار نوع الحمولة وحجمها، وتقدر تضيف صور لها.', 'Choose the cargo type and size, and optionally add photos.'],
  ['lp.about.c3', 'تابع السواق على الخريطة لحد ما الشحنة توصل.', 'Follow the driver on the map until the cargo arrives.'],
  ['lp.about.dt', 'لو سواق نقل', 'If you are a transport driver'],
  ['lp.about.d1', 'سجّل بمستنداتك، وبتتراجع يدوي قبل ما حسابك يتفعّل.', 'Register with your documents; they are reviewed by hand before your account is activated.'],
  ['lp.about.d2', 'شوف طلبات النقل المتاحة واقبل اللي يناسبك.', 'See the available transport jobs and accept the ones that suit you.'],
  ['lp.about.d3', 'صوّر البضاعة عند الاستلام والتسليم، والصور بتتحفظ في الطلب.', 'Photograph the cargo at pickup and delivery; the photos are saved on the order.'],
  ['lp.how.tag', '٣ خطوات بس', 'Just 3 steps'], ['lp.how.title', 'إزاي بتشتغل', 'How it works'],
  ['lp.how.s1t', 'ارسم الرحلة', 'Draw the trip'],
  ['lp.how.s1d', 'علّم الاستلام والتسليم على الخريطة، وتقدر تضيف صور للحمولة، وتعرف السعر قبل ما تأكد الطلب.', 'Mark pickup and drop-off on the map, optionally add cargo photos, and see the price before you confirm.'],
  ['lp.how.s2t.escrow', 'سواق يقبل وأنت تدفع', 'A driver accepts, you pay'], ['lp.how.s2t.direct', 'سواق يقبل وتدفعله مباشرة', 'A driver accepts, you pay directly'],
  ['lp.how.s2d.escrow', 'سواق موثّق يقبل طلبك. بتحوّل المبلغ عبر InstaPay وترفع صورة التحويل، وفريقنا بيأكده والمبلغ بيتحجز.', 'A verified driver accepts. You transfer via InstaPay and upload the receipt, our team confirms it and the amount is held.'],
  ['lp.how.s2d.escrowOffers', 'سواق موثّق يقبل طلبك أو يقترح عليك سعر تقبله أو ترفضه. بتحوّل المبلغ عبر InstaPay وترفع صورة التحويل، وفريقنا بيأكده والمبلغ بيتحجز.', 'A verified driver accepts, or proposes a price you can accept or decline. You transfer via InstaPay and upload the receipt, our team confirms it and the amount is held.'],
  ['lp.how.s2d.direct', 'سواق موثّق يقبل طلبك. بتدفع للسواق مباشرة، ومفيش مبلغ بيتحوّل على المنصة.', 'A verified driver accepts. You pay the driver directly; no payment goes through the platform.'],
  ['lp.how.s2d.directOffers', 'سواق موثّق يقبل طلبك أو يقترح عليك سعر تقبله أو ترفضه. بتدفع للسواق مباشرة، ومفيش مبلغ بيتحوّل على المنصة.', 'A verified driver accepts, or proposes a price you can accept or decline. You pay the driver directly; no payment goes through the platform.'],
  ['lp.how.s3t', 'استلم وأكّد', 'Receive and confirm'],
  ['lp.how.s3d.escrow', 'تتابع السواق على الخريطة، وأول ما الشحنة توصل تضغط «وصلت شحنتي» وبيتحوّل المستحق للسواق بعد خصم عمولة المنصة.', 'Follow the driver on the map. When the cargo arrives, tap “My shipment arrived” and the driver is paid after the platform commission.'],
  ['lp.how.s3d.escrowAuto', 'تتابع السواق على الخريطة، وأول ما الشحنة توصل تضغط «وصلت شحنتي» وبيتحوّل المستحق للسواق بعد خصم عمولة المنصة. ولو التسليم اتأكد بالكود أو الموقع ومفيش نزاع، بيتحوّل تلقائياً بعد {h} ساعة.', 'Follow the driver on the map. When the cargo arrives, tap “My shipment arrived” and the driver is paid after the platform commission. If delivery was verified by code or location with no dispute, it is released automatically after {h} hours.'],
  ['lp.how.s3d.direct', 'تتابع السواق على الخريطة، وأول ما الشحنة توصل تأكد الاستلام وبتتسجّل الشحنة مكتملة.', 'Follow the driver on the map. When the cargo arrives, confirm receipt and the shipment is recorded as completed.'],

  ['lp.mq.1', 'سعر فوري', 'Instant price'], ['lp.mq.2', 'سواقين موثّقين', 'Verified drivers'], ['lp.mq.3.escrow', 'فلوس محجوزة', 'Payment held'],
  ['lp.mq.3.direct', 'دفع مباشر للسواق', 'Pay the driver directly'], ['lp.mq.4', 'صور إثبات', 'Photo proof'], ['lp.mq.5', 'تتبع GPS', 'GPS tracking'],

  ['lp.est.title', 'قدّر سعر شحنتك', 'Estimate your price'],

  ['lp.svc.title', 'خدماتنا', 'Our services'],
  ['lp.svc.cargo.t', 'نقل بضائع', 'Cargo transport'], ['lp.svc.cargo.d', 'من شحنة صغيرة لحمولة كاملة: حدد الاستلام والتسليم على الخريطة وشوف السعر فوراً.', 'From a small parcel to a full load: set pickup and drop-off on the map and see the price instantly.'],
  ['lp.svc.pass.t', 'حجز عربية', 'Vehicle booking'], ['lp.svc.pass.d', 'احجز عربية بسواقها لنقل الأفراد والمجموعات، وتتابع الرحلة على الخريطة.', 'Book a vehicle with a driver for individuals and groups, and follow the trip on the map.'],
  ['lp.svc.driver.t', 'سواقين فرادى', 'Individual drivers'], ['lp.svc.driver.d', 'أي سواق عنده عربية نقل يسجّل بمستنداته، وبعد المراجعة اليدوية يبدأ يستقبل الطلبات.', 'Any driver with a transport vehicle registers with documents and, after manual review, starts receiving orders.'],
  ['lp.svc.company.t', 'شركات شحن', 'Shipping companies'], ['lp.svc.company.d', 'الشركة تسجّل ببطاقة المسؤول وسيلفي معاها ومركبة واحدة على الأقل، وتضيف سواقينها، وتحدد مين هيستلم كل شحنة.', 'A company registers with the manager’s ID, a selfie with it and at least one vehicle, adds its drivers and assigns who picks up each shipment.'],

  ['lp.price.title', 'سعر بدون مفاجآت', 'Pricing without surprises'],
  ['lp.price.text', 'السعر بيتحسب أوتوماتيك من المسافة ونوع الحمولة، وبيظهر لك قبل ما تطلب.', 'The price is calculated automatically from distance and cargo type, and shown before you order.'],
  ['lp.price.formula.classic', 'السعر = *سعر الكيلومتر* × *المسافة* × *معامل نوع الحمولة* × *معامل الحجم*', 'Price = *per-km rate* × *distance* × *cargo-type factor* × *size factor*'],
  ['lp.price.formula.vehicle', 'السعر = (*سعر الفتح* + *سعر الكيلومتر* × *المسافة*) × *معامل نوع الحمولة*، حسب العربية المختارة', 'Price = (*base fare* + *per-km rate* × *distance*) × *cargo-type factor*, depending on the chosen vehicle'],
  ['lp.price.min', 'أقل سعر للشحنة {n} جنيه، مهما كانت المسافة قصيرة.', 'The minimum price for a shipment is EGP {n}, however short the distance.'],
  ['lp.stat.min', 'جنيه أقل سعر للشحنة', 'EGP minimum price'], ['lp.stat.geo', 'متر نطاق التحقق من موقع السواق', 'meters location-check radius'],
  ['lp.stat.photos', 'صورتين إثبات للبضاعة (استلام وتسليم)', 'proof photos per cargo order (pickup and delivery)'], ['lp.stat.steps', 'خطوات للطلب', 'steps to order'],

  ['lp.trust.title', 'ليه تثق فينا', 'Why trust us'],
  ['lp.trust.1t', 'سواقين موثّقين', 'Verified drivers'], ['lp.trust.1d', 'كل سواق بيقدّم بطاقته ورخصته واستمارة العربية وصورتها، وبتتراجع يدوي قبل التفعيل.', 'Every driver submits an ID, license, vehicle registration and a vehicle photo, reviewed by hand before activation.'],
  ['lp.trust.2t.escrow', 'فلوسك محجوزة', 'Your money is held'], ['lp.trust.2d.escrow', 'المبلغ بيفضل محجوز (Escrow) عند المنصة لحد ما تأكد الاستلام.', 'The payment stays in escrow with the platform until you confirm receipt.'],
  ['lp.trust.2d.escrowAuto', 'المبلغ بيفضل محجوز (Escrow) لحد ما تأكد الاستلام. ولو التسليم اتأكد بالكود أو الموقع ومفيش نزاع بيتحوّل تلقائياً بعد {h} ساعة.', 'The payment stays in escrow until you confirm receipt. If delivery was verified by code or location with no dispute, it is released after {h} hours.'],
  ['lp.trust.2t.direct', 'شحنة مسجّلة باسم السواق', 'Shipment tied to the driver'], ['lp.trust.2d.direct', 'كل شحنة مربوطة باسم السواق اللي استلمها وبياناته عند المنصة.', 'Every shipment is tied to the driver who took it, with his details on file at the platform.'],
  ['lp.trust.3t', 'صور إثبات', 'Photo proof'], ['lp.trust.3d', 'السواق لازم يصوّر البضاعة عند الاستلام وعند التسليم، والصور بتتحفظ في الطلب.', 'The driver must photograph the cargo at pickup and at delivery, and the photos are saved on the order.'],
  ['lp.trust.4t.geo', 'تحقق من الموقع', 'Location check'], ['lp.trust.4d.geo', 'السواق مش بيقدر يسجّل الاستلام أو التسليم إلا لو موقعه في حدود {m} متر من النقطة المحددة.', 'The driver can only log pickup or delivery within {m} meters of the chosen point.'],
  ['lp.trust.4t.track', 'تتبع على الخريطة', 'Map tracking'], ['lp.trust.4d.track', 'بتتابع السواق على الخريطة لحد ما الشحنة توصل.', 'You follow the driver on the map until the cargo arrives.'],

  ['lp.join.d.title', 'عندك عربية نقل؟', 'Own a transport vehicle?'],
  ['lp.join.d.text.escrow', 'سجّل بمستنداتك، وأول ما تتفعّل تشوف الطلبات المتاحة، واسحب أرباحك (بعد عمولة المنصة) على InstaPay أو فودافون كاش أو حساب بنكي. أقل مبلغ سحب {w} جنيه.', 'Register with your documents, and once activated you can see available jobs and withdraw your earnings (after the platform commission) via InstaPay, Vodafone Cash or bank transfer. Minimum withdrawal EGP {w}.'],
  ['lp.join.d.text.direct', 'سجّل بمستنداتك، وأول ما تتفعّل تشوف الطلبات المتاحة وتقبلها. الدفع بيكون من العميل للسواق مباشرة.', 'Register with your documents, and once activated you can see available jobs and accept them. The customer pays the driver directly.'],
  ['lp.join.d.cta', 'اشتغل كسواق', 'Drive with us'],
  ['lp.join.c.title', 'لشركات الشحن', 'For shipping companies'],
  ['lp.join.c.text', 'سجّل شركتك ببطاقة المسؤول وسيلفي معاها واستمارة وصورة لمركبة واحدة على الأقل (السجل التجاري مش شرط)، وأضف باقي سواقينك بمستنداتهم. في كل شحنة بتحدد مين اللي هيستلمها، فلو حصل تلف أو فقد يبقى معروف المسؤول.', 'Register your company with the manager’s ID, a selfie with it, and the registration and a photo of at least one vehicle (no commercial register required), then add your other drivers with their documents. For each shipment you assign who picks it up, so if anything is damaged or lost it is known who is responsible.'],
  ['lp.join.c.cta', 'سجّل شركتك', 'Register your company'],

  ['lp.faq.title', 'أسئلة شائعة', 'Frequently asked questions'],
  ['lp.faq.1q', 'الدفع بيتم إزاي؟', 'How does payment work?'],
  ['lp.faq.1a.escrow', 'بتحوّل المبلغ عبر InstaPay وترفع صورة التحويل، وبعد ما فريقنا يأكده المبلغ بيتحجز لحد ما تأكد الاستلام.', 'You transfer via InstaPay and upload the receipt. After our team confirms it, the amount is held until you confirm receipt.'],
  ['lp.faq.1a.escrowAuto', 'بتحوّل المبلغ عبر InstaPay وترفع صورة التحويل، وبعد ما فريقنا يأكده المبلغ بيتحجز لحد ما تأكد الاستلام. ولو التسليم اتأكد بالكود أو الموقع ومفيش نزاع بيتحوّل للسواق تلقائياً بعد {h} ساعة.', 'You transfer via InstaPay and upload the receipt. After our team confirms it, the amount is held until you confirm receipt. If delivery was verified by code or location with no dispute, it is released to the driver after {h} hours.'],
  ['lp.faq.1a.direct', 'بتدفع للسواق مباشرة، والمنصة مش بتستلم أي مبلغ منك.', 'You pay the driver directly; the platform does not receive any payment from you.'],
  ['lp.faq.2q', 'لو الشحنة اتأخرت أو اتلفت؟', 'What if the cargo is late or damaged?'],
  ['lp.faq.2a.escrow', 'افتح نزاع على الطلب. المبلغ بيفضل محجوز والإدارة بتراجع الأدلة (الصور وحالة الطلب) وبتبلّغ الطرفين بالقرار.', 'Open a dispute on the order. The money stays held while our team reviews the evidence (photos and order status) and tells both sides the decision.'],
  ['lp.faq.2a.direct', 'بلّغ الإدارة من «إبلاغ» في صفحة الطلب، والبلاغ بيوصلها ومعاه آخر رسائل الشات كدليل.', 'Report it to the team using “Report” on the order page; the report reaches them with the latest chat messages as evidence.'],
  ['lp.faq.3q', 'إزاي أعرف سعر الشحنة قبل ما أطلب؟', 'How do I know the price before I order?'],
  ['lp.faq.3a', 'بتحدد الاستلام والتسليم على الخريطة فيتحسب السعر تلقائياً من المسافة ونوع الحمولة، ويظهر لك قبل ما تأكد. أقل سعر {n} جنيه.', 'You set pickup and drop-off on the map and the price is calculated from distance and cargo type, shown before you confirm. The minimum price is EGP {n}.'],
  ['lp.faq.4q', 'عمولة السواق بتتحسب إزاي؟', 'How is the driver commission calculated?'],
  ['lp.faq.4a.escrow', 'المنصة بتخصم {p}% من قيمة الشحنة بعد إتمامها.', 'The platform deducts {p}% of the shipment value once it is completed.'],
  ['lp.faq.4a.escrowNew', 'المنصة بتخصم {p}% من قيمة الشحنة بعد إتمامها، وأول {o} رحلات للسواق الجديد بعمولة {c}%.', 'The platform deducts {p}% of the shipment value once it is completed, and a new driver’s first {o} trips carry a {c}% commission.'],
  ['lp.faq.4a.directPct', 'المنصة بتحاسب السواق بنسبة {p}% من مكسبه عن الشحنات المكتملة.', 'The platform charges the driver {p}% of his earnings on completed shipments.'],
  ['lp.faq.4a.directPctKm', 'المنصة بتحاسب السواق بنسبة {p}% من مكسبه عن الشحنات المكتملة، مع رسوم على الكيلومترات المقطوعة.', 'The platform charges the driver {p}% of his earnings on completed shipments, plus a per-kilometre fee.'],
  ['lp.faq.4a.directKm', 'المنصة بتحاسب السواق برسوم على الكيلومترات المقطوعة في الشحنات المكتملة.', 'The platform charges the driver a per-kilometre fee on completed shipments.'],
  ['lp.faq.4a.directNone', 'مفيش عمولة على السواقين حالياً.', 'There is currently no commission on drivers.'],

  ['lp.contact.title', 'تواصل معنا', 'Contact us'],
  ['lp.fin.title', 'جاهز *تشحن*؟', 'Ready to *ship*?'],
  ['lp.foot.rules', 'قواعد التعامل', 'Rules of conduct'], ['lp.foot.pricing', 'أسعار النقل', 'Transport pricing'], ['lp.foot.vehicles', 'أنواع العربيات', 'Vehicle types'],
];

const ROW = Object.fromEntries(LP_ROWS.map(([k, ar, en]) => [k, { ar, en }]));
export const lpFill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (_, k) => vars?.[k] ?? '');
/** النص بلغة معيّنة */
export const lpText = (key, vars, lang = 'ar') => lpFill((ROW[key] || {})[lang === 'en' ? 'en' : 'ar'] ?? key, vars);

const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
/** الحقائق اللي بتتحكم في النصوص: كلها من إعدادات النظام (loadSettings) أو من بيئة السيرفر. */
export function lpFacts(s = {}, env = {}) {
  const dc = s.dcEnabled === true, vp = s.vehiclePricing || {}, nd = s.newDriver || {};
  const kmFee = Object.values(vp).some((v) => num(v?.kmFee) > 0) || num(s.dcPerKm) > 0;
  return {
    direct: dc,
    autoH: !dc && num(s.autoReleaseHours) > 0 ? Math.round(num(s.autoReleaseHours)) : 0,
    offers: s.offersEnabled !== false,
    passengers: s.passengersEnabled === true,
    geo: num(s.geofenceMeters) > 0 ? Math.round(num(s.geofenceMeters)) : 0,
    minPrice: Math.max(0, Math.round(num(s.minPrice))),
    vehiclePricing: Object.values(vp).some((v) => num(v?.perKm) > 0),
    pct: num(s.commissionPct), newOrders: num(nd.orders) > 0 ? Math.round(num(nd.orders)) : 0, newPct: num(nd.commissionPct),
    dcPct: num(s.dcPct), dcKm: kmFee, minWithdraw: Math.max(0, Math.round(num(s.minWithdraw))),
    code: s.deliveryCode === true && !!env?.DELIVERY_CODE_SECRET,
  };
}

const K = (key, vars) => ({ key, vars });
/** كل خانات النص في الصفحة: id → {key, vars} (المفتاح بيتغيّر حسب الحقائق) */
export function lpSlots(f) {
  const sfx = f.autoH ? 'escrowAuto' : 'escrow', h = { h: f.autoH };
  const dm = f.direct ? 'direct' : 'escrow';
  const slots = {
    'hero.eyebrow': K('lp.hero.eyebrow'), 'hero.h1': K(f.direct ? 'lp.hero.h1.direct' : 'lp.hero.h1.escrow'),
    'hero.sub': f.direct ? K('lp.hero.sub.direct') : K(`lp.hero.sub.${sfx}`, h), 'hero.cta1': K('lp.hero.cta1'), 'hero.cta2': K('lp.hero.cta2'),
    'stm.text': K('lp.stm'),
    'about.title': K('lp.about.title'), 'about.p': K('lp.about.p'), 'about.ct': K('lp.about.ct'), 'about.c1': K('lp.about.c1'), 'about.c2': K('lp.about.c2'), 'about.c3': K('lp.about.c3'),
    'about.dt': K('lp.about.dt'), 'about.d1': K('lp.about.d1'), 'about.d2': K('lp.about.d2'), 'about.d3': K('lp.about.d3'),
    'how.tag': K('lp.how.tag'), 'how.title': K('lp.how.title'),
    'how.s1t': K('lp.how.s1t'), 'how.s1d': K('lp.how.s1d'),
    'how.s2t': K(`lp.how.s2t.${dm}`), 'how.s2d': K(`lp.how.s2d.${dm}${f.offers ? 'Offers' : ''}`),
    'how.s3t': K('lp.how.s3t'), 'how.s3d': f.direct ? K('lp.how.s3d.direct') : K(`lp.how.s3d.${sfx}`, h),
    'svc.title': K('lp.svc.title'), 'svc.cargo.t': K('lp.svc.cargo.t'), 'svc.cargo.d': K('lp.svc.cargo.d'),
    'svc.driver.t': K('lp.svc.driver.t'), 'svc.driver.d': K('lp.svc.driver.d'), 'svc.company.t': K('lp.svc.company.t'), 'svc.company.d': K('lp.svc.company.d'),
    'price.title': K('lp.price.title'), 'price.text': K('lp.price.text'),
    'price.formula': K(f.vehiclePricing ? 'lp.price.formula.vehicle' : 'lp.price.formula.classic'),
    'trust.title': K('lp.trust.title'), 'trust.1t': K('lp.trust.1t'), 'trust.1d': K('lp.trust.1d'),
    'trust.2t': K(`lp.trust.2t.${dm}`), 'trust.2d': f.direct ? K('lp.trust.2d.direct') : K(`lp.trust.2d.${sfx}`, h),
    'trust.3t': K('lp.trust.3t'), 'trust.3d': K('lp.trust.3d'),
    'trust.4t': K(f.geo ? 'lp.trust.4t.geo' : 'lp.trust.4t.track'), 'trust.4d': f.geo ? K('lp.trust.4d.geo', { m: f.geo }) : K('lp.trust.4d.track'),
    'join.d.title': K('lp.join.d.title'), 'join.d.text': f.direct ? K('lp.join.d.text.direct') : K('lp.join.d.text.escrow', { w: f.minWithdraw }),
    'join.d.cta': K('lp.join.d.cta'), 'join.c.title': K('lp.join.c.title'), 'join.c.text': K('lp.join.c.text'), 'join.c.cta': K('lp.join.c.cta'),
    'faq.title': K('lp.faq.title'), 'faq.1q': K('lp.faq.1q'), 'faq.1a': f.direct ? K('lp.faq.1a.direct') : K(`lp.faq.1a.${sfx}`, h),
    'faq.2q': K('lp.faq.2q'), 'faq.2a': K(`lp.faq.2a.${dm}`),
    'faq.3q': K('lp.faq.3q'), 'faq.3a': K('lp.faq.3a', { n: f.minPrice }), 'faq.4q': K('lp.faq.4q'),
    'faq.4a': f.direct
      ? (f.dcPct > 0 ? K(f.dcKm ? 'lp.faq.4a.directPctKm' : 'lp.faq.4a.directPct', { p: f.dcPct }) : f.dcKm ? K('lp.faq.4a.directKm') : K('lp.faq.4a.directNone'))
      : (f.newOrders > 0 && f.newPct < f.pct ? K('lp.faq.4a.escrowNew', { p: f.pct, o: f.newOrders, c: f.newPct }) : K('lp.faq.4a.escrow', { p: f.pct })),
    'contact.title': K('lp.contact.title'), 'fin.title': K('lp.fin.title'),
  };
  if (f.passengers) { slots['svc.pass.t'] = K('lp.svc.pass.t'); slots['svc.pass.d'] = K('lp.svc.pass.d'); }
  return slots;
}

/** الحقول اللي الأدمن يقدر يغيّر نصها (الباقي حقائق من النظام). [id, مجموعة, عربي, English, طويل؟] */
export const LP_GROUPS = [['hero', 'الواجهة الأولى', 'Hero'], ['about', 'عن اشحنلي', 'About'], ['how', 'إزاي بتشتغل', 'How it works'], ['svc', 'الخدمات', 'Services'], ['price', 'السعر', 'Pricing'],
  ['trust', 'الثقة', 'Trust'], ['join', 'السواقين والشركات', 'Drivers and companies'], ['faq', 'الأسئلة الشائعة', 'FAQ'], ['misc', 'أخرى', 'Other']];
export const LP_FIELDS = [
  ['hero.eyebrow', 'hero', 'الشارة فوق العنوان', 'Badge above title'], ['hero.h1', 'hero', 'العنوان الرئيسي (حط *كلمة* بين نجمتين لإبرازها)', 'Main title (wrap *a word* in stars to highlight)'],
  ['hero.sub', 'hero', 'الوصف تحت العنوان', 'Text under the title', 1], ['hero.cta1', 'hero', 'زرار العميل', 'Customer button'], ['hero.cta2', 'hero', 'زرار السواق', 'Driver button'],
  ['stm.text', 'hero', 'الجملة الكبيرة بعد الواجهة', 'Big statement', 1],
  ['about.title', 'about', 'العنوان', 'Title'], ['about.p', 'about', 'الفقرة التعريفية', 'Intro paragraph', 1], ['about.ct', 'about', 'العميل: العنوان', 'Customer: title'], ['about.c1', 'about', 'العميل: نقطة 1', 'Customer: point 1', 1], ['about.c2', 'about', 'العميل: نقطة 2', 'Customer: point 2', 1], ['about.c3', 'about', 'العميل: نقطة 3', 'Customer: point 3', 1],
  ['about.dt', 'about', 'السواق: العنوان', 'Driver: title'], ['about.d1', 'about', 'السواق: نقطة 1', 'Driver: point 1', 1], ['about.d2', 'about', 'السواق: نقطة 2', 'Driver: point 2', 1], ['about.d3', 'about', 'السواق: نقطة 3', 'Driver: point 3', 1],
  ['how.tag', 'how', 'الشارة', 'Badge'], ['how.title', 'how', 'العنوان', 'Title'], ['how.s1t', 'how', 'الخطوة 1: العنوان', 'Step 1 title'], ['how.s1d', 'how', 'الخطوة 1: الشرح', 'Step 1 text', 1],
  ['how.s2t', 'how', 'الخطوة 2: العنوان', 'Step 2 title'], ['how.s2d', 'how', 'الخطوة 2: الشرح', 'Step 2 text', 1], ['how.s3t', 'how', 'الخطوة 3: العنوان', 'Step 3 title'], ['how.s3d', 'how', 'الخطوة 3: الشرح', 'Step 3 text', 1],
  ['svc.title', 'svc', 'عنوان القسم', 'Section title'], ['svc.cargo.t', 'svc', 'نقل بضائع: العنوان', 'Cargo: title'], ['svc.cargo.d', 'svc', 'نقل بضائع: الشرح', 'Cargo: text', 1],
  ['svc.pass.t', 'svc', 'حجز عربية: العنوان (بيظهر لو الخدمة مفعّلة)', 'Vehicle booking: title (shown when enabled)'], ['svc.pass.d', 'svc', 'حجز عربية: الشرح', 'Vehicle booking: text', 1],
  ['svc.driver.t', 'svc', 'سواقين فرادى: العنوان', 'Drivers: title'], ['svc.driver.d', 'svc', 'سواقين فرادى: الشرح', 'Drivers: text', 1], ['svc.company.t', 'svc', 'شركات شحن: العنوان', 'Companies: title'], ['svc.company.d', 'svc', 'شركات شحن: الشرح', 'Companies: text', 1],
  ['price.title', 'price', 'العنوان', 'Title'], ['price.text', 'price', 'الشرح', 'Text', 1], ['price.formula', 'price', 'معادلة السعر (بتتحسب من إعدادات التسعير)', 'Price formula (derived from pricing settings)', 1],
  ['trust.title', 'trust', 'عنوان القسم', 'Section title'], ['trust.1t', 'trust', 'الكارت 1: العنوان', 'Card 1 title'], ['trust.1d', 'trust', 'الكارت 1: الشرح', 'Card 1 text', 1],
  ['trust.2t', 'trust', 'الكارت 2: العنوان', 'Card 2 title'], ['trust.2d', 'trust', 'الكارت 2: الشرح', 'Card 2 text', 1], ['trust.3t', 'trust', 'الكارت 3: العنوان', 'Card 3 title'], ['trust.3d', 'trust', 'الكارت 3: الشرح', 'Card 3 text', 1],
  ['trust.4t', 'trust', 'الكارت 4: العنوان', 'Card 4 title'], ['trust.4d', 'trust', 'الكارت 4: الشرح', 'Card 4 text', 1],
  ['join.d.title', 'join', 'السواقين: العنوان', 'Drivers: title'], ['join.d.text', 'join', 'السواقين: الشرح', 'Drivers: text', 1], ['join.d.cta', 'join', 'السواقين: الزرار', 'Drivers: button'],
  ['join.c.title', 'join', 'الشركات: العنوان', 'Companies: title'], ['join.c.text', 'join', 'الشركات: الشرح', 'Companies: text', 1], ['join.c.cta', 'join', 'الشركات: الزرار', 'Companies: button'],
  ['faq.title', 'faq', 'عنوان القسم', 'Section title'], ['faq.1q', 'faq', 'سؤال 1', 'Question 1'], ['faq.1a', 'faq', 'جواب 1', 'Answer 1', 1], ['faq.2q', 'faq', 'سؤال 2', 'Question 2'], ['faq.2a', 'faq', 'جواب 2', 'Answer 2', 1],
  ['faq.3q', 'faq', 'سؤال 3', 'Question 3'], ['faq.3a', 'faq', 'جواب 3', 'Answer 3', 1], ['faq.4q', 'faq', 'سؤال 4', 'Question 4'], ['faq.4a', 'faq', 'جواب 4', 'Answer 4', 1],
  ['contact.title', 'misc', 'عنوان قسم التواصل', 'Contact title'], ['fin.title', 'misc', 'عنوان الدعوة الأخيرة (التصميم الثاني)', 'Final call title (design 2)'],
].map(([id, group, ar, en, long]) => ({ id, group, ar, en, long: !!long }));
const FIELD = Object.fromEntries(LP_FIELDS.map((x) => [x.id, x]));

export const SITE_DEFAULTS = { design: 'a', mode: 'auto', hide: [], logoUrl: '', seo: { title: '', description: '', google: '', bing: '' }, texts: {} };
const clip = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const token = (v) => { const s = String(v ?? '').trim(); return /^[A-Za-z0-9_-]{10,100}$/.test(s) ? s : ''; }; // رموز توثيق ملكية الموقع (Google/Bing)
const httpsUrl = (v) => { const s = clip(v, 300); return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : ''; };
/** تنظيف إعدادات واجهة الموقع (بيشتغل على السيرفر قبل الحفظ وعند القراءة). بيتجاهل أي قيمة غلط بدل ما يرمي خطأ. */
export function cleanSite(b) {
  const o = b && typeof b === 'object' ? b : {}, texts = {};
  for (const [k, v] of Object.entries(o.texts && typeof o.texts === 'object' ? o.texts : {})) {
    const f = FIELD[k]; if (!f) continue;
    const s = clip(v, f.long ? 600 : 160); if (s) texts[k] = s;
  }
  return {
    design: o.design === 'b' ? 'b' : 'a',
    mode: o.mode === 'light' || o.mode === 'dark' ? o.mode : 'auto',
    hide: [...new Set((Array.isArray(o.hide) ? o.hide : []).filter((x) => LP_SECTIONS.includes(x)))],
    logoUrl: httpsUrl(o.logoUrl),
    seo: { title: clip(o.seo?.title, 70), description: clip(o.seo?.description, 200), google: token(o.seo?.google), bing: token(o.seo?.bing) },
    texts,
  };
}
/** الوضع الافتراضي الفعلي: لو "تلقائي" = وضع التصميم الأصلي (الأول نهاري، الثاني ليلي) */
export const lpDefaultMode = (site) => (site.mode === 'light' || site.mode === 'dark' ? site.mode : site.design === 'b' ? 'dark' : 'light');
