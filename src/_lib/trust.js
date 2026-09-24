// نظام ثقة السواقين: مستوى + شارات بيتحسبوا تلقائياً من (الرحلات المكتملة، متوسط التقييم، نسبة الإلغاء).
// نفس منطق النسخة الأصلية بالظبط، بس الحقول camelCase دلوقتي (زي ما Firestore بيخزّنها) بدل أعمدة SQL.
const RULES = [
  { level: 'elite', trips: 100, ratings: 20, avg: 4.7, maxCancelPct: 3 },
  { level: 'pro', trips: 25, ratings: 10, avg: 4.5, maxCancelPct: 5 },
  { level: 'trusted', trips: 5, ratings: 3, avg: 4.0, maxCancelPct: 15 },
];
const r1 = (n) => Math.round(n * 10) / 10;

/** u = مستند مستخدم (camelCase) */
export function trustOf(u) {
  const trips = u.completedOrders || 0, ratings = u.ratingCount || 0, cancels = u.cancelCount || 0;
  const avg = ratings ? u.ratingSum / ratings : 0;
  const cancelPct = trips + cancels ? (cancels / (trips + cancels)) * 100 : 0;
  const idx = RULES.findIndex((r) => trips >= r.trips && ratings >= r.ratings && avg >= r.avg && cancelPct <= r.maxCancelPct);
  const level = idx === -1 ? 'new' : RULES[idx].level;
  const nextRule = idx === -1 ? RULES[RULES.length - 1] : idx === 0 ? null : RULES[idx - 1];
  const badges = [];
  if (u.status === 'active') badges.push('verified');
  if (u.phoneVerified) badges.push('phone');
  if (ratings >= 20 && avg >= 4.8) badges.push('top_rated');
  if (trips >= 15 && cancels === 0) badges.push('reliable');
  return {
    level, badges,
    stats: { trips, ratingCount: ratings, ratingAvg: r1(avg), cancels, cancelPct: r1(cancelPct) },
    next: nextRule && { level: nextRule.level, trips: nextRule.trips, ratings: nextRule.ratings, avg: nextRule.avg, maxCancelPct: nextRule.maxCancelPct },
  };
}
