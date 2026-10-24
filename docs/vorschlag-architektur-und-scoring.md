# Vorschlag: Internet-Betrieb, Speicherung/Offline-Sync und verbessertes Scoring

Grundlage: `Agent_wiss_analyse21.html` (Single-Page-App, läuft komplett im Browser, Daten in `localStorage`),
aktuell erreichbar unter `https://thinkstationpgx-afbe.taildf3925.ts.net/lit` auf der Spark-Maschine.

---

## Teil 1 – Architektur für Internet-Nutzung, LLM-Routing und Speicherung

### 1.1 Ausgangslage und was heute nicht trägt

| Thema | Ist-Zustand im Code | Problem bei Internet-Nutzung |
|---|---|---|
| Benutzer/Login | `hashString()` (djb2-Hash) in `localStorage` | Kein echter Schutz; jeder Browser hat seine eigene „Benutzer-DB“, keine Daten auf Spark |
| API-Keys | `encryptKey()` = XOR mit dem Passwort + Base64 | Trivial umkehrbar; sobald Daten auf den Server sollen, nicht akzeptabel |
| Historie | `localStorage`, max. 20 Läufe, nur Endergebnis | `localStorage` hat ~5 MB → läuft bei großen Läufen voll; Prompts/Antworten der einzelnen Agent-Schritte werden nicht gespeichert |
| Prompts | max. 5 Versionen je Agent, Datum als `toLocaleString()` | Nicht sortier-/synchronisierbar, keine eindeutige Version-ID |
| LLM-Aufruf | Browser ruft Endpoint direkt (`fetch` auf `custom2Url = http://10.189.26.81:8000/v1`) | Ein Nutzer im Internet erreicht die Spark-IP `10.x` nicht; HTTP-Endpoint aus HTTPS-Seite = Mixed Content |
| Offline | pdf.js kommt von cdnjs | Ohne Internet lädt weder die App noch pdf.js |
| Erreichbarkeit | `*.ts.net` über **Tailscale Funnel** bereits öffentlich (z.B. Handy im Mobilfunk) | Die Seite ist für jeden im Internet abrufbar. Solange nur statisches HTML ausgeliefert wird und alle Daten im Browser liegen, ist das unkritisch. Sobald Backend, Proxy und Daten auf dem Spark liegen, wird der Login zur echten Schutzgrenze. Ein Handy kann weder `10.189.26.81` noch Laptop-`localhost` erreichen → dort funktionieren nur Spark-Modelle (über den Proxy) und Internet-APIs |

### 1.2 Zielarchitektur

```
                          Internet
   ┌────────────────────────────────────────────────────────────┐
   │  Browser des Users (PWA, offlinefähig)                      │
   │  ┌──────────────┐  ┌───────────────┐  ┌──────────────────┐  │
   │  │ UI + Pipeline│  │ IndexedDB     │  │ Service Worker   │  │
   │  │ (gleicher JS-│  │ (Settings,    │  │ (App-Shell,      │  │
   │  │  Code wie    │  │  Prompts,     │  │  pdf.js, Fonts   │  │
   │  │  Server)     │  │  Runs, Outbox)│  │  gecacht)        │  │
   │  └──────┬───────┘  └──────┬────────┘  └──────────────────┘  │
   │         │ direct          │ sync                            │
   │         ▼                 │                                  │
   │  LM Studio auf Laptop     │                                  │
   │  http://localhost:1234/v1 │                                  │
   └─────────┼─────────────────┼──────────────────────────────────┘
             │ (oder direkt    │ HTTPS (Tailscale Funnel / Serve)
             │  OpenAI/Gemini) ▼
   ┌────────────────────────────────────────────────────────────┐
   │  Spark: Backend  /lit/api/*   (Node + Fastify, SQLite)      │
   │   ├─ /auth       Login, Sessions (argon2id, HttpOnly-Cookie)│
   │   ├─ /sync       Push/Pull der IndexedDB-Daten              │
   │   ├─ /llm/:prov  LLM-Proxy (Spark-vLLM, OpenAI, Gemini, …)  │
   │   └─ /jobs       optional: Pipeline serverseitig + SSE      │
   │                          │                                  │
   │                          ▼                                  │
   │   vLLM / LM Studio / Ollama auf Spark (nur intern, :8000)   │
   └────────────────────────────────────────────────────────────┘
```

