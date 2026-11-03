// ملخص المنصة للذكاء الاصطناعي من حقائق النظام الفعلية (بيتغيّر لوحده مع إعدادات الأدمن، فمفيش معلومة قديمة أو غلط).
import { LP_ORIGIN, lpFacts, lpSlots, lpText } from '../../public/js/landing-content.js';

const VEH = { pickup: 'ربع نقل', half_ton: 'نص نقل', truck: 'نقل ثقيل', jumbo: 'جامبو' };
export function buildLlms(s, env, full = false) {
  const f = lpFacts(s, env), slots = lpSlots(f), c = s.company || {}, site = s.site || {};
  const tx = (id) => (site.texts?.[id] || lpText(slots[id].key, slots[id].vars, 'ar')).replace(/\*/g, '');
  const L = [
    '# اشحنلي (Ishhanli)', '',
    '> منصة ويب مصرية تربط عملاء عندهم بضائع أو أثاث أو حمولات بسواقين نقل موثّقين، مع تسعير تلقائي بالجنيه المصري.', '',
    '## عن الخدمة', '- الدولة: مصر — العملة: الجنيه المصري (EGP)', `- التعريف: ${tx('about.p')}`,
    '- العميل: يحدد نقطة الاستلام والتسليم على الخريطة، ويضيف صور الحمولة (اختياري)، ويشوف السعر قبل التأكيد، ويتابع السواق على الخريطة.',
    '- السواق: يقدّم بطاقته ورخصته واستمارة العربية وصورتها، وبتتراجع يدوياً قبل التفعيل.',
    `- السعر: ${tx('price.formula')}${f.minPrice > 0 ? ` أقل سعر للشحنة ${f.minPrice} جنيه.` : ''}`,
    `- الدفع: ${tx('faq.1a')}`, `- المشاكل: ${tx('faq.2a')}`, `- العمولة: ${tx('faq.4a')}`, `- الإثباتات: ${tx('trust.3d')} ${tx('trust.4d')}`,
  ];
  if (f.passengers) L.push(`- حجز عربية: ${tx('svc.pass.d')}`);
  L.push('- الشركات: ' + tx('svc.company.d'));
  if (full) {
    const veh = Object.entries(s.vehicleGuide || {}).filter(([k, v]) => Number(v?.maxKg) > 0 && VEH[k]), cats = Object.values(s.categories || {}).filter((x) => x?.ar);
    L.push('', '## خطوات الطلب', `1. ${tx('how.s1t')}: ${tx('how.s1d')}`, `2. ${tx('how.s2t')}: ${tx('how.s2d')}`, `3. ${tx('how.s3t')}: ${tx('how.s3d')}`);
    if (veh.length) L.push('', '## أنواع العربيات (أقصى وزن)', ...veh.map(([k, v]) => `- ${VEH[k]}: ${Number(v.maxKg).toLocaleString('en-US')} كجم`));
    if (cats.length) L.push('', '## أنواع الحمولة', ...cats.map((x) => `- ${x.ar}`));
    L.push('', '## أسئلة شائعة', ...[1, 2, 3, 4].flatMap((n) => [`### ${tx(`faq.${n}q`)}`, tx(`faq.${n}a`), '']));
  }
  L.push('## الصفحات', `- [الرئيسية](${LP_ORIGIN}/): شرح الخدمة والسعر والأسئلة الشائعة.`, `- [إزاي بتشتغل](${LP_ORIGIN}/how-it-works): خطوات الطلب والدفع والتتبع.`,
    `- [أسعار النقل](${LP_ORIGIN}/pricing): إزاي بيتحسب سعر الشحنة.`, `- [أنواع العربيات](${LP_ORIGIN}/vehicles): العربيات المتاحة وحمولة كل نوع.`,
    `- [للسواقين](${LP_ORIGIN}/for-drivers): التسجيل والمستندات والعمولة.`, `- [لشركات الشحن](${LP_ORIGIN}/for-companies): تسجيل الشركات.`);
  const contact = [c.phone && `تليفون: ${c.phone}`, c.whatsapp && `واتساب: ${c.whatsapp}`, c.email && `إيميل: ${c.email}`, c.address && `العنوان: ${c.address}`].filter(Boolean);
  if (contact.length) L.push('', '## التواصل', ...contact.map((x) => `- ${x}`));
  return L.join('\n') + '\n';
}
