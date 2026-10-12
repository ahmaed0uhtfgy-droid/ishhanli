// عميل Firestore عبر REST (بدون SDK) يشتغل على Cloudflare Workers. الدخول بحساب خدمة (FIREBASE_SERVICE_ACCOUNT).
// قواعد التصميم:
//  - كل مستند بنخزنه بنفس أسماء الأعمدة القديمة (snake_case) عشان باقي الكود يفضل زي ما هو.
//  - التزامن: كل كتابة متعددة بتتنفذ في commit واحد ذرّي (كلها أو ولا واحدة) مع شروط على updateTime (= "حراسة النسخة").
//  - بنتجنّب الفهارس المركّبة (composite) تماماً: استعلام إما مساواة فقط أو ترتيب/نطاق على حقل واحد فقط.
import { HttpError } from './core.js';
import { googleToken } from './gauth.js';

const SCOPE = 'https://www.googleapis.com/auth/datastore';
const HOST = 'https://firestore.googleapis.com/v1';
const dbName = (env) => `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)`;
const docsUrl = (env) => `${HOST}/${dbName(env)}/documents`;
export const docName = (env, path) => `${dbName(env)}/documents/${path}`;
const urlPath = (path) => path.split('/').map(encodeURIComponent).join('/');

// ---------- عدّاد الاستخدام (تقدير الكوتا) ----------
// بيتجمّع جوه الـ isolate (مشترك بين الطلبات) وبيتفضّى كتابةً في metrics/{day} عن طريق _lib/metrics.js.
// تقديري: مستند قراءة = 1، استعلام = عدد المستندات الراجعة، تجميع = 1، commit = عدد الكتابات.
let stat = { reads: 0, writes: 0 };
const bump = (k, n = 1) => { stat[k] += n; };
/** يرجّع العدّاد المتجمّع ويصفّره (بيتنادى من مهام الخلفية بعد رد الطلب). */
export const takeStats = () => { const s = stat; stat = { reads: 0, writes: 0 }; return s; };

// ---------- ترميز القيم ----------
const encV = (v) => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('bad_number'); return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }; }
  if (typeof v === 'string') return { stringValue: v };
  throw new Error('unsupported_value_type'); // الكائنات والمصفوفات بتتخزن كـ JSON نصي
};
const decV = (v) => {
  if (!v) return null;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  return null;
};
const fieldsOf = (obj) => { const f = {}; for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && !k.startsWith('_')) f[k] = encV(v); return f; };
const rowOf = (doc) => { const r = {}; for (const [k, v] of Object.entries(doc.fields || {})) r[k] = decV(v); r._id = String(doc.name).split('/').pop(); r._ut = doc.updateTime; return r; };

// ---------- أخطاء ----------
const CONFLICT = new Set(['ABORTED', 'ALREADY_EXISTS', 'FAILED_PRECONDITION', 'NOT_FOUND']);
async function failure(res, what) {
  const j = await res.json().catch(() => ({}));
  const status = Array.isArray(j) ? j[0]?.error?.status : j?.error?.status;
  if (CONFLICT.has(status)) {
    const e = new HttpError(409, 'conflict');
    const msg = String((Array.isArray(j) ? j[0]?.error?.message : j?.error?.message) || '');
    // أخطاء القراءة/التجميع (مش الكتابة): نحتفظ بحالة ونص خطأ Firestore (فيه رابط إنشاء الفهرس لو ناقص) بدل ما يضيع ورا «conflict»
    if (what !== 'commit') { e.detail = `${status} [${what}] ${msg}`.slice(0, 700); console.error('firestore_read_conflict', what, e.detail); }
    return e;
  }
  console.error('firestore_error', what, res.status, status, JSON.stringify(j).slice(0, 300));
  return new HttpError(500, status === 'RESOURCE_EXHAUSTED' ? 'quota_exceeded' : 'db_error');
}
async function call(env, method, url, body, what) {
  const token = await googleToken(env, SCOPE);
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw await failure(res, what);
  return res.json();
}

