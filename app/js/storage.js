// ==========================================
// LOKALE SPEICHERUNG (IndexedDB)
// ==========================================
// Profile (Einstellungen, Keys, Prompt-Versionen) liegen zusätzlich in einem Speicher-Cache, damit
// der bestehende synchrone Code (getUserDB/saveUserDB) unverändert bleiben kann. Läufe und die
// einzelnen Agent-Schritte liegen in eigenen Object Stores und werden erst bei Bedarf gelesen.

const DB_NAME = 'lit-agent';
const DB_VERSION = 3;
const LEGACY_STORAGE_KEY = 'agentUsers';
const EXPORT_FORMAT = 'lit-agent-export';

let idb = null;
let userCache = {};
let storageAvailable = true;

function newId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    // crypto.randomUUID fehlt außerhalb von HTTPS/localhost (z.B. http://<LAN-IP>/lit).
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requestToPromise(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function transactionDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error);
    });
}

function openDatabase() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('users')) db.createObjectStore('users', { keyPath: 'login' });
            if (!db.objectStoreNames.contains('runs')) db.createObjectStore('runs', { keyPath: 'id' }).createIndex('user', 'user');
            if (!db.objectStoreNames.contains('run_steps')) db.createObjectStore('run_steps', { keyPath: 'id' }).createIndex('run', 'run');
            if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
            // v2: Warteschlange der noch nicht zum Spark übertragenen Änderungen
            if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'key' }).createIndex('user', 'user');
            // v3: Referenzbewertungen von Fachleuten (z.B. PEDro-Datenbank) für den Zuverlässigkeits-Abgleich
            if (!db.objectStoreNames.contains('references')) db.createObjectStore('references', { keyPath: 'id' }).createIndex('user', 'user');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB ist durch einen anderen Tab blockiert.'));
    });
}

async function initStorage() {
    try {
        idb = await openDatabase();
    } catch (err) {
        storageAvailable = false;
        console.error('IndexedDB nicht verfügbar:', err);
        return { available: false, migrated: 0 };
    }
    // Bittet den Browser, die Daten nicht bei Speicherknappheit zu löschen.
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

    const migrated = await migrateLegacyStorage();
    const users = await requestToPromise(idb.transaction('users').objectStore('users').getAll());
    userCache = {};
    users.forEach(u => { userCache[u.login] = u.profile; });
    return { available: true, migrated };
}

// Übernimmt einmalig die Daten der Einzeldatei-Version aus localStorage. Der alte Eintrag bleibt als
// Sicherung erhalten, wird aber nicht mehr beschrieben.
async function migrateLegacyStorage() {
    const done = await requestToPromise(idb.transaction('meta').objectStore('meta').get('legacyMigrated'));
    if (done) return 0;
    let legacy = {};
    try { legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || '{}'); } catch (e) { legacy = {}; }

    const tx = idb.transaction(['users', 'runs', 'meta'], 'readwrite');
    let runCount = 0;
    const base = Date.now();
    for (const [login, profile] of Object.entries(legacy)) {
        const { history, ...rest } = profile || {};
        tx.objectStore('users').put({ login, profile: rest, updatedAt: new Date().toISOString() });
        (Array.isArray(history) ? history : []).forEach((res, i) => {
            // Ältere Läufe hatten nur ein lokalisiertes Datum; die Reihenfolge bleibt über createdAt erhalten.
            tx.objectStore('runs').put(buildRunRecord(login, res, new Date(base - (i + 1) * 1000).toISOString(), { legacy: true }));
            runCount++;
        });
    }
    tx.objectStore('meta').put({ key: 'legacyMigrated', at: new Date().toISOString(), users: Object.keys(legacy).length, runs: runCount });
    await transactionDone(tx);
    return runCount;
}

function getUserDB() { return userCache; }

function saveUserDB(db) {
    userCache = db;
    if (!storageAvailable || !idb) return;
    const tx = idb.transaction('users', 'readwrite');
    const store = tx.objectStore('users');
    const now = new Date().toISOString();
    for (const [login, profile] of Object.entries(db)) {
        const { history, ...rest } = profile || {};
        store.put({ login, profile: rest, updatedAt: now });
    }
    transactionDone(tx).catch(err => {
        console.error('Profil konnte nicht gespeichert werden:', err);
        if (typeof log === 'function') log(`Speichern fehlgeschlagen: ${err?.message || err}`, 'error');
    });
}

