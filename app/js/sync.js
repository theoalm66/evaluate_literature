// ==========================================
// SYNCHRONISATION MIT DEM SPARK
// ==========================================
// Der Browser bleibt die Arbeitskopie (offline nutzbar). Ist das Profil mit einem Konto auf dem Spark
// verknüpft, werden lokale Änderungen aus der Warteschlange hochgeladen und Änderungen anderer Geräte
// abgeholt. Ohne Backend (reine Dateiauslieferung) oder ohne Netz läuft alles lokal weiter.

const SYNC_INTERVAL_MS = 60 * 1000;
const PUSH_BATCH_BYTES = 8 * 1024 * 1024;
const PUSH_BATCH_COUNT = 200;
const SECRET_KEY_FIELDS = ['custom1Key', 'custom2Key', 'custom3Key', 'openaiKey', 'geminiKey'];

let serverStatus = 'unknown';   // unknown | available | absent | unreachable
let syncTimer = null;
let syncDebounce = null;
let syncRunning = false;
let syncAgain = false;
let syncState = { phase: 'idle', lastSync: null, pending: 0, error: null };

async function api(pathname, { method = 'GET', body } = {}) {
    try {
        const res = await fetch(`api/${pathname}`, {
            method,
            credentials: 'same-origin',
            headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Lit-Request': '1' },
            body: method === 'GET' ? undefined : JSON.stringify(body || {})
        });
        let data = null;
        try { data = await res.json(); } catch (e) { data = null; }
        return { status: res.status, data };
    } catch (err) {
        return { status: 0, data: null, error: err };
    }
}

async function detectServer() {
    if (!navigator.onLine) { serverStatus = 'unreachable'; return serverStatus; }
    const res = await api('health');
    if (res.status === 200 && res.data?.ok) serverStatus = 'available';
    else if (res.status === 0) serverStatus = 'unreachable';
    else serverStatus = 'absent';  // z.B. 404: App wird ohne Backend ausgeliefert
    return serverStatus;
}

function isLinked(user = currentUser) {
    return !!(user && getUserDB()[user]?.sync?.linked);
}

function syncSettingsOf(profile) {
    const values = { ...(profile.keys || {}) };
    SECRET_KEY_FIELDS.forEach(k => delete values[k]);
    return values;
}

function promptHeadUpdatedAt(profile, agent) {
    const explicit = profile.sync?.promptHeads?.[agent];
    if (explicit !== undefined) return explicit;
    return profile.prompts?.[agent]?.[0]?.createdAt || '';
}

// Stellt aktuelle Prompt-Versionen, aktive Versionen und Einstellungen in die Warteschlange. Der Server
// ignoriert bereits bekannte Versionen und ältere Stände, deshalb ist mehrfaches Einreihen unschädlich.
async function enqueueProfileState(user) {
    const profile = getUserDB()[user];
    if (!profile) return;
    const refs = [];
    Object.entries(profile.prompts || {}).forEach(([agent, versions]) => {
        [...(versions || [])].reverse().forEach(v => refs.push(['prompt_version', v.id]));
        refs.push(['prompt_head', agent]);
    });
    refs.push(['settings', 'settings']);
    await enqueueChanges(user, refs);
}

async function enqueueAllRuns(user) {
    const runs = await listRuns(user);
    await enqueueChanges(user, runs.reverse().flatMap(r => [['run', r.id], ['run_steps', r.id]]));
}

async function getDeviceId() {
    let id = await getMeta('deviceId');
    if (!id) { id = newId(); await setMeta('deviceId', id); }
    return id;
}

function findPromptVersion(profile, id) {
    for (const [agent, versions] of Object.entries(profile.prompts || {})) {
        const v = (versions || []).find(x => x.id === id);
        if (v) return { agent, version: v };
    }
    return null;
}

