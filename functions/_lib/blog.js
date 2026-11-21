// نظام المقالات (SEO): تخزين في Firestore، توليد بالذكاء الاصطناعي (Gemini أو Claude) كمسودات، تعديل/إضافة يدوي من الأدمن، وتشغيل تلقائي بجدول.
// الأمان: النص بيتعرض عبر mdToHtml (بيهرّب كل HTML الأول)، الروابط المسموحة داخلية أو https بس، والصور من /blog/img/ بس (نوع blog)، والفيديو معرّف يوتيوب بس.
// ما فيش أي رقم/سعر/تقييم بيتألّف: التعليمات للنموذج بتمنع ده، والمراجعة اليدوية هي الافتراضي (مسودة).
import { HttpError, newId } from './core.js';
import { F, now, rateTake } from './db.js';
import { esc } from './landing.js';

// ---------- أدوات نصية ----------
const str = (v, min, max) => { const s = String(v ?? '').replace(/\u0000/g, '').trim(); if (s.length < min) throw new HttpError(400, 'bad_input'); return s.slice(0, max); };
const jparse = (s, d) => { try { const v = JSON.parse(s); return v ?? d; } catch { return d; } };
/** سلاج بحروف عربية/لاتينية وأرقام (الكلمات المفتاحية في الرابط): من غير تشكيل ولا تطويل، وبشرطات */
export const slugify = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
const okUrl = (u) => /^\/(?!\/)[^\s"'<>]*$/.test(u) || /^https:\/\/[^\s"'<>]+$/.test(u);
const YT = /^[A-Za-z0-9_-]{11}$/;
/** يستخرج معرّف يوتيوب من رابط (watch/youtu.be/embed/shorts) أو من المعرّف نفسه؛ غير كده فاضي */
export function youtubeId(v) {
  const s = String(v ?? '').trim(); if (!s) return '';
  if (YT.test(s)) return s;
  try { const u = new URL(s); const h = u.hostname.replace(/^www\./, ''); let id = '';
    if (h === 'youtu.be') id = u.pathname.slice(1); else if (h === 'youtube.com' || h === 'm.youtube.com' || h === 'youtube-nocookie.com') id = u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop() || '';
    return YT.test(id) ? id : ''; } catch { return ''; }
}

const inline = (t) => esc(t)
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, url) => { const raw = url.replace(/&amp;/g, '&'); return okUrl(raw) ? `<a href="${esc(raw)}"${raw.startsWith('http') ? ' rel="noopener nofollow" target="_blank"' : ''}>${txt}</a>` : txt; });

