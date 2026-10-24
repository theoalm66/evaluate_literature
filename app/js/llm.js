// ==========================================
// AUTO-DETECT CONTEXT SIZE
// ==========================================
async function autoDetectContext() {
    const provider = document.getElementById('llm-provider').value;
    let url, key, modelName;
    
    if (provider.startsWith('custom')) {
        let baseUrl = document.getElementById(provider + '-url').value.replace(/\/$/, '');
        url = baseUrl + '/models';
        key = document.getElementById(provider + '-key').value || 'lm-studio';
        modelName = document.getElementById(provider + '-model').value;
    } else if (provider === 'openai') {
        url = 'https://api.openai.com/v1/models';
        key = document.getElementById('openai-key').value;
        modelName = document.getElementById('openai-model').value || 'gpt-4o-mini';
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
        let ctx = null;
        
        if (data.data && data.data.length > 0) {
            const modelData = data.data[0];
            ctx = modelData.context_length || 
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

async function callLLM(prompt, meta = {}) {
    const provider = document.getElementById('llm-provider').value;
    let url, key, model;
    
    if (provider.startsWith('custom')) {
        let baseUrl = document.getElementById(provider + '-url').value.replace(/\/$/, '');
        url = baseUrl + '/chat/completions';
        model = document.getElementById(provider + '-model').value || 'local-model';
        key = document.getElementById(provider + '-key').value || 'lm-studio';
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
    }

    const maxTokens = parseInt(document.getElementById('max-output-tokens').value, 10) || 8192;
    const temperature = parseFloat(document.getElementById('llm-temperature').value) || 0.0;
    let systemPrompt = document.getElementById('llm-system-prompt').value || DEFAULT_SYSTEM_PROMPT;

    let isThinkingAllowed = false;
    if (provider.startsWith('custom')) {
        isThinkingAllowed = document.getElementById(provider + '-thinking').checked;
    }

    if (isThinkingAllowed) {
        systemPrompt += "\n\nHINWEIS: Du bist ein Reasoning-Modell. Du darfst vor der JSON-Ausgabe nachdenken. Nutze dafür ggf. <think> Tags. Dein finales Ergebnis MUSS jedoch zwingend mit '{' beginnen und ein valides JSON sein.";
    }

    const payload = {
        model: model,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt }
        ],
        temperature: temperature
    };

    if (provider === 'openai') {
        payload.max_completion_tokens = maxTokens;
    } else {
        payload.max_tokens = maxTokens;
    }

    if (provider.startsWith('custom') && url.includes('8000') && !isThinkingAllowed) {
        const m = model.toLowerCase();
        if (m.includes('qwen') || m.includes('nvidia') || m.includes('deepseek')) {
            payload.response_format = { type: "json_object" };
        }
    }

    const fetchHeaders = { 'Content-Type': 'application/json' };
    if (key && key !== 'lm-studio') fetchHeaders['Authorization'] = `Bearer ${key}`;

    const startTime = performance.now(); // Startzeit messen

    const stepBase = {
        agent: meta.agent || null, doc: meta.doc || null, prompt_version_id: meta.promptVersionId || null,
        provider, model, url, temperature, max_tokens: maxTokens, system_prompt: systemPrompt, prompt
    };
    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: fetchHeaders,
            body: JSON.stringify(payload)
        });
    } catch (err) {
        recordStep({ ...stepBase, duration_ms: Math.round(performance.now() - startTime), error: err?.message || String(err) });
        throw err;
    }

    const endTime = performance.now(); // Endzeit messen
    const durationSec = (endTime - startTime) / 1000;

    if (!response.ok) {
        const err = await response.text();
        recordStep({ ...stepBase, duration_ms: Math.round(endTime - startTime), status: response.status, error: err });
        throw new Error(`API Fehler (${response.status}): ${err}`);
    }
    const data = await response.json();
    
    // Token/s Metrik aus den OpenAI-Usage-Daten extrahieren (falls vorhanden) oder schätzen
    const completionTokens = data.usage?.completion_tokens || Math.round(data.choices[0].message.content.length / 4);
    const tokensPerSec = durationSec > 0 ? Math.round(completionTokens / durationSec) : 0;

    // Global für den Historien-Run zwischenspeichern
    if (!window.currentRunMetrics) window.currentRunMetrics = [];
    window.currentRunMetrics.push(tokensPerSec);

    recordStep({
        ...stepBase, duration_ms: Math.round(endTime - startTime), status: response.status,
        response: data.choices?.[0]?.message?.content ?? null,
        tokens_in: data.usage?.prompt_tokens ?? null, tokens_out: data.usage?.completion_tokens ?? null,
        tokens_per_sec: tokensPerSec
    });

    return data.choices[0].message.content;
}
