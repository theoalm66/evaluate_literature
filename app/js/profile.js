// ==========================================
// AUTHENTICATION & MULTI-USER SYSTEM
// ==========================================
let currentUser = null;
let currentPassKey = null;

function hashString(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) { hash = ((hash << 5) + hash) + str.charCodeAt(i); }
    return hash.toString();
}

function encryptKey(text, password) {
    if (!text) return "";
    const encrypted = Array.from(text, (c, i) => String.fromCharCode(c.charCodeAt(0) ^ password.charCodeAt(i % password.length))).join('');
    return btoa(encrypted);
}

function decryptKey(base64, password) {
    if (!base64) return "";
    try {
        const decoded = atob(base64);
        return Array.from(decoded, (c, i) => String.fromCharCode(c.charCodeAt(0) ^ password.charCodeAt(i % password.length))).join('');
    } catch(e) { return ""; }
}

// getUserDB()/saveUserDB() liegen in storage.js (IndexedDB statt localStorage).

const PROMPT_HISTORY_LIMIT = 20;

function promptVersion(text, date) {
    const now = new Date();
    return { id: newId(), text, date: date || now.toLocaleString(), createdAt: now.toISOString() };
}

// MIGRATION
function ensureProfileStructure(db, user) {
    if (!db[user].sync) db[user].sync = { linked: false, promptHeads: {}, settingsUpdatedAt: null };
    if (!db[user].sync.promptHeads) db[user].sync.promptHeads = {};
    if (!db[user].prompts) {
        db[user].prompts = {
            extraction: [promptVersion(DEFAULT_PROMPTS.extraction, new Date().toLocaleString())],
            analysis: [promptVersion(DEFAULT_PROMPTS.analysis, new Date().toLocaleString())],
            synthesis: [promptVersion(DEFAULT_PROMPTS.synthesis, new Date().toLocaleString())],
            validation: [promptVersion(DEFAULT_PROMPTS.validation, new Date().toLocaleString())]
        };
    }
    ['extraction', 'analysis', 'synthesis', 'validation'].forEach(type => {
        if (!Array.isArray(db[user].prompts[type]) || !db[user].prompts[type].length) {
            db[user].prompts[type] = [promptVersion(DEFAULT_PROMPTS[type], new Date().toLocaleString())];
        }
    });
    // ESTABLISHED-SCORES-MIGRATION: stellt sicher, dass bestehende Profile die
    // aktuelle PEDro/MINORS/AMSTAR2/COSMIN/GRADE-Logik erhalten.
    const frameworkDate = new Date().toLocaleString();
    if (!String(db[user].prompts.extraction?.[0]?.text || '').includes('TIE-BREAKER methodological_paper vs. multiple_study_report')) {
        db[user].prompts.extraction.unshift(promptVersion(DEFAULT_PROMPTS.extraction, frameworkDate));
        db[user].sync.promptHeads.extraction = new Date().toISOString();
        db[user].prompts.extraction = db[user].prompts.extraction.slice(0, PROMPT_HISTORY_LIMIT);
    }
    if (!String(db[user].prompts.analysis?.[0]?.text || '').includes('Bestätige ausdrücklich den Tie-Breaker')) {
        db[user].prompts.analysis.unshift(promptVersion(DEFAULT_PROMPTS.analysis, frameworkDate));
        db[user].sync.promptHeads.analysis = new Date().toISOString();
        db[user].prompts.analysis = db[user].prompts.analysis.slice(0, PROMPT_HISTORY_LIMIT);
    }
    if (!String(db[user].prompts.validation?.[0]?.text || '').includes('validiere jars_quant separat')) {
        db[user].prompts.validation.unshift(promptVersion(DEFAULT_PROMPTS.validation, frameworkDate));
        db[user].sync.promptHeads.validation = new Date().toISOString();
        db[user].prompts.validation = db[user].prompts.validation.slice(0, PROMPT_HISTORY_LIMIT);
    }
    if (!String(db[user].prompts.synthesis?.[0]?.text || '').includes('grade_assessment')) {
        db[user].prompts.synthesis.unshift(promptVersion(DEFAULT_PROMPTS.synthesis, frameworkDate));
        db[user].sync.promptHeads.synthesis = new Date().toISOString();
        db[user].prompts.synthesis = db[user].prompts.synthesis.slice(0, PROMPT_HISTORY_LIMIT);
    }
    // Ältere Prompt-Versionen bekommen eine feste ID, damit Läufe auf die exakte Version verweisen können.
    Object.values(db[user].prompts).forEach(versions => (versions || []).forEach((v, i) => {
        if (!v.id) v.id = newId();
        if (!v.createdAt) v.createdAt = new Date(Date.now() - i * 1000).toISOString();
    }));
    if (!db[user].keys) {
        db[user].keys = {};
    }
    
    if (db[user].keys.activeProvider === 'custom') {
        db[user].keys.activeProvider = 'custom1';
    }
    if (db[user].keys.custom1Url === undefined) {
        db[user].keys.custom1Url = db[user].keys.customUrl || "http://localhost:8888/v1";
        db[user].keys.custom1Key = db[user].keys.customKey || "";
        db[user].keys.custom1Model = db[user].keys.customModel || "";
    }
    if (db[user].keys.custom2Url === undefined) {
        db[user].keys.custom2Url = "http://10.189.26.81:8000/v1";
        db[user].keys.custom2Key = "";
        db[user].keys.custom2Model = "";
    }
    if (db[user].keys.custom3Url === undefined) {
        db[user].keys.custom3Url = "http://localhost:11434/v1";
        db[user].keys.custom3Key = "";
        db[user].keys.custom3Model = "";
    }
    
    if (db[user].keys.custom1Thinking === undefined) db[user].keys.custom1Thinking = false;
    if (db[user].keys.custom2Thinking === undefined) db[user].keys.custom2Thinking = false;
    if (db[user].keys.custom3Thinking === undefined) db[user].keys.custom3Thinking = false;

    if (!db[user].keys.activeProvider) db[user].keys.activeProvider = 'custom1';
    if (!db[user].keys.maxEvidence) db[user].keys.maxEvidence = 50000;
    if (!db[user].keys.maxTokens) db[user].keys.maxTokens = 8192;
    if (db[user].keys.temperature === undefined) db[user].keys.temperature = 0.0;
    if (!db[user].keys.systemPrompt) db[user].keys.systemPrompt = DEFAULT_SYSTEM_PROMPT;
    
    return db;
}

