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
function explainNetworkError(url) {
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
    return `Der Server ${target.host} ist nicht erreichbar, oder er erlaubt keine Aufrufe aus dem Browser (CORS: Der Anbieter muss „Access-Control-Allow-Origin“ senden). Bitte URL, Netzwerk und – bei Hochschul-Netzen – VPN prüfen.`;
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

    const maxTokens = parseInt(document.getElementById('max-output-tokens').value, 10) || 8192;
    const temperature = Number.isFinite(meta.temperature) ? meta.temperature : (parseFloat(document.getElementById('llm-temperature').value) || 0.0);
    let systemPrompt = document.getElementById('llm-system-prompt').value || DEFAULT_SYSTEM_PROMPT;

    let isThinkingAllowed = false;
    if (isUrlProvider(provider) || provider === 'spark') {
        isThinkingAllowed = document.getElementById(provider + '-thinking').checked;
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
    const useSchema = !!meta.schema && !isThinkingAllowed && structuredOutputSupport[schemaKey] !== 'no';
    if (useSchema) {
        payload.response_format = { type: 'json_schema', json_schema: { name: meta.schema.name, schema: meta.schema.schema, strict: true } };
    } else {
        applyJsonObjectMode();
    }

    const fetchHeaders = { 'Content-Type': 'application/json' };
    if (key && key !== 'lm-studio') fetchHeaders['Authorization'] = `Bearer ${key}`;
    if (provider === 'spark') fetchHeaders['X-Lit-Request'] = '1';

    const startTime = performance.now(); // Startzeit messen

    const stepBase = {
        agent: meta.agent || null, doc: meta.doc || null, prompt_version_id: meta.promptVersionId || null,
        provider, model, url, temperature, max_tokens: maxTokens, system_prompt: systemPrompt, prompt, run: meta.run,
        images: meta.images?.length ? meta.imagePages || meta.images.length : undefined
    };
    let response;
    const send = () => fetch(url, { method: 'POST', headers: fetchHeaders, body: JSON.stringify(payload) });
    try {
        response = await send();
        // Abgelaufene Spark-Sitzung: einmal still neu anmelden und wiederholen.
        if (provider === 'spark' && response.status === 401 && await serverLogin(currentUser, currentPassKey)) {
            response = await send();
        }
        // Server kennt kein json_schema: merken und mit dem bisherigen JSON-Modus wiederholen.
        if (useSchema && (response.status === 400 || response.status === 422)) {
            const errText = await response.clone().text();
            if (/schema|response_format|structured|guided|json/i.test(errText)) {
                structuredOutputSupport[schemaKey] = 'no';
                log(`Strukturierte JSON-Ausgabe wird vom Modell-Server nicht unterstützt – weiter mit einfachem JSON-Modus.`, 'warning');
                applyJsonObjectMode();
                stepBase.structured_output = 'abgelehnt';
                response = await send();
            }
        }
    } catch (err) {
        const hint = explainNetworkError(url);
        recordStep({ ...stepBase, duration_ms: Math.round(performance.now() - startTime), error: `${err?.message || err} – ${hint}` });
        markLlmCall(false, provider, hint);
        throw new Error(`Keine Verbindung zu ${url}. ${hint}`);
    }

    const endTime = performance.now(); // Endzeit messen
    const durationSec = (endTime - startTime) / 1000;

    if (!response.ok) {
        const err = await response.text();
        recordStep({ ...stepBase, duration_ms: Math.round(endTime - startTime), status: response.status, error: err });
        let message = err;
        try { message = JSON.parse(err).error?.message || JSON.parse(err).error || err; } catch (e) { /* kein JSON */ }
        const authHint = (response.status === 401 || response.status === 403) && provider !== 'spark' ? ' – API-Key ungültig, abgelaufen oder für dieses Modell nicht berechtigt.' : '';
        const errorText = `API Fehler (${response.status}): ${typeof message === 'string' ? message : JSON.stringify(message)}${authHint}`;
        markLlmCall(false, provider, errorText);
        throw new Error(errorText);
    }
    const data = await response.json();
    
    // Token/s Metrik aus den OpenAI-Usage-Daten extrahieren (falls vorhanden) oder schätzen
    const completionTokens = data.usage?.completion_tokens || Math.round(data.choices[0].message.content.length / 4);
    const tokensPerSec = durationSec > 0 ? Math.round(completionTokens / durationSec) : 0;

    // Global für den Historien-Run zwischenspeichern
    if (!window.currentRunMetrics) window.currentRunMetrics = [];
    window.currentRunMetrics.push(tokensPerSec);

    markLlmCall(true, provider, data.model || model);

    recordStep({
        ...stepBase, duration_ms: Math.round(endTime - startTime), status: response.status,
        response: data.choices?.[0]?.message?.content ?? null,
        tokens_in: data.usage?.prompt_tokens ?? null, tokens_out: data.usage?.completion_tokens ?? null,
        tokens_per_sec: tokensPerSec
    });

    return data.choices[0].message.content;
}