async function buildChange(user, entry) {
    const profile = getUserDB()[user];
    if (entry.kind === 'run') {
        const run = await getRun(entry.entityId);
        if (!run) return null;
        const { user: _u, ...data } = run;
        return { kind: 'run', id: run.id, data };
    }
    if (entry.kind === 'run_steps') {
        const run = await getRun(entry.entityId);
        if (!run || run.legacy) return null;
        const steps = await getRunSteps(entry.entityId);
        if (!steps.length) return null;
        return { kind: 'run_steps', id: entry.entityId, data: steps.map(({ run: _r, ...s }) => s) };
    }
    if (entry.kind === 'run_delete') return { kind: 'run_delete', id: entry.entityId };
    if (entry.kind === 'prompt_version') {
        const found = findPromptVersion(profile, entry.entityId);
        if (!found) return null;
        const { id, ...rest } = found.version;
        return { kind: 'prompt_version', id, data: { agent: found.agent, ...rest } };
    }
    if (entry.kind === 'prompt_head') {
        const head = profile.prompts?.[entry.entityId]?.[0];
        if (!head) return null;
        const updatedAt = promptHeadUpdatedAt(profile, entry.entityId);
        if (!updatedAt) return null;   // nur Standardwert eines neuen Geräts – Spark-Stand hat Vorrang
        return { kind: 'prompt_head', id: entry.entityId, data: { version_id: head.id, updatedAt } };
    }
    if (entry.kind === 'settings') {
        const updatedAt = profile.sync?.settingsUpdatedAt;
        if (!updatedAt) return null;
        return { kind: 'settings', id: 'settings', data: { values: syncSettingsOf(profile), updatedAt } };
    }
    return null;
}

async function pushOutbox(user, deviceId) {
    const entries = await listOutbox(user);
    let index = 0;
    while (index < entries.length) {
        const batch = [], batchEntries = [], skipped = [];
        let bytes = 0;
        while (index < entries.length && batch.length < PUSH_BATCH_COUNT) {
            const entry = entries[index];
            const change = await buildChange(user, entry);
            if (!change) { skipped.push(entry); index++; continue; }
            const size = JSON.stringify(change).length;
            if (batch.length && bytes + size > PUSH_BATCH_BYTES) break;
            batch.push(change); batchEntries.push(entry); bytes += size; index++;
        }
        if (skipped.length) await removeOutboxEntries(skipped);
        if (!batch.length) continue;
        const res = await api('sync/push', { method: 'POST', body: { device: deviceId, changes: batch } });
        if (res.status !== 200) throw Object.assign(new Error(res.data?.error || `Upload fehlgeschlagen (${res.status || 'keine Verbindung'})`), { status: res.status });
        const rejected = res.data.results.filter(r => r.status === 'rejected');
        if (rejected.length) console.warn('Vom Spark abgelehnte Änderungen:', rejected, batch);
        // Abgelehnte Änderungen würden bei jedem Versuch wieder abgelehnt; sie werden verworfen und protokolliert.
        await removeOutboxEntries(batchEntries);
    }
}

async function applyPulledChange(user, change, ctx) {
    const db = ctx.db;
    const profile = db[user];
    if (change.kind === 'run') {
        await putRunRecord({ ...change.data, user });
        ctx.runsChanged = true;
    } else if (change.kind === 'run_steps') {
        await replaceRunSteps(change.id, change.data);
    } else if (change.kind === 'run_delete') {
        await deleteRunLocal(change.id);
        ctx.runsChanged = true;
    } else if (change.kind === 'prompt_version') {
        const { agent, ...rest } = change.data;
        const versions = profile.prompts[agent];
        if (!versions || versions.some(v => v.id === change.id)) return;
        const [active, ...older] = versions;
        older.push({ id: change.id, ...rest });
        older.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        profile.prompts[agent] = [active, ...older].slice(0, PROMPT_HISTORY_LIMIT);
        ctx.promptsChanged = true;
    } else if (change.kind === 'prompt_head') {
        const agent = change.id;
        const versions = profile.prompts[agent];
        if (!versions || change.data.updatedAt <= promptHeadUpdatedAt(profile, agent)) return;
        const i = versions.findIndex(v => v.id === change.data.version_id);
        if (i < 0) return;
        ctx.previousHeads[agent] = ctx.previousHeads[agent] ?? versions[0].text;
        const [head] = versions.splice(i, 1);
        versions.unshift(head);
        profile.sync.promptHeads[agent] = change.data.updatedAt;
        ctx.promptsChanged = true;
    } else if (change.kind === 'settings') {
        if (change.data.updatedAt <= (profile.sync.settingsUpdatedAt || '')) return;
        const secrets = {};
        SECRET_KEY_FIELDS.forEach(k => { secrets[k] = profile.keys[k]; });
        profile.keys = { ...profile.keys, ...change.data.values, ...secrets };
        profile.sync.settingsUpdatedAt = change.data.updatedAt;
        ctx.settingsChanged = true;
    }
}