function defaultKeys() {
    return { custom1Url: "http://localhost:8888/v1", custom1Key: "", custom1Model: "", custom2Url: "http://10.189.26.81:8000/v1", custom2Key: "", custom2Model: "", custom3Url: "http://localhost:11434/v1", custom3Key: "", custom3Model: "", openaiKey: "", geminiKey: "", maxEvidence: 50000, maxTokens: 8192, temperature: 0.0, systemPrompt: DEFAULT_SYSTEM_PROMPT, activeProvider: 'custom1' };
}

function showLoginError(text) {
    const errDiv = document.getElementById('login-error');
    errDiv.textContent = text;
    errDiv.style.display = 'block';
}

// Anmeldung: Ist der Spark erreichbar, wird dort angemeldet (und ein auf diesem Gerät noch fehlendes
// Profil aus den Spark-Daten aufgebaut). Ohne Spark oder ohne Netz gilt die lokale Prüfung wie bisher.
async function handleAuth(action) {
    const user = document.getElementById('login-user').value.trim();
    const pass = document.getElementById('login-pass').value.trim();
    const invite = document.getElementById('login-invite').value.trim();
    document.getElementById('login-error').style.display = 'none';

    if (!user || !pass) {
        showLoginError("Bitte User-ID und Passwort eingeben.");
        return;
    }
    document.querySelectorAll('.auth-btn').forEach(btn => { btn.disabled = true; });
    try {
        await detectServer();
        let db = getUserDB();
        const hashedPass = hashString(pass);
        let notice = '';
        let linkedNow = false;

        if (action === 'register') {
            if (db[user]) {
                showLoginError("Dieser Benutzer existiert auf diesem Gerät bereits. Bitte einloggen.");
                return;
            }
            let linked = false;
            if (invite) {
                if (serverStatus !== 'available') { showLoginError('Der Spark ist nicht erreichbar. Ohne Einladungscode wird ein rein lokales Profil angelegt.'); return; }
                const res = await api('auth/register', { method: 'POST', body: { login: user, password: pass, inviteCode: invite } });
                if (res.status !== 201) { showLoginError(res.data?.error || `Registrierung auf dem Spark fehlgeschlagen (${res.status}).`); return; }
                linked = true;
            }
            db[user] = { passHash: hashedPass, keys: defaultKeys(), history: [] };
            db = ensureProfileStructure(db, user);
            db[user].sync.linked = linked;
            if (linked) db[user].sync.settingsUpdatedAt = new Date().toISOString();
        } else {
            const local = db[user];
            const localOk = !!local && local.passHash === hashedPass;
            let serverOk = false;
            if (serverStatus === 'available') {
                const res = await api('auth/login', { method: 'POST', body: { login: user, password: pass } });
                if (res.status === 429) { showLoginError(res.data?.error || 'Zu viele Fehlversuche.'); return; }
                serverOk = res.status === 200;
            }
            if (serverOk && !local) {
                // Neues Gerät: leeres Profil, das beim ersten Abgleich mit den Spark-Daten gefüllt wird.
                db[user] = { passHash: hashedPass, keys: defaultKeys(), history: [] };
                db = ensureProfileStructure(db, user);
                db[user].sync.settingsUpdatedAt = '';
                ['extraction', 'analysis', 'synthesis', 'validation'].forEach(t => { db[user].sync.promptHeads[t] = ''; });
                notice = 'Profil vom Spark geladen. API-Keys werden nicht übertragen und müssen auf diesem Gerät einmal eingegeben werden.';
            } else if (serverOk && !localOk) {
                // Passwort wurde auf dem Spark geändert: lokale Prüfung angleichen. Lokal verschlüsselte
                // API-Keys lassen sich mit dem neuen Passwort nicht entschlüsseln und werden verworfen.
                local.passHash = hashedPass;
                SECRET_KEY_FIELDS.forEach(k => { local.keys[k] = ''; });
                db = ensureProfileStructure(db, user);
                notice = 'Das Passwort weicht vom lokal gespeicherten ab. Bitte die API-Keys neu eingeben.';
            } else if (localOk) {
                db = ensureProfileStructure(db, user);
                if (invite && !db[user].sync.linked) {
                    // Einladungscode beim Einloggen: bisher nur lokales Profil direkt mit einem neuen Spark-Konto verknüpfen.
                    if (serverStatus !== 'available') {
                        notice = 'Der Spark ist nicht erreichbar – das Profil bleibt vorerst nur lokal.';
                    } else if (pass.length < 8) {
                        notice = 'Für ein Spark-Konto braucht das Passwort mindestens 8 Zeichen. Bitte unter Konfiguration → „Mit Spark verknüpfen“ ein neues Passwort vergeben.';
                    } else {
                        const res = await api('auth/register', { method: 'POST', body: { login: user, password: pass, inviteCode: invite } });
                        if (res.status === 201) { serverOk = true; linkedNow = true; }
                        else notice = res.status === 409
                            ? 'Auf dem Spark gibt es dieses Konto schon, aber mit einem anderen Passwort. Bitte mit dem Spark-Passwort einloggen.'
                            : `Verknüpfen mit dem Spark fehlgeschlagen: ${res.data?.error || res.status}`;
                    }
                } else if (db[user].sync.linked && serverStatus === 'available' && !serverOk) {
                    notice = 'Anmeldung am Spark fehlgeschlagen – es wird nur lokal gearbeitet.';
                }
            } else {
                showLoginError("Falscher Benutzername oder Passwort.");
                return;
            }
            // Vorhandenes lokales Profil wird erstmals verknüpft (ein neu vom Spark geladenes hat noch keine eigenen Daten).
            if (serverOk && local && !db[user].sync.linked) {
                linkedNow = true;
                // Bisherige lokale Einstellungen sollen auf dem Spark ankommen.
                if (!db[user].sync.settingsUpdatedAt) db[user].sync.settingsUpdatedAt = new Date().toISOString();
            }
            if (serverOk) db[user].sync.linked = true;
        }
        saveUserDB(db);
        // Erstmals verknüpft: den gesamten lokalen Bestand zum Hochladen einreihen.
        if (linkedNow) await enqueueAllRuns(user);
        openAppForUser(user, pass);
        if (notice) alert(notice);
    } finally {
        document.querySelectorAll('.auth-btn').forEach(btn => { btn.disabled = false; });
    }
}

