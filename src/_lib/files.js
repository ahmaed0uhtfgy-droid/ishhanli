// تخزين الصور: بما إن Firebase Storage و Cloudflare R2 بقوا الاتنين محتاجين كارت، الصور بتتخزن كـ base64
// مباشرة كـ field جوه مستند filesMeta نفسه (بالظبط زي ما كانت متخزنة في D1 الأصلي). ده بيحطنا تحت حد حجم
// مستند Firestore (1MB)، فده سبب وجود MAX_B64 (نفس الحد اللي كان مطبّق أصلاً).
import { HttpError, newId } from './core.js';
import { filesMetaCol, now } from './db.js';

export const KINDS = ['id', 'license', 'vehicle', 'vehiclePhoto', 'cargo', 'handover', 'payment', 'evidence'];
const SHARED = ['cargo', 'handover', 'vehiclePhoto', 'evidence'];
const REG_KINDS = ['id', 'license', 'vehicle', 'vehiclePhoto'];
const MAX_B64 = 900_000; // هامش أمان تحت حد الـ 1MB بتاع مستند Firestore (بعد إضافة باقي الحقول)

export async function saveFile(uid, profile, kind, dataUrl) {
  if (!KINDS.includes(kind)) throw new HttpError(400, 'bad_file');
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m || m[1].length < 200 || m[1].length > MAX_B64 || !m[1].startsWith('/9j/')) throw new HttpError(400, 'bad_image');
  if (!profile && !REG_KINDS.includes(kind)) throw new HttpError(403, 'no_profile');
  if (profile && profile.status !== 'active' && profile.role !== 'admin' && !REG_KINDS.includes(kind)) throw new HttpError(403, 'account_not_active');
  const since = now() - 3600e3;
  const recentSnap = await filesMetaCol().where('owner', '==', uid).where('createdAt', '>', since).count().get();
  if (recentSnap.data().count >= 30) throw new HttpError(429, 'too_many_uploads');
  const id = newId();
  await filesMetaCol().doc(id).set({ id, owner: uid, kind, mime: 'image/jpeg', size: Math.round(m[1].length * 0.75), data: m[1], createdAt: now() });
  return 'fs:' + id;
}

export async function ownFiles(uid, refs) {
  const ids = [...new Set(refs.filter(Boolean).map((r) => String(r).slice(3)))];
  if (!ids.length) return;
  const snaps = await Promise.all(ids.map((id) => filesMetaCol().doc(id).get()));
  if (snaps.some((s) => !s.exists || s.data().owner !== uid)) throw new HttpError(400, 'bad_file');
}

export async function readFile(viewer, id) {
  if (!/^[A-Za-z0-9]{10,40}$/.test(id)) throw new HttpError(400, 'bad_id');
  const snap = await filesMetaCol().doc(id).get();
  if (!snap.exists) throw new HttpError(404, 'not_found');
  const meta = snap.data();
  if (!(meta.owner === viewer.uid || viewer.role === 'admin' || SHARED.includes(meta.kind))) throw new HttpError(403, 'forbidden');
  const bin = atob(meta.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime: meta.mime };
}
