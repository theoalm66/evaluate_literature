// ==========================================
// LANGE DOKUMENTE: Hinweis und Auswahl vor der Analyse
// ==========================================
// Übersteigt ein Dokument das Eingabelimit, fragt die App, wie es weitergehen soll – statt es stillschweigend zu kürzen.

function currentProviderModelKey() {
    const provider = document.getElementById('llm-provider').value;
    let model = '';
    if (isUrlProvider(provider)) model = document.getElementById(`${provider}-model`).value;
    else if (provider === 'spark') model = document.getElementById('spark-model').value.trim();
    else if (provider === 'openai') model = document.getElementById('openai-model').value || 'gpt-4o-mini';
    else if (provider === 'gemini') model = document.getElementById('gemini-model').value || 'gemini-2.5-flash';
    return { provider, model, key: `${provider}|${model}` };
}

// Kontextfenster des aktuell gewählten Modells, soweit bekannt: { tokens, assumed } oder null
function currentContextTokens() {
    const { provider, model, key } = currentProviderModelKey();
    if (detectedContextTokens[key]) return { tokens: detectedContextTokens[key], assumed: false };
    if (provider === 'openai') return { tokens: openaiContextTokens(model), assumed: true };
    if (provider === 'gemini') return { tokens: 1000000, assumed: true };
    return null;
}

// Andere eingerichtete Modelle mit bekanntem, ausreichend großem Kontextfenster
function otherModelCandidates() {
    const current = currentProviderModelKey().provider;
    const list = [];
    if (current !== 'openai' && document.getElementById('openai-key').value) {
        const model = document.getElementById('openai-model').value || 'gpt-4o-mini';
        list.push({ id: 'openai', label: `OpenAI ${model}`, contextTokens: openaiContextTokens(model), assumed: true });
    }
    if (current !== 'gemini' && document.getElementById('gemini-key').value) {
        const model = document.getElementById('gemini-model').value || 'gemini-2.5-flash';
        list.push({ id: 'gemini', label: `Google Gemini ${model}`, contextTokens: 1000000, assumed: true });
    }
    for (const [key, tokens] of Object.entries(detectedContextTokens)) {
        const [provider, model] = key.split('|');
        if (provider === current || provider === 'openai' || provider === 'gemini') continue;
        list.push({ id: provider, label: `${PROVIDER_LABELS[provider] || provider}${model ? ` ${model}` : ''}`, contextTokens: tokens, assumed: false });
    }
    return list;
}

function fmtNum(n) { return Number(n).toLocaleString('de-DE'); }

