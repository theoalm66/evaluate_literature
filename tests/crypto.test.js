const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../app/js/crypto.js');

const FAST = 1000;   // wenige Runden genügen für die Tests; die App nutzt PBKDF2_ITERATIONS

test('Verschlüsseln und Entschlüsseln, jeder Key mit eigenem IV', async () => {
    const { auth, session } = await c.createAuth('geheimes-Passwort', FAST);
    const a = await c.encryptSecret('sk-test-123', session, 'openaiKey');
    const b = await c.encryptSecret('sk-test-123', session, 'openaiKey');
    assert.ok(a.startsWith('aes1:') && a !== b, 'gleicher Klartext darf nicht gleich aussehen');
    assert.ok(!a.includes('sk-test'), 'Klartext darf nicht erkennbar sein');
    assert.equal(await c.decryptSecret(a, session, 'geheimes-Passwort', 'openaiKey'), 'sk-test-123');
    assert.equal(await c.encryptSecret('', session, 'openaiKey'), '');
    assert.equal(await c.decryptSecret('', session, 'x', 'openaiKey'), '');
    // Umlaute und lange Keys
    const long = 'äöü€-' + 'x'.repeat(500);
    assert.equal(await c.decryptSecret(await c.encryptSecret(long, session, 'geminiKey'), session, 'p', 'geminiKey'), long);
    assert.equal(auth.v, 2);
});

test('Passwortprüfung: richtiges Passwort passt, falsches nicht', async () => {
    const { auth } = await c.createAuth('richtig-1234', FAST);
    assert.equal((await c.checkAuth('richtig-1234', auth)).ok, true);
    assert.equal((await c.checkAuth('falsch-1234', auth)).ok, false);
    assert.equal((await c.checkAuth('richtig-1234', null)).ok, false);
    // Jedes Profil bekommt ein eigenes Salz
    const other = await c.createAuth('richtig-1234', FAST);
    assert.notEqual(other.auth.salt, auth.salt);
    assert.notEqual(other.auth.verifier, auth.verifier);
});

test('Falsches Passwort, manipulierte Daten und vertauschte Felder liefern nichts', async () => {
    const mine = await c.createAuth('passwort-A', FAST);
    const stranger = await c.createAuth('passwort-B', FAST);
    const stored = await c.encryptSecret('sk-geheim', mine.session, 'openaiKey');
    assert.equal(await c.decryptSecret(stored, stranger.session, 'passwort-B', 'openaiKey'), '');
    // Ein Zeichen im Chiffrat ändern → Authentifizierung schlägt fehl
    const raw = Buffer.from(stored.slice(5), 'base64');
    raw[raw.length - 1] ^= 1;
    assert.equal(await c.decryptSecret('aes1:' + raw.toString('base64'), mine.session, 'passwort-A', 'openaiKey'), '');
    // In ein anderes Feld kopiert → Feldname ist gebunden
    assert.equal(await c.decryptSecret(stored, mine.session, 'passwort-A', 'geminiKey'), '');
    assert.equal(await c.decryptSecret('aes1:kaputt!!', mine.session, 'passwort-A', 'openaiKey'), '');
});

test('Altes Format (XOR, djb2) bleibt lesbar und wird erkannt', async () => {
    const legacy = c.legacyEncrypt('sk-alt-key', 'pw123456');
    assert.equal(c.isAesSecret(legacy), false);
    assert.equal(await c.decryptSecret(legacy, null, 'pw123456', 'openaiKey'), 'sk-alt-key');
    assert.equal(c.legacyHash('pw'), '5863724');   // wie hashString() der Originaldatei
});

test('Alle Key-Felder sind eindeutig und haben ein Eingabefeld', () => {
    const fields = c.SECRET_FIELDS.map(f => f.field);
    assert.equal(new Set(fields).size, fields.length);
    assert.ok(fields.includes('hochschuleKey') && fields.includes('endpointKey'));
    assert.ok(c.SECRET_FIELDS.every(f => f.el.endsWith('-key')));
});
