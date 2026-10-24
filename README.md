# Publikations-Agent – Critical Appraisal wissenschaftlicher Literatur

Browser-App, die PDFs mit einer Kette von LLM-Agenten (Extraktion → Appraisal → Validierung → Synthese)
auf Wissenschaftlichkeit prüft und mit etablierten Instrumenten (PEDro, MINORS, AMSTAR 2, COSMIN,
MMAT/CASP, GRADE) sowie dem internen CASQ bewertet.

| Ordner | Inhalt |
|---|---|
| `app/` | Die App (statische Dateien, kein Build-Schritt) |
| `original/` | Die bisherige Einzeldatei-Version v21 als Referenz |
| `docs/` | Vorschlag zu Architektur (Spark-Backend, Sync) und Scoring |
| `tests/` | Unit-Tests der Scoring-Logik und End-to-End-Test im Browser |

## Auf dem Spark ausliefern

Statt der einzelnen HTML-Datei wird der **Ordner `app/`** unter `/lit` ausgeliefert, z.B. mit Tailscale:

```bash
tailscale funnel --bg --set-path /lit /pfad/zu/evaluate_literature/app
```

(Wird `/lit` bisher anders bereitgestellt, z.B. über einen Webserver, genügt es, dort den Ordner statt der
Datei einzutragen.) Aufruf wie bisher: `https://thinkstationpgx-afbe.taildf3925.ts.net/lit` – die Seite
ergänzt den abschließenden Schrägstrich selbst.

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

**Scoring** (Logik in `app/js/scoring.js`)
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
npm test            # Unit-Tests der Scoring-Logik (Node 18+)
npm run test:e2e    # Browser-Test mit Fake-LLM (benötigt Playwright + Chromium)
npm run serve       # App lokal unter http://localhost:8765/lit/
```
