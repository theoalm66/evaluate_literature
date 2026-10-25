// ==========================================
// AUTO-DETECT CONTEXT SIZE
// ==========================================
async function autoDetectContext() {
    const provider = document.getElementById('llm-provider').value;
    let url, key, modelName;
    
    if (isUrlProvider(provider)) {
        let baseUrl = document.getElementById(provider + '-url').value.replace(/\/$/, '');
        url = baseUrl + '/models';
        key = document.getElementById(provider + '-key').value || 'lm-studio';
        modelName = document.getElementById(provider + '-model').value;
    } else if (provider === 'openai') {
        url = 'https://api.openai.com/v1/models';
        key = document.getElementById('openai-key').value;
        modelName = document.getElementById('openai-model').value || 'gpt-4o-mini';
    } else if (provider === 'spark') {
        url = 'api/llm/models';
        modelName = document.getElementById('spark-model').value;
    } else if (provider === 'gemini') {
        alert("Gemini Modelle haben in der Regel ein Context Window von 1.000.000+ Tokens.\nSetze das Limit manuell auf 100.000, das reicht völlig für alle Dokumente.");
        document.getElementById('max-evidence-chars').value = 100000;
        saveUserKeys();
        return;
    }

    try {
        if (provider === 'openai') {
            if(!key) { alert("Bitte zuerst einen OpenAI API-Key eingeben."); return; }
            let ctx = 8192; 
            const m = modelName.toLowerCase();
            if (m.includes('gpt-4o') || m.includes('gpt-4-turbo')) ctx = 128000;
            
            const outTokens = parseInt(document.getElementById('max-output-tokens').value, 10) || 8192;
            const chars = Math.floor((ctx - outTokens) * 3.5);
            document.getElementById('max-evidence-chars').value = chars;
            saveUserKeys();
            alert(`OpenAI Modell erkannt (${ctx} Tokens).\nLimit wurde automatisch auf ${chars.toLocaleString()} Zeichen gesetzt.`);
            log(`Auto-Detect: OpenAI ${ctx} Tokens -> ${chars} Zeichen`, 'success');
            return;
        }

        const fetchHeaders = {};
        if (key && key !== 'lm-studio') fetchHeaders['Authorization'] = `Bearer ${key}`;
        const response = await fetch(url, { headers: fetchHeaders });
        if (!response.ok) throw new Error(`API Fehler: ${response.status}`);
        
        const data = await response.json();
    if (useSchema && payload.response_format?.type === 'json_schema') {
        structuredOutputSupport[schemaKey] = 'yes';
        stepBase.structured_output = 'json_schema';
    }
        let ctx = null;
        
        if (data.data && data.data.length > 0) {
            const modelData = data.data.find(m => modelName && m.id === modelName) || data.data[0];
            ctx = modelData.context_length || modelData.max_model_len || 
                  (modelData.metadata && modelData.metadata.context_length) ||
                  (modelData.parameters && modelData.parameters.n_ctx) || null;
        }

        if (ctx) {
            const outTokens = parseInt(document.getElementById('max-output-tokens').value, 10) || 8192;
            const chars = Math.floor((ctx - outTokens) * 3.5);
            document.getElementById('max-evidence-chars').value = chars;
            saveUserKeys();
            alert(`Lokales Modell erkannt (${ctx} Tokens).\nLimit wurde automatisch auf ${chars.toLocaleString()} Zeichen gesetzt.`);
            log(`Auto-Detect: Lokal ${ctx} Tokens -> ${chars} Zeichen`, 'success');
        } else {
            alert("Der lokale Server verheimlicht das Kontext-Limit leider in der API-Antwort.\n\nBitte prüfe den n_ctx Wert in deinem Studio und trage ihn manuell anhand der Faustregel ein.");
            log('Auto-Detect: Lokaler Server liefert keine Kontext-Größe.', 'warning');
        }
    } catch (e) {
        console.error(e);
        alert("Fehler bei der Verbindung. Stelle sicher, dass die Base-URL korrekt ist und der Server läuft.");
    }
}

// ==========================================
// LLM API WRAPPER (inkl. Performance-Messung)
// ==========================================
// Jeder Agent-Aufruf landet mit Prompt und Rohantwort in currentRunSteps und wird am Ende des Laufs
// zusammen mit dem Ergebnis gespeichert (Historie → "Agent-Protokoll").
let currentRunSteps = null;

function recordStep(step) {
    if (!currentRunSteps) return;
    currentRunSteps.push({ id: newId(), seq: currentRunSteps.length, at: new Date().toISOString(), ...step });
}

// ==========================================
// STATUS-LAMPE: Ist das gewählte Modell erreichbar?
// ==========================================
const PROVIDER_LABELS = { custom1: 'Lokales Profil 1', custom2: 'Lokales Profil 2', custom3: 'Lokales Profil 3', hochschule: 'Hochschul-API', endpoint: 'Eigener Endpunkt', openai: 'OpenAI', gemini: 'Gemini', spark: 'Spark-Modell' };
const LLM_STATUS_INTERVAL_MS = 2 * 60 * 1000;
let llmStatusSeq = 0;
let llmStatusDebounce = null;
let llmStatusInterval = null;
let lastRespondedModel = {};   // Provider → Modell, das zuletzt tatsächlich geantwortet hat

