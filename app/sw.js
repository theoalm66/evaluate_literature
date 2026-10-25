// Service Worker: hält die App-Dateien für den Offline-Start vor.
// Strategie "Netz zuerst, Cache als Rückfall": online kommt immer die aktuelle Version vom Spark,
// offline (oder bei sehr langsamer Verbindung) die zuletzt geladene. Anfragen an LLM-Endpunkte
// (andere Hosts oder POST) und die Spark-API werden nicht angefasst.
const CACHE_NAME = 'lit-agent-v14';
const NETWORK_TIMEOUT_MS = 4000;
const APP_SHELL = [
    './',
    'index.html',
    'manifest.webmanifest',
    'css/app.css',
    'js/prompts.js',
    'js/scoring.js',
    'js/integrity.js',
    'js/pdf-extract.js',
    'js/schemas.js',
    'js/storage.js',
    'js/crypto.js',
    'js/sync.js',
    'js/providers.js',
    'js/reliability.js',
    'js/reliability-ui.js',
    'js/profile.js',
    'js/ui.js',
    'js/llm.js',
    'js/workflow.js',
    'js/render.js',
    'js/app.js',
    'vendor/pdfjs/pdf.min.js',
    'vendor/pdfjs/pdf.worker.min.js',
    'icons/icon.svg',
    'icons/icon-192.png',
    'icons/icon-512.png'
];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k.startsWith('lit-agent-') && k !== CACHE_NAME).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

function fetchWithTimeout(request) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS);
        fetch(request).then(res => { clearTimeout(timer); resolve(res); }, err => { clearTimeout(timer); reject(err); });
    });
}

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    const scope = new URL(self.registration.scope);
    if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
    // API-Antworten (Login, Synchronisation) dürfen nie aus dem Cache kommen.
    if (url.pathname.startsWith(scope.pathname + 'api/')) return;

    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
            const response = await fetchWithTimeout(request);
            if (response.ok) cache.put(request, response.clone());
            return response;
        } catch (err) {
            const cached = await cache.match(request, { ignoreSearch: true })
                || (request.mode === 'navigate' ? await cache.match('index.html') : undefined);
            if (cached) return cached;
            throw err;
        }
    })());
});
