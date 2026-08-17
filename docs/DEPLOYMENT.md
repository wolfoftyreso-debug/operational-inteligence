# Deployment Contract — Operational Intelligence

Detta dokument beskriver exakt vad applikationen kräver för drift. En annan
utvecklare ska kunna deploya systemet utan att gissa.

## VIKTIGT: Kubernetes-miljön kunde inte inspekteras

Byggordern kräver att deployment följer den faktiska Kubernetes-miljöns
konventioner och att inget antas. Från utvecklingssessionen fanns **ingen
åtkomst** till kluster, kubeconfig, GitOps-/infra-repo eller manifests
(verifierat: ingen `kubectl`, ingen `~/.kube`, inget infra-repo i
GitHub-kontot). Därför innehåller detta dokument **applikationens kontrakt**
— komplett och verifierat — medan miljöspecifika val är markerade
`[INSPECT ENV]` och måste fyllas i mot den riktiga miljön innan deploy:

| Beslut | Status |
|---|---|
| Namespace, labels, naming conventions | `[INSPECT ENV]` |
| Ingress-controller, ingress-klass, TLS/cert-hantering | `[INSPECT ENV]` |
| StorageClass för persistent volym | `[INSPECT ENV]` |
| Secret management (Sealed Secrets/ESO/Vault/SOPS?) | `[INSPECT ENV]` |
| Image registry + pull secrets | `[INSPECT ENV]` |
| CI/CD-pipeline / GitOps-verktyg | `[INSPECT ENV]` |
| Observability-stack (logg/metrics/alerting) | `[INSPECT ENV]` — appen loggar strukturerad JSON till stdout och exponerar hälsoprober; koppla mot befintlig stack |
| Backupkonvention för volymer | `[INSPECT ENV]` |

## Applikationskontraktet (verifierat)

**Runtime**: Node.js ≥ 22.5 (använder inbyggda `node:sqlite`). Ingen native
kompilering. En process, statisk frontend serveras av samma process.

**Image**: `Dockerfile` i repo-roten (multi-stage, non-root user `oi`,
alpine). Byggd och körd lokalt är den funktionellt ekvivalent med
`npm run build && npm start`.

**Portar**: `3000` (HTTP). Konfigureras med `PORT`.

**Hälsoprober**:
- Liveness: `GET /healthz` → `200 {ok:true}`
- Readiness: `GET /readyz` → `200` när databasen svarar, `503` annars

**Persistent lagring**: `/data` (styrs av `OI_DATA_DIR`) innehåller:
- `oi.sqlite` — hela verksamhetsdatabasen (SQLite, WAL-läge)
- `secret.key` — genererad krypteringsnyckel om `OI_SECRET_KEY` inte sätts

Kravet är en persistent volym (~1–10 GiB beroende på datamängd).
**Sätt alltid `OI_SECRET_KEY` som secret i drift** så att nyckeln inte bor på
volymen.

**Skalning**: 1 replica (SQLite + in-memory rate limit). Horisontell skalning
kräver databytet beskrivet under "Kända begränsningar".

**Resurskrav (uppmätt lokalt, demo-data)**: ~90 MB RSS i vila; CPU-behov lågt
(analys av demoorganisationen < 1 s). Förslag: requests 100m/128Mi,
limits 500m/512Mi — justera efter last.

## Miljövariabler

| Variabel | Krävs | Beskrivning |
|---|---|---|
| `PORT` | nej (3000) | HTTP-port |
| `OI_BASE_URL` | ja i drift | Publik URL — krävs för OAuth-callbacks och Secure-cookies (https ⇒ Secure-flagga) |
| `OI_DATA_DIR` | nej (`./data`) | Katalog för SQLite + nyckel |
| `OI_DB_FILE` | nej | Explicit databasfil |
| `OI_SECRET_KEY` | **rekommenderas** | Masternyckel för AES-256-GCM-kryptering av connector-secrets (≥32 tecken). Secret. |
| `ANTHROPIC_API_KEY` | nej | Aktiverar språkmodellen; utan den körs deterministisk kompositör |
| `OI_REASONING_MODEL` | nej (`claude-fable-5`) | Modell-ID — kärnan är modellagnostisk |
| `OI_REASONING_PROVIDER` | nej | `anthropic` \| `deterministic` |
| `FORTNOX_CLIENT_ID/SECRET` | nej | Aktiverar Fortnox-connectorn. Secrets. |
| `VISMA_CLIENT_ID/SECRET` | nej | Aktiverar Visma-connectorn. Secrets. |
| `OI_SMS_WEBHOOK_URL`, `OI_PUSH_WEBHOOK_URL`, `OI_SMTP_URL` | nej | Notifieringskanaler |

## Migrationer

Schemat appliceras idempotent vid start (`CREATE TABLE IF NOT EXISTS` +
additiva `ALTER TABLE` i `src/db/index.ts`). Ingen separat migrationskörning
krävs; en ny image mot befintlig volym uppgraderar schemat vid boot.
Rollback: tidigare image fungerar mot nyare schema (endast additiva ändringar).

## Extern nätverksåtkomst (endast när respektive funktion används)

`api.anthropic.com` (reasoning), `apps.fortnox.se`/`api.fortnox.se`,
`identity.vismaonline.com`/`eaccountingapi.vismaonline.com`, samt
kundkonfigurerade Generic API-endpoints och notifierings-webhooks.
NetworkPolicy kan i övrigt vara restriktiv.

## Observability

- **Loggar**: strukturerad JSON till stdout (`ts`, `level`, `msg`,
  `request_id`, `method`, `path`, `status`, `duration_ms`, `org`).
  Inga credentials, cookies eller råa modellinputs loggas.
- **Korrelation**: `x-request-id` respekteras inkommande och sätts utgående;
  felresponser innehåller `request_id`.
- **Prober**: `/healthz`, `/readyz` enligt ovan.
- Metrics-endpoint saknas ännu — koppla på klustrets standard (t.ex.
  sidecar/log-baserade SLO:er) eller lägg till exporter i nästa fas.

## Backup

Backup = kopia av `/data` (SQLite-fil + WAL). Konsistent snapshot: kör
`VACUUM INTO` eller stoppa poddens trafik kort. Följ miljöns
volymbackup-konvention `[INSPECT ENV]`.

## Kända begränsningar för produktion (ärliga)

1. **SQLite + 1 replica** — medvetet val för betan (ADR-001). Byte till
   Postgres krävs för HA/horisontell skalning; datalagret är samlat i
   `src/db/` för att göra bytet avgränsat.
2. **In-memory rate limit** — per process; delas inte mellan replicas.
3. **E-postkanal** — kö-loggas i outbox; SMTP-relay ej implementerat.
4. **Ingen metrics-exporter** — endast strukturerade loggar + prober.
