// فحص صياغة كل ملفات JS/MJS في المشروع (من غير تشغيلها) — بيمسك أي خطأ لصق/قص قبل النشر.
import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
const skip = new Set(['node_modules', '.git', 'vendor', 'test-results', 'playwright-report', 'coverage', '.wrangler']);
const files = [];
(function walk(d) { for (const n of readdirSync(d)) { if (skip.has(n)) continue; const p = join(d, n); statSync(p).isDirectory() ? walk(p) : ['.js', '.mjs'].includes(extname(p)) && files.push(p); } })('.');
let bad = 0;
for (const f of files) { const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }); if (r.status !== 0) { bad++; console.error('✗', f, '\n', r.stderr.split('\n').slice(0, 4).join('\n')); } }
console.log(`${files.length - bad}/${files.length} ملف سليم`);
process.exit(bad ? 1 : 0);
