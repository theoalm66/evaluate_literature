// Start des Servers auf dem Spark. Konfiguration über Umgebungsvariablen (siehe README).
const { buildApp } = require('./app');

const config = {
    dbPath: process.env.LIT_DB || 'data/lit.db',
    inviteCode: process.env.LIT_INVITE_CODE || null,
    cookieSecure: process.env.LIT_COOKIE_SECURE !== 'false',
    sessionDays: Number(process.env.LIT_SESSION_DAYS) || 30,
    logger: { level: process.env.LIT_LOG_LEVEL || 'info' }
};
const host = process.env.LIT_HOST || '127.0.0.1';
const port = Number(process.env.LIT_PORT) || 8080;

const app = buildApp(config);
app.listen({ host, port }).then(() => {
    app.log.info(`Publikations-Agent läuft auf http://${host}:${port}/lit/ (Registrierung: ${config.inviteCode ? 'mit Einladungscode' : 'deaktiviert'})`);
}).catch(err => {
    app.log.error(err);
    process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close().then(() => process.exit(0)));