function applyProfileSettingsToUI(profile) {
    const keys = profile.keys;
    const pass = currentPassKey;
    document.getElementById('llm-provider').value = keys.activeProvider || 'custom1';

    document.getElementById('custom1-url').value = keys.custom1Url;
    document.getElementById('custom1-key').value = decryptKey(keys.custom1Key, pass);
    document.getElementById('custom1-model').value = keys.custom1Model;
    document.getElementById('custom1-thinking').checked = keys.custom1Thinking || false;

    document.getElementById('custom2-url').value = keys.custom2Url;
    document.getElementById('custom2-key').value = decryptKey(keys.custom2Key, pass);
    document.getElementById('custom2-model').value = keys.custom2Model;
    document.getElementById('custom2-thinking').checked = keys.custom2Thinking || false;

    document.getElementById('custom3-url').value = keys.custom3Url;
    document.getElementById('custom3-key').value = decryptKey(keys.custom3Key, pass);
    document.getElementById('custom3-model').value = keys.custom3Model;
    document.getElementById('custom3-thinking').checked = keys.custom3Thinking || false;

    document.getElementById('openai-key').value = decryptKey(keys.openaiKey, pass);
    document.getElementById('openai-model').value = keys.openaiModel || 'gpt-4o-mini';

    document.getElementById('gemini-key').value = decryptKey(keys.geminiKey, pass);
    document.getElementById('gemini-model').value = keys.geminiModel || 'gemini-2.5-flash';

    document.getElementById('max-evidence-chars').value = keys.maxEvidence || 50000;
    document.getElementById('max-output-tokens').value = keys.maxTokens || 8192;
    document.getElementById('llm-temperature').value = keys.temperature;
    document.getElementById('llm-system-prompt').value = keys.systemPrompt || DEFAULT_SYSTEM_PROMPT;

    toggleProviderSettings();
}

