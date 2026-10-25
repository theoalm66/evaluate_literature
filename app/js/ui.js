// ==========================================
// UI & STATE MANAGEMENT
// ==========================================
// pdf.js wird lokal ausgeliefert, damit die App auch offline PDFs lesen kann.
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
let selectedFiles = []; let globalResults = {};

function switchTab(tabId) {
    document.querySelectorAll('.container').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('nav button').forEach(el => el.classList.remove('active'));
    document.getElementById(`tab-${tabId}`).classList.add('active');
    // Über data-tab statt event.target, damit der Aufruf auch aus Code (z.B. Historie) funktioniert.
    const navButton = document.querySelector(`nav button[data-tab="${tabId}"]`);
    if (navButton) navButton.classList.add('active');
}

function toggleProviderSettings() {
    const provider = document.getElementById('llm-provider').value;
    document.getElementById('settings-custom1').style.display = provider === 'custom1' ? 'block' : 'none';
    document.getElementById('settings-custom2').style.display = provider === 'custom2' ? 'block' : 'none';
    document.getElementById('settings-custom3').style.display = provider === 'custom3' ? 'block' : 'none';
    document.getElementById('settings-openai').style.display = provider === 'openai' ? 'block' : 'none';
    document.getElementById('settings-gemini').style.display = provider === 'gemini' ? 'block' : 'none';
    document.getElementById('settings-spark').style.display = provider === 'spark' ? 'block' : 'none';
    document.getElementById('settings-hochschule').style.display = provider === 'hochschule' ? 'block' : 'none';
    document.getElementById('settings-endpoint').style.display = provider === 'endpoint' ? 'block' : 'none';
}

function isPdfFile(f) {
    return f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
}

function handleFiles(files) {
    const all = Array.from(files || []);
    const newFiles = all.filter(isPdfFile);
    if (newFiles.length < all.length) log(`${all.length - newFiles.length} Datei(en) ignoriert – nur PDFs werden angenommen.`, 'warning');
    let addedCount = 0;
    
    newFiles.forEach(f => {
        if (!selectedFiles.some(existing => existing.name === f.name)) {
            selectedFiles.push(f);
            addedCount++;
        }
    });
    
    renderFileList();
    log(`${addedCount} neue Datei(en) hinzugefügt. Gesamt: ${selectedFiles.length}`, 'success');
    document.getElementById('file-input').value = ''; 
}

function renderFileList() {
    const list = document.getElementById('file-list');
    if (selectedFiles.length === 0) {
        list.innerHTML = 'Keine Dateien ausgewählt.';
        return;
    }
    
    list.innerHTML = selectedFiles.map((f, i) => `
        <div class="file-item">
            <span class="file-item-name" title="${escapeHTML(f.name)}">📄 ${escapeHTML(f.name)}</span>
            <button class="file-item-remove" onclick="removeFile(${i}); event.stopPropagation();" title="Datei entfernen">×</button>
        </div>
    `).join('');
}

function removeFile(index) {
    const removed = selectedFiles.splice(index, 1)[0];
    renderFileList();
    log(`Datei entfernt: ${removed.name}`, 'info');
}

function log(msg, type = 'info') {
    const term = document.getElementById('terminal');
    const time = new Date().toLocaleTimeString();
    const div = document.createElement('div');
    div.className = `log-${type}`;
    div.textContent = `[${time}] ${msg}`;
    term.appendChild(div);
    term.scrollTop = term.scrollHeight;
}

function setStep(stepNum, status) {
    const step = document.getElementById(`step-${stepNum}`);
    if (status === 'active') step.classList.add('active');
    if (status === 'done') { step.classList.remove('active'); step.classList.add('done'); }
}

function toggleTerminal() {
    const term = document.getElementById('terminal');
    const btn = document.getElementById('btn-toggle-terminal');
    if (term.style.display === 'none') {
        term.style.display = 'flex';
        btn.textContent = 'Terminal ausblenden';
    } else {
        term.style.display = 'none';
        btn.textContent = 'Terminal anzeigen';
    }
}

// Drag & Drop auf die Ablagefläche. Außerhalb der Fläche abgelegte Dateien werden abgefangen,
// damit der Browser das PDF nicht anstelle der App öffnet.
function initFileDrop() {
    const zone = document.querySelector('.file-drop');
    if (!zone) return;
    const hasFiles = e => Array.from(e.dataTransfer?.types || []).includes('Files');
    ['dragenter', 'dragover'].forEach(type => zone.addEventListener(type, e => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        zone.classList.add('dragover');
    }));
    zone.addEventListener('dragleave', e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('dragover'); });
    zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.classList.remove('dragover');
        handleFiles(e.dataTransfer.files);
    });
    window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', e => { if (hasFiles(e) && !zone.contains(e.target)) e.preventDefault(); });
}

initFileDrop();