**Empfehlung Tech-Stack:** Node.js (TypeScript) + Fastify + `better-sqlite3`.
Grund: Die komplette Pipeline (PDF-Parsing mit pdf.js, Evidenzkontext, Prompt-Füllung, JSON-Parser,
Quote-Verifikation, Score-Berechnung) ist JavaScript und kann **1:1 als gemeinsames Modul**
(`/shared/pipeline/*.ts`) in Browser *und* Server laufen. Python/FastAPI ginge auch, würde aber
die Scoring-Logik doppelt implementieren – genau dort entstehen später Abweichungen.

Deployment auf Spark: ein Container (`docker compose`) mit Backend, das auch die statische App
unter `/lit/` ausliefert; davor `tailscale serve --bg --set-path /lit http://127.0.0.1:3000`
bzw. `tailscale funnel` für öffentlichen Zugang.

### 1.3 LLM-Routing: drei Betriebsarten

Jeder Provider bekommt ein Feld `mode`:

| Modell läuft … | `mode` | Weg | Bemerkung |
|---|---|---|---|
| auf **Spark** (vLLM/LM Studio, `:8000`) | `proxy` | Browser → `/lit/api/llm/spark` → `127.0.0.1:8000` | Einzige Möglichkeit von außen; Endpoint bleibt intern, kein Mixed Content |
| auf dem **Laptop** des Users (LM Studio) | `direct` | Browser → `http://localhost:1234/v1` | Funktioniert auch **offline**. LM Studio: *„Enable CORS“* aktivieren. Chrome fragt ab v142 nach „Local Network Access“-Erlaubnis; Safari blockiert `http://localhost` aus HTTPS-Seiten → Hinweis in der UI |
| **Internet-API** (OpenAI, Gemini, benutzerdefiniert) | `direct` oder `proxy` | direkt, oder über Spark | `proxy` empfohlen, wenn der Key serverseitig liegen soll (z.B. ein Institutsschlüssel für alle) |

Umsetzung im Code: `callLLM()` bekommt statt der DOM-Lesungen ein Provider-Objekt
`{id, mode, baseUrl, model, keyRef, thinking, jsonMode}`. Bei `proxy` geht der Request an
`/lit/api/llm/<id>/chat/completions` (Session-Cookie), der Server ergänzt Key/URL und streamt durch.
Der Proxy erlaubt nur konfigurierte Ziel-URLs (keine freie URL vom Client → sonst SSRF).

**Lange Läufe:** Bei `proxy`-Providern kann die Pipeline optional serverseitig als Job laufen
(`POST /jobs`, Fortschritt per Server-Sent-Events). Dann überlebt der Lauf ein geschlossenes
Laptop. Bei `direct`-Providern (Laptop-LM-Studio) läuft sie zwangsläufig im Browser.

### 1.4 Benutzer und Geheimnisse

- **Login serverseitig:** Passwort mit argon2id, Session als `HttpOnly; Secure; SameSite=Strict`-Cookie,
  Rate-Limit auf `/auth`. Pflicht, weil der Dienst über Funnel bereits öffentlich ist. Mit `tailscale funnel status` prüfen, dass **nur** `/lit` (bzw. später das Backend) freigegeben ist und niemals der vLLM-Port `:8000` direkt.
  Alternative für reine Tailnet-Nutzer: Tailscale-Identität (`Tailscale-User-Login`-Header von `tailscale serve`).
- **Offline-Login:** Nach erstem Online-Login wird ein lokaler Schlüssel (WebCrypto, PBKDF2 → AES-GCM)
  aus dem Passwort abgeleitet; damit entsperrt der Browser die IndexedDB auch ohne Server.
- **API-Keys:** zwei Varianten, pro Key wählbar:
  1. *Nur lokal* – AES-GCM-verschlüsselt in IndexedDB, Server sieht den Key nie (passt zu `direct`).
  2. *Auf Spark* – serverseitig mit einem Server-Master-Key verschlüsselt (libsodium `secretbox`),
     nie an den Browser zurückgegeben (passt zu `proxy`).
  Das bisherige XOR-Verfahren entfällt; bei der Migration werden Keys einmal entschlüsselt und neu abgelegt.

### 1.5 Datenmodell (identisch in SQLite und IndexedDB)

