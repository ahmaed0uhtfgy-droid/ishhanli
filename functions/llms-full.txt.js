// /llms-full.txt: ملخص للذكاء الاصطناعي من حقائق النظام الفعلية (functions/_lib/llms.js)
import { DEFAULTS, loadSettings } from './_lib/logic.js';
import { buildLlms } from './_lib/llms.js';

export async function onRequest({ env }) {
  let s = DEFAULTS;
  try { if (env.FIREBASE_SERVICE_ACCOUNT) s = await loadSettings(env); } catch (e) { console.error('llms_settings_failed', e?.message || e); }
  return new Response(buildLlms(s, env, true), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=600' } });
}
