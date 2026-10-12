// بلاغات أخطاء الواجهة للسيرفر (بتظهر في تاب «المراقبة» عند الأدمن).
// محدودة بتخنق بسيط: بلاغ واحد كل 30 ثانية، وحد أقصى 5 بلاغات لكل تحميل صفحة — عشان مايحصلش إغراق.
import { api } from './api.js';
import { state } from './state.js';

const MAX_PER_LOAD = 5;
const MIN_GAP_MS = 30000;

export function initErrorReporting() {
  let last = 0, n = 0;
  const send = (message, stack) => {
    try {
      if (!state.user || n >= MAX_PER_LOAD) return;
      const at = Date.now();
      if (at - last < MIN_GAP_MS) return;
      last = at; n++;
      api('client/error', {
        message: String(message || 'error').slice(0, 400),
        stack: String(stack || '').slice(0, 1500),
        url: location.href.slice(0, 250),
        route: location.hash.slice(0, 100),
      }).catch(() => {});
    } catch { /* ماينفعش نكسر التطبيق بسبب بلاغ */ }
  };
  window.addEventListener('error', (e) => send(e?.message, e?.error?.stack));
  window.addEventListener('unhandledrejection', (e) => send(e?.reason?.message || e?.reason, e?.reason?.stack));
}