Prinzip: **Fast alles append-only** → Synchronisation ohne echte Konflikte.

```sql
users            (id, login, pass_hash, created_at)
settings         (user_id, key, value_json, updated_at, rev)          -- last-writer-wins pro key
providers        (id, user_id, name, mode, base_url, model, thinking, json_mode, key_storage, updated_at, rev, deleted)
prompt_versions  (id UUID, user_id, agent, text, sha256, created_at, label)  -- unveränderlich
prompt_heads     (user_id, agent, version_id, updated_at, rev)        -- "aktive" Version je Agent
runs             (id UUID, user_id, started_at, finished_at, status, provider_snapshot_json,
                  prompt_version_ids_json, settings_snapshot_json, result_json, scoring_version)
run_documents    (run_id, doc_id, filename, sha256, num_pages, evidence_chars)
run_steps        (id UUID, run_id, doc_id, agent, prompt_version_id, request_json, response_raw,
                  parsed_json, model, tokens_in, tokens_out, duration_ms, error, created_at)
documents        (sha256, user_id, filename, pages_text_json, pdf_blob NULL)  -- PDF optional
sync_log         (seq INTEGER PK, user_id, table, row_id, op, at)     -- Server-Cursor
```

- `run_steps` speichert **jeden Agent-Aufruf mit Prompt, Rohantwort und geparstem JSON** – das ist
  die gewünschte „Historie des Agenten-Durchgangs und der Prompts“ und macht Ergebnisse reproduzierbar.
- Prompts: statt „max. 5 Versionen“ unbegrenzt, mit `sha256` (Duplikate werden nicht neu angelegt)
  und optionalem Label. Ein Run referenziert die exakten `prompt_version_id`s.
- PDFs: Standard nur Hash + extrahierter Seitentext (Urheberrecht/Speicher); PDF-Blob optional.

### 1.6 Offline & Synchronisation

1. **PWA:** `manifest.webmanifest` + Service Worker cachet App-Shell, pdf.js + Worker (lokal
   ausliefern statt cdnjs), Icons. App startet ohne Netz.
   Hinweis: Wird die App per „Zum Home-Bildschirm“ auf dem Handy installiert, startet sie auch ohne Netz.
2. **IndexedDB** (z.B. mit `Dexie`) ersetzt `localStorage` komplett – kein 5-MB-Limit.
3. **Outbox:** Jede lokale Änderung wird in die Tabelle geschrieben **und** als Eintrag in `outbox`.
4. **Sync-Protokoll:**
   - `POST /api/sync/push` – Outbox-Einträge (idempotent über UUID; Server ignoriert Duplikate).
   - `GET /api/sync/pull?since=<seq>` – alle Änderungen nach dem Cursor; Client speichert neuen Cursor.
   - Auslöser: App-Start, `online`-Event, nach jedem Run, alle 60 s; Background Sync wo verfügbar.
5. **Konflikte:** Prompt-Versionen, Runs, Steps sind unveränderlich → keine Konflikte.
   Nur `settings`, `providers`, `prompt_heads` können kollidieren → Last-Writer-Wins über
   `updated_at` + `rev`; der Verlierer bleibt im `sync_log` einsehbar.
6. **Offline-Lauf:** Mit Laptop-LM-Studio (`direct`) läuft die komplette Pipeline offline; der Run
   landet in IndexedDB und wird beim nächsten Online-Kontakt auf Spark hochgeladen.
   `proxy`-Provider sind offline ausgegraut.

### 1.7 Umsetzung in Etappen

| Etappe | Inhalt | Ergebnis |
|---|---|---|
| 0 ✅ | HTML in Module zerlegen, pdf.js lokal (umgesetzt **ohne** Build-Schritt: `app/js/*.js` als normale Skripte, `scoring.js` zusätzlich in Node testbar) | Gleiche App, aber wartbar und testbar |
| 1 ✅ | `localStorage` → IndexedDB, `run_steps` mitschreiben, PWA/Service Worker, Export/Import | Offline + vollständige Historie, noch ohne Server |
| 2 ✅ | Backend auf Spark: Auth, SQLite, Sync-Endpoints, Verknüpfen alter lokaler Profile (umgesetzt mit `node:sqlite` und scrypt statt argon2 – keine nativen Pakete auf dem ARM-Spark; Registrierung nur mit Einladungscode) | Daten auf Spark **und** lokal |
| 3 | LLM-Proxy + Provider-Modell (`direct`/`proxy`), serverseitige Keys | Spark-Modell aus dem Internet nutzbar |
| 4 | Optional: serverseitige Jobs mit SSE | Lange Läufe unabhängig vom Browser |
| 5 | Funnel-Pfade auf das Backend umstellen (Funnel ist schon aktiv), Rate-Limits, Backups (`sqlite3 .backup` per Cron) | Öffentlicher Betrieb |

