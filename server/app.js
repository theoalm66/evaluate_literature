// HTTP-Server: liefert die App aus und stellt /api (Login, Synchronisation) bereit.
// Läuft hinter Tailscale (serve/funnel) unter /lit; funktioniert mit und ohne vorangestelltes /lit.
const path = require('path');
const crypto = require('crypto');
const Fastify = require('fastify');
const fastifyStatic = require('@fastify/static');
const { openDatabase, transaction } = require('./db');
const { hashPassword, verifyPassword, validateCredentials, newSessionToken, hashToken, LoginLimiter } = require('./auth');
const { pushChanges, pullChanges } = require('./sync');
const { registerLlmProxy } = require('./llm-proxy');

const SESSION_COOKIE = 'lit_session';
const PATH_PREFIX = '/lit';
const DEFAULT_APP_DIR = path.resolve(__dirname, '../app');

function parseCookies(header) {
    const out = {};
    String(header || '').split(';').forEach(part => {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    });
    return out;
}

function safeEqual(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function buildApp(options = {}) {
    const config = {
        dbPath: options.dbPath || ':memory:',
        appDir: options.appDir || DEFAULT_APP_DIR,
        inviteCode: options.inviteCode || null,
        cookieSecure: options.cookieSecure !== false,
        sessionDays: options.sessionDays || 30,
        logger: options.logger ?? false,
        llm: options.llm && options.llm.baseUrl ? options.llm : null
    };
    const db = options.db || openDatabase(config.dbPath);
    const limiter = new LoginLimiter(options.limiter);

    const app = Fastify({
        logger: config.logger,
        bodyLimit: 1024 * 1024,
        // /lit/... und /... gleich behandeln: Tailscale reicht den Pfad je nach Konfiguration mit oder ohne Präfix durch.
        rewriteUrl: req => {
            const url = req.url || '/';
            if (url === PATH_PREFIX || url.startsWith(PATH_PREFIX + '/') || url.startsWith(PATH_PREFIX + '?')) return url.slice(PATH_PREFIX.length) || '/';
            return url;
        }
    });
    app.decorate('db', db);
    app.addHook('onClose', async () => { if (!options.db) db.close(); });

    // --- Sitzungen ---------------------------------------------------------
    function setSessionCookie(reply, token, maxAgeSeconds) {
        const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
        if (config.cookieSecure) parts.push('Secure');
        reply.header('Set-Cookie', parts.join('; '));
    }

    function createSession(reply, userId) {
        const token = newSessionToken();
        const now = new Date();
        const expires = new Date(now.getTime() + config.sessionDays * 86400000);
        db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now.toISOString());
        db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
            .run(hashToken(token), userId, now.toISOString(), expires.toISOString());
        setSessionCookie(reply, token, config.sessionDays * 86400);
    }

    function sessionUser(request) {
        const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
        if (!token) return null;
        return db.prepare(`SELECT u.id, u.login FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND s.expires_at > ?`).get(hashToken(token), new Date().toISOString()) || null;
    }

    // --- Schutz der API ------------------------------------------------------
    // Schreibende Anfragen müssen einen eigenen Header tragen. Fremde Seiten können ihn ohne CORS-Freigabe
    // nicht setzen (Schutz gegen Cross-Site-Request-Forgery, zusätzlich zu SameSite=Strict).
    app.addHook('onRequest', async (request, reply) => {
        if (!request.url.startsWith('/api/')) return;
        reply.header('Cache-Control', 'no-store');
        if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers['x-lit-request'] !== '1') {
            return reply.code(403).send({ error: 'Fehlender Anfrage-Header.' });
        }
    });

    async function requireUser(request, reply) {
        const user = sessionUser(request);
        if (!user) return reply.code(401).send({ error: 'Nicht angemeldet.' });
        request.user = user;
    }

    // --- Auth ----------------------------------------------------------------
    app.get('/api/health', async () => ({
        ok: true,
        registration: config.inviteCode ? 'invite' : 'closed',
        llm: config.llm ? { available: true, label: config.llm.label || 'Spark-Modell' } : { available: false }
    }));

    app.post('/api/auth/register', async (request, reply) => {
        const { login, password, inviteCode } = request.body || {};
        if (!config.inviteCode) return reply.code(403).send({ error: 'Registrierung auf dem Spark ist deaktiviert.' });
        if (limiter.isBlocked('invite')) return reply.code(429).send({ error: 'Zu viele Versuche. Bitte später erneut versuchen.' });
        if (typeof inviteCode !== 'string' || !safeEqual(inviteCode, config.inviteCode)) {
            limiter.recordFailure('invite');
            return reply.code(403).send({ error: 'Einladungscode ist falsch.' });
        }
        const invalid = validateCredentials(login, password);
        if (invalid) return reply.code(400).send({ error: invalid });
        const passHash = await hashPassword(password);
        const created = transaction(db, () => {
            if (db.prepare('SELECT 1 FROM users WHERE login = ?').get(login)) return null;
            return db.prepare('INSERT INTO users (login, pass_hash, created_at) VALUES (?, ?, ?)').run(login, passHash, new Date().toISOString());
        });
        if (!created) return reply.code(409).send({ error: 'Benutzer existiert auf dem Spark bereits.' });
        createSession(reply, Number(created.lastInsertRowid));
        return reply.code(201).send({ login });
    });

    app.post('/api/auth/login', async (request, reply) => {
        const { login, password } = request.body || {};
        if (typeof login !== 'string' || typeof password !== 'string' || login.length > 64 || password.length > 512) {
            return reply.code(400).send({ error: 'Ungültige Anmeldedaten.' });
        }
        if (limiter.isBlocked(login)) return reply.code(429).send({ error: 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.' });
        const user = db.prepare('SELECT id, login, pass_hash FROM users WHERE login = ?').get(login);
        const ok = await verifyPassword(password, user?.pass_hash);
        if (!user || !ok) {
            limiter.recordFailure(login);
            return reply.code(401).send({ error: 'Benutzername oder Passwort falsch.' });
        }
        limiter.recordSuccess(login);
        createSession(reply, user.id);
        return { login: user.login };
    });

    app.post('/api/auth/logout', async (request, reply) => {
        const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
        if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
        setSessionCookie(reply, '', 0);
        return { ok: true };
    });

    app.get('/api/auth/me', { preHandler: requireUser }, async request => ({ login: request.user.login }));

    // --- Synchronisation -------------------------------------------------------
    app.post('/api/sync/push', { preHandler: requireUser, bodyLimit: 64 * 1024 * 1024 }, async (request, reply) => {
        const { device, changes } = request.body || {};
        if (!Array.isArray(changes) || changes.length > 1000) return reply.code(400).send({ error: 'Ungültige Änderungsliste.' });
        const deviceId = typeof device === 'string' ? device.slice(0, 100) : null;
        return { results: pushChanges(db, request.user.id, deviceId, changes) };
    });

    app.get('/api/sync/pull', { preHandler: requireUser }, async request => {
        const { since, device, limit } = request.query || {};
        return pullChanges(db, request.user.id, { since: Number(since) || 0, deviceId: typeof device === 'string' ? device : null, limit });
    });

    if (config.llm) registerLlmProxy(app, { ...config.llm, requireUser });
    else app.all('/api/llm/*', async (request, reply) => reply.code(404).send({ error: 'Auf diesem Spark ist kein Modell eingerichtet (LIT_LLM_URL fehlt).' }));

    app.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Nicht gefunden.' });
        return reply.code(404).type('text/plain').send('Nicht gefunden.');
    });

    // --- App-Dateien ---------------------------------------------------------
    app.register(fastifyStatic, { root: config.appDir, prefix: '/', index: ['index.html'], cacheControl: true, maxAge: 0 });

    return app;
}

module.exports = { buildApp };