function buildRunRecord(user, result, createdAt, extra = {}) {
    return {
        id: result.run_id || newId(),
        user,
        createdAt,
        model: result.model || null,
        provider: result.provider || null,
        documentCount: Array.isArray(result.extractions) ? result.extractions.length : 0,
        casq: result.validation?.casq_score ?? null,
        quality: result.validation?.overall_quality || null,
        result,
        ...extra
    };
}

async function saveRun(user, result, steps) {
    if (!storageAvailable || !idb) return null;
    const record = buildRunRecord(user, result, new Date().toISOString());
    record.result.run_id = record.id;
    const tx = idb.transaction(['runs', 'run_steps'], 'readwrite');
    tx.objectStore('runs').put(record);
    (steps || []).forEach(step => tx.objectStore('run_steps').put({ ...step, run: record.id }));
    await transactionDone(tx);
    await enqueueChanges(user, [['run', record.id], ['run_steps', record.id]]);
    return record.id;
}

async function listRuns(user) {
    if (!storageAvailable || !idb) return [];
    const runs = await requestToPromise(idb.transaction('runs').objectStore('runs').index('user').getAll(user));
    return runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function getRun(id) {
    if (!storageAvailable || !idb) return null;
    return requestToPromise(idb.transaction('runs').objectStore('runs').get(id));
}

async function getRunSteps(runId) {
    if (!storageAvailable || !idb) return [];
    const steps = await requestToPromise(idb.transaction('run_steps').objectStore('run_steps').index('run').getAll(runId));
    return steps.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

async function deleteRun(id) {
    const run = await getRun(id);
    await deleteRunLocal(id);
    if (run) await enqueueChanges(run.user, [['run_delete', id]]);
}

// Löscht nur lokal (auch für vom Spark gemeldete Löschungen, die nicht zurückgemeldet werden dürfen).
async function deleteRunLocal(id) {
    const tx = idb.transaction(['runs', 'run_steps'], 'readwrite');
    tx.objectStore('runs').delete(id);
    const keys = await requestToPromise(tx.objectStore('run_steps').index('run').getAllKeys(id));
    keys.forEach(k => tx.objectStore('run_steps').delete(k));
    await transactionDone(tx);
}

async function putRunRecord(record) {
    const tx = idb.transaction('runs', 'readwrite');
    tx.objectStore('runs').put(record);
    await transactionDone(tx);
}

async function replaceRunSteps(runId, steps) {
    const tx = idb.transaction('run_steps', 'readwrite');
    const store = tx.objectStore('run_steps');
    const keys = await requestToPromise(store.index('run').getAllKeys(runId));
    keys.forEach(k => store.delete(k));
    (steps || []).forEach(step => store.put({ ...step, run: runId }));
    await transactionDone(tx);
}

// ==========================================
// WARTESCHLANGE FÜR DIE SYNCHRONISATION
// ==========================================
// Einträge verweisen nur auf die geänderte Einheit; der aktuelle Inhalt wird erst beim Hochladen gelesen.
// Gleiche Einheit = gleicher Schlüssel, mehrfache Änderungen ergeben also nur einen Eintrag.
let outboxCounter = 0;

async function enqueueChanges(user, refs) {
    if (!storageAvailable || !idb || !user || !refs.length) return;
    const tx = idb.transaction('outbox', 'readwrite');
    const store = tx.objectStore('outbox');
    refs.forEach(([kind, entityId]) => {
        store.put({ key: `${user}|${kind}|${entityId}`, user, kind, entityId, order: Date.now() * 1000 + (outboxCounter++ % 1000) });
    });
    await transactionDone(tx);
    if (typeof scheduleSync === 'function') scheduleSync();
}

async function listOutbox(user) {
    if (!storageAvailable || !idb) return [];
    const entries = await requestToPromise(idb.transaction('outbox').objectStore('outbox').index('user').getAll(user));
    return entries.sort((a, b) => a.order - b.order);
}

// Entfernt erledigte Einträge, aber nur wenn sie sich während der Übertragung nicht erneut geändert haben.
async function removeOutboxEntries(entries) {
    const tx = idb.transaction('outbox', 'readwrite');
    const store = tx.objectStore('outbox');
    for (const entry of entries) {
        const current = await requestToPromise(store.get(entry.key));
        if (current && current.order === entry.order) store.delete(entry.key);
    }
    await transactionDone(tx);
}

async function getMeta(key) {
    if (!storageAvailable || !idb) return null;
    const row = await requestToPromise(idb.transaction('meta').objectStore('meta').get(key));
    return row ? row.value : null;
}

async function setMeta(key, value) {
    if (!storageAvailable || !idb) return;
    const tx = idb.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key, value });
    await transactionDone(tx);
}

