# Publikations-Agent – Critical Appraisal wissenschaftlicher Literatur

Browser-App, die PDFs mit einer Kette von LLM-Agenten (Extraktion → Appraisal → Validierung → Synthese)
auf Wissenschaftlichkeit prüft und mit etablierten Instrumenten (PEDro, MINORS, AMSTAR 2, COSMIN,
MMAT/CASP, GRADE) sowie dem internen CASQ bewertet.

| Ordner | Inhalt |
|---|---|
| `app/` | Die App (statische Dateien, kein Build-Schritt) |
| `server/` | Spark-Backend: Login, SQLite, Synchronisation, Verwaltungsbefehle |
| `deploy/` | systemd-Dienst als Alternative zu Docker |
| `original/` | Die bisherige Einzeldatei-Version v21 als Referenz |
| `docs/` | Vorschlag zu Architektur (Spark-Backend, Sync) und Scoring |
| `tests/` | Unit-Tests der Scoring-Logik und End-to-End-Test im Browser |

## Auf dem Spark betreiben

Der Server (`server/`) liefert die App aus und speichert Konten, Einstellungen, Prompts und Historie in
SQLite. Er hört nur lokal (Standard `127.0.0.1:8080`); nach außen geht es über Tailscale:

```bash
sudo tailscale funnel --bg --set-path /lit http://127.0.0.1:8080
```

(`sudo` ist nötig, solange der eigene Benutzer nicht per `sudo tailscale set --operator=$USER` als
Tailscale-Operator eingetragen ist.)

Der Server versteht Pfade mit und ohne `/lit`-Präfix, es spielt also keine Rolle, ob Tailscale das Präfix
weiterreicht. Aufruf wie bisher: `https://thinkstationpgx-afbe.taildf3925.ts.net/lit`.

**Variante A – Docker** (empfohlen, auf dem Spark muss nichts außer Docker installiert sein).
Einstellungen stehen in der Datei `.env` neben `compose.yaml`. Der Einladungscode ist frei gewählt
(z.B. zufällig erzeugt); ist Port 8080 auf dem Spark schon belegt („port is already allocated“), einen
anderen Port eintragen und beim `tailscale funnel`-Befehl denselben Port verwenden:

```bash
echo "LIT_INVITE_CODE=$(openssl rand -base64 24)" >> .env   # weglassen = Registrierung über die Webseite aus
echo "LIT_HOST_PORT=8091" >> .env                           # nur falls 8080 belegt ist
docker compose up -d --build
curl http://127.0.0.1:8091/lit/api/health                   # Prüfung: {"ok":true,...}
docker compose exec lit node server/cli.js user:add theo          # Konto direkt anlegen (optional)
docker compose exec lit node server/cli.js backup /data/backup.db  # Sicherung
```

**Variante B – direkt mit Node** (≥ 22.13, da `node:sqlite` genutzt wird; keine nativen Pakete):

```bash
npm ci --omit=dev
LIT_INVITE_CODE='<geheimer Code>' npm start       # oder als Dienst: deploy/lit-agent.service
npm run admin -- user:add theo                     # weitere Befehle: user:passwd, user:list, user:delete, backup
```

| Variable | Standard | Bedeutung |
|---|---|---|
| `LIT_INVITE_CODE` | – | Einladungscode für die Registrierung über die Web-Oberfläche. Ohne Code ist Registrierung aus; Konten dann nur per `user:add`. |
| `LIT_DB` | `data/lit.db` | SQLite-Datei |
| `LIT_HOST` / `LIT_PORT` | `127.0.0.1` / `8080` | Adresse des Servers |
| `LIT_SESSION_DAYS` | `30` | Gültigkeit einer Anmeldung |
| `LIT_COOKIE_SECURE` | `true` | nur für lokale Tests ohne HTTPS auf `false` setzen |
| `LIT_LLM_URL` | – | Modell-Server auf dem Spark (OpenAI-kompatibel, z.B. vLLM): `http://10.189.26.81:8000/v1`. Aktiviert den Provider „Spark-Modell“. |
| `LIT_LLM_MODEL` | – | Standardmodell; ohne Angabe das erste, das der Modell-Server meldet |
| `LIT_LLM_KEY` | – | API-Key, falls der Modell-Server einen verlangt (bleibt auf dem Server) |
| `LIT_LLM_TIMEOUT_MIN` | `30` | maximale Dauer einer Modell-Antwort |

