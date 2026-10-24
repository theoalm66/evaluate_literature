// ==========================================
// START: Speicher öffnen, Offline-Unterstützung, Netzstatus
// ==========================================
async function initApp() {
    const status = document.getElementById('storage-status');
    const result = await initStorage();
    document.querySelectorAll('.auth-btn').forEach(btn => { btn.disabled = false; });
    if (!result.available) {
        status.textContent = 'Lokaler Speicher (IndexedDB) ist in diesem Browser nicht verfügbar. Einstellungen und Historie gehen beim Schließen verloren.';
        status.classList.add('error');
    } else if (result.migrated > 0) {
        status.textContent = `${result.migrated} Analyse(n) aus der bisherigen Version übernommen.`;
    } else {
        status.textContent = '';
    }

    updateNetworkStatus();
    window.addEventListener('online', () => { updateNetworkStatus(); serverStatus = 'unknown'; scheduleSync(500); });
    window.addEventListener('offline', updateNetworkStatus);
    detectServer().then(status => { showServerStatus(status); updateSparkModelHint(); });

    // Der Service Worker hält App und pdf.js für den Offline-Start vor (nur über HTTPS oder localhost).
    if ('serviceWorker' in navigator && window.isSecureContext) {
        navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service Worker nicht registriert:', err));
    }
}

function showServerStatus(status) {
    const el = document.getElementById('server-status');
    if (status === 'absent') hideInviteField();
    el.classList.toggle('error', status === 'unreachable');
    el.textContent = status === 'available' ? '✓ Verbunden mit dem Spark'
        : status === 'unreachable' ? 'Spark nicht erreichbar – Anmeldung nur mit lokal gespeichertem Profil.'
        : status === 'absent' ? 'Ohne Spark-Server: Profile werden nur in diesem Browser gespeichert.' : '';
}

// Ohne Spark-Backend gibt es keine Konten auf dem Server – dann ist der Einladungscode überflüssig.
function hideInviteField() {
    const input = document.getElementById('login-invite');
    input.style.display = 'none';
    if (input.previousElementSibling?.tagName === 'LABEL') input.previousElementSibling.style.display = 'none';
}

function updateNetworkStatus() {
    const badge = document.getElementById('net-status');
    if (badge) badge.classList.toggle('visible', !navigator.onLine);
}

initApp();