async function exportUserData(user) {
    const profile = userCache[user] || {};
    const runs = await listRuns(user);
    const steps = [];
    for (const run of runs) steps.push(...await getRunSteps(run.id));
    return {
        format: EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(),
        user, prompts: profile.prompts || {}, runs, run_steps: steps,
        references: (await listReferences(user)).map(({ id, user: _u, ...rest }) => rest),
        journals: (await getMeta(`journals|${user}`))?.rows || []
    };
}

// Fügt Läufe, Schritte und fehlende Prompt-Versionen hinzu. Einstellungen und Keys werden bewusst
// nicht überschrieben; vorhandene Einträge mit gleicher ID bleiben unverändert.
async function importUserData(user, data) {
    if (!data || data.format !== EXPORT_FORMAT) throw new Error('Keine gültige Export-Datei des Publikations-Agenten.');
    const db = getUserDB();
    const prompts = db[user].prompts;
    let promptCount = 0;
    for (const [type, versions] of Object.entries(data.prompts || {})) {
        if (!Array.isArray(prompts[type])) continue;
        for (const v of versions) {
            if (prompts[type].some(p => p.id === v.id || p.text === v.text)) continue;
            prompts[type].push(v);
            promptCount++;
        }
        // Die aktive Version (Index 0) bleibt aktiv; nur die ältere Historie wird nach Datum sortiert.
        const [active, ...older] = prompts[type];
        older.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        prompts[type] = [active, ...older].slice(0, PROMPT_HISTORY_LIMIT);
    }
    saveUserDB(db);

    const tx = idb.transaction(['runs', 'run_steps'], 'readwrite');
    const existing = new Set(await requestToPromise(tx.objectStore('runs').getAllKeys()));
    let runCount = 0;
    const importedRuns = new Set();
    for (const run of data.runs || []) {
        if (!run?.id || existing.has(run.id)) continue;
        tx.objectStore('runs').put({ ...run, user });
        importedRuns.add(run.id);
        runCount++;
    }
    for (const step of data.run_steps || []) {
        if (step?.id && importedRuns.has(step.run)) tx.objectStore('run_steps').put(step);
    }
    await transactionDone(tx);
    let referenceCount = 0;
    const existingRefs = new Set((await listReferences(user)).map(r => r.key));
    for (const ref of data.references || []) {
        if (!ref?.key || existingRefs.has(ref.key)) continue;
        await putReference(user, ref);
        referenceCount++;
    }
    // Zeitschriftenliste nur übernehmen, wenn hier noch keine existiert
    if (Array.isArray(data.journals) && data.journals.length && !((await getMeta(`journals|${user}`))?.rows || []).length) {
        await setMeta(`journals|${user}`, { rows: data.journals, updatedAt: new Date().toISOString() });
    }
    await enqueueChanges(user, [...importedRuns].flatMap(id => [['run', id], ['run_steps', id]]));
    if (typeof enqueueProfileState === 'function') await enqueueProfileState(user);
    return { runs: runCount, prompts: promptCount, references: referenceCount };
}

// ==========================================
// REFERENZBEWERTUNGEN (Experten) – nur lokal, Teil von Export/Import
// ==========================================
async function listReferences(user) {
    if (!storageAvailable || !idb) return [];
    return requestToPromise(idb.transaction('references').objectStore('references').index('user').getAll(user));
}

async function putReference(user, ref) {
    if (!storageAvailable || !idb || !ref?.key) return;
    const tx = idb.transaction('references', 'readwrite');
    tx.objectStore('references').put({ ...ref, id: `${user}|${ref.key}`, user, updatedAt: new Date().toISOString() });
    await transactionDone(tx);
}

async function deleteReference(user, key) {
    if (!storageAvailable || !idb) return;
    const tx = idb.transaction('references', 'readwrite');
    tx.objectStore('references').delete(`${user}|${key}`);
    await transactionDone(tx);
}

async function storageEstimate() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    try { return await navigator.storage.estimate(); } catch (e) { return null; }
}
