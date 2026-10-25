// SQLite-Datenhaltung auf dem Spark (node:sqlite, keine nativen Abhängigkeiten).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 1;

function openDatabase(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    migrate(db);
    return db;
}

function migrate(db) {
    const { user_version: version } = db.prepare('PRAGMA user_version').get();
    if (version >= SCHEMA_VERSION) return;
    db.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            login TEXT NOT NULL UNIQUE,
            pass_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            data TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS prompt_versions (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            agent TEXT NOT NULL,
            data TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS prompt_heads (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            agent TEXT NOT NULL,
            version_id TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (user_id, agent)
        );
        CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TEXT,
            data TEXT,
            deleted_at TEXT
        );
        CREATE TABLE IF NOT EXISTS run_steps (
            run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sync_log (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            device_id TEXT,
            at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sync_log_user_seq ON sync_log(user_id, seq);
        CREATE INDEX IF NOT EXISTS runs_user ON runs(user_id);
        PRAGMA user_version = ${SCHEMA_VERSION};
        COMMIT;
    `);
}

function transaction(db, fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
        const result = fn();
        db.exec('COMMIT');
        return result;
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}

module.exports = { openDatabase, transaction };