Ohne Server (nur die Dateien aus `app/` statisch ausgeliefert) läuft die App weiterhin rein lokal im Browser.

### Spark-Modell von überall nutzen

Ein Modell auf dem Spark (z.B. vLLM auf Port 8000) ist aus dem Browser nicht direkt erreichbar: Die Adresse ist
intern und unverschlüsselt (`http`), und aus einer `https`-Seite blockiert der Browser solche Aufrufe. Der Server
leitet deshalb angemeldete Anfragen weiter (`Browser → https://…/lit/api/llm → Modell-Server`).

1. In `.env` die Adresse des Modells eintragen. Achtung: Im Container ist `127.0.0.1` der Container selbst.
   Mit `sudo ss -ltnp | grep ':8000 '` prüfen, worauf der Modell-Server lauscht:
   - `0.0.0.0:8000` oder `*:8000` → `LIT_LLM_URL=http://host.docker.internal:8000/v1`
   - `127.0.0.1:8000` → Container ins Netz des Spark holen:
     `LIT_LLM_URL=http://127.0.0.1:8000/v1` und `COMPOSE_FILE=compose.yaml:compose.hostnet.yaml`
2. `docker compose up -d --build`
3. In der App unter *Konfiguration* den Provider **„🚀 Spark-Modell“** wählen. Nur für verknüpfte Spark-Konten.

### Konten und Synchronisation

- **Neues Konto:** beim Registrieren den Einladungscode eingeben. Ohne Code entsteht wie bisher ein rein lokales Profil.
- **Bestehendes lokales Profil** (auch aus der alten Einzeldatei-Version): einloggen → *Konfiguration* →
  *Mit Spark verknüpfen*. Danach werden Einstellungen, Prompts und die komplette Historie hochgeladen.
  Kürzere Passwörter als 8 Zeichen müssen dabei durch ein neues ersetzt werden (gilt dann auch lokal).
- **Weiteres Gerät / Handy:** einfach mit Spark-Benutzername und -Passwort einloggen – das Profil wird vom Spark geladen.
- Was synchronisiert wird: Einstellungen (Provider-URLs, Modelle, Limits, System-Prompt), alle Prompt-Versionen
  und die aktive Version je Agent, alle Analyse-Läufe mit Agent-Protokoll, Löschungen.
- **API-Keys werden nie übertragen** und bleiben auf dem jeweiligen Gerät.
- Ohne Verbindung landen Änderungen in einer Warteschlange und werden automatisch nachgereicht
  (Anzeige oben rechts: „☁ synchron“, „☁ 3 ausstehend“, „☁ offline“, „nur lokal“).
- Konflikte: Läufe und Prompt-Versionen werden nur angelegt oder gelöscht, nie überschrieben. Bei Einstellungen
  und der aktiven Prompt-Version gewinnt die zuletzt gemachte Änderung.

## Was sich gegenüber v21 geändert hat

**Speicherung und Offline**
- Daten liegen in **IndexedDB** statt `localStorage` (kein 5-MB-Limit mehr). Beim ersten Start werden Profile
  und Historie der alten Version automatisch übernommen; der alte `localStorage`-Eintrag bleibt als Sicherung.
- Jeder Lauf speichert ein **Agent-Protokoll**: pro Agent-Aufruf Prompt, Prompt-Version, Modell, Rohantwort,
  Tokens und Dauer (Historie → „Agent-Protokoll (JSON)“).
