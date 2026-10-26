// End-to-End-Test der Synchronisation mit dem echten Spark-Server (Fastify + SQLite):
// zwei Geräte, Prompt- und Einstellungsabgleich, Löschen, Offline-Warteschlange und das Verknüpfen
// eines bisher nur lokalen Profils der alten Version.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildApp } = require('../../server/app');
const { startMockLLM, QUOTES } = require('./mock-llm');

const APP_PORT = 8790;
const LLM_PORT = 8791;
const APP_URL = `http://localhost:${APP_PORT}/lit/`;
const INVITE = 'einladung-test';

function legacyHash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) { hash = ((hash << 5) + hash) + str.charCodeAt(i); }
    return hash.toString();
}

async function startServer(dbPath) {
    const app = buildApp({ dbPath, inviteCode: INVITE, cookieSecure: false, llm: { baseUrl: `http://127.0.0.1:${LLM_PORT}/v1` } });
    await app.listen({ host: '127.0.0.1', port: APP_PORT });
    return app;
}

async function newDevice(browser, errors, initScript) {
    const context = await browser.newContext();
    if (initScript) await context.addInitScript(...initScript);
    const page = await context.newPage();
    page.on('dialog', d => d.accept());
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => {
        const url = String(m.location()?.url);
        // Fehlgeschlagene API-Aufrufe sind in den Offline- und Falsch-Passwort-Schritten gewollt.
        if (m.type() === 'error' && !url.includes('/api/') && (!url.startsWith('http') || url.startsWith(`http://localhost:${APP_PORT}/`))) errors.push(m.text());
    });
    await page.goto(APP_URL);
    return { context, page };
}

async function login(page, user, pass, { action = 'login', invite = '' } = {}) {
    await page.waitForSelector('.auth-btn:not([disabled])');
    await page.fill('#login-user', user);
    await page.fill('#login-pass', pass);
    await page.fill('#login-invite', invite);
    await page.click(action === 'login' ? 'text=Einloggen' : 'text=Neu registrieren');
}

async function sync(page) {
    return page.evaluate(async () => {
        const idle = async () => { while (syncRunning) await new Promise(r => setTimeout(r, 50)); };
        await idle();
        await syncNow();
        await idle();
        return { pending: syncState.pending, error: syncState.error, badge: document.getElementById('sync-status').className };
    });
}

async function analyse(page, pdfFile) {
    await page.click('nav button[data-tab="dashboard"]');
    // Keine Crossref-Abfrage im Test (kein Internet)
    await page.evaluate(() => { document.getElementById('opt-integrity-online').checked = false; });
    await page.setInputFiles('#file-input', pdfFile);
    await page.click('#btn-start');
    await page.waitForSelector('#results-view.active', { timeout: 60000 });
    await page.evaluate(() => { selectedFiles = []; renderFileList(); document.getElementById('results-view').classList.remove('active'); });
}

