// حركة الصفحة الرئيسية (GSAP + ScrollTrigger + Lenis): بتتحمّل من /vendor وقت الحاجة بس، وبتتشال بالكامل لما الزائر يسيب الصفحة الرئيسية.
// بدونها الصفحة شغّالة كاملة (المحتوى والتخطيط ثابتين). مع prefers-reduced-motion مفيش حركة خالص.
const V = '/vendor/';
const loaded = {};
const loadScript = (name) => (loaded[name] ||= new Promise((ok, no) => { const s = document.createElement('script'); s.src = V + name; s.async = false; s.onload = ok; s.onerror = () => { delete loaded[name]; no(new Error('load ' + name)); }; document.head.appendChild(s); }));
export const motionOK = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;

/** تقسيم الكلمات (DOM مش innerHTML) مع الحفاظ على <em> وإمكانية الاسترجاع */
function split(el, mode) {
  if (!el) return [];
  el.dataset.orig = el.innerHTML; const words = []; let endsSpace = true;
  const walk = (n, e) => n.childNodes.forEach((c) => {
    if (c.nodeType === 3) { // علامة ترقيم لازقة في الكلمة اللي قبلها (بعد <em> مثلاً) بتفضل معاها
      const txt = c.textContent, toks = txt.split(/\s+/).filter(Boolean);
      if (toks.length && !/^\s/.test(txt) && !endsSpace && words.length) words[words.length - 1][2] += toks.shift();
      toks.forEach((w) => words.push([w, e, '']));
      if (txt.length) endsSpace = /\s$/.test(txt);
    } else if (c.nodeName === 'EM') walk(c, true);
  });
  walk(el, false); el.textContent = '';
  const out = [];
  for (const [w, e, tail] of words) {
    const inner = document.createDocumentFragment();
    inner.appendChild(e ? Object.assign(document.createElement('em'), { textContent: w }) : document.createTextNode(w));
    if (tail) inner.appendChild(document.createTextNode(tail));
    const sp = document.createElement('span');
    if (mode === 't') { sp.className = 't'; sp.appendChild(inner); out.push(sp); } else { sp.className = 'w'; const i = document.createElement('i'); i.appendChild(inner); sp.appendChild(i); out.push(i); }
    el.appendChild(sp); el.appendChild(document.createTextNode(' '));
  }
  return out;
}
const unsplit = (root) => root.querySelectorAll('[data-orig]').forEach((el) => { el.innerHTML = el.dataset.orig; delete el.dataset.orig; });

