// فحص بسيط على الجهاز لصور المستندات (بطاقة/رخصة/سجل): بيرفض الصور الواضح إنها غلط (صغيرة، ضلمة، مبهورة، فاضية/من غير كتابة،
// مهزوزة، أو سيلفي لوش) ولسه مش بيفرّق بين البطاقة والرخصة — الأدمن بيراجع المستند في كل الأحوال.
// الأعتاب محافظة عن قصد عشان نتجنب رفض صورة سليمة.
import { toast, errMsg } from './ui.js';

export const DOC_KINDS = new Set(['id', 'license', 'vehicle', 'company']);

/** مقاييس الصورة من بكسلات RGBA (دالة نقية — قابلة للاختبار) */
export function analyzePixels(d, w, h) {
  const n = w * h, g = new Float32Array(n); let sum = 0, skin = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = d[p], gg = d[p + 1], b = d[p + 2], y = 0.299 * r + 0.587 * gg + 0.114 * b;
    g[i] = y; sum += y;
    if (r > 95 && gg > 40 && b > 20 && Math.max(r, gg, b) - Math.min(r, gg, b) > 15 && Math.abs(r - gg) > 15 && r > gg && r > b) skin++;
  }
  const mean = sum / n; let v = 0; for (let i = 0; i < n; i++) v += (g[i] - mean) ** 2;
  let lapSum = 0, lapSq = 0, edges = 0, cnt = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
    lapSum += lap; lapSq += lap * lap; cnt++;
    if (Math.abs(g[i + 1] - g[i - 1]) + Math.abs(g[i + w] - g[i - w]) > 40) edges++;
  }
  return { mean, sd: Math.sqrt(v / n), lapVar: lapSq / cnt - (lapSum / cnt) ** 2, edge: edges / cnt, skin: skin / n };
}

/** بيرجّع سبب الرفض (أو null لو الصورة مقبولة) */
export function judge(m) {
  if (m.mean < 45) return 'dark';
  if (m.mean > 235) return 'bright';
  if (m.sd < 14 || m.edge < 0.02) return 'blank';
  if (m.lapVar < 25) return 'blurry';
  if (m.skin > 0.6) return 'selfie';
  return null;
}

/** src: ImageBitmap أو canvas. بيرجّع { ok, reason } */
export async function checkSource(src, w0, h0, kind) {
  if (!DOC_KINDS.has(kind)) return { ok: true };
  if (Math.min(w0, h0) < 320) return { ok: false, reason: 'small' };
  const k = Math.min(1, 480 / Math.max(w0, h0)), w = Math.round(w0 * k), h = Math.round(h0 * k);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(src, 0, 0, w, h);
  let why = judge(analyzePixels(ctx.getImageData(0, 0, w, h).data, w, h));
  if (!why && 'FaceDetector' in globalThis) { // متاح في بعض المتصفحات (كروم أندرويد): وش كبير = سيلفي مش مستند
    try {
      const faces = await new globalThis.FaceDetector({ fastMode: true, maxDetectedFaces: 3 }).detect(c);
      if (Math.max(0, ...faces.map((f) => f.boundingBox.width * f.boundingBox.height)) / (w * h) > 0.18) why = 'selfie';
    } catch { /* مش قادرين نكشف: نعدّي */ }
  }
  return why ? { ok: false, reason: why } : { ok: true };
}

/** فحص فوري أول ما المستخدم يختار الملف: لو مرفوض بنمسح الاختيار ونطلب صورة تانية */
export function attachDocCheck(form, kinds) {
  form.addEventListener('change', async (e) => {
    const inp = e.target, kind = kinds[inp?.name], file = inp?.files?.[0];
    if (!kind || !file) return;
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const v = await checkSource(bmp, bmp.width, bmp.height, kind);
      if (!v.ok) { inp.value = ''; toast(errMsg({ code: 'img_' + v.reason }), true); }
    } catch { /* مش قادرين نفحص: الأدمن بيراجع */ }
  });
}