async function pullChanges(user, deviceId) {
    const cursorKey = `syncCursor:${user}`;
    let cursor = (await getMeta(cursorKey)) || 0;
    const ctx = { db: getUserDB(), previousHeads: {}, runsChanged: false, promptsChanged: false, settingsChanged: false };
    for (;;) {
        const res = await api(`sync/pull?since=${cursor}&device=${encodeURIComponent(deviceId)}&limit=25`);
        if (res.status !== 200) throw Object.assign(new Error(res.data?.error || `Abruf fehlgeschlagen (${res.status || 'keine Verbindung'})`), { status: res.status });
        for (const change of res.data.changes) await applyPulledChange(user, change, ctx);
        cursor = res.data.cursor;
        await setMeta(cursorKey, cursor);
        if (!res.data.has_more) break;
    }
    if (ctx.promptsChanged || ctx.settingsChanged) saveUserDB(ctx.db);
    if (user === currentUser) {
        if (ctx.settingsChanged) applyProfileSettingsToUI(ctx.db[user]);
        if (ctx.promptsChanged) refreshPromptsAfterSync(ctx.previousHeads);
        if (ctx.runsChanged && document.getElementById('tab-history')?.classList.contains('active')) loadHistory();
    }
}

// Aktualisiert die Prompt-Felder nur, wenn dort keine ungespeicherten Änderungen stehen.
function refreshPromptsAfterSync(previousHeads) {
    const prompts = getUserDB()[currentUser].prompts;
    ['extraction', 'analysis', 'synthesis', 'validation'].forEach(type => {
        const field = document.getElementById(`prompt-${type}`);
        const select = document.getElementById(`history-${type}`);
        const unchanged = previousHeads[type] === undefined || field.value.trim() === String(previousHeads[type]).trim();
        if (unchanged) field.value = prompts[type][0].text;
        select.innerHTML = prompts[type].map((p, i) => `<option value="${i}">Version vom ${escapeHTML(p.date)}</option>`).join('');
        select.value = '0';
    });
}

async function syncNow() {
    const user = currentUser;
    if (!user || !isLinked(user)) { updateSyncStatus(); return; }
    if (syncRunning) { syncAgain = true; return; }
    syncRunning = true;
    syncState.phase = 'running';
    updateSyncStatus();
    try {
        if (serverStatus !== 'available') await detectServer();
        if (serverStatus !== 'available') throw Object.assign(new Error('Spark nicht erreichbar'), { status: 0 });
        const deviceId = await getDeviceId();
        const exchange = async () => {
            await pushOutbox(user, deviceId);
            await pullChanges(user, deviceId);
        };
        try {
            await exchange();
        } catch (err) {
            // Abgelaufene Sitzung: einmal still neu anmelden (das Passwort ist für die Schlüssel ohnehin im Speicher).
            if (err.status !== 401) throw err;
            if (!(await serverLogin(user, currentPassKey))) {
                throw new Error('Anmeldung am Spark fehlgeschlagen – wurde das Passwort dort geändert? Bitte ab- und mit dem Spark-Passwort neu anmelden.');
            }
            await exchange();
        }
        syncState = { ...syncState, phase: 'idle', lastSync: new Date(), error: null };
    } catch (err) {
        if (err.status === 0) serverStatus = 'unreachable';
        syncState = { ...syncState, phase: 'idle', error: err.status === 0 ? 'offline' : (err.message || String(err)) };
        if (err.status !== 0) console.error('Synchronisation fehlgeschlagen:', err);
    } finally {
        syncRunning = false;
        syncState.pending = (await listOutbox(user)).length;
        updateSyncStatus();
        if (syncAgain) { syncAgain = false; scheduleSync(); }
    }
}

function scheduleSync(delayMs = 1500) {
    if (!currentUser || !isLinked()) { updateSyncStatus(); return; }
    clearTimeout(syncDebounce);
    syncDebounce = setTimeout(syncNow, delayMs);
}

function startSyncLoop() {
    stopSyncLoop();
    syncTimer = setInterval(() => { if (navigator.onLine) syncNow(); }, SYNC_INTERVAL_MS);
    syncNow();
}

function stopSyncLoop() {
    clearInterval(syncTimer);
    clearTimeout(syncDebounce);
    syncTimer = null;
    syncState = { phase: 'idle', lastSync: null, pending: 0, error: null };
}

async function serverLogin(user, password) {
    const res = await api('auth/login', { method: 'POST', body: { login: user, password } });
    if (res.status === 200) serverStatus = 'available';
    return res.status === 200;
}