/** Markdown مبسّط → HTML آمن. بيدعم: ## عنوان، ### عنوان فرعي، قوائم - و1.، **غامق**، [نص](رابط)، [[img:N]] صورة رقم N، [[video]] */
export function mdToHtml(md, { images = [], video = '', title = '' } = {}) {
  const out = []; let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line0 of String(md ?? '').replace(/\r/g, '').split('\n')) {
    const line = line0.trim();
    if (!line) { close(); continue; }
    let m;
    if ((m = /^\[\[img:(\d+)\]\]$/.exec(line))) { close(); const im = images[Number(m[1]) - 1]; if (im) out.push(`<figure class="blog-fig"><img src="/blog/img/${esc(im.id)}" alt="${esc(im.alt || '')}" loading="lazy" decoding="async">${im.alt ? `<figcaption>${esc(im.alt)}</figcaption>` : ''}</figure>`); continue; }
    if (line === '[[video]]') { close(); if (video) out.push(videoHtml(video, title)); continue; }
    if ((m = /^(#{1,2})\s+(.+)$/.exec(line))) { close(); out.push(`<h2>${inline(m[2])}</h2>`); continue; }
    if ((m = /^#{3,4}\s+(.+)$/.exec(line))) { close(); out.push(`<h3>${inline(m[1])}</h3>`); continue; }
    if ((m = /^[-*•]\s+(.+)$/.exec(line))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = /^\d+[.)]\s+(.+)$/.exec(line))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    close(); out.push(`<p>${inline(line)}</p>`);
  }
  close(); return out.join('\n');
}
export const videoHtml = (id, title = '') => YT.test(id) ? `<div class="blog-video"><iframe src="https://www.youtube-nocookie.com/embed/${id}" title="${esc(title || 'فيديو')}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>` : '';

// ---------- تنظيف المدخلات ----------
export function cleanArticle(b, { partial = false } = {}) {
  const title = str(b.title, 5, 140);
  const body = String(b.body ?? '').replace(/\u0000/g, '').trim().slice(0, 40000);
  if (body.length < (partial ? 0 : 30)) throw new HttpError(400, 'bad_input');
  const faq = (Array.isArray(b.faq) ? b.faq : []).slice(0, 8).map((x) => [String(x?.[0] ?? '').trim().slice(0, 200), String(x?.[1] ?? '').trim().slice(0, 800)]).filter(([q, a]) => q && a);
  const images = (Array.isArray(b.images) ? b.images : []).slice(0, 12).map((x) => ({ id: String(x?.id ?? ''), alt: String(x?.alt ?? '').trim().slice(0, 140) })).filter((x) => /^[A-Za-z0-9]{10,40}$/.test(x.id));
  const keywords = [...new Set((Array.isArray(b.keywords) ? b.keywords : []).map((k) => String(k).trim().slice(0, 60)).filter(Boolean))].slice(0, 15);
  const status = b.status === 'published' ? 'published' : 'draft';
  return {
    title, body, faq, images, keywords, status,
    description: String(b.description ?? '').trim().slice(0, 170) || body.replace(/[#*\[\]()>-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160),
    excerpt: String(b.excerpt ?? '').trim().slice(0, 300),
    video: youtubeId(b.video),
    slug: slugify(b.slug) || slugify(title),
  };
}

const rowOut = (r, full = false) => ({
  id: r.id, slug: r.slug, title: r.title, description: r.description || '', excerpt: r.excerpt || '', status: r.status, source: r.source || 'manual', topic: r.topic || '', angle: r.angle || '',
  video: r.video || '', publishedAt: r.published_at || null, createdAt: r.created_at || 0, updatedAt: r.updated_at || 0,
  ...(full ? { body: r.body || '', faq: jparse(r.faq_json, []), images: jparse(r.images_json, []), keywords: jparse(r.keywords_json, []) } : { hasImage: (jparse(r.images_json, []) || []).length > 0 }),
});

async function uniqueSlug(env, slug, selfId = null) {
  let s = slug || 'maqal', n = 1;
  for (;;) {
    const cand = n === 1 ? s : `${s}-${n}`;
    const rows = await F.query(env, 'articles', { eq: { slug: cand }, limit: 2 });
    if (!rows.some((r) => r.id !== selfId)) return cand;
    if (++n > 30) return `${s}-${newId().slice(0, 5)}`;
  }
}

// ---------- كاش القراءات العامة (الكوتا) ----------
let pubCache = { at: 0, v: null };
export const clearBlogCache = () => { pubCache = { at: 0, v: null }; };
export async function publishedList(env) {
  if (pubCache.v && Date.now() - pubCache.at < 300000) return pubCache.v;
  const rows = await F.query(env, 'articles', { eq: { status: 'published' }, limit: 300 });
  const v = rows.map((r) => rowOut(r)).sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
  pubCache = { at: Date.now(), v }; return v;
}
export async function publishedBySlug(env, slug) {
  const rows = await F.query(env, 'articles', { eq: { slug: String(slug || '').slice(0, 120) }, limit: 1 });
  return rows[0] && rows[0].status === 'published' ? rowOut(rows[0], true) : null;
}

// ---------- حفظ/حذف ----------
export async function saveArticle(env, b, { source = 'manual', topic = '', angle = '' } = {}) {
  const c = cleanArticle(b);
  const id = b.id ? String(b.id) : newId();
  const old = b.id ? await F.get(env, `articles/${id}`) : null;
  if (b.id && !old) throw new HttpError(404, 'not_found');
  const slug = await uniqueSlug(env, c.slug, old ? id : null);
  const t = now();
  const publishedAt = c.status === 'published' ? (old?.published_at || t) : (old?.published_at || null);
  await F.run(env, [F.set(`articles/${id}`, {
    id, slug, title: c.title, description: c.description, excerpt: c.excerpt, body: c.body, status: c.status, video: c.video,
    faq_json: JSON.stringify(c.faq), images_json: JSON.stringify(c.images), keywords_json: JSON.stringify(c.keywords),
    source: old?.source || source, topic: old?.topic ?? topic, angle: old?.angle ?? angle,
    created_at: old?.created_at || t, updated_at: t, published_at: publishedAt,
  })]);
  clearBlogCache();
  return { ...rowOut({ ...c, id, slug, faq_json: JSON.stringify(c.faq), images_json: JSON.stringify(c.images), keywords_json: JSON.stringify(c.keywords), source: old?.source || source, topic, angle, created_at: old?.created_at || t, updated_at: t, published_at: publishedAt }, true) };
}
export async function deleteArticle(env, id) {
  if (!/^[A-Za-z0-9]{10,40}$/.test(String(id))) throw new HttpError(400, 'bad_id');
  await F.run(env, [F.del(`articles/${id}`)]); clearBlogCache();
}

// ---------- الذكاء الاصطناعي ----------
export const aiProvider = (env) => {
  const p = String(env.AI_PROVIDER || '').toLowerCase();
  if (p === 'anthropic' && env.ANTHROPIC_API_KEY) return 'anthropic';
  if (p === 'gemini' && env.GEMINI_API_KEY) return 'gemini';
  return env.GEMINI_API_KEY ? 'gemini' : env.ANTHROPIC_API_KEY ? 'anthropic' : null;
};
const aiErr = (status, code, detail) => { const e = new HttpError(status, code); e.detail = String(detail || '').replace(/key=[^&\s"']+/gi, 'key=***').slice(0, 300); return e; }; // التفاصيل بتوصل للأدمن بس (مسارات admin/)
let geminiPick = null; // آخر موديل اشتغل (أو اتلقى من ListModels)
export const resetAiCache = () => { geminiPick = null; }; // للاختبارات
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** كل موديلات gemini-X-flash المتاحة (من غير lite/preview/…)، الأحدث أولاً */
async function listFlash(env, signal) {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { signal, headers: { 'x-goog-api-key': env.GEMINI_API_KEY } });
  if (!r.ok) return [];
  return ((await r.json()).models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, '')).filter((n) => /^gemini-[\d.]+-flash$/.test(n))
    .sort((a, b) => parseFloat(b.match(/[\d.]+/)[0]) - parseFloat(a.match(/[\d.]+/)[0]));
}
/** استدعاء Gemini: لو الموديل مش موجود (404) أو عليه ضغط (429/5xx) نعيد المحاولة مرة (AI_RETRY_MS) وبعدين نجرّب موديل flash تاني متاح (حتى 4 موديلات). GEMINI_MODEL لو متحدد بيتستخدم هو بس. */
async function geminiCall(env, signal, reqBody) {
  const fixed = env.GEMINI_MODEL, wait = Number(env.AI_RETRY_MS ?? 2500);
  const call = (m) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body: reqBody });
  const queue = [fixed || geminiPick || 'gemini-2.5-flash'], tried = new Set(); let listed = false, last = { status: 0, model: '', msg: '' };
  while (queue.length && tried.size < 4) {
    const model = queue.shift(); if (tried.has(model)) continue; tried.add(model);
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await call(model);
      if (res.ok) { if (!fixed) geminiPick = model; return res; }
      let msg = ''; try { msg = (await res.json())?.error?.message || ''; } catch { /* ignore */ }
      last = { status: res.status, model, msg };
      if ((res.status === 429 || res.status >= 500) && attempt === 0) { await sleep(wait); continue; }
      break;
    }
    if (!fixed && !listed && (last.status === 404 || last.status === 429 || last.status >= 500)) { listed = true; queue.push(...(await listFlash(env, signal)).filter((n) => !tried.has(n))); }
  }
  throw aiErr(502, 'ai_failed', `gemini ${last.status} (${last.model}): ${last.msg}`);
}
async function callAI(env, system, prompt) {
  const prov = aiProvider(env); if (!prov) throw new HttpError(503, 'ai_not_configured');
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 100000);
  try {
    let res, text;
    if (prov === 'gemini') {
      res = await geminiCall(env, ctl.signal, JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.95, maxOutputTokens: 8192, responseMimeType: 'application/json' } }));
      const j = await res.json(); text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    } else {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: 8000, temperature: 1, system, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!res.ok) { let msg = ''; try { msg = (await res.json())?.error?.message || ''; } catch { /* ignore */ } throw aiErr(502, 'ai_failed', `anthropic ${res.status}: ${msg}`); }
      const j = await res.json(); text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    }
    return text;
  } catch (e) { if (e instanceof HttpError) throw e; throw aiErr(502, 'ai_failed', String(e?.message || e)); } finally { clearTimeout(timer); }
}
/** JSON من رد النموذج (بيشيل سياج ``` ويقتطع من أول { لآخر }) */
export function parseAiJson(text) {
  let s = String(text ?? '').replace(/```json|```/gi, '').trim();
  const a = s.indexOf('{'), z = s.lastIndexOf('}'); if (a < 0 || z <= a) throw new HttpError(502, 'ai_bad_output');
  try { return JSON.parse(s.slice(a, z + 1)); } catch { throw new HttpError(502, 'ai_bad_output'); }
}

