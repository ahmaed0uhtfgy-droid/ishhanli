// عدّادات التغيير: بدل ما كل صفحة تجيب قوائمها كاملة كل كام ثانية (وتستهلك قراءات Firestore)،
// بنسأل `sync` (قراءة واحدة، مشتركة بين كل الصفحات المفتوحة) وبنجيب القائمة بس لما عدّاد النوع بتاعها يتغيّر.
import { api } from './api.js';
import { makeSync } from './gate.js';

export const { stamps, gate, gpoll } = makeSync(() => api('sync', {}).then((r) => r.stamp || {}));
