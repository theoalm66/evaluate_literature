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
    const app = buildApp({ dbPath, inviteCode: INVITE, cookieSecure: false });
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
        if (m.type() === 'error' && !url.includes('/api/')) errors.push(m.text());
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
        assert.equal(JSON.parse(db().prepare('SELECT data FROM run_steps').get().data).length, 4);
        const storedSettings = db().prepare('SELECT data FROM settings').get().data;
        assert.ok(storedSettings.includes(`localhost:${LLM_PORT}`), 'Einstellungen nicht auf dem Spark');
        assert.ok(!storedSettings.includes('Key"') && !storedSettings.includes('geheimer'), 'API-Key darf nicht übertragen werden');
        console.log('✓ Gerät A: Konto, Analyse, Prompt und Einstellungen auf dem Spark (ohne API-Key)');

        // 2) Gerät B: Anmeldung baut das Profil aus den Spark-Daten auf
        const B = await newDevice(browser, errors);
        await login(B.page, 'anna', 'passwort123');
        await B.page.waitForSelector('#app-screen', { state: 'visible' });
        await sync(B.page);
        assert.equal(await runCount(B.page, 'anna'), 1);
        const bRun = await B.page.evaluate(async () => { const r = (await listRuns('anna'))[0]; return (await getRunSteps(r.id)).length; });
        assert.equal(bRun, 4, 'Agent-Protokoll fehlt auf Gerät B');
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
