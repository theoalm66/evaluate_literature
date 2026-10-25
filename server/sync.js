// Synchronisation Browser ↔ Spark.
// Läufe, Agent-Protokolle und Prompt-Versionen sind unveränderlich (nur Anlegen oder Löschen), daher
// gibt es dort keine Konflikte. Einstellungen und die aktive Prompt-Version je Agent werden nach
// "letzte Änderung gewinnt" (updatedAt) zusammengeführt.
const { transaction } = require('./db');

const AGENTS = new Set(['extraction', 'analysis', 'casq', 'validation', 'casq_validation', 'synthesis', 'integrity']);
const KINDS = new Set(['run', 'run_steps', 'run_delete', 'prompt_version', 'prompt_head', 'settings']);
const MAX_ID_LENGTH = 100;
const PULL_DEFAULT_LIMIT = 25;
const PULL_MAX_LIMIT = 200;
const PULL_MAX_BYTES = 8 * 1024 * 1024;

const isIso = v => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

function logChange(db, userId, kind, entityId, deviceId) {
    db.prepare('INSERT INTO sync_log (user_id, kind, entity_id, device_id, at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, kind, entityId, deviceId || null, new Date().toISOString());
}

function applyChange(db, userId, deviceId, change) {
    const { kind, id, data } = change || {};
    if (!KINDS.has(kind)) return { status: 'rejected', reason: 'unknown_kind' };
    if (typeof id !== 'string' || !id || id.length > MAX_ID_LENGTH) return { status: 'rejected', reason: 'invalid_id' };

    if (kind === 'run') {
        if (!data || typeof data !== 'object' || data.id !== id) return { status: 'rejected', reason: 'invalid_data' };
        const existing = db.prepare('SELECT user_id, deleted_at FROM runs WHERE id = ?').get(id);
        if (existing && existing.user_id !== userId) return { status: 'rejected', reason: 'forbidden' };
        if (existing) return { status: 'ok', note: existing.deleted_at ? 'deleted' : 'exists' };
        const { user, ...record } = data;
        db.prepare('INSERT INTO runs (id, user_id, created_at, data) VALUES (?, ?, ?, ?)')
            .run(id, userId, isIso(record.createdAt) ? record.createdAt : new Date().toISOString(), JSON.stringify(record));
        logChange(db, userId, 'run', id, deviceId);
        return { status: 'ok' };
    }

    if (kind === 'run_steps') {
        if (!Array.isArray(data)) return { status: 'rejected', reason: 'invalid_data' };
        const run = db.prepare('SELECT user_id, deleted_at FROM runs WHERE id = ?').get(id);
        if (!run) return { status: 'rejected', reason: 'unknown_run' };
        if (run.user_id !== userId) return { status: 'rejected', reason: 'forbidden' };
        if (run.deleted_at) return { status: 'ok', note: 'deleted' };
        if (db.prepare('SELECT 1 FROM run_steps WHERE run_id = ?').get(id)) return { status: 'ok', note: 'exists' };
        db.prepare('INSERT INTO run_steps (run_id, user_id, data) VALUES (?, ?, ?)').run(id, userId, JSON.stringify(data));
        logChange(db, userId, 'run_steps', id, deviceId);
        return { status: 'ok' };
    }

    if (kind === 'run_delete') {
        const run = db.prepare('SELECT user_id, deleted_at FROM runs WHERE id = ?').get(id);
        if (run && run.user_id !== userId) return { status: 'rejected', reason: 'forbidden' };
        if (run?.deleted_at) return { status: 'ok', note: 'deleted' };
        const now = new Date().toISOString();
        if (run) db.prepare('UPDATE runs SET data = NULL, deleted_at = ? WHERE id = ?').run(now, id);
        // Grabstein, damit ein später eintreffender Upload desselben Laufs ihn nicht wiederbelebt.
        else db.prepare('INSERT INTO runs (id, user_id, created_at, data, deleted_at) VALUES (?, ?, ?, NULL, ?)').run(id, userId, now, now);
        db.prepare('DELETE FROM run_steps WHERE run_id = ?').run(id);
        logChange(db, userId, 'run_delete', id, deviceId);
        return { status: 'ok' };
    }

    if (kind === 'prompt_version') {
        if (!data || !AGENTS.has(data.agent) || typeof data.text !== 'string') return { status: 'rejected', reason: 'invalid_data' };
        const existing = db.prepare('SELECT user_id FROM prompt_versions WHERE id = ?').get(id);
        if (existing && existing.user_id !== userId) return { status: 'rejected', reason: 'forbidden' };
        if (existing) return { status: 'ok', note: 'exists' };
        const record = { agent: data.agent, text: data.text, date: typeof data.date === 'string' ? data.date.slice(0, 60) : null,
            createdAt: isIso(data.createdAt) ? data.createdAt : new Date().toISOString() };
        db.prepare('INSERT INTO prompt_versions (id, user_id, agent, data, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(id, userId, record.agent, JSON.stringify(record), record.createdAt);
        logChange(db, userId, 'prompt_version', id, deviceId);
        return { status: 'ok' };
    }

    if (kind === 'prompt_head') {
        if (!AGENTS.has(id) || !data || typeof data.version_id !== 'string' || !isIso(data.updatedAt)) return { status: 'rejected', reason: 'invalid_data' };
        const version = db.prepare('SELECT user_id, agent FROM prompt_versions WHERE id = ?').get(data.version_id);
        if (!version || version.user_id !== userId || version.agent !== id) return { status: 'rejected', reason: 'unknown_version' };
        const current = db.prepare('SELECT version_id, updated_at FROM prompt_heads WHERE user_id = ? AND agent = ?').get(userId, id);
        if (current && current.updated_at >= data.updatedAt) return { status: 'ok', note: 'stale' };
        db.prepare(`INSERT INTO prompt_heads (user_id, agent, version_id, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, agent) DO UPDATE SET version_id = excluded.version_id, updated_at = excluded.updated_at`)
            .run(userId, id, data.version_id, data.updatedAt);
        logChange(db, userId, 'prompt_head', id, deviceId);
        return { status: 'ok' };
    }

    // settings
    if (id !== 'settings' || !data || typeof data.values !== 'object' || !isIso(data.updatedAt)) return { status: 'rejected', reason: 'invalid_data' };
    const current = db.prepare('SELECT updated_at FROM settings WHERE user_id = ?').get(userId);
    if (current && current.updated_at >= data.updatedAt) return { status: 'ok', note: 'stale' };
    db.prepare(`INSERT INTO settings (user_id, data, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
        .run(userId, JSON.stringify(data.values), data.updatedAt);
    logChange(db, userId, 'settings', 'settings', deviceId);
    return { status: 'ok' };
}

function pushChanges(db, userId, deviceId, changes) {
    return transaction(db, () => changes.map(change => {
        try {
            return applyChange(db, userId, deviceId, change);
        } catch (err) {
            return { status: 'rejected', reason: 'error' };
        }
    }));
}

// Liefert den aktuellen Stand jeder geänderten Einheit seit `since`. Änderungen, die das anfragende
// Gerät selbst hochgeladen hat, werden ausgelassen.
function currentState(db, userId, kind, entityId) {
    if (kind === 'run' || kind === 'run_delete') {
        const run = db.prepare('SELECT data, deleted_at FROM runs WHERE id = ? AND user_id = ?').get(entityId, userId);
        if (!run) return null;
        if (run.deleted_at) return { kind: 'run_delete', id: entityId };
        return { kind: 'run', id: entityId, data: JSON.parse(run.data) };
    }
    if (kind === 'run_steps') {
        const row = db.prepare('SELECT data FROM run_steps WHERE run_id = ? AND user_id = ?').get(entityId, userId);
        return row ? { kind, id: entityId, data: JSON.parse(row.data) } : null;
    }
    if (kind === 'prompt_version') {
        const row = db.prepare('SELECT data FROM prompt_versions WHERE id = ? AND user_id = ?').get(entityId, userId);
        return row ? { kind, id: entityId, data: JSON.parse(row.data) } : null;
    }
    if (kind === 'prompt_head') {
        const row = db.prepare('SELECT version_id, updated_at FROM prompt_heads WHERE user_id = ? AND agent = ?').get(userId, entityId);
        return row ? { kind, id: entityId, data: { version_id: row.version_id, updatedAt: row.updated_at } } : null;
    }
    if (kind === 'settings') {
        const row = db.prepare('SELECT data, updated_at FROM settings WHERE user_id = ?').get(userId);
        return row ? { kind, id: 'settings', data: { values: JSON.parse(row.data), updatedAt: row.updated_at } } : null;
    }
    return null;
}

function pullChanges(db, userId, { since = 0, deviceId = null, limit = PULL_DEFAULT_LIMIT, maxBytes = PULL_MAX_BYTES } = {}) {
    const cappedLimit = Math.max(1, Math.min(PULL_MAX_LIMIT, Number(limit) || PULL_DEFAULT_LIMIT));
    const rows = db.prepare(`
        SELECT kind, entity_id, MAX(seq) AS seq FROM sync_log
        WHERE user_id = ? AND seq > ? AND (device_id IS NULL OR device_id != ?)
        GROUP BY kind, entity_id ORDER BY seq LIMIT ?`).all(userId, Number(since) || 0, deviceId || '', cappedLimit + 1);
    const latest = db.prepare('SELECT MAX(seq) AS seq FROM sync_log WHERE user_id = ?').get(userId).seq || 0;

    const changes = [];
    let bytes = 0, cursor = Number(since) || 0, truncated = rows.length > cappedLimit;
    for (const row of rows.slice(0, cappedLimit)) {
        const state = currentState(db, userId, row.kind, row.entity_id);
        const size = state ? JSON.stringify(state).length : 0;
        if (changes.length && bytes + size > maxBytes) { truncated = true; break; }
        if (state) { changes.push(state); bytes += size; }
        cursor = row.seq;
    }
    // Sind alle Zeilen geliefert, springt der Cursor über die eigenen (ausgelassenen) Änderungen hinweg.
    if (!truncated) cursor = Math.max(cursor, latest);
    return { changes, cursor, has_more: truncated };
}

module.exports = { pushChanges, pullChanges, AGENTS };
