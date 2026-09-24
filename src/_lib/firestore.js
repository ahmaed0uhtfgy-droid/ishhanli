// عميل REST خفيف لـ Firestore، بيقلّد شكل الاستخدام البسيط بتاع مكتبة firebase-admin/firestore
// (اللي مش شغالة جوه Cloudflare Workers) — عشان باقي الكود (db.js وملف الـ routes) يفضل زي ما هو من غير تعديل.
// كل حاجة هنا بتتكلم مباشرة مع https://firestore.googleapis.com/v1/... بتوكن Google OAuth2 (lib/gcp.js).
import { getAccessToken, SCOPES } from './gcp.js';

// ---------- تحويل القيم JS <-> شكل Firestore REST ----------
const isPlainObj = (v) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof FSIncrement) && !(v instanceof FSArrayUnion);
class FSIncrement { constructor(n) { this.n = n; } }
class FSArrayUnion { constructor(v) { this.v = v; } }
export const FieldValue = {
  increment: (n) => new FSIncrement(n),
  arrayUnion: (v) => new FSArrayUnion(v),
};
export const AggregateField = { sum: (field) => ({ __agg: 'sum', field }) };

function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (isPlainObj(v)) return { mapValue: { fields: encodeFields(v) } };
  throw new Error('unsupported_value: ' + typeof v);
}
function encodeFields(obj) { const out = {}; for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = encodeValue(v); return out; }
function decodeValue(v) {
  if (!v || v.nullValue !== undefined) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue, 10);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.arrayValue !== undefined) return (v.arrayValue.values || []).map(decodeValue);
  if (v.mapValue !== undefined) return decodeFields(v.mapValue.fields || {});
  if (v.timestampValue !== undefined) return new Date(v.timestampValue).getTime();
  return null;
}
function decodeFields(fields) { const out = {}; for (const [k, v] of Object.entries(fields || {})) out[k] = decodeValue(v); return out; }