const runCount = (page, user) => page.evaluate(u => listRuns(u).then(r => r.length), user);

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-sync-'));
    const dbPath = path.join(tmp, 'lit.db');
    const pdfFile = path.join(tmp, 'studie.pdf');
    let server = await startServer(dbPath);
    const llm = await startMockLLM(LLM_PORT);
    const browser = await chromium.launch();
    const errors = [];
    let ok = false;
    try {
        const pdfPage = await browser.newPage();
        await pdfPage.setContent(`<p>${QUOTES.rq}</p><p>${QUOTES.alloc}</p><p>${QUOTES.stats}</p><p>${QUOTES.limits}</p>`);
        await pdfPage.pdf({ path: pdfFile });
        await pdfPage.close();

        // 1) Gerät A: Konto mit Einladungscode, Einstellungen, Analyse, eigener Prompt
        const A = await newDevice(browser, errors);
        await login(A.page, 'anna', 'passwort123', { action: 'register', invite: INVITE });
        await A.page.waitForSelector('#app-screen', { state: 'visible' });
        await A.page.click('nav button[data-tab="config"]');
        await A.page.fill('#custom1-url', `http://localhost:${LLM_PORT}/v1`);
        await A.page.dispatchEvent('#custom1-url', 'change');
        await A.page.fill('#custom1-key', 'geheimer-key');
        await A.page.dispatchEvent('#custom1-key', 'change');
        await analyse(A.page, pdfFile);
        await A.page.click('nav button[data-tab="info"]');
        await A.page.fill('#prompt-extraction', 'EIGENER PROMPT {{TITLE}} {{SOURCE_TEXT}}');
        await A.page.click('#tab-info .prompt-editor >> nth=0 >> text=Speichern');
        let state = await sync(A.page);
        assert.equal(state.pending, 0, 'A hat noch ausstehende Änderungen');
        assert.match(state.badge, /\bok\b/);
        const db = () => server.db;
        assert.equal(db().prepare('SELECT COUNT(*) c FROM runs WHERE deleted_at IS NULL').get().c, 1);
        assert.equal(JSON.parse(db().prepare('SELECT data FROM run_steps').get().data).length, 7);
        const storedSettings = db().prepare('SELECT data FROM settings').get().data;
        assert.ok(storedSettings.includes(`localhost:${LLM_PORT}`), 'Einstellungen nicht auf dem Spark');
        assert.ok(!storedSettings.includes('Key"') && !storedSettings.includes('geheimer'), 'API-Key darf nicht übertragen werden');
        const stored = await A.page.evaluate(() => getUserDB().anna.keys.custom1Key);
        assert.ok(stored.startsWith('aes1:') && !stored.includes('geheimer'), 'API-Key lokal nicht mit AES gespeichert');
        console.log('✓ Gerät A: Konto, Analyse, Prompt und Einstellungen auf dem Spark (ohne API-Key)');

        // 2) Gerät B: Anmeldung baut das Profil aus den Spark-Daten auf
        const B = await newDevice(browser, errors);
        await login(B.page, 'anna', 'passwort123');
        await B.page.waitForSelector('#app-screen', { state: 'visible' });
        await sync(B.page);
        assert.equal(await runCount(B.page, 'anna'), 1);
        const bRun = await B.page.evaluate(async () => { const r = (await listRuns('anna'))[0]; return (await getRunSteps(r.id)).length; });
        assert.equal(bRun, 7, 'Agent-Protokoll fehlt auf Gerät B');
        assert.equal(await B.page.inputValue('#custom1-url'), `http://localhost:${LLM_PORT}/v1`);
        assert.equal(await B.page.inputValue('#custom1-key'), '', 'API-Key darf auf B nicht auftauchen');
        assert.equal(await B.page.inputValue('#prompt-extraction'), 'EIGENER PROMPT {{TITLE}} {{SOURCE_TEXT}}');
        await B.page.click('nav button[data-tab="history"]');
        await B.page.waitForSelector('.history-item');
        console.log('✓ Gerät B: Lauf mit Protokoll, Einstellungen und eigener Prompt übernommen');

        // 3) Löschen auf B kommt auf A an
        await B.page.click('.history-item >> text=Löschen');
        await B.page.waitForFunction(() => document.querySelectorAll('.history-item').length === 0);
        await sync(B.page);
        await sync(A.page);
        assert.equal(await runCount(A.page, 'anna'), 0);
        console.log('✓ Löschen auf B wird auf A übernommen');

        // 4) Spark weg: Analyse auf A landet in der Warteschlange und wird später nachgereicht
        await server.close();
        await analyse(A.page, pdfFile);
        state = await sync(A.page);
        assert.ok(state.pending >= 2, `erwartet ausstehende Änderungen, war ${state.pending}`);
        assert.equal(state.error, 'offline');
        assert.match(await A.page.textContent('#sync-status'), /offline · \d+ ausstehend/);
        server = await startServer(dbPath);
        state = await sync(A.page);
        assert.equal(state.pending, 0);
        await sync(B.page);
        assert.equal(await runCount(B.page, 'anna'), 1);
        console.log('✓ Offline-Warteschlange: Lauf wird nach Rückkehr des Spark übertragen');

        // 5) Altes, rein lokales Profil (kurzes Passwort) mit dem Spark verknüpfen
        const legacy = { alt: { passHash: legacyHash('pw'), keys: { activeProvider: 'custom1', custom1Url: 'http://x/v1', custom1Key: '' },
            history: [{ date: '1.1.2026', model: 'altes-modell', extractions: [{ title: 'alt.pdf' }], validation: { casq_score: 6 }, study_results: [] }] } };
        const C = await newDevice(browser, errors, [data => { if (!localStorage.getItem('agentUsers')) localStorage.setItem('agentUsers', data); }, JSON.stringify(legacy)]);
        await login(C.page, 'alt', 'pw');
        await C.page.waitForSelector('#app-screen', { state: 'visible' });
        assert.equal(await C.page.textContent('#sync-status'), 'nur lokal');
        await C.page.click('nav button[data-tab="config"]');
        await C.page.fill('#link-invite', INVITE);
        await C.page.click('text=Mit Spark verknüpfen');
        await C.page.waitForFunction(() => document.getElementById('link-message').textContent.includes('mindestens 8'));
        await C.page.fill('#link-password', 'neuesPasswort9');
        await C.page.click('text=Mit Spark verknüpfen');
        await C.page.waitForFunction(() => document.getElementById('link-message').textContent.includes('Verknüpft'));
        await sync(C.page);
        const altRuns = db().prepare(`SELECT COUNT(*) c FROM runs r JOIN users u ON u.id = r.user_id WHERE u.login = 'alt'`).get().c;
        assert.equal(altRuns, 1, 'übernommener Lauf fehlt auf dem Spark');
        await C.page.click('.btn-logout');
        await login(C.page, 'alt', 'pw');
        await C.page.waitForSelector('#login-error', { state: 'visible' });
        await login(C.page, 'alt', 'neuesPasswort9');
        await C.page.waitForSelector('#app-screen', { state: 'visible' });
        console.log('✓ Altes lokales Profil verknüpft, Passwort auf beiden Seiten geändert, Historie hochgeladen');

        // 6) Altes lokales Profil: Einloggen MIT Einladungscode verknüpft direkt
        const legacy2 = { dora: { passHash: legacyHash('langesPasswort1'), keys: { activeProvider: 'custom1', custom1Url: 'http://y/v1', custom1Key: '' },
            history: [{ date: '2.1.2026', model: 'm', extractions: [{ title: 'd.pdf' }], validation: { casq_score: 5 }, study_results: [] }] } };
        const D = await newDevice(browser, errors, [data => { if (!localStorage.getItem('agentUsers')) localStorage.setItem('agentUsers', data); }, JSON.stringify(legacy2)]);
        await D.page.waitForFunction(() => document.getElementById('server-status').textContent.includes('Verbunden'));
        await login(D.page, 'dora', 'langesPasswort1', { invite: INVITE });
        await D.page.waitForSelector('#app-screen', { state: 'visible' });
        state = await sync(D.page);
        assert.match(state.badge, /\bok\b/, 'Profil nicht verknüpft: ' + state.badge);
        const doraRuns = db().prepare(`SELECT COUNT(*) c FROM runs r JOIN users u ON u.id = r.user_id WHERE u.login = 'dora'`).get().c;
        assert.equal(doraRuns, 1);
        console.log('✓ Einloggen mit Einladungscode verknüpft ein lokales Profil direkt');

        // 7) Analyse mit dem Spark-Modell über die Weiterleitung des Servers
        await D.page.click('nav button[data-tab="config"]');
        await D.page.selectOption('#llm-provider', 'spark');
        await D.page.waitForFunction(() => document.getElementById('spark-model-hint').textContent.includes('eingerichtet'));
        const callsBefore = llm.calls.length;
        await analyse(D.page, pdfFile);
        assert.equal(llm.calls.length - callsBefore, 7, 'erwartet 7 Modell-Aufrufe über den Server (Agenten 2, 3, 3b, 4, 4b, 6, 5)');
        const sparkRun = await D.page.evaluate(async () => (await listRuns('dora'))[0].model);
        assert.equal(sparkRun, 'Spark-Modell (Standard)');
        console.log('✓ Analyse mit dem Spark-Modell über die Server-Weiterleitung');

        // 8) Mehrfachbewertung mit 3 Durchläufen: Agent 3 und 3b dreimal (mit Wiederholungs-Temperatur), Rest einmal
        await D.page.click('nav button[data-tab="dashboard"]');
        await D.page.selectOption('#opt-repeat-runs', '3');
        await D.page.fill('#opt-repeat-temperature', '0.4');
        await D.page.dispatchEvent('#opt-repeat-temperature', 'change');
        const callsBefore8 = llm.calls.length, tempsBefore8 = llm.temps.length;
        await analyse(D.page, pdfFile);
        assert.equal(llm.calls.length - callsBefore8, 11, 'erwartet 11 Aufrufe (Agent 2, 3×3, 3b×3, 4, 4b, 6, 5)');
        const temps8 = llm.temps.slice(tempsBefore8);
        const repeated = temps8.filter(t => t.agent === '3' || t.agent === '3b');
        assert.equal(repeated.length, 6);
        assert.ok(repeated.every(t => t.temperature === 0.4), 'Agent 3/3b nicht mit der Wiederholungs-Temperatur');
        assert.ok(temps8.filter(t => !['3', '3b'].includes(t.agent)).every(t => t.temperature === 0), 'andere Agenten dürfen die Temperatur nicht ändern');
        const rel = await D.page.textContent('#res-studies');
        assert.ok(rel.includes('MEHRFACHBEWERTUNG · 3 Durchläufe'), 'Mehrfachbewertung fehlt in der Ansicht');
        assert.ok(rel.includes('Unsichere Antworten (2)'), 'erwartet 2 unsichere Antworten (QN-2.1 und PEDro-Item 4)');
        assert.ok(rel.includes('Fleiss-κ') && rel.includes('Median'), 'Kennzahlen fehlen');
        const relData = await D.page.evaluate(async () => { const st = (await collectStudiesForReliability('dora'))[0]; return st.reliability; });
        assert.equal(relData.casq.scores.length, 3);
        assert.ok(relData.casq.scores[0] !== null && new Set(relData.casq.scores).size === 2, 'ein Durchlauf müsste abweichen: ' + relData.casq.scores);
        assert.deepEqual(relData.casq.uncertain.map(u => u.id), ['QN-2.1']);
        assert.equal(relData.casq.uncertain[0].chosen, 'yes', 'Mehrheit gewinnt');
        assert.deepEqual(relData.established.uncertain.map(u => u.item_id), ['4']);
        assert.equal(relData.established.runs.length, 3);
        console.log('✓ Mehrfachbewertung: 3 Durchläufe, CASQ je Durchlauf', relData.casq.scores.map(v => v.toFixed(1)).join(' / '), '– unsicher: QN-2.1, PEDro-Item 4');

        // 9) Tab "Zuverlässigkeit": Referenzen per CSV importieren, Abgleich, manuelle Eingabe, Vorlage, Export
        await D.page.click('nav button[data-tab="reliability"]');
        await D.page.waitForSelector('#ref-table tr[data-key]');
        const csvFile = path.join(tmp, 'experten.csv');
        fs.writeFileSync(csvFile, [
            'dokument;doi;pedro_gesamt;pedro_2;pedro_3;pedro_4;pedro_5;pedro_6;pedro_7;pedro_8;pedro_9;pedro_10;pedro_11;amstar2;casq_experte',
            'studie.pdf;;6;ja;ja;ja;nein;nein;nein;ja;ja;ja;nein;;8',
            'fehlt.pdf;;5;;;;;;;;;;;;'
        ].join('\r\n'));
        await D.page.setInputFiles('#ref-csv-input', csvFile);
        await D.page.waitForFunction(() => document.getElementById('ref-message').textContent.includes('2 Referenz(en) übernommen, davon 1'));
        await D.page.waitForSelector('#agreement-results .integ-box');
        const agree = await D.page.textContent('#agreement-results');
        assert.ok(agree.includes('PEDro-Gesamtwert (0–10)') && agree.includes('n = 1 Dokumente'), 'PEDro-Abgleich fehlt');
        assert.ok(agree.includes('2.00 Punkte') && agree.includes('-2.00'), 'Abweichung/Bias falsch: ' + agree.slice(0, 400));
        assert.ok(agree.includes('80 %'), 'Item-Übereinstimmung 8 von 10 erwartet');
        assert.ok(agree.includes('Weniger als 5 Dokumente'), 'Warnung bei kleiner Stichprobe fehlt');
        assert.ok(agree.includes('CASQ (interner Index, Experten-CASQ)'), 'CASQ-Abgleich fehlt');
        assert.ok((await D.page.textContent('#ref-table')).includes('1 Referenz(en) ohne analysiertes Dokument: fehlt.pdf'), 'Waise nicht gemeldet');
        await D.page.fill('#ref-table tr[data-key] [data-field="casq"]', '8.5');
        await D.page.waitForFunction(async () => (await listReferences('dora')).find(r => r.key === 'studie')?.casq === 8.5);
        const [tpl] = await Promise.all([D.page.waitForEvent('download'), D.page.click('#tab-reliability button:has-text("Vorlage laden")')]);
        const tplText = fs.readFileSync(await tpl.path(), 'utf8');
        assert.ok(tplText.includes('dokument;doi;pedro_gesamt') && tplText.includes('studie.pdf'), 'Vorlage unvollständig');
        const exported2 = await D.page.evaluate(async () => (await exportUserData('dora')).references.map(r => r.key).sort());
        assert.deepEqual(exported2, ['fehlt', 'studie']);
        assert.ok((await D.page.textContent('#repeat-results')).includes('Ø Übereinstimmung der Prüffragen'), 'Stabilitätstabelle fehlt');
        console.log('✓ Zuverlässigkeit: CSV-Import, PEDro-Abgleich (Abweichung 2.00, Items 80 %), manuelle Eingabe, Vorlage, Export');

        assert.deepEqual(errors, [], 'Fehler in der Browser-Konsole');
        ok = true;
    } catch (err) {
        console.error('✗', err.message);
        if (errors.length) console.error('Browser-Fehler:', errors);
    } finally {
        await browser.close();
        await server.close().catch(() => {});
        llm.server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log(ok ? '\nSync-E2E: alle Prüfungen bestanden' : '\nSync-E2E: FEHLGESCHLAGEN');
    process.exit(ok ? 0 : 1);
})();
