// تحديث دوري بدون أي اعتماد خارجي (سهل الاختبار)
/**
 * تحديث دوري (Polling) لأن D1 مفيهاش Realtime.
 *  - بيوقف نفسه لما التاب يتخبّى ويكمل فوراً لما يرجع
 *  - dedupe: ما يستدعيش cb لو البيانات ما اتغيرتش (يحمي الفورمات من إعادة الرسم)
 *  - onError بيتنادى مرة واحدة لكل نوع خطأ؛ ولو رجّع false الـ poll بيتوقف
 *  - stop.now() = تحديث فوري (بعد أي إجراء)
 * الفاصل الزمني (ms) ممكن يبقى دالة عشان يتغير حسب الحالة. اعرف حدود الطلبات المجانية في الـ README.
 */
export function poll(fn, ms, cb, { onError, dedupe = false } = {}) {
  let stopped = false, timer = null, running = false, again = false, last = null, lastErr = null;
  const delay = () => (typeof ms === 'function' ? ms() : ms);
  const schedule = () => { clearTimeout(timer); if (!stopped) timer = setTimeout(tick, delay()); };
  async function tick() {
    clearTimeout(timer);
    if (stopped) return;
    if (running) { again = true; return; }
    if (document.hidden) return schedule();
    running = true;
    try {
      const data = await fn();
      if (stopped) return;
      lastErr = null;
      const key = dedupe ? JSON.stringify(data) : null;
      if (!dedupe || key !== last) { last = key; cb(data); }
    } catch (e) {
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
    if (stopped) return; last = null;
    for (let i = 0; running && i < 100; i++) await new Promise((r) => setTimeout(r, 50));
    await tick();
  };
  return stop;
}
