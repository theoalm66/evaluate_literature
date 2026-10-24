// Weiterleitung an das Sprachmodell auf dem Spark (OpenAI-kompatibel, z.B. vLLM).
// Der Browser erreicht das Modell nicht direkt (interne http-Adresse, aus einer https-Seite blockiert);
// angemeldete Benutzer schicken ihre Anfragen deshalb an /api/llm/..., der Server reicht sie intern weiter.
// Es werden nur die beiden benötigten Endpunkte durchgereicht, Ziel-URL und API-Key kommen aus der
// Server-Konfiguration, nie vom Browser.
const http = require('http');
const https = require('https');

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;   // lange Antworten großer Modelle ohne Streaming
const MODELS_CACHE_MS = 60 * 1000;

function upstreamRequest(baseUrl, path, { method = 'GET', body = null, apiKey = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const target = new URL(baseUrl.replace(/\/$/, '') + path);
    const client = target.protocol === 'https:' ? https : http;
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const headers = { Accept: 'application/json' };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    // node:http statt fetch: fetch (undici) bricht nach 5 Minuten ohne Antwort-Header ab,
    // ein großes Modell braucht für eine vollständige JSON-Antwort aber oft länger.
    return new Promise((resolve, reject) => {
        const req = client.request(target, { method, headers }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
            res.on('error', reject);
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`Zeitüberschreitung nach ${Math.round(timeoutMs / 60000)} Minuten`)));
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function registerLlmProxy(app, { baseUrl, apiKey = null, defaultModel = null, label = 'Spark-Modell', timeoutMs = DEFAULT_TIMEOUT_MS, requireUser }) {
    let modelsCache = { at: 0, data: null };

    async function fetchModels() {
        if (modelsCache.data && Date.now() - modelsCache.at < MODELS_CACHE_MS) return modelsCache.data;
        const res = await upstreamRequest(baseUrl, '/models', { apiKey, timeoutMs: 15000 });
        if (res.status !== 200) throw Object.assign(new Error(`Modellliste: Status ${res.status}`), { status: res.status });
        modelsCache = { at: Date.now(), data: JSON.parse(res.body) };
        return modelsCache.data;
    }

    function unreachable(reply, err) {
        return reply.code(502).send({ error: `${label} nicht erreichbar (${err.message || err}). Läuft der Modell-Server auf dem Spark?` });
    }

    app.get('/api/llm/models', { preHandler: requireUser }, async (request, reply) => {
        try {
            return await fetchModels();
        } catch (err) {
            return unreachable(reply, err);
        }
    });

    app.post('/api/llm/chat/completions', { preHandler: requireUser, bodyLimit: 32 * 1024 * 1024 }, async (request, reply) => {
        const body = request.body;
        if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
            return reply.code(400).send({ error: 'Ungültige Anfrage an das Modell.' });
        }
        if (body.stream) return reply.code(400).send({ error: 'Streaming wird über die Weiterleitung nicht unterstützt.' });
        const payload = { ...body };
        try {
            // Ohne Modellnamen nimmt der Server das eingestellte bzw. das erste vom Modell-Server gemeldete Modell.
            if (!payload.model) payload.model = defaultModel || (await fetchModels())?.data?.[0]?.id;
            if (!payload.model) return reply.code(502).send({ error: `${label}: kein Modell gefunden.` });
            const res = await upstreamRequest(baseUrl, '/chat/completions', { method: 'POST', body: payload, apiKey, timeoutMs });
            request.log.info({ user: request.user.login, model: payload.model, status: res.status }, 'LLM-Weiterleitung');
            return reply.code(res.status).type('application/json').send(res.body);
        } catch (err) {
            return unreachable(reply, err);
        }
    });

    return { label };
}

module.exports = { registerLlmProxy, upstreamRequest };
