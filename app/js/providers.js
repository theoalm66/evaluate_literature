// ==========================================
// LLM-PROVIDER MIT EIGENER URL (OpenAI-kompatibel)
// ==========================================
// custom1–3 sind die bisherigen "Lokalen Profile". Neu: "Hochschul-API" und "Eigener Endpunkt" – beide mit
// Endpunkt-URL und API-Key, einer Modellsuche (GET {url}/models) und einem ausdrücklichen Aktivieren.
// Die Anfragen gehen direkt aus dem Browser an den Endpunkt; der Anbieter muss Browser-Zugriffe (CORS) erlauben.

const URL_PROVIDERS = ['custom1', 'custom2', 'custom3', 'hochschule', 'endpoint'];
const MODEL_PROVIDERS = ['hochschule', 'endpoint'];       // Provider mit Modellsuche
const KEY_REQUIRED_PROVIDERS = ['hochschule'];            // ohne API-Key nicht nutzbar
const PROVIDER_NAMES = { hochschule: 'Hochschul-API', endpoint: 'Eigener Endpunkt' };

function isUrlProvider(provider) {
    return URL_PROVIDERS.includes(provider);
}

// Modelle, die keine Chat-Modelle sind, blendet die Suche aus (Embeddings, Reranker, Sprache, Bilderzeugung).
const NON_CHAT_MODEL = /embed|rerank|(^|[-_/])e5([-_]|$)|bge-|whisper|tts|speech|dall-e|moderation|stable-diffusion|flux/i;

// Modell-IDs aus der Antwort von /models (OpenAI-Format {data:[{id}]}, Liste von Objekten oder von Strings)
function parseModelList(payload) {
    const list = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
    const ids = list.map(m => typeof m === 'string' ? m : String(m?.id ?? m?.name ?? '')).filter(Boolean);
    const unique = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    const chat = unique.filter(id => !NON_CHAT_MODEL.test(id));
    return { models: chat, hidden: unique.length - chat.length, all: unique };
}

function renderModelSelect(id, models, selected) {
    const select = document.getElementById(`${id}-model`);
    if (!select) return;
    const options = [...models];
    // Ein gespeichertes Modell bleibt auswählbar, auch wenn es in der aktuellen Liste fehlt oder noch nicht gesucht wurde.
    if (selected && !options.includes(selected)) options.unshift(selected);
    select.innerHTML = options.length
        ? options.map(m => `<option value="${escapeHTML(m)}">${escapeHTML(m)}${m === selected && !models.includes(m) ? ' (nicht in der Liste)' : ''}</option>`).join('')
        : '<option value="">– erst „Modelle suchen“ –</option>';
    select.value = selected && options.includes(selected) ? selected : (options[0] || '');
}

function setSearchStatus(id, kind, text) {
    const el = document.getElementById(`${id}-search-status`);
    if (!el) return;
    el.textContent = text;
    el.className = `model-search-status ${kind || ''}`;
}

