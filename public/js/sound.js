// تنبيه صوتي للطلب الجديد (بدون ملفات صوت: نغمات من WebAudio). المتصفح بيسمح بالصوت بعد أول ضغطة من المستخدم.
let ctx = null;
const AC = () => window.AudioContext || window.webkitAudioContext;
export function unlockAudio() { try { ctx ||= new (AC())(); ctx.resume(); } catch { /* الصوت اختياري */ } }
export function chime(times = 3) {
  try {
    ctx ||= new (AC())(); if (ctx.state === 'suspended') ctx.resume();
    for (let i = 0; i < times; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain(), t0 = ctx.currentTime + i * 0.24;
      o.type = 'sine'; o.frequency.value = i % 2 ? 660 : 880;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
      o.connect(g); g.connect(ctx.destination); o.start(t0); o.stop(t0 + 0.22);
    }
    navigator.vibrate?.([200, 100, 200]);
  } catch { /* ignore */ }
}