function updateSyncStatus() {
    const badge = document.getElementById('sync-status');
    const detail = document.getElementById('sync-detail');
    const linkBox = document.getElementById('sync-link');
    if (!badge) return;
    const linked = isLinked();
    let text, cls;
    if (!currentUser) { text = ''; cls = ''; }
    else if (!linked) { text = 'nur lokal'; cls = 'local'; }
    else if (syncState.phase === 'running') { text = '⟳ synchronisiert…'; cls = 'running'; }
    else if (syncState.error === 'offline') { text = `☁ offline${syncState.pending ? ` · ${syncState.pending} ausstehend` : ''}`; cls = 'offline'; }
    else if (syncState.error) { text = '⚠ Sync-Fehler'; cls = 'error'; }
    else if (syncState.pending) { text = `☁ ${syncState.pending} ausstehend`; cls = 'pending'; }
    else { text = '☁ synchron'; cls = 'ok'; }
    badge.textContent = text;
    badge.className = `sync-status ${cls}`;
    badge.title = syncState.error && syncState.error !== 'offline' ? syncState.error : '';

    if (detail) {
        if (!linked) {
            detail.innerHTML = serverStatus === 'absent'
                ? 'Diese Installation hat kein Spark-Backend. Alle Daten bleiben in diesem Browser.'
                : 'Dieses Profil ist nur in diesem Browser gespeichert. Verknüpfe es mit einem Konto auf dem Spark, um Einstellungen, Prompts und Historie auf allen Geräten zu haben.';
        } else {
            const last = syncState.lastSync ? syncState.lastSync.toLocaleString() : 'noch nicht in dieser Sitzung';
            detail.innerHTML = `Verknüpft mit dem Spark-Konto <strong>${escapeHTML(currentUser)}</strong>. Letzte Synchronisation: ${escapeHTML(last)}.`
                + (syncState.pending ? ` ${syncState.pending} Änderung(en) warten auf Übertragung.` : '')
                + (syncState.error && syncState.error !== 'offline' ? `<br><span style="color:var(--danger);">${escapeHTML(syncState.error)}</span>` : '')
                + '<br><span style="font-size:.8rem;">API-Keys werden nie übertragen und bleiben auf diesem Gerät.</span>';
        }
    }
    if (linkBox) linkBox.style.display = linked || serverStatus === 'absent' ? 'none' : 'block';
    const syncButton = document.getElementById('btn-sync-now');
    if (syncButton) syncButton.style.display = linked ? 'inline-block' : 'none';
}

// Verknüpft ein bisher nur lokales Profil mit einem Spark-Konto: neues Konto per Einladungscode oder
// Anmeldung an einem bereits vorhandenen Konto. Danach wird der gesamte lokale Bestand hochgeladen.
async function linkAccount() {
    const invite = document.getElementById('link-invite').value.trim();
    const newPass = document.getElementById('link-password').value;
    const msg = document.getElementById('link-message');
    const password = newPass || currentPassKey;
    msg.style.color = 'var(--danger)';
    if (password.length < 8) {
        msg.textContent = 'Für den Spark sind mindestens 8 Zeichen nötig. Bitte ein neues Passwort eingeben – es gilt dann auch hier.';
        return;
    }
    await detectServer();
    if (serverStatus !== 'available') { msg.textContent = 'Spark ist nicht erreichbar.'; return; }
    let ok = false;
    if (invite) {
        const res = await api('auth/register', { method: 'POST', body: { login: currentUser, password, inviteCode: invite } });
        if (res.status === 201) ok = true;
        else if (res.status !== 409) { msg.textContent = res.data?.error || `Fehler ${res.status}`; return; }
    }
    if (!ok) ok = await serverLogin(currentUser, password);
    if (!ok) {
        msg.textContent = invite ? 'Das Konto gibt es schon, aber das Passwort passt nicht.' : 'Anmeldung fehlgeschlagen. Für ein neues Konto bitte den Einladungscode eingeben.';
        return;
    }
    if (newPass && newPass !== currentPassKey) changeLocalPassword(newPass);
    const db = getUserDB();
    db[currentUser].sync.linked = true;
    // Die bisherigen lokalen Einstellungen sollen auf dem Spark ankommen.
    if (!db[currentUser].sync.settingsUpdatedAt) db[currentUser].sync.settingsUpdatedAt = new Date().toISOString();
    saveUserDB(db);
    await enqueueProfileState(currentUser);
    await enqueueAllRuns(currentUser);
    msg.style.color = 'var(--success)';
    msg.textContent = 'Verknüpft. Die vorhandenen Daten werden jetzt übertragen.';
    document.getElementById('link-invite').value = '';
    document.getElementById('link-password').value = '';
    startSyncLoop();
}