// زوايا مختلفة لنفس العنوان = مقالات مختلفة فعلاً (مش نسخ متقاربة تضر بالترتيب)
export const ANGLES = [
  ['guide', 'دليل عملي خطوة بخطوة من أول ما يقرر العميل لحد التسليم'],
  ['mistakes', 'أخطاء شائعة بيقع فيها الناس وإزاي يتفاداها'],
  ['saving', 'إزاي توفّر فلوس ومجهود من غير ما تضحّي بالأمان'],
  ['scenario', 'سيناريو واقعي (شخص عنده موقف معيّن) بنتابع قراراته'],
  ['qa', 'أسئلة الناس الحقيقية وإجابات مباشرة ومفصّلة'],
  ['checklist', 'قائمة تجهيز ومراجعة قبل يوم النقل'],
];
const LINKS = [['/', 'اشحنلي (الرئيسية)'], ['/routes', 'طرق النقل بين المدن'], ['/pricing', 'الأسعار'], ['/vehicles', 'أنواع العربيات وحمولتها'], ['/how-it-works', 'إزاي بتشتغل المنصة'], ['/for-drivers', 'للسواقين'], ['/for-companies', 'لشركات الشحن']];
const SYSTEM = `أنت كاتب محتوى مصري محترف متخصص في النقل والشحن، بتكتب لموقع "اشحنلي" (منصة بتوصّل العميل بسواقين وشركات نقل في مصر، وبتعرض سعر تقديري قبل التأكيد، والسعر ممكن يتفاوض عليه مع السواق).
اكتب بعربية سهلة قريبة من لغة الناس (فصحى مبسّطة بنبرة مصرية دافئة من غير عامية ثقيلة)، كأنك خبير بيشرح لصاحبه.
قواعد صارمة:
- ممنوع تألّف أرقام أو إحصائيات أو أسعار محددة أو آراء عملاء أو شهادات أو ضمانات أو وعود. لو محتاج تتكلم عن السعر قول إنه بيتغيّر حسب المسافة ونوع العربية والحمولة وإنه قابل للتفاوض، ووجّه القارئ للحاسبة في الموقع.
- ممنوع تقول إنك ذكاء اصطناعي أو تذكر "كنموذج" أو "بصفتي". ممنوع المقدمات العامة المكرّرة ("في عالمنا اليوم" وما شابه) والخاتمة المكرّرة ("في الختام").
- نوّع في الأسلوب وطول الفقرات: افتتاحية جاذبة بموقف أو سؤال، عناوين فرعية متنوعة (مش كلها أسئلة ولا بنفس الصيغة)، قوائم قصيرة لما تفيد، أمثلة من واقع مصر (شقة في المنصورة، محل في العبور، مصنع في العاشر…) من غير أسماء أشخاص حقيقيين.
- الكلمات المفتاحية وصيغ البحث المختلفة (مرادفات وأسئلة الناس) تظهر طبيعي جوه الجمل. الكلمة الأساسية في العنوان وأول 100 كلمة وعنوان فرعي واحد على الأقل. ممنوع الحشو والتكرار الممل.
- الطول: من 900 لـ1400 كلمة في body. استخدم صيغة Markdown: ## للعناوين الفرعية، ### للأقل، - للقوائم، **غامق**، وروابط [نص](/مسار) من القائمة المسموحة بس (2 لـ4 روابط داخلية في السياق الطبيعي).
- مكان الصورة المقترح: اكتب سطر لوحده [[img:1]] أو [[img:2]] في مكانين مناسبين، وفي imageIdeas اكتب وصف مقترح لكل صورة (الأدمن بيرفعها).
رجّع JSON فقط من غير أي كلام تاني، بالشكل:
{"title":"عنوان جذاب فيه الكلمة الأساسية (60-90 حرف)","slugWords":"3-6 كلمات مفتاحية بالعربي للرابط","description":"وصف ميتا 130-160 حرف فيه الكلمة الأساسية ومحفّز للضغط","excerpt":"ملخص جذاب 2-3 جمل","body":"نص المقال Markdown","faq":[["سؤال","إجابة مختصرة دقيقة"],... 4 أسئلة],"keywords":["8-12 عبارة بحث متنوعة"],"imageIdeas":["وصف صورة 1","وصف صورة 2"]}`;

