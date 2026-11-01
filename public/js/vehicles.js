// رسمات العربيات (SVG) لكروت اختيار العربية، وكبديل لما السواق ما يكونش سجّل صورة حقيقية.
// من غير ألوان ثابتة: الألوان من متغيّرات الثيم في app.css (.vsvg) فبتشتغل في الوضع الفاتح والليلي.
const WHEEL = (x) => `<circle class="wheel" cx="${x}" cy="52" r="7"/><circle class="hub" cx="${x}" cy="52" r="2.6"/>`;
const SHAPES = {
  // ربع نقل: كابينة صغيرة وصندوق مفتوح
  pickup: `<path class="body" d="M16 34h52v16H16z"/><path class="cab" d="M70 24h14l10 12h8v14H70z"/><path class="glass" d="M74 28h9l7 8H74z"/><path class="rail" d="M16 34v-5M68 34v-5"/>${WHEEL(34)}${WHEEL(90)}`,
  // نص نقل: صندوق مقفول متوسط
  half_ton: `<path class="body" d="M8 16h62v34H8z"/><path class="rib" d="M8 28h62"/><path class="cab" d="M72 26h13l10 11h9v13H72z"/><path class="glass" d="M76 30h8l7 7H76z"/>${WHEEL(28)}${WHEEL(90)}`,
  // نقل ثقيل: صندوق طويل وكابينة أعلى وعجلتين ورا
  truck: `<path class="body" d="M3 12h78v38H3z"/><path class="rib" d="M3 25h78M3 38h78"/><path class="cab" d="M83 22h14l10 12h9v16H83z"/><path class="glass" d="M87 26h9l7 8H87z"/>${WHEEL(20)}${WHEEL(40)}${WHEEL(98)}`,
  // جامبو: تريلا حاوية طويلة بـ3 محاور
  jumbo: `<path class="body" d="M2 8h84v42H2z"/><path class="rib" d="M14 8v42M26 8v42M38 8v42M50 8v42M62 8v42M74 8v42"/><path class="cab" d="M88 20h13l9 12h8v18H88z"/><path class="glass" d="M92 24h8l7 8H92z"/>${WHEEL(14)}${WHEEL(32)}${WHEEL(50)}${WHEEL(100)}`,
  // نقل ركاب: ميكروباص
  passengers: `<path class="cab" d="M10 50V28q0-8 8-8h58q10 0 18 12l14 8v10z"/><path class="glass" d="M18 26h14v10H18zM36 26h14v10H36zM54 26h14v10H54zM72 26h8l9 10H72z"/>${WHEEL(34)}${WHEEL(92)}`,
};

