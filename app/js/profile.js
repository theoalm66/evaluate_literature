// ==========================================
// AUTHENTICATION & MULTI-USER SYSTEM
// ==========================================
let currentUser = null;
let currentPassKey = null;

// Abgeleiteter AES-Schlüssel der angemeldeten Sitzung (nur im Arbeitsspeicher), null ohne WebCrypto
let currentSession = null;

// Neue Zugangsdaten für ein lokales Profil: PBKDF2-Prüfwert (profile.auth) oder, ohne WebCrypto, der alte Hash.
async function newProfileAuth(pass) {
    if (cryptoAvailable()) return { auth: (await createAuth(pass)).auth };
    return { passHash: legacyHash(pass) };
}

async function localPasswordOk(profile, pass) {
    if (!profile) return false;
    if (profile.auth) return (await checkAuth(pass, profile.auth)).ok;
    return profile.passHash === legacyHash(pass);
}

// Nach erfolgreicher Anmeldung: AES-Schlüssel bereitstellen. Ältere Profile (djb2-Hash) bekommen dabei ihren
// PBKDF2-Prüfwert; der alte Hash wird entfernt.
async function unlockProfile(user, pass) {
    currentSession = null;
    if (!cryptoAvailable()) return;
    const db = getUserDB();
    const profile = db[user];
    if (profile.auth) {
        const checked = await checkAuth(pass, profile.auth);
        if (checked.ok) { currentSession = checked.session; return; }
    }
    const { auth, session } = await createAuth(pass);
    profile.auth = auth;
    delete profile.passHash;
    currentSession = session;
    saveUserDB(db);
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
    PROMPT_TYPES.forEach(type => {
        if (!Array.isArray(db[user].prompts[type]) || !db[user].prompts[type].length) {
            db[user].prompts[type] = [promptVersion(DEFAULT_PROMPTS[type], new Date().toLocaleString())];
        }
    });
    // ESTABLISHED-SCORES-MIGRATION: stellt sicher, dass bestehende Profile die
    // aktuelle PEDro/MINORS/AMSTAR2/COSMIN/GRADE-Logik erhalten.
    const frameworkDate = new Date().toLocaleString();
    if (!String(db[user].prompts.extraction?.[0]?.text || '').includes('TIE-BREAKER methodological_paper vs. multiple_study_report')
        || !String(db[user].prompts.extraction?.[0]?.text || '').includes('method_class')) {
        db[user].prompts.extraction.unshift(promptVersion(DEFAULT_PROMPTS.extraction, frameworkDate));
        db[user].sync.promptHeads.extraction = new Date().toISOString();
        db[user].prompts.extraction = db[user].prompts.extraction.slice(0, PROMPT_HISTORY_LIMIT);
    }
    // CASQ-Prüffragen laufen in eigenen Aufrufen (Agent 3b/4b) – ältere Agent-3/4-Prompts enthalten sie noch.
    if (!String(db[user].prompts.analysis?.[0]?.text || '').includes('Bestätige ausdrücklich den Tie-Breaker')
        || !String(db[user].prompts.analysis?.[0]?.text || '').includes('eigenen Aufruf (Agent 3b)')
        || !String(db[user].prompts.analysis?.[0]?.text || '').includes('Gesundheitsbezug laut Extraktion')) {
        db[user].prompts.analysis.unshift(promptVersion(DEFAULT_PROMPTS.analysis, frameworkDate));
        db[user].sync.promptHeads.analysis = new Date().toISOString();
        db[user].prompts.analysis = db[user].prompts.analysis.slice(0, PROMPT_HISTORY_LIMIT);
    }
    if (!String(db[user].prompts.validation?.[0]?.text || '').includes('validiere jars_quant separat')
        || !String(db[user].prompts.validation?.[0]?.text || '').includes('eigenen Aufruf (Agent 4b)')) {
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
    
    // Hochschul-API und Eigener Endpunkt (später ergänzt): leere Voreinstellungen für ältere Profile
    MODEL_PROVIDERS.forEach(id => {
        const k = db[user].keys;
        if (k[`${id}Url`] === undefined) k[`${id}Url`] = '';
        if (k[`${id}Key`] === undefined) k[`${id}Key`] = '';
        if (k[`${id}Model`] === undefined) k[`${id}Model`] = '';
        if (!Array.isArray(k[`${id}Models`])) k[`${id}Models`] = [];
    });
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
    return { hochschuleUrl: "", hochschuleKey: "", hochschuleModel: "", hochschuleModels: [], endpointUrl: "", endpointKey: "", endpointModel: "", endpointModels: [], custom1Url: "http://localhost:8888/v1", custom1Key: "", custom1Model: "", custom2Url: "http://10.189.26.81:8000/v1", custom2Key: "", custom2Model: "", custom3Url: "http://localhost:11434/v1", custom3Key: "", custom3Model: "", openaiKey: "", geminiKey: "", maxEvidence: 50000, maxTokens: 8192, temperature: 0.0, systemPrompt: DEFAULT_SYSTEM_PROMPT, activeProvider: 'custom1' };
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
            db[user] = { ...(await newProfileAuth(pass)), keys: defaultKeys(), history: [] };
            db = ensureProfileStructure(db, user);
            db[user].sync.linked = linked;
            if (linked) db[user].sync.settingsUpdatedAt = new Date().toISOString();
        } else {
            const local = db[user];
            if (local?.auth && !cryptoAvailable()) {
                showLoginError('Dieses Profil ist mit moderner Verschlüsselung geschützt und lässt sich nur über eine sichere Verbindung (https) öffnen – bitte die https-Adresse verwenden.');
                return;
            }
            const localOk = await localPasswordOk(local, pass);
            let serverOk = false;
            if (serverStatus === 'available') {
                const res = await api('auth/login', { method: 'POST', body: { login: user, password: pass } });
                if (res.status === 429) { showLoginError(res.data?.error || 'Zu viele Fehlversuche.'); return; }
                serverOk = res.status === 200;
            }
            if (serverOk && !local) {
                // Neues Gerät: leeres Profil, das beim ersten Abgleich mit den Spark-Daten gefüllt wird.
                db[user] = { ...(await newProfileAuth(pass)), keys: defaultKeys(), history: [] };
                db = ensureProfileStructure(db, user);
                db[user].sync.settingsUpdatedAt = '';
                PROMPT_TYPES.forEach(t => { db[user].sync.promptHeads[t] = ''; });
                notice = 'Profil vom Spark geladen. API-Keys werden nicht übertragen und müssen auf diesem Gerät einmal eingegeben werden.';
            } else if (serverOk && !localOk) {
                // Passwort wurde auf dem Spark geändert: lokale Prüfung angleichen. Lokal verschlüsselte
                // API-Keys lassen sich mit dem neuen Passwort nicht entschlüsseln und werden verworfen.
                delete local.auth;
                delete local.passHash;
                Object.assign(local, await newProfileAuth(pass));
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
        await openAppForUser(user, pass);
        if (notice) alert(notice);
    } finally {
        document.querySelectorAll('.auth-btn').forEach(btn => { btn.disabled = false; });
    }
}

// Füllt die Einstellungsfelder aus dem Profil und entschlüsselt dabei die API-Keys.
// Liefert true, wenn noch Keys im alten Format vorliegen, die auf AES umgestellt werden sollen.
async function applyProfileSettingsToUI(profile) {
    const keys = profile.keys;
    const el = id => document.getElementById(id);
    el('llm-provider').value = keys.activeProvider || 'custom1';

    let needsMigration = false;
    for (const { field, el: elId } of SECRET_FIELDS) {
        const stored = keys[field] || '';
        if (stored && !isAesSecret(stored) && currentSession) needsMigration = true;
        el(elId).value = await decryptSecret(stored, currentSession, currentPassKey, field);
    }

    for (const id of URL_PROVIDERS) {
        el(`${id}-url`).value = keys[`${id}Url`] || '';
        el(`${id}-thinking`).checked = keys[`${id}Thinking`] || false;
        if (MODEL_PROVIDERS.includes(id)) renderModelSelect(id, keys[`${id}Models`] || [], keys[`${id}Model`] || '');
        else el(`${id}-model`).value = keys[`${id}Model`] || '';
    }

    el('openai-model').value = keys.openaiModel || 'gpt-4o-mini';
    el('gemini-model').value = keys.geminiModel || 'gemini-2.5-flash';

    el('spark-model').value = keys.sparkModel || '';
    el('opt-integrity-computed').checked = keys.integrityComputed !== false;
    el('opt-integrity-online').checked = keys.integrityOnline !== false;
    el('opt-integrity-llm').checked = keys.integrityLLM !== false;
    el('opt-vision').checked = keys.visionEnabled !== false;
    el('opt-compact').checked = keys.compactAnswers === true;
    el('opt-no-reasoning').checked = keys.disableReasoning === true;
    el('opt-medical-instruments').checked = keys.allowMedicalInstruments === true;
    el('opt-repeat-runs').value = String(keys.repeatRuns || 1);
    el('opt-repeat-temperature').value = keys.repeatTemperature ?? 0.4;
    updateVisionHint();
    el('spark-thinking').checked = keys.sparkThinking || false;

    el('max-evidence-chars').value = keys.maxEvidence || 50000;
    el('max-output-tokens').value = keys.maxTokens || 8192;
    el('llm-temperature').value = keys.temperature;
    el('llm-system-prompt').value = keys.systemPrompt || DEFAULT_SYSTEM_PROMPT;

    toggleProviderSettings();
    updateProviderActiveHints();
    updateEncryptionNote();
    return needsMigration;
}

// Hinweis in den Einstellungen, wie die API-Keys gespeichert werden
function updateEncryptionNote() {
    const note = document.getElementById('encryption-note');
    if (!note) return;
    if (currentSession) {
        note.textContent = '🔒 API-Keys werden in diesem Browser mit AES-256 verschlüsselt gespeichert (Schlüssel aus Ihrem Passwort) und nie an den Spark übertragen.';
        note.className = 'encryption-note ok';
    } else {
        note.textContent = '⚠ Keine sichere Verbindung (https): API-Keys werden nur schwach verschleiert gespeichert. Bitte die App über die https-Adresse öffnen.';
        note.className = 'encryption-note warn';
    }
}

async function openAppForUser(user, pass) {
    currentUser = user;
    currentPassKey = pass;
    await unlockProfile(user, pass);
    document.getElementById('display-username').textContent = user;
    const needsMigration = await applyProfileSettingsToUI(getUserDB()[user]);

    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-screen').style.display = 'flex';
    document.getElementById('login-pass').value = '';
    document.getElementById('login-invite').value = '';

    loadPromptsToUI();
    startLlmStatusMonitor();
    // Keys im alten XOR-Format einmalig auf AES umstellen
    if (needsMigration) queueKeyPersist(persistSecretsOnly);
    if (isLinked(user)) {
        enqueueProfileState(user).then(startSyncLoop);
    } else {
        updateSyncStatus();
    }
}

// Ändert das lokale Passwort: neues Salz, neuer Schlüssel; die API-Keys (stehen im Klartext in den Eingabefeldern)
// werden damit neu verschlüsselt.
async function changeLocalPassword(newPass) {
    const user = currentUser;
    const db = getUserDB();
    const profile = db[user];
    delete profile.auth;
    delete profile.passHash;
    if (cryptoAvailable()) {
        const { auth, session } = await createAuth(newPass);
        profile.auth = auth;
        currentSession = session;
    } else {
        profile.passHash = legacyHash(newPass);
    }
    currentPassKey = newPass;
    saveUserDB(db);
    await persistSecretsOnly();
}

function logout() {
    if (isLinked()) api('auth/logout', { method: 'POST' });
    stopSyncLoop();
    stopLlmStatusMonitor();
    currentUser = null; currentPassKey = null; currentSession = null;
    updateSyncStatus();
    SECRET_FIELDS.forEach(f => { document.getElementById(f.el).value = ''; });
    document.getElementById('app-screen').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('login-error').style.display = 'none';
}

// Speichern läuft hintereinander (Warteschlange), damit schnelle Änderungen sich nicht überholen.
let saveKeysChain = Promise.resolve();

function queueKeyPersist(task) {
    saveKeysChain = saveKeysChain.then(task).catch(err => console.error('Einstellungen konnten nicht gespeichert werden:', err));
    return saveKeysChain;
}

function saveUserKeys() {
    return queueKeyPersist(persistUserKeys);
}

// Verschlüsselt die API-Keys aus den Eingabefeldern (AES, ohne WebCrypto das alte Verfahren).
async function encryptSecretsFromUI() {
    const out = {};
    for (const { field, el } of SECRET_FIELDS) {
        const value = document.getElementById(el).value;
        out[field] = currentSession ? await encryptSecret(value, currentSession, field) : legacyEncrypt(value, currentPassKey);
    }
    return out;
}

async function persistSecretsOnly() {
    const user = currentUser;
    if (!user) return;
    const secrets = await encryptSecretsFromUI();
    if (currentUser !== user) return;
    const db = getUserDB();
    Object.assign(db[user].keys, secrets);
    saveUserDB(db);
}

async function persistUserKeys() {
    const user = currentUser;
    if (!user) return;
    const secrets = await encryptSecretsFromUI();
    if (currentUser !== user) return;   // zwischenzeitlich abgemeldet
    const db = getUserDB();
    const keys = db[user].keys;
    const el = id => document.getElementById(id);

    keys.activeProvider = el('llm-provider').value;
    Object.assign(keys, secrets);

    for (const id of URL_PROVIDERS) {
        keys[`${id}Url`] = el(`${id}-url`).value.trim();
        keys[`${id}Model`] = el(`${id}-model`).value;
        keys[`${id}Thinking`] = el(`${id}-thinking`).checked;
    }
    keys.openaiModel = el('openai-model').value;
    keys.geminiModel = el('gemini-model').value;

    keys.sparkModel = el('spark-model').value.trim();
    keys.sparkThinking = el('spark-thinking').checked;
    keys.integrityComputed = el('opt-integrity-computed').checked;
    keys.integrityOnline = el('opt-integrity-online').checked;
    keys.integrityLLM = el('opt-integrity-llm').checked;
    keys.visionEnabled = el('opt-vision').checked;
    keys.compactAnswers = el('opt-compact').checked;
    keys.disableReasoning = el('opt-no-reasoning').checked;
    keys.allowMedicalInstruments = el('opt-medical-instruments').checked;
    keys.repeatRuns = parseInt(el('opt-repeat-runs').value, 10) || 1;
    keys.repeatTemperature = Number.isFinite(parseFloat(el('opt-repeat-temperature').value)) ? parseFloat(el('opt-repeat-temperature').value) : 0.4;

    keys.maxEvidence = parseInt(el('max-evidence-chars').value, 10) || 50000;
    keys.maxTokens = parseInt(el('max-output-tokens').value, 10) || 8192;
    keys.temperature = parseFloat(el('llm-temperature').value) || 0.0;
    keys.systemPrompt = el('llm-system-prompt').value;
    db[user].sync.settingsUpdatedAt = new Date().toISOString();

    saveUserDB(db);
    enqueueChanges(user, [['settings', 'settings']]);
    scheduleLlmStatusCheck();
    updateVisionHint();
    updateProviderActiveHints();

    const provider = el('llm-provider').value;
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

    PROMPT_TYPES.forEach(type => {
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
