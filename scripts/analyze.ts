// CLI: re-run the analysis for all organizations (e.g. from cron).

import { getDb, all } from '../src/db';
import { runAnalysis } from '../src/analysis/engine';

async function main(): Promise<void> {
  getDb();
  const orgs = all<{ id: string; name: string }>('SELECT id, name FROM organizations');
  for (const org of orgs) {
    const r = await runAnalysis(org.id);
    console.log(`${org.name}: ${r.overallStatus} — ${r.summary}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
