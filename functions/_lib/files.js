// تخزين الصور: بيانات الوصول (ACL) في D1 دايماً، والمحتوى في R2 لو مربوط (env.BUCKET)،
// وإلا في قاعدة D1 منفصلة (env.FILES) أو في نفس القاعدة كحل أخير. صفر كارت بنكي في الوضع الافتراضي.
import { HttpError, newId } from './core.js';
import { st, one, now } from './db.js';

export const KINDS = ['id', 'license', 'vehicle', 'vehiclePhoto', 'cargo', 'handover', 'payment', 'evidence'];
const SHARED = ['cargo', 'handover', 'vehiclePhoto', 'evidence']; // باقي الأنواع (بطاقة/رخصة/استمارة/إثبات دفع) للمالك والأدمن فقط
const REG_KINDS = ['id', 'license', 'vehicle', 'vehiclePhoto'];    // المسموح رفعه قبل ما الحساب يتفعّل
const MAX_B64 = 1_000_000;                                          // ~750KB بعد الضغط (حد D1 للصف 2MB)
const blobDb = (env) => env.FILES || env.DB;

const b64ToBytes = (b64) => { const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; };

export async function saveFile(env, uid, profile, kind, dataUrl) {
  if (!KINDS.includes(kind)) throw new HttpError(400, 'bad_file');
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m || m[1].length < 200 || m[1].length > MAX_B64 || !m[1].startsWith('/9j/')) throw new HttpError(400, 'bad_image'); // '/9j/' = توقيع JPEG
  if (!profile && !REG_KINDS.includes(kind)) throw new HttpError(403, 'no_profile');
  if (profile && profile.status !== 'active' && profile.role !== 'admin' && !REG_KINDS.includes(kind)) throw new HttpError(403, 'account_not_active');
  const recent = await one(env, 'SELECT COUNT(*) c FROM files_meta WHERE owner = ? AND created_at > ?', uid, now() - 3600e3);
  if (recent.c >= 30) throw new HttpError(429, 'too_many_uploads');
  const id = newId(), bytes = b64ToBytes(m[1]);
  if (env.BUCKET) await env.BUCKET.put(id, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
  else await blobDb(env).prepare('INSERT INTO file_blobs(id, data) VALUES(?, ?)').bind(id, m[1]).run();
  await st(env, 'INSERT INTO files_meta(id, owner, kind, mime, size, store, created_at) VALUES(?,?,?,?,?,?,?)', id, uid, kind, 'image/jpeg', bytes.length, env.BUCKET ? 'r2' : 'd1', now()).run();
  return 'fs:' + id;
}

/** التأكد إن كل الملفات المشار لها تخص المستخدم (يمنع الإشارة لملفات غيره) */
export async function ownFiles(env, uid, refs) {
  const ids = [...new Set(refs.filter(Boolean).map((r) => String(r).slice(3)))];
  if (!ids.length) return;
  const r = await one(env, `SELECT COUNT(*) c FROM files_meta WHERE owner = ? AND id IN (${ids.map(() => '?').join(',')})`, uid, ...ids);
  if (r.c !== ids.length) throw new HttpError(400, 'bad_file');
}

export async function readFile(env, viewer, id) {
  if (!/^[A-Za-z0-9]{10,40}$/.test(id)) throw new HttpError(400, 'bad_id');
  const meta = await one(env, 'SELECT * FROM files_meta WHERE id = ?', id);
  if (!meta) throw new HttpError(404, 'not_found');
  if (!(meta.owner === viewer.uid || viewer.role === 'admin' || SHARED.includes(meta.kind))) throw new HttpError(403, 'forbidden');
  let bytes;
  if (meta.store === 'r2') { const obj = await env.BUCKET?.get(id); if (!obj) throw new HttpError(404, 'not_found'); bytes = await obj.arrayBuffer(); }
  else { const r = await blobDb(env).prepare('SELECT data FROM file_blobs WHERE id = ?').bind(id).first(); if (!r) throw new HttpError(404, 'not_found'); bytes = b64ToBytes(r.data); }
  return new Response(bytes, { headers: { 'Content-Type': meta.mime, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
}