Kleinere Fehler, die beim Umbau mit behoben werden sollten:
- `prompt.replace('{{SOURCE_TEXT}}', doc.evidence_text)`: Bei String-Ersetzung interpretiert JS `$&`, `$'`, `` $` `` im
  PDF-Text als Sonderzeichen → Text wird verfälscht. Fix: `replace('{{SOURCE_TEXT}}', () => doc.evidence_text)`.
- Default-URL `http://10.189.26.81:8000/v1` gehört nicht in den Client, sondern als `proxy`-Provider auf den Server.

---

## Teil 2 – Verbesserung des Scorings

### 2.1 Schwachstellen des aktuellen Scorings

1. **Das LLM vergibt die Gewichte.** `calculateValidatedCASQ()` nimmt `weight` aus der Appraisal-Antwort.
   Die Gewichte stehen zwar im Prompt, werden aber nicht im Code erzwungen → ein Modell kann sie
   (bewusst oder durch Fehler) verschieben.
2. **Freie 0–10-Werte pro Dimension.** „Statistical analysis = 7.5“ ist ein holistisches Urteil ohne Anker.
   Das ist die Hauptquelle für Unzuverlässigkeit (zwischen Läufen und Modellen).
3. **Nicht-Berichten wird belohnt.** Dimensionen mit `insufficient_information`/`unsupported` werden aus
   dem Mittel *entfernt*. Ein Paper, das schlechte Methodik verschweigt, kann dadurch besser abschneiden
   als eines, das sie offenlegt. Etablierte Instrumente machen das gerade nicht (PEDro: nicht berichtet = 0).
4. **`evidence_coverage` ist Selbstauskunft des LLM** (Agent 4 liefert die Zahl, der Code übernimmt sie).
5. **Verifikation der Zitate hat keine Folgen.** `verified:false` wird nur angezeigt, der Score bleibt gleich.
6. **Ausgleich schwerer Mängel.** Ein gewichtetes Mittel lässt z.B. fehlende Randomisierung durch gute
   Transparenz „wegmitteln“ – genau das Prinzip, das der OnePager bei AMSTAR 2 selbst kritisiert.
7. **Etablierte Instrumente – Logik teilweise vom LLM abhängig:**
   - AMSTAR 2: `critical` kommt vom LLM. Kritisch sind laut Instrument fest Items 2, 4, 7, 9, 11, 13, 15.
   - COSMIN: der Code bevorzugt `ea.official_rating` des LLM vor dem selbst berechneten „worst score counts“
     und berechnet über *alle* Items statt pro Box/Messeigenschaft.
   - MINORS: komparativ/nicht-komparativ wird aus `items.length` geraten, Items werden nach Position
     statt nach `item_id` gezählt. `clinical_context.is_comparative` aus der Extraktion existiert bereits.
   - PEDro: fehlen Items in der LLM-Antwort, sinkt der Score stillschweigend.
8. **Lücke bei Instrumenten.** RCTs außerhalb der Physiotherapie, Kohorten, Querschnittstudien,
   Diagnostikstudien bekommen keinen etablierten Score – das ist die Mehrzahl der Literatur.
9. **Kein Maß für Zuverlässigkeit.** Ein einzelner Lauf mit `temperature 0` ist nicht deterministisch;
   ob ein Score 6,5 oder 7,5 „ist“, weiß man nicht.
10. **Gesamtwert = Mittel der CASQ verschiedener Designs** – fachlich kaum interpretierbar.

### 2.2 Prinzip: LLM beantwortet Prüffragen, Code rechnet

