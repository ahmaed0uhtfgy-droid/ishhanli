// قواعد التعامل: كل قاعدة هنا مبنية على سلوك الكود الفعلي، والأرقام بتتسحب من إعدادات الأدمن (فمش بتتعارض معاها).
// بيرجّع مجموعات: { id, rules: [{ id, vars }] } والنصوص من i18n (rules.<id>.t / .d)
const n = (v, d) => (Number.isFinite(+v) && v !== '' && v !== null && v !== undefined ? +v : d);

export function rulesSections(S = {}) {
  const nd = S.newDriver || {};
  const v = {
    max: n(S.maxCancellations, 5), grace: n(S.prepaidGraceMin, 30),
    dp: n(S.cancelPaidDriverPct, 10), pp: n(S.cancelPaidPlatformPct, 5), hdp: n(S.cancelHeadingDriverPct, 30), hpp: n(S.cancelHeadingPlatformPct, 10),
    commission: n(S.commissionPct, 12), newOrders: n(nd.orders, 0), newPct: n(nd.commissionPct, 0),
    geo: n(S.geofenceMeters, 0), autoHours: n(S.autoReleaseHours, 0), maxActive: n(S.maxActiveJobs, 1), comp: n(S.mismatchCompensation, 0), mismatchMax: n(S.mismatchMaxPer30d, 3), buffer: n(S.deliveryBufferMin, 60), offerMin: n(S.offerMinPct, 70), offerMax: n(S.offerMaxPct, 200), minW: n(S.minWithdraw, 100),
    guardFrom: n(S.valueGuardFrom, 20000), late: n(S.latePointsLimit, 5),
  };
  const code = S.deliveryCode === true && S.deliveryCodeAvailable === true;
  const guard = S.valueGuardOn === true && S.deliveryCodeAvailable === true; // حراسة القيمة شغّالة فعلاً (محتاجة سر الكود)
  const R = (id, show = true) => (show ? { id, vars: v } : null);
  return [
    { id: 'all', rules: [R('a1'), R('a2'), R('a3'), R('a4'), R('a5'), R('a6'), R('a8'), R('a9'), R('a7', v.autoHours > 0)].filter(Boolean) },
    { id: 'customer', rules: [R('c1'), R('c2'), R('c3'), R('c4'), R('c5'), R('c6'), R('c7', v.grace > 0), R('c8', code), R('c9'), R('c10', S.startCode === true && S.deliveryCodeAvailable === true), R('c11'), R('c12', guard), R('c13')].filter(Boolean) },
    { id: 'driver', rules: [R('d1'), R('d1b', v.newOrders > 0), R('d2'), R('d3', v.geo > 0), R('d4'), R('d5', S.offersEnabled !== false), R('d6'), R('d7'), R('d8'), R('d9', code), R('d10'), R('d11', S.startCode === true && S.deliveryCodeAvailable === true), R('d12', guard), R('d13'), R('d14', v.late > 0)].filter(Boolean) },
    { id: 'company', rules: [R('k1'), R('k2'), R('k3'), R('k4')].filter(Boolean) },
  ];
}
