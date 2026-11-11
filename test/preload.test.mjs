// يتأكد إن modulepreload في index.html مطابق لشجرة الاستيراد الثابتة لـ app.js (مفيش ملف ناقص ولا زيادة ولا مكسور)
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = new URL('../public', import.meta.url).pathname;
const seen = new Set();
const walk = (f) => {
  if (seen.has(f)) return; seen.add(f);
  if (f.startsWith('http')) return;
  const src = readFileSync(path.join(root, f), 'utf8');
  const re = /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) {
    const sp = m[1] || m[2];
    walk(sp.startsWith('http') ? sp : path.posix.normalize(path.posix.join(path.posix.dirname(f), sp)));
  }
};
walk('/js/app.js');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const pre = new Set([...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]));
for (const f of seen) assert.ok(pre.has(f), `ناقص modulepreload لـ ${f}`);
for (const f of pre) { assert.ok(seen.has(f), `modulepreload زيادة/قديم: ${f}`); if (!f.startsWith('http')) assert.ok(existsSync(path.join(root, f)), `الملف مش موجود: ${f}`); }
console.log(`✅ preload test passed (${pre.size} وحدة)`);