/** يولّد مقال واحد (JSON منظّف) لعنوان وزاوية */
export async function generateArticle(env, topic, angleIdx = 0) {
  const [akey, atext] = ANGLES[((angleIdx % ANGLES.length) + ANGLES.length) % ANGLES.length];
  const prompt = `العنوان/الموضوع الأساسي: ${topic}\nالزاوية المطلوبة لهذا المقال: ${atext}\nغيّر صياغة العنوان شوية (نفس الكلمة المفتاحية بس بصياغة مختلفة عن الموضوع الأصلي) واكتب المقال بالكامل.\nالروابط الداخلية المسموحة (استخدم منها بس): ${LINKS.map(([h, l]) => `${h} = ${l}`).join(' ، ')}\nفكرة: صفحات الطرق بين المدن شكلها /routes/cairo-to-alexandria (اسم المدينة بالإنجليزي بشرطات) ولو ذكرت مدينتين اربط بيهم لو مناسب.`;
  const j = parseAiJson(await callAI(env, SYSTEM, prompt));
  const body = String(j.body ?? '').trim();
  if (String(j.title ?? '').trim().length < 5 || body.length < 600) throw new HttpError(502, 'ai_bad_output');
  const faq = (Array.isArray(j.faq) ? j.faq : []).map((x) => (Array.isArray(x) ? x : [x?.q, x?.a]));
  return { title: j.title, slug: slugify(j.slugWords) || slugify(j.title), description: j.description, excerpt: j.excerpt, body, faq, keywords: j.keywords, imageIdeas: (Array.isArray(j.imageIdeas) ? j.imageIdeas : []).slice(0, 4).map(String), angle: akey };
}
/** يولّد ويحفظ مسودة (أو منشور لو تلقائي ومفعّل النشر التلقائي) */
export async function generateAndSave(env, topic, angleIdx, { publish = false } = {}) {
  const g = await generateArticle(env, topic, angleIdx);
  const a = await saveArticle(env, { ...g, status: publish ? 'published' : 'draft' }, { source: 'ai', topic, angle: g.angle });
  return { ...a, imageIdeas: g.imageIdeas };
}

