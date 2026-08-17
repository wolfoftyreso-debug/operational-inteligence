// Seed: demo organisation "Demo Verkstad AB" with 18 months of realistic
// workshop data (with built-in deviations), imported through the CSV
// connector pipeline so the entire vertical slice is exercised:
// data → normalization → analysis → findings → evidence → alerts.

import { getDb, get, all, run, uuid, now, today } from '../src/db';
import { hashPassword, randomToken } from '../src/core/crypto';
import { createDataSource, makeContext } from '../src/connectors/registry';
import { ingestCsvContent } from '../src/connectors/csv';
import { runAnalysis } from '../src/analysis/engine';
import { createUnit, createGoal, breakdownGoal } from '../src/core/hierarchy';
import { ingestDocument, approveItem } from '../src/ingest/documents';

const DEMO_EMAIL = 'demo@verkstad.se';
const DEMO_PASSWORD = 'demo1234!';

function pad(n: number): string { return String(n).padStart(2, '0'); }

function monthsBack(n: number): { y: number; m: number; label: string }[] {
  const out: { y: number; m: number; label: string }[] = [];
  const nowD = new Date();
  for (let i = n; i >= 0; i--) {
    const d = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() - i, 1));
    out.push({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, label: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}` });
  }
  return out;
}

// Deterministic pseudo-random (stable seed data across runs)
let seedState = 42;
function rnd(): number {
  seedState = (seedState * 1103515245 + 12345) % 2147483648;
  return seedState / 2147483648;
}

async function main(): Promise<void> {
  getDb();
  if (get('SELECT id FROM users WHERE email = ?', DEMO_EMAIL)) {
    console.log('Demo-organisationen finns redan. Logga in med:');
    console.log(`  ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
    return;
  }

  const orgId = uuid();
  run('INSERT INTO organizations (id, name, industry, rss_token, created_at) VALUES (?,?,?,?,?)',
    orgId, 'Demo Verkstad AB', 'workshop', randomToken(), now());

  const adminId = uuid();
  run('INSERT INTO users (id, org_id, email, name, role, password_hash, created_at) VALUES (?,?,?,?,?,?,?)',
    adminId, orgId, DEMO_EMAIL, 'Demo Admin', 'admin', hashPassword(DEMO_PASSWORD), now());
  run('INSERT INTO alert_prefs (user_id, channel, min_severity, enabled) VALUES (?,?,?,1)', adminId, 'in_app', 'medium');
  const ceoId = uuid();
  run('INSERT INTO users (id, org_id, email, name, role, password_hash, created_at) VALUES (?,?,?,?,?,?,?)',
    ceoId, orgId, 'vd@verkstad.se', 'Kim VD', 'executive', hashPassword(DEMO_PASSWORD), now());
  run('INSERT INTO alert_prefs (user_id, channel, min_severity, enabled) VALUES (?,?,?,1)', ceoId, 'in_app', 'high');

  // Business profile (manual data)
  const profile: Record<string, string> = {
    employee_count: '14',
    unit_count: '2',
    monthly_revenue_target: '1450000',
    cash_position: '620000',
    liquidity_buffer: '500000',
    monthly_fixed_costs: '210000',
    monthly_payroll: '540000',
    internal_goals: 'Faktureringsgrad över 78 %. Max 5 % återbesök.',
    important_dates: 'Momsinbetalning den 12:e varje månad. Semesterstängt v.29–30.'
  };
  for (const [k, v] of Object.entries(profile)) {
    run('INSERT INTO business_profile (org_id, key, value, updated_at, updated_by) VALUES (?,?,?,?,?)', orgId, k, v, now(), adminId);
  }

  run('INSERT INTO observations (id, org_id, user_id, date, category, text, created_at) VALUES (?,?,?,?,?,?,?)',
    uuid(), orgId, adminId, today(), 'personal', 'En erfaren tekniker på Verkstad Syd slutar i slutet av nästa månad.', now());

  // Organizational structure (lasagne layer 2): company → facilities → departments.
  const companyUnit = createUnit(orgId, 'Demo Verkstad AB', 'company', null);
  const nordId = createUnit(orgId, 'Verkstad Nord', 'facility', companyUnit);
  const sydId = createUnit(orgId, 'Verkstad Syd', 'facility', companyUnit);
  createUnit(orgId, 'Reservdelar', 'department', nordId);
  createUnit(orgId, 'Kundmottagning', 'department', sydId);
  run('UPDATE users SET unit_id = NULL, responsibilities = ? WHERE id = ?', 'Hela verksamheten: resultat, likviditet, strategi.', ceoId);

  // Governance layer: annual revenue goal, broken down to monthly targets.
  const year = new Date().getFullYear();
  const annualGoal = createGoal(orgId, {
    label: `Omsättning ${year}`, metric: 'revenue', target_value: 17400000,
    period: 'yearly', period_start: `${year}-01-01`, period_end: `${year}-12-31`,
    owner: 'Kim VD', source: 'manual'
  });
  breakdownGoal(orgId, annualGoal);

  // Governing document through the extraction pipeline (reviewed & approved).
  const planText = [
    `Verksamhetsplan ${year} — Demo Verkstad AB`,
    `Marginalen ska öka till 12 % under ${year}.`,
    'Kundnöjdheten ska överstiga 90 %.',
    'Risk: Beroendet av två stora företagskunder är en väsentlig risk för kassaflödet.',
    'Risk: Kompetensbrist på erfarna tekniker riskerar att begränsa kapaciteten.',
    'Ledningen beslutade att införa månatlig genomgång av faktureringsgraden per anläggning.',
    'Åtgärd: Ta fram bemanningsplan för hösten. Ansvarig: Maria Sjö.'
  ].join('\n');
  const doc = await ingestDocument(orgId, adminId, { filename: `verksamhetsplan-${year}.txt`, kind: 'verksamhetsplan', content: planText });
  for (const item of all<{ id: string }>('SELECT id FROM document_items WHERE document_id = ?', doc.documentId)) {
    approveItem(orgId, item.id, adminId);
  }
  console.log('Styrande dokument tolkat:', JSON.stringify(doc.counts));

  // Data source: CSV connector (the real ingest pipeline)
  const src = createDataSource(orgId, 'csv', 'Ekonomiexport', {});
  const ctx = makeContext(src);

  // --- Generate 18 months of transactions ---
  const months = monthsBack(18);
  const units = ['Verkstad Nord', 'Verkstad Syd'];
  const txLines: string[] = ['id;datum;beskrivning;belopp;typ;kategori;enhet'];
  let txId = 1000;

  for (const mo of months) {
    const idx = months.indexOf(mo);
    const isLast = idx >= months.length - 2; // senaste ~2 månaderna: inbyggd dipp i Syd
    const season = 1 + 0.12 * Math.sin((mo.m - 3) / 12 * 2 * Math.PI); // vår/höst starkare
    for (const unit of units) {
      const base = unit === 'Verkstad Nord' ? 780000 : 700000;
      let monthRev = base * season * (0.92 + rnd() * 0.16);
      if (isLast && unit === 'Verkstad Syd') monthRev *= 0.60; // avvikelsen som analysen ska hitta
      // 8-14 revenue posts per unit/month
      const posts = 8 + Math.floor(rnd() * 7);
      for (let p = 0; p < posts; p++) {
        const day = 1 + Math.floor(rnd() * 27);
        const amount = Math.round(monthRev / posts * (0.7 + rnd() * 0.6));
        txLines.push(`${txId++};${mo.label}-${pad(day)};Arbetsorder ${3000 + txId};${amount};intäkt;arbetsorder;${unit}`);
      }
    }
    // Costs
    const costCats: [string, number][] = [
      ['reservdelar', 310000 * season],
      ['löner', 540000],
      ['lokalhyra', 95000],
      ['el och drift', 38000 * (mo.m <= 2 || mo.m === 12 ? 1.5 : 1)],
      ['verktyg och förbrukning', 42000],
      ['övrigt', 30000]
    ];
    for (const [cat, base] of costCats) {
      let amount = base * (0.9 + rnd() * 0.2);
      // Built-in anomaly: verktyg spikes the last complete month
      if (cat === 'verktyg och förbrukning' && idx === months.length - 2) amount *= 1.9;
      const day = cat === 'löner' ? 25 : 1 + Math.floor(rnd() * 27);
      txLines.push(`${txId++};${mo.label}-${pad(day)};${cat};${Math.round(amount)};kostnad;${cat};`);
    }
  }

  // Single large investment + development costs → the tax opportunity
  // detectors get something real to be curious about.
  const twoMonthsAgo = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  txLines.push(`${txId++};${twoMonthsAgo};Fyrhjulsinställare ny maskin;620000;kostnad;investeringar;Verkstad Nord`);
  txLines.push(`${txId++};${twoMonthsAgo};Utveckling internt planeringssystem;340000;kostnad;utveckling;`);

  const txResult = ingestCsvContent(ctx, { filename: 'transaktioner.csv', content: txLines.join('\n'), dataset: 'transactions' });
  console.log('Transaktioner importerade:', JSON.stringify(txResult.datasets));

  // --- Customer invoices (receivables with overdue concentration) ---
  const customers = ['Åkeri Nordfrakt AB', 'Byggarna i Stan AB', 'Kommunens Fordonsenhet', 'Taxi Direkt', 'Privatkunder (samlade)', 'Maskinuthyrning Öst AB'];
  const invLines: string[] = ['fakturanummer;kund;fakturadatum;förfallodatum;belopp;saldo;betaldatum;status'];
  let invNo = 5000;
  const nowD = new Date();

  // Paid history (for DSO): last 6 months
  for (let i = 0; i < 60; i++) {
    const daysAgo = 20 + Math.floor(rnd() * 160);
    const issue = new Date(nowD.getTime() - daysAgo * 86400000);
    const due = new Date(issue.getTime() + 30 * 86400000);
    const paid = new Date(due.getTime() + Math.floor(rnd() * 12) * 86400000);
    const cust = customers[Math.floor(rnd() * customers.length)];
    const amount = Math.round(15000 + rnd() * 120000);
    invLines.push(`${invNo++};${cust};${issue.toISOString().slice(0, 10)};${due.toISOString().slice(0, 10)};${amount};0;${paid.toISOString().slice(0, 10)};betald`);
  }
  // Open invoices, several overdue — concentrated on two customers
  const openSpec: [string, number, number][] = [
    // [customer, amount, daysOverdue (negative = not yet due)]
    ['Åkeri Nordfrakt AB', 185000, 34],
    ['Åkeri Nordfrakt AB', 96000, 18],
    ['Byggarna i Stan AB', 142000, 41],
    ['Byggarna i Stan AB', 58000, 9],
    ['Kommunens Fordonsenhet', 210000, -12],
    ['Taxi Direkt', 33000, 5],
    ['Maskinuthyrning Öst AB', 76000, -20],
    ['Privatkunder (samlade)', 24000, -5]
  ];
  for (const [cust, amount, overdueDays] of openSpec) {
    const due = new Date(nowD.getTime() - overdueDays * 86400000);
    const issue = new Date(due.getTime() - 30 * 86400000);
    invLines.push(`${invNo++};${cust};${issue.toISOString().slice(0, 10)};${due.toISOString().slice(0, 10)};${amount};${amount};;öppen`);
  }
  const invResult = ingestCsvContent(ctx, { filename: 'kundfakturor.csv', content: invLines.join('\n'), dataset: 'invoices_customer' });
  console.log('Kundfakturor importerade:', JSON.stringify(invResult.datasets));

  // --- Supplier invoices ---
  const suppliers = ['Bildelsgrossisten AB', 'Verktygshuset', 'Fastighets AB Lokalen', 'Energibolaget'];
  const supLines: string[] = ['fakturanummer;leverantör;fakturadatum;förfallodatum;belopp;saldo;status'];
  const supSpec: [string, number, number][] = [
    ['Bildelsgrossisten AB', 168000, -8],
    ['Bildelsgrossisten AB', 92000, -22],
    ['Verktygshuset', 84000, -15],
    ['Fastighets AB Lokalen', 95000, -10],
    ['Energibolaget', 41000, -18]
  ];
  let supNo = 9000;
  for (const [sup, amount, dueIn] of supSpec) {
    const due = new Date(nowD.getTime() - dueIn * 86400000);
    const issue = new Date(due.getTime() - 30 * 86400000);
    supLines.push(`${supNo++};${sup};${issue.toISOString().slice(0, 10)};${due.toISOString().slice(0, 10)};${amount};${amount};öppen`);
  }
  const supResult = ingestCsvContent(ctx, { filename: 'leverantorsfakturor.csv', content: supLines.join('\n'), dataset: 'invoices_supplier' });
  console.log('Leverantörsfakturor importerade:', JSON.stringify(supResult.datasets));

  // --- Employees ---
  const empLines = ['namn;roll;enhet',
    'Anna Berg;Verkstadschef;Verkstad Nord', 'Johan Ek;Tekniker;Verkstad Nord', 'Sara Lind;Tekniker;Verkstad Nord',
    'Omar Haddad;Tekniker;Verkstad Nord', 'Elin Norén;Kundmottagare;Verkstad Nord', 'Peter Ståhl;Tekniker;Verkstad Nord',
    'Maria Sjö;Verkstadschef;Verkstad Syd', 'Lukas Vall;Tekniker;Verkstad Syd', 'Nina Falk;Tekniker;Verkstad Syd',
    'Ali Rezai;Tekniker;Verkstad Syd', 'Karin Modig;Kundmottagare;Verkstad Syd', 'Erik Brand;Tekniker;Verkstad Syd',
    'Lisa Palm;Ekonomi;', 'Demo Admin;VD;'];
  ingestCsvContent(ctx, { filename: 'personal.csv', content: empLines.join('\n'), dataset: 'employees' });

  // --- Time entries: person × day granularity (Maximum Data Resolution) ---
  // Built-in decision-intelligence case: the last 3 weeks, two technicians at
  // Verkstad Syd bill fewer hours per worked hour while worked hours stay
  // normal → the productivity rule should find, concentrate and explain it.
  const techs: [string, string][] = [
    ['Johan Ek', 'Verkstad Nord'], ['Sara Lind', 'Verkstad Nord'], ['Omar Haddad', 'Verkstad Nord'], ['Peter Ståhl', 'Verkstad Nord'],
    ['Lukas Vall', 'Verkstad Syd'], ['Nina Falk', 'Verkstad Syd'], ['Ali Rezai', 'Verkstad Syd'], ['Erik Brand', 'Verkstad Syd']
  ];
  const dippers = new Set(['Lukas Vall', 'Nina Falk']);
  const teLines: string[] = ['id;datum;tekniker;enhet;arbetsorder;arbetade timmar;debiterade timmar'];
  const woLines: string[] = ['arbetsorder;beskrivning;kategori;status;kund;öppnad;stängd;enhet'];
  let teId = 50000; let woNum = 7000;
  const dayMs = 86400000;
  for (let back = 70; back >= 1; back--) {
    const d = new Date(Date.now() - back * dayMs);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // weekdays only
    const dateStr = d.toISOString().slice(0, 10);
    const isRecent = back <= 21;
    for (const [tech, unit] of techs) {
      const worked = Math.round((7.2 + rnd() * 1.2) * 10) / 10;
      let ratio = 0.74 + rnd() * 0.10;
      if (isRecent && dippers.has(tech)) ratio = 0.52 + rnd() * 0.08;
      const billed = Math.round(worked * ratio * 10) / 10;
      const wo = `AO-${7000 + Math.floor(rnd() * 300)}`;
      teLines.push(`${teId++};${dateStr};${tech};${unit};${wo};${String(worked).replace('.', ',')};${String(billed).replace('.', ',')}`);
    }
    if (rnd() < 0.5) {
      const unit = rnd() < 0.5 ? 'Verkstad Nord' : 'Verkstad Syd';
      const cust = customers[Math.floor(rnd() * customers.length)];
      const closed = back > 8 ? new Date(d.getTime() + (2 + Math.floor(rnd() * 5)) * dayMs).toISOString().slice(0, 10) : '';
      woLines.push(`AO-${woNum++};Service och reparation;service;${closed ? 'klar' : 'öppen'};${cust};${dateStr};${closed};${unit}`);
    }
  }
  const teResult = ingestCsvContent(ctx, { filename: 'tidsposter.csv', content: teLines.join('\n'), dataset: 'time_entries' });
  console.log('Tidsposter importerade:', JSON.stringify(teResult.datasets));
  const woResult = ingestCsvContent(ctx, { filename: 'arbetsorder.csv', content: woLines.join('\n'), dataset: 'work_orders' });
  console.log('Arbetsorder importerade:', JSON.stringify(woResult.datasets));

  run("UPDATE data_sources SET last_sync_at = ?, last_sync_status = 'ok', status = 'connected' WHERE id = ?", now(), src.id);

  // A previous decision + completed action to exercise the memory/feedback loop
  run('INSERT INTO decisions (id, org_id, title, rationale, owner, decided_at, expected_result, status) VALUES (?,?,?,?,?,?,?,?)',
    uuid(), orgId, 'Införa veckovis genomgång av förfallna fordringar', 'Kundfordringarna har vuxit under kvartalet.', 'Kim VD',
    new Date(Date.now() - 45 * 86400000).toISOString(), 'Förfallna fordringar under 200 tkr inom två månader', 'active');
  run(`INSERT INTO actions (id, org_id, title, owner, priority, due_date, expected_effect, status, created_at, completed_at, effect_verified)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    uuid(), orgId, 'Ringa de fem största förfallna kunderna', 'Lisa Palm', 'high',
    new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10),
    'Minskad förfallen fordringsstock', 'done',
    new Date(Date.now() - 30 * 86400000).toISOString(), new Date(Date.now() - 20 * 86400000).toISOString(), 'pending');

  // Run the full analysis (deterministic; narrative provider optional)
  const result = await runAnalysis(orgId);
  console.log('');
  console.log('Analys klar:', result.overallStatus, '—', result.summary);
  console.log('Aktiva findings:', result.activeFindings.length, '| Nya:', result.newFindings.length);
  console.log('');
  console.log('Demo-inloggning:');
  console.log(`  Admin: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`  VD:    vd@verkstad.se / ${DEMO_PASSWORD}`);
}

main().catch(e => { console.error(e); process.exit(1); });
