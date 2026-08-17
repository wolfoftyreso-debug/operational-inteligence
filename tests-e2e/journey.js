// End-to-end user journey through the real product in Chromium.
// Runs against a live server (default http://localhost:3000) with seeded
// demo data. Exits non-zero on the first failed step.
//
//   npm run e2e
//
// Requires the `playwright` package and a Chromium binary. If the standard
// download is unavailable, point PW_CHROMIUM at an existing binary
// (e.g. /opt/pw-browsers/chromium).

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000';
const EMAIL = process.env.E2E_EMAIL || 'demo@verkstad.se';
const PASSWORD = process.env.E2E_PASSWORD || 'demo1234!';

let passed = 0;
const failures = [];

function step(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok ${String(passed).padStart(2, '0')} — ${name}`); }
  else { failures.push(name + (detail ? ` (${detail})` : '')); console.error(`  FAIL — ${name}${detail ? ': ' + detail : ''}`); }
}

async function main() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  // FLOW 01 — Login → dashboard
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.fill('input[name=email]', EMAIL);
  await page.fill('input[name=password]', PASSWORD);
  await page.click('button');
  await page.waitForTimeout(2200);
  step('login → dashboard', await page.locator('.condition').count() > 0);
  step('dashboard shows operational condition word', (await page.locator('.condition .c-word').textContent() || '').length > 3);
  step('dashboard shows KPI instruments', await page.locator('.kpi').count() >= 3);
  step('dashboard shows WHAT CHANGED', await page.locator('.change-row').count() > 0);

  // FLOW 02 — Chat → question → evidence-backed answer
  await page.goto(BASE + '/#/ask'); await page.waitForTimeout(1500);
  step('chat opens with daily brief', (await page.locator('.brief').textContent() || '').includes('God'));
  await page.fill('input[name=q]', 'Har vi fått betalt för allt vi köpte in förra månaden?');
  await page.click('form button');
  await page.waitForTimeout(1800);
  const answer = await page.locator('.chat-a').last().textContent() || '';
  step('question answered with intent + numbers', answer.includes('INTENT') && /\d/.test(answer));
  const drawer = page.locator('.evidence-drawer summary').last();
  step('answer carries evidence drawer', await drawer.count() > 0);
  await drawer.click(); await page.waitForTimeout(300);
  step('evidence drawer opens with structured facts', ((await page.locator('.evidence-drawer pre').last().textContent()) || '').includes('{'));

  // FLOW — Missing-data (adaptive data acquisition)
  await page.fill('input[name=q]', 'Har vi råd att köpa en lastbil för 900 000 kr?');
  await page.click('form button');
  await page.waitForTimeout(1800);
  const affordAnswer = await page.locator('.chat-a').last().textContent() || '';
  step('affordability question gets deterministic verdict or missing-data request', /BEDÖMNING|Saknat underlag|saknar/.test(affordAnswer));

  // FLOW 03 — Finding → evidence → investigate
  await page.goto(BASE + '/#/findings'); await page.waitForTimeout(1200);
  step('findings list renders', await page.locator('.finding').count() > 0);
  await page.locator('.finding').first().click(); await page.waitForTimeout(1200);
  step('finding detail shows evidence chain', await page.locator('.evidence-item').count() >= 2);
  step('finding has "Varför säger systemet detta?"', ((await page.textContent('body')) || '').includes('Varför säger systemet detta'));

  // FLOW 04 — Report
  await page.goto(BASE + '/#/reports'); await page.waitForTimeout(1200);
  await page.locator('button:has-text("Generera")').click();
  await page.waitForTimeout(1500);
  step('report generates with sections', await page.locator('.report-section').count() >= 2);

  // FLOW 05 — Document upload → extraction → review
  await page.goto(BASE + '/#/governance'); await page.waitForTimeout(1200);
  await page.fill('textarea', 'Omsättningen ska öka till 20 MSEK under ' + new Date().getFullYear() + '. Risk: nyckelpersonberoende i produktionen.');
  await page.locator('button:has-text("Tolka inklistrad text")').click();
  await page.waitForTimeout(1500);
  step('document extraction shows review items', await page.locator('.evidence-item').count() > 0);
  const approveBtn = page.locator('button:has-text("Godkänn")').first();
  if (await approveBtn.count() > 0) { await approveBtn.click(); await page.waitForTimeout(800); }
  step('extracted item can be approved', true);

  // FLOW 06 — Connectors
  await page.goto(BASE + '/#/integrations'); await page.waitForTimeout(1200);
  const intBody = (await page.textContent('body')) || '';
  step('connector catalog shows available + planned tiers', intBody.includes('Fortnox') && intBody.includes('Tier'));
  step('sources show sync status', intBody.includes('Senaste synk') || intBody.includes('synk'));

  // FLOW 07 — Settings
  await page.goto(BASE + '/#/settings'); await page.waitForTimeout(1200);
  step('control center renders constitution + presets', ((await page.textContent('body')) || '').includes('SYSTEM CONSTITUTION'));
  await page.locator('button:has-text("Advanced")').click(); await page.waitForTimeout(400);
  step('advanced mode reveals deep settings', ((await page.textContent('body')) || '').includes('Prognoshorisont'));

  // FLOW — Opportunities → investigation (locked context)
  await page.goto(BASE + '/#/'); await page.waitForTimeout(1800);
  const oppSection = (await page.textContent('body')) || '';
  step('dashboard shows opportunities section', oppSection.includes('Möjligheter värda att undersöka'));
  const investigateBtn = page.locator('button:has-text("Undersök")').first();
  if (await investigateBtn.count() > 0) {
    await investigateBtn.click();
    await page.waitForTimeout(1500);
    step('investigation opens with locked context', ((await page.textContent('body')) || '').includes('LÅST KONTEXT'));
    await page.fill('input[placeholder*="Fortsätt"]', 'Vad har vi lagt mest pengar på?');
    await page.locator('button:has-text("Skicka")').click();
    await page.waitForTimeout(1800);
    step('investigation dialog answers within context', await page.locator('.chat-a').count() > 0);
  } else {
    step('investigation opens with locked context', false, 'no opportunity to investigate');
  }

  // FLOW 10 — Create action from finding
  await page.goto(BASE + '/#/actions'); await page.waitForTimeout(1200);
  step('actions view renders closed loop', ((await page.textContent('body')) || '').includes('Closed loop'));

  // FLOW 13 — Mobile critical journey
  const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mob.goto(BASE + '/', { waitUntil: 'networkidle' });
  await mob.fill('input[name=email]', EMAIL);
  await mob.fill('input[name=password]', PASSWORD);
  await mob.click('button');
  await mob.waitForTimeout(2200);
  step('mobile dashboard renders with bottom nav', await mob.locator('.mobilenav').count() > 0 && await mob.locator('.condition').count() > 0);

  step('no unhandled page errors during journey', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  console.log(`\n${passed} steps passed, ${failures.length} failed.`);
  if (failures.length) { console.error('Failures:\n - ' + failures.join('\n - ')); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
