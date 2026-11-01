// إشعارات Push عبر Firebase Cloud Messaging (مجاني، بدون كارت). اختيارية: لو `FIREBASE_SERVICE_ACCOUNT` مش متحط،
// كل الدوال هنا بتبقى no-op والمنصة بتشتغل عادي (بالتحديث الدوري).
// كل الإرسال بيتم في الخلفية (waitUntil) وما بيوقفش الطلب، وأي فشل بيتسجّل بس ومش بيكسّر العملية الأساسية.
import { F } from './db.js';
import { googleToken, serviceAccount } from './gauth.js';
import { haversineM, canServe } from './logic.js';
import { trustOf } from './trust.js';

// الإشعارات شغّالة تلقائياً مع حساب الخدمة (نفس المفتاح بتاع Firestore). PUSH_DISABLED=1 بيوقفها من غير ما يأثر على باقي الموقع.
export const pushEnabled = (env) => !!env.FIREBASE_SERVICE_ACCOUNT && String(env.PUSH_DISABLED ?? '') !== '1';
const accessToken = (env) => googleToken(env, 'https://www.googleapis.com/auth/firebase.messaging');

// رسالة data فقط (الـ Service Worker هو اللي بيعرض الإشعار) — مع أولوية عالية عشان توصل فوراً
async function sendOne(env, bearer, deviceToken, data) {
  const project = serviceAccount(env).project_id || env.FIREBASE_PROJECT_ID;
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${project}/messages:send`, {
    method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token: deviceToken, data, android: { priority: 'high' }, webpush: { headers: { Urgency: 'high', TTL: '300' } } } }),
  });
  if (r.ok) return 'ok';
  const txt = await r.text().catch(() => '');
  if (r.status === 404 || /UNREGISTERED|NOT_FOUND/.test(txt) || (r.status === 400 && /registration token/i.test(txt))) return 'gone'; // الجهاز مبقاش صالح
  console.error('fcm_send_failed', r.status, txt.slice(0, 200));
  return 'error';
}

// ---------- نصوص الإشعارات (عربي/إنجليزي حسب لغة المستخدم) ----------
const MSG = {
  auto_released: { ar: ['تم تحويل المبلغ للسواق', 'الطلب {no}: عدّت {hours} ساعة على التسليم من غير اعتراض فاتحوّل المبلغ للسواق تلقائياً. لو فيه مشكلة تواصل معانا.'], en: ['Payment released to the driver', 'Order {no}: {hours} hours passed after delivery without a dispute, so the payment was released to the driver automatically. Contact us if something is wrong.'] },
  admin_released: { ar: ['تم تحويل المبلغ للسواق', 'الطلب {no}: الإدارة حوّلت المبلغ للسواق بعد مراجعة التسليم. لو فيه مشكلة تواصل معانا.'], en: ['Payment released to the driver', 'Order {no}: the admin released the payment to the driver after reviewing the delivery. Contact us if something is wrong.'] },
  cod_collected: { ar: ['السواق استلم مبلغ التحصيل', 'الطلب {no}: السواق استلم {amount} جنيه من المستلم. هيتحوّل لك بعد ما السواق يسدّد للمنصة.'], en: ['The driver collected the payment', 'Order {no}: the driver collected {amount} EGP from the recipient. It will be transferred to you once the driver settles with the platform.'] },
  accepted_direct: { ar: ['السواق قبل طلبك', 'السواق {driver} قبل الطلب {no}. الدفع للسواق مباشرة عند الاستلام/التسليم (من غير دفع على المنصة).'], en: ['A driver accepted your order', 'Driver {driver} accepted order {no}. You pay the driver directly (no payment on the platform).'] },
  delivered_direct: { ar: ['تم تسليم طلبك', 'الطلب {no}: السواق أكّد التسليم وتم إكمال الطلب. تقدر تقيّمه من صفحة الطلب.'], en: ['Your order was delivered', 'Order {no}: the driver confirmed delivery and the order is complete. You can rate the driver on the order page.'] },
  direct_auto: { ar: ['اتكمّل الطلب تلقائياً', 'الطلب {no}: عدّت {hours} ساعة من الاستلام من غير تأكيد تسليم، فاتحسب مسلَّم واتكمّل.'], en: ['Order completed automatically', 'Order {no}: {hours} hours passed since pickup with no delivery confirmation, so it was marked delivered and completed.'] },
  direct_confirmed: { ar: ['العميل أكّد الاستلام', 'العميل أكّد استلام الطلب {no} واتكمّل.'], en: ['Customer confirmed receipt', 'The customer confirmed receiving order {no} and it is complete.'] },
  dc_review: { ar: ['سداد عمولة جديد للمراجعة', 'السواق {name} بعت تحويل {amount} جنيه (عمولة المنصة). راجعه وأكّده.'], en: ['New commission payment to review', 'Driver {name} sent a transfer of {amount} EGP (platform commission). Review and confirm it.'] },
  dc_paid: { ar: ['تم تأكيد سداد العمولة', 'الإدارة أكدت سداد {amount} جنيه. حسابك شغّال وتقدر تقبل طلبات جديدة.'], en: ['Commission payment confirmed', 'The admin confirmed your payment of {amount} EGP. Your account is active and you can accept new orders.'] },
  dc_rejected: { ar: ['تم رفض إثبات سداد العمولة', 'الإدارة رفضت إثبات السداد ({amount} جنيه). راجع السبب وابعت تحويل صحيح عشان حسابك يرجع يقبل طلبات.'], en: ['Commission payment proof rejected', 'The admin rejected your payment proof ({amount} EGP). Check the reason and send a valid transfer so your account can accept orders again.'] },
  cod_paid: { ar: ['تم تأكيد سداد حسابك', 'الإدارة أكدت سداد {amount} جنيه من مبالغ الدفع عند الاستلام.'], en: ['Your settlement was confirmed', 'The admin confirmed your settlement of {amount} EGP for cash-on-delivery collections.'] },
  cod_payout: { ar: ['تم تحويل مبلغ التحصيل لك', 'الطلب {no}: تم تحويل {net} جنيه (مبلغ التحصيل بعد خصم العمولة) لك.'], en: ['Your collected amount was transferred', 'Order {no}: {net} EGP (collected amount after commission) was transferred to you.'] },
  trip_started: { ar: ['السواق بدأ الرحلة', 'السواق دخل كود البداية للطلب {no}. الرحلة بدأت وتقدر تتابع العدّاد في صفحة الطلب.'], en: ['The trip has started', 'The driver entered the start code for order {no}. Follow the timer on the order page.'] },
  trip_started_nocode: { ar: ['السواق بدأ الرحلة بدون كود', 'السواق بدأ الرحلة للطلب {no} من غير كود البداية. لو ده غلط راجع الطلب.'], en: ['Trip started without a code', 'The driver started order {no} without the start code. Check the order if this is wrong.'] },
  late_ask_pickup: { ar: ['السواق اتأخر عن ميعاد الاستلام', 'الطلب {no}: السواق عدّى ميعاد الاستلام + المدة المسموحة. افتح الطلب وقرر: سجّل نقطة تأخير أو سامحه.'], en: ['Driver missed the pickup time', 'Order {no}: the driver passed the pickup time plus the allowed delay. Open the order: record a late point or forgive.'] },
  late_ask_delivery: { ar: ['السواق اتأخر عن ميعاد التسليم', 'الطلب {no}: السواق عدّى ميعاد التسليم + المدة المسموحة. افتح الطلب وقرر: سجّل نقطة تأخير أو سامحه.'], en: ['Driver missed the delivery time', 'Order {no}: the driver passed the delivery time plus the allowed delay. Open the order: record a late point or forgive.'] },
  late_point: { ar: ['اتسجّلت عليك نقطة تأخير', 'العميل سجّل نقطة تأخير على الطلب {no}. شوف نقاطك في لوحة السواق.'], en: ['A late point was recorded', 'The customer recorded a late point on order {no}. See your points on the driver dashboard.'] },
  late_limit: { ar: ['سواق وصل لحد نقاط التأخير', 'السواق {name} وصل {n} نقاط تأخير. راجعه: حظر أو مسح النقاط.'], en: ['Driver reached the late-points limit', 'Driver {name} reached {n} late points. Review: ban or clear the points.'] },
  time_proposed: { ar: ['السواق اقترح تعديل المواعيد', 'السواق اقترح ميعاد جديد للطلب {no}. افتح الطلب ووافق أو ارفض.'], en: ['Driver proposed new times', 'The driver proposed new times for order {no}. Open it to accept or decline.'] },
  time_agreed: { ar: ['العميل وافق على المواعيد', 'العميل وافق على المواعيد الجديدة للطلب {no}.'], en: ['Customer accepted the times', 'The customer accepted the new times for order {no}.'] },
  time_rejected: { ar: ['العميل رفض المواعيد', 'العميل رفض المواعيد المقترحة للطلب {no}. تقدر تقترح غيرها.'], en: ['Customer declined the times', 'The customer declined the proposed times for order {no}. You can propose others.'] },
  late_delivery: { ar: ['الطلب اتأخر', 'الطلب {no} عدّى الوقت المتوقع للتسليم. افتح الطلب وراجعه.'], en: ['Order is late', 'Order {no} passed its expected delivery time. Open it to review.'] },
  stall_alert: { ar: ['السواق واقف', 'السواق واقف في مكانه من فترة في الطلب {no}. راجع الطلب.'], en: ['Driver has stopped', 'The driver has been stationary for a while on order {no}. Please check.'] },
  goods_mismatch: { ar: ['السواق رفض الاستلام', 'السواق رفض استلام الطلب {no} لأن الشحنة مش زي الوصف. تعويضه {amount} ج والباقي هيترد لك.'], en: ['Driver declined pickup', 'The driver declined order {no} because the cargo did not match the description. Compensation EGP {amount}; the rest will be refunded.'] },
  missing_report: { ar: ['بلاغ فقدان شحنة', 'عميل بلّغ إن الشحنة في الطلب {no} مفقودة. محفظة السواق اتجمّدت لحد القرار.'], en: ['Missing cargo report', 'A customer reported the cargo missing on order {no}. The driver wallet is frozen until a decision.'] },
  cancel_comp: { ar: ['تم إلغاء الطلب', 'العميل لغى الطلب {no}. تم إضافة {amount} ج تعويض لمحفظتك'], en: ['Order cancelled', 'The customer cancelled {no}. EGP {amount} compensation was added to your wallet'] },
  cancel_plain: { ar: ['تم إلغاء الطلب', 'العميل لغى الطلب {no}'], en: ['Order cancelled', 'The customer cancelled {no}'] },
  driver_cancelled: { ar: ['السواق اعتذر عن الطلب', 'الطلب {no} رجع ظاهر لسواقين تانيين ومبلغك لسه محجوز'], en: ['The driver withdrew', 'Order {no} is visible to other drivers again and your payment is still held'] },
  report: { ar: ['بلاغ جديد', 'بلاغ من {name} على الطلب {no}'], en: ['New report', 'Report from {name} on order {no}'] },
  report_handled: { ar: ['تمت مراجعة بلاغك', 'الإدارة راجعت بلاغك على الطلب {no}'], en: ['Your report was reviewed', 'Support reviewed your report on order {no}'] },
  sos: { ar: ['استغاثة أثناء رحلة', '{name} ضغط زر الطوارئ في الطلب {no}. افتح لوحة الأدمن فوراً'], en: ['Emergency during a trip', '{name} pressed the emergency button on order {no}. Open the admin panel now'] },
  prepaid_open: { ar: ['تم تأكيد دفعك', 'طلبك {no} ظاهر للسواقين دلوقتي. لو ماحدش قبله هنرجّع لك فلوسك'], en: ['Payment confirmed', 'Order {no} is now visible to drivers. If nobody accepts it, you will be refunded'] },
  accepted_prepaid: { ar: ['سواق قبل طلبك', 'السواق {driver} قبل الطلب {no} وهيبدأ التنفيذ'], en: ['A driver accepted your order', 'Driver {driver} accepted {no} and will start'] },
  refund_due: { ar: ['طلب استرجاع جديد', 'الطلب {no}: {amount} ج محتاج تحويل للعميل'], en: ['New refund request', 'Order {no}: EGP {amount} to transfer back to the customer'] },
  refund_pending: { ar: ['تم تسجيل طلب الاسترجاع', 'هنحوّل {amount} ج على InstaPay قريباً ({no})'], en: ['Refund requested', 'We will transfer EGP {amount} back via InstaPay soon ({no})'] },
  refund_paid: { ar: ['تم رد المبلغ', 'تم تحويل {amount} ج ليك ({no})'], en: ['Refund sent', 'EGP {amount} was transferred to you ({no})'] },
  chat: { ar: ['رسالة من {name}', '{text}'], en: ['Message from {name}', '{text}'] },
  new_trip: { ar: ['طلب نقل ركاب جديد', 'من {from} إلى {to} — {n} ركاب — {price} ج'], en: ['New passenger trip', '{from} → {to} — {n} passengers — EGP {price}'] },
  heading_pickup_p: { ar: ['السواق في الطريق ليك', 'السواق بدأ الطريق لاستقبالكم ({no})'], en: ['Driver is on the way', 'The driver is heading to pick you up ({no})'] },
  picked_up_p: { ar: ['الرحلة بدأت', 'الركاب ركبوا — رحلة سعيدة ({no})'], en: ['Trip started', 'Passengers are on board ({no})'] },
  in_transit_p: { ar: ['في الطريق للوجهة', 'السواق بدأ الطريق للوجهة ({no})'], en: ['On the way', 'The driver is heading to the destination ({no})'] },
  delivered_p: { ar: ['وصلتوا الوجهة؟', 'اضغط «وصلت وجهتي» لتحويل المبلغ للسواق ({no})'], en: ['Have you arrived?', 'Tap “I arrived” to pay the driver ({no})'] },
  new_order: { ar: ['طلب نقل جديد', 'من {from} إلى {to} — {price} ج'], en: ['New delivery request', '{from} → {to} — EGP {price}'] },
  offer: { ar: ['عرض سعر جديد', 'سواق قدّم عرض {price} ج على طلبك {no}'], en: ['New price offer', 'A driver offered EGP {price} on order {no}'] },
  offer_accepted: { ar: ['تم قبول عرضك', 'العميل قبل عرضك ({price} ج) على الطلب {no} — استنى تأكيد الدفع'], en: ['Your offer was accepted', 'The customer accepted your EGP {price} offer on {no} — wait for payment confirmation'] },
  offer_rejected: { ar: ['تم اختيار سواق آخر', 'الطلب {no} اتاخد من سواق تاني'], en: ['Another driver was chosen', 'Order {no} went to another driver'] },
  accepted: { ar: ['سواق قبل طلبك', 'السواق {driver} قبل الطلب {no} — ادفع لتأكيد الحجز'], en: ['A driver accepted your order', 'Driver {driver} accepted {no} — pay to confirm the booking'] },
  handler_assigned: { ar: ['تم تحديد سواق الشحنة', 'السواق {name} (لوحة {plate}) هيستلم الطلب {no}'], en: ['Your shipment driver is set', 'Driver {name} (plate {plate}) will pick up {no}'] },
  proof: { ar: ['إثبات دفع جديد', 'الطلب {no} محتاج مراجعة'], en: ['New payment proof', 'Order {no} needs review'] },
  paid_driver: { ar: ['تم تأكيد الدفع — ابدأ التنفيذ', 'المبلغ محجوز للطلب {no}'], en: ['Payment confirmed — start the job', 'Funds are held for order {no}'] },
  paid_customer: { ar: ['تم تأكيد دفعك', 'المبلغ محجوز وهيبدأ السواق تنفيذ الطلب {no}'], en: ['Payment confirmed', 'Funds are held and the driver will start order {no}'] },
  payment_rejected: { ar: ['إثبات الدفع مرفوض', 'راجع سبب الرفض وارفع إثبات جديد للطلب {no}'], en: ['Payment proof rejected', 'Check the reason and upload a new proof for {no}'] },
  heading_pickup: { ar: ['السواق في الطريق', 'السواق بدأ الطريق لاستلام شحنتك ({no})'], en: ['Driver is on the way', 'The driver is heading to pick up your cargo ({no})'] },
  picked_up: { ar: ['تم استلام شحنتك', 'السواق استلم الشحنة {no}'], en: ['Cargo picked up', 'The driver picked up {no}'] },
  in_transit: { ar: ['شحنتك في الطريق', 'السواق بدأ الطريق للتسليم ({no})'], en: ['Your cargo is on the way', 'The driver is heading to the drop-off ({no})'] },
  delivered: { ar: ['وصلت شحنتك؟', 'راجع الصور واضغط «وصلت شحنتي» لتحويل المبلغ للسواق ({no})'], en: ['Has your cargo arrived?', 'Check the photos and tap “My shipment arrived” to pay the driver ({no})'] },
  completed: { ar: ['وصلت مستحقاتك', '+{net} ج في محفظتك من الطلب {no}'], en: ['You got paid', '+EGP {net} added to your wallet from {no}'] },
  dispute: { ar: ['تم فتح نزاع', 'فيه نزاع على الطلب {no}. المبلغ محجوز لحد قرار الإدارة'], en: ['A dispute was opened', 'There is a dispute on order {no}. Funds stay held until support decides'] },
  account_active: { ar: ['تم تفعيل حسابك', 'تقدر تستخدم المنصة دلوقتي'], en: ['Your account is active', 'You can now use the platform'] },
  account_rejected: { ar: ['تعذّر تفعيل حسابك', 'راجع السبب داخل التطبيق'], en: ['We could not activate your account', 'Open the app to see the reason'] },
  withdrawal_paid: { ar: ['تم تحويل مبلغ السحب', 'تم تحويل {amount} ج'], en: ['Withdrawal sent', 'EGP {amount} was transferred'] },
  withdrawal_rejected: { ar: ['تم رفض طلب السحب', 'رجع المبلغ {amount} ج لمحفظتك'], en: ['Withdrawal rejected', 'EGP {amount} was returned to your wallet'] },
  quota_alert: { ar: ['تنبيه استهلاك Firestore', 'قراءات النهارده {reads} (الحد {limit}). راجع تاب المراقبة'], en: ['Firestore usage alert', 'Today’s reads: {reads} (limit {limit}). Check the Monitoring tab'] },
};
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));
export const orderNo = (id) => '#' + String(id).slice(0, 6).toUpperCase();

/** يبعت إشعار لمجموعة مستخدمين. ما بيرميش أخطاء أبداً. بيرجّع عدد الإشعارات اللي اتبعتت. */
export async function notify(env, uids, type, vars = {}, { url = '/', tag } = {}) {
  try {
    if (!pushEnabled(env) || !uids?.length || !MSG[type]) return 0;
    const ids = [...new Set(uids)].slice(0, 12);
    // حد أقصى 30 جهاز في الإرسال الواحد (الخطة المجانية = 50 subrequest للطلب الكامل)
    const toks = (await F.query(env, 'push_tokens', { inn: { uid: ids } })).slice(0, 30);
    const users = await F.getMany(env, 'users', toks.map((t) => t.uid), ['lang']);
    const rows = toks.map((t, i) => ({ id: t._id, token: t.token, lang: users[i]?.lang })).filter((_, i) => users[i]);
    if (!rows.length) return 0;
    const bearer = await accessToken(env);
    const dead = []; let sent = 0;
    await Promise.all(rows.map(async (r) => {
      const m = MSG[type][r.lang === 'en' ? 'en' : 'ar'];
      const res = await sendOne(env, bearer, r.token, { title: fill(m[0], vars), body: fill(m[1], vars), url, tag: tag || type, type });
      if (res === 'ok') sent++; else if (res === 'gone') dead.push(r.id);
    }));
    if (dead.length) await F.run(env, dead.map((id) => F.del(`push_tokens/${id}`)));
    return sent;
  } catch (e) { console.error('push_failed', e?.message || e); return 0; }
}

export async function adminIds(env) {
  return (await F.query(env, 'users', { eq: { role: 'admin', status: 'active' }, limit: 20 })).map((r) => r.uid);
}

const PRESENCE_TTL_MS = 12 * 3600e3;
const short = (s, n = 28) => { s = String(s || '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s || '—'; };

const BONUS_KM = { new: 0, trusted: 2, pro: 4, elite: 6 }; // أولوية الإشعار: مستوى الثقة بيقرّب السواق "افتراضياً" بالكيلومترات

/**
 * طلب جديد: بنبعت إشعار للسواقين "المتاحين" اللي عربيتهم تناسب الطلب وفي نطاق الخدمة (زي أوبر).
 * الترتيب بالأقرب، مع أفضلية للمستويات العليا (نخبة = كأنه أقرب بـ 6 كم). باقي السواقين بيشوفوا الطلب في قائمة المتاح.
 */
export async function dispatchNewOrder(env, o, settings) {
  try {
    if (!pushEnabled(env)) return 0;
    const pres = (await F.query(env, 'driver_presence', { eq: { online: true }, limit: 300 })).filter((p) => p.seen_at > Date.now() - PRESENCE_TTL_MS); // "متاح" بيتنسي بعد 12 ساعة
    const us = await F.getMany(env, 'users', pres.map((p) => p.uid));
    const rows = pres.map((p, i) => ({ ...us[i], uid: p.uid, lat: p.lat, lng: p.lng })).filter((r, i) => us[i] && r.status === 'active' && r.role === 'driver');
    const ranked = rows
      .filter((r) => canServe(r.vehicle_type, o))
      .map((r) => { const km = r.lat == null ? Infinity : haversineM({ lat: r.lat, lng: r.lng }, o.pickup) / 1000; return { uid: r.uid, km, score: km - BONUS_KM[trustOf(r, settings).level] }; })
      .filter((r) => r.km === Infinity || r.km <= settings.dispatchRadiusKm)
      .sort((a, b) => (a.score === b.score ? 0 : a.score < b.score ? -1 : 1)).slice(0, settings.dispatchMaxDrivers);
    const trip = o.service === 'passengers';
    return await notify(env, ranked.map((r) => r.uid), trip ? 'new_trip' : 'new_order',
      { from: short(o.pickup.address), to: short(o.dropoff.address), price: o.price, n: o.passengers }, { url: `/#/order/${o.id}`, tag: 'order-' + o.id });
  } catch (e) { console.error('dispatch_failed', e?.message || e); return 0; }
}