// ---------- REST helper ----------
class Rest {
  constructor(sa) {
    this.sa = sa;
    this.dbBase = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)`; // beginTransaction/commit/rollback
    this.base = this.dbBase + '/documents'; // get/runQuery/runAggregationQuery/batchGet + مسارات المستندات
  }
  async token() { return getAccessToken(this.sa, SCOPES.firestore); }
  async _fetch(url, method, body) {
    const token = await this.token();
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 404) return null;
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) { const err = new Error('firestore_error: ' + text.slice(0, 500)); err.status = res.status; err.body = json; throw err; }
    return json;
  }
  async call(method, path, body) { return this._fetch(this.base + path, method, body); } // عمليات المستندات
  async dbCall(method, path, body) { return this._fetch(this.dbBase + path, method, body); } // beginTransaction/commit/rollback
}

function docNameToPath(name, projectPrefix) { return name.slice(projectPrefix.length); } // اسم كامل -> مسار بعد /documents

// ---------- بناء استعلام هيكلي (structured query) من سلسلة where/orderBy/limit/select ----------
function buildStructuredQuery(q) {
  const sq = { from: [{ collectionId: q.collectionId }] };
  if (q.filters.length) {
    const toFilter = (f) => ({ fieldFilter: { field: { fieldPath: f.field }, op: OP[f.op], value: encodeValue(f.value) } });
    sq.where = q.filters.length === 1 ? toFilter(q.filters[0]) : { compositeFilter: { op: 'AND', filters: q.filters.map(toFilter) } };
  }
  if (q.order) sq.orderBy = [{ field: { fieldPath: q.order.field }, direction: q.order.dir === 'desc' ? 'DESCENDING' : 'ASCENDING' }];
  if (q.lim) sq.limit = q.lim;
  if (q.fields) sq.select = { fields: q.fields.map((f) => ({ fieldPath: f })) };
  return sq;
}
const OP = { '==': 'EQUAL', '!=': 'NOT_EQUAL', '<': 'LESS_THAN', '<=': 'LESS_THAN_OR_EQUAL', '>': 'GREATER_THAN', '>=': 'GREATER_THAN_OR_EQUAL', in: 'IN', 'not-in': 'NOT_IN', 'array-contains': 'ARRAY_CONTAINS' };

class DocSnapshot {
  constructor(name, fields, exists, ref) { this.id = name ? name.split('/').pop() : null; this.exists = exists; this._fields = fields; this.ref = ref; }
  data() { return this.exists ? decodeFields(this._fields) : undefined; }
}

class Query {
  constructor(rest, collectionPath) { this.rest = rest; this.collectionPath = collectionPath; this.collectionId = collectionPath.split('/').pop(); this.filters = []; this.order = null; this.lim = null; this.fields = null; }
  where(field, op, value) { const q = this._clone(); q.filters = [...this.filters, { field, op, value }]; return q; }
  orderBy(field, dir = 'asc') { const q = this._clone(); q.order = { field, dir }; return q; }
  limit(n) { const q = this._clone(); q.lim = n; return q; }
  select(...fields) { const q = this._clone(); q.fields = fields; return q; }
  _clone() { const q = new Query(this.rest, this.collectionPath); Object.assign(q, this); return q; }

  async get(transaction) {
    const structuredQuery = buildStructuredQuery(this);
    const parentPath = this.collectionPath.split('/').slice(0, -1).join('/');
    const body = { structuredQuery, ...(transaction ? { transaction } : {}) };
    const rows = await this.rest.call('POST', (parentPath ? '/' + parentPath : '') + ':runQuery', body) || [];
    const docs = rows.filter((r) => r.document).map((r) => new DocSnapshot(r.document.name, r.document.fields, true, docRefFromName(this.rest, r.document.name)));
    return { docs, empty: docs.length === 0, size: docs.length, forEach: (fn) => docs.forEach(fn) };
  }
  // .count() و .aggregate() بيرجّعوا كائن فيه get() — زي شكل استخدام Admin SDK بالظبط (query.count().get())
  async _runAggregation(aggregations) {
    const structuredQuery = buildStructuredQuery(this);
    const parentPath = this.collectionPath.split('/').slice(0, -1).join('/');
    const rows = await this.rest.call('POST', (parentPath ? '/' + parentPath : '') + ':runAggregationQuery', { structuredAggregationQuery: { structuredQuery, aggregations } });
    return rows?.[0]?.result?.aggregateFields || {};
  }
  count() {
    return { get: async () => { const out = await this._runAggregation([{ alias: 'c', count: {} }]); const v = out.c; return { data: () => ({ count: v ? parseInt(v.integerValue || '0', 10) : 0 }) }; } };
  }
  aggregate(map) {
    return {
      get: async () => {
        const aggregations = Object.entries(map).map(([alias, a]) => ({ alias, sum: { field: { fieldPath: a.field } } }));
        const out = await this._runAggregation(aggregations);
        return { data: () => Object.fromEntries(Object.keys(map).map((k) => [k, out[k] ? (out[k].doubleValue ?? parseInt(out[k].integerValue || '0', 10)) : 0])) };
      },
    };
  }
}

class DocRef {
  constructor(rest, path) { this.rest = rest; this.path = path; this.id = path.split('/').pop(); }
  async get(transaction) {
    if (transaction) {
      const rows = await this.rest.call('POST', ':batchGet', { documents: [this.rest.base + '/' + this.path], transaction });
      const r = rows?.[0];
      return r?.found ? new DocSnapshot(r.found.name, r.found.fields, true, this) : new DocSnapshot(null, null, false, this);
    }
    const json = await this.rest.call('GET', '/' + this.path);
    return json ? new DocSnapshot(json.name, json.fields, true, this) : new DocSnapshot(null, null, false, this);
  }
  writeOp(data, { merge = false, requireExists = null } = {}) {
    const plain = {}, transforms = [];
    for (const [k, v] of Object.entries(data)) {
      if (v instanceof FSIncrement) transforms.push({ fieldPath: k, increment: encodeValue(v.n) });
      else if (v instanceof FSArrayUnion) transforms.push({ fieldPath: k, appendMissingElements: { values: [encodeValue(v.v)] } });
      else plain[k] = v;
    }
    const write = { update: { name: this.rest.base + '/' + this.path, fields: encodeFields(plain) } };
    if (merge) write.updateMask = { fieldPaths: Object.keys(plain) };
    if (transforms.length) write.updateTransforms = transforms;
    if (requireExists !== null) write.currentDocument = { exists: requireExists };
    return write;
  }
  async set(data, opts) { await this.rest.dbCall('POST', ':commit', { writes: [this.writeOp(data, { merge: !!opts?.merge })] }); }
  async update(data) { await this.rest.dbCall('POST', ':commit', { writes: [this.writeOp(data, { merge: true, requireExists: true })] }); }
  async delete() { await this.rest.dbCall('POST', ':commit', { writes: [{ delete: this.rest.base + '/' + this.path }] }); }
  collection(sub) { return new CollectionRef(this.rest, `${this.path}/${sub}`); }
}
function docRefFromName(rest, name) { return new DocRef(rest, name.slice(rest.base.length + 1)); }

class CollectionRef extends Query {
  constructor(rest, path) { super(rest, path); this.path = path; }
  doc(id) { return new DocRef(this.rest, `${this.path}/${id || cryptoId()}`); }
}
function cryptoId() { const b = crypto.getRandomValues(new Uint8Array(15)); return [...b].map((x) => x.toString(36).padStart(2, '0')).join('').slice(0, 20); }

// ---------- Transactions ----------
class Tx {
  constructor(rest, id) { this.rest = rest; this.id = id; this.writes = []; }
  async get(refOrQuery) {
    if (refOrQuery instanceof Query) return refOrQuery.get(this.id);
    return refOrQuery.get(this.id);
  }
  set(ref, data, opts) { this.writes.push(ref.writeOp(data, { merge: !!opts?.merge })); }
  update(ref, data) { this.writes.push(ref.writeOp(data, { merge: true, requireExists: true })); }
  delete(ref) { this.writes.push({ delete: ref.rest.base + '/' + ref.path }); }
}

export class Firestore {
  constructor(sa) { this.rest = new Rest(sa); }
  collection(path) { return new CollectionRef(this.rest, path); }

  /** بديل db.runTransaction بتاع Admin SDK: نفس الضمانات (تضارب = إعادة تلقائية لحد 5 مرات) */
  async runTransaction(fn) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const begun = await this.rest.dbCall('POST', ':beginTransaction', {});
      const tx = new Tx(this.rest, begun.transaction);
      let result;
      try {
        result = await fn(tx);
      } catch (e) {
        await this.rest.dbCall('POST', ':rollback', { transaction: tx.id }).catch(() => {});
        throw e; // خطأ منطقي (HttpError) — مش تضارب، منعيدش المحاولة
      }
      try {
        await this.rest.dbCall('POST', ':commit', { transaction: tx.id, writes: tx.writes });
        return result;
      } catch (e) {
        const retryable = e.status === 409 || e.status === 429 || /ABORTED/i.test(e.body?.error?.status || '');
        if (!retryable || attempt === 5) throw e;
        await new Promise((r) => setTimeout(r, 50 * attempt));
      }
    }
  }
}
