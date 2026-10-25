// End-to-End-Test im echten Chromium: Migration aus localStorage, kompletter Analyse-Lauf gegen einen
// Fake-LLM, Speicherung in IndexedDB, Agent-Protokoll, Export und Offline-Start über den Service Worker.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startStaticServer } = require('./static-server');
const { startMockLLM, QUOTES } = require('./mock-llm');

const APP_PORT = 8765;
const LLM_PORT = 8766;
const APP_URL = `http://localhost:${APP_PORT}/lit`;

// Gleiches Verfahren wie hashString() der App (djb2), um ein Profil der alten Version nachzubilden.
function legacyHash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) { hash = ((hash << 5) + hash) + str.charCodeAt(i); }
    return hash.toString();
}

// Altes "Verschlüsselungs"-Verfahren der Einzeldatei (XOR mit dem Passwort, Base64)
function legacyXor(text, password) {
    return Buffer.from(Array.from(text, (c, i) => String.fromCharCode(c.charCodeAt(0) ^ password.charCodeAt(i % password.length))).join(''), 'latin1').toString('base64');
}

const legacyProfile = {
    alt: {
        passHash: legacyHash('pw'),
        keys: { activeProvider: 'custom1', custom1Url: 'http://localhost:1/v1', custom1Key: legacyXor('alt-geheim', 'pw'), custom1Model: '', maxEvidence: 50000, maxTokens: 8192, temperature: 0 },
        prompts: { extraction: [{ text: 'alter Prompt', date: '1.1.2026, 10:00:00' }] },
        history: [{ date: '1.1.2026, 10:05:00', model: 'altes-modell', provider: 'custom2', extractions: [{ title: 'alt.pdf' }], validation: { casq_score: 6.1, overall_quality: 'MITTEL' }, study_results: [] }]
    }
};

async function makePdf(browser, file) {
    const page = await browser.newPage();
    await page.setContent(`<html><body style="font-family:sans-serif;font-size:12pt">
        <h1>Supervised exercise for chronic low back pain</h1>
        <p>doi: 10.1234/test.2026.001 · Registered at ClinicalTrials.gov (NCT01234567).</p>
        <p>${QUOTES.rq}</p><p>${QUOTES.alloc}</p><p>${QUOTES.stats}</p>
        <p>Table 1. Baseline characteristics</p>
        <table style="width:100%;border-collapse:collapse"><tr><td></td><td>Group A</td><td>Group B</td></tr>
        <tr><td>Age</td><td>54.2</td><td>55.1</td></tr><tr><td>Women</td><td>18</td><td>17</td></tr></table>
        <p>In total N = 60 patients took part. Pain decreased, t(28) = 2.10, p = .045, and the group effect was F(2, 57) = 1.20, p < .05.</p>
        <div style="page-break-before:always"></div>
        <h2>Discussion</h2><p>${QUOTES.limits}</p></body></html>`);
    await page.pdf({ path: file, format: 'A4' });
    await page.close();
}

async function login(page, user, pass, action = 'login') {
    await page.waitForSelector('.auth-btn:not([disabled])');
    await page.fill('#login-user', user);
    await page.fill('#login-pass', pass);
    await page.click(action === 'login' ? 'text=Einloggen' : 'text=Neu registrieren');
    await page.waitForSelector('#app-screen', { state: 'visible' });
}

