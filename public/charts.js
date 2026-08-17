// Hand-rolled SVG charts — no external dependencies.
// Calm, professional rendering: thin lines, subtle grid, tabular numerics.

(function () {
  const NS = 'http://www.w3.org/2000/svg';

  function el(name, attrs, children) {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    (children || []).forEach(c => e.appendChild(c));
    return e;
  }

  function fmtShort(n) {
    const abs = Math.abs(n);
    if (abs >= 1e6) return (n / 1e6).toLocaleString('sv-SE', { maximumFractionDigits: 1 }) + ' mkr';
    if (abs >= 1e3) return Math.round(n / 1e3).toLocaleString('sv-SE') + ' tkr';
    return Math.round(n).toLocaleString('sv-SE');
  }

  function niceScale(min, max, ticks) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const step = Math.pow(10, Math.floor(Math.log10(span / ticks)));
    const err = (span / ticks) / step;
    const mult = err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
    const s = mult * step;
    return { min: Math.floor(min / s) * s, max: Math.ceil(max / s) * s, step: s };
  }

  // series: [{label, color, points:[{period,value}]}]
  window.lineChart = function (series, opts) {
    opts = opts || {};
    const W = opts.width || 640, H = opts.height || 240;
    const pad = { l: 52, r: 12, t: 12, b: 28 };
    const all = series.flatMap(s => s.points.map(p => p.value));
    if (!all.length) return document.createTextNode('');
    let lo = Math.min(0, ...all), hi = Math.max(...all);
    const sc = niceScale(lo, hi, 4);
    lo = sc.min; hi = sc.max;
    const n = Math.max(...series.map(s => s.points.length));
    const x = i => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - pad.l - pad.r));
    const y = v => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
    for (let v = lo; v <= hi + 1e-9; v += sc.step) {
      svg.appendChild(el('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), stroke: '#e8ecf1', 'stroke-width': 1 }));
      const t = el('text', { x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 10, fill: '#8494a5' });
      t.textContent = fmtShort(v);
      svg.appendChild(t);
    }
    const periods = (series[0] || { points: [] }).points.map(p => p.period);
    const lblEvery = Math.ceil(periods.length / 6);
    periods.forEach((p, i) => {
      if (i % lblEvery !== 0 && i !== periods.length - 1) return;
      const t = el('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', 'font-size': 10, fill: '#8494a5' });
      t.textContent = String(p).slice(2);
      svg.appendChild(t);
    });

    series.forEach(s => {
      const pts = s.points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ');
      if (s.area) {
        const path = `M ${x(0)},${y(0 > lo ? 0 : lo)} L ` + s.points.map((p, i) => `${x(i)},${y(p.value)}`).join(' L ') + ` L ${x(s.points.length - 1)},${y(0 > lo ? 0 : lo)} Z`;
        svg.appendChild(el('path', { d: path, fill: s.color, opacity: 0.07 }));
      }
      svg.appendChild(el('polyline', { points: pts, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      const last = s.points[s.points.length - 1];
      if (last) svg.appendChild(el('circle', { cx: x(s.points.length - 1), cy: y(last.value), r: 3, fill: s.color }));
    });
    if (opts.refLine !== undefined && opts.refLine !== null) {
      svg.appendChild(el('line', { x1: pad.l, x2: W - pad.r, y1: y(opts.refLine), y2: y(opts.refLine), stroke: '#a8630a', 'stroke-width': 1.4, 'stroke-dasharray': '5 4' }));
    }
    return svg;
  };

  window.barChart = function (points, opts) {
    opts = opts || {};
    const W = opts.width || 640, H = opts.height || 220;
    const pad = { l: 52, r: 12, t: 12, b: 28 };
    if (!points.length) return document.createTextNode('');
    const vals = points.map(p => p.value);
    let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    const sc = niceScale(lo, hi, 4);
    lo = sc.min; hi = sc.max;
    const y = v => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
    const bw = (W - pad.l - pad.r) / points.length;

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}` });
    for (let v = lo; v <= hi + 1e-9; v += sc.step) {
      svg.appendChild(el('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), stroke: '#e8ecf1' }));
      const t = el('text', { x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 10, fill: '#8494a5' });
      t.textContent = fmtShort(v);
      svg.appendChild(t);
    }
    const lblEvery = Math.ceil(points.length / 6);
    points.forEach((p, i) => {
      const xx = pad.l + i * bw + bw * 0.18;
      const h = Math.abs(y(p.value) - y(0));
      svg.appendChild(el('rect', {
        x: xx, y: p.value >= 0 ? y(p.value) : y(0),
        width: bw * 0.64, height: Math.max(h, 0.5), rx: 2,
        fill: p.color || (p.value >= 0 ? (opts.color || '#1d4e6e') : '#b3362b'),
        opacity: p.faded ? 0.4 : 0.9
      }));
      if (i % lblEvery === 0 || i === points.length - 1) {
        const t = el('text', { x: pad.l + i * bw + bw / 2, y: H - 8, 'text-anchor': 'middle', 'font-size': 10, fill: '#8494a5' });
        t.textContent = String(p.period).slice(2);
        svg.appendChild(t);
      }
    });
    return svg;
  };

  window.sparkline = function (values, opts) {
    opts = opts || {};
    const W = opts.width || 120, H = opts.height || 34;
    if (!values.length) return document.createTextNode('');
    const lo = Math.min(...values), hi = Math.max(...values);
    const x = i => (i / Math.max(values.length - 1, 1)) * (W - 4) + 2;
    const y = v => 2 + (1 - (hi === lo ? 0.5 : (v - lo) / (hi - lo))) * (H - 4);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
    svg.appendChild(el('polyline', {
      points: values.map((v, i) => `${x(i)},${y(v)}`).join(' '),
      fill: 'none', stroke: opts.color || '#1d4e6e', 'stroke-width': 1.6
    }));
    return svg;
  };
})();
