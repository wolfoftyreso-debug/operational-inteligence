# Handoff — Operational Intelligence

Skriven vid slutet av hardening-fasen. Syftet är att nästa utvecklarsession ska
kunna fortsätta utan att läsa någon chatthistorik.

**Branch:** `claude/operational-intelligence-beta-xdgsjj`
**Senaste commit vid handoff:** `b680f0e`
**Status:** fungerande beta med production foundation. Inte release-klar för
externa användare (se "Nästa fas").

---

## Kom igång på 30 sekunder

```bash
npm install
npm run build
npm run seed     # demoorganisation "Demo Verkstad AB", 18 mån syntetisk data
npm start        # http://localhost:3000
```

Demo-inloggning: `demo@verkstad.se` / `demo1234!` (admin),
`vd@verkstad.se` / `demo1234!` (executive).

```bash
npm test         # 28 enhets-/integrationstester
npm run e2e      # 25-stegs E2E-resa i Chromium mot körande server
                 # PW_CHROMIUM=/opt/pw-browsers/chromium om standarddownload saknas
```

Radera `data/` och kör `npm run seed` igen för ren demo-state.

---

## Vad som faktiskt fungerar (verifierat)

Hela kedjan **data → normalisering → analys → finding → evidens → dashboard →
alert** går igenom på riktigt, plus:

- **Connectors**: CSV, Excel, Generic REST fullt fungerande. Fortnox har
  komplett OAuth2-flöde men kräver `FORTNOX_CLIENT_ID/SECRET`. Visma är
  skelett med samma kontrakt. Planerade (Hogia, Björn Lundén, Fieldly,
  Bygglet, Winassist) visas som Tier 2/3 i UI:t — inga fejkade integrationer.
- **Analysmotor**: 11 deterministiska regler. Ekonomi räknas alltid av kod,
  aldrig av modellen. Säsongsmedveten trendregel. Confidence från datatäckning.
- **Reasoning**: modellagnostiskt. Utan `ANTHROPIC_API_KEY` körs deterministisk
  kompositör — allt fungerar, inklusive tester.
- **Chat**: 16 intents med reasoning contract (confidence-tier, saknat underlag,
  krav på mänsklig granskning för skatt/ägare). Evidenspaket beräknas
  deterministiskt före modellanropet.
- **Background Intelligence**: 6 opportunity-detektorer, investigations med
  låst kontext, avvisade möjligheter lärs som preferens.
- **Styrning**: enhetshierarki med scopes, mål med arv (årsmål → månadsmål),
  dokumentextraktion med gransknings-/godkännandeflöde.
- **Control Center**: settings-katalog med konsekvensbeskrivna alternativ,
  System Constitution som injiceras i prompten, presets, org- + användarnivå.
- **Drift**: produktivitet per vecka/enhet/person från tidsposter på
  person × dag-nivå.

---

## Arkitektur i korthet

```
src/
  config.ts        Miljökonfiguration (modell, kanaler, connector-credentials)
  db/              node:sqlite + schema.sql + additiva migrationer
  core/            auth (RBAC), crypto (scrypt + AES-256-GCM), settings,
                   hierarchy, audit, http (logg/fel/rate limit)
  domain/types.ts  Finding, Evidence, Severity, Epistemic, MetricPack…
  ingest/          csv-parser, normalize (kolumnalias sv/en), documents
  connectors/      types.ts (kontraktet) + registry.ts + en katalog per connector
  analysis/        metrics, liquidity, productivity, opportunities, engine
  reasoning/       providers, intents, evidenspaket, investigations, brief
  alerts/          engine (severity + dedupe) + channels (in-app/e-post/SMS/push)
  reports/         generator (7 rapporttyper)
  api/             routes.ts (REST /api/v1) + rss.ts
public/            SPA i vanilla JS: app.js, charts.js, motion.js, styles.css
```

Läs `docs/ADR.md` innan större arkitekturändringar — sju beslut med motivering.
De viktigaste invarianterna:

