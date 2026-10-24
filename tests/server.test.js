const test = require('node:test');
const assert = require('node:assert/strict');
const { buildApp } = require('../server/app');

const H = { 'content-type': 'application/json', 'x-lit-request': '1' };

function cookieOf(res) {
    const raw = res.headers['set-cookie'];
    return String(Array.isArray(raw) ? raw[0] : raw).split(';')[0];
}

async function register(app, login, password = 'passwort123', inviteCode = 'einladung') {
    const res = await app.inject({ method: 'POST', url: '/lit/api/auth/register', headers: H, payload: { login, password, inviteCode } });
    return { res, cookie: res.statusCode === 201 ? cookieOf(res) : null };
}

const push = (app, cookie, changes, device = 'dev-a') =>
    app.inject({ method: 'POST', url: '/api/sync/push', headers: { ...H, cookie }, payload: { device, changes } });
const pull = (app, cookie, query = '') =>
    app.inject({ method: 'GET', url: `/api/sync/pull?${query}`, headers: { cookie } }).then(r => r.json());

const run = (id, extra = {}) => ({ kind: 'run', id, data: { id, createdAt: '2026-10-01T10:00:00.000Z', model: 'm', result: { run_id: id, validation: { casq_score: 7 } }, ...extra } });

test('Registrierung nur mit Einladungscode; ohne Code deaktiviert', async () => {
    const closed = buildApp();
    assert.equal((await register(closed, 'anna')).res.statusCode, 403);
    assert.equal((await closed.inject({ url: '/api/health' })).json().registration, 'closed');
    await closed.close();

    const app = buildApp({ inviteCode: 'einladung' });
    assert.equal((await register(app, 'anna', 'passwort123', 'falsch')).res.statusCode, 403);
    assert.equal((await register(app, 'anna', 'kurz')).res.statusCode, 400);
    const ok = await register(app, 'anna');
    assert.equal(ok.res.statusCode, 201);
    const setCookie = String(ok.res.headers['set-cookie']);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Secure/);
    assert.equal((await register(app, 'anna')).res.statusCode, 409);
    await app.close();
});

test('Login, Sitzung, Logout und Begrenzung von Fehlversuchen', async () => {
    const app = buildApp({ inviteCode: 'einladung', limiter: { perLogin: 3 } });
    await register(app, 'ben');
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', headers: H, payload: { login: 'ben', password: 'falschfalsch' } });
    assert.equal(bad.statusCode, 401);
    const unknown = await app.inject({ method: 'POST', url: '/api/auth/login', headers: H, payload: { login: 'niemand', password: 'egalegal' } });
    assert.equal(unknown.statusCode, 401);
    assert.deepEqual(unknown.json(), bad.json(), 'unbekannter Benutzer darf sich nicht von falschem Passwort unterscheiden');

    const good = await app.inject({ method: 'POST', url: '/lit/api/auth/login', headers: H, payload: { login: 'ben', password: 'passwort123' } });
    assert.equal(good.statusCode, 200);
    const cookie = cookieOf(good);
    assert.equal((await app.inject({ url: '/api/auth/me', headers: { cookie } })).json().login, 'ben');
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...H, cookie }, payload: {} })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode, 401);

    for (let i = 0; i < 3; i++) await app.inject({ method: 'POST', url: '/api/auth/login', headers: H, payload: { login: 'ben', password: 'xxxxxxxx' } });
    const blocked = await app.inject({ method: 'POST', url: '/api/auth/login', headers: H, payload: { login: 'ben', password: 'passwort123' } });
    assert.equal(blocked.statusCode, 429);
    await app.close();
});

test('Schreibende API-Aufrufe brauchen den Anfrage-Header', async () => {
    const app = buildApp({ inviteCode: 'einladung' });
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: { login: 'a', password: 'b' } });
    assert.equal(res.statusCode, 403);
    assert.equal((await app.inject({ url: '/api/sync/pull' })).statusCode, 401);
    await app.close();
});