// ---------- قراءة ----------
/** مستند واحد (مسار مثل users/abc أو orders/ID/messages/ID2). بيرجّع صف أو null. */
export async function get(env, path) {
  const token = await googleToken(env, SCOPE);
  const res = await fetch(`${docsUrl(env)}/${urlPath(path)}`, { headers: { Authorization: `Bearer ${token}` } });
  bump('reads');
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(res, 'get');
  return rowOf(await res.json());
}
/** عدة مستندات في طلب واحد (أرخص في الـ subrequests). بيرجّع مصفوفة بنفس الترتيب (null للي مش موجود). */
export async function getMany(env, col, ids, fields = null) { // fields = مصفوفة حقول للقراءة فقط (توفير حجم النقل؛ مثلاً من غير الصور)
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return ids.map(() => null);
  bump('reads', uniq.length);
  const found = new Map();
  for (let i = 0; i < uniq.length; i += 100) {
    const chunk = uniq.slice(i, i + 100);
    const out = await call(env, 'POST', `${docsUrl(env)}:batchGet`, { documents: chunk.map((id) => docName(env, `${col}/${id}`)), ...(fields ? { mask: { fieldPaths: fields } } : {}) }, 'batchGet');
    for (const e of out) if (e.found) { const r = rowOf(e.found); found.set(r._id, r); }
  }
  return ids.map((id) => found.get(id) || null);
}

const OPS = { '>': 'GREATER_THAN', '>=': 'GREATER_THAN_OR_EQUAL', '<': 'LESS_THAN', '<=': 'LESS_THAN_OR_EQUAL' };
function structured(col, { eq = {}, inn = {}, range = [], order = null, limit = null } = {}) {
  const parts = col.split('/'), collectionId = parts.pop(), parent = parts.join('/');
  const filters = [
    ...Object.entries(eq).map(([f, v]) => ({ fieldFilter: { field: { fieldPath: f }, op: 'EQUAL', value: encV(v) } })),
    ...Object.entries(inn).map(([f, vs]) => ({ fieldFilter: { field: { fieldPath: f }, op: 'IN', value: { arrayValue: { values: vs.map(encV) } } } })),
    ...range.map(([f, op, v]) => ({ fieldFilter: { field: { fieldPath: f }, op: OPS[op], value: encV(v) } })),
  ];
  const q = { from: [{ collectionId }] };
  if (filters.length === 1) q.where = filters[0]; else if (filters.length > 1) q.where = { compositeFilter: { op: 'AND', filters } };
  if (order) q.orderBy = [{ field: { fieldPath: order[0] }, direction: order[1] === 'desc' ? 'DESCENDING' : 'ASCENDING' }];
  if (limit) q.limit = limit;
  return { parent, q };
}
/**
 * استعلام. eq: مساواة (ممكن أكتر من حقل). inn: { حقل: [قيم] } (حتى 30 قيمة، بيتقسم تلقائياً).
 * order: ['حقل','desc'|'asc'] — لو معاه مساواة على حقل تاني بيرفضه (ده بيحتاج فهرس مركّب). range: [[حقل, '>', قيمة]].
 */
export async function query(env, col, opts = {}) {
  const inn = opts.inn || {}, keys = Object.keys(inn);
  if (keys.length > 1) throw new Error('one_in_only');
  if (keys.length === 1 && inn[keys[0]].length > 30) { // IN محدود بـ 30 قيمة
    const vals = inn[keys[0]], out = [];
    for (let i = 0; i < vals.length; i += 30) out.push(...await query(env, col, { ...opts, inn: { [keys[0]]: vals.slice(i, i + 30) } }));
    return out;
  }
  if (keys.length === 1 && !inn[keys[0]].length) return [];
  const { parent, q } = structured(col, opts);
  const url = `${docsUrl(env)}${parent ? '/' + urlPath(parent) : ''}:runQuery`;
  const out = await call(env, 'POST', url, { structuredQuery: q }, 'runQuery');
  const rows = out.filter((e) => e.document).map((e) => rowOf(e.document));
  bump('reads', rows.length);
  return rows;
}
/** تجميع (count / sum) بدون قراءة كل المستندات. aggs: { alias: ['count'] | ['sum','حقل'] } */
export async function aggregate(env, col, filt = {}, aggs = { n: ['count'] }) {
  const { parent, q } = structured(col, filt);
  const aggregations = Object.entries(aggs).map(([alias, [kind, field]]) => (kind === 'count' ? { alias, count: {} } : { alias, sum: { field: { fieldPath: field } } }));
  const url = `${docsUrl(env)}${parent ? '/' + urlPath(parent) : ''}:runAggregationQuery`;
  const out = await call(env, 'POST', url, { structuredAggregationQuery: { structuredQuery: q, aggregations } }, 'aggregate');
  bump('reads');
  const f = out[0]?.result?.aggregateFields || {}, res = {};
  for (const alias of Object.keys(aggs)) res[alias] = Number(f[alias]?.integerValue ?? f[alias]?.doubleValue ?? 0);
  return res;
}
export async function count(env, col, filt = {}) { return (await aggregate(env, col, filt)).n; }

