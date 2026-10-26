// ==========================================
// LANGE DOKUMENTE: Etappen, Zusammenführung, Modellvorschläge
// ==========================================
// Übersteigt ein Dokument das Eingabelimit, kann es in Etappen gelesen werden: Der Text wird in Abschnitte geteilt, die je ins Limit passen,
// Extraktion und CASQ-Prüffragen laufen je Abschnitt, die Ergebnisse werden zusammengeführt. Die Funktionen sind rein und in Node testbar.

const MAX_STAGES = 8;

const renderStagePage = p => `\n--- PAGE ${p.page} ---\n${p.text}\n`;

// Länge des vollständigen Evidenztexts (so, wie ihn das Modell ohne Kürzung bekäme)
function fullEvidenceLength(pages) {
    return (pages || []).reduce((sum, p) => sum + renderStagePage(p).length, 0);
}

// Teilt die Seiten in aufeinanderfolgende Etappen, die je höchstens maxChars lang sind. Eine einzelne, zu lange Seite wird gekürzt.
// Mehr als maxStages Etappen werden nicht gebildet (truncated = true).
function splitStages(pages, maxChars, maxStages = MAX_STAGES) {
    const stages = [];
    let current = null;
    let skipped = false;
    for (const page of pages || []) {
        let chunk = renderStagePage(page);
        if (chunk.length > maxChars) chunk = chunk.slice(0, maxChars);
        if (!current || current.text.length + chunk.length > maxChars) {
            if (stages.length >= maxStages) { skipped = true; current = null; continue; }
            current = { index: stages.length + 1, pages: [], text: '' };
            stages.push(current);
        }
        current.pages.push(page.page);
        current.text += chunk;
    }
    stages.forEach(s => { s.from = s.pages[0]; s.to = s.pages[s.pages.length - 1]; });
    const covered = stages.reduce((a, s) => a + s.text.length, 0);
    return { stages, truncated: skipped, covered_chars: covered, total_chars: fullEvidenceLength(pages) };
}

const meaningful = v => !(v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)
    || (typeof v === 'string' && /^(not_reported|unclear|unknown|other|n\/a)$/i.test(v.trim())));

function mergeValues(a, b, cap = 40) {
    if (Array.isArray(a) || Array.isArray(b)) {
        const out = [], seen = new Set();
        for (const item of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
            const key = typeof item === 'string' ? item.trim().toLowerCase() : JSON.stringify(item);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(item);
        }
        return out.slice(0, cap);
    }
    if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) || Boolean(b);
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const out = { ...a };
        for (const key of Object.keys(b)) out[key] = key in a ? mergeValues(a[key], b[key], cap) : b[key];
        return out;
    }
    return meaningful(a) ? a : (meaningful(b) ? b : (a ?? b));
}

// Führt die Extraktionen der Etappen zusammen: Listen werden vereinigt (ohne Doppelte, höchstens 40 Einträge), Wahrheitswerte mit ODER,
// Einzelwerte übernimmt die erste Etappe mit einem Inhalt (Titel, Zusammenfassung und Design stehen meist vorn).
function mergeExtractions(list) {
    const usable = (list || []).filter(x => x && typeof x === 'object');
    if (!usable.length) return {};
    return usable.slice(1).reduce((acc, next) => mergeValues(acc, next), { ...usable[0] });
}

const RESPONSE_RANK = { yes: 4, partial: 3, no: 2, not_reported: 1, not_applicable: 0 };

// Führt die Antworten der Etappen je Prüffrage zusammen: Die beste Antwort zählt (ja vor teilweise vor nein vor nicht berichtet),
// weil eine Frage schon durch eine einzige Fundstelle im Dokument erfüllt ist. „nicht anwendbar“ nur, wenn alle Etappen so antworten.
function mergeChecklistStages(stageLists, ids, normalize = r => String(r || 'not_reported')) {
    const merged = [];
    for (const id of ids) {
        const answers = stageLists.map((list, i) => {
            const a = (list || []).find(x => x && x.id === id);
            return a ? { ...a, response: normalize(a.response), stage: i + 1 } : null;
        }).filter(Boolean);
        if (!answers.length) continue;
        const best = answers.reduce((x, y) => (RESPONSE_RANK[y.response] > RESPONSE_RANK[x.response] ? y
            : RESPONSE_RANK[y.response] === RESPONSE_RANK[x.response] && !(x.evidence || []).length && (y.evidence || []).length ? y : x));
        merged.push({ ...best, id, rationale: `${best.rationale || ''}${best.rationale ? ' ' : ''}[Etappe ${best.stage}/${stageLists.length}]`.trim() });
    }
    return merged;
}

// Zusätzliche Modellaufrufe im Etappenmodus gegenüber dem normalen Ablauf (grobe Schätzung für die Anzeige)
function estimateStagedCalls({ stages, splitExtraction, repeatRuns }) {
    const normalExtraction = splitExtraction ? 3 : 1;
    const staged = stages * (splitExtraction ? 3 : 1) + stages * repeatRuns;
    const normal = normalExtraction + repeatRuns;
    return Math.max(0, staged - normal);
}

// Welche der bekannten Modelle haben ein Kontextfenster, in das der ganze Text passt? candidates: [{ id, label, contextTokens }]
function modelSuggestions(candidates, neededChars, outputTokens, overheadTokens = 12000, charsPerToken = 3.2) {
    return (candidates || [])
        .filter(c => Number(c.contextTokens) > 0)
        .map(c => ({ ...c, fitsChars: Math.max(0, Math.floor((c.contextTokens - (outputTokens || 0) - overheadTokens) * charsPerToken)) }))
        .filter(c => c.fitsChars >= neededChars)
        .sort((a, b) => a.contextTokens - b.contextTokens);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MAX_STAGES, fullEvidenceLength, splitStages, mergeExtractions, mergeChecklistStages, estimateStagedCalls, modelSuggestions };
}
