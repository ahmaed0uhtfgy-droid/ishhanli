// لوحة الأدمن: المقالات (SEO). توليد بالذكاء الاصطناعي كمسودات، جدولة تلقائية، تعديل/إضافة يدوي، صور وفيديو يوتيوب اختياريين، وأسئلة شائعة.
import { api } from '../api.js';
import { t, registerRows } from '../i18n.js';
import { $, $$, html, render, toast, errMsg, busy, spinner, confirmDialog, fmtDate } from '../ui.js';
import { uploadImage } from '../storage.js';

registerRows([
  ['blog.title', 'مقالات الموقع', 'Site articles'],
  ['blog.noAi', 'التوليد بالذكاء الاصطناعي مش متفعّل: ضيف GEMINI_API_KEY (أو ANTHROPIC_API_KEY) كـ Secret في Cloudflare Pages ← Settings ← Variables and Secrets، وبعدين اعمل Redeploy. المقالات اليدوية شغّالة من غير مفتاح.', 'AI generation is off: add GEMINI_API_KEY (or ANTHROPIC_API_KEY) as a Cloudflare Pages secret, then redeploy. Manual articles work without a key.'],
  ['blog.ai', 'مزوّد الذكاء الاصطناعي', 'AI provider'],
  ['blog.genTitle', 'توليد مقالات لعنوان', 'Generate articles for a title'],
  ['blog.genHint', 'كل مقال بيتولّد بزاوية مختلفة وبصياغة عنوان مختلفة شوية (مش نسخ متقاربة). بيتحفظ كمسودة عشان تراجعه وتنشره.', 'Each article uses a different angle and a slightly different title (not near-duplicates). Saved as a draft for you to review and publish.'],
  ['blog.titlePh', 'مثال: نقل أثاث من القاهرة للإسكندرية', 'e.g. Furniture moving Cairo to Alexandria'],
  ['blog.count', 'عدد المقالات', 'Number of articles'],
  ['blog.generate', 'ولّد', 'Generate'],
  ['blog.generating', 'بيتولّد مقال {i} من {n}…', 'Generating article {i} of {n}…'],
  ['blog.genDone', 'اتولّد {n} مقال كمسودة', '{n} draft article(s) generated'],
  ['blog.autoTitle', 'التشغيل التلقائي', 'Automatic publishing'],
  ['blog.autoHint', 'مقال واحد كل فترة، بيلف على المواضيع وبيغيّر الزاوية كل لفّة. مفيش Cron في Cloudflare Pages، فالتنفيذ بيحصل أول زيارة للموقع بعد الموعد (أو من خدمة cron خارجية بمفتاح BLOG_CRON_KEY على /api/blog/cron). ', 'One article per interval, rotating through topics and changing the angle each round. Cloudflare Pages has no cron, so it runs on the first site visit after the due time (or via an external cron with BLOG_CRON_KEY on /api/blog/cron).'],
  ['blog.autoOn', 'شغّل التوليد التلقائي', 'Enable automatic generation'],
  ['blog.every', 'كل كام ساعة', 'Every N hours'],
  ['blog.autoPublish', 'انشر تلقائياً من غير مراجعة', 'Publish automatically without review'],
  ['blog.autoPublishWarn', 'تحذير: النشر التلقائي من غير مراجعة بيطلّع محتوى ممكن يكون فيه أخطاء. جوجل بتعاقب المحتوى الكتير الضعيف. الأفضل تسيبه مسودات وتراجعها.', 'Warning: auto-publishing unreviewed content may publish mistakes, and search engines penalize mass low-quality content. Prefer drafts you review.'],
  ['blog.topics', 'المواضيع (سطر لكل موضوع)', 'Topics (one per line)'],
  ['blog.saveCfg', 'احفظ الإعدادات', 'Save settings'],
  ['blog.runNow', 'ولّد مقال دلوقتي من الدورة', 'Generate the next article now'],
  ['blog.lastError', 'آخر خطأ تلقائي', 'Last automatic error'],
  ['blog.cfgSaved', 'اتحفظت', 'Saved'],
  ['blog.ran', 'اتعمل مقال جديد (راجعه في القائمة)', 'New article created (see the list)'],
  ['blog.new', 'مقال جديد', 'New article'],
  ['blog.list', 'كل المقالات', 'All articles'],
  ['blog.empty', 'مفيش مقالات لسه.', 'No articles yet.'],
  ['blog.status.draft', 'مسودة', 'Draft'],
  ['blog.status.published', 'منشور', 'Published'],
  ['blog.src.ai', 'ذكاء اصطناعي', 'AI'],
  ['blog.src.manual', 'يدوي', 'Manual'],
  ['blog.edit', 'تعديل', 'Edit'],
  ['blog.view', 'عرض', 'View'],
  ['blog.delete', 'حذف', 'Delete'],
  ['blog.deleteAsk', 'تحذف المقال ده نهائياً؟', 'Delete this article permanently?'],
  ['blog.f.title', 'العنوان', 'Title'],
  ['blog.f.slug', 'الرابط (كلمات البحث، بالعربي أو إنجليزي)', 'URL slug (search keywords)'],
  ['blog.f.desc', 'وصف جوجل (حتى 170 حرف)', 'Search description (up to 170 chars)'],
  ['blog.f.excerpt', 'ملخص قصير', 'Short excerpt'],
  ['blog.f.body', 'نص المقال', 'Article body'],
  ['blog.bodyHelp', 'Markdown: ## عنوان، ### عنوان فرعي، - قائمة، **غامق**، [نص](/pricing). الصور: [[img:1]] في سطر لوحده. الفيديو: [[video]].', 'Markdown: ## heading, ### subheading, - list, **bold**, [text](/pricing). Images: [[img:1]] on its own line. Video: [[video]].'],
  ['blog.f.keywords', 'عبارات البحث (بينها فاصلة)', 'Search phrases (comma-separated)'],
  ['blog.f.faq', 'أسئلة شائعة (سطر لكل سؤال: السؤال | الإجابة)', 'FAQ (one per line: question | answer)'],
  ['blog.f.video', 'فيديو يوتيوب (اختياري: رابط)', 'YouTube video (optional URL)'],
  ['blog.images', 'الصور (اختياري)', 'Images (optional)'],
  ['blog.addImage', 'ارفع صورة', 'Upload image'],
  ['blog.alt', 'وصف الصورة (مهم للـSEO)', 'Image alt text (important for SEO)'],
  ['blog.insertImg', 'أدرج في النص', 'Insert in text'],
  ['blog.remove', 'شيل', 'Remove'],
  ['blog.imageIdeas', 'صور مقترحة للمقال', 'Suggested images'],
  ['blog.saveDraft', 'احفظ كمسودة', 'Save as draft'],
  ['blog.publish', 'احفظ وانشر', 'Save & publish'],
  ['blog.unpublish', 'احفظ وارجّعه مسودة', 'Save & unpublish'],
  ['blog.cancel', 'رجوع', 'Back'],
  ['blog.saved', 'اتحفظ', 'Saved'],
  ['blog.err.ai_not_configured', 'مفيش مفتاح ذكاء اصطناعي على السيرفر', 'No AI key configured on the server'],
  ['blog.err.ai_failed', 'خدمة الذكاء الاصطناعي فشلت، جرّب تاني', 'AI service failed, try again'],
  ['blog.err.ai_bad_output', 'الرد مش مفهوم، جرّب تاني', 'AI output was unusable, try again'],
]);

