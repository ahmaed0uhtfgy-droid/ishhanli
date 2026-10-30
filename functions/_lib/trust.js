// نظام ثقة السواقين: مستوى + شارات بيتحسبوا تلقائياً من **تقييم العميل بالنجوم** (متوسط النجوم + حد أدنى لعدد التقييمات).
// الرحلات المكتملة ونسبة الإلغاء بقوا للعرض بس (مش شرط في المستوى). الحدود من إعدادات الأدمن (settings.trustRules)، ولو مفيش بتاخد القيم الافتراضية.
// الحساب هنا على السيرفر (مصدر واحد للحقيقة) والواجهة بس بتعرضه.
export const DEFAULT_TRUST = { trusted: { avg: 4.0, ratings: 3 }, pro: { avg: 4.5, ratings: 10 }, elite: { avg: 4.7, ratings: 20 } };
const ORDER = ['elite', 'pro', 'trusted']; // من الأعلى للأدنى
const rulesOf = (s) => ORDER.map((level) => ({ level, ratings: (s?.trustRules?.[level] || DEFAULT_TRUST[level]).ratings, avg: (s?.trustRules?.[level] || DEFAULT_TRUST[level]).avg }));
const r1 = (n) => Math.round(n * 10) / 10;

/** u = مستند من مجموعة users (أسماء snake_case). s = الإعدادات (اختياري، للحدود من الأدمن). */
export function trustOf(u, s) {
  const RULES = rulesOf(s);
  const trips = u.completed_orders || 0, ratings = u.rating_count || 0, cancels = u.cancel_count || 0;
  const avg = ratings ? u.rating_sum / ratings : 0;
  const cancelPct = trips + cancels ? (cancels / (trips + cancels)) * 100 : 0;
  const idx = RULES.findIndex((r) => ratings >= r.ratings && avg >= r.avg);
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
    next: nextRule && { level: nextRule.level, ratings: nextRule.ratings, avg: nextRule.avg },
  };
}
