// تخزين الصور في Firestore (مستند لكل صورة: بيانات الوصول + المحتوى base64). الصور بتتضغط في المتصفح (~60-120KB)
// فمفيش حاجة محتاجة Cloud Storage (اللي بقى محتاج وسيلة دفع). حد المستند في Firestore = 1MiB.
import { HttpError, newId } from './core.js';
import { F, now, rateLimit } from './db.js';

export const KINDS = ['id', 'license', 'vehicle', 'vehiclePhoto', 'cargo', 'handover', 'payment', 'evidence'];
const SHARED = ['cargo', 'handover', 'vehiclePhoto', 'evidence']; // باقي الأنواع (بطاقة/رخصة/استمارة/إثبات دفع) للمالك والأدمن فقط
const REG_KINDS = ['id', 'license', 'vehicle', 'vehiclePhoto'];    // المسموح رفعه قبل ما الحساب يتفعّل
const MAX_B64 = 900_000;                                           // حد مستند Firestore = 1MiB

const b64ToBytes = (b64) => { const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; };

export async function saveFile(env, uid, profile, kind, dataUrl) {
  if (!KINDS.includes(kind)) throw new HttpError(400, 'bad_file');
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m || m[1].length < 200 || m[1].length > MAX_B64 || !m[1].startsWith('/9j/')) throw new HttpError(400, 'bad_image'); // '/9j/' = توقيع JPEG
  if (!profile && !REG_KINDS.includes(kind)) throw new HttpError(403, 'no_profile');
  if (profile && profile.status !== 'active' && profile.role !== 'admin' && !REG_KINDS.includes(kind)) throw new HttpError(403, 'account_not_active');
  const limit = await rateLimit(env, 'upload', uid, 3600e3, 30, 'too_many_uploads');
  const id = newId(), size = b64ToBytes(m[1]).length;
  await F.run(env, [limit, F.create(`files/${id}`, { id, owner: uid, kind, mime: 'image/jpeg', size, created_at: now(), data: m[1] })]);
  return 'fs:' + id;
}

/** التأكد إن كل الملفات المشار لها تخص المستخدم (يمنع الإشارة لملفات غيره) — بنقرا بيانات الوصول بس من غير الصورة */
export async function ownFiles(env, uid, refs) {
  const ids = [...new Set(refs.filter(Boolean).map((r) => String(r).slice(3)))];
  if (!ids.length) return;
  const rows = await F.getMany(env, 'files', ids, ['owner']);
  if (rows.some((r) => !r || r.owner !== uid)) throw new HttpError(400, 'bad_file');
}

export async function readFile(env, viewer, id) {
  if (!/^[A-Za-z0-9]{10,40}$/.test(id)) throw new HttpError(400, 'bad_id');
  const f = await F.get(env, `files/${id}`);
  if (!f) throw new HttpError(404, 'not_found');
  if (!(f.owner === viewer.uid || viewer.role === 'admin' || SHARED.includes(f.kind))) throw new HttpError(403, 'forbidden');
  return new Response(b64ToBytes(f.data), { headers: { 'Content-Type': f.mime, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
}
