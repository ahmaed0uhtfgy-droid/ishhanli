// طبقة البيانات فوق Firestore: مسارات المستندات، المحفظة، تحويل الصفوف لكائنات الواجهة، وتحديث الطلبات بأمان.
// المستندات بنفس أسماء الأعمدة القديمة (snake_case) — شوف firestore.js للتفاصيل.
import { HttpError, newId } from './core.js';
import * as F from './firestore.js';

export { F };
export const now = () => Date.now();

// ---------- المحفظة ----------
/** زيادة/نقص رصيد السواق ذرّياً (بينشئ المحفظة لو مش موجودة). */
export const walletCredit = (uid, amount) => F.inc(`wallets/${uid}`, { balance: amount, total_earned: Math.max(amount, 0) }, { uid, updated_at: now() });
export const walletTx = (t) => { const id = newId(); return F.create(`wallets/${t.uid}/tx/${id}`, { id, uid: t.uid, type: t.type, amount: t.amount, order_id: t.orderId ?? null, gross: t.gross ?? null, commission: t.commission ?? null, withdrawal_id: t.withdrawalId ?? null, at: now() }); };

/**
 * حد معدّل (Rate limit) بنافذة متحركة: مستند واحد لكل (نوع، مستخدم) فيه آخر الأوقات. لو وصل الحد بيرمي 429، وإلا بيرجّع كتابة
 * بتسجّل المحاولة (تتحط في نفس الـ commit بتاع العملية عشان ما يتحسبش إلا لو العملية نجحت).
 */
export async function rateLimit(env, kind, uid, windowMs, max, code = 'too_many_requests') {
  const path = `rl/${kind}_${uid}`, t = now();
  const r = await F.get(env, path);
  let recent = []; try { recent = JSON.parse(r?.t || '[]'); } catch { /* تالف => نبدأ من الأول */ }
  recent = recent.filter((x) => x > t - windowMs);
  if (recent.length >= max) throw new HttpError(429, code);
  return F.set(path, { kind, uid, t: JSON.stringify([...recent, t].slice(-max)) });
}

// ---------- تحويل الصفوف ----------
export const userOut = (r) => r && ({
  id: r.uid, uid: r.uid, role: r.role, status: r.status, statusReason: r.status_reason, name: r.name, phone: r.phone, email: r.email,
  nationalId: r.national_id, area: r.area, lang: r.lang, idRef: r.id_ref, licenseRef: r.license_ref, vehicleRegRef: r.vehicle_reg_ref,
  vehiclePhotoRef: r.vehicle_photo_ref, vehicleType: r.vehicle_type, phoneVerified: !!r.phone_verified, ratingSum: r.rating_sum,
  ratingCount: r.rating_count, completedOrders: r.completed_orders, cancelCount: r.cancel_count, createdAt: r.created_at,
});
export const withdrawalOut = (r) => ({
  id: r.id, uid: r.uid, name: r.name, phone: r.phone, amount: r.amount, method: r.method, account: r.account, status: r.status,
  note: r.note, createdAt: r.created_at, decidedAt: r.decided_at,
});
export const txOut = (r) => ({ id: r.id, uid: r.uid, type: r.type, amount: r.amount, orderId: r.order_id, gross: r.gross, commission: r.commission, at: r.at });
export const disputeOut = (r) => ({
  id: r.id, orderId: r.order_id, customerId: r.customer_id, driverId: r.driver_id, openedBy: r.opened_by, openedByRole: r.opened_by_role,
  reason: r.reason, details: r.details, evidence: JSON.parse(r.evidence || '[]'), orderPrice: r.order_price, status: r.status, decision: r.decision,
  customerPct: r.customer_pct, customerRefund: r.customer_refund, driverNet: r.driver_net, commission: r.commission, note: r.note,
  refundPaid: !!r.refund_paid, createdAt: r.created_at, resolvedAt: r.resolved_at,
});

// ---------- الطلبات ----------
// الحقول اللي ليها أعمدة (للفلترة والتجميع). أي حقل تاني بيتخزن في data (JSON نصي).
const COLS = { status: 'status', escrowStatus: 'escrow_status', price: 'price', commission: 'commission', driverNet: 'driver_net', customerRefund: 'customer_refund', driverId: 'driver_id' };
const META = new Set(['id', 'customerId', 'driverId', 'status', 'escrowStatus', 'price', 'commission', 'driverNet', 'customerRefund', 'scheduledAt', 'createdAt', 'updatedAt', '_v', '_ut']);

export function hydrateOrder(r) {
  return {
    ...JSON.parse(r.data || '{}'),
    id: r.id, customerId: r.customer_id, driverId: r.driver_id, status: r.status, escrowStatus: r.escrow_status, price: r.price,
    commission: r.commission, driverNet: r.driver_net, customerRefund: r.customer_refund, scheduledAt: r.scheduled_at,
    createdAt: r.created_at, updatedAt: r.updated_at, _v: r.version, _ut: r._ut,
  };
}
export async function loadOrder(env, id) {
  const r = await F.get(env, `orders/${id}`);
  if (!r) throw new HttpError(404, 'order_not_found');
  return hydrateOrder(r);
}

/** تحديث طلب بأمان: لو حد غيّر الطلب في نفس اللحظة الـ commit كله بيفشل (409). */
export function orderUpdate(_env, o, patch, log) {
  const cols = {}, data = {};
  for (const [k, v] of Object.entries(o)) if (!META.has(k)) data[k] = v;
  for (const [k, v] of Object.entries(patch)) { if (COLS[k]) cols[COLS[k]] = v; else data[k] = v; }
  if (log) data.log = [...(o.log || []), { ...log, at: now() }];
  return [F.patch(`orders/${o.id}`, { ...cols, data: JSON.stringify(data), updated_at: now(), version: (o._v || 0) + 1 }, o._ut)];
}

const AFTER_PAYMENT = ['paid', 'heading_pickup', 'picked_up', 'in_transit', 'delivered', 'completed', 'disputed', 'resolved'];
/** الشكل اللي بيوصل للمتصفح — مع إخفاء البيانات الحساسة حسب دور المشاهد (الفلترة على السيرفر مش الواجهة) */
export function orderOut(o, viewer, { brief = false } = {}) {
  const { _v, _ut, ...x } = o;
  x.version = _v;
  if (viewer.role === 'driver') {
    delete x.paymentProof; delete x.paymentRef; delete x.paymentRejectReason;
    if (o.driverId !== viewer.uid) { delete x.customerName; delete x.customerPhone; }
    else if (!AFTER_PAYMENT.includes(o.status)) delete x.customerPhone; // رقم العميل بعد الدفع بس
  }
  if (brief) delete x.log;
  return x;
}