function setLlmStatus(state, text, title = '') {
    const lamp = document.getElementById('llm-lamp');
    const label = document.getElementById('llm-status-text');
    if (!lamp || !label) return;
    lamp.className = `lamp ${state}`;
    label.textContent = text;
    document.getElementById('llm-status').title = `${title ? title + '\n' : ''}Klicken zum erneuten Prüfen.`;
}

// Ermittelt Modellliste-Endpunkt, Header und eingestelltes Modell des aktiven Providers.
function currentLlmConfig() {
    const provider = document.getElementById('llm-provider').value;
    const label = PROVIDER_LABELS[provider] || provider;
    if (isUrlProvider(provider)) {
        const base = document.getElementById(provider + '-url').value.trim().replace(/\/$/, '');
        const key = document.getElementById(provider + '-key').value;
        const model = document.getElementById(provider + '-model').value.trim();
        if (!base) return { provider, label, error: 'keine Endpunkt-URL eingetragen' };
        if (KEY_REQUIRED_PROVIDERS.includes(provider) && !key) return { provider, label, error: 'API-Key fehlt' };
        if (MODEL_PROVIDERS.includes(provider) && !model) return { provider, label, error: 'kein Modell aktiviert (erst „Modelle suchen“)' };
        return { provider, label, url: base + '/models', headers: key && key !== 'lm-studio' ? { Authorization: `Bearer ${key}` } : {}, model, checkModel: true };
    }
    if (provider === 'openai') {
        const key = document.getElementById('openai-key').value;
        if (!key) return { provider, label, error: 'API-Key fehlt' };
        return { provider, label, url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${key}` }, model: document.getElementById('openai-model').value.trim() || 'gpt-4o-mini', checkModel: true };
    }
    if (provider === 'gemini') {
        const key = document.getElementById('gemini-key').value;
        if (!key) return { provider, label, error: 'API-Key fehlt' };
        return { provider, label, url: 'https://generativelanguage.googleapis.com/v1beta/openai/models', headers: { Authorization: `Bearer ${key}` }, model: document.getElementById('gemini-model').value.trim() || 'gemini-2.5-flash', checkModel: true };
    }
    if (provider === 'spark') {
        if (!isLinked()) return { provider, label, error: 'Profil nicht mit dem Spark verknüpft' };
        return { provider, label, url: 'api/llm/models', headers: {}, model: document.getElementById('spark-model').value.trim(), checkModel: true };
    }
    return { provider, label, error: 'unbekannter Provider' };
}

async function checkLlmStatus() {
    if (!currentUser) return;
    const seq = ++llmStatusSeq;
    const cfg = currentLlmConfig();
    if (cfg.error) { setLlmStatus('err', `${cfg.label}: ${cfg.error}`); return; }
    setLlmStatus('checking', `${cfg.label}: ${cfg.model || 'Standardmodell'} – prüfe…`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
        const res = await fetch(cfg.url, { headers: cfg.headers, signal: ctrl.signal });
        if (seq !== llmStatusSeq) return;
        if (!res.ok) {
            const reason = res.status === 401 || res.status === 403 ? 'nicht berechtigt (API-Key/Anmeldung prüfen)' : res.status === 502 ? 'Modell-Server antwortet nicht' : `Fehler ${res.status}`;
            setLlmStatus('err', `${cfg.label}: ${reason}`);
            return;
        }
        const data = await res.json();
        const ids = (Array.isArray(data?.data) ? data.data : []).map(m => String(m.id || ''));
        const shown = cfg.model || (ids.includes(lastRespondedModel[cfg.provider]) ? lastRespondedModel[cfg.provider] : ids[0]) || 'Standardmodell';
        const known = !cfg.model || !ids.length || ids.some(id => id === cfg.model || id.endsWith('/' + cfg.model));
        const checkedAt = new Date().toLocaleTimeString();
        if (cfg.checkModel && !known) {
            setLlmStatus('warn', `${cfg.label}: Modell „${cfg.model}“ nicht gefunden`, `Verbunden, aber das eingestellte Modell fehlt in der Liste (${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ', …' : ''}). Geprüft um ${checkedAt}.`);
        } else {
            setLlmStatus('ok', `${cfg.label} · ${shown}${visionSuffix(cfg)}`, `Verbunden, ${ids.length} Modell(e) verfügbar. Geprüft um ${checkedAt}.${visionTooltip(cfg)}`);
        }
    } catch (err) {
        if (seq !== llmStatusSeq) return;
        setLlmStatus('err', `${cfg.label}: nicht erreichbar`, err?.name === 'AbortError' ? 'Keine Antwort innerhalb von 8 Sekunden.' : explainNetworkError(new URL(cfg.url, location.href).href));
    } finally {
        clearTimeout(timer);
    }
}

function scheduleLlmStatusCheck(delayMs = 800) {
    clearTimeout(llmStatusDebounce);
    llmStatusDebounce = setTimeout(checkLlmStatus, delayMs);
}

function startLlmStatusMonitor() {
    stopLlmStatusMonitor();
    checkLlmStatus();
    llmStatusInterval = setInterval(() => { if (!document.hidden) checkLlmStatus(); }, LLM_STATUS_INTERVAL_MS);
}

function stopLlmStatusMonitor() {
    clearInterval(llmStatusInterval);
    clearTimeout(llmStatusDebounce);
    llmStatusInterval = null;
    llmStatusSeq++;
}

// Nach einem echten Modellaufruf: Das Modell, das geantwortet hat, ist der sicherste Nachweis.
function markLlmCall(ok, provider, modelOrError) {
    llmStatusSeq++;   // laufende Prüfung soll diese Information nicht überschreiben
    const label = PROVIDER_LABELS[provider] || provider;
    if (ok && modelOrError) lastRespondedModel[provider] = modelOrError;
    if (ok) {
        const cfg = currentLlmConfig();
        setLlmStatus('ok', `${label} · ${modelOrError || 'Standardmodell'}${visionSuffix(cfg)}`, `Letzte Antwort um ${new Date().toLocaleTimeString()} von diesem Modell erhalten.${visionTooltip(cfg)}`);
    }
    else setLlmStatus('err', `${label}: Aufruf fehlgeschlagen`, modelOrError);
}

// ==========================================
// BILDER (Tabellen/Abbildungen) AN DAS MODELL
// ==========================================
// OpenAI-kompatibles Format: Text plus image_url-Teile. Verstehen OpenAI, Gemini, vLLM mit
// Vision-Modell und LM Studio mit Vision-Modell; reine Textmodelle lehnen das ab oder ignorieren es.
function buildUserContent(prompt, images) {
    if (!Array.isArray(images) || !images.length) return prompt;
    return [{ type: 'text', text: prompt }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))];
}

// Ergebnis der Bildprüfung je Provider und Modell (für diese Sitzung): yes | no | unknown
const visionSupport = {};
// Unterstützt der Server response_format "json_schema"? je Provider|Modell: yes | no
const structuredOutputSupport = {};

function visionKey(cfg = currentLlmConfig()) {
    return `${cfg.provider}|${cfg.model || ''}`;
}

function visionSuffix(cfg) {
    const v = visionSupport[visionKey(cfg)];
    return v?.state === 'yes' ? ' · 🖼️ Bilder' : v?.state === 'no' ? ' · nur Text' : '';
}

function visionTooltip(cfg) {
    const structured = structuredOutputSupport[visionKey(cfg)];
    const structuredText = structured === 'yes' ? ' Strukturierte JSON-Ausgabe (Schema): ja.' : structured === 'no' ? ' Strukturierte JSON-Ausgabe (Schema): nicht unterstützt, einfacher JSON-Modus.' : '';
    const v = visionSupport[visionKey(cfg)];
    if (!v) return structuredText;
    return structuredText + visionTooltipText(v);
}

function visionTooltipText(v) {
    return v.state === 'yes' ? ' Das Modell verarbeitet Bilder (Tabellen/Abbildungen werden als Bild mitgeschickt).'
        : v.state === 'no' ? ' Das Modell verarbeitet keine Bilder – Tabellen und Abbildungen nur als Text.' : '';
}

function probeImageDataUrl() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#e00000';
    ctx.fillRect(0, 0, 64, 64);
    return canvas.toDataURL('image/png');
}

// Kleiner Testaufruf mit einem roten Bild. Kommt "rot/red" zurück, versteht das Modell Bilder.
async function probeVisionSupport(force = false) {
    const cfg = currentLlmConfig();
    const key = visionKey(cfg);
    if (!force && visionSupport[key] && visionSupport[key].state !== 'unknown') return visionSupport[key];
    if (cfg.error) return (visionSupport[key] = { state: 'unknown', detail: cfg.error });
    updateVisionHint('checking');
    let result;
    try {
        const answer = await callLLM('Welche Farbe hat das beigefügte Bild? Antworte als JSON {"farbe":"..."}.', { agent: 'vision-probe', images: [probeImageDataUrl()] });
        result = /\b(rot|red|rote|rosso|rouge)\b/i.test(String(answer))
            ? { state: 'yes', detail: 'Testbild erkannt.' }
            : { state: 'no', detail: 'Das Modell hat das Testbild nicht erkannt.' };
    } catch (err) {
        const msg = err?.message || String(err);
        // HTTP-Fehler 4xx bei Bildern heißt fast immer: Modell/Server ohne Bildverarbeitung
        result = /API Fehler \(4\d\d\)/.test(msg)
            ? { state: 'no', detail: 'Der Modell-Server lehnt Bilder ab.' }
            : { state: 'unknown', detail: msg };
    }
    result.checkedAt = new Date().toLocaleTimeString();
    visionSupport[key] = result;
    updateVisionHint();
    if (result.state !== 'unknown') scheduleLlmStatusCheck(200);
    return result;
}

function updateVisionHint(phase) {
    const el = document.getElementById('vision-hint');
    if (!el || !currentUser) return;
    const enabled = document.getElementById('opt-vision')?.checked;
    const v = visionSupport[visionKey()];
    let text, cls;
    if (phase === 'checking') { text = '⏳ Prüfe, ob das Modell Bilder verarbeitet…'; cls = 'checking'; }
    else if (!enabled) { text = 'Aus – Tabellen und Abbildungen werden nur als Text ausgewertet.'; cls = 'off'; }
    else if (v?.state === 'yes') { text = '✓ Das gewählte Modell verarbeitet Bilder – Tabellen und Abbildungen werden zusätzlich als Bild ausgewertet.'; cls = 'yes'; }
    else if (v?.state === 'no') { text = '✗ Das gewählte Modell verarbeitet keine Bilder – Tabellen und Abbildungen werden nur als Text ausgewertet.'; cls = 'no'; }
    else { text = v?.detail ? `? Nicht prüfbar (${v.detail}). Wird beim Start erneut geprüft.` : '? Noch nicht geprüft – wird beim Start der Analyse automatisch geprüft.'; cls = 'unknown'; }
    el.textContent = text;
    el.className = `vision-hint ${cls}`;
}

// Der Browser verrät bei abgelehnten Verbindungen keinen Grund ("NetworkError" / "Failed to fetch").
// Aus Seiten- und Ziel-Adresse lässt sich die wahrscheinliche Ursache aber eingrenzen.
function explainNetworkError(url, elapsedMs = 0) {
    let target;
    try { target = new URL(url, location.href); } catch (e) { return 'Die Base-URL ist ungültig.'; }
    if (target.origin === location.origin) return 'Der Spark-Server ist nicht erreichbar (offline?).';
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
    if (location.protocol === 'https:' && target.protocol === 'http:' && !local) {
        return `Die App läuft über https, der Endpunkt aber über unverschlüsseltes http auf ${target.host}. Das blockiert der Browser grundsätzlich („Mixed Content“). `
            + 'Ein Modell auf dem Spark ist von außen erst über die Weiterleitung durch den Spark-Server nutzbar.';
    }
    if (local) {
        return `Auf diesem Gerät antwortet unter ${target.host} kein Server, oder er erlaubt keine Browser-Zugriffe. `
            + 'LM Studio: Server starten und unter Developer → Settings „Enable CORS“ einschalten. „localhost“ meint immer das Gerät, auf dem der Browser läuft.';
    }
    if (!navigator.onLine) return 'Das Gerät ist offline.';
    // Nach langer Wartezeit ist es fast immer ein Zeitlimit (Gateway/Proxy, z.B. 5 Minuten), kein CORS-Problem.
    if (elapsedMs > 60000) {
        return `Die Verbindung zu ${target.host} wurde nach ${(elapsedMs / 60000).toFixed(1).replace('.', ',')} Minuten getrennt. Das ist meist ein Zeitlimit des Servers oder Gateways (z.B. 5 Minuten für eine Antwort; auch Streaming umgeht es manchmal nicht), kein CORS-Problem. `
            + 'Abhilfe: im Dashboard „Kurze Antworten“ und „Reasoning abschalten“ wählen, Seitenbilder abschalten, Max. Output Tokens und Max. Zeichen Evidenz senken oder ein schnelleres Modell wählen.';
    }
    return `Der Server ${target.host} ist nicht erreichbar, oder er erlaubt keine Aufrufe aus dem Browser (CORS: Der Anbieter muss „Access-Control-Allow-Origin“ senden). Bitte URL, Netzwerk und – bei Hochschul-Netzen – VPN prüfen.`;
}

const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));

// Anbieter, bei denen die Antwort als Datenstrom (SSE) geholt wird: Ein einzelner langer Aufruf läuft sonst in
// Zeitlimits von Gateways (z.B. 5 Minuten ohne Antwort) und endet als scheinbarer Netzwerkfehler.
const STREAM_PROVIDERS = ['hochschule', 'endpoint'];
const streamingSupport = {};            // Provider|Modell: 'no', wenn der Server Streaming ablehnt
const reasoningParamSupport = {};        // Provider|Modell: 'no', wenn der Server chat_template_kwargs ablehnt
const schemaServerErrors = {};          // Provider|Modell: Anzahl 5xx-Fehler, nach denen ohne Schema gelang
const RETRYABLE_STATUS = [429, 500, 502, 503, 504];
const MAX_SEND_ATTEMPTS = 3;

// Liest eine Chat-Antwort, die als Datenstrom (SSE) oder – wenn der Server Streaming ignoriert – als einzelnes
// JSON kommt. Entschieden wird am Inhalt, nicht am Content-Type: Gateways liefern SSE auch als text/plain.
async function readChatResponse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', content = '', model = null, usage = null, finish = null, mode = null, whole = '';
    const handleLine = raw => {
        const line = raw.trim();
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        let chunk;
        try { chunk = JSON.parse(payload); } catch (e) { return; }
        if (chunk.error) throw new Error(`API Fehler (Datenstrom): ${typeof chunk.error === 'string' ? chunk.error : chunk.error.message || JSON.stringify(chunk.error)}`);
        if (chunk.model) model = chunk.model;
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) content += choice.delta.content;
        if (choice?.finish_reason) finish = choice.finish_reason;
    };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (!mode) {
            if (!text.trim()) continue;
            mode = text.trimStart().startsWith('{') ? 'json' : 'sse';
        }
        if (mode === 'json') { whole += text; continue; }
        buffer += text;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
            handleLine(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
        }
    }
    if (mode === 'json') {
        try { return JSON.parse(whole + decoder.decode()); }
        catch (e) { throw new Error(`Die Antwort ist kein gültiges JSON (${whole.slice(0, 120).replace(/\s+/g, ' ')}…)`); }
    }
    if (!mode) throw new Error('Leere Antwort des Servers.');
    handleLine(buffer);
    if (!content && !finish) throw new Error(`Der Datenstrom enthält keinen Antworttext (${buffer.slice(0, 120).replace(/\s+/g, ' ')})`);
    return { model, usage, choices: [{ message: { content }, finish_reason: finish }] };
}

async function callLLM(prompt, meta = {}) {
    const provider = document.getElementById('llm-provider').value;
    let url, key, model;
    
    if (isUrlProvider(provider)) {
        let baseUrl = document.getElementById(provider + '-url').value.trim().replace(/\/$/, '');
        if (!baseUrl) throw new Error(`${PROVIDER_LABELS[provider]}: Endpunkt-URL fehlt in der Konfiguration!`);
        url = baseUrl + '/chat/completions';
        model = document.getElementById(provider + '-model').value || 'local-model';
        key = document.getElementById(provider + '-key').value || 'lm-studio';
        if (KEY_REQUIRED_PROVIDERS.includes(provider) && key === 'lm-studio') throw new Error(`${PROVIDER_LABELS[provider]}: API-Key fehlt in der Konfiguration!`);
        if (MODEL_PROVIDERS.includes(provider) && model === 'local-model') throw new Error(`${PROVIDER_LABELS[provider]}: Kein Modell aktiviert – bitte unter Konfiguration „Modelle suchen“ und ein Modell aktivieren.`);
    } else if (provider === 'openai') {
        url = 'https://api.openai.com/v1/chat/completions';
        key = document.getElementById('openai-key').value;
        model = document.getElementById('openai-model').value || 'gpt-4o-mini';
        if(!key) throw new Error("OpenAI API-Key fehlt in der Konfiguration!");
    } else if (provider === 'gemini') {
        url = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
        key = document.getElementById('gemini-key').value;
        model = document.getElementById('gemini-model').value || 'gemini-2.5-flash';
        if(!key) throw new Error("Google Gemini API-Key fehlt in der Konfiguration!");
    } else if (provider === 'spark') {
        // Über den Spark-Server weitergeleitet; ohne Modellnamen wählt der Server sein Standardmodell.
        if (!isLinked()) throw new Error('Das Spark-Modell ist nur mit einem Konto auf dem Spark nutzbar (Konfiguration → Mit Spark verknüpfen).');
        url = 'api/llm/chat/completions';
        model = document.getElementById('spark-model').value.trim();
        key = null;
    }

    const maxTokens = Number.isFinite(meta.maxTokens) ? meta.maxTokens : (parseInt(document.getElementById('max-output-tokens').value, 10) || 8192);
    const temperature = Number.isFinite(meta.temperature) ? meta.temperature : (parseFloat(document.getElementById('llm-temperature').value) || 0.0);
    let systemPrompt = document.getElementById('llm-system-prompt').value || DEFAULT_SYSTEM_PROMPT;

    let isThinkingAllowed = false;
    if (isUrlProvider(provider) || provider === 'spark') {
        isThinkingAllowed = document.getElementById(provider + '-thinking').checked;
    }

    // Langsame Server mit Zeitlimit: kürzere Antworten, damit sie rechtzeitig fertig werden.
    if (document.getElementById('opt-compact')?.checked) {
        systemPrompt += '\n\nFASSE DICH KURZ: Zitate höchstens 25 Wörter, Begründungen und Notizen höchstens ein Satz, höchstens 12 Belegstellen in evidence_locations, leere Felder knapp als "not_reported". Keine Wiederholungen.';
    }

    if (isThinkingAllowed) {
        systemPrompt += "\n\nHINWEIS: Du bist ein Reasoning-Modell. Du darfst vor der JSON-Ausgabe nachdenken. Nutze dafür ggf. <think> Tags. Dein finales Ergebnis MUSS jedoch zwingend mit '{' beginnen und ein valides JSON sein.";
    }

    const payload = {
        ...(model ? { model } : {}),
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: buildUserContent(prompt, meta.images) }
        ],
        temperature: temperature
    };

    if (provider === 'openai') {
        payload.max_completion_tokens = maxTokens;
    } else {
        payload.max_tokens = maxTokens;
    }

    const vllmLike = provider === 'spark' || (provider.startsWith('custom') && url.includes('8000'));
    const applyJsonObjectMode = () => {
        delete payload.response_format;
        if (vllmLike && !isThinkingAllowed) {
            const m = (model || '').toLowerCase();
            // Ohne Modellnamen (Spark-Standardmodell) wird JSON-Modus ebenfalls angefordert; vLLM unterstützt ihn generell.
            if (!m || m.includes('qwen') || m.includes('nvidia') || m.includes('deepseek')) {
                payload.response_format = { type: "json_object" };
            }
        }
    };
    // Strukturierte Ausgabe nach JSON-Schema, solange der Server sie nicht abgelehnt hat. Im Thinking-Modus
    // nicht: Das Modell soll vor dem JSON frei nachdenken dürfen.
    const schemaKey = `${provider}|${model || ''}`;
    // Manche Server hängen bei strengen JSON-Schemata oder brauchen dafür sehr lange: per Option abschaltbar.
    const schemaWanted = meta.forceSchema || (!meta.noSchema && !document.getElementById('opt-no-schema')?.checked && structuredOutputSupport[schemaKey] !== 'no');
    const useSchema = !!meta.schema && !isThinkingAllowed && schemaWanted;
    if (useSchema) {
        payload.response_format = { type: 'json_schema', json_schema: { name: meta.schema.name, schema: meta.schema.schema, strict: true } };
    } else {
        applyJsonObjectMode();
    }

    const reasoningKey = `${provider}|${model || ''}`;
    if (document.getElementById('opt-no-reasoning')?.checked && (isUrlProvider(provider) || provider === 'spark') && !isThinkingAllowed && reasoningParamSupport[reasoningKey] !== 'no') {
        payload.chat_template_kwargs = { enable_thinking: false };
    }
    const streamKey = `${provider}|${model || ''}`;
    if (STREAM_PROVIDERS.includes(provider) && streamingSupport[streamKey] !== 'no') {
        payload.stream = true;
        payload.stream_options = { include_usage: true };
    }

    const fetchHeaders = { 'Content-Type': 'application/json' };
    if (key && key !== 'lm-studio') fetchHeaders['Authorization'] = `Bearer ${key}`;
    if (provider === 'spark') fetchHeaders['X-Lit-Request'] = '1';

    const startTime = performance.now(); // Startzeit messen

    const stepBase = {
        agent: meta.agent || null, doc: meta.doc || null, prompt_version_id: meta.promptVersionId || null,
        provider, model, url, temperature, max_tokens: maxTokens, system_prompt: systemPrompt, prompt, run: meta.run, part: meta.part,
        images: meta.images?.length ? meta.imagePages || meta.images.length : undefined
    };
    let response, attempt = 0, schemaFallbackUsed = false, attemptStart = performance.now();
    const rec = step => { if (!meta.quiet) recordStep(step); };
    let schemaTimeoutRetried = false;
    // Eigenes Zeitlimit je Versuch (Dashboard): Hängt ein Aufruf, wird früh abgebrochen und neu gestartet, statt 5 Minuten zu warten.
    const clientTimeoutMs = Math.max(0, parseInt(document.getElementById('opt-call-timeout')?.value, 10) || 0) * 1000;
    const send = () => {
        const init = { method: 'POST', headers: fetchHeaders, body: JSON.stringify(payload) };
        const limit = meta.timeoutMs || clientTimeoutMs;
        if (limit) init.signal = AbortSignal.timeout(limit);
        return fetch(url, init);
    };
    for (;;) {
        attempt++;
        attemptStart = performance.now();
        try {
            response = await send();
            // Abgelaufene Spark-Sitzung: einmal still neu anmelden und wiederholen.
            if (provider === 'spark' && response.status === 401 && await serverLogin(currentUser, currentPassKey)) {
                response = await send();
            }
        } catch (err) {
            const elapsed = performance.now() - attemptStart;
            // Verbindungsaufbau gescheitert (schnell): wiederholen. Nach langer Wartezeit ist es ein Zeitlimit – dann nicht erneut warten.
            if (attempt < MAX_SEND_ATTEMPTS && elapsed < 30000 && navigator.onLine !== false) {
                log(`Keine Verbindung zu ${new URL(url, location.href).host} – neuer Versuch ${attempt + 1}/${MAX_SEND_ATTEMPTS}...`, 'warning');
                await sleepMs(2000 * attempt);
                continue;
            }
            const timedOut = err?.name === 'TimeoutError' && !meta.timeoutMs;
            if (timedOut && attempt < MAX_SEND_ATTEMPTS) {
                log(`Keine Antwort nach ${Math.round(elapsed / 1000)} s (eigenes Zeitlimit) – neuer Versuch ${attempt + 1}/${MAX_SEND_ATTEMPTS}...`, 'warning');
                continue;
            }
            // Lange Wartezeit mit JSON-Schema: Das Schema kann den Server aufhalten – einmal ohne Schema wiederholen und es merken.
            if (elapsed >= 60000 && !meta.quiet && !schemaTimeoutRetried && payload.response_format?.type === 'json_schema' && !meta.timeoutMs) {
                schemaTimeoutRetried = true;
                structuredOutputSupport[schemaKey] = 'no';
                applyJsonObjectMode();
                stepBase.structured_output = 'Zeitlimit-Rückfall';
                log(`Keine Antwort nach ${(elapsed / 60000).toFixed(1).replace('.', ',')} Minuten – neuer Versuch ohne JSON-Schema (strenge Schemata können Server aufhalten). Das Schema bleibt für dieses Modell aus.`, 'warning');
                continue;
            }
            const hint = explainNetworkError(url, elapsed);
            rec({ ...stepBase, duration_ms: Math.round(performance.now() - startTime), error: `${err?.message || err} – ${hint}` });
            markLlmCall(false, provider, hint);
            throw new Error(`Keine Verbindung zu ${url}. ${hint}`);
        }
        if (response.ok) break;

        const rejected = response.status === 400 || response.status === 422;
        // Server kennt kein Streaming: merken und ohne Datenstrom wiederholen.
        if (rejected && payload.stream) {
            const errText = await response.clone().text();
            if (/stream/i.test(errText)) {
                streamingSupport[streamKey] = 'no';
                delete payload.stream; delete payload.stream_options;
                log('Der Modell-Server lehnt Streaming ab – weiter ohne Datenstrom.', 'warning');
                continue;
            }
        }
        // Server kennt chat_template_kwargs nicht: merken und ohne wiederholen.
        if ((rejected || RETRYABLE_STATUS.includes(response.status)) && payload.chat_template_kwargs) {
            const errText = await response.clone().text();
            if (rejected ? /chat_template|template_kwargs|enable_thinking|extra|unknown|unexpected|unrecognized/i.test(errText) : attempt === 1) {
                reasoningParamSupport[reasoningKey] = 'no';
                delete payload.chat_template_kwargs;
                log(`Der Modell-Server nimmt „Reasoning abschalten“ nicht an (${response.status}: ${errText.replace(/\s+/g, ' ').slice(0, 160) || 'ohne Text'}) – weiter ohne diesen Parameter.`, 'warning');
                continue;
            }
        }
        // Server kennt kein json_schema: merken und mit dem bisherigen JSON-Modus wiederholen.
        if (rejected && payload.response_format?.type === 'json_schema') {
            const errText = await response.clone().text();
            if (/schema|response_format|structured|guided|json/i.test(errText)) {
                structuredOutputSupport[schemaKey] = 'no';
                log(`Strukturierte JSON-Ausgabe wird vom Modell-Server nicht unterstützt – weiter mit einfachem JSON-Modus.`, 'warning');
                applyJsonObjectMode();
                stepBase.structured_output = 'abgelehnt';
                continue;
            }
        }
        // Serverfehler (500/502/503/504) oder Überlastung (429): erst ohne Schema, dann mit Wartezeit erneut versuchen.
        if (RETRYABLE_STATUS.includes(response.status) && attempt < MAX_SEND_ATTEMPTS) {
            const errText = (await response.clone().text()).slice(0, 200);
            // Erst derselbe Aufruf noch einmal: Bei manchen Gateways scheitert ein Teil der Anfragen zufällig und sofort (defekter Knoten).
            if (attempt === 1) {
                log(`Modell-Server meldet ${response.status} (${errText || 'ohne Text'}) – neuer Versuch ${attempt + 1}/${MAX_SEND_ATTEMPTS}.`, 'warning');
                await sleepMs(1000);
                continue;
            }
            if (payload.response_format?.type === 'json_schema' && !schemaFallbackUsed) {
                schemaFallbackUsed = true;
                applyJsonObjectMode();
                stepBase.structured_output = 'Serverfehler-Rückfall';
                log(`Modell-Server meldet ${response.status} (${errText || 'ohne Text'}) – neuer Versuch ohne JSON-Schema (${attempt + 1}/${MAX_SEND_ATTEMPTS}).`, 'warning');
                continue;
            }
            const retryAfter = Number(response.headers.get('retry-after'));
            const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 3000 * attempt * attempt;
            log(`Modell-Server meldet ${response.status} (${errText || 'ohne Text'}) – neuer Versuch ${attempt + 1}/${MAX_SEND_ATTEMPTS} in ${Math.round(wait / 1000)} s...`, 'warning');
            await sleepMs(wait);
            continue;
        }
        break;
    }
    // Ohne Schema gelang, was mit Schema am Serverfehler scheiterte: nach wiederholtem Auftreten das Schema für dieses Modell abschalten.
    if (response.ok && schemaFallbackUsed) {
        schemaServerErrors[schemaKey] = (schemaServerErrors[schemaKey] || 0) + 1;
        if (schemaServerErrors[schemaKey] >= 2 && structuredOutputSupport[schemaKey] !== 'no') {
            structuredOutputSupport[schemaKey] = 'no';
            log('Der Modell-Server scheitert wiederholt an strukturierter JSON-Ausgabe – ab jetzt einfacher JSON-Modus.', 'warning');
        }
    }

    let endTime = performance.now(); // Endzeit messen
    let durationSec = (endTime - startTime) / 1000;

    if (!response.ok) {
        const err = await response.text();
        rec({ ...stepBase, duration_ms: Math.round(endTime - startTime), status: response.status, error: err });
        let message = err;
        try { message = JSON.parse(err).error?.message || JSON.parse(err).error || err; } catch (e) { /* kein JSON */ }
        const authHint = (response.status === 401 || response.status === 403) && provider !== 'spark' ? ' – API-Key ungültig, abgelaufen oder für dieses Modell nicht berechtigt.' : '';
        // Manche Gateways melden ein zu kleines Kontextfenster nur als allgemeinen 500er – die Größe der Anfrage dazusetzen.
        const promptTokens = Math.round(JSON.stringify(payload.messages).length / 3.5);
        const sizeHint = response.status >= 500 || response.status === 413
            ? ` – Anfrage: ca. ${promptTokens.toLocaleString('de-DE')} Token Prompt + bis zu ${maxTokens.toLocaleString('de-DE')} Token Antwort. Hat das Modell ein kleineres Kontextfenster (z.B. 32.000), hilft es, „Max. Zeichen Evidenz“ oder „Max. Output Tokens“ zu senken.`
            : '';
        const errorText = `API Fehler (${response.status}): ${typeof message === 'string' ? message : JSON.stringify(message)}${authHint}${sizeHint}`;
        markLlmCall(false, provider, errorText);
        throw new Error(errorText);
    }
    let data;
    try {
        data = payload.stream ? await readChatResponse(response) : await response.json();
    } catch (err) {
        const elapsed = performance.now() - startTime;
        const hint = explainNetworkError(url, elapsed);
        rec({ ...stepBase, duration_ms: Math.round(elapsed), error: `Antwort abgebrochen: ${err?.message || err} – ${hint}` });
        markLlmCall(false, provider, hint);
        throw new Error(`Antwort von ${url} wurde unterbrochen: ${err?.message || err}. ${hint}`);
    }

    endTime = performance.now();   // bei Datenströmen erst nach dem letzten Teil
    durationSec = (endTime - startTime) / 1000;

    // Token/s Metrik aus den OpenAI-Usage-Daten extrahieren (falls vorhanden) oder schätzen
    const completionTokens = data.usage?.completion_tokens || Math.round(data.choices[0].message.content.length / 4);
    const tokensPerSec = durationSec > 0 ? Math.round(completionTokens / durationSec) : 0;

    // Global für den Historien-Run zwischenspeichern
    if (!window.currentRunMetrics) window.currentRunMetrics = [];
    window.currentRunMetrics.push(tokensPerSec);

    markLlmCall(true, provider, data.model || model);

    rec({
        ...stepBase, duration_ms: Math.round(endTime - startTime), status: response.status,
        response: data.choices?.[0]?.message?.content ?? null,
        tokens_in: data.usage?.prompt_tokens ?? null, tokens_out: data.usage?.completion_tokens ?? null,
        tokens_per_sec: tokensPerSec
    });

    return data.choices[0].message.content;
}


// ==========================================
// GESCHWINDIGKEITSTEST (zeigt, ob Schema, Wartezeit oder Erzeugungstempo bremsen)
// ==========================================
async function runSpeedTest() {
    const out = document.getElementById('speed-test-result');
    const button = document.getElementById('speed-test-btn');
    const provider = document.getElementById('llm-provider').value;
    out.innerHTML = '';
    button.disabled = true;
    const line = (text, cls = '') => { const div = document.createElement('div'); div.textContent = text; if (cls) div.className = cls; out.appendChild(div); return div; };
    const numbers = Array.from({ length: 150 }, (_, i) => i + 1).join(', ');
    const tests = [
        { label: 'Kurzer Aufruf ohne Schema', prompt: 'Antworte nur mit {"ok": true}', opts: { noSchema: true, maxTokens: 30 } },
        { label: 'Kurzer Aufruf mit kleinem JSON-Schema', prompt: 'Antworte nur mit {"ok": true}',
            opts: { forceSchema: true, maxTokens: 30, schema: { name: 'speedtest', schema: S.obj({ ok: S.bool() }) } } },
        { label: 'Aufruf mit dem Schema der Extraktion (Teil 1)', prompt: 'Titel: Test. Es handelt sich um eine Online-Befragung mit 200 Teilnehmenden im Marketing. Fülle das JSON aus.',
            opts: { forceSchema: true, maxTokens: 1500, schema: agentSchema('extraction', { part: 'classification' }) } },
        { label: 'Erzeugungstempo (ca. 450 Token Ausgabe ohne Schema)', prompt: `Antworte nur mit JSON: {"zahlen": [${numbers}]} – gib genau diese Zahlen aus.`, opts: { noSchema: true, maxTokens: 900 }, rate: true }
    ];
    try {
        for (const t of tests) {
            const row = line(`${t.label}: läuft…`);
            const before = (window.currentRunMetrics || []).length;
            const started = performance.now();
            try {
                await callLLM(t.prompt, { quiet: true, timeoutMs: 150000, agent: 'speedtest', ...t.opts });
                const sec = (performance.now() - started) / 1000;
                const tps = (window.currentRunMetrics || []).slice(before).pop();
                row.textContent = `${t.label}: ${sec.toFixed(1).replace('.', ',')} s${t.rate && tps ? `, ca. ${tps} Token/s` : ''}`;
                row.className = sec > 60 ? 'warn' : 'ok';
            } catch (err) {
                const sec = (performance.now() - started) / 1000;
                const timeout = err?.name === 'TimeoutError' || /timeout|aborted|getrennt|Zeitlimit/i.test(String(err?.message));
                row.textContent = `${t.label}: ${timeout ? `keine Antwort nach ${sec.toFixed(0)} s` : 'Fehler'} – ${String(err?.message || err).slice(0, 200)}`;
                row.className = 'err';
            }
        }
        line('Einordnung: Ist der Aufruf mit Schema viel langsamer als ohne, hilft „JSON-Schema nicht verwenden“. Dauert schon der Kurzaufruf lange, ist der Dienst ausgelastet oder wartet in einer Warteschlange. Ist nur das Erzeugungstempo niedrig, sind lange Antworten das Problem.');
    } finally {
        button.disabled = false;
    }
}