const errText = (e) => { const k = 'blog.err.' + (e?.code || ''); const s = t(k); return s && s !== k ? s : errMsg(e); };
const faqToText = (faq) => (faq || []).map(([q, a]) => `${q} | ${a}`).join('\n');
const textToFaq = (s) => String(s || '').split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((p) => p[0] && p[1]).map((p) => [p[0], p.slice(1).join(' | ')]);

export function renderBlog(body) {
  let items = [], ai = null, cron = false, cfg = null, edit = null, ideas = [], busyMsg = '';
  const onError = (e) => toast(errText(e), true);

  const load = async () => {
    const [l, c] = await Promise.all([api('admin/blog/list'), api('admin/blog/config')]);
    items = l.items; ai = l.ai; cron = l.cron; cfg = c.config; paint();
  };

  const listView = () => html`
    <div class="card stack"><h3>${t('blog.title')}</h3>
      <p class="muted small">${t('blog.ai')}: <b>${ai || '—'}</b></p>
      ${ai ? '' : html`<div class="action bad"><p>${t('blog.noAi')}</p></div>`}
    </div>
    <form id="gen" class="card stack"><h3>${t('blog.genTitle')}</h3><p class="hint">${t('blog.genHint')}</p>
      <div class="grid-2"><label class="f">${t('blog.f.title')}<input name="title" maxlength="140" placeholder="${t('blog.titlePh')}" required minlength="5"></label>
      <label class="f">${t('blog.count')}<select name="n"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select></label></div>
      <div><button class="btn primary" type="submit" ${ai ? '' : 'disabled'}>${t('blog.generate')}</button> <span class="muted small" id="genMsg">${busyMsg}</span></div>
    </form>
    <form id="cfg" class="card stack"><h3>${t('blog.autoTitle')}</h3><p class="hint">${t('blog.autoHint')}${cron ? ' ✓ BLOG_CRON_KEY' : ''}</p>
      <label class="row"><input type="checkbox" name="autoEnabled" ${cfg?.autoEnabled ? 'checked' : ''}> <span>${t('blog.autoOn')}</span></label>
      <label class="f" style="max-width:220px">${t('blog.every')}<input type="number" name="everyHours" min="1" max="720" value="${cfg?.everyHours ?? 24}" required></label>
      <label class="row"><input type="checkbox" name="autoPublish" ${cfg?.autoPublish ? 'checked' : ''}> <span>${t('blog.autoPublish')}</span></label><p class="hint">${t('blog.autoPublishWarn')}</p>
      <label class="f">${t('blog.topics')}<textarea name="topics" rows="5" maxlength="6000">${(cfg?.topics || []).join('\n')}</textarea></label>
      ${cfg?.lastError ? html`<p class="err">${t('blog.lastError')}: ${cfg.lastError}</p>` : ''}
      <div class="row"><button class="btn primary" type="submit">${t('blog.saveCfg')}</button><button class="btn ghost" type="button" data-act="run" ${ai ? '' : 'disabled'}>${t('blog.runNow')}</button></div>
    </form>
    <div class="card stack"><div class="row"><h3 class="grow">${t('blog.list')}</h3><button class="btn primary sm" data-act="new">${t('blog.new')}</button></div>
      ${items.length ? html`<div class="table-wrap"><table><thead><tr><th>${t('blog.f.title')}</th><th></th><th></th><th></th></tr></thead><tbody>
        ${items.map((a) => html`<tr><td><b>${a.title}</b><br><span class="muted small">/blog/${a.slug}</span></td>
          <td><span class="stamp ${a.status === 'published' ? 'ok-t' : ''}">${t('blog.status.' + a.status)}</span><br><span class="muted small">${t('blog.src.' + a.source)} · ${fmtDate(a.updatedAt)}</span></td>
          <td>${a.status === 'published' ? html`<a class="btn ghost sm" href="/blog/${encodeURIComponent(a.slug)}" target="_blank" rel="noopener">${t('blog.view')}</a>` : ''}</td>
          <td><button class="btn ghost sm" data-act="edit" data-id="${a.id}">${t('blog.edit')}</button> <button class="btn ghost sm" data-act="del" data-id="${a.id}">${t('blog.delete')}</button></td></tr>`)}
      </tbody></table></div>` : html`<p class="muted">${t('blog.empty')}</p>`}
    </div>`;

  const editView = () => {
    const a = edit;
    return html`<form id="ed" class="stack"><div class="card stack">
      <label class="f">${t('blog.f.title')}<input name="title" maxlength="140" value="${a.title}" required minlength="5"></label>
      <label class="f">${t('blog.f.slug')}<input name="slug" maxlength="90" value="${a.slug}" placeholder="auto"></label>
      <label class="f">${t('blog.f.desc')}<input name="description" maxlength="170" value="${a.description}"></label>
      <label class="f">${t('blog.f.excerpt')}<textarea name="excerpt" rows="2" maxlength="300">${a.excerpt}</textarea></label>
      <label class="f">${t('blog.f.body')}<textarea name="body" rows="20" maxlength="40000" required>${a.body}</textarea></label><p class="hint">${t('blog.bodyHelp')}</p>
      <label class="f">${t('blog.f.keywords')}<input name="keywords" maxlength="900" value="${(a.keywords || []).join('، ')}"></label>
      <label class="f">${t('blog.f.faq')}<textarea name="faq" rows="6" maxlength="6000">${faqToText(a.faq)}</textarea></label>
      <label class="f">${t('blog.f.video')}<input name="video" dir="ltr" maxlength="200" value="${a.videoUrl || ''}" placeholder="https://www.youtube.com/watch?v=…"></label>
    </div>
    <div class="card stack"><h3>${t('blog.images')}</h3>
      ${ideas.length ? html`<p class="hint">${t('blog.imageIdeas')}: ${ideas.join(' • ')}</p>` : ''}
      ${(a.images || []).map((im, i) => html`<div class="row" data-img="${i}"><img src="/blog/img/${im.id}" alt="" width="64" height="64" style="object-fit:cover;border-radius:8px"><label class="f grow">${t('blog.alt')} (#${i + 1})<input data-alt="${i}" maxlength="140" value="${im.alt}"></label><button type="button" class="btn ghost sm" data-act="ins" data-i="${i}">${t('blog.insertImg')}</button><button type="button" class="btn ghost sm" data-act="rm" data-i="${i}">${t('blog.remove')}</button></div>`)}
      <label class="btn ghost sm" style="width:fit-content">${t('blog.addImage')}<input type="file" id="imgFile" accept="image/*" hidden></label>
    </div>
    <p class="err" id="eerr" role="alert"></p>
    <div class="row"><button class="btn primary" type="submit" data-pub="${a.status === 'published' ? '1' : '0'}">${a.status === 'published' ? t('blog.publish') : t('blog.saveDraft')}</button>
      ${a.status === 'published' ? html`<button class="btn ghost" type="submit" data-pub="0">${t('blog.unpublish')}</button>` : html`<button class="btn" type="submit" data-pub="1">${t('blog.publish')}</button>`}
      <button class="btn ghost" type="button" data-act="back">${t('blog.cancel')}</button></div></form>`;
  };

  const paint = () => { render(body, edit ? editView() : listView()); };
  const syncImagesFromDom = () => { if (!edit) return; $$('[data-alt]', body).forEach((el) => { const i = Number(el.dataset.alt); if (edit.images[i]) edit.images[i].alt = el.value.trim(); }); };
  const readForm = () => {
    const f = $('#ed', body); syncImagesFromDom();
    return { id: edit.id || undefined, title: f.title.value, slug: f.slug.value, description: f.description.value, excerpt: f.excerpt.value, body: f.body.value, keywords: f.keywords.value.split(/[,،]/).map((x) => x.trim()).filter(Boolean), faq: textToFaq(f.faq.value), video: f.video.value, images: edit.images };
  };
  const keepForm = () => { if (!edit) return; const f = $('#ed', body); if (!f) return; Object.assign(edit, readForm(), { videoUrl: f.video.value, status: edit.status }); };

  body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    try {
      if (act === 'new') { edit = { title: '', slug: '', description: '', excerpt: '', body: '', status: 'draft', keywords: [], faq: [], images: [], videoUrl: '' }; ideas = []; paint(); }
      else if (act === 'edit') { edit = (await api('admin/blog/get', { id: b.dataset.id })).article; edit.videoUrl = edit.video ? `https://www.youtube.com/watch?v=${edit.video}` : ''; ideas = []; paint(); window.scrollTo(0, 0); }
      else if (act === 'back') { edit = null; await load(); }
      else if (act === 'del') { if (!(await confirmDialog(t('blog.deleteAsk')))) return; await api('admin/blog/delete', { id: b.dataset.id }); await load(); }
      else if (act === 'run') { await busy(b, async () => { await api('admin/blog/run', {}); toast(t('blog.ran')); await load(); }); }
      else if (act === 'rm') { keepForm(); edit.images.splice(Number(b.dataset.i), 1); paint(); }
      else if (act === 'ins') { const f = $('#ed', body), ta = f.body, tok = `\n[[img:${Number(b.dataset.i) + 1}]]\n`, p = ta.selectionStart ?? ta.value.length; ta.value = ta.value.slice(0, p) + tok + ta.value.slice(p); ta.focus(); }
    } catch (er) { onError(er); }
  });

  body.addEventListener('change', async (e) => {
    if (e.target.id !== 'imgFile' || !e.target.files[0]) return;
    const file = e.target.files[0]; e.target.value = '';
    try { keepForm(); const ref = await uploadImage(file, 'blog'); edit.images.push({ id: String(ref).slice(3), alt: '' }); paint(); } catch (er) { onError(er); }
  });

  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      if (f.id === 'gen') {
        const title = f.title.value.trim(), n = Number(f.n.value) || 1; let done = 0;
        const msg = $('#genMsg', body), btn = $('button[type=submit]', f); btn.disabled = true;
        try {
          for (let i = 0; i < n; i++) { msg.textContent = t('blog.generating', { i: i + 1, n }); const r = await api('admin/blog/generate', { title, index: i + items.filter((x) => x.topic === title).length }); done++; if (n === 1) { edit = r.article; edit.videoUrl = ''; ideas = r.article.imageIdeas || []; } }
        } finally { btn.disabled = false; }
        toast(t('blog.genDone', { n: done }));
        if (edit) { paint(); window.scrollTo(0, 0); } else await load();
      } else if (f.id === 'cfg') {
        const r = await api('admin/blog/config/save', { autoEnabled: f.autoEnabled.checked, autoPublish: f.autoPublish.checked, everyHours: Number(f.everyHours.value), topics: f.topics.value.split('\n') });
        cfg = r.config; toast(t('blog.cfgSaved')); paint();
      } else if (f.id === 'ed') {
        const pub = e.submitter?.dataset.pub === '1';
        const data = { ...readForm(), status: pub ? 'published' : 'draft' };
        await busy(e.submitter, async () => { const r = await api('admin/blog/save', data); edit = r.article; edit.videoUrl = edit.video ? `https://www.youtube.com/watch?v=${edit.video}` : ''; toast(t('blog.saved')); paint(); });
      }
    } catch (er) { const box = $('#eerr', body); if (box && edit) box.textContent = errText(er); else onError(er); if (!box && !edit) load().catch(() => {}); }
  });

  render(body, spinner());
  load().catch(onError);
  return () => {};
}
