// منطق "جيب البيانات بس لو اتغيّرت" من غير أي اعتماد على المتصفح/الشبكة (سهل الاختبار). شوف sync.js للتوصيل بالـ API.
import { poll } from './poll.js';

export function makeSync(fetchStamps) {
  let cache = null, at = 0, inflight = null;
  /** آخر عدّادات (بنشارك نفس الطلب بين المحدّثات اللي بتشتغل في نفس اللحظة) */
  const stamps = (maxAge = 2500) => {
    if (inflight) return inflight;
    if (cache && Date.now() - at < maxAge) return Promise.resolve(cache);
    inflight = Promise.resolve().then(fetchStamps).then((s) => { cache = s || {}; at = Date.now(); return cache; }).finally(() => { inflight = null; });
    return inflight;
  };
  /** gate لـ poll: true لو أي عدّاد من kinds اتغيّر (أو كل `every` دورة كأمان). لو الطلب فشل: true (نجيب البيانات عادي). */
  const gate = (kinds, { every = 10 } = {}) => {
    let seen = null, skips = 0;
    const g = async () => {
      try {
        const s = await stamps();
        const cur = kinds.map((k) => s[k] ?? 0).join(',');
        if (cur === seen && ++skips < every) return false;
        seen = cur; skips = 0; return true;
      } catch { return true; }
    };
    g.reset = () => { seen = null; };
    return g;
  };
  /** poll يجيب البيانات بس لما kinds تتغيّر. نفس واجهة poll. */
  const gpoll = (kinds, fn, ms, cb, { every, ...opts } = {}) => poll(fn, ms, cb, { ...opts, gate: gate(kinds, every ? { every } : {}) });
  return { stamps, gate, gpoll };
}