function openAppForUser(user, pass) {
    currentUser = user;
    currentPassKey = pass;
    document.getElementById('display-username').textContent = user;
    applyProfileSettingsToUI(getUserDB()[user]);

    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-screen').style.display = 'flex';
    document.getElementById('login-pass').value = '';
    document.getElementById('login-invite').value = '';

    loadPromptsToUI();
    if (isLinked(user)) {
        enqueueProfileState(user).then(startSyncLoop);
    } else {
        updateSyncStatus();
    }
}

// Ändert das lokale Passwort; die lokal verschlüsselten API-Keys werden mit dem neuen Passwort neu verschlüsselt.
function changeLocalPassword(newPass) {
    const db = getUserDB();
    const keys = db[currentUser].keys;
    SECRET_KEY_FIELDS.forEach(k => { keys[k] = encryptKey(decryptKey(keys[k], currentPassKey), newPass); });
    db[currentUser].passHash = hashString(newPass);
    currentPassKey = newPass;
    saveUserDB(db);
}

function logout() {
    if (isLinked()) api('auth/logout', { method: 'POST' });
    stopSyncLoop();
    currentUser = null; currentPassKey = null;
    updateSyncStatus();
    document.getElementById('custom1-key').value = '';
    document.getElementById('custom2-key').value = '';
    document.getElementById('custom3-key').value = '';
    document.getElementById('openai-key').value = '';
    document.getElementById('gemini-key').value = '';
    document.getElementById('app-screen').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('login-error').style.display = 'none';
}

