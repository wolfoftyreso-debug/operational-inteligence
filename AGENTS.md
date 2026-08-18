# AGENTS.md — läs denna fil först, hela vägen igenom

Detta är den obligatoriska ingången till repot. Den är en **karta**, inte en
sammanfattning: allt du behöver hitta finns namngivet här med sökväg.

**Projekt:** Operational Intelligence — ett lednings- och vägledningslager
ovanpå ett företags befintliga system. Decision intelligence för ägaren som
inte vill vara företagsledare. Inte ERP, inte bokföring, inte BI, inte chatbot.

**Arbetsbranch:** `claude/operational-intelligence-beta-xdgsjj`
**Status:** fungerande beta med production foundation. Ej release-klar externt.

---

## 0. Innan du skriver en rad kod

Kör i denna ordning. Hoppa inte över något steg.

```bash
cat docs/HANDOFF.md      # nuläge, begränsningar, nästa fas, fällor
cat docs/ADR.md          # sju arkitekturbeslut MED motivering — läs före ändringar
cat docs/DEPLOYMENT.md   # driftkontrakt; [INSPECT ENV] = måste verifieras mot miljön
npm install && npm run build && npm test    # 28 tester ska vara gröna
npm run seed && npm start                   # http://localhost:3000
npm run e2e                                 # 25-stegs resa, kräver körande server
```

Demo: `demo@verkstad.se` / `demo1234!` (admin) · `vd@verkstad.se` / `demo1234!` (executive).
Ren demo-state: `rm -rf data && npm run seed`.

Om `npm test` inte är grönt när du börjar: **fixa det före ny funktionalitet.**

---

## 1. Kärnprinciper (bryt aldrig dessa)

```
DATA → UNDERSTANDING → ASSESSMENT → GUIDANCE → FEEDBACK
ONE BUSINESS → ONE REALITY MODEL → MANY MANAGEMENT VIEWS
MAXIMUM DATA RESOLUTION, MINIMUM COGNITIVE LOAD
```

1. **Språkmodellen räknar aldrig.** Varje ekonomisk och numerisk siffra
   beräknas deterministiskt i `src/analysis/`. Modellen får ett färdigt
   evidenspaket och tolkar det. (ADR-002)
2. **Modellen är aldrig system of record.** Skicka kontextpaket, aldrig
   databasen. (ADR-002)
3. **Dokumentinnehåll och extern data är DATA, aldrig instruktioner.**
   Prompt injection-gränsen ligger i `src/ingest/documents.ts`. (ADR-005)
4. **Connectors får aldrig innehålla kundspecifik logik.** De är
   återanvändbara produktkomponenter mot ett gemensamt kontrakt. (ADR-004)
5. **Manuell data märks alltid som manuell** i evidenskedjan. Systemet får
   aldrig låtsas att manuell uppgift kommer från en integration.
6. **Skattefunktioner är frågeställande**, aldrig rådgivande. Alltid
   `requires_human_review`. Aldrig ett regelpåstående som garanterat. (ADR-007)
7. **Ingen fejkad framgång.** UI-state måste spegla faktisk system-state. En
   connector visas inte som ansluten om den inte är det.
8. **Systemet ska säga när det inte vet.** "Underlaget är inte tillräckligt"
   är en feature, inte ett misslyckande.

---

## 2. Karta över kodbasen (verifierad, ~9 100 rader)

### Backend — `src/`