// ---------- الإعدادات والتشغيل التلقائي ----------
const CFG_DEFAULT = { topics: [], autoEnabled: false, everyHours: 24, autoPublish: false, cursor: 0, lastAutoAt: 0, lastError: '' };
export async function getConfig(env) { const r = await F.get(env, 'blog_config/main'); return { ...CFG_DEFAULT, ...jparse(r?.v, {}) }; }
async function putConfig(env, c) { await F.run(env, [F.set('blog_config/main', { k: 'main', v: JSON.stringify(c) })]); }
export function cleanConfig(b, old = CFG_DEFAULT) {
  const topics = [...new Set((Array.isArray(b.topics) ? b.topics : String(b.topics ?? '').split('\n')).map((x) => String(x).trim().slice(0, 120)).filter((x) => x.length >= 3))].slice(0, 60);
  const every = Math.floor(Number(b.everyHours)); 
  return { ...old, topics, autoEnabled: b.autoEnabled === true, autoPublish: b.autoPublish === true, everyHours: Number.isFinite(every) ? Math.min(720, Math.max(1, every)) : 24 };
}
export async function saveConfig(env, b) { const c = cleanConfig(b, await getConfig(env)); await putConfig(env, c); return c; }

let lastCheck = 0;
/** يشغّل مقال واحد لو الموعد جه. بيتنده من زيارات الموقع (مفيش Cron في Cloudflare Pages) ومن /api/blog/cron بمفتاح. بيتأكد من الإعدادات مرة كل 10 دقايق على الأكثر في نفس الـisolate. */
export async function autoTick(env, { force = false, throttle = !force } = {}) {
  if (throttle) { if (Date.now() - lastCheck < 600000) return { skipped: 'throttle' }; lastCheck = Date.now(); }
  const cfg = await getConfig(env);
  if (!force && (!cfg.autoEnabled || !cfg.topics.length)) return { skipped: 'off' };
  if (!cfg.topics.length) return { skipped: 'no_topics' };
  if (!aiProvider(env)) { if (cfg.lastError !== 'ai_not_configured') await putConfig(env, { ...cfg, lastError: 'ai_not_configured' }); return { skipped: 'ai_not_configured' }; }
  if (!force && now() < Number(cfg.lastAutoAt || 0) + cfg.everyHours * 3600e3) return { skipped: 'not_due' };
  const n = cfg.topics.length, topic = cfg.topics[cfg.cursor % n], angle = Math.floor(cfg.cursor / n);
  await putConfig(env, { ...cfg, lastAutoAt: now() }); // نحجز الموعد قبل التوليد: لو فشل نحاول تاني في الموعد الجاي مش في كل زيارة
  try {
    const a = await generateAndSave(env, topic, angle, { publish: cfg.autoPublish });
    await putConfig(env, { ...(await getConfig(env)), cursor: cfg.cursor + 1, lastError: '' });
    return { ok: true, id: a.id, status: a.status };
  } catch (e) {
    await putConfig(env, { ...(await getConfig(env)), lastError: String(e?.code || e?.message || 'error').slice(0, 80) });
    return { error: e?.code || 'error' };
  }
}
export const autoTickSafe = (env) => autoTick(env).catch((e) => { console.error('blog_auto_failed', e?.message || e); });