function saveUserKeys() {
    if (!currentUser) return;
    let db = getUserDB();
    
    db[currentUser].keys.activeProvider = document.getElementById('llm-provider').value;
    
    db[currentUser].keys.custom1Url = document.getElementById('custom1-url').value;
    db[currentUser].keys.custom1Key = encryptKey(document.getElementById('custom1-key').value, currentPassKey);
    db[currentUser].keys.custom1Model = document.getElementById('custom1-model').value;
    db[currentUser].keys.custom1Thinking = document.getElementById('custom1-thinking').checked;

    db[currentUser].keys.custom2Url = document.getElementById('custom2-url').value;
    db[currentUser].keys.custom2Key = encryptKey(document.getElementById('custom2-key').value, currentPassKey);
    db[currentUser].keys.custom2Model = document.getElementById('custom2-model').value;
    db[currentUser].keys.custom2Thinking = document.getElementById('custom2-thinking').checked;

    db[currentUser].keys.custom3Url = document.getElementById('custom3-url').value;
    db[currentUser].keys.custom3Key = encryptKey(document.getElementById('custom3-key').value, currentPassKey);
    db[currentUser].keys.custom3Model = document.getElementById('custom3-model').value;
    db[currentUser].keys.custom3Thinking = document.getElementById('custom3-thinking').checked;
    
    db[currentUser].keys.openaiKey = encryptKey(document.getElementById('openai-key').value, currentPassKey);
    db[currentUser].keys.openaiModel = document.getElementById('openai-model').value;
    
    db[currentUser].keys.geminiKey = encryptKey(document.getElementById('gemini-key').value, currentPassKey);
    db[currentUser].keys.geminiModel = document.getElementById('gemini-model').value;
    
    db[currentUser].keys.maxEvidence = parseInt(document.getElementById('max-evidence-chars').value, 10) || 50000;
    db[currentUser].keys.maxTokens = parseInt(document.getElementById('max-output-tokens').value, 10) || 8192;
    db[currentUser].keys.temperature = parseFloat(document.getElementById('llm-temperature').value) || 0.0;
    db[currentUser].keys.systemPrompt = document.getElementById('llm-system-prompt').value;
    db[currentUser].sync.settingsUpdatedAt = new Date().toISOString();

    saveUserDB(db);
    enqueueChanges(currentUser, [['settings', 'settings']]);
    
    const provider = document.getElementById('llm-provider').value;
    const note = document.getElementById(`save-note-${provider}`);
    if (note) {
        note.style.display = 'block';
        setTimeout(() => note.style.display = 'none', 3000);
    }
}

// ==========================================
// PROMPT MANAGEMENT
// ==========================================
function loadPromptsToUI() {
    let db = getUserDB();
    let prompts = db[currentUser].prompts;

    ['extraction', 'analysis', 'synthesis', 'validation'].forEach(type => {
        let historyArr = prompts[type];
        document.getElementById(`prompt-${type}`).value = historyArr[0].text;
        
        let select = document.getElementById(`history-${type}`);
        select.innerHTML = historyArr.map((p, i) => `<option value="${i}">Version vom ${p.date}</option>`).join('');
        select.value = "0";
    });
}

function savePrompt(type) {
    let db = getUserDB();
    let newText = document.getElementById(`prompt-${type}`).value.trim();
    
    let historyArr = db[currentUser].prompts[type];
    if (historyArr[0].text !== newText) {
        historyArr.unshift(promptVersion(newText));
        if (historyArr.length > PROMPT_HISTORY_LIMIT) historyArr.pop();
        db[currentUser].sync.promptHeads[type] = historyArr[0].createdAt;
        enqueueChanges(currentUser, [['prompt_version', historyArr[0].id], ['prompt_head', type]]);
        
        db[currentUser].prompts[type] = historyArr;
        saveUserDB(db);
        loadPromptsToUI(); 
    }

    const note = document.getElementById(`save-note-${type}`);
    if(note) {
        note.style.display = 'block';
        setTimeout(() => note.style.display = 'none', 3000);
    }
}

function restorePrompt(type) {
    let db = getUserDB();
    let index = document.getElementById(`history-${type}`).value;
    document.getElementById(`prompt-${type}`).value = db[currentUser].prompts[type][index].text;
}

function getCurrentPrompt(type) {
    return document.getElementById(`prompt-${type}`).value;
}

function getCurrentPromptDate(type) {
    let db = getUserDB();
    return db[currentUser].prompts[type][0].date;
}

function getCurrentPromptVersionId(type) {
    let db = getUserDB();
    return db[currentUser].prompts[type][0].id;
}
