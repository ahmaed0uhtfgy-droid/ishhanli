// إشعارات Push عبر Firebase Cloud Messaging، مبعوتة بـ REST API مباشرة (Cloudflare Workers ماعندوش
// firebase-admin)، بنفس حساب الخدمة المستخدم لـ Firestore بس بصلاحية FCM إضافية.
import { pushTokensCol, presenceCol, usersCol, now, serviceAccount } from './db.js';
import { getAccessToken } from './gcp.js';
import { haversineM, canServe } from './logic.js';
import { trustOf } from './trust.js';

export const pushEnabled = () => true;

/** إرسال إشعار واحد عبر FCM REST API (بدل admin.messaging().send()) — نفس حساب الخدمة، بس بصلاحية FCM.
 *  محتاج تدي الـ Service Account رول إضافي في Google Cloud: "Firebase Cloud Messaging API Admin". */
async function fcmSend(sa, message) {
  const token = await getAccessToken(sa, ['https://www.googleapis.com/auth/firebase.messaging']);
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message }),
  });
  if (!res.ok) { const err = new Error(await res.text()); err.status = res.status; throw err; }
}

// ---------- نصوص الإشعارات (عربي/إنجليزي حسب لغة المستخدم) ----------
const MSG = {
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
  delivered_p: { ar: ['وصلتوا الوجهة؟', 'اضغط «وصلت وجهتي» لتحويل المبلغ للسواق ({no})'], en: ['Have you arrived?', 'Tap "I arrived" to pay the driver ({no})'] },
  new_order: { ar: ['طلب نقل جديد', 'من {from} إلى {to} — {price} ج'], en: ['New delivery request', '{from} → {to} — EGP {price}'] },
  offer: { ar: ['عرض سعر جديد', 'سواق قدّم عرض {price} ج على طلبك {no}'], en: ['New price offer', 'A driver offered EGP {price} on order {no}'] },
  offer_accepted: { ar: ['تم قبول عرضك', 'العميل قبل عرضك ({price} ج) على الطلب {no} — استنى تأكيد الدفع'], en: ['Your offer was accepted', 'The customer accepted your EGP {price} offer on {no} — wait for payment confirmation'] },
  offer_rejected: { ar: ['تم اختيار سواق آخر', 'الطلب {no} اتاخد من سواق تاني'], en: ['Another driver was chosen', 'Order {no} went to another driver'] },
  accepted: { ar: ['سواق قبل طلبك', 'السواق {driver} قبل الطلب {no} — ادفع لتأكيد الحجز'], en: ['A driver accepted your order', 'Driver {driver} accepted {no} — pay to confirm the booking'] },
  proof: { ar: ['إثبات دفع جديد', 'الطلب {no} محتاج مراجعة'], en: ['New payment proof', 'Order {no} needs review'] },
  paid_driver: { ar: ['تم تأكيد الدفع — ابدأ التنفيذ', 'المبلغ محجوز للطلب {no}'], en: ['Payment confirmed — start the job', 'Funds are held for order {no}'] },
  paid_customer: { ar: ['تم تأكيد دفعك', 'المبلغ محجوز وهيبدأ السواق تنفيذ الطلب {no}'], en: ['Payment confirmed', 'Funds are held and the driver will start order {no}'] },
  payment_rejected: { ar: ['إثبات الدفع مرفوض', 'راجع سبب الرفض وارفع إثبات جديد للطلب {no}'], en: ['Payment proof rejected', 'Check the reason and upload a new proof for {no}'] },
  heading_pickup: { ar: ['السواق في الطريق', 'السواق بدأ الطريق لاستلام شحنتك ({no})'], en: ['Driver is on the way', 'The driver is heading to pick up your cargo ({no})'] },
  picked_up: { ar: ['تم استلام شحنتك', 'السواق استلم الشحنة {no}'], en: ['Cargo picked up', 'The driver picked up {no}'] },
  in_transit: { ar: ['شحنتك في الطريق', 'السواق بدأ الطريق للتسليم ({no})'], en: ['Your cargo is on the way', 'The driver is heading to the drop-off ({no})'] },
  delivered: { ar: ['وصلت شحنتك؟', 'راجع الصور واضغط «وصلت شحنتي» لتحويل المبلغ للسواق ({no})'], en: ['Has your cargo arrived?', 'Check the photos and tap "My shipment arrived" to pay the driver ({no})'] },
  completed: { ar: ['وصلت مستحقاتك', '+{net} ج في محفظتك من الطلب {no}'], en: ['You got paid', '+EGP {net} added to your wallet from {no}'] },
  dispute: { ar: ['تم فتح نزاع', 'فيه نزاع على الطلب {no}. المبلغ محجوز لحد قرار الإدارة'], en: ['A dispute was opened', 'There is a dispute on order {no}. Funds stay held until support decides'] },
  account_active: { ar: ['تم تفعيل حسابك', 'تقدر تستخدم المنصة دلوقتي'], en: ['Your account is active', 'You can now use the platform'] },
  account_rejected: { ar: ['تعذّر تفعيل حسابك', 'راجع السبب داخل التطبيق'], en: ['We could not activate your account', 'Open the app to see the reason'] },
  withdrawal_paid: { ar: ['تم تحويل مبلغ السحب', 'تم تحويل {amount} ج'], en: ['Withdrawal sent', 'EGP {amount} was transferred'] },
  withdrawal_rejected: { ar: ['تم رفض طلب السحب', 'رجع المبلغ {amount} ج لمحفظتك'], en: ['Withdrawal rejected', 'EGP {amount} was returned to your wallet'] },
};
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));
export const orderNo = (id) => '#' + String(id).slice(0, 6).toUpperCase();

