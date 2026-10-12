// مراقبة التشغيل: عدّاد استخدام Firestore (تقدير الكوتا اليومية) + تسجيل الأخطاء + تحويل اختياري لـ Sentry.
// التصميم:
//  - عدّاد الاستخدام بيتجمّع جوه الـ isolate (firestore.js) وبيتفضّى كتابةً في metrics/{YYYY-MM-DD} من غير ما يوقفش الرد.
//  - ما بنكتبش مع كل طلب: بنلمّ عدد عمليات معيّن (METRICS_FLUSH_OPS) أو نستنى مدة (METRICS_FLUSH_MS) وبعدين كتابة واحدة.
//  - الأخطاء (سيرفر أو واجهة) بتتسجّل في errors/{id} — للمراجعة من تاب «المراقبة» في لوحة الأدمن.
//  - لو التقدير اليومي للقراءات عدّى الحد (METRICS_READ_ALERT، افتراضي 40000) بنبعت تنبيه للإدارة مرة واحدة في اليوم.
//  - Sentry اختياري تماماً: بيشتغل بس لو SENTRY_DSN متحط، وغير كده كل حاجة no-op.
import * as F from './firestore.js';
import { takeStats } from './firestore.js';
import { newId } from './core.js';
import { notify, adminIds, pushEnabled } from './push.js';

const FLUSH_OPS = 25;        // عدد العمليات اللي بعدها بنكتب العدّاد
const FLUSH_MS = 60000;      // أو كل دقيقة (أيهما أسبق)
const READ_ALERT = 40000;    // تنبيه لو قراءات اليوم عدّت الرقم ده

let pending = { reads: 0, writes: 0 };
let lastFlush = 0;

const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const envNum = (env, key, fallback) => { const n = Number(env?.[key]); return Number.isFinite(n) && n > 0 ? n : fallback; };
const disabled = (env) => !env || String(env.METRICS_DISABLED ?? '') === '1';

/** يجمّع عدّاد الـ isolate، ولو استحقنا نكتب بنكتب metrics/{day} في مهمة خلفية. مابيرميش أخطاء أبداً. */
export async function flushMetrics(env, force = false) {
  if (disabled(env)) return;
  try {
    const s = takeStats();
    pending.reads += s.reads; pending.writes += s.writes;
    const total = pending.reads + pending.writes;
    if (!total) return;
    const at = Date.now();
    if (!force && total < envNum(env, 'METRICS_FLUSH_OPS', FLUSH_OPS) && at - lastFlush < envNum(env, 'METRICS_FLUSH_MS', FLUSH_MS)) return;
    const p = pending; pending = { reads: 0, writes: 0 }; lastFlush = at;
    const d = dayKey(at);
    await F.run(env, [F.inc(`metrics/${d}`, { reads: p.reads, writes: p.writes }, { day: d, updated_at: at })]);
    if (p.reads) await maybeAlertQuota(env, d);
  } catch (e) { console.error('metrics_flush_failed', e?.message || e); }
}

/** تنبيه الإدارة لما قراءات اليوم تعدّي الحد — مرة واحدة في اليوم (مستند Alerts/{day}). */
async function maybeAlertQuota(env, d) {
  const limit = envNum(env, 'METRICS_READ_ALERT', READ_ALERT);
  const m = await F.get(env, `metrics/${d}`);
  const reads = Number(m?.reads || 0);
  if (reads < limit) return;
  try { await F.run(env, [F.create(`metrics/${d}/alerts/reads`, { at: Date.now(), reads, limit })]); }
  catch (e) { if (e?.code === 'conflict') return; throw e; } // اتبعت قبل كده النهارده
  if (pushEnabled(env)) await notify(env, await adminIds(env), 'quota_alert', { reads, limit });
}

/** تسجيل خطأ (سيرفر أو واجهة) + زيادة عدّاد أخطاء اليوم. مابيرميش أخطاء أبداً. */
export async function recordError(env, info = {}) {
  if (disabled(env)) return;
  try {
    const at = Date.now();
    const id = newId();
    await F.run(env, [
      F.create(`errors/${id}`, {
        id, source: info.source || 'server', route: String(info.route || '').slice(0, 120), uid: info.uid || null,
        status: Number(info.status) || 500, message: String(info.message || '').slice(0, 500), stack: String(info.stack || '').slice(0, 2000),
        url: String(info.url || '').slice(0, 300), at,
      }),
      F.inc(`metrics/${dayKey(at)}`, { errors: 1 }, { day: dayKey(at), updated_at: at }),
    ]);
  } catch (e) { console.error('record_error_failed', e?.message || e); }
}

/** تحويل خطأ السيرفر لـ Sentry (اختياري: بيشتغل بس لو SENTRY_DSN متحط). مابيرميش أخطاء أبداً. */
export async function sentryCapture(env, err, ctx = {}) {
  const dsn = env?.SENTRY_DSN;
  if (!dsn) return;
  try {
    const u = new URL(dsn);
    const project = u.pathname.replace(/^\//, '');
    const url = `${u.protocol}//${u.host}/api/${project}/store/`;
    const header = `Sentry sentry_version=7, sentry_client=ashanli/1.0, sentry_key=${u.username}`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sentry-Auth': header },
      body: JSON.stringify({
        timestamp: new Date().toISOString(), platform: 'javascript', level: 'error',
        logger: 'ashanli-api', environment: String(env.SENTRY_ENV || 'production'),
        message: String(err?.message || err || 'error').slice(0, 500),
        extra: { route: ctx.route || null, uid: ctx.uid || null, stack: String(err?.stack || '').slice(0, 2000) },
      }),
    });
  } catch (e) { console.error('sentry_failed', e?.message || e); }
}