(async () => {
    const appServer = await startStaticServer(APP_PORT);
    const llm = await startMockLLM(LLM_PORT);
    const browser = await chromium.launch();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-e2e-'));
    const pdfFile = path.join(tmp, 'studie-$&-test.pdf');
    const errors = [];
    let ok = false;
    try {
        await makePdf(browser, pdfFile);
        const context = await browser.newContext({ acceptDownloads: true });
        await context.addInitScript(data => {
            if (!localStorage.getItem('agentUsers')) localStorage.setItem('agentUsers', data);
        }, JSON.stringify(legacyProfile));
        const page = await context.newPage();
        page.on('pageerror', e => errors.push(e.message));
        // Ohne Backend antwortet api/… mit 404 – das ist hier der erwartete Betriebsmodus.
        // Ohne Backend antwortet api/… mit 404, und die Status-Lampe prüft absichtlich auch unerreichbare
        // Modell-Adressen – beides erzeugt erwartete Ladefehler fremder Adressen.
        page.on('console', m => {
            const url = String(m.location()?.url);
            if (m.type() === 'error' && !url.includes('/api/') && (!url.startsWith('http') || url.startsWith(`http://localhost:${APP_PORT}/`))) errors.push(m.text());
        });

        // 1) /lit ohne Schrägstrich wird auf /lit/ umgeleitet, Migration läuft
        await page.goto(APP_URL);
        await page.waitForURL(`${APP_URL}/`);
        await page.waitForFunction(() => document.getElementById('storage-status').textContent.includes('übernommen'));
        console.log('✓ Umleitung /lit → /lit/ und Migration:', await page.textContent('#storage-status'));
        // Vor der Umleitung lädt der Browser css/ und js/ einmal relativ zu /lit → erwartete 404.
        errors.length = 0;

        // 2) Login mit altem Profil, Prompt-Versionen haben IDs
        await login(page, 'alt', 'pw');
        const promptInfo = await page.evaluate(() => getUserDB().alt.prompts.extraction.map(p => ({ id: !!p.id, createdAt: !!p.createdAt })));
        assert.ok(promptInfo.length >= 2 && promptInfo.every(p => p.id && p.createdAt), 'Prompt-Versionen ohne ID');
        console.log(`✓ Login mit migriertem Profil, ${promptInfo.length} Extraction-Prompt-Versionen mit ID`);

        // Alter Key (XOR) wird gelesen und beim Login auf AES umgestellt; djb2-Hash wird durch PBKDF2-Prüfwert ersetzt
        assert.equal(await page.inputValue('#custom1-key'), 'alt-geheim', 'alter Key nicht entschlüsselt');
        await page.waitForFunction(() => getUserDB().alt.keys.custom1Key.startsWith('aes1:'));
        const migrated = await page.evaluate(() => { const p = getUserDB().alt; return { auth: p.auth?.v, passHash: p.passHash, iter: p.auth?.iter, hasPlain: JSON.stringify(p).includes('alt-geheim') }; });
        assert.deepEqual(migrated, { auth: 2, passHash: undefined, iter: 310000, hasPlain: false }, 'Umstellung auf AES unvollständig');
        console.log('✓ Alter Key entschlüsselt und auf AES-256 umgestellt, Passwortprüfung auf PBKDF2 (310.000 Runden)');

        // Status-Lampe: altes Profil zeigt auf einen nicht erreichbaren Server → rot
        await page.waitForFunction(() => document.getElementById('llm-lamp').classList.contains('err'));
        console.log('✓ Status-Lampe rot bei unerreichbarem Modell:', await page.textContent('#llm-status-text'));

        // 3) Provider auf den Fake-LLM stellen und Analyse ausführen
        await page.click('nav button[data-tab="config"]');
        await page.fill('#custom1-url', `http://localhost:${LLM_PORT}/v1`);
        await page.dispatchEvent('#custom1-url', 'change');
        await page.waitForFunction(() => document.getElementById('llm-lamp').classList.contains('ok'));
        assert.equal(await page.textContent('#llm-status-text'), 'Lokales Profil 1 · mock-model');
        console.log('✓ Status-Lampe grün mit Modellname nach Umstellung:', await page.textContent('#llm-status-text'));
        await page.click('nav button[data-tab="dashboard"]');
        await page.uncheck('#opt-integrity-online');   // kein Internet im Test
        // Drag & Drop: ein PDF und eine Nicht-PDF-Datei auf die Ablagefläche ziehen
        const pdfBase64 = fs.readFileSync(pdfFile).toString('base64');
        const dataTransfer = await page.evaluateHandle(({ b64, name }) => {
            const dt = new DataTransfer();
            const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            dt.items.add(new File([bytes], name, { type: 'application/pdf' }));
            dt.items.add(new File(['x'], 'notiz.txt', { type: 'text/plain' }));
            return dt;
        }, { b64: pdfBase64, name: path.basename(pdfFile) });
        await page.dispatchEvent('.file-drop', 'dragover', { dataTransfer });
        await page.dispatchEvent('.file-drop', 'drop', { dataTransfer });
        const dropped = await page.evaluate(() => selectedFiles.map(f => f.name));
        assert.deepEqual(dropped, [path.basename(pdfFile)], 'Drag & Drop hat nicht genau das PDF übernommen');
        console.log('✓ Drag & Drop: PDF angenommen, andere Datei ignoriert');
        await page.click('#btn-start');
        await page.waitForSelector('#results-view.active', { timeout: 60000 });
        assert.equal(llm.calls.length, 7, 'erwartet 7 LLM-Aufrufe (Agenten 2, 3, 3b, 4, 4b, 6, 5)');
        assert.ok(llm.formats.every(f => f === 'json_schema'), 'nicht alle Aufrufe mit JSON-Schema: ' + llm.formats.join(','));
        assert.ok(!llm.calls.find(c => c.includes('Du bist Agent 3,')).includes('QN-1.1'), 'Agent 3 darf keine CASQ-Prüffragen mehr bekommen');
        assert.ok(llm.calls.find(c => c.includes('Du bist Agent 3b')).includes('QN-2.2 [Design appropriateness]'), 'Agent 3b ohne Prüffragen');
        console.log('✓ Ein Instrument je Aufruf (Agent 3/3b, 4/4b), alle 7 Aufrufe mit JSON-Schema');
        // Layout-Extraktion: Tabellenzeile kommt mit getrennten Zellen beim Modell an
        assert.match(llm.calls[0], /Age\t54\.2\t55\.1/, 'Tabellenzeile nicht in Zellen getrennt');
        // Seite mit Tabelle ging als Bild an Agent 2 und Agent 6
        assert.deepEqual(llm.imageCalls.map(c => c.agent).sort(), ['2', '6']);
        assert.ok(llm.calls[0].includes('ZUSÄTZLICH: Angehängt sind Bilder dieser PDF-Seiten: S. 1 (Tabelle)'), 'Bildhinweis fehlt im Prompt');
        assert.match(await page.textContent('#llm-status-text'), /🖼️ Bilder/);
        const sourceInfo = await page.textContent('.source-info');
        assert.ok(sourceInfo.includes('Tabellen: S. 1') && sourceInfo.includes('als Bild ausgewertet: S. 1'), 'Quelleninfo falsch: ' + sourceInfo);
        console.log('✓ Tabelle zeilenweise mit Zellen extrahiert, Seitenbild an Agent 2 und 6, Hinweis:', sourceInfo.trim());
        assert.match(await page.textContent('#llm-status-text'), /^Lokales Profil 1 · mock-model · 🖼️ Bilder$/, 'Lampe zeigt nicht das antwortende Modell');
        const integ = await page.textContent('#res-studies');
        assert.ok(integ.includes('INTEGRITÄTSPRÜFUNG'), 'Integritätsprüfung fehlt');
        assert.ok(integ.includes('2 Tests1 abweichend · 1 Signifikanz geändert'), 'statcheck-Zusammenfassung falsch');
        assert.ok(integ.includes('50 %'), 'Übereinstimmung Code/LLM falsch');
        assert.ok(integ.includes('NCT01234567 (ClinicalTrials.gov'), 'Registrierung fehlt');
        assert.ok(integ.includes('Testfazit Integrität.'), 'LLM-Fazit fehlt');
        console.log('✓ Integritätsprüfung: statcheck findet den Fehler, LLM nicht → Übereinstimmung 50 %');
        assert.ok(llm.calls[0].includes(QUOTES.rq), 'PDF-Text fehlt im Extraction-Prompt');

        const study = await page.textContent('#res-studies');
        assert.ok(study.includes('4 / 10 (unvollständig)'), 'PEDro-Anzeige fehlt');
        assert.ok(study.includes('PEDro-Items fehlen'), 'Hinweis auf fehlende PEDro-Items fehlt');
        assert.ok(study.includes('CASQ intern: 8.7 / 10 (Spanne 8.7–9.2)'), 'CASQ/Spanne falsch: ' + (study.match(/CASQ intern: [^|]*/) || [''])[0]);
        assert.ok(study.includes('Informationsgrad: 96 %'), 'Informationsgrad falsch');
        assert.ok(study.includes('Belege verifiziert: 96 %'), 'Belegquote falsch');
        assert.ok(study.includes('CASQ (INTERNER INDEX) · Quantitativ'), 'Rubrik fehlt');
        assert.ok(study.includes('Methodische Grundlage der Prüffragen') && study.includes('kein offizieller Score'), 'Grundlage/Kennzeichnung als interner Index fehlt');
        assert.ok(study.includes('kein Zitat im PDF gefunden'), 'Herabstufung ohne Beleg nicht angezeigt');
        assert.ok(study.includes('Prüffragen (27)'), 'Prüffragen-Tabelle fehlt');
        const analysisPrompt = llm.calls.find(c => c.includes('Du bist Agent 3b'));
        assert.ok(analysisPrompt.includes('QN-2.2 [Design appropriateness]') && !analysisPrompt.includes('{{CASQ_CHECKLIST}}'), 'Prüffragen nicht im Prompt');
        assert.ok(study.includes('Testvalidierung $& mit Sonderzeichen.'), 'Sonderzeichen verfälscht');
        console.log('✓ Analyse-Lauf: PEDro 4/10 (unvollständig), CASQ 2.0 = 8.7 (Spanne 8.7–9.2), Informationsgrad 96 %, Belege 96 %');

        // Modell ohne Bildverarbeitung: Prüfung erkennt das, Hinweis und Lampe zeigen „nur Text“
        llm.state.vision = false;
        await page.click('text=Bildverarbeitung jetzt prüfen');
        await page.waitForFunction(() => document.getElementById('vision-hint').classList.contains('no'));
        assert.match(await page.textContent('#vision-hint'), /verarbeitet keine Bilder/);
        await page.waitForFunction(() => document.getElementById('llm-status-text').textContent.includes('nur Text'));
        llm.state.vision = true;
        console.log('✓ Modell ohne Bildverarbeitung erkannt:', await page.textContent('#vision-hint'));

        // Server ohne JSON-Schema: Rückfall auf einfachen JSON-Modus, Ergebnis kommt trotzdem
        llm.state.jsonSchema = false;
        const fallback = await page.evaluate(async () => {
            const answer = parseJSONRobust(await callLLM('Du bist Agent 5 – Test', { schema: agentSchema('synthesis') }));
            return { support: Object.values(structuredOutputSupport), summary: answer.narrative_summary };
        });
        llm.state.jsonSchema = true;
        assert.ok(fallback.support.includes('no'), 'Ablehnung des Schemas nicht vermerkt');
        assert.equal(fallback.summary, 'Testsynthese.');
        console.log('✓ Server ohne JSON-Schema: automatischer Rückfall auf einfachen JSON-Modus');

        // Hochschul-API: URL und Key eintragen, Modelle suchen, Modell wählen und aktivieren
        llm.state.requireKey = 'sk-hs-123';
        await page.click('nav button[data-tab="config"]');
        await page.selectOption('#llm-provider', 'hochschule');
        await page.fill('#hochschule-url', `http://localhost:${LLM_PORT}/v1`);
        await page.dispatchEvent('#hochschule-url', 'change');
        await page.click('#settings-hochschule >> text=Modelle suchen');
        await page.waitForFunction(() => document.getElementById('hochschule-search-status').textContent.includes('API-Key'));
        assert.match(await page.textContent('#hochschule-search-status'), /Bitte zuerst den API-Key/, 'ohne Key muss gewarnt werden');
        await page.fill('#hochschule-key', 'falscher-key');
        await page.click('#settings-hochschule >> text=Modelle suchen');
        await page.waitForFunction(() => document.getElementById('hochschule-search-status').classList.contains('err') && document.getElementById('hochschule-search-status').textContent.includes('ungültig'));
        await page.fill('#hochschule-key', 'sk-hs-123');
        await page.dispatchEvent('#hochschule-key', 'change');
        await page.click('#settings-hochschule >> text=Modelle suchen');
        await page.waitForFunction(() => document.getElementById('hochschule-search-status').classList.contains('ok'));
        const hsOptions = await page.$$eval('#hochschule-model option', o => o.map(x => x.value));
        assert.deepEqual(hsOptions, ['mock-model', 'zweites-modell'], 'Embedding-Modell muss ausgeblendet sein');
        assert.match(await page.textContent('#hochschule-search-status'), /2 Modell\(e\) gefunden \(1 Embedding/);
        await page.selectOption('#hochschule-model', 'zweites-modell');
        await page.click('#settings-hochschule >> text=Modell aktivieren');
        await page.waitForFunction(() => document.getElementById('llm-status-text').textContent === 'Hochschul-API · zweites-modell');
        assert.equal(await page.inputValue('#llm-provider'), 'hochschule');
        assert.match(await page.textContent('#hochschule-active'), /Aktiv: Hochschul-API · zweites-modell/);
        const hsCall = await page.evaluate(async () => parseJSONRobust(await callLLM('Du bist Agent 5 – Test', {})).narrative_summary);
        assert.equal(hsCall, 'Testsynthese.', 'Aufruf mit Key über die Hochschul-API fehlgeschlagen');
        const hsStored = await page.evaluate(() => { const k = getUserDB().alt.keys; return { key: k.hochschuleKey, models: k.hochschuleModels, model: k.hochschuleModel }; });
        assert.ok(hsStored.key.startsWith('aes1:') && !hsStored.key.includes('sk-hs'), 'Hochschul-Key nicht verschlüsselt');
        assert.deepEqual(hsStored.models, ['mock-model', 'zweites-modell']);
        assert.equal(hsStored.model, 'zweites-modell');
        console.log('✓ Hochschul-API: Modelle gesucht (Embedding ausgeblendet), Modell aktiviert, Aufruf mit Key, Key verschlüsselt');

        // Hochschul-API: Antwort als Datenstrom, bei 500 mit Schema Rückfall ohne Schema, Streaming-Ablehnung wird umgangen
        await page.selectOption('#llm-provider', 'hochschule');
        await page.dispatchEvent('#llm-provider', 'change');
        const hsChat = () => page.evaluate(async () => {
            const answer = parseJSONRobust(await callLLM('Du bist Agent 5 – Test', { schema: agentSchema('synthesis') }));
            return answer.narrative_summary;
        });
        const beforeStream = llm.state.streamed.length;
        assert.equal(await hsChat(), 'Testsynthese.');
        assert.equal(llm.state.streamed.length, beforeStream + 1, 'Antwort kam nicht als Datenstrom');
        console.log('✓ Hochschul-API: Antwort als Datenstrom gelesen (reasoning-Teile ignoriert)');
        llm.state.failSchema500 = 1;
        const formatsBefore = llm.formats.length;
        assert.equal(await hsChat(), 'Testsynthese.');
        assert.deepEqual(llm.formats.slice(formatsBefore), ['none'], 'Wiederholung ohne Schema fehlt');
        console.log('✓ Serverfehler 500 mit JSON-Schema: automatischer neuer Versuch ohne Schema');
        llm.state.rejectStream = true;
        assert.equal(await hsChat(), 'Testsynthese.');
        llm.state.rejectStream = false;
        assert.equal(await page.evaluate(() => Object.values(streamingSupport)[0]), 'no', 'Streaming-Ablehnung nicht vermerkt');
        console.log('✓ Server lehnt Streaming ab: Rückfall auf normale Antwort');
        await page.evaluate(() => { for (const k of Object.keys(streamingSupport)) delete streamingSupport[k]; });
        // Gateways liefern den Datenstrom oft mit falschem Content-Type (z.B. text/plain) oder ignorieren Streaming ganz
        llm.state.sseContentType = 'text/plain';
        assert.equal(await hsChat(), 'Testsynthese.');
        llm.state.sseContentType = 'application/json';
        assert.equal(await hsChat(), 'Testsynthese.');
        llm.state.sseContentType = 'text/event-stream';
        llm.state.streamAsOneJson = true;
        assert.equal(await hsChat(), 'Testsynthese.');
        llm.state.streamAsOneJson = false;
        console.log('✓ Datenstrom mit falschem Content-Type und Server ohne Streaming werden erkannt');
        llm.state.requireKey = null;

        // Eigener Endpunkt ohne Key
        llm.state.requireKey = null;
        await page.selectOption('#llm-provider', 'endpoint');
        await page.fill('#endpoint-url', `http://localhost:${LLM_PORT}/v1/`);
        await page.dispatchEvent('#endpoint-url', 'change');
        await page.click('#settings-endpoint >> text=Modelle suchen');
        await page.waitForFunction(() => document.getElementById('endpoint-search-status').classList.contains('ok'));
        await page.click('#settings-endpoint >> text=Modell aktivieren');
        await page.waitForFunction(() => document.getElementById('llm-status-text').textContent === 'Eigener Endpunkt · mock-model');
        console.log('✓ Eigener Endpunkt: Modelle gesucht und aktiviert:', await page.textContent('#llm-status-text'));

        // zurück auf Lokales Profil 1 für die weiteren Prüfungen
        await page.selectOption('#llm-provider', 'custom1');
        await page.dispatchEvent('#llm-provider', 'change');
        await page.waitForFunction(() => document.getElementById('llm-status-text').textContent.startsWith('Lokales Profil 1'));

        // 4) Lauf + Agent-Protokoll in IndexedDB
        const stored = await page.evaluate(async () => {
            const runs = await listRuns('alt');
            const steps = await getRunSteps(runs[0].id);
            return { runs: runs.length, legacy: runs.filter(r => r.legacy).length, steps: steps.map(s => s.agent), hasPrompt: steps.every(s => s.prompt && s.response && s.prompt_version_id) };
        });
        assert.deepEqual(stored.steps, ['extraction', 'analysis', 'casq', 'validation', 'casq_validation', 'integrity', 'synthesis']);
        assert.equal(stored.runs, 2);
        assert.equal(stored.legacy, 1);
        assert.ok(stored.hasPrompt, 'Protokoll unvollständig');
        console.log('✓ IndexedDB: 2 Läufe (1 übernommen), Protokoll mit 7 Schritten inkl. Prompt-Version');

        // 5) Historie, Export, Agent-Protokoll-Download
        await page.click('nav button[data-tab="history"]');
        await page.waitForSelector('.history-item >> nth=1');
        let download = await Promise.all([page.waitForEvent('download'), page.click('text=Agent-Protokoll (JSON)')]).then(([d]) => d);
        const protocol = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
        assert.equal(protocol.steps.length, 7);
        download = await Promise.all([page.waitForEvent('download'), page.click('text=Export (JSON)')]).then(([d]) => d);
        const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
        assert.equal(exported.format, 'lit-agent-export');
        assert.equal(exported.runs.length, 2);
        console.log('✓ Historie, Agent-Protokoll-Download und Export');

        // 6) Historien-Eintrag öffnen (switchTab ohne Klick-Event)
        await page.click('.history-item >> nth=0');
        await page.waitForSelector('#tab-dashboard.active');
        assert.ok(await page.isVisible('#results-view.active'));
        console.log('✓ Historien-Eintrag geöffnet');

        // 7) Import in ein neues Profil auf "anderem Gerät"
        const other = await browser.newContext();
        const page2 = await other.newPage();
        page2.on('pageerror', e => errors.push(e.message));
        await page2.goto(`${APP_URL}/`);
        await login(page2, 'neu', 'geheim', 'register');
        const exportFile = path.join(tmp, 'export.json');
        fs.writeFileSync(exportFile, JSON.stringify(exported));
        page2.once('dialog', d => d.accept());
        await page2.click('nav button[data-tab="history"]');
        await page2.setInputFiles('#history-import', exportFile);
        await page2.waitForSelector('.history-item >> nth=1');
        await other.close();
        console.log('✓ Import auf zweitem Gerät');

        // 8) Offline-Start über den Service Worker
        await page.evaluate(() => navigator.serviceWorker.ready);
        await page.reload();
        await page.waitForFunction(() => !!navigator.serviceWorker.controller);
        await context.setOffline(true);
        await page.reload();
        await login(page, 'alt', 'pw');
        assert.ok(await page.isVisible('#net-status'), 'Offline-Hinweis fehlt');
        const offlineRuns = await page.evaluate(async () => (await listRuns('alt')).length);
        assert.equal(offlineRuns, 2);
        const pdfjsOk = await page.evaluate(() => typeof pdfjsLib !== 'undefined');
        assert.ok(pdfjsOk, 'pdf.js offline nicht geladen');
        assert.equal(await page.inputValue('#hochschule-key'), 'sk-hs-123', 'AES-Key nach erneutem Login nicht lesbar');
        assert.equal(await page.inputValue('#custom1-key'), 'alt-geheim');
        console.log('✓ Offline-Start: App, pdf.js und Historie verfügbar');

        // 9) Marketing-Studie (Befragung/PLS-SEM): fachspezifische Rubrik, medizinische Instrumente werden nicht angewendet
        await context.setOffline(false);
        llm.state.domain = 'business';
        llm.calls.length = 0;
        await page.click('nav button[data-tab="dashboard"]');
        await page.setInputFiles('#file-input', pdfFile);
        await page.click('#btn-start');
        await page.waitForSelector('#results-view.active', { timeout: 60000 });
        await page.waitForFunction(() => document.getElementById('res-studies').textContent.includes('Befragung / SEM / PLS-SEM'), null, { timeout: 30000 });
        const bStudy = await page.textContent('#res-studies');
        assert.ok(bStudy.includes('CASQ (INTERNER INDEX) · Befragung / SEM / PLS-SEM'), 'fachspezifische Rubrik fehlt');
        assert.ok(bStudy.includes('Hair, Risher, Sarstedt'), 'Methodische Grundlage der Rubrik fehlt');
        assert.ok(!bStudy.includes('/ 10 (unvollständig)') && !bStudy.includes('PEDro Scale'), 'PEDro darf ohne Gesundheitsbezug nicht erscheinen');
        const bAnalysis = llm.calls.find(c => c.includes('Du bist Agent 3,'));
        assert.ok(bAnalysis.includes('Gesundheitsbezug laut Extraktion: nein'), 'Gesundheitsbezug nicht im Prompt');
        assert.ok(llm.calls.find(c => c.includes('Du bist Agent 3b')).includes('SM-2.1 [Sampling & response quality]'), 'SEM-Prüffragen fehlen');
        console.log('✓ Marketing-Studie: Rubrik „Befragung / SEM / PLS-SEM“ mit Grundlage, PEDro ausgeblendet');

        // 10) Systematisches Review im Marketing: Business-Rubrik mit PRISMA-Berichtserfüllung
        llm.state.domain = 'review';
        await page.click('nav button[data-tab="dashboard"]');
        await page.setInputFiles('#file-input', pdfFile);
        await page.click('#btn-start');
        await page.waitForSelector('#results-view.active', { timeout: 60000 });
        await page.waitForFunction(() => document.getElementById('res-studies').textContent.includes('Management / Marketing / Digital'), null, { timeout: 30000 });
        const rStudy = await page.textContent('#res-studies');
        assert.ok(rStudy.includes('PRISMA-2020-BERICHTSERFÜLLUNG') && rStudy.includes('kein offizieller Score'), 'PRISMA-Berichtserfüllung fehlt');
        assert.ok(/\d+ % \(\d+ von \d+ Berichtspunkten erfüllt\)/.test(rStudy), 'Erfüllungsgrad fehlt');
        console.log('✓ Marketing-Review: Business-Rubrik, PRISMA-Berichtserfüllung getrennt ausgewiesen');

        const relevantErrors = errors.filter(e => !e.includes('net::ERR_INTERNET_DISCONNECTED'));
        assert.deepEqual(relevantErrors, [], 'Fehler in der Browser-Konsole');
        ok = true;
    } catch (err) {
        console.error('✗', err.message);
        if (errors.length) console.error('Browser-Fehler:', errors);
    } finally {
        await browser.close();
        appServer.close();
        llm.server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log(ok ? '\nE2E: alle Prüfungen bestanden' : '\nE2E: FEHLGESCHLAGEN');
    process.exit(ok ? 0 : 1);
})();