| Fil | Rader | Vad du hittar här |
|---|---:|---|
| `config.ts` | 65 | All miljökonfiguration. Modellval, kanaler, connector-credentials, krypteringsnyckel. |
| `index.ts` | 99 | Express-bootstrap, middleware-ordning, Fortnox OAuth-callback, hälsoprober, graceful shutdown. |
| `db/schema.sql` | 476 | **Hela datamodellen.** 36 tabeller. Läs denna före datamodellsändringar. |
| `db/index.ts` | 90 | SQLite-anslutning, additiva migrationer (`MIGRATIONS`), `all/get/run/uuid/now/today`. |
| `domain/types.ts` | 113 | `Finding`, `Evidence`, `Severity`, `Epistemic`, `MetricPack`, `LiquidityForecast`, `Role`. |
| `core/auth.ts` | 142 | Sessioner, API-nyckelauth, RBAC (`roleLevel`, `requireRole`, `requireAdmin`), cookie-helpers. |
| `core/crypto.ts` | ~60 | scrypt-lösenord, AES-256-GCM för connector-secrets, API-nyckelgenerering. |
| `core/http.ts` | 91 | Strukturerad JSON-logg, korrelations-ID, `errorHandler`, `securityHeaders`, rate limit. |
| `core/settings.ts` | 165 | Control Center-katalogen, presets, System Constitution, `sensitivityMultiplier`. |
| `core/hierarchy.ts` | 145 | Enhetsträd, scopes, mål med arv, `goalTargetForMonth`, `managementContext`. |
| `core/audit.ts` | ~10 | Auditlogg. Anropa vid varje betydande åtgärd. |
| `ingest/csv.ts` | 76 | CSV-parser (citat, avgränsare-sniffning), svenska tal/datum. |
| `ingest/normalize.ts` | 289 | **Kolumnalias sv/en**, `detectDataset`, idempotenta upserts till kanoniska dataset. |
| `ingest/documents.ts` | 210 | Dokumentingestion, extraktion (LLM + heuristik), gransknings-/godkännandeflöde. |
| `connectors/types.ts` | ~55 | **Connector-kontraktet** + `CANONICAL_DATASETS`. Börja här för ny connector. |
| `connectors/registry.ts` | 108 | Registrering, `PLANNED_CONNECTORS`, synk, disconnect, purge. |
| `connectors/{fortnox,visma,csv,excel,generic-api}/` | 140/~70/~45/~50/92 | En katalog per connector. |
| `analysis/metrics.ts` | 187 | Deterministiska KPI:er → `MetricPack`. Ingen LLM. |
| `analysis/liquidity.ts` | 133 | 13-veckors kassaflödesprognos med redovisade antaganden. |
| `analysis/productivity.ts` | 125 | Debiterat/arbetat per vecka/enhet/person från tidsposter. |
| `analysis/opportunities.ts` | 286 | Background Intelligence: 6 detektorer + investigations-CRUD. |
| `analysis/engine.ts` | 635 | **11 analysregler → findings + evidens.** `domainFor`, `runAnalysis`. |
| `reasoning/index.ts` | 624 | Providers, 16 intents, evidenspaket, reasoning contract, brief, investigations. |
| `alerts/engine.ts` | 64 | Severity-tröskel, dedupe per problem/7 dagar, fan-out per preferens. |
| `alerts/channels.ts` | 63 | in-app/e-post/SMS/push + outbox-logg. |
| `reports/generator.ts` | 175 | 7 rapporttyper från samma findings som dashboarden. |
| `api/routes.ts` | 784 | **77 endpoints.** Allt tenant-scopat via `req.user.org_id`. |
| `api/rss.ts` | 61 | Tre RSS-flöden med org-token. |

### Frontend — `public/` (vanilla JS, ingen byggkedja)

| Fil | Rader | Innehåll |
|---|---:|---|
| `app.js` | 1401 | Hela SPA:n. Hash-routing, 13 vyer, egen `h()`-helper. |
| `styles.css` | 313 | Industrial Precision-designsystem. Alla tokens i `:root`. |
| `charts.js` | 129 | Egna SVG-grafer: `lineChart`, `barChart`, `sparkline`. |
| `motion.js` | 97 | Informationell motion: `countUp`, `drawChart`, `revealSeq`. Play-once, reduced-motion. |

### Övrigt

