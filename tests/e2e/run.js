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

const legacyProfile = {
    alt: {
        passHash: legacyHash('pw'),
        keys: { activeProvider: 'custom1', custom1Url: 'http://localhost:1/v1', custom1Key: '', custom1Model: '', maxEvidence: 50000, maxTokens: 8192, temperature: 0 },
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
        assert.equal(llm.calls.length, 5, 'erwartet 5 LLM-Aufrufe (inkl. Agent 6)');
        assert.equal(await page.textContent('#llm-status-text'), 'Lokales Profil 1 · mock-model', 'Lampe zeigt nicht das antwortende Modell');
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
        assert.ok(study.includes('CASQ INTERN · Quantitativ'), 'Rubrik fehlt');
        assert.ok(study.includes('kein Zitat im PDF gefunden'), 'Herabstufung ohne Beleg nicht angezeigt');
        assert.ok(study.includes('Prüffragen (27)'), 'Prüffragen-Tabelle fehlt');
        const analysisPrompt = llm.calls.find(c => c.includes('Du bist Agent 3'));
        assert.ok(analysisPrompt.includes('QN-2.2 [Design appropriateness]') && !analysisPrompt.includes('{{CASQ_CHECKLIST}}'), 'Prüffragen nicht im Prompt');
        assert.ok(study.includes('Testvalidierung $& mit Sonderzeichen.'), 'Sonderzeichen verfälscht');
        console.log('✓ Analyse-Lauf: PEDro 4/10 (unvollständig), CASQ 2.0 = 8.7 (Spanne 8.7–9.2), Informationsgrad 96 %, Belege 96 %');

        // 4) Lauf + Agent-Protokoll in IndexedDB
        const stored = await page.evaluate(async () => {
            const runs = await listRuns('alt');
            const steps = await getRunSteps(runs[0].id);
            return { runs: runs.length, legacy: runs.filter(r => r.legacy).length, steps: steps.map(s => s.agent), hasPrompt: steps.every(s => s.prompt && s.response && s.prompt_version_id) };
        });
        assert.deepEqual(stored.steps, ['extraction', 'analysis', 'validation', 'integrity', 'synthesis']);
        assert.equal(stored.runs, 2);
        assert.equal(stored.legacy, 1);
        assert.ok(stored.hasPrompt, 'Protokoll unvollständig');
        console.log('✓ IndexedDB: 2 Läufe (1 übernommen), Protokoll mit 5 Schritten inkl. Prompt-Version');

        // 5) Historie, Export, Agent-Protokoll-Download
        await page.click('nav button[data-tab="history"]');
        await page.waitForSelector('.history-item >> nth=1');
        let download = await Promise.all([page.waitForEvent('download'), page.click('text=Agent-Protokoll (JSON)')]).then(([d]) => d);
        const protocol = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
        assert.equal(protocol.steps.length, 5);
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
        console.log('✓ Offline-Start: App, pdf.js und Historie verfügbar');

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
