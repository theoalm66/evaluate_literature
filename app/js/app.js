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
    detectServer().then(status => {
        if (status === 'absent') hideInviteField();
    });

    // Der Service Worker hält App und pdf.js für den Offline-Start vor (nur über HTTPS oder localhost).
    if ('serviceWorker' in navigator && window.isSecureContext) {
        navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service Worker nicht registriert:', err));
    }
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
