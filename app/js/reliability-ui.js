// ==========================================
// ZUVERLÄSSIGKEIT: Anzeige und Tab "Zuverlässigkeit"
// ==========================================
// Rechenlogik steht in reliability.js. Hier: Ergebnis der Mehrfachbewertung je Studie sowie das Tab, in dem
// Referenzbewertungen von Fachleuten eingetragen/importiert und mit den Bewertungen der App verglichen werden.

const fmt = (v, d = 2) => v === null || v === undefined || Number.isNaN(v) ? '–' : Number(v).toFixed(d);
const fmtCI = ci => ci ? `[${fmt(ci[0])}; ${fmt(ci[1])}]` : '';
const pctText = v => v === null || v === undefined ? '–' : `${Math.round(v * 100)} %`;

function votesText(votes) {
    const labels = { yes: 'ja', partial: 'teilweise', no: 'nein', not_reported: 'nicht berichtet', not_applicable: 'n. a.', 'fehlt|': 'fehlt' };
    return Object.entries(votes || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}× ${labels[k] || k.replace('|', ' / ')}`).join(', ');
}

// ---------- Ergebnis der Mehrfachbewertung je Studie ----------
function renderReliability(rel, study) {
    if (!rel) return '';
    const casq = rel.casq, est = rel.established;
    const rubric = CASQ_RUBRICS[study?.appraisal?.casq_rubric];
    const questionText = id => rubric?.dimensions.flatMap(d => d.questions).find(q => q.id === id)?.text || '';
    const kappaText = k => k === null || k === undefined ? 'nicht berechenbar (keine Variation)' : `${fmt(k)} – ${interpretKappa(k)}`;
    const chips = [];
    if (casq) {
        chips.push(`<div class="integ-chip"><div class="integ-chip-title">CASQ JE DURCHLAUF</div><div class="integ-chip-value">${casq.scores.map(v => v === null ? '–' : fmt(v, 1)).join(' · ')}</div><div>Median ${fmt(casq.median, 1)} · Spanne ${fmt(casq.min, 1)}–${fmt(casq.max, 1)} · SD ${fmt(casq.sd, 2)}</div></div>`);
        chips.push(`<div class="integ-chip"><div class="integ-chip-title">ÜBEREINSTIMMUNG PRÜFFRAGEN</div><div class="integ-chip-value">${pctText(casq.agreement)}</div><div>${pctText(casq.unanimous_share)} einstimmig · Fleiss-κ ${kappaText(casq.fleiss)}</div></div>`);
    }
    if (est && est.runs?.length) {
        chips.push(`<div class="integ-chip"><div class="integ-chip-title">${escapeHTML((est.instrument || 'INSTRUMENT').toUpperCase())} JE DURCHLAUF</div><div class="integ-chip-value">${est.runs.map(r => escapeHTML(r.applicable ? r.display : 'n. a.')).join(' · ')}</div><div>Items: ${pctText(est.agreement)} Übereinstimmung · Fleiss-κ ${kappaText(est.fleiss)}</div></div>`);
    }
    const uncertainRows = (casq?.uncertain || []).map(u => `<tr><td style="white-space:nowrap;">${escapeHTML(u.id)}</td><td>${escapeHTML(questionText(u.id))}</td><td>${escapeHTML(votesText(u.votes))}</td><td>${escapeHTML(CASQ_RESPONSE_LABEL[u.chosen] || u.chosen)}</td></tr>`).join('');
    const uncertainItems = (est?.uncertain || []).map(u => `<tr><td>Item ${escapeHTML(u.item_id)}</td><td colspan="2">${escapeHTML(votesText(u.votes))}</td><td>${escapeHTML(u.chosen.split('|')[0])}</td></tr>`).join('');
    const failed = rel.runs_requested - Math.min(rel.analysis_runs, rel.casq_runs || rel.analysis_runs);
    return `<div class="integ-box" style="background:#faf5ff;border-color:#e9d5ff;border-left-color:#9333ea;">
        <div style="font-size:.72rem;color:#6b21a8;font-weight:700;">MEHRFACHBEWERTUNG · ${rel.runs_requested} Durchläufe (Agent 3 und 3b), Temperatur ${fmt(rel.temperature, 1)}</div>
        <div class="integ-chips">${chips.join('')}</div>
        ${failed > 0 ? `<div style="font-size:.8rem;color:#92400e;">${failed} Durchlauf/Durchläufe fehlgeschlagen – ausgewertet wurden ${rel.analysis_runs} (Agent 3) bzw. ${rel.casq_runs} (Agent 3b).</div>` : ''}
        ${uncertainRows || uncertainItems ? `<details style="margin-top:.4rem;"><summary style="cursor:pointer;font-weight:600;">Unsichere Antworten (${(casq?.uncertain?.length || 0) + (est?.uncertain?.length || 0)}) – die Durchläufe waren sich nicht einig</summary>
            <div style="overflow-x:auto;"><table class="integ-table"><thead><tr><th>ID</th><th>Prüffrage</th><th>Stimmen</th><th>Gewertet</th></tr></thead><tbody>${uncertainRows}${uncertainItems}</tbody></table></div></details>` : '<div style="font-size:.85rem;margin-top:.3rem;">Alle Durchläufe stimmen bei allen Fragen überein.</div>'}
        <div style="font-size:.72rem;color:var(--text-light);margin-top:.5rem;">Je Frage entscheidet die Mehrheit der Durchläufe (bei Gleichstand die vorsichtigere Antwort); der angezeigte CASQ stammt aus diesem Mehrheitsergebnis nach der Validierung durch Agent 4/4b. Die Übereinstimmung zeigt, wie stabil die Bewertung bei Wiederholung ist – nicht, ob sie richtig ist. Dafür dient der Abgleich mit Expertenbewertungen im Tab „Zuverlässigkeit“.</div>
    </div>`;
}

// ---------- Tab: Daten sammeln ----------
// Eine Zeile je Studie in der Historie: Bewertung der App in vergleichbarer Form
async function collectStudiesForReliability(user) {
    const runs = await listRuns(user);
    const out = [];
    for (const run of runs) {
        const res = run.result || {};
        for (const r of res.study_results || []) {
            const established = calculateEstablishedResult(r.validation || {}, r.appraisal || {}, r.extraction || {});
            out.push({
                title: r.title, key: normalizeDocKey(r.title), model: run.model || res.model || 'unbekannt', createdAt: run.createdAt, runId: run.id,
                doi: String(r.integrity?.computed?.doi || r.integrity?.online?.doi || '').toLowerCase(),
                agent: agentAssessment(established, r.casq_score), reliability: r.reliability || null,
                established, rubric: r.appraisal?.casq_rubric || null
            });
        }
    }
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function latestPerDocument(studies) {
    const seen = new Set();
    return studies.filter(s => { if (seen.has(s.key)) return false; seen.add(s.key); return true; });
}

function resolveReferences(studies, refs) {
    const byKey = new Map(refs.map(r => [r.key, r]));
    const byDoi = new Map(refs.filter(r => r.doi).map(r => [r.doi, r]));
    const resolved = new Map();
    for (const s of studies) {
        const ref = byKey.get(s.key) || (s.doi && byDoi.get(s.doi)) || null;
        if (ref) resolved.set(s.key, ref);
    }
    return resolved;
}

// ---------- Tab: Referenzen eintragen ----------
let reliabilityData = { studies: [], refs: [] };
let refSaveTimers = {};

function emptyRef(key, name) {
    return { key, name, doi: '', pedro_total: null, pedro_items: {}, amstar2: null, casq: null };
}

function renderReferenceTable(studies, refs) {
    const docs = latestPerDocument(studies);
    const refByKey = new Map(refs.map(r => [r.key, r]));
    if (!docs.length) return '<p style="font-size:.9rem;color:var(--text-light);">Noch keine analysierten Dokumente in der Historie. Erst Dokumente analysieren – oder Referenzen per CSV importieren und später zuordnen.</p>';
    const rows = docs.map(d => {
        const ref = refByKey.get(d.key) || (d.doi && refs.find(r => r.doi === d.doi)) || null;
        const items = ref ? PEDRO_ITEM_IDS.filter(id => ref.pedro_items?.[id]).length : 0;
        const a = d.agent;
        return `<tr data-key="${escapeHTML(d.key)}" data-name="${escapeHTML(d.title)}">
            <td title="${escapeHTML(d.title)}" style="max-width:16rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHTML(d.title)}</td>
            <td style="font-size:.75rem;color:var(--text-light);">${escapeHTML(a.pedro ? `PEDro ${a.pedro.total}/10` : '')}${a.amstar2 ? ` AMSTAR ${escapeHTML(AMSTAR2_LABELS[a.amstar2])}` : ''}${a.casq !== null ? ` · CASQ ${fmt(a.casq, 1)}` : ''}</td>
            <td><input type="number" class="ref-input" data-field="pedro_total" min="0" max="10" step="1" value="${ref?.pedro_total ?? ''}" style="width:4.5rem;"></td>
            <td style="font-size:.75rem;">${items ? `${items}/10 Items` : '–'}</td>
            <td><select class="ref-input" data-field="amstar2" style="width:9rem;"><option value="">–</option>${AMSTAR2_LEVELS.slice().reverse().map(l => `<option value="${l}" ${ref?.amstar2 === l ? 'selected' : ''}>${AMSTAR2_LABELS[l]}</option>`).join('')}</select></td>
            <td><input type="number" class="ref-input" data-field="casq" min="0" max="10" step="0.1" value="${ref?.casq ?? ''}" style="width:4.5rem;"></td>
        </tr>`;
    }).join('');
    const matchedKeys = new Set(docs.map(d => d.key));
    const orphans = refs.filter(r => !matchedKeys.has(r.key) && !(r.doi && docs.some(d => d.doi === r.doi)));
    return `<div style="overflow-x:auto;"><table class="integ-table"><thead><tr><th>Dokument</th><th>Bewertung der App</th><th>PEDro gesamt (Experte)</th><th>PEDro-Items</th><th>AMSTAR 2 (Experte)</th><th>CASQ (Experte)</th></tr></thead><tbody>${rows}</tbody></table></div>
        ${orphans.length ? `<div style="font-size:.8rem;color:var(--text-light);margin-top:.4rem;">${orphans.length} Referenz(en) ohne analysiertes Dokument: ${escapeHTML(orphans.map(o => o.name).slice(0, 6).join(', '))}${orphans.length > 6 ? ', …' : ''}. Sie werden verwendet, sobald das Dokument analysiert wurde.</div>` : ''}`;
}

function readReferenceRow(tr, existing) {
    const num = (field, max) => {
        const raw = tr.querySelector(`[data-field="${field}"]`).value.trim();
        if (raw === '') return null;
        const v = Number(raw.replace(',', '.'));
        return Number.isFinite(v) && v >= 0 && v <= max ? v : null;
    };
    const ref = existing ? { ...existing } : emptyRef(tr.dataset.key, tr.dataset.name);
    ref.pedro_total = num('pedro_total', 10);
    ref.casq = num('casq', 10);
    ref.amstar2 = tr.querySelector('[data-field="amstar2"]').value || null;
    return ref;
}

async function onReferenceEdited(event) {
    const tr = event.target.closest('tr[data-key]');
    if (!tr || !currentUser) return;
    const key = tr.dataset.key;
    const existing = reliabilityData.refs.find(r => r.key === key) || (reliabilityData.studies.find(s => s.key === key)?.doi && reliabilityData.refs.find(r => r.doi === reliabilityData.studies.find(s => s.key === key).doi)) || null;
    const ref = readReferenceRow(tr, existing);
    clearTimeout(refSaveTimers[key]);
    refSaveTimers[key] = setTimeout(async () => {
        const empty = ref.pedro_total === null && ref.casq === null && !ref.amstar2 && !Object.keys(ref.pedro_items || {}).length;
        if (empty) await deleteReference(currentUser, ref.key); else await putReference(currentUser, ref);
        reliabilityData.refs = await listReferences(currentUser);
        renderAgreement();
    }, 400);
}

// ---------- Tab: CSV ----------
async function importReferenceCsv(fileList) {
    const file = fileList && fileList[0];
    document.getElementById('ref-csv-input').value = '';
    const msg = document.getElementById('ref-message');
    if (!file) return;
    const { rows, errors } = parseExpertCsv(await file.text());
    let saved = 0;
    for (const row of rows) {
        const { name, ...rest } = row;
        await putReference(currentUser, { ...rest, name });
        saved++;
    }
    const matched = resolveReferences(reliabilityData.studies, rows).size;
    msg.className = `model-search-status ${errors.length && !saved ? 'err' : 'ok'}`;
    msg.innerHTML = `${saved} Referenz(en) übernommen, davon ${matched} zu bereits analysierten Dokumenten passend.`
        + (errors.length ? `<br><span style="color:#b45309;">${errors.length} Hinweis(e): ${escapeHTML(errors.slice(0, 5).join(' · '))}${errors.length > 5 ? ' …' : ''}</span>` : '');
    await loadReliability();
}

function downloadReferenceTemplate() {
    const titles = latestPerDocument(reliabilityData.studies).map(s => s.title);
    const blob = new Blob([buildTemplateCsv(titles.length ? titles : ['beispiel.pdf'])], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'expertenbewertungen-vorlage.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- Tab: Auswertung ----------
function agreementTable(rows) {
    return `<table class="integ-table"><thead><tr><th>Maß</th><th>Wert</th><th>95-%-Intervall</th><th>Einordnung</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r[0]}</td><td><strong>${r[1]}</strong></td><td>${r[2] || ''}</td><td>${r[3] || ''}</td></tr>`).join('')}</tbody></table>`;
}