/** بيبدأ الحركة على الجذر .lp. بيرجّع { stop, scrollTo } (أو null لو الحركة مش مناسبة/فشل التحميل) */
export async function startFx(root) {
  if (!root || !motionOK()) return null;
  try { await loadScript('gsap-3.12.5.min.js'); await loadScript('ScrollTrigger-3.12.5.min.js'); await loadScript('lenis-1.1.18.min.js'); } catch (e) { console.warn(e.message); return null; }
  if (!root.isConnected || root.closest('[hidden]')) return null; // الزائر مشي قبل ما التحميل يخلص
  const { gsap, ScrollTrigger, Lenis } = window; gsap.registerPlugin(ScrollTrigger);
  const q = (s) => root.querySelector(s), qa = (s) => [...root.querySelectorAll(s)];
  const rtl = getComputedStyle(root).direction === 'rtl', sgn = rtl ? 1 : -1, design = root.dataset.design;
  root.classList.add('fx');
  const lenis = new Lenis({ lerp: 0.09 }); lenis.on('scroll', ScrollTrigger.update);
  const raf = (t) => lenis.raf(t * 1000); gsap.ticker.add(raf); gsap.ticker.lagSmoothing(0);
  const mm = gsap.matchMedia();
  const ctx = gsap.context(() => {
    const st = (trigger, o = {}) => ({ trigger, ...o });
    const hw = split(q('#lpH1'), 'w'); gsap.set(hw, { yPercent: 115 });
    const mq = q('#lpMq'); if (mq) { const copies = design === 'b' ? 2 : 1; const base = mq.innerHTML; for (let i = 0; i < copies; i++) mq.insertAdjacentHTML('beforeend', base); }
    const ml = mq ? gsap.fromTo(mq, { xPercent: -100 / (design === 'b' ? 3 : 2) }, { xPercent: 0, duration: design === 'b' ? 30 : 40, ease: 'none', repeat: -1 }) : null;
    if (mq) ScrollTrigger.create({ trigger: mq.parentElement, start: 'top bottom', end: 'bottom top', onUpdate: (s) => { ml.timeScale(1 + Math.abs(s.getVelocity()) / 250); gsap.to(ml, { timeScale: 1, duration: 0.9, overwrite: true, delay: 0.05 }); } });
    const stm = split(q('#lpStm'), 't');
    if (stm.length) gsap.to(stm, { opacity: 1, stagger: 0.1, ease: 'none', scrollTrigger: st(q('#lpStm').parentElement, { start: 'top 70%', end: 'bottom 60%', scrub: true }) });
    qa('[data-n]').forEach((el) => { const n = +el.dataset.n, o = { v: 0 }; el.textContent = '0'; ScrollTrigger.create({ trigger: el, start: 'top 92%', once: true, onEnter: () => gsap.to(o, { v: n, duration: 2, ease: 'power3.out', onUpdate: () => { el.textContent = Math.round(o.v); } }) }); });
    const fade = (sel, from, trg) => qa(sel).forEach((e) => gsap.from(e, { ...from, duration: 0.9, ease: 'power3.out', scrollTrigger: st(trg || e, { start: 'top 90%' }) }));

    if (design === 'b') {
      gsap.timeline({ defaults: { ease: 'power4.out' } }).from('#lpBd', { scale: 0.4, opacity: 0, rotate: -20, duration: 1.5 }, 0).from(q('.lpb-big'), { opacity: 0, scale: 1.25, duration: 1.6 }, 0)
        .to(hw, { yPercent: 0, duration: 1.1, stagger: 0.08 }, 0.5).from(qa('.lpb-sub,.lpb-hero .lp-cta'), { y: 30, opacity: 0, duration: 0.9, stagger: 0.12 }, 0.9);
      gsap.to(q('#lpBd'), { y: -12, duration: 3, ease: 'sine.inOut', yoyo: true, repeat: -1 });
      gsap.to(q('.lpb-big'), { xPercent: -8, ease: 'none', scrollTrigger: st(q('.lpb-hero'), { start: 'top top', end: 'bottom top', scrub: true }) });
      gsap.to(q('#lpBd'), { rotate: 25, ease: 'none', scrollTrigger: st(q('.lpb-hero'), { start: 'top top', end: 'bottom top', scrub: true }) });
      // مشهد الطريق: الشاحنة بتمشي على المسار مع السكرول والعناوين بتتبدّل
      const route = q('.lpb-route'), rp = q('#lpRdp'), trk = q('#lpTrk'), caps = [1, 2, 3].map((n) => q('#lpC' + n)); let cur = -1;
      if (route && rp && trk) {
        route.parentElement.classList.add('fxr'); const L = rp.getTotalLength(); rp.style.strokeDasharray = L; rp.style.strokeDashoffset = L;
        const show = (i) => { if (i === cur) return; cur = i; caps.forEach((c, k) => gsap.to(c, { opacity: k === i ? 1 : 0, y: k === i ? 0 : (k < i ? -24 : 24), duration: 0.5, overwrite: true })); };
        const place = (p) => { const a = rp.getPointAtLength(L * p), b = rp.getPointAtLength(Math.min(L, L * p + 2)); const ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI, flip = Math.cos(ang * Math.PI / 180) < 0 ? -1 : 1; trk.setAttribute('transform', `translate(${a.x} ${a.y}) scale(${-flip} 1)`); rp.style.strokeDashoffset = L * (1 - p); show(p < 0.34 ? 0 : p < 0.67 ? 1 : 2); };
        place(0); ScrollTrigger.create({ trigger: route, start: 'top top', end: '+=260%', pin: true, scrub: 1, onUpdate: (s) => place(s.progress) });
      }
      const pv = q('#lpPv');
      if (pv) { const qx = gsap.quickTo(pv, 'x', { duration: 0.5, ease: 'power3' }), qy = gsap.quickTo(pv, 'y', { duration: 0.5, ease: 'power3' });
        qa('.lpb-row').forEach((r) => { r.addEventListener('mouseenter', () => { pv.innerHTML = r.querySelector('.lpb-ico').innerHTML; gsap.to(pv, { opacity: 1, scale: 1, duration: 0.35, ease: 'back.out(2)' }); }); r.addEventListener('mouseleave', () => gsap.to(pv, { opacity: 0, scale: 0.6, duration: 0.25 })); r.addEventListener('mousemove', (e) => { qx(e.clientX + 30); qy(e.clientY - 75); }); }); }
      fade('.lpb-row', { y: 50, opacity: 0 });
      const sc = qa('.lpb-sc'); sc.forEach((c, i) => { if (i < sc.length - 1) gsap.to(c, { scale: 0.94, ease: 'none', scrollTrigger: st(sc[i + 1], { start: 'top 75%', end: 'top 20%', scrub: true }) }); });
      fade('.lpb-f p', { y: 40, opacity: 0 }); fade('.lpb-fin h2', { scale: 0.8, opacity: 0 });
    } else {
      gsap.timeline({ defaults: { ease: 'power4.out' } }).to(hw, { yPercent: 0, duration: 1.1, stagger: 0.08 }, 0.2).from(qa('.lpa-eyebrow,.lpa-lead,.lpa-hin .lp-cta'), { y: 30, opacity: 0, duration: 0.9, stagger: 0.12 }, 0.6)
        .from('#lpMark', { scale: 0.6, rotate: -8, duration: 1.4 }, 0.3).from('#lpHalo', { scale: 0.7, opacity: 0, duration: 1.4 }, 0.3);
      gsap.to('#lpHalo', { rotate: 360, duration: 60, ease: 'none', repeat: -1 });
      gsap.to('#lpMark', { y: -14, duration: 3, ease: 'sine.inOut', yoyo: true, repeat: -1 });
      gsap.to('#lpDash', { x: -70, duration: 1.2, ease: 'none', repeat: -1 });
      gsap.to('#lpPyr', { x: 60, ease: 'none', scrollTrigger: st(q('.lpa-hero'), { start: 'top top', end: 'bottom top', scrub: true }) });
      gsap.to(q('.lpa-mark'), { yPercent: -12, ease: 'none', scrollTrigger: st(q('.lpa-hero'), { start: 'top top', end: 'bottom top', scrub: true }) });
      mm.add('(min-width: 901px)', () => { // بطاقات الخطوات بتتحرك أفقياً مع السكرول (مثبّتة)
        root.classList.add('fxh'); const tr = q('#lpTrack'), sec = q('#how'), dist = () => Math.max(0, tr.scrollWidth - innerWidth + innerWidth * 0.02);
        gsap.fromTo(tr, { x: 0 }, { x: () => sgn * dist(), ease: 'none', scrollTrigger: { trigger: sec, start: 'top top', end: () => '+=' + dist(), pin: true, scrub: 1, invalidateOnRefresh: true } });
        return () => root.classList.remove('fxh');
      });
      const g = q('#lpGiant'); if (g) gsap.fromTo(g, { x: () => -sgn * innerWidth * 0.1 }, { x: () => sgn * (g.offsetWidth - innerWidth + innerWidth * 0.1), ease: 'none', scrollTrigger: st(g.parentElement, { start: 'top bottom', end: 'bottom top', scrub: true, invalidateOnRefresh: true }) });
      qa('.lpa-card').forEach((c, i) => { gsap.from(c, { y: 60, opacity: 0, duration: 0.9, ease: 'power3.out', delay: i * 0.06, scrollTrigger: st(c, { start: 'top 90%' }) }); c.addEventListener('pointermove', (e) => { const r = c.getBoundingClientRect(); c.style.setProperty('--x', e.clientX - r.left + 'px'); c.style.setProperty('--y', e.clientY - r.top + 'px'); }); });
      fade('.lpa-formula', { x: -80, opacity: 0 }); fade('.lpa-badge', { scale: 0.7, opacity: 0, rotate: -12 });
      const bd = q('.lpa-badge'); if (bd) gsap.to(bd, { rotate: 8, ease: 'none', scrollTrigger: st(q('.lpa-trust'), { start: 'top bottom', end: 'bottom top', scrub: true }) });
      qa('.lp-tc').forEach((e, i) => gsap.from(e, { y: 40, opacity: 0, duration: 0.8, delay: i * 0.1, ease: 'power3.out', scrollTrigger: st(e, { start: 'top 90%' }) }));
    }
  }, root);
  const refresh = () => ScrollTrigger.refresh(); const t = setTimeout(refresh, 700); addEventListener('load', refresh, { once: true });
  return {
    scrollTo(id) { const el = root.querySelector('#' + id); if (el) lenis.scrollTo(el, { offset: id === 'top' ? 0 : -60 }); },
    stop() {
      clearTimeout(t); mm.revert(); ctx.revert(); gsap.ticker.remove(raf); lenis.destroy(); unsplit(root);
      qa('[data-n]').forEach((el) => { el.textContent = el.dataset.n; }); const mq = q('#lpMq'); if (mq) { while (mq.children.length > 5) mq.lastElementChild.remove(); }
      root.classList.remove('fx', 'fxh', 'fxr'); root.querySelector('.lpb-route')?.parentElement?.classList.remove('fxr'); q('#lpRdp')?.removeAttribute('style'); q('#lpTrk')?.removeAttribute('transform');
      ScrollTrigger.getAll().forEach((s) => s.kill());
    },
  };
}
