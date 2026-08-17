// Operational Intelligence — SPA (vanilla JS, hash routing).

(function () {
  'use strict';

  const $app = document.getElementById('app');
  let ME = null;          // {user, org}
  let UNREAD = 0;

  // ---------- helpers ----------

  async function api(path, opts) {
    opts = opts || {};
    const res = await fetch('/api/v1' + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin'
    });
    if (res.status === 401 && !path.startsWith('/auth')) { ME = null; route(); throw new Error('401'); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
    return j;
  }

  function h(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
    }
    for (const c of children.flat(9)) {
      if (c === null || c === undefined || c === false) continue;
      e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return e;
  }

  const kr = n => (n === null || n === undefined) ? '–' : new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' kr';
  const pct = n => (n * 100).toFixed(0) + ' %';
  const dt = s => s ? new Date(s).toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' }) : '–';
  const d10 = s => s ? String(s).slice(0, 10) : '–';

  const SEV_LABEL = { critical: 'Kritisk', high: 'Hög', medium: 'Medel', low: 'Låg', info: 'Info' };
  const EPI_LABEL = { fact: 'Fakta', derived: 'Härlett', inference: 'Bedömning', forecast: 'Prognos', recommendation: 'Rekommendation' };
  const STATUS_META = {
    stable: { label: 'Stabilt läge', sub: 'Inga väsentliga avvikelser i tillgänglig data.' },
    attention: { label: 'Kräver uppmärksamhet', sub: 'Avvikelser finns som bör bevakas.' },
    action_needed: { label: 'Åtgärder behövs', sub: 'Det finns avvikelser som kräver aktiv hantering.' },
    critical: { label: 'Kritiskt läge', sub: 'Omedelbar hantering krävs.' }
  };
  const ROLE_LABEL = { technician: 'Tekniker', team_manager: 'Teamledare', department_manager: 'Avdelningschef', facility_manager: 'Platschef', executive: 'VD/Ledning', admin: 'Administratör' };

  function toast(msg, ok) {
    const t = h('div', { class: ok ? 'ok-msg' : 'error-msg', style: 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:99;box-shadow:0 8px 30px rgba(0,0,0,.15)' }, msg);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  function confidenceBar(c) {
    return h('span', { class: 'confidence' }, 'Confidence ' + pct(c));
  }

  // ---------- shell ----------

  const NAV = [
    { hash: '#/', label: 'Verksamhetsläge', ico: '◉', min: 0 },
    { hash: '#/ask', label: 'Fråga verksamheten', ico: '?', min: 1 },
    { hash: '#/findings', label: 'Observationer', ico: '☰', min: 0 },
    { hash: '#/liquidity', label: 'Likviditet', ico: '≈', min: 2 },
    { hash: '#/actions', label: 'Åtgärder & beslut', ico: '✓', min: 1 },
    { hash: '#/governance', label: 'Styrning', ico: '§', min: 3 },
    { hash: '#/reports', label: 'Rapporter', ico: '▤', min: 2 },
    { hash: '#/alerts', label: 'Alerts', ico: '!', min: 0, badge: () => UNREAD },
    { hash: '#/settings', label: 'Kontrollcenter', ico: '⌘', min: 0 },
    { hash: '#/integrations', label: 'Integrationer', ico: '⇄', admin: true },
    { hash: '#/profile', label: 'Verksamhetsprofil', ico: '▦', min: 3 },
    { hash: '#/admin', label: 'Administration', ico: '⚙', admin: true }
  ];
  const ROLE_LEVEL = { technician: 0, team_manager: 1, department_manager: 2, facility_manager: 3, executive: 4, admin: 4 };

  function visibleNav() {
    const lvl = ROLE_LEVEL[ME.user.role] || 0;
    return NAV.filter(n => n.admin ? ME.user.role === 'admin' : lvl >= (n.min || 0));
  }

  function shell(content) {
    const cur = location.hash || '#/';
    const navLinks = visibleNav().map(n => {
      const badge = n.badge ? n.badge() : 0;
      return h('a', { href: n.hash, class: cur === n.hash ? 'active' : '' },
        h('span', {}, n.ico + ' ' + n.label),
        badge > 0 ? h('span', { class: 'nav-badge' }, badge) : null);
    });
    const mobileLinks = visibleNav().slice(0, 5).map(n =>
      h('a', { href: n.hash, class: cur === n.hash ? 'active' : '' },
        h('span', { class: 'ico' }, n.ico), n.label.split(' ')[0]));

    $app.replaceChildren(
      h('div', { class: 'topbar-mobile' },
        h('span', { class: 'brand' }, 'Operational Intelligence'),
        h('span', { class: 'small', style: 'color:#7d93a8' }, ME.org.name)),
      h('div', { class: 'layout' },
        h('aside', { class: 'sidebar' },
          h('div', { class: 'brand' }, 'Operational Intelligence', h('small', {}, 'System of understanding')),
          h('nav', {}, navLinks),
          h('div', { class: 'sidebar-footer' },
            h('div', { class: 'who' }, ME.user.name),
            h('div', {}, ME.org.name + ' · ' + (ROLE_LABEL[ME.user.role] || ME.user.role)),
            h('div', { style: 'margin-top:6px' }, h('a', { onclick: logout }, 'Logga ut')))),
        h('main', { class: 'main' }, content)),
      h('div', { class: 'mobilenav' }, mobileLinks)
    );
  }

  async function logout() {
    try { await api('/auth/logout', { method: 'POST' }); } catch (e) {}
    ME = null; location.hash = '#/'; route();
  }

  // ---------- auth views ----------

  function loginView(showRegister) {
    const err = h('div');
    const form = showRegister
      ? h('form', { onsubmit: onRegister },
          h('label', { class: 'fld' }, h('span', {}, 'Företagets namn'), h('input', { name: 'org_name', required: '' })),
          h('label', { class: 'fld' }, h('span', {}, 'Ditt namn'), h('input', { name: 'name', required: '' })),
          h('label', { class: 'fld' }, h('span', {}, 'E-post'), h('input', { name: 'email', type: 'email', required: '' })),
          h('label', { class: 'fld' }, h('span', {}, 'Lösenord (minst 8 tecken)'), h('input', { name: 'password', type: 'password', required: '', minlength: 8 })),
          h('button', { style: 'width:100%' }, 'Skapa organisation'),
          h('p', { class: 'muted', style: 'margin-top:12px;text-align:center' },
            'Har du redan konto? ', h('a', { href: '#', onclick: e => { e.preventDefault(); renderLogin(false); } }, 'Logga in')))
      : h('form', { onsubmit: onLogin },
          h('label', { class: 'fld' }, h('span', {}, 'E-post'), h('input', { name: 'email', type: 'email', required: '' })),
          h('label', { class: 'fld' }, h('span', {}, 'Lösenord'), h('input', { name: 'password', type: 'password', required: '' })),
          h('button', { style: 'width:100%' }, 'Logga in'),
          h('p', { class: 'muted', style: 'margin-top:12px;text-align:center' },
            'Ny verksamhet? ', h('a', { href: '#', onclick: e => { e.preventDefault(); renderLogin(true); } }, 'Skapa organisation')));

    async function onLogin(e) {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api('/auth/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
        await boot();
      } catch (ex) { err.replaceChildren(h('div', { class: 'error-msg' }, ex.message)); }
    }
    async function onRegister(e) {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api('/auth/register-org', { method: 'POST', body: { org_name: f.get('org_name'), name: f.get('name'), email: f.get('email'), password: f.get('password') } });
        await boot();
      } catch (ex) { err.replaceChildren(h('div', { class: 'error-msg' }, ex.message)); }
    }

    return h('div', { class: 'auth-wrap' },
      h('div', { class: 'auth-logo' },
        h('div', { class: 't' }, 'Operational Intelligence'),
        h('div', { class: 's' }, 'Intelligent ledningslager ovanpå era befintliga system')),
      h('div', { class: 'card' }, err, form));
  }

  function renderLogin(reg) { $app.replaceChildren(loginView(reg)); }

  // ---------- dashboard ----------

  async function dashboardView() {
    const [status, metrics, changes] = await Promise.all([api('/status'), api('/metrics'), api('/changes')]);
    UNREAD = status.unread_alerts;
    const sm = STATUS_META[status.overall_status] || STATUS_META.stable;
    const lastIdx = metrics.revenueByMonth.length - 2;
    const rev = lastIdx >= 0 ? metrics.revenueByMonth[lastIdx] : null;
    const result = lastIdx >= 0 ? metrics.resultByMonth[lastIdx] : null;
    const prevRev = lastIdx >= 1 ? metrics.revenueByMonth[lastIdx - 1] : null;
    const revDelta = rev && prevRev && prevRev.value ? (rev.value - prevRev.value) / prevRev.value : null;

    const important = status.findings.filter(f => f.severity !== 'info');
    const infoFindings = status.findings.filter(f => f.severity === 'info');

    const analyzeBtn = h('button', { class: 'secondary', onclick: async (e) => {
      e.target.disabled = true; e.target.textContent = 'Analyserar…';
      try { await api('/analyze', { method: 'POST' }); route(); toast('Analysen är uppdaterad', true); }
      catch (ex) { toast(ex.message); e.target.disabled = false; e.target.textContent = 'Kör ny analys'; }
    } }, 'Kör ny analys');

    const clock = new Date().toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
    const syncT = status.last_sync_at ? new Date(status.last_sync_at).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' }) : '—';
    const avgConf = important.length ? Math.round(important.reduce((a, f) => a + f.confidence, 0) / important.length * 100) : null;

    const root = h('div', {},
      h('div', { class: 'tech-row', style: 'justify-content:space-between;margin-bottom:4px' },
        h('span', { class: 'tech' }, h('b', {}, ME.org.name.toUpperCase()), ' / OPERATIONS'),
        h('span', { class: 'tech' }, h('span', { class: 'live-dot' }), 'LIVE ' + clock + '  ·  SYNCED ' + syncT + '  ·  ' + status.sources + ' ' + (status.sources === 1 ? 'SOURCE' : 'SOURCES'))),

      h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, 'Verksamhetsläge'),
          h('div', { class: 'sub' }, status.last_analysis_at ? 'Senaste analys: ' + dt(status.last_analysis_at) : 'Ingen analys har körts ännu.')),
        analyzeBtn),

      h('div', { class: 'condition ' + status.overall_status },
        h('div', { class: 'tech' }, 'OPERATIONAL CONDITION'),
        h('div', { class: 'c-word' }, sm.label.toUpperCase()),
        h('div', { class: 'c-sub' }, status.summary || sm.sub),
        h('div', { class: 'tech-row', style: 'margin-top:12px' },
          h('span', { class: 'tech' }, important.length + ' OBSERVATIONER'),
          avgConf !== null ? h('span', { class: 'tech' }, 'CONFIDENCE ' + avgConf + '%') : null,
          status.hidden_low_confidence > 0 ? h('span', { class: 'tech' }, status.hidden_low_confidence + ' DOLDA (LÅG CONFIDENCE)') : null,
          h('span', { class: 'tech' }, (status.narrative_model || 'DETERMINISTIC').toUpperCase()))),

      h('div', { class: 'grid kpis', id: 'kpi-strip' },
        kpiCard('OMSÄTTNING' + (rev ? ' · ' + rev.period : ''), rev ? { raw: rev.value, fmt: kr } : '–',
          revDelta !== null ? { text: (revDelta >= 0 ? '+' : '−') + Math.abs(revDelta * 100).toFixed(1) + '% MOT FÖREG', dir: revDelta >= 0 ? 'up' : 'down' } : null),
        kpiCard('RESULTAT' + (result ? ' · ' + result.period : ''), result ? { raw: result.value, fmt: kr } : '–', null),
        kpiCard('KUNDFORDRINGAR', { raw: metrics.receivables.openTotal, fmt: kr },
          metrics.receivables.overdueTotal > 0 ? { text: kr(metrics.receivables.overdueTotal) + ' FÖRFALLET', dir: 'down' } : { text: 'INGET FÖRFALLET', dir: 'up' }),
        kpiCard('LEVERANTÖRSSKULDER', { raw: metrics.payables.openTotal, fmt: kr }, null)),

      h('div', { class: 'grid two' },
        chartCard('Omsättning och kostnader', 'PER MÅNAD · ' + metrics.months.length + ' MÅN', lineChart([
          { label: 'Omsättning', color: '#12507b', points: metrics.revenueByMonth, area: true },
          { label: 'Kostnader', color: '#ab3226', points: metrics.costsByMonth }
        ])),
        chartCard('Resultat per månad', 'OMSÄTTNING − KOSTNADER', barChart(metrics.resultByMonth))),

      h('div', { class: 'card tight' },
        h('div', { class: 'tech', style: 'margin-bottom:6px' }, 'WHAT CHANGED'),
        changes.length ? changes.map(c => h('div', { class: 'change-row' },
          h('span', { class: 't' }, new Date(c.at).toLocaleDateString('sv-SE', { day: '2-digit', month: '2-digit' })),
          h('span', { class: 'k' }, c.kind),
          c.ref ? h('a', { href: '#/finding/' + c.ref, style: 'color:inherit;text-decoration:none' }, c.text) : h('span', {}, c.text)))
        : h('div', { class: 'muted' }, 'Inga registrerade förändringar ännu.')),

      h('div', { class: 'section-title' }, 'Viktigaste observationerna'),
      h('div', { id: 'findings-seq' },
        important.length
          ? important.map(findingCard)
          : h('div', { class: 'card empty' }, 'Inga väsentliga avvikelser.'),
        infoFindings.length ? h('div', { class: 'section-title' }, 'Information') : null,
        infoFindings.map(findingCard)),

      status.narrative ? h('div', { class: 'card' },
        h('div', { class: 'tech', style: 'margin-bottom:6px' }, 'MANAGEMENT ASSESSMENT'),
        h('div', { class: 'answer' }, status.narrative),
        h('div', { class: 'hairline' }),
        h('div', { class: 'btnrow' },
          h('a', { class: 'btn secondary', href: '#/findings' }, 'Visa evidens'),
          h('a', { class: 'btn secondary', href: '#/ask' }, 'Fråga verksamheten')),
        h('div', { class: 'tech', style: 'margin-top:10px' }, 'GENERATED BY ' + (status.narrative_model || 'DETERMINISTIC').toUpperCase())) : null
    );

    // Informational motion: numbers count up, charts draw, findings reveal.
    const strip = root.querySelector('#kpi-strip');
    if (strip) Motion.onVisible(strip, () => {
      strip.querySelectorAll('[data-count]').forEach(el => {
        Motion.countUp(el, Number(el.dataset.count), v => kr(v), 650);
      });
    });
    root.querySelectorAll('.chart-box svg').forEach(svg => {
      svg.classList.add('chart-pending');
      Motion.onVisible(svg.closest('.card') || svg, () => Motion.drawChart(svg, 850));
    });
    const seq = root.querySelector('#findings-seq');
    if (seq) Motion.revealSeq(seq, '.finding', 70);
    return root;
  }

  function chartCard(title, techLabel, svg) {
    return h('div', { class: 'card' },
      h('h2', {}, title),
      h('div', { class: 'tech', style: 'margin-bottom:10px' }, techLabel),
      h('div', { class: 'chart-box' }, svg));
  }

  function kpiCard(label, value, delta) {
    const isAnimated = value && typeof value === 'object' && 'raw' in value;
    const valEl = isAnimated
      ? h('div', { class: 'value', 'data-count': String(value.raw) }, Motion.reduced ? value.fmt(value.raw) : value.fmt(0))
      : h('div', { class: 'value' }, value);
    return h('div', { class: 'kpi' },
      h('div', { class: 'label' }, label),
      valEl,
      delta ? h('div', { class: 'delta ' + delta.dir }, delta.text) : null);
  }

  function findingCard(f) {
    return h('div', { class: 'finding', onclick: () => { location.hash = '#/finding/' + f.id; } },
      h('span', { class: 'sev ' + f.severity }),
      h('div', { class: 'f-body' },
        h('div', { class: 'f-title' }, f.title),
        h('div', { class: 'f-desc' }, f.description.length > 220 ? f.description.slice(0, 220) + '…' : f.description),
        h('div', { class: 'f-meta' },
          h('span', { class: 'tag ' + f.severity }, SEV_LABEL[f.severity]),
          h('span', { class: 'tag epistemic' }, EPI_LABEL[f.epistemic] || f.epistemic),
          confidenceBar(f.confidence),
          h('span', { class: 'muted' }, d10(f.detected_at)))));
  }

  // ---------- findings list & detail ----------

  async function findingsView() {
    const [open, allF] = await Promise.all([api('/findings'), api('/findings?status=all')]);
    const resolved = allF.filter(f => f.status === 'resolved' || f.status === 'dismissed').slice(0, 20);
    return h('div', {},
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Observationer'),
        h('div', { class: 'sub' }, 'Strukturerade findings från analysmotorn. Öppna en observation för bedömning, evidens och rekommendation.'))),
      open.length ? open.map(findingCard) : h('div', { class: 'card empty' }, 'Inga aktiva observationer.'),
      resolved.length ? h('div', { class: 'section-title' }, 'Tidigare (löst/avfärdat)') : null,
      resolved.map(f => {
        const c = findingCard(f); c.style.opacity = '.6'; return c;
      }));
  }

  async function findingDetailView(id) {
    const f = await api('/findings/' + id);
    const actionForm = h('form', { onsubmit: async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/actions', { method: 'POST', body: { title: fd.get('title'), owner: fd.get('owner'), due_date: fd.get('due_date') || null, expected_effect: f.expected_effect, finding_id: f.id } });
        toast('Åtgärd skapad', true); route();
      } catch (ex) { toast(ex.message); }
    } },
      h('div', { class: 'grid two' },
        h('label', { class: 'fld' }, h('span', {}, 'Åtgärd'), h('input', { name: 'title', required: '', value: (f.recommended_actions[0] || '') })),
        h('label', { class: 'fld' }, h('span', {}, 'Ansvarig'), h('input', { name: 'owner', placeholder: 'Namn' }))),
      h('label', { class: 'fld' }, h('span', {}, 'Deadline'), h('input', { name: 'due_date', type: 'date' })),
      h('button', {}, 'Skapa åtgärd'));

    return h('div', {},
      h('a', { href: '#/findings', class: 'muted' }, '← Alla observationer'),
      h('div', { class: 'page-head', style: 'margin-top:10px' },
        h('div', {}, h('h1', {}, f.title),
          h('div', { class: 'f-meta', style: 'margin-top:8px' },
            h('span', { class: 'tag ' + f.severity }, SEV_LABEL[f.severity]),
            h('span', { class: 'tag epistemic' }, EPI_LABEL[f.epistemic] || f.epistemic),
            h('span', { class: 'tag epistemic' }, f.category),
            confidenceBar(f.confidence),
            f.occurrence_count > 1 ? h('span', { class: 'tag medium' }, f.occurrence_count + ' förekomster') : null))),

      h('div', { class: 'card' },
        h('h2', {}, 'Bedömning'),
        h('p', { style: 'margin-top:6px' }, f.description),
        f.recommended_actions.length ? h('div', {},
          h('div', { class: 'section-title' }, 'Rekommendation'),
          h('ul', { class: 'list-plain' }, f.recommended_actions.map(a => h('li', {}, '→ ' + a)))) : null,
        f.expected_effect ? h('p', { class: 'muted', style: 'margin-top:8px' }, 'Förväntad effekt: ' + f.expected_effect) : null),

      h('div', { class: 'card' },
        h('h2', {}, 'Varför säger systemet detta?'),
        h('div', { class: 'muted', style: 'margin-bottom:12px' }, 'Evidenskedja — fakta och härledda värden med källa och beräkning.'),
        f.evidence.map(e => h('div', { class: 'evidence-item ' + e.kind },
          h('div', { class: 'e-label' }, (e.kind === 'fact' ? 'FAKTA · ' : 'HÄRLETT · ') + e.label),
          e.value ? h('div', { class: 'e-value' }, e.value) : null,
          e.period ? h('div', { class: 'e-src' }, 'Period: ' + e.period) : null,
          e.source_label ? h('div', { class: 'e-src' }, 'Källa: ' + e.source_label) : null,
          e.calculation ? h('div', { class: 'e-calc' }, 'Beräkning: ' + e.calculation) : null))),

      f.history.length ? h('div', { class: 'card' },
        h('h2', {}, 'Historik (Management Memory)'),
        h('div', { class: 'muted', style: 'margin-bottom:8px' }, 'Samma underliggande problem har tidigare identifierats:'),
        f.history.map(hi => h('div', { class: 'timeline-item' },
          h('span', { class: 't-date' }, d10(hi.detected_at)),
          h('span', {}, SEV_LABEL[hi.severity] + ' · ' + hi.status)))) : null,

      f.actions.length ? h('div', { class: 'card' },
        h('h2', {}, 'Kopplade åtgärder'),
        f.actions.map(a => h('div', { class: 'timeline-item' },
          h('span', { class: 't-date' }, d10(a.created_at)),
          h('span', {}, a.title + ' — ' + a.status + (a.effect_verified ? ' (effekt: ' + a.effect_verified + ')' : ''))))) : null,

      h('div', { class: 'card' },
        h('h2', {}, 'Skapa åtgärd från denna observation'),
        actionForm),

      h('div', { class: 'btnrow' },
        f.status === 'open' ? h('button', { class: 'secondary', onclick: () => setFindingStatus(f.id, 'acknowledged') }, 'Markera som mottagen') : null,
        h('button', { class: 'secondary', onclick: () => setFindingStatus(f.id, 'resolved') }, 'Markera som löst'),
        h('button', { class: 'ghost', onclick: () => setFindingStatus(f.id, 'dismissed') }, 'Avfärda')));
  }

  async function setFindingStatus(id, status) {
    try { await api('/findings/' + id + '/status', { method: 'POST', body: { status } }); toast('Status uppdaterad', true); location.hash = '#/findings'; }
    catch (e) { toast(e.message); }
  }

  // ---------- ask ----------

  async function askView() {
    const [brief, history] = await Promise.all([api('/brief'), api('/ask/history')]);
    const thread = h('div', { class: 'chat-thread' });
    const examples = ['Har vi fått betalt för allt vi köpte in förra månaden?', 'Vilka kunder påverkar likviditeten mest?', 'Hur ligger vi till mot våra mål?', 'Vad är den största risken just nu?', 'Vad har vi lagt mest pengar på?', 'Vilka åtgärder gav faktisk effekt?'];

    function answerBlock(q, r) {
      return h('div', {},
        h('div', { class: 'chat-q' }, q),
        h('div', { class: 'chat-a' },
          h('div', { class: 'tech', style: 'margin-bottom:6px' }, 'BUSINESS INTELLIGENCE · INTENT ' + (r.intent || '—').toUpperCase().replace(/_/g, ' ')),
          h('div', { class: 'answer' }, r.answer),
          h('details', { class: 'evidence-drawer' },
            h('summary', {}, '▸ Underlag — ' + (r.evidence.datapoints ?? '?') + ' datapunkter · ' + ((r.evidence.sources || []).join(', ') || 'manuell data')),
            h('div', { class: 'muted', style: 'margin-top:6px' }, 'Period: ' + r.evidence.period + ' · Modell: ' + r.model),
            h('pre', {}, JSON.stringify(r.evidence.facts ?? r.evidence, null, 2))),
          h('div', { class: 'btnrow', style: 'margin-top:10px' },
            h('button', { class: 'ghost', style: 'font-size:12px;padding:4px 10px', onclick: async () => {
              const title = prompt('Åtgärdens titel:', q.slice(0, 60));
              if (!title) return;
              try { await api('/actions', { method: 'POST', body: { title } }); toast('Åtgärd skapad', true); }
              catch (ex) { toast(ex.message); }
            } }, 'Skapa åtgärd'))));
    }

    async function submit(q) {
      const pending = h('div', { class: 'chat-a' }, h('div', { class: 'tech' }, 'ANALYSERAR…'));
      thread.append(h('div', { class: 'chat-q' }, q), pending);
      pending.scrollIntoView({ behavior: Motion.reduced ? 'auto' : 'smooth', block: 'end' });
      try {
        const r = await api('/ask', { method: 'POST', body: { question: q } });
        pending.previousSibling.remove(); pending.remove();
        const block = answerBlock(q, r);
        thread.append(block);
        block.scrollIntoView({ behavior: Motion.reduced ? 'auto' : 'smooth', block: 'end' });
      } catch (ex) { pending.replaceChildren(h('div', { class: 'error-msg' }, ex.message)); }
    }

    const input = h('input', { name: 'q', placeholder: 'Ställ en fråga om verksamheten…', style: 'flex:1' });
    const form = h('form', { onsubmit: e => { e.preventDefault(); const q = input.value.trim(); if (q) { input.value = ''; submit(q); } } },
      h('div', { style: 'display:flex;gap:8px' }, input, h('button', {}, 'Fråga')));

    const briefCard = h('div', { class: 'card brief' },
      h('div', { class: 'tech', style: 'margin-bottom:6px' }, 'DAILY BRIEF · ' + (brief.mode || '').toUpperCase().replace('_', ' ')),
      h('h2', {}, brief.greeting),
      brief.status ? h('p', { class: 'small', style: 'color:var(--ink-soft);margin-top:4px' }, brief.status) : null,
      brief.items.length ? h('div', { style: 'margin-top:10px' },
        brief.items.map((it, i) => h('a', { href: '#/finding/' + it.id, style: 'display:block;text-decoration:none;color:inherit;padding:6px 0;border-bottom:1px solid var(--hairline)' },
          h('span', { class: 'tech', style: 'margin-right:10px' }, String(i + 1).padStart(2, '0')),
          h('span', { class: 'tag ' + it.severity }, SEV_LABEL[it.severity]), ' ',
          h('span', { class: 'small' }, it.title))))
      : h('p', { class: 'muted', style: 'margin-top:8px' }, 'Inget kräver din uppmärksamhet just nu.'));
    Motion.revealSeq(briefCard, 'a', 90);

    return h('div', {},
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Fråga verksamheten'),
        h('div', { class: 'sub' }, 'Fråga → intent → datahämtning → deterministisk beräkning → evidens → svar. Samma sanningsmodell som dashboarden.'))),
      briefCard,
      h('div', { class: 'card' }, form,
        h('div', { style: 'margin-top:10px;display:flex;gap:6px;flex-wrap:wrap' },
          examples.map(x => h('button', { class: 'ghost', style: 'font-size:11.5px;padding:4px 10px', onclick: () => { input.value = x; input.focus(); } }, x)))),
      thread,
      history.length ? h('div', { class: 'section-title' }, 'Tidigare frågor') : null,
      history.slice(0, 8).map(q => h('div', { class: 'card tight' },
        h('strong', { class: 'small' }, q.question),
        h('div', { class: 'answer small', style: 'margin-top:6px;color:var(--ink-soft)' }, q.answer.length > 350 ? q.answer.slice(0, 350) + '…' : q.answer),
        h('div', { class: 'tech', style: 'margin-top:6px' }, dt(q.asked_at) + ' · ' + (q.model || '')))));
  }

  // ---------- liquidity ----------

  async function liquidityView() {
    const liq = await api('/liquidity');
    const riskLabel = { unknown: 'Okänd', low: 'Låg', medium: 'Måttlig', high: 'Hög', critical: 'Kritisk' };
    const riskClass = { unknown: 'configured', low: 'ok', medium: 'configured', high: 'error', critical: 'error' };

    const points = liq.weeks.map(w => ({ period: w.weekStart, value: w.balance }));

    return h('div', {},
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Likviditet'),
        h('div', { class: 'sub' }, '13-veckors kassaflödesprognos byggd på öppna fakturor, fasta kostnader och löner.'))),
      h('div', { class: 'grid kpis' },
        kpiCard('Kassaposition (start)', liq.startBalance !== null ? kr(liq.startBalance) : 'Ej angiven', null),
        kpiCard('Lägsta prognostiserat saldo', liq.minBalance !== null ? kr(liq.minBalance) : '–', liq.minWeek ? { text: 'vecka ' + liq.minWeek, dir: (liq.minBalance || 0) < 0 ? 'down' : 'up' } : null),
        kpiCard('Buffertmål', liq.bufferTarget !== null ? kr(liq.bufferTarget) : 'Ej angivet', null),
        h('div', { class: 'kpi' },
          h('div', { class: 'label' }, 'Risknivå'),
          h('div', { class: 'value' }, h('span', { class: 'pill-status ' + riskClass[liq.riskLevel] }, riskLabel[liq.riskLevel])))),
      h('div', { class: 'card' },
        h('h2', {}, 'Prognostiserat kassasaldo per vecka'),
        liq.startBalance === null ? h('div', { class: 'error-msg', style: 'margin-top:10px' },
          'Kassaposition saknas i verksamhetsprofilen — kurvan visar ackumulerade nettoflöden, inte verkligt saldo.') : null,
        h('div', { class: 'chart-box', style: 'margin-top:10px' },
          lineChart([{ label: 'Saldo', color: '#1d4e6e', points, area: true }], { refLine: liq.bufferTarget })),
        liq.bufferTarget !== null ? h('div', { class: 'muted' }, 'Streckad linje = buffertmål') : null),
      h('div', { class: 'card' },
        h('h2', {}, 'Veckodetaljer'),
        h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Vecka'), h('th', { class: 'num' }, 'Inbetalningar'), h('th', { class: 'num' }, 'Utbetalningar'), h('th', { class: 'num' }, 'Saldo'), h('th', {}, 'Noteringar'))),
          h('tbody', {}, liq.weeks.map(w => h('tr', {},
            h('td', {}, w.weekStart),
            h('td', { class: 'num' }, kr(w.inflow)),
            h('td', { class: 'num' }, kr(w.outflow)),
            h('td', { class: 'num', style: w.balance < 0 ? 'color:var(--danger);font-weight:600' : '' }, kr(w.balance)),
            h('td', { class: 'muted' }, w.notes.join(', ')))))))),
      h('div', { class: 'card' },
        h('h2', {}, 'Antaganden och begränsningar'),
        h('ul', { class: 'list-plain' }, liq.assumptions.map(a => h('li', {}, a)))));
  }

  // ---------- actions & decisions ----------

  async function actionsView() {
    const [actions, decisions, findings] = await Promise.all([api('/actions'), api('/decisions'), api('/findings')]);
    const effLabel = { pending: 'Effekt ej verifierad', effective: 'Effekt observerad', ineffective: 'Effekt uteblivit' };
    const effClass = { pending: 'configured', effective: 'ok', ineffective: 'error' };

    const actionForm = h('form', { onsubmit: async e => {
      e.preventDefault(); const fd = new FormData(e.target);
      try {
        await api('/actions', { method: 'POST', body: { title: fd.get('title'), owner: fd.get('owner'), priority: fd.get('priority'), due_date: fd.get('due_date') || null, expected_effect: fd.get('expected_effect'), finding_id: fd.get('finding_id') || null } });
        toast('Åtgärd skapad', true); route();
      } catch (ex) { toast(ex.message); }
    } },
      h('div', { class: 'grid two' },
        h('label', { class: 'fld' }, h('span', {}, 'Åtgärd *'), h('input', { name: 'title', required: '' })),
        h('label', { class: 'fld' }, h('span', {}, 'Ansvarig'), h('input', { name: 'owner' })),
        h('label', { class: 'fld' }, h('span', {}, 'Prioritet'), h('select', { name: 'priority' }, h('option', { value: 'high' }, 'Hög'), h('option', { value: 'medium', selected: '' }, 'Medel'), h('option', { value: 'low' }, 'Låg'))),
        h('label', { class: 'fld' }, h('span', {}, 'Deadline'), h('input', { name: 'due_date', type: 'date' }))),
      h('label', { class: 'fld' }, h('span', {}, 'Förväntad effekt'), h('input', { name: 'expected_effect' })),
      h('label', { class: 'fld' }, h('span', {}, 'Koppla till observation'), h('select', { name: 'finding_id' },
        h('option', { value: '' }, '— ingen —'),
        findings.map(f => h('option', { value: f.id }, f.title.slice(0, 80))))),
      h('button', {}, 'Skapa åtgärd'));

    const decisionForm = h('form', { onsubmit: async e => {
      e.preventDefault(); const fd = new FormData(e.target);
      try {
        await api('/decisions', { method: 'POST', body: { title: fd.get('title'), rationale: fd.get('rationale'), expected_result: fd.get('expected_result') } });
        toast('Beslut registrerat', true); route();
      } catch (ex) { toast(ex.message); }
    } },
      h('label', { class: 'fld' }, h('span', {}, 'Beslut *'), h('input', { name: 'title', required: '' })),
      h('label', { class: 'fld' }, h('span', {}, 'Motivering'), h('textarea', { name: 'rationale' })),
      h('label', { class: 'fld' }, h('span', {}, 'Förväntat resultat'), h('input', { name: 'expected_result' })),
      h('button', {}, 'Registrera beslut'));

    return h('div', {},
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Åtgärder & beslut'),
        h('div', { class: 'sub' }, 'Closed loop: observerat → bedömt → rekommenderat → beslutat → genomfört → mätt → verifierat.'))),
      h('div', { class: 'card' },
        h('h2', {}, 'Åtgärder'),
        actions.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Åtgärd'), h('th', {}, 'Ansvarig'), h('th', {}, 'Deadline'), h('th', {}, 'Status'), h('th', {}, 'Effekt'), h('th', {}, ''))),
          h('tbody', {}, actions.map(a => h('tr', {},
            h('td', {}, h('strong', {}, a.title), a.expected_effect ? h('div', { class: 'muted' }, 'Förväntat: ' + a.expected_effect) : null,
              a.observed_effect ? h('div', { class: 'muted' }, 'Observerat: ' + a.observed_effect) : null),
            h('td', {}, a.owner || '–'),
            h('td', {}, a.due_date || '–'),
            h('td', {}, h('span', { class: 'pill-status ' + (a.status === 'done' ? 'ok' : 'configured') }, a.status)),
            h('td', {}, a.effect_verified ? h('span', { class: 'pill-status ' + effClass[a.effect_verified] }, effLabel[a.effect_verified]) : '–'),
            h('td', {}, a.status !== 'done' && a.status !== 'cancelled' ? h('div', { class: 'btnrow' },
              a.status === 'open' ? h('button', { class: 'ghost', style: 'padding:4px 10px;font-size:12px', onclick: () => setActionStatus(a.id, 'in_progress') }, 'Starta') : null,
              h('button', { class: 'secondary', style: 'padding:4px 10px;font-size:12px', onclick: () => setActionStatus(a.id, 'done') }, 'Klart')) : null))))))
        : h('div', { class: 'empty' }, 'Inga åtgärder ännu.')),
      h('div', { class: 'grid two' },
        h('div', { class: 'card' }, h('h2', {}, 'Ny åtgärd'), actionForm),
        h('div', { class: 'card' }, h('h2', {}, 'Nytt beslut'), decisionForm)),
      h('div', { class: 'card' },
        h('h2', {}, 'Beslutslogg'),
        decisions.length ? decisions.map(d => h('div', { class: 'timeline-item' },
          h('span', { class: 't-date' }, d10(d.decided_at)),
          h('div', {}, h('strong', {}, d.title),
            d.rationale ? h('div', { class: 'muted' }, d.rationale) : null,
            d.expected_result ? h('div', { class: 'muted' }, 'Förväntat: ' + d.expected_result) : null,
            d.actual_result ? h('div', { class: 'muted' }, 'Utfall: ' + d.actual_result) : null)))
        : h('div', { class: 'empty' }, 'Inga beslut registrerade.')));
  }

  async function setActionStatus(id, status) {
    let observed;
    if (status === 'done') observed = prompt('Observerad effekt (valfritt):') || undefined;
    try { await api('/actions/' + id + '/status', { method: 'POST', body: { status, observed_effect: observed } }); route(); }
    catch (e) { toast(e.message); }
  }

  // ---------- reports ----------

  async function reportsView() {
    const data = await api('/reports');
    const out = h('div');
    const customBox = h('textarea', { placeholder: 'Beskriv vilken analys som behövs…', style: 'display:none' });

    const typeSel = h('select', {}, data.types.map(t => h('option', { value: t.key }, t.label + ' — ' + t.description)));
    typeSel.addEventListener('change', () => { customBox.style.display = typeSel.value === 'custom' ? '' : 'none'; });

    async function generate() {
      out.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Genererar rapport…')));
      try {
        const r = await api('/reports', { method: 'POST', body: { type: typeSel.value, custom_prompt: customBox.value || undefined } });
        out.replaceChildren(reportCard(r.title, r.content));
        toast('Rapport genererad', true);
      } catch (ex) { out.replaceChildren(h('div', { class: 'error-msg' }, ex.message)); }
    }

    return h('div', {},
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Rapporter'),
        h('div', { class: 'sub' }, 'Genereras från samma strukturerade findings och nyckeltal som dashboarden.'))),
      h('div', { class: 'card' },
        h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start' },
          h('div', { style: 'flex:1;min-width:240px' }, typeSel, customBox),
          h('button', { onclick: generate }, 'Generera')),
      ),
      out,
      data.reports.length ? h('div', { class: 'section-title' }, 'Tidigare rapporter') : null,
      data.reports.map(r => h('div', { class: 'card tight', style: 'cursor:pointer', onclick: async () => {
        const full = await api('/reports/' + r.id);
        out.replaceChildren(reportCard(full.title, full.content));
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } },
        h('strong', { class: 'small' }, r.title),
        h('div', { class: 'muted' }, dt(r.created_at)))));
  }

  function reportCard(title, content) {
    return h('div', { class: 'card' },
      h('h2', {}, title),
      h('div', { class: 'divider' }),
      content.sections.map(s => h('div', { class: 'report-section' },
        h('h3', {}, s.heading),
        s.body ? h('div', { class: 'answer' }, s.body) : null,
        s.list ? h('ul', { class: 'list-plain' }, s.list.map(li => h('li', {}, li))) : null,
        s.table ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, s.table.headers.map(hd => h('th', {}, hd)))),
          h('tbody', {}, s.table.rows.map(row => h('tr', {}, row.map((c, i) => h('td', { class: i > 0 ? 'num' : '' }, String(c)))))))) : null)),
      h('div', { class: 'muted' }, 'Genererad ' + dt(content.meta && content.meta.generated_at)));
  }

  // ---------- alerts ----------

  async function alertsView() {
    const [alerts, prefs] = await Promise.all([api('/alerts'), api('/alert-prefs')]);
    const channels = [
      { key: 'in_app', label: 'I appen' },
      { key: 'email', label: 'E-post' },
      { key: 'sms', label: 'SMS' },
      { key: 'push', label: 'Push' }
    ];
    const prefMap = {};
    prefs.forEach(p => { prefMap[p.channel] = p; });

    const prefForm = h('form', { onsubmit: async e => {
      e.preventDefault();
      const rows = [...e.target.querySelectorAll('[data-ch]')].map(row => ({
        channel: row.dataset.ch,
        enabled: row.querySelector('input[type=checkbox]').checked,
        min_severity: row.querySelector('select').value,
        destination: row.querySelector('input[type=text]') ? row.querySelector('input[type=text]').value : null
      }));
      try { await api('/alert-prefs', { method: 'PUT', body: { prefs: rows } }); toast('Notifieringsinställningar sparade', true); }
      catch (ex) { toast(ex.message); }
    } },
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Kanal'), h('th', {}, 'Aktiv'), h('th', {}, 'Lägsta severity'), h('th', {}, 'Destination'))),
        h('tbody', {}, channels.map(c => {
          const p = prefMap[c.key] || {};
          return h('tr', { 'data-ch': c.key },
            h('td', {}, c.label),
            h('td', {}, h('input', { type: 'checkbox', style: 'width:auto', ...(p.enabled ? { checked: '' } : {}) })),
            h('td', {}, h('select', {}, ['medium', 'high', 'critical'].map(s =>
              h('option', { value: s, ...(p.min_severity === s ? { selected: '' } : {}) }, SEV_LABEL[s])))),
            h('td', {}, ['sms', 'push', 'email'].includes(c.key) ? h('input', { type: 'text', placeholder: c.key === 'sms' ? '+46…' : '', value: p.destination || '' }) : h('span', { class: 'muted' }, '—')));
        })))),
      h('button', { style: 'margin-top:12px' }, 'Spara'));

    return h('div', {},
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Alerts'),
        h('div', { class: 'sub' }, 'En alert innebär att något faktiskt kräver uppmärksamhet. Systemet deduplicerar för att undvika notisspam.'))),
      alerts.length ? alerts.map(a => h('div', { class: 'card tight', style: a.read_at ? 'opacity:.65' : '' },
        h('div', { style: 'display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap' },
          h('div', {},
            h('span', { class: 'tag ' + a.severity }, SEV_LABEL[a.severity] || a.severity), ' ',
            h('strong', {}, a.title),
            h('div', { class: 'small', style: 'color:var(--ink-soft);margin-top:4px' }, a.body),
            h('div', { class: 'muted', style: 'margin-top:4px' }, dt(a.created_at))),
          h('div', { class: 'btnrow' },
            a.finding_id ? h('a', { class: 'btn secondary', href: '#/finding/' + a.finding_id, style: 'font-size:12px;padding:5px 10px' }, 'Öppna') : null,
            !a.read_at ? h('button', { class: 'ghost', style: 'font-size:12px;padding:5px 10px', onclick: async () => { await api('/alerts/' + a.id + '/read', { method: 'POST' }); route(); } }, 'Markera läst') : null))))
      : h('div', { class: 'card empty' }, 'Inga alerts.'),
      h('div', { class: 'card' },
        h('h2', {}, 'Notifieringspreferenser'),
        h('div', { class: 'muted', style: 'margin-bottom:10px' }, 'Per kanal och severity. E-post/SMS/push levereras när respektive leverantör är konfigurerad på servern; alla försök loggas.'),
        prefForm));
  }

  // ---------- integrations ----------

  async function integrationsView() {
    const [connectors, sources] = await Promise.all([api('/connectors'), api('/sources')]);
    const connectorByKey = {};
    connectors.forEach(c => { connectorByKey[c.key] = c; });

    function sourceRow(s) {
      const isFile = s.connector_key === 'csv' || s.connector_key === 'excel';
      const fileInput = h('input', { type: 'file', accept: s.connector_key === 'excel' ? '.xlsx,.xls' : '.csv,.txt', style: 'display:none' });
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        if (!file) return;
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const b64 = btoa(bin);
        try {
          const r = await api('/sources/' + s.id + '/upload', { method: 'POST', body: { filename: file.name, content_base64: b64, dataset: 'auto' } });
          toast('Importerade: ' + r.datasets.map(d => d.dataset + ' (' + d.upserted + ' rader)').join(', '), true);
          route();
        } catch (ex) { toast(ex.message); }
      });

      return h('div', { class: 'card tight' },
        h('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap' },
          h('div', {},
            h('strong', {}, s.name), ' ', h('span', { class: 'muted' }, '· ' + s.connector_key),
            h('div', { class: 'small', style: 'margin-top:4px' },
              h('span', { class: 'pill-status ' + s.status }, s.status === 'connected' ? 'Ansluten' : s.status === 'configured' ? 'Konfigurerad' : s.status === 'error' ? 'Fel' : 'Bortkopplad'),
              ' ', h('span', { class: 'muted' }, s.last_sync_at ? 'Senaste synk: ' + dt(s.last_sync_at) + ' (' + s.last_sync_status + ')' : 'Aldrig synkroniserad')),
            s.last_error ? h('div', { class: 'small', style: 'color:var(--danger);margin-top:4px' }, s.last_error) : null),
          h('div', { class: 'btnrow' },
            isFile && s.status !== 'disconnected' ? h('button', { onclick: () => fileInput.click() }, 'Ladda upp fil') : null,
            !isFile && s.status !== 'disconnected' ? h('button', { class: 'secondary', onclick: async () => {
              try { const r = await api('/sources/' + s.id + '/sync', { method: 'POST' }); toast(r.ok ? 'Synk klar' : ('Synkfel: ' + r.error), r.ok); route(); }
              catch (ex) { toast(ex.message); }
            } }, 'Synkronisera') : null,
            s.connector_key === 'fortnox' && s.status !== 'disconnected' && s.status !== 'connected' ? h('button', { onclick: async () => {
              try { const r = await api('/connect/fortnox/start?source_id=' + s.id); location.href = r.url; }
              catch (ex) { toast(ex.message); }
            } }, 'Anslut via OAuth') : null,
            s.status !== 'disconnected' ? h('button', { class: 'secondary', onclick: async () => {
              try { const st = await api('/sources/' + s.id + '/test', { method: 'POST' }); toast(st.detail, st.ok); }
              catch (ex) { toast(ex.message); }
            } }, 'Testa') : null,
            s.status !== 'disconnected' ? h('button', { class: 'ghost', onclick: async () => {
              if (!confirm('Koppla bort källan? API-uppgifter raderas, redan importerad data behålls.')) return;
              await api('/sources/' + s.id + '/disconnect', { method: 'POST' }); toast('Källan bortkopplad', true); route();
            } }, 'Koppla bort') : null,
            h('button', { class: 'danger', onclick: async () => {
              if (!confirm('Radera källan OCH all data som importerats från den?')) return;
              await api('/sources/' + s.id, { method: 'DELETE' }); toast('Källa och data raderad', true); route();
            } }, 'Radera')),
          fileInput));
    }

    const addForm = (() => {
      const sel = h('select', {}, connectors.map(c => h('option', { value: c.key }, c.name + (c.availability.ok ? '' : ' (kräver serverkonfiguration)'))));
      const nameInput = h('input', { placeholder: 'Namn på källan, t.ex. "Fortnox — huvudbolag"' });
      const cfgBox = h('div');
      function renderCfg() {
        const c = connectorByKey[sel.value];
        cfgBox.replaceChildren(
          h('p', { class: 'muted', style: 'margin:8px 0' }, c.description),
          !c.availability.ok ? h('div', { class: 'error-msg' }, c.availability.reason) : null,
          ...c.config_fields.map(f => h('label', { class: 'fld' },
            h('span', {}, f.label + (f.secret ? ' (lagras krypterat)' : '')),
            h('input', { 'data-cfg': f.key, placeholder: f.placeholder || '', type: f.secret ? 'password' : 'text' }))));
      }
      sel.addEventListener('change', renderCfg);
      setTimeout(renderCfg, 0);
      return h('div', { class: 'card' },
        h('h2', {}, 'Lägg till datakälla'),
        h('div', { class: 'grid two', style: 'margin-top:10px' },
          h('label', { class: 'fld' }, h('span', {}, 'Connector'), sel),
          h('label', { class: 'fld' }, h('span', {}, 'Namn'), nameInput)),
        cfgBox,
        h('button', { onclick: async () => {
          const cfg = {};
          cfgBox.querySelectorAll('[data-cfg]').forEach(i => { if (i.value) cfg[i.dataset.cfg] = i.value; });
          try {
            await api('/sources', { method: 'POST', body: { connector_key: sel.value, name: nameInput.value, config: cfg } });
            toast('Källa skapad', true); route();
          } catch (ex) { toast(ex.message); }
        } }, 'Skapa källa'));
    })();

    return h('div', {},
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Integrationer'),
        h('div', { class: 'sub' }, 'Connector-first: varje källa är en återanvändbar adapter. API-uppgifter lagras krypterat och exponeras aldrig mot webbläsaren.'))),
      sources.length ? sources.map(sourceRow) : h('div', { class: 'card empty' }, 'Inga datakällor ännu. Lägg till en nedan.'),
      addForm,
      h('div', { class: 'card' },
        h('h2', {}, 'Tillgängliga connectors'),
        h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Connector'), h('th', {}, 'Auth'), h('th', {}, 'Dataset'), h('th', {}, 'Status'))),
          h('tbody', {}, connectors.map(c => h('tr', {},
            h('td', {}, h('strong', {}, c.name), h('div', { class: 'muted' }, c.description)),
            h('td', {}, c.auth_kind),
            h('td', { class: 'small' }, c.datasets.map(d => d.label).join(', ')),
            h('td', {}, h('span', { class: 'pill-status ' + (c.availability.ok ? 'ok' : 'configured') }, c.availability.ok ? 'Tillgänglig' : 'Kräver konfig')))))))));
  }

  // ---------- profile ----------

  async function profileView() {
    const [prof, observations] = await Promise.all([api('/profile'), api('/observations')]);
    const inputs = {};

    const obsForm = h('form', { onsubmit: async e => {
      e.preventDefault(); const fd = new FormData(e.target);
      try { await api('/observations', { method: 'POST', body: { text: fd.get('text'), category: fd.get('category') } }); toast('Observation sparad', true); route(); }
      catch (ex) { toast(ex.message); }
    } },
      h('label', { class: 'fld' }, h('span', {}, 'Ny manuell observation'), h('textarea', { name: 'text', required: '', placeholder: 'T.ex. "Två tekniker slutar i september", "Ny stor kund från oktober"…' })),
      h('label', { class: 'fld' }, h('span', {}, 'Kategori (valfri)'), h('input', { name: 'category', placeholder: 'personal / marknad / kunder…' })),
      h('button', {}, 'Spara observation'));

    return h('div', {},
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Verksamhetsprofil'),
        h('div', { class: 'sub' }, 'Manuell grunddata. Allt här märks som "Manuell uppgift" i analyser och evidens — systemet låtsas aldrig att manuell data kommer från en integration.'))),
      h('div', { class: 'card' },
        h('div', { class: 'grid two' },
          prof.fields.map(f => h('label', { class: 'fld' },
            h('span', {}, f.label),
            inputs[f.key] = f.type === 'text'
              ? h('textarea', { value: prof.values[f.key] || '' }, prof.values[f.key] || '')
              : h('input', { type: 'number', step: 'any', value: prof.values[f.key] || '' })))),
        h('button', { onclick: async () => {
          const values = {};
          for (const k in inputs) values[k] = inputs[k].value;
          try { await api('/profile', { method: 'PUT', body: { values } }); toast('Profil sparad. Kör en ny analys för att uppdatera bedömningen.', true); }
          catch (ex) { toast(ex.message); }
        } }, 'Spara profil')),
      h('div', { class: 'grid two' },
        h('div', { class: 'card' }, h('h2', {}, 'Manuella observationer'), obsForm),
        h('div', { class: 'card' },
          h('h2', {}, 'Loggade observationer'),
          observations.length ? observations.map(o => h('div', { class: 'timeline-item' },
            h('span', { class: 't-date' }, o.date),
            h('div', {}, o.text, o.category ? h('span', { class: 'muted' }, ' · ' + o.category) : null)))
          : h('div', { class: 'empty' }, 'Inga observationer.'))));
  }

  // ---------- admin ----------

  async function adminView() {
    const [me, users, keys, auditLog, outbox] = await Promise.all([
      api('/me'), api('/users'), api('/api-keys'), api('/audit'), api('/notifications/outbox')
    ]);
    const keyResult = h('div');

    const userForm = h('form', { onsubmit: async e => {
      e.preventDefault(); const fd = new FormData(e.target);
      try {
        await api('/users', { method: 'POST', body: { name: fd.get('name'), email: fd.get('email'), password: fd.get('password'), role: fd.get('role') } });
        toast('Användare skapad', true); route();
      } catch (ex) { toast(ex.message); }
    } },
      h('div', { class: 'grid two' },
        h('label', { class: 'fld' }, h('span', {}, 'Namn'), h('input', { name: 'name', required: '' })),
        h('label', { class: 'fld' }, h('span', {}, 'E-post'), h('input', { name: 'email', type: 'email', required: '' })),
        h('label', { class: 'fld' }, h('span', {}, 'Lösenord'), h('input', { name: 'password', type: 'password', required: '', minlength: 8 })),
        h('label', { class: 'fld' }, h('span', {}, 'Roll'), h('select', { name: 'role' },
          Object.entries(ROLE_LABEL).map(([k, v]) => h('option', { value: k }, v))))),
      h('button', {}, 'Skapa användare'));

    return h('div', {},
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Administration'))),
      h('div', { class: 'card' },
        h('h2', {}, 'Användare'),
        h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Namn'), h('th', {}, 'E-post'), h('th', {}, 'Roll'))),
          h('tbody', {}, users.map(u => h('tr', {}, h('td', {}, u.name), h('td', {}, u.email), h('td', {}, ROLE_LABEL[u.role] || u.role)))))),
        h('div', { class: 'divider' }),
        h('h3', {}, 'Ny användare'), userForm),
      h('div', { class: 'card' },
        h('h2', {}, 'API-nycklar'),
        h('p', { class: 'muted' }, 'För externa system: Authorization: Bearer <nyckel> mot /api/v1/… Nyckeln visas endast en gång.'),
        keyResult,
        keys.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Namn'), h('th', {}, 'Prefix'), h('th', {}, 'Skapad'), h('th', {}, 'Senast använd'), h('th', {}, ''))),
          h('tbody', {}, keys.map(k => h('tr', {},
            h('td', {}, k.name), h('td', {}, h('code', { class: 'inline' }, k.prefix + '…')),
            h('td', {}, d10(k.created_at)), h('td', {}, k.last_used_at ? dt(k.last_used_at) : '–'),
            h('td', {}, k.revoked_at ? h('span', { class: 'muted' }, 'Återkallad') :
              h('button', { class: 'ghost', style: 'font-size:12px;padding:4px 10px', onclick: async () => {
                await api('/api-keys/' + k.id + '/revoke', { method: 'POST' }); route();
              } }, 'Återkalla')))))))
        : null,
        h('button', { style: 'margin-top:10px', onclick: async () => {
          const name = prompt('Namn på nyckeln:') || 'API-nyckel';
          const r = await api('/api-keys', { method: 'POST', body: { name } });
          keyResult.replaceChildren(h('div', { class: 'ok-msg' }, 'Nyckel (visas endast nu): ', h('code', { class: 'inline' }, r.key)));
          route.pending = true;
        } }, 'Skapa API-nyckel')),
      h('div', { class: 'card' },
        h('h2', {}, 'RSS-flöden'),
        h('p', { class: 'muted', style: 'margin-bottom:8px' }, 'Läggs in i valfri RSS-läsare eller informationsflöde.'),
        h('ul', { class: 'list-plain' },
          ['alerts', 'findings', 'management'].map(f => h('li', {},
            h('code', { class: 'inline' }, location.origin + '/rss/' + f + '?token=' + (me.rss_token || '…')))))),
      h('div', { class: 'card' },
        h('h2', {}, 'Notifieringslogg (outbox)'),
        outbox.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Tid'), h('th', {}, 'Kanal'), h('th', {}, 'Titel'), h('th', {}, 'Status'))),
          h('tbody', {}, outbox.map(o => h('tr', {},
            h('td', {}, dt(o.created_at)), h('td', {}, o.channel), h('td', { class: 'small' }, o.title),
            h('td', {}, h('span', { class: 'pill-status ' + (o.status === 'sent' ? 'ok' : o.status === 'failed' ? 'error' : 'configured') }, o.status + (o.detail ? ' · ' + o.detail : ''))))))))
        : h('div', { class: 'empty' }, 'Inga notifieringar skickade ännu.')),
      h('div', { class: 'card' },
        h('h2', {}, 'Auditlogg'),
        h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Tid'), h('th', {}, 'Händelse'), h('th', {}, 'Mål'))),
          h('tbody', {}, auditLog.slice(0, 40).map(a => h('tr', {},
            h('td', {}, dt(a.at)), h('td', {}, a.action), h('td', { class: 'small' }, a.target || ''))))))));
  }

  // ---------- Control Center ----------

  async function settingsView() {
    const data = await api('/settings');
    let advanced = false;
    let scope = ME.user.role === 'admin' ? 'org' : 'user';
    const pending = {};
    const wrap = h('div');

    const CAT_LABELS = {
      constitution: 'SYSTEM CONSTITUTION', general: 'GENERAL', intelligence: 'INTELLIGENCE',
      guidance: 'GUIDANCE', reports: 'REPORTS', tone: 'TONE', notifications: 'NOTIFICATIONS / POLICY'
    };
    const CAT_ORDER = ['constitution', 'general', 'intelligence', 'guidance', 'reports', 'tone', 'notifications'];

    function currentValue(key) {
      if (key in pending) return pending[key];
      const src = scope === 'user' ? data.effective : data.org;
      return src[key] ? src[key].value : '';
    }

    function settingRow(def) {
      const resolved = (scope === 'user' ? data.effective : data.org)[def.key];
      const row = h('div', { class: 'setting-row' },
        h('div', { style: 'display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap' },
          h('div', {},
            h('div', { class: 's-label' }, def.label),
            h('div', { class: 's-desc' }, def.description)),
          h('span', { class: 's-source' }, resolved ? resolved.source : 'default')));
      if (def.type === 'select' && def.options) {
        const cards = h('div', { class: 'opt-cards' },
          def.options.map(o => {
            const c = h('div', { class: 'opt-card' + (currentValue(def.key) === o.value ? ' selected' : ''), onclick: () => {
              pending[def.key] = o.value;
              cards.querySelectorAll('.opt-card').forEach(x => x.classList.remove('selected'));
              c.classList.add('selected');
            } },
              h('div', { class: 'o-label' }, o.label),
              h('div', { class: 'o-desc' }, o.description));
            return c;
          }));
        row.append(cards);
      } else {
        const inp = def.type === 'number'
          ? h('input', { type: 'number', step: 'any', value: currentValue(def.key), style: 'max-width:220px;margin-top:8px' })
          : h('input', { type: 'text', value: currentValue(def.key), style: 'margin-top:8px' });
        inp.addEventListener('input', () => { pending[def.key] = inp.value; });
        row.append(inp);
      }
      return row;
    }

    function render() {
      const cats = CAT_ORDER.map(cat => {
        const defs = data.catalog.filter(d => d.category === cat && (advanced || !d.advanced));
        if (!defs.length) return null;
        return h('div', { class: 'card' },
          h('div', { class: 'tech', style: 'margin-bottom:4px' }, CAT_LABELS[cat] || cat.toUpperCase()),
          defs.map(settingRow));
      });
      const content = h('div', {},
        h('div', { class: 'card tight' },
          h('div', { style: 'display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center' },
            h('div', { class: 'btnrow' },
              h('button', { class: advanced ? 'ghost' : 'secondary', onclick: () => { advanced = false; render(); } }, 'Simple'),
              h('button', { class: advanced ? 'secondary' : 'ghost', onclick: () => { advanced = true; render(); } }, 'Advanced')),
            ME.user.role === 'admin' ? h('div', { class: 'btnrow' },
              h('button', { class: scope === 'org' ? 'secondary' : 'ghost', onclick: () => { scope = 'org'; render(); } }, 'Organisation'),
              h('button', { class: scope === 'user' ? 'secondary' : 'ghost', onclick: () => { scope = 'user'; render(); } }, 'Bara mig'))
            : h('span', { class: 'tech' }, 'PERSONLIGA INSTÄLLNINGAR'))),
        ME.user.role === 'admin' && scope === 'org' ? h('div', { class: 'card' },
          h('div', { class: 'tech', style: 'margin-bottom:8px' }, 'PRESETS'),
          h('div', { class: 'opt-cards' },
            data.presets.map(p => h('div', { class: 'opt-card', onclick: async () => {
              if (!confirm('Tillämpa preset "' + p.label + '" på organisationen?')) return;
              await api('/settings/preset', { method: 'POST', body: { preset: p.key } });
              toast('Preset tillämpad', true); route();
            } },
              h('div', { class: 'o-label' }, p.label),
              h('div', { class: 'o-desc' }, p.description))))) : null,
        cats,
        h('div', { class: 'btnrow', style: 'margin-top:4px' },
          h('button', { onclick: async () => {
            if (!Object.keys(pending).length) { toast('Inga ändringar att spara', true); return; }
            try {
              await api('/settings', { method: 'PUT', body: { values: pending, scope } });
              toast('Inställningar sparade (' + (scope === 'org' ? 'organisation' : 'personligt') + '). Alla ändringar auditloggas.', true);
              route();
            } catch (ex) { toast(ex.message); }
          } }, 'Spara ändringar')));
      wrap.replaceChildren(content);
    }
    render();

    return h('div', {},
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Kontrollcenter'),
        h('div', { class: 'sub' }, 'Opinionated defaults, deep control. Bra standardinställningar — och djup konfigurerbarhet när du vill. Varje inställning förklarar sin konsekvens.'))),
      wrap);
  }

  // ---------- Governance (Styrning) ----------

  async function governanceView() {
    const [docs, goals, units, risks] = await Promise.all([api('/documents'), api('/goals'), api('/units'), api('/risks')]);
    const reviewBox = h('div');

    async function openReview(docId, filename) {
      const items = await api('/documents/' + docId + '/items');
      reviewBox.replaceChildren(h('div', { class: 'card' },
        h('div', { class: 'tech', style: 'margin-bottom:6px' }, 'SYSTEMET HAR TOLKAT · ' + filename),
        h('div', { class: 'muted', style: 'margin-bottom:10px' }, 'Granska varje post. Inget blir styrande utan godkännande.'),
        items.length ? items.map(it => h('div', { class: 'evidence-item ' + (it.status === 'approved' ? 'fact' : 'derived') },
          h('div', { class: 'e-label' }, it.kind.toUpperCase() + ' · ' + it.status),
          h('div', { class: 'e-value', style: 'font-size:13px' }, it.payload.label || it.payload.title || it.payload.definition || '—'),
          it.payload.target_value ? h('div', { class: 'e-src' }, 'Målvärde: ' + Number(it.payload.target_value).toLocaleString('sv-SE') + (it.payload.target_unit === '%' ? ' %' : ' kr') + (it.payload.period_start ? ' · ' + it.payload.period_start.slice(0, 4) : '')) : null,
          it.status === 'proposed' ? h('div', { class: 'btnrow', style: 'margin-top:6px' },
            h('button', { style: 'font-size:12px;padding:4px 12px', onclick: async () => { await api('/document-items/' + it.id + '/approve', { method: 'POST' }); toast('Godkänd och materialiserad', true); openReview(docId, filename); } }, 'Godkänn'),
            h('button', { class: 'ghost', style: 'font-size:12px;padding:4px 12px', onclick: async () => { await api('/document-items/' + it.id + '/reject', { method: 'POST' }); openReview(docId, filename); } }, 'Avvisa')) : null))
        : h('div', { class: 'empty' }, 'Inga poster kunde extraheras ur dokumentet.')));
      reviewBox.scrollIntoView({ behavior: Motion.reduced ? 'auto' : 'smooth' });
    }

    const fileInput = h('input', { type: 'file', accept: '.txt,.md,.csv,.xlsx', style: 'display:none' });
    const pasteArea = h('textarea', { placeholder: 'Eller klistra in text ur verksamhetsplan / ledningsgenomgång här…' });
    const kindSel = h('select', {},
      h('option', { value: 'verksamhetsplan' }, 'Verksamhetsplan'),
      h('option', { value: 'ledningsgenomgang' }, 'Ledningsgenomgång'),
      h('option', { value: 'budget' }, 'Budget'),
      h('option', { value: 'policy' }, 'Policy'),
      h('option', { value: 'other' }, 'Övrigt'));

    async function uploadDoc(filename, content, contentBase64) {
      try {
        const r = await api('/documents', { method: 'POST', body: { filename, kind: kindSel.value, content, content_base64: contentBase64 } });
        const parts = Object.entries(r.counts).map(([k, v]) => v + ' ' + k).join(', ');
        toast('Jag hittade: ' + (parts || 'inga styrobjekt') + '. Granska nedan.', true);
        await openReview(r.documentId, filename);
      } catch (ex) { toast(ex.message); }
    }
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      await uploadDoc(file.name, null, btoa(bin));
    });

    function unitNode(n, depth) {
      return [h('div', { class: 'unit-node', style: 'padding-left:' + depth * 18 + 'px' },
        (depth ? '└ ' : '') + n.name, h('span', { class: 'u-kind' }, n.kind)),
        ...n.children.flatMap(c => unitNode(c, depth + 1))];
    }
    const flatUnits = [];
    (function flatten(list) { list.forEach(n => { flatUnits.push(n); flatten(n.children); }); })(units.tree);

    return h('div', {},
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Styrning'),
        h('div', { class: 'sub' }, 'Organisationens styrande verklighet: dokument, mål, struktur och risker. Först avsikten — sedan mäts verkligheten mot den.'))),

      h('div', { class: 'card' },
        h('div', { class: 'tech', style: 'margin-bottom:6px' }, 'STYRANDE DOKUMENT'),
        h('div', { class: 'muted', style: 'margin-bottom:10px' }, 'Ladda upp verksamhetsplan, ledningsgenomgång eller budget (TXT/MD/CSV/XLSX eller inklistrad text). Systemet extraherar mål, KPI:er, risker, beslut och åtgärder — du godkänner varje post.'),
        h('div', { class: 'grid two' },
          h('div', {},
            h('label', { class: 'fld' }, h('span', {}, 'Dokumenttyp'), kindSel),
            h('div', { class: 'btnrow' },
              h('button', { onclick: () => fileInput.click() }, 'Välj fil'),
              h('button', { class: 'secondary', onclick: () => {
                const text = pasteArea.value.trim();
                if (text.length < 20) { toast('Klistra in mer text först'); return; }
                uploadDoc('inklistrad-text.txt', text, null);
              } }, 'Tolka inklistrad text')),
            fileInput),
          pasteArea),
        docs.length ? h('div', { style: 'margin-top:12px' },
          h('div', { class: 'tech', style: 'margin-bottom:4px' }, 'IMPORTERADE DOKUMENT'),
          docs.map(d => h('div', { class: 'timeline-item', style: 'cursor:pointer', onclick: () => openReview(d.id, d.filename) },
            h('span', { class: 't-date' }, d10(d.uploaded_at)),
            h('span', {}, d.filename + ' · ' + (d.kind || '') + ' · ' + d.item_count + ' poster '),
            h('span', { class: 'tech' }, (d.extraction_model || '').toUpperCase())))) : null),
      reviewBox,

      h('div', { class: 'card' },
        h('div', { class: 'tech', style: 'margin-bottom:6px' }, 'MÅL'),
        goals.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Mål'), h('th', {}, 'Metric'), h('th', { class: 'num' }, 'Målvärde'), h('th', {}, 'Period'), h('th', {}, 'Källa'), h('th', {}, ''))),
          h('tbody', {}, goals.filter(g => g.period !== 'monthly').map(g => h('tr', {},
            h('td', {}, g.label),
            h('td', {}, h('code', { class: 'inline' }, g.metric || g.key)),
            h('td', { class: 'num' }, Number(g.target_value).toLocaleString('sv-SE')),
            h('td', {}, g.period + (g.period_start ? ' ' + g.period_start.slice(0, 4) : '')),
            h('td', { class: 'small' }, g.source === 'document' ? 'Styrande dokument' : g.source === 'breakdown' ? 'Nedbrutet' : 'Manuellt'),
            h('td', {}, g.period === 'yearly' ? h('button', { class: 'ghost', style: 'font-size:11.5px;padding:3px 10px', onclick: async () => {
              const r = await api('/goals/' + g.id + '/breakdown', { method: 'POST' });
              toast(r.created ? r.created + ' månadsmål skapade' : 'Redan nedbrutet', true); route();
            } }, 'Bryt ner → månader') : null))))))
        : h('div', { class: 'empty' }, 'Inga mål registrerade. Skapa nedan eller importera ett styrande dokument.'),
        h('div', { class: 'hairline' }),
        h('form', { onsubmit: async e => {
          e.preventDefault(); const fd = new FormData(e.target);
          try {
            await api('/goals', { method: 'POST', body: { label: fd.get('label'), metric: fd.get('metric'), target_value: Number(fd.get('target_value')), period: 'yearly', year: fd.get('year') } });
            toast('Mål skapat', true); route();
          } catch (ex) { toast(ex.message); }
        } },
          h('div', { class: 'grid two' },
            h('label', { class: 'fld' }, h('span', {}, 'Mål (t.ex. "Omsättning 2026")'), h('input', { name: 'label', required: '' })),
            h('label', { class: 'fld' }, h('span', {}, 'Metric'), h('select', { name: 'metric' },
              h('option', { value: 'revenue' }, 'Omsättning'), h('option', { value: 'margin' }, 'Marginal'),
              h('option', { value: 'liquidity' }, 'Likviditet'), h('option', { value: 'costs' }, 'Kostnader'),
              h('option', { value: 'other' }, 'Övrigt'))),
            h('label', { class: 'fld' }, h('span', {}, 'Målvärde (kr/år)'), h('input', { name: 'target_value', type: 'number', required: '' })),
            h('label', { class: 'fld' }, h('span', {}, 'År'), h('input', { name: 'year', type: 'number', value: new Date().getFullYear() }))),
          h('button', {}, 'Skapa årsmål'))),

      h('div', { class: 'grid two' },
        h('div', { class: 'card' },
          h('div', { class: 'tech', style: 'margin-bottom:6px' }, 'ORGANISATIONSSTRUKTUR'),
          units.tree.length ? units.tree.flatMap(n => unitNode(n, 0)) : h('div', { class: 'empty' }, 'Inga enheter.'),
          ME.user.role === 'admin' ? h('form', { style: 'margin-top:10px', onsubmit: async e => {
            e.preventDefault(); const fd = new FormData(e.target);
            try { await api('/units', { method: 'POST', body: { name: fd.get('name'), kind: fd.get('kind'), parent_id: fd.get('parent_id') || null } }); toast('Enhet skapad', true); route(); }
            catch (ex) { toast(ex.message); }
          } },
            h('label', { class: 'fld' }, h('span', {}, 'Ny enhet'), h('input', { name: 'name', required: '' })),
            h('div', { class: 'grid two' },
              h('label', { class: 'fld' }, h('span', {}, 'Typ'), h('select', { name: 'kind' },
                units.kinds.map(k => h('option', { value: k }, k)))),
              h('label', { class: 'fld' }, h('span', {}, 'Överordnad'), h('select', { name: 'parent_id' },
                h('option', { value: '' }, '— ingen (toppnivå) —'),
                flatUnits.map(u => h('option', { value: u.id }, u.name))))),
            h('button', { class: 'secondary' }, 'Lägg till')) : null),
        h('div', { class: 'card' },
          h('div', { class: 'tech', style: 'margin-bottom:6px' }, 'RISKER'),
          risks.length ? risks.map(r => h('div', { class: 'timeline-item' },
            h('span', { class: 'tag ' + (r.severity === 'high' ? 'high' : r.severity === 'medium' ? 'medium' : 'low') }, r.severity),
            h('div', {}, h('strong', { class: 'small' }, r.title),
              r.description && r.description !== r.title ? h('div', { class: 'muted' }, r.description) : null)))
          : h('div', { class: 'empty' }, 'Inga registrerade risker.'))));
  }

  // ---------- router ----------

  const routes = [
    { re: /^#\/$/, view: dashboardView },
    { re: /^#\/findings$/, view: findingsView },
    { re: /^#\/finding\/(.+)$/, view: m => findingDetailView(m[1]) },
    { re: /^#\/ask$/, view: askView },
    { re: /^#\/liquidity$/, view: liquidityView },
    { re: /^#\/actions$/, view: actionsView },
    { re: /^#\/reports$/, view: reportsView },
    { re: /^#\/alerts$/, view: alertsView },
    { re: /^#\/settings$/, view: settingsView },
    { re: /^#\/governance$/, view: governanceView },
    { re: /^#\/integrations$/, view: integrationsView },
    { re: /^#\/profile$/, view: profileView },
    { re: /^#\/admin$/, view: adminView }
  ];

  async function route() {
    if (!ME) { renderLogin(false); return; }
    const hash = location.hash || '#/';
    for (const r of routes) {
      const m = hash.match(r.re);
      if (m) {
        try {
          shell(h('div', { class: 'boot' }, 'Laddar…'));
          const content = await r.view(m);
          shell(content);
        } catch (e) {
          if (e.message !== '401') shell(h('div', { class: 'error-msg' }, 'Fel: ' + e.message));
        }
        return;
      }
    }
    location.hash = '#/';
  }

  async function boot() {
    try {
      ME = await api('/me');
      if (!location.hash) location.hash = '#/';
    } catch (e) {
      ME = null;
    }
    route();
  }

  window.addEventListener('hashchange', route);
  boot();
})();
