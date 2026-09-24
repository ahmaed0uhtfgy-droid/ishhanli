// نفس واجهة db.js بتاعة نسخة Cloud Functions بالظبط، لكن مبنية فوق عميل REST (lib/firestore.js) بدل
// firebase-admin/firestore. بكده باقي الملفات (logic.js, trust.js, index.js) اتنسخوا/اتحولوا من غير ما
// يحتاجوا يعرفوا حاجة عن الفرق.
import { Firestore, FieldValue } from './firestore.js';
import { HttpError, newId } from './core.js';

let _db = null;
/** لازم تتنادى مرة في أول الطلب (من functions/api/[[route]].js) قبل أي استخدام لباقي الدوال هنا */
export function initDb(serviceAccount) { if (!_db) _db = new Firestore(serviceAccount); return _db; }
export function db() { if (!_db) throw new Error('db_not_initialized'); return _db; }
export function serviceAccount() { return db().rest.sa; } // لاستخدامها في push.js (FCM محتاج نفس حساب الخدمة بصلاحية تانية)

export const now = () => Date.now();

export function mapDbError(e) {
  if (e instanceof HttpError) return e;
  console.error('db_error', e?.message || e);
  return new HttpError(500, 'db_error');
}
export async function runTx(fn) {
  try { return await db().runTransaction(fn); } catch (e) { throw mapDbError(e); }
}

// ---------- المجموعات (getters عشان تتقيّم بعد initDb مش وقت الـ import) ----------
export const usersCol = () => db().collection('users');
export const ordersCol = () => db().collection('orders');
export const walletsCol = () => db().collection('wallets');
export const withdrawalsCol = () => db().collection('withdrawals');
export const disputesCol = () => db().collection('disputes');
export const refundsCol = () => db().collection('refunds');
export const offersCol = () => db().collection('offers');
export const reportsCol = () => db().collection('reports');
export const sosCol = () => db().collection('sosEvents');
export const blacklistCol = () => db().collection('blacklist');
export const uniqueIndexCol = () => db().collection('uniqueIndex');
export const settingsDoc = () => db().collection('settings').doc('pricing');
export const filesMetaCol = () => db().collection('filesMeta');
export const presenceCol = () => db().collection('driverPresence');
export const pushTokensCol = () => db().collection('pushTokens');
export const liveLocCol = () => db().collection('liveLocations');
export const walletTxCol = (uid) => walletsCol().doc(uid).collection('tx');
export const messagesCol = (orderId) => ordersCol().doc(orderId).collection('messages');

// ---------- المحفظة ----------
export function walletCreditTx(tx, uid, amount) {
  const ref = walletsCol().doc(uid);
  tx.set(ref, { uid, balance: FieldValue.increment(amount), totalEarned: FieldValue.increment(Math.max(amount, 0)), updatedAt: now() }, { merge: true });
}
export function walletTxTx(tx, t) {
  const ref = walletTxCol(t.uid).doc(newId());
  tx.set(ref, { id: ref.id, uid: t.uid, type: t.type, amount: t.amount, orderId: t.orderId ?? null, gross: t.gross ?? null, commission: t.commission ?? null, withdrawalId: t.withdrawalId ?? null, at: now() });
}

// ---------- تحويل المستندات لكائنات الواجهة ----------
export const userOut = (d) => d && ({
  id: d.uid, uid: d.uid, role: d.role, status: d.status, statusReason: d.statusReason ?? null, name: d.name, phone: d.phone ?? null, email: d.email ?? null,
  nationalId: d.nationalId ?? null, area: d.area ?? null, lang: d.lang || 'ar', idRef: d.idRef ?? null, licenseRef: d.licenseRef ?? null, vehicleRegRef: d.vehicleRegRef ?? null,
  vehiclePhotoRef: d.vehiclePhotoRef ?? null, vehicleType: d.vehicleType ?? null, phoneVerified: !!d.phoneVerified, ratingSum: d.ratingSum || 0,
  ratingCount: d.ratingCount || 0, completedOrders: d.completedOrders || 0, cancelCount: d.cancelCount || 0, createdAt: d.createdAt,
});
export const withdrawalOut = (d) => ({
  id: d.id, uid: d.uid, name: d.name, phone: d.phone, amount: d.amount, method: d.method, account: d.account, status: d.status,
  note: d.note ?? null, createdAt: d.createdAt, decidedAt: d.decidedAt ?? null,
});
export const txOut = (d) => ({ id: d.id, uid: d.uid, type: d.type, amount: d.amount, orderId: d.orderId ?? null, gross: d.gross ?? null, commission: d.commission ?? null, at: d.at });
export const disputeOut = (d) => ({
  id: d.id, orderId: d.orderId, customerId: d.customerId, driverId: d.driverId ?? null, openedBy: d.openedBy, openedByRole: d.openedByRole,
  reason: d.reason, details: d.details ?? '', evidence: d.evidence || [], orderPrice: d.orderPrice, status: d.status, decision: d.decision ?? null,
  customerPct: d.customerPct ?? null, customerRefund: d.customerRefund ?? null, driverNet: d.driverNet ?? null, commission: d.commission ?? null, note: d.note ?? null,
  refundPaid: !!d.refundPaid, createdAt: d.createdAt, resolvedAt: d.resolvedAt ?? null,
});

// ---------- الطلبات ----------
export async function loadOrder(id) {
  const snap = await ordersCol().doc(id).get();
  if (!snap.exists) throw new HttpError(404, 'order_not_found');
  return { id: snap.id, ...snap.data() };
}
export function orderFromSnap(snap) {
  if (!snap.exists) throw new HttpError(404, 'order_not_found');
  return { id: snap.id, ...snap.data() };
}

const AFTER_PAYMENT = ['paid', 'heading_pickup', 'picked_up', 'in_transit', 'delivered', 'completed', 'disputed', 'resolved'];
export function orderOut(o, viewer, { brief = false } = {}) {
  const x = { ...o };
  if (viewer.role === 'driver') {
    delete x.paymentProof; delete x.paymentRef; delete x.paymentRejectReason;
    if (o.driverId !== viewer.uid) { delete x.customerName; delete x.customerPhone; }
    else if (!AFTER_PAYMENT.includes(o.status)) delete x.customerPhone;
  }
  if (brief) delete x.log;
  return x;
}
export function orderPatch(patch, log) {
  const out = { ...patch, updatedAt: now(), version: FieldValue.increment(1) };
  if (log) out.log = FieldValue.arrayUnion({ ...log, at: now() });
  return out;
}

export { FieldValue };