Das LLM soll nur noch **beobachtbare, belegbare Einzelfragen** beantworten
(`yes | partial | no | not_reported | not_applicable` + Zitat + Seite).
Jede Zahl – Item-Punkte, Domänenurteile, Gesamtrating, CASQ – wird **deterministisch im Code** berechnet,
mit fest hinterlegten Rubriken (`shared/scoring/rubrics/*.json`, versioniert über `scoring_version`).

So wird die Bewertung reproduzierbar, prüfbar und unabhängig vom Prompt-Tuning des Modells.

### 2.3 Drei getrennte Achsen statt eines Mischwerts

| Achse | Frage | Instrumente | Ausgabe |
|---|---|---|---|
| **A. Reporting-Qualität** | Ist berichtet, was man berichten muss? | CONSORT, STROBE, PRISMA 2020, SRQR/COREQ, APA JARS | Erfüllungsgrad % (intern), Liste fehlender Punkte |
| **B. Methodische Qualität / Risk of Bias** | Wie belastbar ist das Ergebnis? | RoB 2, ROBINS-I, NOS, QUADAS-2, JBI, PEDro, MINORS, AMSTAR 2, COSMIN, MMAT/CASP | Offizielles Rating / Score |
| **C. Vertrauenswürdigkeitssignale** | Gibt es formale Auffälligkeiten? | deterministische Checks (2.6) | Flags |

CASQ bleibt als interner Vergleichsindex, wird aber aus A+B-Prüffragen abgeleitet (2.4).

### 2.4 CASQ 2.0 – verankerte Formel

**Rubrik:** Jede Dimension bekommt 3–6 konkrete Prüffragen (Anker). Beispiel *Quantitativ – Stichprobe & externe Validität (Gewicht 15)*:

| ID | Prüffrage |
|---|---|
| S1 | Zielpopulation und Ein-/Ausschlusskriterien sind beschrieben |
| S2 | Rekrutierungs-/Auswahlverfahren ist beschrieben |
| S3 | Stichprobenumfang ist begründet (Power-Analyse o.ä.) |
| S4 | Rücklauf / Drop-out ist berichtet |
| S5 | Stichprobenmerkmale sind tabellarisch berichtet |

**Berechnung (im Code):**

```
Antwortwert:   yes = 1   partial = 0.5   no = 0   not_reported = 0   not_applicable = (entfällt)
Belegpflicht:  yes/partial ohne verifiziertes Zitat  →  eine Stufe herab (yes→partial, partial→no)
Dimension d:   s_d = 10 · mean(Antwortwerte der anwendbaren Fragen)
CASQ:          CASQ = Σ w_d · s_d / Σ w_d        (w_d fest aus Rubrik, nicht vom LLM)
Deckel:        kritische Fragen (z.B. "Randomisierung angemessen", "Confounding adressiert")
               mit "no" → CASQ ≤ 5.0;  ≥ 2 kritische "no" → CASQ ≤ 3.0
```

Zusätzlich ausweisen:

- **Informationsgrad** = Anteil der Fragen mit `yes|partial|no` (also nicht `not_reported`) – ersetzt die LLM-`evidence_coverage`.
- **Belegquote** = Anteil der `yes/partial`-Antworten mit verifiziertem Zitat.
- **Spannweite**: CASQ_min (not_reported = 0, so oben) und CASQ_max (not_reported = 1). Eine große Spanne
  zeigt sofort: „Das Paper berichtet zu wenig, um es zu beurteilen“ – statt eines scheinbar präzisen Werts.

```ts
// shared/scoring/casq.ts (Skizze)
const VALUE = { yes: 1, partial: 0.5, no: 0, not_reported: 0 };
const DOWNGRADE = { yes: 'partial', partial: 'no' };

export function computeCASQ(rubric, answers) {
  let sum = 0, wsum = 0, sumMax = 0, decided = 0, total = 0, criticalNo = 0;
  for (const dim of rubric.dimensions) {
    const vals = [], valsMax = [];
    for (const q of dim.questions) {
      let r = answers[q.id]?.response ?? 'not_reported';
      if (r === 'not_applicable') continue;
      if (DOWNGRADE[r] && !answers[q.id]?.evidence?.some(e => e.verified)) r = DOWNGRADE[r];
      total++; if (r !== 'not_reported') decided++;
      if (q.critical && r === 'no') criticalNo++;
      vals.push(VALUE[r]); valsMax.push(r === 'not_reported' ? 1 : VALUE[r]);
    }
    if (!vals.length) continue;
    sum += dim.weight * 10 * mean(vals);
    sumMax += dim.weight * 10 * mean(valsMax);
    wsum += dim.weight;
  }
  if (!wsum) return null;
  const cap = criticalNo >= 2 ? 3 : criticalNo === 1 ? 5 : 10;
  return {
    casq: Math.min(sum / wsum, cap),
    casqMax: Math.min(sumMax / wsum, cap),
    informationGrade: decided / total,
    criticalFlaws: criticalNo,
  };
}
```