function numericBlock(title, a, unit) {
    if (!a) return '';
    return `<h4 style="margin:.8rem 0 .3rem;">${title} <span style="font-weight:normal;color:var(--text-light);">(n = ${a.n} Dokumente)</span></h4>
        ${agreementTable([
            ['Mittlere absolute Abweichung', `${fmt(a.mae)} ${unit}`, fmtCI(a.ci?.mae), `${pctText(a.within_share)} liegen innerhalb ±${a.within} ${unit}`],
            ['Systematische Abweichung (App − Experte)', `${a.bias >= 0 ? '+' : ''}${fmt(a.bias)}`, (a.n >= 3 ? `Übereinstimmungsgrenzen ${fmt(a.loa[0])} bis ${fmt(a.loa[1])}` : 'Grenzen erst ab 3 Dokumenten'), a.bias > 0.5 ? 'App bewertet eher höher' : a.bias < -0.5 ? 'App bewertet eher niedriger' : 'kein deutlicher Trend'],
            ['Korrelation (Pearson r)', fmt(a.r), '', ''],
            ['ICC(2,1) – absolute Übereinstimmung', fmt(a.icc), fmtCI(a.ci?.icc), interpretICC(a.icc)]
        ])}
        ${sampleSizeWarning(a.n) ? `<div class="vision-hint no">${escapeHTML(sampleSizeWarning(a.n))}</div>` : ''}`;
}

