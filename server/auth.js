// Passwort-Hashing (scrypt), Sitzungen und Schutz gegen Passwort-Raten.
const crypto = require('crypto');

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const MIN_PASSWORD_LENGTH = 8;
const LOGIN_PATTERN = /^[\p{L}\p{N}._@-]{1,64}$/u;

function scrypt(password, salt) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem },
            (err, key) => err ? reject(err) : resolve(key));
    });
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(password, salt);
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

// Fester Dummy-Hash, damit unbekannte Benutzer genauso lange brauchen wie falsche Passwörter.
let dummyHash = null;

async function verifyPassword(password, stored) {
    if (!stored) {
        dummyHash = dummyHash || await hashPassword('dummy-password');
        stored = dummyHash;
        password = `${password}\u0000no-user`;
    }
    const [scheme, n, r, p, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const key = await new Promise((resolve, reject) => {
        crypto.scrypt(password, Buffer.from(salt, 'base64'), expected.length,
            { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem }, (err, k) => err ? reject(err) : resolve(k));
    });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function validateCredentials(login, password) {
    if (typeof login !== 'string' || !LOGIN_PATTERN.test(login)) return 'Ungültiger Benutzername (1–64 Zeichen: Buchstaben, Ziffern, . _ @ -).';
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen haben.`;
    if (password.length > 512) return 'Das Passwort ist zu lang.';
    return null;
}

function newSessionToken() {
    return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Begrenzt Fehlversuche je Benutzername und insgesamt. Hinter Tailscale kommen alle Anfragen von
// 127.0.0.1, daher wird nicht nach IP-Adresse unterschieden.
class LoginLimiter {
    constructor({ perLogin = 10, global = 100, windowMs = 15 * 60 * 1000 } = {}) {
        this.perLogin = perLogin;
        this.global = global;
        this.windowMs = windowMs;
        this.failures = new Map();
        this.globalFailures = [];
    }

    prune(now) {
        this.globalFailures = this.globalFailures.filter(t => now - t < this.windowMs);
        for (const [key, times] of this.failures) {
            const recent = times.filter(t => now - t < this.windowMs);
            if (recent.length) this.failures.set(key, recent); else this.failures.delete(key);
        }
    }

    isBlocked(login, now = Date.now()) {
        this.prune(now);
        return (this.failures.get(String(login).toLowerCase())?.length || 0) >= this.perLogin
            || this.globalFailures.length >= this.global;
    }

    recordFailure(login, now = Date.now()) {
        const key = String(login).toLowerCase();
        this.failures.set(key, [...(this.failures.get(key) || []), now]);
        this.globalFailures.push(now);
    }

    recordSuccess(login) {
        this.failures.delete(String(login).toLowerCase());
    }
}

module.exports = { hashPassword, verifyPassword, validateCredentials, newSessionToken, hashToken, LoginLimiter, MIN_PASSWORD_LENGTH };