// ===== أشكال تانية شائعة في السوق المصري =====
SHAPES.microbus = SHAPES.passengers; // ميكروباص (نفس رسمة الركاب القديمة)
Object.assign(SHAPES, {
  // سيارة ملاكي
  car: `<path class="cab" d="M8 50V40q0-4 4-5l14-4q10-12 24-12h16q14 0 22 12l14 4q4 1 4 5v10z"/><path class="glass" d="M32 31q7-8 18-8h6v8zM60 23h8q9 0 15 8H60z"/>${WHEEL(30)}${WHEEL(92)}`,
  // فان تجاري (هايس / بوكس مقفول)
  van: `<path class="body" d="M10 50V24q0-6 6-6h54v32z"/><path class="cab" d="M72 22h8q10 0 18 10l12 8v10H72z"/><path class="glass" d="M78 26h8l8 8H78z"/><path class="rib" d="M10 34h60"/>${WHEEL(30)}${WHEEL(94)}`,
  // ميني باص: أطول من الميكروباص
  minibus: `<path class="cab" d="M4 50V26q0-8 8-8h78q10 0 18 12l8 6v14z"/><path class="glass" d="M10 25h12v10H10zM25 25h12v10H25zM40 25h12v10H40zM55 25h12v10H55zM70 25h12v10H70zM85 25h8l8 10H85z"/>${WHEEL(26)}${WHEEL(100)}`,
  // توك توك / تروسيكل نقل: عجلة قدام وعجلتين ورا وصندوق مكشوف
  tuktuk: `<path class="body" d="M14 34h56v16H14z"/><path class="rail" d="M14 34v-6M70 34v-6"/><path class="cab" d="M74 26h10q8 0 12 8v16H74z"/><path class="glass" d="M78 29h8l6 6H78z"/>${WHEEL(30)}${WHEEL(52)}${WHEEL(96)}`,
  // ثلاجة (مبرد): صندوق بوحدة تبريد فوق الكابينة وعلامة تلج
  reefer: `<path class="body" d="M3 16h78v34H3z"/><path class="body" d="M62 8h16v8H62z"/><path class="rib" d="M30 33h24M42 22v22M33 24l18 18M51 24l-18 18"/><path class="cab" d="M83 24h14l10 12h9v14H83z"/><path class="glass" d="M87 28h9l7 8H87z"/>${WHEEL(20)}${WHEEL(40)}${WHEEL(98)}`,
  // سطحة: منصة مفتوحة بحمولة
  flatbed: `<path class="body" d="M3 40h82v7H3z"/><path class="body" d="M12 26h24v14H12zM40 30h20v10H40z"/><path class="cab" d="M87 26h12l10 11h9v13H87z"/><path class="glass" d="M91 30h8l7 7H91z"/>${WHEEL(20)}${WHEEL(40)}${WHEEL(98)}`,
  // صهريج: خزان أسطواني
  tanker: `<path class="body" d="M8 34q0-20 20-20h40q20 0 20 20t-20 16H28Q8 50 8 34z"/><path class="rib" d="M30 14v36M50 14v36M70 14v36"/><circle class="hub" cx="50" cy="12" r="3"/><path class="cab" d="M91 28h8l10 10h9v12H91z"/><path class="glass" d="M95 31h6l6 7H95z"/>${WHEEL(22)}${WHEEL(42)}${WHEEL(100)}`,
  // قلاب: صندوق مائل بالرافعة الهيدروليكية
  dump: `<path class="body" d="M4 26L72 14l8 36H4z"/><path class="rib" d="M70 50L40 36"/><path class="cab" d="M84 26h12l10 12h9v12H84z"/><path class="glass" d="M88 30h8l7 8H88z"/>${WHEEL(24)}${WHEEL(44)}${WHEEL(98)}`,
  // ستارة جانبية: صندوق بشرايط قماش مائلة
  curtain: `<path class="body" d="M3 12h78v38H3z"/><path class="rib" d="M3 12l78 38M3 50l78-38"/><path class="cab" d="M83 22h14l10 12h9v16H83z"/><path class="glass" d="M87 26h9l7 8H87z"/>${WHEEL(20)}${WHEEL(40)}${WHEEL(98)}`,
  // ونش / ناقلة سيارات: منصة بعربيتين فوقها
  carcarrier: `<path class="body" d="M3 40h84v6H3z"/><g class="car"><path class="cab" d="M8 40v-6q0-3 3-4l8-2q5-6 11-6h6q7 0 10 7l5 2q2 1 2 4v5z"/><path class="glass" d="M20 28q4-5 9-5h4v5z"/></g><g class="car" transform="translate(40 0)"><path class="cab" d="M8 40v-6q0-3 3-4l8-2q5-6 11-6h6q7 0 10 7l5 2q2 1 2 4v5z"/><path class="glass" d="M20 28q4-5 9-5h4v5z"/></g><path class="cab" d="M89 26h10l9 11h9v13H89z"/><path class="glass" d="M93 30h7l6 7H93z"/>${WHEEL(20)}${WHEEL(40)}${WHEEL(100)}`,
});
export const VEHICLE_SHAPES = Object.keys(SHAPES);
const ALIAS = { passengers: 'passengers' };
export const vehicleImgKey = (type) => (SHAPES[type] ? type : ALIAS[type] || 'half_ton');
export const vehicleSvg = (type, label = '') => `<svg class="vsvg" viewBox="0 0 120 64" role="img"${label ? ` aria-label="${String(label).replace(/[<>"&]/g, '')}"` : ' aria-hidden="true"'}><path class="road" d="M0 59.5h120"/>${SHAPES[vehicleImgKey(type)]}</svg>`;
