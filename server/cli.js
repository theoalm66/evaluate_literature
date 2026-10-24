// Verwaltung auf dem Spark:
//   node server/cli.js user:add <login>       Konto anlegen (Passwort wird abgefragt)
//   node server/cli.js user:passwd <login>    Passwort setzen
//   node server/cli.js user:list              Konten auflisten
//   node server/cli.js user:delete <login>    Konto samt Daten löschen
//   node server/cli.js backup <datei>         konsistente Kopie der Datenbank schreiben
const readline = require('readline');
const { openDatabase } = require('./db');
const { hashPassword, validateCredentials } = require('./auth');

function askPassword(prompt) {
    if (process.env.LIT_PASSWORD) return Promise.resolve(process.env.LIT_PASSWORD);
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        rl._writeToOutput = text => { if (text.includes(prompt)) process.stdout.write(text); };
        rl.question(prompt, answer => { rl.close(); process.stdout.write('\n'); resolve(answer); });
    });
}

async function main() {
    const [command, arg] = process.argv.slice(2);
    const db = openDatabase(process.env.LIT_DB || 'data/lit.db');
    try {
        if (command === 'user:add' || command === 'user:passwd') {
            const exists = db.prepare('SELECT id FROM users WHERE login = ?').get(arg || '');
            if (command === 'user:add' && exists) throw new Error(`Benutzer "${arg}" existiert bereits.`);
            if (command === 'user:passwd' && !exists) throw new Error(`Benutzer "${arg}" gibt es nicht.`);
            const password = await askPassword('Passwort: ');
            const invalid = validateCredentials(arg, password);
            if (invalid) throw new Error(invalid);
            const hash = await hashPassword(password);
            if (exists) {
                db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hash, exists.id);
                db.prepare('DELETE FROM sessions WHERE user_id = ?').run(exists.id);
                console.log(`Passwort für "${arg}" gesetzt; bestehende Sitzungen wurden beendet.`);
            } else {
                db.prepare('INSERT INTO users (login, pass_hash, created_at) VALUES (?, ?, ?)').run(arg, hash, new Date().toISOString());
                console.log(`Benutzer "${arg}" angelegt.`);
            }
        } else if (command === 'user:list') {
            const rows = db.prepare(`SELECT u.login, u.created_at,
                (SELECT COUNT(*) FROM runs r WHERE r.user_id = u.id AND r.deleted_at IS NULL) AS runs
                FROM users u ORDER BY u.login`).all();
            rows.forEach(r => console.log(`${r.login}\tangelegt ${r.created_at}\t${r.runs} Läufe`));
            if (!rows.length) console.log('Keine Benutzer.');
        } else if (command === 'user:delete') {
            const result = db.prepare('DELETE FROM users WHERE login = ?').run(arg || '');
            console.log(result.changes ? `Benutzer "${arg}" und alle Daten gelöscht.` : `Benutzer "${arg}" gibt es nicht.`);
        } else if (command === 'backup') {
            if (!arg) throw new Error('Zieldatei angeben, z.B. backup data/backup-2026-10-24.db');
            db.prepare('VACUUM INTO ?').run(arg);
            console.log(`Sicherung geschrieben: ${arg}`);
        } else {
            console.log('Befehle: user:add <login> | user:passwd <login> | user:list | user:delete <login> | backup <datei>');
            process.exitCode = command ? 1 : 0;
        }
    } catch (err) {
        console.error(err.message);
        process.exitCode = 1;
    } finally {
        db.close();
    }
}

main();
