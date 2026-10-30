// تقدير سعر تقريبي قبل التسجيل — من غير أي نقطة جديدة على السيرفر: بنستخدم الأسعار العامة (settings) ونفس معادلة calcPrice.
// المسافة هنا خط مستقيم بين مراكز المدن × معامل الطريق، فالسعر النهائي بيتحسب من المسافة الفعلية على الخريطة بعد التسجيل.
export const CITIES = {
  cairo: ['القاهرة', 'Cairo', 30.0444, 31.2357], giza: ['الجيزة', 'Giza', 30.0131, 31.2089], alex: ['الإسكندرية', 'Alexandria', 31.2001, 29.9187],
  mansoura: ['المنصورة', 'Mansoura', 31.0409, 31.3785], tanta: ['طنطا', 'Tanta', 30.7865, 31.0004], zagazig: ['الزقازيق', 'Zagazig', 30.5877, 31.502],
  portsaid: ['بورسعيد', 'Port Said', 31.2653, 32.3019], suez: ['السويس', 'Suez', 29.9668, 32.5498], ismailia: ['الإسماعيلية', 'Ismailia', 30.5965, 32.2715],
  banha: ['بنها', 'Banha', 30.466, 31.1848], shebin: ['شبين الكوم', 'Shebin El Kom', 30.5503, 31.0107], damanhur: ['دمنهور', 'Damanhur', 31.0409, 30.47],
  fayoum: ['الفيوم', 'Fayoum', 29.3084, 30.8428], beni: ['بني سويف', 'Beni Suef', 29.0661, 31.0994], minya: ['المنيا', 'Minya', 28.1099, 30.7503],
  assiut: ['أسيوط', 'Assiut', 27.1783, 31.1859], sohag: ['سوهاج', 'Sohag', 26.5569, 31.6948], qena: ['قنا', 'Qena', 26.1551, 32.716],
  luxor: ['الأقصر', 'Luxor', 25.6872, 32.6396], aswan: ['أسوان', 'Aswan', 24.0889, 32.8998],
};
export function straightKm(a, b) {
  const R = 6371, d = Math.PI / 180, h = Math.sin(((b[2] - a[2]) * d) / 2) ** 2 + Math.cos(a[2] * d) * Math.cos(b[2] * d) * Math.sin(((b[3] - a[3]) * d) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/** نفس معادلة السيرفر (calcPrice): سعر الكيلومتر × المسافة × معامل النوع × معامل الحجم، وبحد أدنى */
export function priceFromKm(S, km, category, size) {
  const c = S.categories?.[category], z = S.sizes?.[size]; if (!c || !z) return null;
  return Math.max(Math.ceil(S.minPrice), Math.ceil(S.perKm * km * Number(c.mult) * Number(z.mult)));
}
export function estimate(S, from, to, category, size) {
  const a = CITIES[from], b = CITIES[to]; if (!a || !b || from === to) return null;
  const km = Math.max(1, Math.round(straightKm(a, b) * (S.roadFactor || 1.3)));
  const price = priceFromKm(S, km, category, size); return price == null ? null : { km, price };
}

/** ترشيح العربية (نفس منطق السيرفر recommendVehicle): أول عربية مفعّلة وزنها يكفي، وإلا أكبر مفعّلة */
export const VEHICLE_KEYS = ['pickup', 'half_ton', 'truck', 'jumbo'];
export function recommendVehicle(guide, weightKg) {
  const on = VEHICLE_KEYS.filter((k) => guide?.[k]?.maxKg > 0), kg = Number(weightKg);
  if (!on.length) return null;
  return (Number.isFinite(kg) && kg > 0 && on.find((k) => kg <= guide[k].maxKg)) || on[on.length - 1];
}
