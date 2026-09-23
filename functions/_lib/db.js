// طبقة الوصول لـ Cloudflare D1: استعلامات، معاملات ذرّية (batch)، "حراسة" شروط، وتحويل الصفوف لكائنات الواجهة.
import { HttpError, newId } from './core.js';

const clean = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
export const now = () => Date.now();
export const st = (env, sql, ...p) => env.DB.prepare(sql).bind(...clean(p));
export const one = (env, sql, ...p) => st(env, sql, ...p).first();
export async function all(env, sql, ...p) { return (await st(env, sql, ...p).all()).results || []; }

/**
 * شرط لازم يتحقق جوه المعاملة. لو الشرط false بنحاول نكتب NULL في عمود NOT NULL فتفشل المعاملة كلها
 * ويتلغي كل اللي قبلها/بعدها (D1 batch = معاملة ذرّية). ده اللي بيمنع الصرف المزدوج وقبول سواقين اتنين.
 */
export const guard = (env, cond, ...p) => st(env, `INSERT INTO _guard(x) SELECT NULL WHERE NOT (${cond})`, ...p);

export function mapDbError(e) {
  if (e instanceof HttpError) return e;
  const m = String(e?.message || e);
  if (m.includes('_guard')) return new HttpError(409, 'conflict');
  if (m.includes('users.phone') || m.includes('users.national_id')) return new HttpError(409, 'duplicate');
  if (m.includes('CHECK constraint failed') && m.includes('balance')) return new HttpError(400, 'insufficient_balance');
  if (m.includes('UNIQUE constraint failed')) return new HttpError(409, 'conflict');
  console.error('db_error', m);
  return new HttpError(500, 'db_error');
}
/** ينفذ مجموعة عبارات في معاملة واحدة (كلها أو ولا واحدة) */
export async function run(env, stmts) {
  try { return await env.DB.batch(stmts); } catch (e) { throw mapDbError(e); }
}

// ---------- المحفظة ----------
export const walletCredit = (env, uid, amount) => st(env,
  `INSERT INTO wallets(uid, balance, total_earned, updated_at) VALUES(?,?,?,?)
   ON CONFLICT(uid) DO UPDATE SET balance = balance + excluded.balance, total_earned = total_earned + excluded.total_earned, updated_at = excluded.updated_at`,
  uid, amount, Math.max(amount, 0), now());
export const walletTx = (env, t) => st(env,
  'INSERT INTO wallet_tx(id, uid, type, amount, order_id, gross, commission, withdrawal_id, at) VALUES(?,?,?,?,?,?,?,?,?)',
  newId(), t.uid, t.type, t.amount, t.orderId ?? null, t.gross ?? null, t.commission ?? null, t.withdrawalId ?? null, now());

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
// الحقول اللي ليها أعمدة (للفلترة والتجميع). أي حقل تاني بيتخزن في data (JSON).
const COLS = { status: 'status', escrowStatus: 'escrow_status', price: 'price', commission: 'commission', driverNet: 'driver_net', customerRefund: 'customer_refund', driverId: 'driver_id' };
const META = new Set(['id', 'customerId', 'driverId', 'status', 'escrowStatus', 'price', 'commission', 'driverNet', 'customerRefund', 'scheduledAt', 'createdAt', 'updatedAt', '_v']);

export function hydrateOrder(r) {
  return {
    ...JSON.parse(r.data || '{}'),
    id: r.id, customerId: r.customer_id, driverId: r.driver_id, status: r.status, escrowStatus: r.escrow_status, price: r.price,
    commission: r.commission, driverNet: r.driver_net, customerRefund: r.customer_refund, scheduledAt: r.scheduled_at,
    createdAt: r.created_at, updatedAt: r.updated_at, _v: r.version,
  };
}
export async function loadOrder(env, id) {
  const r = await one(env, 'SELECT * FROM orders WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'order_not_found');
  return hydrateOrder(r);
}

/** تحديث طلب بأمان: [حراسة النسخة, UPDATE]. لو حد غيّر الطلب في نفس اللحظة المعاملة كلها بتفشل (409). */
export function orderUpdate(env, o, patch, log) {
  const sets = [], vals = [], data = {};
  for (const [k, v] of Object.entries(o)) if (!META.has(k)) data[k] = v;
  for (const [k, v] of Object.entries(patch)) {
    if (COLS[k]) { sets.push(`${COLS[k]} = ?`); vals.push(v); } else data[k] = v;
  }
  if (log) data.log = [...(o.log || []), { ...log, at: now() }];
  return [
    guard(env, 'EXISTS (SELECT 1 FROM orders WHERE id = ? AND version = ?)', o.id, o._v),
    st(env, `UPDATE orders SET ${sets.map((s) => s + ',').join(' ')} data = ?, updated_at = ?, version = version + 1 WHERE id = ?`, ...vals, JSON.stringify(data), now(), o.id),
  ];
}

const AFTER_PAYMENT = ['paid', 'heading_pickup', 'picked_up', 'in_transit', 'delivered', 'completed', 'disputed', 'resolved'];
/** الشكل اللي بيوصل للمتصفح — مع إخفاء البيانات الحساسة حسب دور المشاهد (الفلترة على السيرفر مش الواجهة) */
export function orderOut(o, viewer, { brief = false } = {}) {
  const { _v, ...x } = o;
  x.version = _v;
  if (viewer.role === 'driver') {
    delete x.paymentProof; delete x.paymentRef; delete x.paymentRejectReason;
    if (o.driverId !== viewer.uid) { delete x.customerName; delete x.customerPhone; }
    else if (!AFTER_PAYMENT.includes(o.status)) delete x.customerPhone; // رقم العميل بعد الدفع بس
  }
  if (brief) delete x.log;
  return x;
}