// ---------- معالجات الأدمن (بتتنده بعد need(c,['admin']) في [[route]].js) ----------
export const admin = {
  async list(env) { return { items: (await F.query(env, 'articles', { order: ['updated_at', 'desc'], limit: 300 })).map((r) => rowOut(r)), ai: aiProvider(env), cron: !!env.BLOG_CRON_KEY }; },
  async get(env, id) { if (!/^[A-Za-z0-9]{10,40}$/.test(String(id))) throw new HttpError(400, 'bad_id'); const r = await F.get(env, `articles/${id}`); if (!r) throw new HttpError(404, 'not_found'); return { article: rowOut(r, true) }; },
  save: (env, b) => saveArticle(env, b),
  async generate(env, uid, b) {
    const topic = str(b.title, 5, 140), idx = Math.max(0, Math.min(50, Math.floor(Number(b.index) || 0)));
    await rateTake(env, 'blogai', uid, 3600e3, 40, 'too_many_requests'); // سقف تكلفة التوليد
    return { article: await generateAndSave(env, topic, idx) };
  },
  async config(env) { return { config: await getConfig(env), ai: aiProvider(env), cron: !!env.BLOG_CRON_KEY, angles: ANGLES.length }; },
  async configSave(env, b) { return { config: await saveConfig(env, b), ai: aiProvider(env) }; },
};

