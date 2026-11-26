import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { recordError, flushMetrics, sentryCapture } from '../../functions/_lib/metrics.js';
import { boot } from '../helpers/harness.mjs';

let h;
beforeAll(async () => { h = await boot({ METRICS_DISABLED: undefined }); delete h.env.METRICS_DISABLED; });
afterAll(() => h.restore());

describe('metrics', () => {
  it('recordError: بيسجّل الخطأ بحدود الطول ويزوّد عدّاد اليوم', async () => {
    await recordError(h.env, { source: 'client', route: 'r'.repeat(500), uid: 'u1', status: 500, message: 'm'.repeat(900), stack: 's'.repeat(5000), url: 'u'.repeat(900) });
    const e = h.FS.list('errors')[0]; expect(e.route.length).toBe(120); expect(e.message.length).toBe(500); expect(e.stack.length).toBe(2000); expect(e.url.length).toBe(300); expect(e.source).toBe('client');
    const day = h.FS.list('metrics')[0]; expect(day.errors).toBeGreaterThanOrEqual(1);
  });
  it('recordError: بدون مدخلات / METRICS_DISABLED=1 ما يكسرش ولا يكتب', async () => {
    await expect(recordError(h.env)).resolves.toBeUndefined(); const n = h.FS.list('errors').length;
    await recordError({ ...h.env, METRICS_DISABLED: '1' }, { message: 'x' }); expect(h.FS.list('errors').length).toBe(n);
  });
  it('flushMetrics: بيجمّع عمليات Firestore الحقيقية في عدّاد اليوم، ومعطّل = لا شيء', async () => {
    h.user('mcust', { role: 'customer' });
    await flushMetrics(h.env, true); // تصفير العدّاد المعلّق من اللي فات
    const dayDoc = () => h.FS.list('metrics').find((d) => typeof d.reads === 'number') || { reads: 0, writes: 0 };
    const before = dayDoc();
    for (let i = 0; i < 5; i++) await h.call('mcust', 'orders/list', {}); // قراءات حقيقية
    await flushMetrics({ ...h.env, METRICS_DISABLED: '1' }, true); // معطّل: ما يكتبش
    expect(dayDoc().reads).toBe(before.reads);
    await flushMetrics(h.env, true);
    expect(dayDoc().reads).toBeGreaterThan(before.reads);
  });
  it('sentryCapture: من غير DSN لا يعمل أي طلب شبكة؛ ومع DSN بيبعت لـSentry ويتحمّل فشل الشبكة', async () => {
    const calls = []; const inner = globalThis.fetch; globalThis.fetch = async (u, i) => { calls.push(String(u)); if (String(u).includes('sentry.test')) throw new Error('net down'); return inner(u, i); };
    await sentryCapture({}, new Error('x')); expect(calls).toEqual([]);
    await expect(sentryCapture({ SENTRY_DSN: 'https://abc123@sentry.test/42' }, new Error('boom'), { route: 'x' })).resolves.toBeUndefined();
    expect(calls.some((c) => c === 'https://sentry.test/api/42/store/')).toBe(true);
    await expect(sentryCapture({ SENTRY_DSN: 'not a url' }, new Error('x'))).resolves.toBeUndefined(); // DSN فاسد لا يكسر
    globalThis.fetch = inner;
  });
});