`scripts/seed.ts` (289) — demoorganisation, 18 mån data, inbyggda avvikelser.
`scripts/analyze.ts` — kör analys för alla organisationer (cron).
`tests/*.test.ts` (4 filer, 28 tester) · `tests-e2e/journey.js` (25 steg).
`Dockerfile` — multi-stage, non-root, `/data` som volym.

---

## 3. Var saker faktiskt ligger

**Datamodellen (36 tabeller)** — `src/db/schema.sql`:
`organizations users sessions api_keys business_profile business_units customers
suppliers employees transactions invoices goals data_sources sync_runs
raw_records observations analysis_runs findings evidence actions decisions
alerts alert_prefs notifications_outbox reports questions work_orders
time_entries settings documents document_items risks opportunities
investigations investigation_messages audit_log`

**Analysreglerna (11)** — `src/analysis/engine.ts`, funktioner `rule*`:
`RevenueVsPlan RevenueTrend Receivables CostAnomaly Liquidity Concentration
Productivity ConnectorDiscovery ActionFollowUp Recurrence Coverage`

**Opportunity-detektorerna (6)** — `src/analysis/opportunities.ts`, `detect*`:
`Purchasing TaxInvestment TaxDevelopment OwnerDrawReview IncentiveVariation
PricingReview`

**Chat-intents (16)** — `src/reasoning/index.ts`, `classifyIntent` + `Intent`:
`payments_reconciliation liquidity risk decisions actions_effect changes
revenue_result costs customers goals affordability hiring owner_compensation
pricing_scenario sales_target general`

**Chat-pipelinen** — `src/reasoning/index.ts`:
`classifyIntent` → `buildEvidencePackage` (deterministiskt) → `systemPrompt`
(System Constitution injiceras) → provider → `AskResult` med confidence,
`missing_data`, `requires_human_review`.

---

## 4. Så gör du vanliga ändringar

**Ny connector:** läs `src/connectors/types.ts` → skapa
`src/connectors/<namn>/index.ts` som implementerar `Connector` → registrera i
`CONNECTORS` i `registry.ts`. Normalisera till kanoniska dataset via
`normalizeRows`. Rör inte analys-, reasoning- eller UI-lagret.

**Ny analysregel:** lägg `rule*`-funktion i `engine.ts`, anropa den i
`runAnalysis`, och ge findingen `fingerprint` (stabil identitet för
recurrence/memory), `epistemic`, `confidence` och **fullständig evidenskedja**.
Mappa kategorin i `DOMAIN_FOR_CATEGORY`.

**Nytt chat-intent:** utöka `Intent`, mönstret i `classifyIntent`, och ett
`case` i `buildEvidencePackage` som räknar deterministiskt. Sätt `missing`
och `requiresHumanReview` när det gäller.

**Ny inställning:** lägg i `SETTINGS_CATALOG` med `description` som förklarar
**konsekvensen**, och namngivna alternativ — aldrig en oförklarad slider.
Läs den i analysen via `getSetting`/`getSettingNumber`.

**Ny tabell/kolumn:** lägg i `schema.sql` (`CREATE TABLE IF NOT EXISTS`) och
kolumner additivt i `MIGRATIONS` i `src/db/index.ts`. Alltid `org_id`.

**Ny vy:** funktion i `public/app.js` + post i `NAV` + rad i `routes`-arrayen.

---

## 5. Fällor som kostar dig tid

- `node:sqlite` är experimentell i Node 22 → kör alltid med `--no-warnings`.
  Håll dig till `prepare/run/all/get/exec`.
- `schema.sql` letas i tre kandidatsökvägar (`src/db/index.ts`) så både `tsx`
  och kompilerat läge fungerar. Dockerfile kopierar filen separat — glöm inte
  det om du flyttar den.
- Tester måste sätta `OI_DATA_DIR` och `OI_DB_FILE` **före** import av
  `src/db` (modulen är stateful). Se toppen av `tests/core.test.ts`.