- Prompt-Versionen haben eine feste ID; es werden bis zu 20 statt 5 Versionen je Agent aufbewahrt.
- Historie ohne 20er-Grenze, Einträge einzeln löschbar, **Export/Import** als JSON (Sicherung, Gerätewechsel).
- **Offline-Start**: Service Worker hält App und pdf.js vor (pdf.js liegt jetzt in `app/vendor/`, nicht mehr
  auf einem CDN). Auf dem Handy über „Zum Home-Bildschirm“ als App installierbar. Ohne Netz funktionieren nur
  Modelle auf demselben Gerät (z.B. LM Studio auf dem Laptop).
- Einfaches **mobiles Layout**.

**CASQ 2.0: Prüffragen statt freier Punkte** (Logik in `app/js/scoring.js`)
- Je Dokumenttyp (quantitativ, qualitativ, Mixed Methods, systematisches Review, theoretisch, Methodenbeitrag,
  Multiple-Study-Report, narrative Übersicht) gibt es eine feste Rubrik mit 13–27 konkreten, im Text prüfbaren
  Prüffragen. Welche Rubrik gilt, entscheidet das Programm anhand der Extraktion.
- Agent 3 beantwortet jede Frage mit ja / teilweise / nein / nicht berichtet / nicht anwendbar und Belegstelle,
  Agent 4 korrigiert. Das Modell vergibt keine Punkte mehr.
- Berechnung: ja = 1, teilweise = 0,5, nein / nicht berichtet = 0; „ja/teilweise“ ohne im PDF auffindbares Zitat
  eine Stufe herab; Teilscore = 10 × Mittelwert je Dimension; CASQ = gewichtetes Mittel (Gewichte wie bisher).
- Kritische Fragen (z.B. „Verfahren passen zu Design und Daten“, „mind. zwei Datenbanken durchsucht“) begrenzen
  den CASQ bei einem Mangel auf 5, bei mehreren auf 3.
- Angezeigt werden zusätzlich Informationsgrad, Belegquote, kritische Mängel, Spanne und die komplette
  Prüffragen-Tabelle mit Antworten und Belegen.

**Fachspezifische Rubriken statt medizinischer Instrumente (Marketing, Medien, Digitalisierung, E-Commerce, Handel)**
- Leitprinzip: Das Gewicht liegt auf den methodenspezifischen Prüfkriterien (Einzelfragen mit Beleg). Der CASQ fasst sie nur zu einem
  **intern berechneten Vergleichsindex** zusammen, er ist kein offizieller Score. Bei jedem Ergebnis steht, worauf die Rubrik beruht.
- Agent 2 bestimmt eine Methodenklasse (`method_class`). Neue Rubriken: **Befragung / SEM / PLS-SEM** (Messmodell, Strukturmodell,
  Stichprobe, Common Method Bias, Robustheit), **Experiment / A/B-Test** (Zuteilung, Manipulationscheck, Power, Effektgrößen, Störgrößen)
  und **Plattform-/Social-Media-/Big-Data-Studie** (Datenherkunft, Selektion, Bots, Plattformeffekte, Leakage, kausale Aussagen,
  Reproduzierbarkeit, Datenschutz). Klinische Studien behalten die allgemeine quantitative Rubrik.
- Weitere Rubriken: **Fallstudie** (Fallauswahl, Datenquellen, Triangulation, Beweiskette, Within-/Cross-Case-Analyse),
  **bibliometrische Analyse** (Datenbank, Suchstring, Bereinigung, Software und Parameter, Clusterdeutung),
  **Skalenentwicklung** (Konstrukt, Items, EFA/CFA, Reliabilität, Validität, Kreuzvalidierung) und
  **systematisches Review in Management/Marketing/Digital** (PRISMA 2020 und SPAR-4-SLR). Dort wird die
  **PRISMA-Berichtserfüllung** getrennt vom CASQ als interner Erfüllungsgrad ausgewiesen, nicht als „PRISMA-Score“.
- PEDro, MINORS, AMSTAR 2 und COSMIN werden nur bei Gesundheitsbezug angewendet (der Code entscheidet anhand der Extraktion; im
  Dashboard unter „Fachgebiet“ lässt sich das aufheben). Der Quellcode der Instrumente bleibt erhalten.
