// حقائق النظام للنصوص الثابتة في صفحات التطبيق (الشروط، الإشعارات…): من إعدادات المستخدم لو متاحة، وإلا من الأرقام العامة اللي السيرفر حطّها في الصفحة (#lpPub).
import { state } from './state.js';
import { lpFacts } from './landing-content.js';

export function siteFacts() {
  if (state.settings && !state.settings._failed) return lpFacts(state.settings, {});
  try { return JSON.parse(document.getElementById('lpPub')?.textContent || 'null')?.facts || lpFacts({}); } catch { return lpFacts({}); }
}