function categoricalBlock(title, a, kappaLabel, extra = '') {
    if (!a) return '';
    return `<h4 style="margin:.8rem 0 .3rem;">${title} <span style="font-weight:normal;color:var(--text-light);">(${a.n} Vergleiche)</span></h4>
        ${agreementTable([
            ['Übereinstimmung', pctText(a.exact_agreement), '', ''],
            [kappaLabel, fmt(a.kappa), fmtCI(a.ci), interpretKappa(a.kappa)],
            ...(a.pabak !== null && a.pabak !== undefined ? [['PABAK (gleicht ungleiche Verteilung aus)', fmt(a.pabak), '', interpretKappa(a.pabak)]] : [])
        ])}${extra}`;
}

function renderAgreementForModel(model, studies, refs) {
    const resolved = resolveReferences(studies, refs);
    const cmp = compareWithReferences(studies, resolved);
    const body = [
        numericBlock('PEDro-Gesamtwert (0–10)', cmp.pedro_total, 'Punkte'),
        categoricalBlock('PEDro-Items 2–11 (erfüllt / nicht erfüllt)', cmp.pedro_items, 'Cohens κ', cmp.pedro_items ? `<details style="margin-top:.4rem;"><summary style="cursor:pointer;font-size:.85rem;">Je Item</summary><table class="integ-table"><thead><tr><th>Item</th><th>Vergleiche</th><th>Übereinstimmung</th><th>κ</th></tr></thead><tbody>${cmp.pedro_item_detail.map(d => `<tr><td>${d.id}</td><td>${d.n}</td><td>${pctText(d.agreement)}</td><td>${d.kappa === null ? '–' : fmt(d.kappa)}</td></tr>`).join('')}</tbody></table></details>` : ''),
        categoricalBlock('AMSTAR 2 (Gesamtvertrauen)', cmp.amstar2, 'Gewichtetes κ (linear)'),
        numericBlock('CASQ (interner Index, Experten-CASQ)', cmp.casq, 'Punkte')
    ].join('');
    return `<div class="integ-box" style="background:#f8fafc;border-color:var(--border);border-left-color:var(--primary);">
        <div style="font-size:.72rem;color:var(--primary);font-weight:700;">MODELL</div>
        <div style="font-size:1.05rem;font-weight:700;">${escapeHTML(model)} <span style="font-weight:normal;font-size:.85rem;color:var(--text-light);">· ${cmp.documents.length} Dokument(e) mit Referenz</span></div>
        ${body || '<div style="font-size:.85rem;color:var(--text-light);margin-top:.4rem;">Noch nichts vergleichbar: Für dieses Modell gibt es keine Dokumente mit passender Referenzbewertung (PEDro-Studien brauchen PEDro-Werte, Reviews AMSTAR 2).</div>'}
    </div>`;
}