test('Push/Pull: Läufe, Schritte, Löschen, eigenes Gerät wird ausgelassen', async () => {
    const app = buildApp({ inviteCode: 'einladung' });
    const { cookie } = await register(app, 'clara');
    const res = (await push(app, cookie, [run('r1'), { kind: 'run_steps', id: 'r1', data: [{ id: 's1', agent: 'extraction', prompt: 'p' }] }, { kind: 'run_steps', id: 'unbekannt', data: [] }])).json();
    assert.deepEqual(res.results.map(r => r.status), ['ok', 'ok', 'rejected']);

    // Gleiches Gerät bekommt seine Änderungen nicht zurück, anderes Gerät schon
    const own = await pull(app, cookie, 'since=0&device=dev-a');
    assert.equal(own.changes.length, 0);
    const other = await pull(app, cookie, 'since=0&device=dev-b');
    assert.deepEqual(other.changes.map(c => c.kind).sort(), ['run', 'run_steps']);
    assert.equal(other.changes.find(c => c.kind === 'run').data.result.validation.casq_score, 7);
    assert.equal(other.has_more, false);

    // Löschen: Lauf wird zum Grabstein, erneutes Hochladen belebt ihn nicht
    await push(app, cookie, [{ kind: 'run_delete', id: 'r1' }], 'dev-b');
    await push(app, cookie, [run('r1')], 'dev-c');
    const afterDelete = await pull(app, cookie, `since=${other.cursor}&device=dev-a`);
    assert.deepEqual(afterDelete.changes.map(c => c.kind), ['run_delete']);
    await app.close();
});

test('Fremde Daten können weder überschrieben noch gelesen werden', async () => {
    const app = buildApp({ inviteCode: 'einladung' });
    const a = await register(app, 'dora');
    const b = await register(app, 'emil');
    await push(app, a.cookie, [run('geheim'), { kind: 'prompt_version', id: 'pv1', data: { agent: 'analysis', text: 'A', createdAt: '2026-10-01T00:00:00Z' } }]);
    const attack = (await push(app, b.cookie, [run('geheim', { model: 'manipuliert' }), { kind: 'run_steps', id: 'geheim', data: [] },
        { kind: 'run_delete', id: 'geheim' }, { kind: 'prompt_head', id: 'analysis', data: { version_id: 'pv1', updatedAt: '2027-01-01T00:00:00Z' } }])).json();
    assert.deepEqual(attack.results.map(r => r.reason), ['forbidden', 'forbidden', 'forbidden', 'unknown_version']);
    assert.equal((await pull(app, b.cookie, 'since=0')).changes.length, 0);
    const own = await pull(app, a.cookie, 'since=0&device=x');
    assert.equal(own.changes.find(c => c.kind === 'run').data.model, 'm');
    await app.close();
});

test('Einstellungen und aktive Prompt-Version: letzte Änderung gewinnt', async () => {
    const app = buildApp({ inviteCode: 'einladung' });
    const { cookie } = await register(app, 'fritz');
    const pv = (id, createdAt) => ({ kind: 'prompt_version', id, data: { agent: 'extraction', text: id, createdAt } });
    await push(app, cookie, [pv('v1', '2026-10-01T00:00:00Z'), pv('v2', '2026-10-02T00:00:00Z'),
        { kind: 'prompt_head', id: 'extraction', data: { version_id: 'v2', updatedAt: '2026-10-02T00:00:00Z' } },
        { kind: 'settings', id: 'settings', data: { values: { maxTokens: 8192 }, updatedAt: '2026-10-02T00:00:00Z' } }]);
    const stale = (await push(app, cookie, [
        { kind: 'prompt_head', id: 'extraction', data: { version_id: 'v1', updatedAt: '2026-10-01T12:00:00Z' } },
        { kind: 'settings', id: 'settings', data: { values: { maxTokens: 1 }, updatedAt: '2026-10-01T00:00:00Z' } }])).json();
    assert.deepEqual(stale.results.map(r => r.note), ['stale', 'stale']);
    await push(app, cookie, [{ kind: 'settings', id: 'settings', data: { values: { maxTokens: 4096 }, updatedAt: '2026-10-03T00:00:00Z' } }]);
    const state = await pull(app, cookie, 'since=0&device=other');
    assert.equal(state.changes.find(c => c.kind === 'prompt_head').data.version_id, 'v2');
    assert.equal(state.changes.find(c => c.kind === 'settings').data.values.maxTokens, 4096);
    await app.close();
});