`qualityLabel()` dann auf Basis von `casq` **und** `informationGrade` (z.B. < 60 % → „UNSICHER“), nicht auf der LLM-Coverage.

### 2.5 Etablierte Instrumente: korrigieren und ergänzen

**Korrekturen am vorhandenen Code:**

- **AMSTAR 2:** `critical` fest über `item_id ∈ {2,4,7,9,11,13,15}` setzen; LLM-Feld ignorieren.
  Regel laut Shea et al. 2017: High = höchstens 1 nicht-kritische Schwäche; Moderate = > 1 nicht-kritische;
  Low = genau 1 kritischer Mangel; Critically low = > 1 kritischer Mangel. Item 11/15 nur zählen, wenn Meta-Analyse durchgeführt.
- **COSMIN:** Rating pro Box/Messeigenschaft deterministisch mit „worst score counts“ berechnen; LLM-`official_rating` nur noch als Plausibilitätsvergleich anzeigen.
- **MINORS:** komparativ aus `extraction.clinical_context.is_comparative`; Items nach `item_id` 1–12 zuordnen.
- **PEDro:** Vollständigkeit prüfen (Items 1–11 vorhanden); fehlende Items als `no` zählen **und** als „unvollständige Antwort“ markieren bzw. gezielt nachfragen (Repair-Prompt nur für fehlende Items).

**Ergänzung um die gebräuchlichsten Werkzeuge** (alle mit Signalfragen + publiziertem Algorithmus → ideal für „LLM fragt, Code rechnet“):

| Design | Instrument | Ausgabe |
|---|---|---|
| RCT (allgemein) | **Cochrane RoB 2** (5 Domänen, Signalfragen, Algorithmus) | Low / Some concerns / High |
| Nicht-randomisierte Interventionsstudie | **ROBINS-I** (V2) | Low / Moderate / Serious / Critical |
| Kohorte, Fall-Kontrolle | **Newcastle-Ottawa Scale** | 0–9 Sterne |
| Querschnitt, Fallserie, Prävalenz | **JBI Critical Appraisal Checklists** | Checkliste |
| Diagnostische Genauigkeit | **QUADAS-2** | RoB + Applicability je Domäne |
| Reporting | CONSORT / STROBE / PRISMA 2020 / SRQR | Erfüllungsgrad (intern) |

PEDro bleibt für Physio-RCTs, zusätzlich zu RoB 2.

### 2.6 Deterministische Vertrauenssignale (Achse C)

Ohne LLM, direkt aus Text/Extraktion berechenbar:

- **statcheck-Logik:** aus berichteten Teststatistiken (`t(28) = 2.10, p = .045`) p-Wert nachrechnen; Inkonsistenzen flaggen.
- **GRIM/GRIMMER-Test:** Mittelwerte/SD bei ganzzahligen Skalen und gegebenem N auf Möglichkeit prüfen.
- **Stichproben-Konsistenz:** N in Abstract, Methoden, Tabellen, Flow-Diagramm vergleichen.
- **Präregistrierung:** genannte IDs (NCT…, DRKS…, OSF, PROSPERO CRD…) per Regex erkennen und (online) auflösen.
- **Retraction-/Correction-Check:** DOI gegen Crossref / Retraction-Watch-Daten prüfen (nur online, Ergebnis cachen).
- **Selektives Berichten:** primäres Outcome in Registrierung vs. Paper (wenn Registrierung abrufbar).

Diese Flags fließen nicht in den CASQ ein, sondern werden separat und gut sichtbar angezeigt.

### 2.7 Zuverlässigkeit messen statt annehmen