// ---------- كتابة (كل run = commit ذرّي) ----------
/** create: لازم المستند يكون مش موجود (وإلا conflict). ده اللي بيمنع التكرار (UNIQUE). */
export const create = (path, data) => ({ k: 'update', path, data, mask: null, pre: { exists: false } });
/** set: استبدال كامل. ut = شرط إن المستند ما اتغيّرش من وقت ما قريته. */
export const set = (path, data, ut) => ({ k: 'update', path, data, mask: null, pre: ut ? { updateTime: ut } : null });
/** patch: تعديل الحقول المذكورة بس (وبينشئ المستند لو مش موجود، إلا لو ut/exists اتحدد). */
export const patch = (path, data, ut) => ({ k: 'update', path, data, mask: Object.keys(data).filter((k) => data[k] !== undefined), pre: ut ? { updateTime: ut } : null });
/** inc: زيادة أرقام ذرّياً (بتنشئ المستند لو مش موجود) + اختيارياً تعديل حقول. */
export const inc = (path, incs, data = {}, ut) => ({ k: 'update', path, data, mask: Object.keys(data).filter((k) => data[k] !== undefined), incs, pre: ut ? { updateTime: ut } : null });
export const del = (path) => ({ k: 'delete', path });
/** guard: شرط إن مستند ما اتغيّرش (من غير تعديله) — لو اتغيّر الـ commit كله بيفشل. */
export const guard = (row, path) => ({ k: 'update', path, data: {}, mask: [], pre: { updateTime: row._ut } });

const toWrite = (env, w) => {
  if (w.k === 'delete') return { delete: docName(env, w.path) };
  const out = { update: { name: docName(env, w.path), fields: fieldsOf(w.data) } };
  if (w.mask) out.updateMask = { fieldPaths: w.mask };
  if (w.incs) out.updateTransforms = Object.entries(w.incs).map(([fieldPath, n]) => ({ fieldPath, increment: encV(n) }));
  if (w.pre) out.currentDocument = w.pre;
  return out;
};
// ختم التغيير: لكل مجموعة بيانات "بتتحدّث" بنزوّد عدّاد في مستند meta/stamp ضمن نفس الـ commit.
// الواجهة بتسأل `sync` (قراءة واحدة) وما بتجيبش القوائم الكبيرة غير لما العدّاد يتغيّر — ده بيوفّر معظم قراءات Firestore (الكوتا المجانية).
// الربط بالمسار بيتم تلقائياً هنا، فمفيش كتابة جديدة ممكن تنسى تزوّد العدّاد.
const STAMP_OF = { orders: 'orders', offers: 'orders', users: 'users', wallets: 'wallet', withdrawals: 'withdrawals', refunds: 'refunds', disputes: 'disputes', reports: 'reports', sos_events: 'reports', blacklist: 'blacklist', audit: 'audit' };
export const STAMP_KINDS = [...new Set(Object.values(STAMP_OF))];
export const STAMP_PATH = 'meta/stamp';
const stampsOf = (list) => {
  const kinds = new Set();
  for (const w of list) {
    if (w.k !== 'delete' && w.mask && w.mask.length === 0 && !w.incs) continue; // guard: مجرد شرط من غير تعديل
    const kind = STAMP_OF[w.path.split('/')[0]];
    if (kind) kinds.add(kind);
  }
  return kinds;
};

/** ينفّذ مجموعة كتابات كمعاملة واحدة. أي شرط فاشل => HttpError(409,'conflict') ومفيش أي حاجة اتكتبت. */
export async function run(env, writes) {
  const list = writes.flat().filter(Boolean);
  if (!list.length) return;
  const kinds = stampsOf(list);
  if (kinds.size) list.push(inc(STAMP_PATH, Object.fromEntries([...kinds].map((k) => [k, 1])), { k: 'stamp', updated_at: Date.now() }));
  if (list.length > 400) throw new HttpError(500, 'too_many_writes');
  await call(env, 'POST', `${docsUrl(env)}:commit`, { writes: list.map((w) => toWrite(env, w)) }, 'commit');
  bump('writes', list.length);
}