function renderAgreement() {
    const el = document.getElementById('agreement-results');
    if (!el) return;
    const { studies, refs } = reliabilityData;
    if (!refs.length) { el.innerHTML = '<p style="font-size:.9rem;color:var(--text-light);">Noch keine Referenzbewertungen. Tragen Sie oben Werte ein oder importieren Sie eine CSV-Datei.</p>'; return; }
    const models = [...new Set(studies.map(s => s.model))];
    el.innerHTML = models.map(model => renderAgreementForModel(model, latestPerDocument(studies.filter(s => s.model === model)), refs)).join('')
        || '<p style="font-size:.9rem;color:var(--text-light);">Noch keine analysierten Dokumente.</p>';
}

function renderRepeatResults() {
    const el = document.getElementById('repeat-results');
    if (!el) return;
    const withRel = reliabilityData.studies.filter(s => s.reliability?.casq || s.reliability?.established);
    if (!withRel.length) { el.innerHTML = '<p style="font-size:.9rem;color:var(--text-light);">Noch keine Mehrfachbewertungen. Auf dem Dashboard „Durchläufe je PDF“ auf 3 oder 5 stellen und analysieren.</p>'; return; }
    const rows = withRel.slice(0, 40).map(s => {
        const c = s.reliability.casq;
        return `<tr><td style="max-width:14rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHTML(s.title)}">${escapeHTML(s.title)}</td><td>${escapeHTML(s.model)}</td><td>${s.reliability.runs_requested}</td>
            <td>${c ? c.scores.map(v => v === null ? '–' : fmt(v, 1)).join(' · ') : '–'}</td><td>${c ? fmt(c.sd, 2) : '–'}</td>
            <td>${c ? pctText(c.agreement) : '–'}</td><td>${c ? (c.fleiss === null ? '–' : fmt(c.fleiss)) : '–'}</td><td>${c ? c.uncertain.length : '–'}</td>
            <td>${s.reliability.established ? pctText(s.reliability.established.agreement) : '–'}</td></tr>`;
    }).join('');
    const withCasq = withRel.filter(s => s.reliability.casq);
    const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    el.innerHTML = `<div style="font-size:.85rem;margin-bottom:.4rem;">${withCasq.length} Dokument(e) · Ø Übereinstimmung der Prüffragen ${pctText(mean(withCasq.map(s => s.reliability.casq.agreement)))} · Ø Standardabweichung des CASQ ${fmt(mean(withCasq.map(s => s.reliability.casq.sd)), 2)}</div>
        <div style="overflow-x:auto;"><table class="integ-table"><thead><tr><th>Dokument</th><th>Modell</th><th>Läufe</th><th>CASQ je Durchlauf</th><th>SD</th><th>Prüffragen einig</th><th>Fleiss-κ</th><th>Unsichere</th><th>Items (Instrument)</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function loadReliability() {
    if (!currentUser) return;
    const [studies, refs] = await Promise.all([collectStudiesForReliability(currentUser), listReferences(currentUser)]);
    reliabilityData = { studies, refs };
    document.getElementById('ref-table').innerHTML = renderReferenceTable(studies, refs);
    renderAgreement();
    renderRepeatResults();
}

document.addEventListener('input', e => { if (e.target.classList?.contains('ref-input')) onReferenceEdited(e); });
document.addEventListener('change', e => { if (e.target.classList?.contains('ref-input')) onReferenceEdited(e); });