// Fragt den Nutzer; Ergebnis: { action: 'stages' | 'truncate' | 'raise' | 'switch' | 'cancel', limit?, candidate? }
function askLongDocumentStrategy({ longDocs, maxChars, outTokens, splitExtraction, repeatRuns }) {
    return new Promise(resolve => {
        const dialog = document.getElementById('long-doc-dialog');
        const body = document.getElementById('long-doc-body');
        const needed = Math.max(...longDocs.map(d => fullEvidenceLength(d.pages)));
        const stagesPerDoc = longDocs.map(d => splitStages(d.pages, maxChars));
        const maxStageCount = Math.max(...stagesPerDoc.map(s => s.stages.length));
        const extraCalls = stagesPerDoc.reduce((a, s) => a + estimateStagedCalls({ stages: s.stages.length, splitExtraction, repeatRuns }), 0);
        const cutOff = stagesPerDoc.some(s => s.truncated);
        const ctx = currentContextTokens();
        const fitsChars = ctx ? Math.floor((ctx.tokens - outTokens - PROMPT_OVERHEAD_TOKENS) * CHARS_PER_TOKEN) : 0;
        const canRaise = ctx && fitsChars >= needed;
        const suggestions = modelSuggestions(otherModelCandidates(), needed, outTokens, PROMPT_OVERHEAD_TOKENS, CHARS_PER_TOKEN);

        const docRows = longDocs.map(d => {
            const total = fullEvidenceLength(d.pages);
            return `<li><strong>${escapeHTML(d.title)}</strong>: ${fmtNum(total)} Zeichen, das Modell sähe bei Ihrem Limit nur ${Math.min(100, Math.round(maxChars / total * 100))} %</li>`;
        }).join('');
        const option = (id, title, detail, extra = '') => `<div class="long-doc-option">${id === 'switch' ? `<strong style="display:block;margin-bottom:.3rem;">${title}</strong>` : `<button class="btn btn-small" data-choice="${id}">${title}</button>`}<div class="long-doc-detail">${detail}</div>${extra}</div>`;

        body.innerHTML = `
            <p>Ein Sprachmodell kann nur begrenzt viel Text auf einmal lesen. Ihr Eingabelimit liegt bei <strong>${fmtNum(maxChars)} Zeichen</strong>. Was darüber hinausgeht, würde nicht gelesen und als „nicht berichtet“ bewertet.</p>
            <ul>${docRows}</ul>
            <p>Wie soll die App weiter vorgehen?</p>
            ${option('stages', `In Etappen auswerten${canRaise ? '' : ' (empfohlen)'}`,
                `Der Text wird in ${maxStageCount} Abschnitt(e) geteilt, die je ins Limit passen. Extraktion und CASQ-Prüffragen lesen den ganzen Text; Instrumente und Verzerrungsbewertung (Agent 3 und 4) sehen weiter den wichtigsten Ausschnitt, und die LLM-Validierung der Prüffragen entfällt (die Belegprüfung im PDF bleibt). Etwa ${extraCalls} zusätzliche Modellaufrufe, die Laufzeit steigt entsprechend.${cutOff ? ` Mehr als ${MAX_STAGES} Etappen liest die App nicht; der Rest des Dokuments bleibt ungelesen.` : ''}`)}
            ${canRaise ? option('raise', `Limit auf ${fmtNum(Math.ceil(needed / 1000) * 1000)} Zeichen erhöhen (empfohlen)`,
                `Das gewählte Modell hat ${ctx.assumed ? 'laut Modellname etwa' : 'laut Anbieter'} ${fmtNum(ctx.tokens)} Token Kontextfenster. Das reicht rechnerisch für den ganzen Text auf einmal (Schätzung: 3,2 Zeichen je Token, ${fmtNum(PROMPT_OVERHEAD_TOKENS)} Token für Anweisungen, ${fmtNum(outTokens)} Token Antwort). Das ist der schnellste Weg, kostet bei Bezahl-Modellen aber mehr.`) : ''}
            ${suggestions.length ? option('switch', 'Anderes Modell verwenden',
                `Diese eingerichteten Modelle haben ein Fenster, in das der ganze Text passt. Die Analyse wird dann abgebrochen, Sie starten sie erneut mit dem gewählten Modell.`,
                suggestions.map((s, i) => `<button class="btn btn-secondary btn-small" data-switch="${i}">Zu ${escapeHTML(s.label)} wechseln (${fmtNum(s.contextTokens)} Token${s.assumed ? ', laut Modellname' : ''})</button>`).join(' ')) : ''}
            ${option('truncate', 'Gekürzt auswerten', `Das Modell sieht nur den wichtigsten Teil (${Math.min(100, Math.round(maxChars / needed * 100))} % bei dem längsten Dokument); Angaben außerhalb davon zählen als „nicht berichtet“ und senken den CASQ. Das Ergebnis trägt eine Warnung.`)}
            ${option('cancel', 'Abbrechen', 'Die Analyse startet nicht.')}`;

        const finish = result => { dialog.style.display = 'none'; resolve(result); };
        body.querySelectorAll('button[data-choice]').forEach(btn => btn.addEventListener('click', () => {
            const choice = btn.dataset.choice;
            if (choice === 'raise') finish({ action: 'raise', limit: Math.ceil(needed / 1000) * 1000 });
            else finish({ action: choice });
        }));
        body.querySelectorAll('button[data-switch]').forEach(btn => btn.addEventListener('click', () => finish({ action: 'switch', candidate: suggestions[Number(btn.dataset.switch)], limit: Math.min(MAX_AUTO_EVIDENCE_CHARS * 2, Math.ceil(needed / 1000) * 1000) })));
        dialog.style.display = 'flex';
    });
}

// Stellt auf das vorgeschlagene Modell um (Anbieterauswahl und Limit); die Analyse muss danach erneut gestartet werden.
function applyModelSwitch(candidate, limit) {
    document.getElementById('llm-provider').value = candidate.id;
    toggleProviderSettings();
    document.getElementById('max-evidence-chars').value = limit;
    saveUserKeys();
    scheduleLlmStatusCheck?.(300);
}
