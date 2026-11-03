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
    dcPct: n(S.dcPct, 2), dcLimit: n(S.dcLimit, 1000), perKm: n(S.dcPerKm, 0), autoH: n(S.dcAutoCompleteHours, 0), radius: n(S.jobsRadiusKm, 0),
    fFree: n(S.fineFreeCancelMin, 2), fWait: n(S.fineWaitMin, 10), fEn: n(S.fineEnRouteAmount, 15), fAr: n(S.fineArrivedAmount, 30), fClaim: n(S.fineClaimHours, 12), fObj: n(S.fineObjectHours, 24),
    fShare: n(S.fineDriverSharePct, 50), fCap: n(S.fineMonthlyCap, 0), fKeep: n(S.fineCollectorPct, 0), samePickup: n(S.samePickupMax, 0), sameM: n(S.samePickupMeters, 300),
    codMax: n(S.codMaxAmount, 5000), codPct: n(S.codCommissionPct, 0), codPeriod: n(S.codPeriodDays, 7), codGrace: n(S.codGraceDays, 3),
  };
  const code = S.deliveryCode === true && S.deliveryCodeAvailable === true;
  const guard = S.valueGuardOn === true && S.deliveryCodeAvailable === true; // حراسة القيمة شغّالة فعلاً (محتاجة سر الكود)
  const direct = S.dcEnabled === true, fines = direct && S.finesEnabled === true, feesOn = direct && (v.dcPct > 0 || v.perKm > 0 || ['pickup', 'half_ton', 'truck', 'jumbo'].some((k) => S.vehiclePricing?.[k]?.kmFee > 0));
  const vehPrice = ['pickup', 'half_ton', 'truck', 'jumbo'].some((k) => S.vehiclePricing?.[k]?.perKm > 0);
  const R = (id, show = true) => (show ? { id, vars: v } : null);
  return [
    { id: 'all', rules: [R('a1'), R('a2'), R('a3'), R('a4'), R('a5'), R('a6'), R('a8'), R('a9'), R('a7', v.autoHours > 0), R('a10', direct), R('a11', vehPrice)].filter(Boolean) },
    { id: 'customer', rules: [R('c1'), R('c2'), R('c3'), R('c4'), R('c5'), R('c6'), R('c7', v.grace > 0), R('c8', code), R('c9'), R('c10', S.startCode === true && S.deliveryCodeAvailable === true), R('c11'), R('c12', guard), R('c13'), R('c14', S.codEnabled === true), R('c15', S.codEnabled === true && v.codPct > 0), R('c16', direct), R('c16a', direct && v.autoH > 0), R('c17', fines), R('c18', v.samePickup > 0), R('c19')].filter(Boolean) },
    { id: 'driver', rules: [R('d1'), R('d1b', v.newOrders > 0), R('d2'), R('d3', v.geo > 0), R('d4'), R('d5', S.offersEnabled !== false), R('d6'), R('d7'), R('d8'), R('d9', code), R('d10'), R('d11', S.startCode === true && S.deliveryCodeAvailable === true), R('d12', guard), R('d13'), R('d14', v.late > 0), R('d15', S.codEnabled === true), R('d16', feesOn), R('d16k', direct && v.perKm > 0), R('d16z', direct && !feesOn), R('d17', fines), R('d18', fines), R('d19', v.radius > 0), R('d20', direct && v.autoH > 0)].filter(Boolean) },
    { id: 'company', rules: [R('k1'), R('k2'), R('k3'), R('k4'), R('k5', direct)].filter(Boolean) },
  ];
}
