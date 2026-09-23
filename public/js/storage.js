import { auth } from './firebase.js';
import { api } from './api.js';

// حجم/جودة الصورة حسب النوع: المستندات محتاجة وضوح، وصور الشحنة أخف عشان قاعدة D1 المجانية حدها 500MB
const PROFILE = { id: [1280, 0.7], license: [1280, 0.7], vehicle: [1280, 0.7], payment: [1280, 0.7], vehiclePhoto: [1024, 0.62], cargo: [1024, 0.62], handover: [1024, 0.62], evidence: [1024, 0.62] };

export async function compress(file, maxDim, quality) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  if (!bmp) throw Object.assign(new Error('bad_image'), { code: 'bad_image' });
  const k = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return { dataUrl: c.toDataURL('image/jpeg', quality), canvas: c };
}

/** يضغط الصورة في المتصفح ويرفعها للسيرفر. بيرجّع مرجع نصي 'fs:<id>' */
export async function uploadImage(file, kind) {
  if (!file || !file.type?.startsWith('image/')) throw Object.assign(new Error('bad_image'), { code: 'bad_image' });
  const [dim, q] = PROFILE[kind] || [1024, 0.62];
  let { dataUrl, canvas } = await compress(file, dim, q);
  for (const qq of [0.5, 0.4, 0.3]) { if (dataUrl.length <= 900000) break; dataUrl = canvas.toDataURL('image/jpeg', qq); }
  if (dataUrl.length > 950000) throw Object.assign(new Error('bad_image'), { code: 'bad_image' });
  return (await api('files/upload', { kind, data: dataUrl })).ref;
}

const cache = new Map();
/** يجيب الصورة من السيرفر (بتوكن الدخول) ويحوّلها لرابط مؤقت صالح للعرض */
export function resolveImg(ref) {
  if (!ref) return Promise.resolve('');
  if (cache.has(ref)) return cache.get(ref);
  const p = (async () => {
    const r = await fetch('/api/files/' + String(ref).slice(3), { headers: { Authorization: 'Bearer ' + (await auth.currentUser.getIdToken()) } });
    return r.ok ? URL.createObjectURL(await r.blob()) : '';
  })().catch(() => '');
  cache.set(ref, p); p.then((v) => { if (!v) cache.delete(ref); });
  return p;
}
export function clearImgCache() { for (const p of cache.values()) p.then((u) => u && URL.revokeObjectURL(u)); cache.clear(); }

/** أي <img data-ref="…"> جوه العنصر بيتحمّل تلقائياً */
export function hydrate(root) {
  root.querySelectorAll('img[data-ref]').forEach(async (img) => {
    if (img.dataset.done) return; img.dataset.done = '1';
    img.src = (await resolveImg(img.dataset.ref)) || 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/%3E';
  });
}
export const imgTag = (ref, cls = '') => `<img data-ref="${String(ref).replace(/"/g, '')}" data-zoom="1" class="${cls}" alt="" loading="lazy">`;