// ---------- صفحات الموقع العامة ----------
const dateAr = (t) => new Date(t || 0).toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Africa/Cairo' });
export const blogPath = (a) => `/blog/${encodeURIComponent(a.slug)}`;

export function articleContent(a, related = []) {
  const path = blogPath(a), hero = (a.images || [])[0];
  const usedImg = /\[\[img:1\]\]/.test(a.body);
  const html = mdToHtml(a.body, { images: a.images || [], video: a.video, title: a.title });
  const hasVideoToken = /\[\[video\]\]/.test(a.body);
  const body = `<article class="blog-art"><p class="blog-meta">${esc(dateAr(a.publishedAt))}</p>
${hero && !usedImg ? `<figure class="blog-fig"><img src="/blog/img/${esc(hero.id)}" alt="${esc(hero.alt || a.title)}" decoding="async"></figure>` : ''}
${html}
${a.video && !hasVideoToken ? videoHtml(a.video, a.title) : ''}
${related.length ? `<h2>اقرأ كمان</h2><ul class="blog-rel">${related.map((r) => `<li><a href="${blogPath(r)}">${esc(r.title)}</a></li>`).join('')}</ul>` : ''}</article>`;
  const ld = { '@context': 'https://schema.org', '@type': 'Article', headline: a.title, description: a.description, inLanguage: 'ar', datePublished: new Date(a.publishedAt || a.createdAt).toISOString(), dateModified: new Date(a.updatedAt || a.publishedAt || a.createdAt).toISOString(), mainEntityOfPage: path, author: { '@type': 'Organization', name: 'اشحنلي' }, publisher: { '@type': 'Organization', name: 'اشحنلي' }, ...(hero ? { image: [`/blog/img/${hero.id}`] } : {}) };
  return {
    title: a.title.length > 55 ? a.title : `${a.title} | اشحنلي`, desc: a.description, h1: a.title, lead: a.excerpt || a.description, body,
    faq: a.faq?.length ? a.faq : null, cta: ['احسب سعر شحنتك', '/'], path,
    crumbs: [['اشحنلي', '/'], ['المدونة', '/blog'], [a.title, path]],
    extraLd: `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`,
  };
}
export function indexContent(list) {
  const body = list.length ? `<ul class="blog-list">${list.map((a) => `<li><a class="blog-card" href="${blogPath(a)}"><b>${esc(a.title)}</b><span>${esc(a.excerpt || a.description)}</span><small>${esc(dateAr(a.publishedAt))}</small></a></li>`).join('')}</ul>` : '<p>لسه مفيش مقالات منشورة. تابعنا قريب.</p>';
  return { title: 'مدونة اشحنلي — نصائح نقل الشحن والأثاث في مصر', desc: 'مقالات عملية عن نقل البضائع والأثاث في مصر: التجهيز، اختيار العربية، التوفير، وكل اللي محتاج تعرفه قبل ما تشحن.', h1: 'مدونة اشحنلي', lead: 'نصائح عملية عن النقل والشحن في مصر.', body, faq: null, cta: ['احسب سعر شحنتك', '/'], path: '/blog', crumbs: [['اشحنلي', '/'], ['المدونة', '/blog']], extraLd: '' };
}
const b64ToBytes = (b64) => { const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; };
/** صورة مقال عامة: بس ملفات نوع blog (اللي الأدمن رفعها) */
export async function blogImage(env, id) {
  if (!/^[A-Za-z0-9]{10,40}$/.test(String(id))) return null;
  const f = await F.get(env, `files/${id}`);
  if (!f || f.kind !== 'blog') return null;
  return new Response(b64ToBytes(f.data), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } });
}