test('Pull blättert seitenweise und verliert dabei nichts', async () => {
    const app = buildApp({ inviteCode: 'einladung' });
    const { cookie } = await register(app, 'gina');
    await push(app, cookie, Array.from({ length: 7 }, (_, i) => run(`run-${i}`)));
    const seen = [];
    let cursor = 0, pages = 0, page;
    do {
        page = await pull(app, cookie, `since=${cursor}&device=other&limit=3`);
        seen.push(...page.changes.map(c => c.id));
        cursor = page.cursor;
        pages++;
    } while (page.has_more);
    assert.equal(pages, 3);
    assert.deepEqual(seen.sort(), Array.from({ length: 7 }, (_, i) => `run-${i}`).sort());
    await app.close();
});

test('App-Dateien werden unter /lit/ und / ausgeliefert, Präfix-Varianten funktionieren', async () => {
    const app = buildApp();
    for (const url of ['/lit/', '/', '/lit', '/lit/js/scoring.js']) {
        const res = await app.inject({ url });
        assert.equal(res.statusCode, 200, url);
    }
    assert.equal((await app.inject({ url: '/lit/../server/app.js' })).statusCode, 404);
    assert.equal((await app.inject({ url: '/lit/%2e%2e/server/app.js' })).statusCode, 404);
    assert.equal((await app.inject({ url: '/lit/api/gibtsnicht' })).statusCode, 404);
    await app.close();
});

test('LLM-Weiterleitung: nur angemeldet, Standardmodell, Key bleibt auf dem Server, Fehler bei Ausfall', async () => {
    const http = require('http');
    const seen = [];
    const upstream = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            seen.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'qwen-spark', max_model_len: 65536 }] }));
            res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
        });
    });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
    const app = buildApp({ inviteCode: 'einladung', llm: { baseUrl, apiKey: 'server-geheim' } });
    const { cookie } = await register(app, 'hanna');

    assert.equal((await app.inject({ url: '/api/health' })).json().llm.available, true);
    const anon = await app.inject({ method: 'POST', url: '/lit/api/llm/chat/completions', headers: H, payload: { messages: [] } });
    assert.equal(anon.statusCode, 401);

    const res = await app.inject({ method: 'POST', url: '/lit/api/llm/chat/completions', headers: { ...H, cookie, authorization: 'Bearer vom-browser' },
        payload: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().choices[0].message.content, '{"ok":true}');
    const call = seen.find(s => s.url === '/v1/chat/completions');
    assert.equal(call.body.model, 'qwen-spark', 'Standardmodell aus /models');
    assert.equal(call.auth, 'Bearer server-geheim', 'nur der Server-Key wird weitergegeben');

    const models = await app.inject({ url: '/api/llm/models', headers: { cookie } });
    assert.equal(models.json().data[0].max_model_len, 65536);

    await new Promise(r => upstream.close(r));
    const down = await app.inject({ method: 'POST', url: '/api/llm/chat/completions', headers: { ...H, cookie }, payload: { model: 'x', messages: [] } });
    assert.equal(down.statusCode, 502);
    assert.match(down.json().error, /nicht erreichbar/);
    await app.close();

    const noLlm = buildApp({ inviteCode: 'einladung' });
    assert.equal((await noLlm.inject({ method: 'POST', url: '/api/llm/chat/completions', headers: H, payload: {} })).statusCode, 404);
    await noLlm.close();
});
