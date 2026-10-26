// ==========================================
// VERSCHLÜSSELUNG DER API-KEYS (WebCrypto)
// ==========================================
// Aus dem Passwort wird mit PBKDF2-SHA-256 (310.000 Runden, zufälliges Salz je Profil) ein Hauptschlüssel
// abgeleitet. Daraus entstehen – per HMAC mit unterschiedlicher Bezeichnung – zwei getrennte Werte:
//   - der AES-256-GCM-Schlüssel für die API-Keys (jeder Key mit eigenem zufälligem IV; der Feldname ist
//     als zusätzliche authentifizierte Angabe gebunden, ein Key lässt sich also nicht in ein anderes Feld kopieren)
//   - ein Prüfwert für das Passwort (ersetzt den früheren djb2-Hash, mit dem sich Passwörter offline in
//     Sekunden hätten raten lassen und der die Verschlüsselung entwertet hätte)
// Gespeichert: profile.auth = { v: 2, salt, iter, verifier }, Keys als "aes1:" + Base64(IV + Chiffrat).
// Ältere Profile (XOR-"Verschlüsselung", djb2-Hash) werden beim nächsten Login automatisch umgestellt.
// WebCrypto gibt es nur in sicheren Kontexten (https, localhost). Auf einer reinen http-Adresse bleibt es
// beim alten Verfahren, und die App weist darauf hin.

const PBKDF2_ITERATIONS = 310000;
const AES_PREFIX = 'aes1:';

// Alle API-Key-Felder: Feld im Profil ↔ Eingabefeld in der Oberfläche
const SECRET_FIELDS = [
    { field: 'custom1Key', el: 'custom1-key' },
    { field: 'custom2Key', el: 'custom2-key' },
    { field: 'custom3Key', el: 'custom3-key' },
    { field: 'openaiKey', el: 'openai-key' },
    { field: 'geminiKey', el: 'gemini-key' },
    { field: 'hochschuleKey', el: 'hochschule-key' },
    { field: 'endpointKey', el: 'endpoint-key' }
];

function cryptoAvailable() {
    return typeof globalThis.crypto !== 'undefined' && !!globalThis.crypto.subtle;
}

function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Letzte Ableitung merken: Anmeldung und Entsperren brauchen sie beide, PBKDF2 soll nur einmal laufen.
let lastDerivation = null;

async function deriveSession(password, auth) {
    const tag = `${auth.salt}|${auth.iter}`;
    if (lastDerivation && lastDerivation.pass === password && lastDerivation.tag === tag) return lastDerivation.session;
    const subtle = globalThis.crypto.subtle;
    const base = await subtle.importKey('raw', textEncoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const master = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: base64ToBytes(auth.salt), iterations: auth.iter }, base, 256);
    const hmacKey = await subtle.importKey('raw', master, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const derive = async label => new Uint8Array(await subtle.sign('HMAC', hmacKey, textEncoder.encode(label)));
    const aesKey = await subtle.importKey('raw', await derive('lit-agent aes-gcm key'), 'AES-GCM', false, ['encrypt', 'decrypt']);
    const session = { aesKey, verifier: bytesToBase64(await derive('lit-agent password verifier')) };
    lastDerivation = { pass: password, tag, session };
    return session;
}

async function createAuth(password, iterations = PBKDF2_ITERATIONS) {
    const auth = { v: 2, salt: bytesToBase64(globalThis.crypto.getRandomValues(new Uint8Array(16))), iter: iterations, verifier: '' };
    const session = await deriveSession(password, auth);
    auth.verifier = session.verifier;
    return { auth, session };
}

async function checkAuth(password, auth) {
    if (!auth || auth.v !== 2) return { ok: false, session: null };
    const session = await deriveSession(password, auth);
    return { ok: session.verifier === auth.verifier, session };
}

async function encryptSecret(plain, session, field) {
    if (!plain) return '';
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const data = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: textEncoder.encode(field) }, session.aesKey, textEncoder.encode(plain));
    const out = new Uint8Array(12 + data.byteLength);
    out.set(iv); out.set(new Uint8Array(data), 12);
    return AES_PREFIX + bytesToBase64(out);
}

// Altes Verfahren (XOR mit dem Passwort) – nur noch zum Lesen und Umstellen
function legacyDecrypt(base64, password) {
    if (!base64) return '';
    try {
        return Array.from(atob(base64), (c, i) => String.fromCharCode(c.charCodeAt(0) ^ password.charCodeAt(i % password.length))).join('');
    } catch (e) { return ''; }
}

function legacyEncrypt(text, password) {
    if (!text) return '';
    return btoa(Array.from(text, (c, i) => String.fromCharCode(c.charCodeAt(0) ^ password.charCodeAt(i % password.length))).join(''));
}

function legacyHash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) { hash = ((hash << 5) + hash) + str.charCodeAt(i); }
    return hash.toString();
}

function isAesSecret(stored) {
    return typeof stored === 'string' && stored.startsWith(AES_PREFIX);
}

// Entschlüsselt einen gespeicherten Key (AES oder altes Format). Bei falschem Schlüssel oder
// manipulierten Daten kommt ein leerer String zurück, nie ein Fehler.
async function decryptSecret(stored, session, password, field) {
    if (!stored) return '';
    if (!isAesSecret(stored)) return legacyDecrypt(stored, password);
    if (!session) return '';
    try {
        const raw = base64ToBytes(stored.slice(AES_PREFIX.length));
        const data = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: textEncoder.encode(field) }, session.aesKey, raw.slice(12));
        return textDecoder.decode(data);
    } catch (e) {
        return '';
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        SECRET_FIELDS, cryptoAvailable, createAuth, checkAuth, deriveSession, encryptSecret, decryptSecret,
        isAesSecret, legacyEncrypt, legacyDecrypt, legacyHash, PBKDF2_ITERATIONS, AES_PREFIX
    };
}
