# Operational Intelligence — beta

Ett intelligent lednings- och vägledningslager ovanpå verksamhetens befintliga system.

> **System of understanding & system of guidance — inte system of record.**
> Fortnox fortsätter vara Fortnox. Visma fortsätter vara Visma. Det här systemet samlar in, normaliserar, analyserar, bedömer, rekommenderar och följer upp.

Kärnprinciper genom hela kodbasen:

```
DATA → UNDERSTANDING → ASSESSMENT → GUIDANCE → FEEDBACK
ONE BUSINESS → ONE REALITY MODEL → MANY MANAGEMENT VIEWS
```

## Arkitekturprinciper (tillägg v0.2)

**Organizational Context Graph.** Enhetshierarki (company → business unit →
facility → department → team) med scopes per användare, mål som förstklassiga
styrobjekt med arv (årsmål → månadsmål via nedbrytning), och styrande dokument
som källa. Analysen mäter verkligheten mot avsikten: omsättningsregeln hämtar
plan från aktivt mål i målgrafen (källan redovisas i evidensen), med
verksamhetsprofilen som fallback.

**Styrande dokument.** Verksamhetsplan/ledningsgenomgång/budget laddas upp
(TXT/MD/CSV/XLSX eller inklistrad text). Systemet extraherar mål, KPI:er,
risker, beslut och åtgärder — LLM när konfigurerad, deterministisk heuristik
annars — och **inget blir styrande utan granskning och godkännande**.

**Opinionated Defaults, Deep Control.** Kontrollcenter med kategorierna
General / Intelligence / Guidance / Reports / Tone / Notifications samt
**System Constitution** (primary objective, risk tolerance, management style,
alert philosophy, reporting philosophy) som injiceras i reasoning-prompten.
Varje inställning förklarar sin konsekvens i ord (Conservative/Balanced/More
sensitive — aldrig en oförklarad slider). Presets (Recommended, Executive,
Operational, Financial, Compliance-nära, Full Intelligence), Simple/Advanced-
läge, org-defaults + användar-overrides (unit/roll-nivå förberedd i modellen),
suppressionspolicy ("ignorera variationer under X %", tysta kategorier) som
faktiskt styr analys- och alertmotorn. Alla ändringar auditloggas.