- Die Kriterien sind aus etablierten Methodenempfehlungen abgeleitet, aber keine offiziellen Instrumente; sie sollten fachlich
  durchgesehen werden. Geplant: Zeitschriftenkontext.
- Die Prompts von Agent 3 und 4 wurden dafür angepasst (Platzhalter `{{CASQ_RUBRIC}}`, `{{CASQ_CHECKLIST}}`) und
  beim nächsten Login automatisch als neue aktive Version gesetzt; frühere Versionen bleiben in der Versionsauswahl.
  Mit einem älteren Prompt ohne Prüffragen rechnet die App wie bisher über die Dimensionen.

**Weitere LLM-Verbindungen und sichere API-Keys**
- **🎓 Hochschul-API** und **🔌 Eigener Endpunkt** (beide OpenAI-kompatibel, direkt aus dem Browser): Endpunkt-URL und
  API-Key eintragen → *Modelle suchen* (`GET {url}/models`; Embedding-, Audio- und Reranker-Modelle werden
  ausgeblendet) → Modell wählen → *Modell aktivieren*. Die Hochschul-API enthält die Hinweise zum Zugang
  (portal.rh-koeln.de/chatai-access-token) und zur Modellauswahl (Modellübersicht der GWDG). Der Dienst muss
  Browser-Zugriffe (CORS) erlauben; sonst nennt die App den Grund bei der Modellsuche bzw. im Terminal.
- **API-Keys mit AES-256-GCM** (WebCrypto) statt XOR: Schlüssel per PBKDF2-SHA-256 (310.000 Runden, eigenes Salz je
  Profil) aus dem Passwort, jeder Key mit eigenem IV, der Feldname ist gebunden. Auch die lokale Passwortprüfung
  nutzt jetzt diese Ableitung statt des alten djb2-Hashs (mit dem sich das Passwort offline in Sekunden hätte raten
  lassen). Profile der alten Version werden beim nächsten Login automatisch umgestellt. WebCrypto gibt es nur über
  https oder localhost – über eine reine http-Adresse bleibt es beim alten Verfahren (die App zeigt das an), und ein
  bereits umgestelltes Profil lässt sich dort nicht öffnen.

**Zuverlässigkeit messen** (`app/js/reliability.js`, `reliability-ui.js`, Tab „Zuverlässigkeit“)
- **Mehrfachbewertung:** Auf dem Dashboard „Durchläufe je PDF“ auf 3 oder 5 stellen. Agent 3 und 3b laufen dann mehrfach
  (mit eigener Temperatur, Standard 0,4 – bei 0 wären alle Durchläufe gleich); je Frage und je Instrument-Item entscheidet
  die Mehrheit (bei Gleichstand die vorsichtigere Antwort), Agent 4/4b validieren das Ergebnis einmal. Je PDF steht dort:
  CASQ je Durchlauf mit Median, Spanne und SD, Übereinstimmung der Prüffragen (Anteil, Fleiss-κ), das Instrument-Ergebnis
  je Durchlauf und die **unsicheren Fragen**, bei denen sich die Durchläufe nicht einig waren. Kosten: 2 Modellaufrufe je
  zusätzlichem Durchlauf und PDF.
- **Abgleich mit Expertenbewertungen:** Im Tab Referenzen eintragen (PEDro-Gesamtwert, AMSTAR 2, CASQ) oder per CSV
  importieren (*Vorlage laden* liefert die Spalten und Ihre Dokumente; zusätzlich PEDro-Items 2–11 als ja/nein; Zuordnung
  über Dateiname oder DOI), z.B. aus der PEDro-Datenbank (pedro.org.au) oder aus einer eigenen Doppelbewertung.
  Ausgewertet wird **je Modell** (jeweils der letzte Lauf je Dokument), damit sich Modelle vergleichen lassen:
  PEDro-Summe und CASQ: mittlere Abweichung, systematische Verschiebung, Korrelation, ICC(2,1), Übereinstimmungsgrenzen;
  PEDro-Items und AMSTAR 2: Übereinstimmung, Cohens κ (AMSTAR 2 linear gewichtet), PABAK; Intervalle per Bootstrap.
  Unter 5 Dokumenten warnt die App; für eine belastbare Aussage werden 30–50 doppelt bewertete Dokumente empfohlen.
  Referenzen bleiben auf dem Gerät (nicht synchronisiert), sind aber Teil von Export/Import.