1. **Mehrfachbewertung:** Appraisal-Agent pro Dokument *k* = 3× (gleiches Modell mit Temperatur 0.3–0.5 oder
   zwei verschiedene Modelle, z.B. Spark-lokal + API). Pro Prüffrage Mehrheitsentscheid; Items ohne
   Einigkeit → `uncertain`, gezielte Nachprüfung durch Agent 4 nur für diese Items (spart Tokens).
2. **Streuung anzeigen:** CASQ als Median mit Spannweite der Läufe; Übereinstimmung je Instrument (Fleiss-κ).
3. **Kalibrierung gegen Experten (wichtigster Schritt für Wissenschaftlichkeit):**
   - **PEDro-Datenbank** (pedro.org.au) enthält Expertenbewertungen für sehr viele Physio-RCTs → Agent vs. Experte: ICC, MAE, Item-κ.
   - Publizierte Cochrane-Reviews enthalten RoB-2-Urteile je Studie → Domänen-κ.
   - Overviews mit AMSTAR-2-Ratings.
   - Ein eigenes kleines Goldstandard-Set (30–50 Paper) mit Doppelbewertung durch Fachleute für CASQ.
   Daraus: Bericht „Übereinstimmung Agent vs. Experte“ je Instrument und Modell, der in der App
   verlinkt wird. Erst damit lässt sich ein Agent-Score wissenschaftlich vertreten.
4. **Regressionstests:** Goldstandard-Set als automatisierter Test; jede Prompt-/Rubrik-Änderung muss
   die Übereinstimmung halten oder verbessern (erfordert die Modularisierung aus Etappe 0).

### 2.8 Technische Maßnahmen für stabilere Bewertungen

- **Strukturierte Ausgabe:** `response_format: { type: "json_schema", … }` verwenden – unterstützt von OpenAI,
  Gemini (OpenAI-kompatibel), vLLM (guided decoding) und LM Studio. Enums (`yes|no|…`) werden dann erzwungen,
  der „Hardcore-Parser“ wird zur Rückfallebene.
- **Ein Instrument pro Aufruf:** statt eines Riesen-JSON mit JARS + Embedded + Established + Framework + CASQ
  erst Routing (welches Instrument?), dann je Instrument ein kleiner Aufruf mit dessen Signalfragen.
  Kürzere Antworten → weniger abgeschnittene JSONs, bessere Item-Qualität bei kleinen lokalen Modellen.
- **Evidenzkontext abschnittsbasiert:** Überschriften erkennen (Methods/Results/…), pro Instrument die
  relevanten Abschnitte schicken (z.B. RoB-2-Domäne „Missing outcome data“ → Results + Flow-Diagramm).
- **Robustere Zitatprüfung:** zusätzlich zur exakten Suche Fuzzy-Matching (Token-Overlap ≥ 0,85, Silbentrennung
  „-\n“ entfernen, Ligaturen ﬁ/ﬂ normalisieren); sonst werden korrekte Zitate als unverifiziert abgestraft, sobald 2.4 greift.
- **Gesamtwert über Dokumente:** keinen Mittelwert über Designs hinweg; stattdessen Verteilung
  (z.B. „3× Low RoB, 2× Some concerns, 1× High“) und GRADE pro Outcome als eigentliche Synthese.
- **Nachvollziehbarkeit:** Jeder Score speichert `scoring_version`, Rubrik-Hash, Prompt-Version-IDs, Modell
  (siehe `runs`/`run_steps` in 1.5).

### 2.9 Reihenfolge der Scoring-Verbesserungen

| Prio | Maßnahme | Aufwand |
|---|---|---|
| 1 ✅ | Gewichte im Code fixieren, Coverage selbst berechnen (nur verifizierte Belege zählen), CASQ-Spanne | klein |
| 2 ✅ | AMSTAR-2-/COSMIN-/MINORS-/PEDro-Korrekturen (2.5) | klein |
| 3 | CASQ 2.0 mit Prüffragen + Deckel + Spannweite (2.4) | mittel |
| 4 | JSON-Schema-Ausgabe, ein Instrument pro Aufruf | mittel |
| 5 | RoB 2, ROBINS-I, NOS, JBI, QUADAS-2 ergänzen | mittel–groß |
| 6 | Deterministische Signale (statcheck, GRIM, Registrierung, Retractions) | mittel |
| 7 | Mehrfachbewertung + Kalibrierung gegen PEDro-/Cochrane-Daten | groß, aber entscheidend |
