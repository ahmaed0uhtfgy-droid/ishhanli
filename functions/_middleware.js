// بيحدّد دومين الموقع من SITE_ORIGIN (اختياري) قبل أي Function، فتغيير الدومين = تغيير متغيّر بيئة بس.
import { setSiteOrigin } from '../public/js/landing-content.js';

export async function onRequest({ env, next }) {
  setSiteOrigin(env.SITE_ORIGIN, env.OLD_SITE_ORIGINS);
  return next();
}