**Strukturierte JSON-Ausgabe, ein Instrument je Aufruf** (`app/js/schemas.js`)
- Jeder Agent schickt ein JSON-Schema als `response_format: json_schema` mit (strikter Modus: alle Felder Pflicht,
  feste Werte für Entscheidungsfelder, bei den CASQ-Prüffragen nur die IDs der gewählten Rubrik). vLLM, OpenAI und
  LM Studio erzwingen damit Aufbau und erlaubte Werte – keine abgeschnittenen oder kaputten Antworten mehr durch
  Formatfehler. Lehnt ein Server Schemata ab, nutzt die App automatisch den bisherigen JSON-Modus und merkt sich das
  (Tooltip der Status-Lampe). Im Thinking-Modus wird kein Schema erzwungen.
- Agent 3 bewertet nur noch Instrumente (JARS, PEDro/MINORS/AMSTAR 2/COSMIN, MMAT/CASP, Bias); die CASQ-Prüffragen
  beantwortet **Agent 3b** in einem eigenen Aufruf, validiert von **Agent 4b**. Kürzere Antworten je Aufruf, dafür
  zwei Aufrufe mehr pro PDF. Beide haben eigene, versionierte Prompts; die Prompts von Agent 3 und 4 werden beim
  nächsten Login automatisch auf die verkleinerte Fassung umgestellt (alte Versionen bleiben auswählbar).

**PDF-Einlesen: Layout, Tabellen, Abbildungen** (`app/js/pdf-extract.js`)
- Der Text wird aus den Positionen der Textstücke zeilenweise rekonstruiert; Tabellenspalten werden durch
  Tabulatoren getrennt, Wortteile ohne Abstand nicht mehr zerrissen. Tabellen kommen so zeilenweise mit
  getrennten Zellen bei den Agenten an. Die Reihenfolge folgt weiter der PDF-Datei (zweispaltige Layouts bleiben lesbar).
- Je Seite werden Tabellen (Beschriftung oder Spaltenzeilen), Abbildungen (Beschriftung) und Bilder erkannt.
- Seiten ohne Textschicht (gescannt) werden gemeldet; hat das ganze PDF keine Textschicht, wird es mit einem
  klaren Hinweis übersprungen statt mit leerem Text analysiert (OCR gibt es nicht).
- Häkchen **„Tabellen und Abbildungen zusätzlich als Bild an das LLM“**: Die App prüft mit einem kleinen
  Testbild, ob das gewählte Modell Bilder verarbeitet (Ergebnis unter dem Häkchen und in der Status-Lampe:
  „🖼️ Bilder“ bzw. „nur Text“). Wenn ja, gehen bis zu 6 Seiten mit Tabellen/Abbildungen als Bild an Agent 2
  (Extraktion) und Agent 6 (Integrität). Wenn nein – oder lehnt der Server Bilder später ab –, läuft die Analyse
  nur mit Text weiter. Bei jeder Publikation steht, wie sie gelesen wurde (Seiten, Tabellen, Abbildungen,
  ob als Bild ausgewertet).

**Integritätsprüfung – rechnerisch und per LLM zum Vergleich** (`app/js/integrity.js`, Agent 6)
- Auswahl per Häkchen auf dem Dashboard: *rechnerisch*, *online bei Crossref*, *per LLM*. Alle drei sind
  voreingestellt; die Auswahl wird mit dem Profil synchronisiert.