1. **Modellen räknar aldrig.** Alla siffror kommer från `src/analysis/`.
2. **Modellen är aldrig system of record.** Den får ett kontextpaket, inte databasen.
3. **Dokumentinnehåll är data, aldrig instruktioner** (prompt injection-gräns).
4. **Connectors får aldrig innehålla kundspecifik logik** — de är produktkomponenter.
5. **Manuell data märks alltid som manuell** i evidenskedjan.
6. **Skattefunktioner är frågeställande**, alltid flaggade för mänsklig granskning.

---

## Kända begränsningar

| Område | Status |
|---|---|
| Kubernetes-manifests | Saknas medvetet. Miljön kunde inte inspekteras (ingen kubectl/kubeconfig/infra-repo). `docs/DEPLOYMENT.md` har komplett app-kontrakt med `[INSPECT ENV]`-markeringar. |
| Databas | SQLite, 1 replica (ADR-001). Postgres krävs för HA. All SQL ligger bakom `src/db/`. |
| Rate limiting | In-memory, per process. Delas inte mellan replicas. |
| E-post | Kö-loggas i outbox; SMTP-relay ej implementerat. SMS/push går via webhook. |
| Metrics | Endast strukturerade loggar + prober. Ingen exporter. |
| Visma | OAuth-skelett; token-refresh och fler dataset återstår. |
| PDF/DOCX | Dokumentingestion stödjer TXT/MD/CSV/XLSX + inklistrad text. |
| Bank | Kassaposition anges manuellt eller via kontoutdrag. Ingen bank-connector. |
| Röst | Ej byggt. Arkitekturen är förberedd (samma chatmotor, annat in/ut-lager). |

---

## Nästa fas: release candidate + externa testlänkar

Byggordern för detta finns i projektets historik. Grunden är på plats
(tenant-isolering testad, syntetisk demo-data rik, E2E-svit kan bli release
gate, prompt injection-gräns hanterad). Det som återstår, i den ordning jag
skulle ta det:

1. **`demo_invitation`-objektet** — id, `token_hash` (aldrig klartext),
   `expires_at`, `revoked_at`, `max_sessions`, `session_count`, `tenant_id`,
   `last_used_at`, status. Landningssida → "Starta demo" → isolerad demo-tenant.
2. **Demo-reset per session** — nollställ konversationer, undersökningar,
   settings, uppladdade dokument och åtgärder utan att röra baseline-organisationen.
3. **Admin-vy för testlänkar** — skapa/återkalla/löpa ut, sessioner, senaste
   aktivitet, fel, misstänkt aktivitet.
4. **Red team-pass** — cross-tenant-försök, token-manipulation, scope-eskalering,
   prompt injection via chat/dokument/CSV, försök att extrahera secrets eller
   systemprompt, falsk auktoritet ("jag är VD"), fabricerad evidens, orimlig
   säkerhet i skattesvar. Dokumentera varje försök och utfall.
5. **Visual regression + accessibility-pass** — snapshots på definierade
   checkpoints; tangentbordsnavigering, fokus, kontrast, touch targets,
   reduced motion.

Release gate: 0 öppna P0, kritiska P1 åtgärdade eller uttryckligen accepterade,
E2E grön, red team-kritiska vägar klarade, ingen produktionsdata i demo,
reproducerbar deploy verifierad.

---

## Fällor att undvika

- `node:sqlite` är experimentell i Node 22 — kör med `--no-warnings` och håll
  API-ytan minimal (`prepare/run/all/get/exec`).
- Skema-sökvägen letas i tre kandidatplatser (`src/db/index.ts`) så att både
  `tsx`-dev och kompilerat läge fungerar. Dockerfile kopierar därför
  `src/db/schema.sql` separat.
- Tester sätter `OI_DATA_DIR`/`OI_DB_FILE` till en temp-katalog **före** import
  av `src/db` — modulen är stateful.
- `sv-SE`-formatering använder hårt mellanslag (U+00A0/U+202F). Normalisera
  innan strängjämförelse i tester.
- Frontend är vanilla JS med en egen `h()`-helper. `replaceChildren` tar
  element, inte arrayer — bygg ett omslutande element i stället.
