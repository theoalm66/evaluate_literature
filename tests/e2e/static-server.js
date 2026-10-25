// Minimaler Static-Server: liefert app/ unter /lit/ aus (wie Tailscale serve auf dem Spark).
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../app');
const PREFIX = '/lit';
const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json'
};

function startStaticServer(port) {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (!url.pathname.startsWith(PREFIX)) { res.writeHead(404); return res.end('not found'); }
        let rel = decodeURIComponent(url.pathname.slice(PREFIX.length)) || '/';
        if (rel.endsWith('/')) rel += 'index.html';
        const file = path.resolve(ROOT, '.' + rel);
        if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

module.exports = { startStaticServer };

if (require.main === module) {
    const port = Number(process.env.PORT) || 8765;
    startStaticServer(port).then(() => console.log(`App: http://localhost:${port}${PREFIX}/`));
}