/** يبعت إشعار لمجموعة مستخدمين. ما بيرميش أخطاء أبداً. بيرجّع عدد الإشعارات اللي اتبعتت. */
export async function notify(uids, type, vars = {}, { url = '/', tag } = {}) {
  try {
    if (!uids?.length || !MSG[type]) return 0;
    const ids = [...new Set(uids)].slice(0, 12);
    const [userSnaps, tokenSnaps] = await Promise.all([
      Promise.all(ids.map((uid) => usersCol().doc(uid).get())),
      Promise.all(ids.map((uid) => pushTokensCol().where('uid', '==', uid).get())),
    ]);
    const langOf = Object.fromEntries(ids.map((uid, i) => [uid, userSnaps[i].data()?.lang]));
    const rows = [];
    tokenSnaps.forEach((snap, i) => { const uid = ids[i]; snap.forEach((d) => rows.push({ token: d.id, uid, lang: langOf[uid] })); });
    if (!rows.length) return 0;
    const sa = serviceAccount();
    const dead = []; let sent = 0;
    await Promise.all(rows.map(async (r) => {
      const m = MSG[type][r.lang === 'en' ? 'en' : 'ar'];
      try {
        await fcmSend(sa, {
          token: r.token,
          data: { title: fill(m[0], vars), body: fill(m[1], vars), url, tag: tag || type, type },
          android: { priority: 'high' },
          webpush: { headers: { Urgency: 'high', TTL: '300' } },
        });
        sent++;
      } catch (e) {
        // NOT_FOUND / UNREGISTERED = التوكن باين ملغي (المستخدم مسح التطبيق أو رفض الإشعارات) — بنمسحه
        if (e.status === 404 || /UNREGISTERED/i.test(e.message || '')) dead.push(r.token);
        else console.error('fcm_send_failed', e?.message || e);
      }
    }));
    if (dead.length) await Promise.all(dead.map((tk) => pushTokensCol().doc(tk).delete().catch(() => {})));
    return sent;
  } catch (e) { console.error('push_failed', e?.message || e); return 0; }
}

export async function adminIds() {
  const snap = await usersCol().where('role', '==', 'admin').where('status', '==', 'active').limit(20).get();
  return snap.docs.map((d) => d.id);
}

const PRESENCE_TTL_MS = 12 * 3600e3;
const short = (s, n = 28) => { s = String(s || '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s || '—'; };
const BONUS_KM = { new: 0, trusted: 2, pro: 4, elite: 6 };

/**
 * طلب جديد: بنبعت إشعار للسواقين "المتاحين" اللي عربيتهم تناسب الطلب وفي نطاق الخدمة (زي أوبر).
 * ملحوظة أداء: بنقرا كل السواقين المتاحين (driverPresence) ثم نفلتر في الميموري — مناسب لحجم MVP.
 * لو عدد السواقين كبر جداً، الخطوة الطبيعية بعد كده استخدام Geohash + استعلام نطاقي بدل القراءة الكاملة.
 */
export async function dispatchNewOrder(o, settings) {
  try {
    const snap = await presenceCol().where('online', '==', true).where('seenAt', '>', now() - PRESENCE_TTL_MS).limit(500).get();
    if (snap.empty) return 0;
    const uids = snap.docs.map((d) => d.id);
    const userSnaps = await Promise.all(uids.map((uid) => usersCol().doc(uid).get()));
    const rows = snap.docs.map((d, i) => ({ uid: d.id, ...d.data(), user: userSnaps[i].data() }))
      .filter((r) => r.user && r.user.role === 'driver' && r.user.status === 'active');
    const ranked = rows
      .filter((r) => canServe(r.user.vehicleType, o))
      .map((r) => { const km = r.lat == null ? Infinity : haversineM({ lat: r.lat, lng: r.lng }, o.pickup) / 1000; return { uid: r.uid, km, score: km - BONUS_KM[trustOf(r.user).level] }; })
      .filter((r) => r.km === Infinity || r.km <= settings.dispatchRadiusKm)
      .sort((a, b) => (a.score === b.score ? 0 : a.score < b.score ? -1 : 1)).slice(0, settings.dispatchMaxDrivers);
    const trip = o.service === 'passengers';
    return await notify(ranked.map((r) => r.uid), trip ? 'new_trip' : 'new_order',
      { from: short(o.pickup.address), to: short(o.dropoff.address), price: o.price, n: o.passengers }, { url: `/#/order/${o.id}`, tag: 'order-' + o.id });
  } catch (e) { console.error('dispatch_failed', e?.message || e); return 0; }
}