- Rechnerisch (im Browser, gesamter PDF-Text):
  - **statcheck:** t, F, χ², r und z mit Freiheitsgraden und p-Wert werden erkannt und der zweiseitige p-Wert
    exakt nachgerechnet (Rundung berücksichtigt). Markiert werden Abweichungen und Fälle, in denen sich die
    Signifikanz bei α = .05 ändert; „einseitig?“, wenn die Angabe nur einseitig passt.
  - **GRIM:** Mittelwert und n in einer Klammer werden darauf geprüft, ob sie bei ganzzahligen Einzelwerten möglich sind.
  - **Stichprobengrößen:** alle N/n-Angaben, mehrere verschiedene Gesamt-N, Abgleich mit dem extrahierten N.
  - **Registrierung:** NCT, DRKS, ISRCTN, PROSPERO (CRD), ANZCTR, ChiCTR, EudraCT, OSF, AsPredicted, INPLASY – mit Links.
  - **DOI** der Publikation; online zusätzlich Crossref-Metadaten, Titelabgleich mit dem PDF und
    **Retractions, Corrections, Expressions of Concern** (Crossref enthält die Daten von Retraction Watch).
- Per LLM: Agent 6 bekommt dieselben Aufgaben (eigener, versionierter Prompt im Tab *Prompts & Info*).
- Ergebnis: Code und LLM nebeneinander, statistische Angaben einander zugeordnet, Übereinstimmungsquote.
  Die Auffälligkeiten gehen zusätzlich an die Synthese (Agent 5).

**Status-Lampe** neben „Workflow Status & Ergebnisse“: grün = Modell erreichbar (mit Modellname), gelb = eingestelltes
Modell nicht in der Modellliste, rot = nicht erreichbar bzw. API-Key fehlt. Geprüft wird beim Login, nach jeder
Änderung der Einstellungen, alle 2 Minuten und per Klick; nach jedem Modellaufruf zeigt sie das Modell, das tatsächlich
geantwortet hat.

**Scoring – frühere Korrekturen**
- **CASQ-Gewichte sind fest im Code** (Rubriken wie in Agent 3 beschrieben) und werden nicht mehr aus der
  Modellantwort übernommen. Die Dimensionsnamen des Modells werden der passenden Rubrik zugeordnet; passt keine,
  wird das in der Ergebnisansicht angezeigt und es gelten wie bisher die Modell-Gewichte.
  Gewichtsänderungen im Prompt wirken sich deshalb nicht mehr auf den Score aus.
- **CASQ-Spanne**: zusätzlich der Wert, wenn nicht belegbare Dimensionen mit 0 bzw. 10 Punkten zählen würden.
  Eine breite Spanne heißt: Das Paper berichtet zu wenig für ein belastbares Urteil.
- **Evidenzabdeckung wird berechnet** (Gewichtsanteil der Dimensionen mit im PDF wiedergefundenem Zitat) statt
  von Agent 4 übernommen; dessen Angabe wird nur noch zum Vergleich angezeigt. Dadurch fällt der Wert in der
  Regel niedriger aus als bisher, und das Label „UNSICHER“ erscheint häufiger, wenn Zitate nicht auffindbar sind.
- **Zitatprüfung robuster**: Silbentrennung, Ligaturen und kleine Abweichungen (≥ 80 % übereinstimmende Wortfolgen).
- **AMSTAR 2**: kritische Items fest 2, 4, 7, 9, 11, 13, 15 (nicht mehr vom Modell markiert).
- **COSMIN**: „worst score counts“ wird berechnet; ein abweichendes Modell-Rating wird angezeigt.
- **MINORS**: komparativ/nicht-komparativ aus der Extraktion, Zählung nach Item-Nummer statt Reihenfolge.
- **PEDro**: fehlende Items werden als „unvollständig“ gekennzeichnet.
- Agent 5 erhält zusätzlich das berechnete Instrument-Ergebnis.
- Fehlerbehebung: PDF-Text mit `$&`, `$'` usw. wurde beim Einsetzen in die Prompts verfälscht.

Die Prompts selbst sind unverändert.

## Tests

```bash
npm test            # Scoring- und Server-Tests (Node ≥ 22.13)
npm run test:e2e    # Browser-Tests mit Fake-LLM: ohne Backend sowie Synchronisation mit echtem Server
npm run serve       # nur die App, ohne Backend, unter http://localhost:8765/lit/
```
