// تحديث دوري بدون أي اعتماد خارجي (سهل الاختبار)
/**
 * تحديث دوري (Polling) لأن السيرفر بيقرا من Firestore بالطلب (مفيش Realtime).
 *  - بيوقف نفسه لما التاب يتخبّى ويكمل فوراً لما يرجع
 *  - dedupe: ما يستدعيش cb لو البيانات ما اتغيرتش (يحمي الفورمات من إعادة الرسم)
 *  - onError بيتنادى مرة واحدة لكل نوع خطأ؛ ولو رجّع false الـ poll بيتوقف
 *  - stop.now() = تحديث فوري (بعد أي إجراء)
 *  - gate (اختياري): دالة async بترجّع true/false — لو false الدورة دي بتتخطى من غير ما تنادي fn (بنستخدمها مع sync لتوفير القراءات)
 * الفاصل الزمني (ms) ممكن يبقى دالة عشان يتغير حسب الحالة. اعرف حدود الطلبات المجانية في الـ README.
 */
export function poll(fn, ms, cb, { onError, dedupe = false, gate = null } = {}) {
  let stopped = false, timer = null, running = false, again = false, last = null, lastErr = null, force = true, errCount = 0; // أول دورة وstop.now دايماً بتجيب البيانات
  // POLL_SCALE (من config.js): مضاعف لكل الفواصل. 3 = مناسب للكوتا المجانية في Firestore (50 ألف قراءة/يوم). 1 = السرعة الأصلية (خطة Blaze).
  // لو الطلبات بتفشل (السيرفر/الحصة تحت ضغط) نزوّد الفاصل بالتدريج (×2 لحد ×8) مع عشوائية ±20% عشان العملاء ما يضربوش السيرفر مع بعض، ويرجع طبيعي أول نجاح.
  const delay = () => Math.round((typeof ms === 'function' ? ms() : ms) * (globalThis.POLL_SCALE ?? 1) * Math.min(2 ** errCount, 8) * (errCount ? 0.8 + Math.random() * 0.4 : 1));
  const schedule = () => { clearTimeout(timer); if (!stopped) timer = setTimeout(tick, delay()); };
  async function tick() {
    clearTimeout(timer);
    if (stopped) return;
    if (running) { again = true; return; }
    if (document.hidden) return schedule();
    running = true;
    try {
      const go = gate ? await gate() : true; // بنسأل gate دايماً (عشان يسجّل آخر حالة) حتى لو الدورة إجبارية
      if (!go && !force) return;
      force = false;
      const data = await fn();
      if (stopped) return;
      lastErr = null; errCount = 0;
      const key = dedupe ? JSON.stringify(data) : null;
      if (!dedupe || key !== last) { last = key; cb(data); }
    } catch (e) {
      errCount = Math.min(errCount + 1, 3); gate?.reset?.(); // فشل الجلب: نعيد المحاولة في الدورة الجاية حتى لو مفيش تغيير
      if (!stopped && e.code !== lastErr) { lastErr = e.code; if (onError?.(e) === false) stopped = true; }
    } finally {
      running = false;
      if (again && !stopped) { again = false; tick(); } else schedule();
    }
  }
  const onVis = () => { if (!document.hidden && !stopped) tick(); };
  document.addEventListener('visibilitychange', onVis);
  tick();
  const stop = () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); };
  stop.now = async () => { // تحديث فوري: يستنى أي طلب شغال وبعدها يجيب البيانات الجديدة
    if (stopped) return; last = null; force = true;
    for (let i = 0; running && i < 100; i++) await new Promise((r) => setTimeout(r, 50));
    await tick();
  };
  return stop;
}