async function searchModels(id) {
    const name = PROVIDER_NAMES[id] || id;
    const url = document.getElementById(`${id}-url`).value.trim().replace(/\/+$/, '');
    const key = document.getElementById(`${id}-key`).value.trim();
    if (!url) { setSearchStatus(id, 'err', 'Bitte zuerst die Endpunkt-URL eintragen.'); return; }
    if (!/^https?:\/\//i.test(url)) { setSearchStatus(id, 'err', 'Die URL muss mit https:// (oder http://) beginnen.'); return; }
    if (KEY_REQUIRED_PROVIDERS.includes(id) && !key) { setSearchStatus(id, 'err', 'Bitte zuerst den API-Key eintragen.'); return; }
    setSearchStatus(id, 'busy', 'Suche Modelle…');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
        const res = await fetch(`${url}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: ctrl.signal });
        if (res.status === 401 || res.status === 403) { setSearchStatus(id, 'err', `${name}: API-Key ungültig oder nicht berechtigt (${res.status}).`); return; }
        if (res.status === 404) { setSearchStatus(id, 'err', `${name}: Unter ${url}/models gibt es keine Modellliste (404). Ist die URL die OpenAI-kompatible Basis-URL, meist mit …/v1 am Ende?`); return; }
        if (!res.ok) { setSearchStatus(id, 'err', `${name}: Fehler ${res.status} bei der Modellsuche.`); return; }
        const { models, hidden } = parseModelList(await res.json());
        if (!models.length) { setSearchStatus(id, 'err', `${name}: Der Endpunkt meldet keine Chat-Modelle.`); return; }
        const db = getUserDB();
        const keys = db[currentUser].keys;
        keys[`${id}Models`] = models;
        const current = document.getElementById(`${id}-model`).value;
        renderModelSelect(id, models, models.includes(current) ? current : models[0]);
        setSearchStatus(id, 'ok', `${models.length} Modell(e) gefunden${hidden ? ` (${hidden} Embedding-/Audio-Modelle ausgeblendet)` : ''}. Bitte ein Modell wählen und aktivieren.`);
        await saveUserKeys();
    } catch (err) {
        const reason = err?.name === 'AbortError' ? 'Keine Antwort innerhalb von 15 Sekunden.' : explainNetworkError(`${url}/models`);
        setSearchStatus(id, 'err', `${name}: nicht erreichbar. ${reason}`);
    } finally {
        clearTimeout(timer);
    }
}

async function activateModel(id) {
    const name = PROVIDER_NAMES[id] || id;
    const model = document.getElementById(`${id}-model`).value;
    if (!document.getElementById(`${id}-url`).value.trim()) { setSearchStatus(id, 'err', 'Bitte zuerst die Endpunkt-URL eintragen.'); return; }
    if (KEY_REQUIRED_PROVIDERS.includes(id) && !document.getElementById(`${id}-key`).value.trim()) { setSearchStatus(id, 'err', 'Bitte zuerst den API-Key eintragen.'); return; }
    if (!model) { setSearchStatus(id, 'err', 'Bitte zuerst „Modelle suchen“ und ein Modell wählen.'); return; }
    document.getElementById('llm-provider').value = id;
    toggleProviderSettings();
    await saveUserKeys();
    setSearchStatus(id, 'ok', `✓ ${name} mit Modell „${model}“ ist jetzt aktiv.`);
    updateProviderActiveHints();
}

// Zeigt je Provider mit Modellsuche, ob er gerade aktiv ist und mit welchem Modell.
function updateProviderActiveHints() {
    const active = document.getElementById('llm-provider')?.value;
    for (const id of MODEL_PROVIDERS) {
        const el = document.getElementById(`${id}-active`);
        if (!el) continue;
        const model = document.getElementById(`${id}-model`)?.value;
        el.textContent = active === id ? `● Aktiv: ${PROVIDER_NAMES[id]}${model ? ` · ${model}` : ''}` : '○ Nicht aktiv – mit „Modell aktivieren“ verwenden.';
        el.className = `model-active ${active === id ? 'on' : ''}`;
    }
}

// Empfohlenes Zeichenlimit für den Evidenztext aus dem Kontextfenster. Vom Fenster gehen die Antwort und der Aufwand der Anweisungen
// (Prompt, Schema, Extraktion, Prüffragen) ab; Zahlen und Tabellen brauchen mehr Token je Zeichen als Fließtext. Ein sehr großes Fenster
// wird gedeckelt: Längere Texte kosten viel, bringen selten etwas und laufen leicht in Ratenlimits.
const PROMPT_OVERHEAD_TOKENS = 12000;
const CHARS_PER_TOKEN = 3.2;
const MAX_AUTO_EVIDENCE_CHARS = 200000;

function evidenceCharsForContext(contextTokens, outputTokens) {
    const usable = Number(contextTokens) - Number(outputTokens || 0) - PROMPT_OVERHEAD_TOKENS;
    if (!(usable > 0)) return 4000;
    return Math.min(MAX_AUTO_EVIDENCE_CHARS, Math.floor(usable * CHARS_PER_TOKEN / 1000) * 1000);
}

// Kontextfenster aus dem OpenAI-Modellnamen; bewusst vorsichtig (die genannten Modellfamilien haben mindestens 128.000 Token).
function openaiContextTokens(modelName) {
    const m = String(modelName || '').toLowerCase();
    if (/gpt-4o|gpt-4-turbo|gpt-4\.1|gpt-5|^o[134]/.test(m)) return 128000;
    if (/gpt-3\.5-turbo-16k/.test(m)) return 16000;
    return 8192;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { evidenceCharsForContext, openaiContextTokens, PROMPT_OVERHEAD_TOKENS, MAX_AUTO_EVIDENCE_CHARS, parseModelList, isUrlProvider, URL_PROVIDERS, MODEL_PROVIDERS, NON_CHAT_MODEL };
}
