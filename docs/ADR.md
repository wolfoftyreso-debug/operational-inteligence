# Architecture Decision Records

Varje post beskriver ett beslut, dess kontext, alternativ, motivering och
konsekvenser — så att någon annan kan förstå varför systemet är byggt så här.

---

## ADR-001 — SQLite via `node:sqlite` som datalager i betan

**Beslut.** Verksamhetsdatabasen är SQLite genom Node.js inbyggda
`node:sqlite`, med hela dataåtkomsten samlad i `src/db/`.

**Kontext.** Betan skulle vara körbar direkt (`npm install && npm start`) utan
externa tjänster, utan native kompilering och utan att låsa produktvalet av
databas. Datamodellen är relationell och kräver transaktioner, index och
constraints.

**Alternativ.**
- *Postgres från start* — bättre för HA och horisontell skalning, men kräver
  en extra körande tjänst i varje utvecklings- och demomiljö.
- `better-sqlite3` — moget, men native-kompilering i varje image/miljö.
- *Dokumentdatabas* — passar dåligt: modellen är genuint relationell
  (findings → evidence → källor → transaktioner).

**Motivering.** Inbyggd runtime, noll externa beroenden, verklig SQL. Bytet
till Postgres är avgränsat eftersom all SQL ligger bakom `src/db/` och
schemat är rent SQL.

**Konsekvenser.** En replica i drift (SQLite + WAL på en volym). Horisontell
skalning kräver databyte. Persistent volym på `/data` krävs. `node:sqlite` är
markerad experimentell i Node 22 — därför körs processen med `--no-warnings`
och API-ytan som används är den minimala (prepare/run/all/get/exec).

---

## ADR-002 — Deterministiska beräkningar skilda från reasoning

**Beslut.** Alla ekonomiska och numeriska värden beräknas av kod
(`src/analysis/`). Språkmodellen får ett färdigberäknat evidenspaket och
tolkar det. Modellen räknar aldrig och är aldrig system of record.

**Kontext.** Produkten ska tåla ifrågasättande: "varifrån kommer den här
siffran?" måste alltid gå att besvara. Språkmodeller är opålitliga som
kalkylatorer och kan inte revideras i efterhand.

**Alternativ.** Skicka rådata och låta modellen räkna — enklare att bygga,
men omöjligt att verifiera och reproducerbarheten försvinner.

**Konsekvenser.** Varje nytt analysområde kräver en deterministisk regel, inte
bara en prompt. Systemet fungerar fullt ut utan språkmodell (deterministisk
kompositör). Confidence och evidenskedjor kan beräknas, inte gissas.

---

## ADR-003 — Modellagnostiskt reasoning-lager

**Beslut.** Provider och modell-ID kommer enbart från konfiguration
(`OI_REASONING_PROVIDER`, `OI_REASONING_MODEL`). Kärnan refererar aldrig ett
modellnamn.

**Konsekvenser.** Modellbyte är en miljövariabel. En deterministisk provider
finns alltid som fallback, vilket också gör tester oberoende av nätverk och
API-nycklar.

---

## ADR-004 — Connector-first med kanoniska dataset

**Beslut.** Varje integration implementerar ett gemensamt kontrakt
(`src/connectors/types.ts`) och normaliserar till kanoniska dataset
(transaktioner, fakturor, tidsposter, arbetsorder, kunder, leverantörer,
personal). Registret (`registry.ts`) är enda platsen som känner till vilka
connectors som finns.

**Kontext.** Adapter-flywheel: varje ny kund kan introducera ett nytt
källsystem. Att lägga till en connector får aldrig kräva ändringar i analys-,
reasoning- eller UI-lagret.

**Konsekvenser.** Nya connectors är additiva. Kundspecifik logik är förbjuden
i connectorn — den ska vara en återanvändbar produktkomponent. Data som saknar
connector kommer in via CSV/Excel/Generic API, och Connector Discovery
föreslår integration när manuell import blir återkommande.

---

## ADR-005 — AI-datagräns: dokumentinnehåll är data, aldrig instruktioner

**Beslut.** Uppladdat dokumentinnehåll skickas inneslutet i `<DOKUMENT>`-taggar
med en explicit säkerhetsregel i systemprompten om att instruktionsliknande
text i dokumentet ska behandlas som innehåll. System policy, verksamhetens
policy, användarens fråga och dokumentinnehåll hålls åtskilda i prompten.

**Kontext.** Styrande dokument och externa datakällor är otrodd input.

**Konsekvenser.** Prompt injection via dokument är arkitektoniskt hanterad,
inte beroende av modellens godtycke. Extraktion producerar dessutom endast
förslag som kräver mänskligt godkännande innan de blir styrande.

---

## ADR-006 — Opportunities och Investigations som förstaklassiga objekt

**Beslut.** Utöver findings (något händer) finns opportunities (något kan bli
bättre) och investigations (låst-kontext-tråd kring en specifik fråga) som
egna entiteter i datamodellen.

**Kontext.** Systemet ska kunna upptäcka frågor ägaren inte visste att hen
skulle ställa — men aldrig ta över beslutet. En upptäckt ska bli en valfri
undersökning, inte en automatisk slutsats.

**Alternativ.** Låta allt vara findings — men severity/status passar dåligt på
möjligheter, och chatthistorik utan objektidentitet tappar spårbarhet.

**Konsekvenser.** Avvisade möjligheter (`dismissed`) föreslås aldrig igen —
systemet lär sig användarpreferens, samtidigt som det underliggande
verksamhetsfaktumet behålls i verklighetsmodellen. Undersökningar har egen
kontext, dialog, slutsats och confidence.

---

## ADR-007 — Skattefunktioner är frågeställande, aldrig rådgivande

**Beslut.** Skattedetektorer identifierar *saker värda att undersöka* inom
lagens ram (LEGAL TAX EFFICIENCY), flaggas alltid
`requires_human_review`, och formulerar aldrig ett regelpåstående som
garanterat.

**Kontext.** Skatteregler är år- och situationsberoende. Ett felaktigt
regelpåstående skulle vara direkt skadligt för användaren.

**Konsekvenser.** Systemet säger "det här bör kontrolleras mot aktuellt
beskattningsår — stäm av med redovisningskonsult", visar scenarier i stället
för svar, och redovisar vilket underlag som saknas.
