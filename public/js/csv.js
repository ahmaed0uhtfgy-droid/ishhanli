// تصدير CSV يفتح سليم في Excel بالعربي (UTF-8 مع BOM). النصوص اللي بتبدأ بـ = + - @ بتتحصّن من "حقن الصيغ" (الأسماء جاية من المستخدمين).
const cell = (v) => {
  let s = v == null ? '' : String(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
/** cols: [{ h: 'عنوان العمود', v: (row) => قيمة }] */
export const toCsv = (cols, rows) => '\ufeff' + [cols.map((c) => cell(c.h)).join(','), ...rows.map((r) => cols.map((c) => cell(c.v(r))).join(','))].join('\r\n');
export function downloadCsv(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** تنزيل نص كـ JSON (للنسخ الاحتياطي) */
export function downloadJson(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
