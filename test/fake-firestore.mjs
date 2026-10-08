// Firestore REST وهمي (في الذاكرة) للاختبار من غير إنترنت. بيحاكي بالظبط اللي السيرفر بيستخدمه:
//  GET مستند، batchGet، runQuery، runAggregationQuery، commit (ذرّي + شروط exists/updateTime + increment transform).
// وبيفرض قيود Firestore الحقيقية اللي ممكن تكسر الإنتاج: الاستعلام المركّب (مساواة + ترتيب/نطاق على حقل تاني) مرفوض (محتاج فهرس)،
// وحد حجم المستند 1MiB، و IN بحد 30 قيمة.
export function makeFirestore(project) {
  const docs = new Map(); // path -> { fields, createTime, updateTime }
  let tick = 0;
  const stamp = () => `2026-01-01T00:00:00.${String(++tick).padStart(9, '0')}Z`;
  const root = `projects/${project}/databases/(default)/documents/`;
  const stats = { reads: 0, writes: 0, queries: 0, commits: 0 };
  const err = (http, status, message) => ({ http, body: { error: { code: http, status, message } } });

  const val = (v) => v && ('integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue : 'stringValue' in v ? v.stringValue : 'booleanValue' in v ? v.booleanValue : null);
  const plain = (d) => Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, val(v)]));
  const size = (d) => JSON.stringify(d.fields).length;
  const pathOf = (name) => { if (!name.startsWith(root)) throw new Error('bad name ' + name); return name.slice(root.length); };
  const out = (path, d) => ({ name: root + path, fields: d.fields, createTime: d.createTime, updateTime: d.updateTime });

  function runCommit(writes) {
    // ذرّي: نطبّق على نسخة، ولو أي شرط فشل نرمي من غير ما نغيّر حاجة
    const next = new Map(docs); const t = stamp();
    for (const w of writes) {
      const path = pathOf(w.update ? w.update.name : w.delete);
      const cur = next.get(path);
      const pre = w.currentDocument;
      if (pre) {
        if ('exists' in pre && pre.exists !== !!cur) throw err(pre.exists ? 404 : 409, pre.exists ? 'NOT_FOUND' : 'ALREADY_EXISTS', 'precondition ' + path);
        if (pre.updateTime && (!cur || cur.updateTime !== pre.updateTime)) throw err(400, 'FAILED_PRECONDITION', 'stale ' + path);
      }
      if (w.delete) { next.delete(path); continue; }
      const d = cur ? { ...cur, fields: { ...cur.fields } } : { fields: {}, createTime: t };
      const incoming = w.update.fields || {};
      if (w.updateMask) {
        for (const f of w.updateMask.fieldPaths) { if (f in incoming) d.fields[f] = incoming[f]; else delete d.fields[f]; }
      } else d.fields = { ...incoming }; // بدون mask = استبدال كامل
      for (const tr of w.updateTransforms || []) {
        if (!tr.increment) throw err(400, 'INVALID_ARGUMENT', 'only increment supported');
        const old = d.fields[tr.fieldPath]; const o = old ? val(old) : 0; const inc = val(tr.increment);
        d.fields[tr.fieldPath] = { integerValue: String(o + inc) };
      }
      for (const k of Object.keys(d.fields)) if (/[^A-Za-z0-9_]/.test(k)) throw err(400, 'INVALID_ARGUMENT', 'bad field path ' + k);
      if (size(d) > 1048576) throw err(400, 'INVALID_ARGUMENT', 'document too large');
      d.updateTime = t; next.set(path, d); stats.writes++;
    }
    docs.clear(); for (const [k, v] of next) docs.set(k, v);
    stats.commits++;
    return { writeResults: writes.map(() => ({ updateTime: t })), commitTime: t };
  }

  const cmp = (a, b) => (a === b ? 0 : a === null || a === undefined ? -1 : b === null || b === undefined ? 1 : a < b ? -1 : 1);
  function filtersOf(where) {
    if (!where) return [];
    if (where.fieldFilter) return [where.fieldFilter];
    if (where.compositeFilter) return where.compositeFilter.filters.flatMap(filtersOf);
    return [];
  }
  function select(parent, sq) {
    stats.queries++;
    const colId = sq.from[0].collectionId, base = (parent ? parent + '/' : '') + colId + '/';
    const fs = filtersOf(sq.where), ob = sq.orderBy || [];
    // قواعد الفهرس: مساواة/IN بس = مسموح (دمج فهارس). أي نطاق/ترتيب لازم يبقى على حقل واحد فقط ومن غير فلاتر مساواة تانية
    const eqs = fs.filter((f) => ['EQUAL', 'IN'].includes(f.op)), rng = fs.filter((f) => !['EQUAL', 'IN'].includes(f.op));
    const inCount = fs.filter((f) => f.op === 'IN').length;
    if (inCount > 1) throw err(400, 'INVALID_ARGUMENT', 'one IN only');
    for (const f of fs) if (f.op === 'IN' && f.value.arrayValue.values.length > 30) throw err(400, 'INVALID_ARGUMENT', 'IN > 30');
    const rangeFields = new Set([...rng.map((f) => f.field.fieldPath), ...ob.map((o) => o.field.fieldPath)]);
    if (rangeFields.size > 1) throw err(400, 'FAILED_PRECONDITION', 'The query requires an index (multiple range/order fields)');
    if (rangeFields.size === 1 && eqs.length) throw err(400, 'FAILED_PRECONDITION', 'The query requires an index (equality + range/order)');
    let rows = [...docs].filter(([p]) => p.startsWith(base) && !p.slice(base.length).includes('/')).map(([p, d]) => ({ p, d, v: plain(d) }));
    for (const f of fs) {
      const k = f.field.fieldPath, x = val(f.value && f.value.arrayValue ? null : f.value);
      rows = rows.filter(({ v }) => {
        const a = v[k];
        switch (f.op) {
          case 'EQUAL': return a === x;
          case 'IN': return f.value.arrayValue.values.map(val).includes(a);
          case 'GREATER_THAN': return a !== undefined && a !== null && a > x;
          case 'GREATER_THAN_OR_EQUAL': return a !== undefined && a !== null && a >= x;
          case 'LESS_THAN': return a !== undefined && a !== null && a < x;
          case 'LESS_THAN_OR_EQUAL': return a !== undefined && a !== null && a <= x;
          default: throw err(400, 'INVALID_ARGUMENT', 'op ' + f.op);
        }
      });
    }
    if (ob.length) { // الترتيب بيستبعد المستندات اللي مفيهاش الحقل (زي Firestore)
      const k = ob[0].field.fieldPath, dir = ob[0].direction === 'DESCENDING' ? -1 : 1;
      rows = rows.filter(({ v }) => v[k] !== undefined && v[k] !== null).sort((a, b) => dir * cmp(a.v[k], b.v[k]));
    } else rows.sort((a, b) => cmp(a.p, b.p)); // الافتراضي: بالمعرّف
    if (sq.limit) rows = rows.slice(0, sq.limit);
    stats.reads += Math.max(rows.length, 1);
    return rows;
  }

  async function handle(method, url, body) {
    const u = new URL(url); const path = decodeURIComponent(u.pathname).replace(/^\/v1\//, '');
    try {
      if (method === 'GET') {
        const p = pathOf(path); const d = docs.get(p); stats.reads++;
        if (!d) return { http: 404, body: { error: { code: 404, status: 'NOT_FOUND' } } };
        return { http: 200, body: out(p, d) };
      }
      const m = /^(.*)\/documents(?:\/(.*))?:(commit|batchGet|runQuery|runAggregationQuery)$/.exec(path);
      if (!m) return { http: 404, body: { error: { code: 404, status: 'NOT_FOUND', message: path } } };
      const parent = m[2] || '', op = m[3];
      if (op === 'commit') return { http: 200, body: runCommit(body.writes) };
      if (op === 'batchGet') {
        return { http: 200, body: body.documents.map((n) => { const p = pathOf(n), d = docs.get(p); stats.reads++;
          if (!d) return { missing: n }; const o = out(p, d); if (body.mask) o.fields = Object.fromEntries(Object.entries(o.fields).filter(([k]) => body.mask.fieldPaths.includes(k))); return { found: o }; }) };
      }
      if (op === 'runQuery') {
        const rows = select(parent, body.structuredQuery);
        return { http: 200, body: rows.length ? rows.map(({ p, d }) => ({ document: out(p, d) })) : [{ readTime: stamp() }] };
      }
      const sq = body.structuredAggregationQuery, rows = select(parent, sq.structuredQuery), res = {};
      for (const a of sq.aggregations) res[a.alias] = a.count ? { integerValue: String(rows.length) } : { integerValue: String(rows.reduce((s, r) => s + (Number(r.v[a.sum.field.fieldPath]) || 0), 0)) };
      return { http: 200, body: [{ result: { aggregateFields: res } }] };
    } catch (e) { if (e && e.http) return e; throw e; }
  }

  return {
    handle, stats, root,
    // أدوات فحص للاختبارات
    get: (path) => (docs.has(path) ? plain(docs.get(path)) : null),
    list: (col) => [...docs].filter(([p]) => p.startsWith(col + '/') && !p.slice(col.length + 1).includes('/')).map(([p, d]) => ({ _id: p.slice(col.length + 1), ...plain(d) })),
    put: (path, obj) => { const f = {}; for (const [k, v] of Object.entries(obj)) f[k] = v === null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : Number.isInteger(v) ? { integerValue: String(v) } : typeof v === 'number' ? { doubleValue: v } : { stringValue: String(v) }; const t = stamp(); docs.set(path, { fields: f, createTime: t, updateTime: t }); },
    patch: (path, obj) => { const cur = docs.get(path); if (!cur) throw new Error('no doc ' + path); const merged = { ...plain(cur), ...obj }; const f = {}; for (const [k, v] of Object.entries(merged)) f[k] = v === null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : Number.isInteger(v) ? { integerValue: String(v) } : typeof v === 'number' ? { doubleValue: v } : { stringValue: String(v) }; cur.fields = f; cur.updateTime = stamp(); },
    del: (path) => docs.delete(path),
    size: () => docs.size,
  };
}
