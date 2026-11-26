import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeOrigin, currentOrigin, rewrite, rewriteLanding, FILES } from '../../scripts/set-domain.mjs';

describe('set-domain', () => {
  it('normalizeOrigin: بيقبل https بدون مسار ويشيل السلاش', () => { expect(normalizeOrigin('https://example.com/')).toBe('https://example.com'); expect(normalizeOrigin('https://www.my-site.com.eg')).toBe('https://www.my-site.com.eg'); });
  it('بيرفض http والمسار والقيم الفاسدة', () => { for (const bad of ['http://example.com', 'https://example.com/path', 'https://example.com?x=1', 'example.com', '', 'https://', 'https://localhost', 'javascript:alert(1)']) expect(() => normalizeOrigin(bad), bad).toThrow(); });
  it('currentOrigin بيقرا LP_ORIGIN الفعلي، وكل ملف في القايمة فيه الدومين الحالي (يعني السكربت هيغطيهم)', () => {
    const from = currentOrigin(readFileSync(new URL('../../public/js/landing-content.js', import.meta.url), 'utf8')); expect(from).toMatch(/^https:\/\//);
    for (const f of FILES) expect(readFileSync(new URL('../../' + f, import.meta.url), 'utf8'), f).toContain(from);
  });
  it('rewrite: بيستبدل كل المواضع وidempotent، ومش بيلمس نصوص تانية', () => { const t = 'a https://old.dev/x b https://old.dev/y https://other.dev'; const r = rewrite(t, 'https://old.dev', 'https://new.com'); expect(r).toBe('a https://new.com/x b https://new.com/y https://other.dev'); expect(rewrite(r, 'https://old.dev', 'https://new.com')).toBe(r); });
  it('مفيش ملف وظيفي تاني فيه الدومين الثابت خارج القايمة (وإلا السكربت يفوّته)', () => {
    const from = currentOrigin(readFileSync(new URL('../../public/js/landing-content.js', import.meta.url), 'utf8')), host = new URL(from).hostname;
    const files = ['functions/index.js', 'functions/sitemap.xml.js', 'functions/_lib/pages.js', 'functions/_lib/routes.js', 'functions/_lib/landing.js', 'functions/_lib/llms.js', 'functions/_lib/publicProfile.js', 'public/index.html', 'public/manifest.webmanifest', 'public/_headers', 'public/sw.js', 'wrangler.toml'];
    for (const f of files) expect(readFileSync(new URL('../../' + f, import.meta.url), 'utf8').includes(host), f).toBe(false);
  });
  it('rewriteLanding: بيبدّل LP_ORIGIN بس ويضيف القديم لقايمة KNOWN_OLD (من غير تكرار)', () => {
    const src = readFileSync(new URL('../../public/js/landing-content.js', import.meta.url), 'utf8'), from = currentOrigin(src);
    const out = rewriteLanding(src, from, 'https://new.example.com'); expect(currentOrigin(out)).toBe('https://new.example.com'); expect(out).toContain(`const KNOWN_OLD = ['${from}']`);
    const out2 = rewriteLanding(out, 'https://new.example.com', 'https://third.example.com'); expect(out2).toContain(`const KNOWN_OLD = ['${from}', 'https://new.example.com']`);
    expect(rewriteLanding(rewriteLanding(out2, 'https://third.example.com', 'https://new.example.com'), 'https://new.example.com', 'https://new.example.com').split('https://third.example.com').length).toBeGreaterThan(1);
  });
});