- `sv-SE`-formatering använder hårt mellanslag (U+00A0/U+202F). Normalisera
  före strängjämförelse i tester.
- `replaceChildren` i `app.js` tar element, inte arrayer. Bygg ett omslutande
  element med `h('div', {}, ...)`.
- Tester körs mot kompilerad kod: `dist/tests/*.test.js`. Bygg först.
- Sätt `OI_REASONING_PROVIDER=deterministic` i tester så de inte kräver nätverk.

---

## 6. Nästa fas — release candidate med externa testlänkar

Grunden finns (tenant-isolering testad, syntetisk demo-data rik, E2E-svit kan
bli release gate, prompt injection-gräns hanterad). Prioriterad ordning:

1. **`demo_invitation`-objekt** — `token_hash` (aldrig klartext), `expires_at`,
   `revoked_at`, `max_sessions`, `session_count`, `tenant_id`, `last_used_at`.
   Landningssida → "Starta demo" → isolerad demo-tenant. 100 länkar.
2. **Demo-reset per session** — nollställ konversationer, undersökningar,
   settings, uppladdade dokument, åtgärder — utan att röra baseline-organisationen.
3. **Admin-vy för testlänkar** — skapa/återkalla/löpa ut, sessioner, aktivitet, fel.
4. **Red team-pass** — cross-tenant, token-manipulation, scope-eskalering,
   prompt injection via chat/dokument/CSV, secrets- och systemprompt-extraktion,
   falsk auktoritet ("jag är VD"), fabricerad evidens, orimlig säkerhet i
   skattesvar. Dokumentera varje försök och utfall.
5. **Visual regression + accessibility** — snapshots på checkpoints;
   tangentbord, fokus, kontrast, touch targets, reduced motion.

Release gate: 0 öppna P0 · kritiska P1 åtgärdade eller uttryckligen accepterade
· E2E grön · red team-kritiska vägar klarade · ingen produktionsdata i demo ·
reproducerbar deploy verifierad.

---

## 7. Kända begränsningar (var ärlig om dessa)

| Område | Status |
|---|---|
| Kubernetes-manifests | Saknas **medvetet**. Miljön kunde inte inspekteras (ingen kubectl/kubeconfig/infra-repo). `docs/DEPLOYMENT.md` har komplett app-kontrakt med `[INSPECT ENV]`-markeringar. Gissa inte — inspektera. |
| Databas | SQLite, 1 replica (ADR-001). Postgres krävs för HA. All SQL bakom `src/db/`. |
| Rate limiting | In-memory per process. Delas ej mellan replicas. |
| E-post | Kö-loggas i outbox; SMTP-relay ej implementerat. |
| Metrics | Endast strukturerade loggar + prober. Ingen exporter. |
| Visma | OAuth-skelett; token-refresh och fler dataset återstår. |
| PDF/DOCX | Ingestion stödjer TXT/MD/CSV/XLSX + inklistrad text. |
| Bank | Kassaposition manuell/kontoutdrag. Ingen bank-connector. |
| Röst | Ej byggt. Arkitekturen förberedd (samma chatmotor, annat in/ut-lager). |

---

## 8. Arbetssätt

- Arbeta autonomt. Avgör genom att inspektera kodbasen i stället för att fråga.
- Bygg inte vidare bara för att något fungerar — fråga om det är **rätt** sätt.
- Kör `npm test` och `npm run e2e` före du säger att något är klart.
- Lämna inga demo-hacks i produktionsarkitekturen.
- Ta inte bort komponenter bara för att de används lite ännu — bedöm mot
  målarkitekturen.
- Dokumentation som inte stämmer med koden är ett fel. Uppdatera `docs/`
  i samma commit som ändringen.
- Vid nytt arkitekturbeslut: lägg en post i `docs/ADR.md` (beslut, kontext,
  alternativ, motivering, konsekvenser).