**Chat-pipeline med sanningsmodell.** "Fråga verksamheten" är ett
huvudgränssnitt: fråga → intentklassificering → entitets-/datahämtning →
deterministiska beräkningar → evidenspaket → språkmodell (eller deterministisk
kompositör) → svar med evidenslåda. Chatten, dashboarden, rapporterna och
alerts är olika presentationer av samma underliggande verklighetsmodell.
Morgonbriefen landar i chatten ("God morgon. N saker förtjänar din
uppmärksamhet.").

**Industrial Precision + informationell motion.** Ljust, neutralt till 90–95 %,
färg med semantisk vikt, monospace för tekniska etiketter (LIVE, SYNCED,
CONFIDENCE, N SOURCES), hairlines i stället för dekor. Motion är funktionell:
KPI:er räknas upp (~650 ms), grafer ritas in (~850 ms), findings materialiseras
sekventiellt vid första viewport-kontakt (IntersectionObserver, play-once,
`prefers-reduced-motion` respekteras). Det ska kännas som att systemet redan
har gjort jobbet och avslöjar resultatet — aldrig som en presentation.

## Kom igång

Krav: Node.js ≥ 22.5 (använder inbyggda `node:sqlite` — inga native-beroenden).

```bash
npm install
npm run build
npm run seed      # skapar demoorganisationen "Demo Verkstad AB" med 18 mån data
npm start         # http://localhost:3000
```

Demo-inloggning efter seed:

| Roll | E-post | Lösenord |
|---|---|---|
| Administratör | `demo@verkstad.se` | `demo1234!` |
| VD/Executive | `vd@verkstad.se` | `demo1234!` |

Utan seed: registrera en ny organisation direkt i inloggningsvyn.

```bash
npm test          # bygger + kör testsviten (vertikala slicen end-to-end)
npm run analyze   # kör om analysen för alla organisationer (t.ex. från cron)
npm run dev       # utvecklingsläge via tsx
```

## Arkitektur

```
src/
  config.ts              Miljökonfiguration (modell, kanaler, connector-credentials)
  db/                    node:sqlite + schema (normaliserad intern datamodell)
  core/                  Auth (sessioner, RBAC), kryptering (scrypt, AES-256-GCM), audit
  domain/                Domäntyper: Finding, Evidence, Severity, Epistemic, MetricPack…
  ingest/                CSV-parser, kolumnalias (sv/en), normalisering → kanoniska dataset
  connectors/            Connector-first: fortnox/ visma/ csv/ excel/ generic-api/ + registry
  analysis/
    metrics.ts           Deterministiska KPI-beräkningar (aldrig LLM)
    liquidity.ts         13-veckors kassaflödesprognos
    engine.ts            Regelmotor → findings + evidenskedjor + memory + effektuppföljning
  reasoning/             Modellagnostiskt lager: Anthropic-provider + deterministisk fallback,
                         "Fråga verksamheten"
  alerts/                Alert-motor (severity-trösklar, dedupe) + kanaladaptrar (in-app,
                         e-post, SMS, push) med outbox-logg
  reports/               Rapportgenerator (Daily Brief … Custom Analysis) från samma findings
  api/                   REST-API (/api/v1) + RSS-flöden
public/                  Responsiv SPA (vanilla JS, egna SVG-grafer) — situationsrum, inte ERP
scripts/seed.ts          Demoverkstad med inbyggda avvikelser genom hela pipelinen
tests/                   node:test-svit för hela vertikala slicen
```

### Dataflödet (vertikala slicen)

1. **DATA** — connectors hämtar/tar emot rådata; allt sparas i `raw_records` (proveniens).
2. **UNDERSTANDING** — `ingest/normalize.ts` mappar svenska/engelska kolumnnamn till den
   kanoniska modellen (transaktioner, fakturor, kunder, leverantörer, personal, enheter).
   Idempotenta upserts på `(org, källa, externt id)`.
3. **ASSESSMENT** — `analysis/engine.ts` kör deterministiska regler över `MetricPack`:
   omsättning mot plan/trend, kostnadsavvikelser per kategori, förfallna kundfordringar/DSO,
   likviditetsrisk, kundkoncentration, återkommande problem, åtgärder utan effekt — och
   säger uttryckligen till när läget är **stabilt** eller när underlaget är **otillräckligt**.
4. **GUIDANCE** — strukturerade findings (severity, kategori, epistemisk status, confidence,
   rekommendation, förväntad effekt) renderas som dashboard, rapport, alert, API och RSS.
5. **FEEDBACK** — beslut och åtgärder loggas; analysen verifierar om genomförda åtgärder
   gav förväntad effekt (`effective`/`ineffective`) och flaggar när effekt uteblir.

### Evidence / proveniens

Varje viktig finding bär en evidenskedja ("Varför säger systemet detta?"):

- **FACT** — direkt belagt, med källetikett (t.ex. `Fortnox`, `CSV-import`, `Manuell uppgift`).
- **DERIVED** — härlett värde med beräkningsbeskrivning och underliggande datapunkter.
- Epistemisk status på hela findingen: `fact | derived | inference | forecast | recommendation`.
- Confidence sätts utifrån datatäckning (historikmånader, datapunkter, källor).

Manuell data (verksamhetsprofilen) märks **alltid** som "Manuell uppgift" — systemet låtsas
aldrig att den kommer från en integration.

### Reasoning engine — modellagnostisk

Kärnan är aldrig hårdkodad mot ett modellnamn. Provider och modell väljs i miljön:

```bash
ANTHROPIC_API_KEY=sk-ant-…        # aktiverar Anthropic-providern
OI_REASONING_MODEL=claude-fable-5 # valfri modell (default, byts fritt)
OI_REASONING_PROVIDER=anthropic   # eller "deterministic"
```

Utan nyckel körs en deterministisk kompositör — alla siffror, findings, evidens och alerts
fungerar identiskt, eftersom **alla ekonomiska beräkningar görs av kod, aldrig av modellen**.
Modellen tolkar och formulerar; den räknar inte.

### Connectors

Varje connector implementerar samma kontrakt (`src/connectors/types.ts`): auth, status,
hämtning, synk, normalisering, felhantering, senaste synk, tillgängliga dataset.

| Connector | Auth | Status i betan |
|---|---|---|
| Fortnox | OAuth2 | Komplett flöde (authorize/token/refresh, fakturor); aktiveras med `FORTNOX_CLIENT_ID/SECRET` |
| Visma eAccounting | OAuth2 | Skelett med samma kontrakt; aktiveras med `VISMA_CLIENT_ID/SECRET` |
| CSV | fil | Komplett — automatisk kolumn- och datasetdetektering |
| Excel (.xlsx) | fil | Komplett — varje blad normaliseras |
| Generic REST API | konfig | Komplett — bas-URL, auth (bearer/basic/header), fältmappning |

Nya connectors registreras i `src/connectors/registry.ts` utan att kärnan byggs om —
adapter-flywheel: en kunds nya system blir en återanvändbar produktkomponent.

### Säkerhet

- Tenant-isolation: varje fråga scopas på `org_id` från sessionen.
- Roller: technician → team/department/facility manager → executive; admin för inställningar.
  Lägre roller ser ett fokuserat urval (severity-filtrering).
- Lösenord: scrypt. Connector-secrets: AES-256-GCM at rest, exponeras aldrig mot frontend.
- API-nycklar: hashas (SHA-256), visas en gång, kan återkallas.
- Auditlogg på inloggningar, konfigändringar, synk, export, radering.
- Bortkoppling av integration raderar credentials omedelbart; full dataradering per källa
  eller hela organisationen (`DELETE /api/v1/org/data`).

### API & RSS

```
GET  /api/v1/status | /findings | /findings/:id | /alerts | /kpis | /metrics
GET  /api/v1/reports | /reports/:id | /forecasts/liquidity | /actions | /decisions | /observations
POST /api/v1/ask | /analyze | /reports | /actions | /decisions
Auth: sessionscookie eller  Authorization: Bearer <api-nyckel>
```

RSS (token per organisation, visas under Administration):

```
/rss/alerts?token=…   /rss/findings?token=…   /rss/management?token=…
```

### Notifieringskanaler

Alert-motorn skickar endast när något faktiskt kräver uppmärksamhet (severity-tröskel +
dedupe per problem/7 dagar). Preferenser per användare, kanal och severity. Leverans per
kanal aktiveras via miljön; alla försök loggas i outboxen:

```bash
OI_SMS_WEBHOOK_URL=…    # POST {to, body}
OI_PUSH_WEBHOOK_URL=…   # POST {user, title, body}
OI_SMTP_URL=…           # e-postrelay
```

### Övriga miljövariabler

```bash
PORT=3000
OI_BASE_URL=https://oi.example.com   # krävs för OAuth-callbacks
OI_DATA_DIR=./data                   # SQLite + genererad krypteringsnyckel
OI_SECRET_KEY=…                      # egen masternyckel (annars genereras och sparas 0600)
```

## Beta-acceptanskriterier → var i systemet

| # | Kriterium | Var |
|---|---|---|
| 1–2 | Skapa organisation/användare | Registrering + Administration |
| 3 | Grundläggande verksamhetsinfo | Verksamhetsprofil (manuell data, märkt som sådan) |
| 4 | Mata in/importera data | CSV/Excel-upload, manuella observationer |
| 5 | Ansluta extern datakälla | Fortnox OAuth (med API-uppgifter), Generic REST |
| 6 | Se normaliserad data | Dashboard/metrics-API från kanoniska modellen |
| 7 | Automatisk verksamhetsbedömning | "Kör ny analys" → status + ledningsbedömning |
| 8–9 | Findings + evidens | Observationer → "Varför säger systemet detta?" |
| 10 | Grafer | Omsättning/kostnader, resultat, likviditetskurva (egen SVG) |
| 11 | Fråga verksamheten | Egen vy, svar med evidens och modelletikett |
| 12 | Management report | Rapporter (7 typer inkl. Custom Analysis) |
| 13–14 | Skapa/följa åtgärd | Åtgärder & beslut + effektverifiering i analysen |
| 15 | Få alert | Alert-motor (severity + dedupe) |
| 16 | Extern kanal | Kanalarkitektur + outbox (SMS/push via webhook, RSS) |
| 17 | API/RSS | `/api/v1` med Bearer-nyckel, tre RSS-flöden |
| 18–19 | Koppla bort integration + status | Integrationer-vyn (status, test, disconnect, purge) |
| 20 | Veta vad systemet vet/inte vet | Coverage-findings, confidence, antaganden, källetiketter |

## Första vertikalen

Kärnmodellen är generell (Organization, Business Unit, Transaction, Invoice, Finding,
Evidence, Action, Decision, …). Verkstad är referensverksamhet via seed-datan
(arbetsordrar, reservdelar, enheter) — inte via kärnlogiken. Branschadapters
(hantverk, städ, fabrik, fastighet) läggs till som connectors + profilfält senare.
