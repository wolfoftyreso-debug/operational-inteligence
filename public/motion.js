// Informational motion — the interface feels alive because the information
// is alive. Rules: functional only, fast (counts 400–800 ms, chart draw
// 600–1000 ms), play-once via IntersectionObserver, prefers-reduced-motion
// respected, GPU-friendly (opacity/transform/dashoffset only).

(function () {
  'use strict';

  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const handlers = new WeakMap();
  const played = new WeakSet();

  // Low threshold + margin so tall containers still trigger reliably.
  const io = ('IntersectionObserver' in window) ? new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting && !played.has(e.target)) {
        played.add(e.target);
        const fn = handlers.get(e.target);
        io.unobserve(e.target);
        if (fn) fn(e.target);
      }
    }
  }, { threshold: 0.05, rootMargin: '0px 0px -40px 0px' }) : null;

  /** Run fn once, the first time el enters the viewport. */
  function onVisible(el, fn) {
    if (reduced || !io) { fn(el); return; }
    handlers.set(el, fn);
    io.observe(el);
  }

  /** Count a numeric value up quickly (default 650 ms, ease-out). */
  function countUp(el, to, fmt, ms) {
    ms = ms || 650;
    if (reduced || !Number.isFinite(to)) { el.textContent = fmt(to); return; }
    const t0 = performance.now();
    function tick(t) {
      const p = Math.min(1, (t - t0) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(to * eased);
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = fmt(to);
    }
    requestAnimationFrame(tick);
  }

  /** Draw chart lines left→right; fade areas/points in. Call when visible. */
  function drawChart(svg, ms) {
    ms = ms || 800;
    svg.classList.remove('chart-pending');
    if (reduced) return;
    svg.querySelectorAll('polyline').forEach(pl => {
      let len = 1200;
      try { len = pl.getTotalLength(); } catch (e) {}
      pl.style.strokeDasharray = String(len);
      pl.style.strokeDashoffset = String(len);
      pl.style.opacity = '1';
      pl.getBoundingClientRect(); // reflow
      pl.style.transition = 'stroke-dashoffset ' + ms + 'ms cubic-bezier(.35,0,.25,1)';
      pl.style.strokeDashoffset = '0';
    });
    svg.querySelectorAll('path.area, circle').forEach(elm => {
      elm.style.opacity = '0';
      elm.getBoundingClientRect();
      elm.style.transition = 'opacity 380ms ease ' + Math.round(ms * 0.55) + 'ms';
      elm.style.opacity = elm.tagName === 'path' ? '0.07' : '1';
    });
    svg.querySelectorAll('rect.bar').forEach((r, i) => {
      r.style.transform = 'scaleY(0)';
      r.style.transformBox = 'fill-box';
      r.style.transformOrigin = 'bottom';
      r.getBoundingClientRect();
      r.style.transition = 'transform 500ms cubic-bezier(.35,0,.25,1) ' + Math.min(i * 22, 350) + 'ms';
      r.style.transform = 'scaleY(1)';
    });
  }

  /** Sequential reveal: each element materializes the first time it enters
   *  the viewport; simultaneous entries get a fast stagger. */
  function revealSeq(container, selector, stepMs) {
    stepMs = stepMs || 60;
    const items = Array.from(container.querySelectorAll(selector));
    let batchStart = 0, batchCount = 0;
    items.forEach(it => {
      it.classList.add('reveal');
      onVisible(it, () => {
        const nowT = performance.now();
        if (nowT - batchStart > 150) { batchStart = nowT; batchCount = 0; }
        const delay = reduced ? 0 : Math.min(batchCount * stepMs, 420);
        batchCount++;
        setTimeout(() => it.classList.add('in'), delay);
      });
    });
  }

  window.Motion = { onVisible, countUp, drawChart, revealSeq, reduced };
})();
