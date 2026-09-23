// نظام ثقة السواقين: مستوى + شارات بيتحسبوا تلقائياً من (الرحلات المكتملة، متوسط التقييم، نسبة الإلغاء).
// الحساب هنا على السيرفر (مصدر واحد للحقيقة) والواجهة بس بتعرضه. الحدود ثابتة دلوقتي وممكن نحوّلها لإعدادات أدمن.
const RULES = [ // من الأعلى للأدنى: لازم كل الشروط تتحقق مع بعض
  { level: 'elite', trips: 100, ratings: 20, avg: 4.7, maxCancelPct: 3 },
  { level: 'pro', trips: 25, ratings: 10, avg: 4.5, maxCancelPct: 5 },
  { level: 'trusted', trips: 5, ratings: 3, avg: 4.0, maxCancelPct: 15 },
];
const r1 = (n) => Math.round(n * 10) / 10;

/** u = صف من جدول users (أعمدة SQL) */
export function trustOf(u) {
  const trips = u.completed_orders || 0, ratings = u.rating_count || 0, cancels = u.cancel_count || 0;
  const avg = ratings ? u.rating_sum / ratings : 0;
  const cancelPct = trips + cancels ? (cancels / (trips + cancels)) * 100 : 0;
  const idx = RULES.findIndex((r) => trips >= r.trips && ratings >= r.ratings && avg >= r.avg && cancelPct <= r.maxCancelPct);
  const level = idx === -1 ? 'new' : RULES[idx].level;
  const nextRule = idx === -1 ? RULES[RULES.length - 1] : idx === 0 ? null : RULES[idx - 1];
  const badges = [];
  if (u.status === 'active') badges.push('verified');                 // الأدمن راجع البطاقة والرخصة والاستمارة
  if (u.phone_verified) badges.push('phone');
  if (ratings >= 20 && avg >= 4.8) badges.push('top_rated');
  if (trips >= 15 && cancels === 0) badges.push('reliable');
  return {
    level, badges,
    stats: { trips, ratingCount: ratings, ratingAvg: r1(avg), cancels, cancelPct: r1(cancelPct) },
    next: nextRule && { level: nextRule.level, trips: nextRule.trips, ratings: nextRule.ratings, avg: nextRule.avg, maxCancelPct: nextRule.maxCancelPct },
  };
}
