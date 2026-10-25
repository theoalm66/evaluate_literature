// ==========================================
// ZUVERLÄSSIGKEIT: Mehrfachbewertung und Abgleich mit Expertenbewertungen
// ==========================================
// Reine Rechenfunktionen (kein DOM, keine Netzzugriffe), in Node testbar.
//   1. Mehrfachbewertung: dieselbe Bewertung k-mal erzeugen → Mehrheitsentscheid je Frage, Übereinstimmung der
//      Durchläufe (Anteil, Fleiss-Kappa), Streuung des Scores. Unsichere Fragen werden benannt.
//   2. Abgleich mit Experten: Übereinstimmung der App-Bewertung mit Referenzbewertungen (z.B. PEDro-Datenbank):
//      Zahlen (PEDro-Summe, CASQ): Abweichung, Bias, Korrelation, ICC(2,1), Bland-Altman;
//      Kategorien (PEDro-Items, AMSTAR 2): Cohen-Kappa (bei AMSTAR 2 linear gewichtet), PABAK, Anteil Übereinstimmung.
//      Konfidenzintervalle per Bootstrap (festes Seed → reproduzierbar).

// ---------- Grundlagen ----------
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const sampleSd = a => a.length < 2 ? 0 : Math.sqrt(a.reduce((s, v) => s + (v - mean(a)) ** 2, 0) / (a.length - 1));
const median = a => { const s = [...a].sort((x, y) => x - y), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function seededRandom(seed = 12345) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Percentile-Bootstrap: statFn bekommt die neu gezogene Stichprobe und liefert eine Zahl oder null
function bootstrapCI(items, statFn, { iterations = 1000, seed = 20260101, alpha = 0.05 } = {}) {
    if (items.length < 3) return null;
    const rand = seededRandom(seed);
    const values = [];
    for (let i = 0; i < iterations; i++) {
        const sample = Array.from({ length: items.length }, () => items[Math.floor(rand() * items.length)]);
        const v = statFn(sample);
        if (v !== null && v !== undefined && Number.isFinite(v)) values.push(v);
    }
    if (values.length < iterations * 0.5) return null;
    values.sort((a, b) => a - b);
    const at = q => values[Math.min(values.length - 1, Math.max(0, Math.floor(q * values.length)))];
    return [at(alpha / 2), at(1 - alpha / 2)];
}

// ---------- Kategoriale Übereinstimmung ----------
// pairs: [[a, b], …] mit beliebigen Beschriftungen; ordered/categories → linear gewichtetes Kappa
function cohenKappa(pairs, { categories = null, weighted = false } = {}) {
    const n = pairs.length;
    if (!n) return { kappa: null, observed: null, expected: null, n: 0 };
    const cats = categories || [...new Set(pairs.flat())];
    const idx = new Map(cats.map((c, i) => [c, i]));
    const c = cats.length;
    const rows = new Array(c).fill(0), cols = new Array(c).fill(0);
    const table = Array.from({ length: c }, () => new Array(c).fill(0));
    for (const [a, b] of pairs) {
        const i = idx.get(a), j = idx.get(b);
        if (i === undefined || j === undefined) continue;
        table[i][j]++; rows[i]++; cols[j]++;
    }
    const total = rows.reduce((x, y) => x + y, 0);
    if (!total) return { kappa: null, observed: null, expected: null, n: 0 };
    const w = (i, j) => weighted && c > 1 ? 1 - Math.abs(i - j) / (c - 1) : (i === j ? 1 : 0);
    let po = 0, pe = 0;
    for (let i = 0; i < c; i++) for (let j = 0; j < c; j++) {
        po += w(i, j) * table[i][j] / total;
        pe += w(i, j) * (rows[i] / total) * (cols[j] / total);
    }
    // Ohne jede Variation (alle in einer Kategorie) ist Kappa nicht definiert
    const kappa = 1 - pe < 1e-12 ? (po > 1 - 1e-12 ? null : 0) : (po - pe) / (1 - pe);
    const exact = table.reduce((s, row, i) => s + row[i], 0) / total;
    return { kappa, observed: po, expected: pe, exact_agreement: exact, n: total };
}

// Fleiss-Kappa: counts[i][j] = Anzahl der Bewerter, die Gegenstand i der Kategorie j zuordnen (feste Bewerterzahl)
function fleissKappa(counts) {
    const N = counts.length;
    if (!N) return null;
    const n = counts[0].reduce((a, b) => a + b, 0);
    if (n < 2) return null;
    const cats = counts[0].length;
    const pj = new Array(cats).fill(0);
    let pBar = 0;
    for (const row of counts) {
        let sumSq = 0;
        row.forEach((v, j) => { pj[j] += v; sumSq += v * v; });
        pBar += (sumSq - n) / (n * (n - 1));
    }
    pBar /= N;
    const pe = pj.reduce((s, v) => s + (v / (N * n)) ** 2, 0);
    return 1 - pe < 1e-12 ? null : (pBar - pe) / (1 - pe);
}

// ---------- Kontinuierliche Übereinstimmung ----------
function pearson(x, y) {
    if (x.length < 3) return null;
    const mx = mean(x), my = mean(y);
    let sxy = 0, sxx = 0, syy = 0;
    x.forEach((v, i) => { sxy += (v - mx) * (y[i] - my); sxx += (v - mx) ** 2; syy += (y[i] - my) ** 2; });
    return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

// ICC(2,1): zweifaktoriell, zufällige Bewerter, absolute Übereinstimmung, Einzelmessung (Shrout & Fleiss 1979)
function icc21(matrix) {
    const n = matrix.length, k = n ? matrix[0].length : 0;
    if (n < 2 || k < 2) return null;
    const all = matrix.flat();
    const grand = mean(all);
    const rowMeans = matrix.map(r => mean(r));
    const colMeans = Array.from({ length: k }, (_, j) => mean(matrix.map(r => r[j])));
    const ssr = k * rowMeans.reduce((s, m) => s + (m - grand) ** 2, 0);
    const ssc = n * colMeans.reduce((s, m) => s + (m - grand) ** 2, 0);
    const sst = all.reduce((s, v) => s + (v - grand) ** 2, 0);
    const sse = sst - ssr - ssc;
    const msr = ssr / (n - 1), msc = ssc / (k - 1), mse = sse / ((n - 1) * (k - 1));
    const denom = msr + (k - 1) * mse + k * (msc - mse) / n;
    return Math.abs(denom) < 1e-12 ? null : (msr - mse) / denom;
}

function blandAltman(pairs) {
    const diffs = pairs.map(([a, b]) => a - b);
    const bias = mean(diffs), sd = sampleSd(diffs);
    return { bias, sd, loa_low: bias - 1.96 * sd, loa_high: bias + 1.96 * sd };
}

// pairs: [[App, Experte], …] auf einer Zahlenskala
function numericAgreement(pairs, { within = 1 } = {}) {
    const n = pairs.length;
    if (!n) return { n: 0 };
    const diffs = pairs.map(([a, b]) => a - b);
    const ba = blandAltman(pairs);
    const mae = mean(diffs.map(Math.abs));
    const icc = icc21(pairs);
    const r = pearson(pairs.map(p => p[0]), pairs.map(p => p[1]));
    return {
        n, mae, rmse: Math.sqrt(mean(diffs.map(d => d * d))), bias: ba.bias, sd_diff: ba.sd, loa: [ba.loa_low, ba.loa_high],
        r, icc, within_share: diffs.filter(d => Math.abs(d) <= within).length / n, within,
        ci: n >= 5 ? { mae: bootstrapCI(pairs, s => mean(s.map(([a, b]) => Math.abs(a - b)))), icc: bootstrapCI(pairs, icc21) } : null
    };
}

function categoricalAgreement(pairs, { categories = null, weighted = false } = {}) {
    const base = cohenKappa(pairs, { categories, weighted });
    const binary = (categories || [...new Set(pairs.flat())]).length === 2;
    return {
        ...base, weighted,
        // PABAK gleicht das Kappa-Paradox bei sehr ungleich verteilten Antworten aus (nur für zwei Kategorien)
        pabak: binary && base.observed !== null ? 2 * base.observed - 1 : null,
        ci: pairs.length >= 5 ? bootstrapCI(pairs, s => cohenKappa(s, { categories, weighted }).kappa) : null
    };
}

// ---------- Deutung ----------
function interpretKappa(k) {
    if (k === null || k === undefined || Number.isNaN(k)) return 'nicht berechenbar';
    if (k < 0) return 'schlechter als Zufall';
    if (k <= 0.20) return 'gering';
    if (k <= 0.40) return 'mäßig';
    if (k <= 0.60) return 'moderat';
    if (k <= 0.80) return 'substanziell';
    return 'nahezu perfekt';
}

function interpretICC(i) {
    if (i === null || i === undefined || Number.isNaN(i)) return 'nicht berechenbar';
    if (i < 0.5) return 'schlecht';
    if (i < 0.75) return 'mäßig';
    if (i < 0.9) return 'gut';
    return 'ausgezeichnet';
}

function sampleSizeWarning(n) {
    if (n < 5) return 'Weniger als 5 Dokumente: Die Werte sind nur Anhaltspunkte, keine belastbare Aussage.';
    if (n < 30) return `Nur ${n} Dokumente: Die Konfidenzintervalle sind breit. Für eine belastbare Aussage über die Zuverlässigkeit werden 30–50 doppelt bewertete Dokumente empfohlen.`;
    return '';
}

// ---------- Mehrfachbewertung ----------
const TIE_ORDER = ['no', 'not_reported', 'partial', 'yes', 'not_applicable'];   // bei Gleichstand die vorsichtigere Antwort

function majority(values, tieOrder = TIE_ORDER) {
    const counts = {};
    values.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
    const max = Math.max(...Object.values(counts));
    const tied = Object.keys(counts).filter(k => counts[k] === max);
    const winner = tied.sort((a, b) => (tieOrder.indexOf(a) + 1 || 99) - (tieOrder.indexOf(b) + 1 || 99))[0];
    return { value: winner, votes: counts, share: max / values.length, unanimous: tied.length === 1 && max === values.length };
}

function scoreSpread(scores) {
    const valid = scores.filter(v => Number.isFinite(v));
    if (!valid.length) return { scores, median: null, min: null, max: null, sd: null };
    return { scores, median: median(valid), min: Math.min(...valid), max: Math.max(...valid), sd: sampleSd(valid) };
}

function fleissFromVotes(votesPerItem, categories) {
    const counts = votesPerItem.map(v => categories.map(c => v[c] || 0));
    return fleissKappa(counts);
}

// runs: Array je Durchlauf von Antworten [{id, response, evidence, rationale}]; ids: erwartete Prüffragen
function aggregateChecklistRuns(runs, ids, normalize = r => String(r || 'not_reported')) {
    const cats = ['yes', 'partial', 'no', 'not_reported', 'not_applicable'];
    const merged = [], uncertain = [], votesPerItem = [];
    for (const id of ids) {
        const answers = runs.map(run => (run || []).find(a => a && a.id === id) || null);
        const normalized = answers.map(a => normalize(a?.response));
        const m = majority(normalized);
        votesPerItem.push(m.votes);
        const source = answers.find((a, i) => a && normalized[i] === m.value) || answers.find(Boolean);
        if (!source) continue;
        merged.push({ ...source, id, response: m.value,
            rationale: `${source.rationale || ''}${source.rationale ? ' ' : ''}[Mehrheit ${Math.round(m.share * runs.length)}/${runs.length}]`.trim(),
            votes: m.votes, agreement: m.share });
        if (!m.unanimous) uncertain.push({ id, votes: m.votes, chosen: m.value });
    }
    const shares = merged.map(m => m.agreement);
    return {
        merged,
        agreement: shares.length ? mean(shares) : null,
        unanimous_share: merged.length ? merged.filter(m => m.agreement === 1).length / merged.length : null,
        fleiss: runs.length >= 2 ? fleissFromVotes(votesPerItem, cats) : null,
        uncertain
    };
}

// runs: established_appraisal-Objekte je Durchlauf. Der Durchlauf, dessen Instrument die Mehrheit hat, bildet die
// Grundlage; Antworten je Item werden per Mehrheit (Antwort + Punkte) ersetzt.
function aggregateEstablishedRuns(runs) {
    const usable = runs.filter(r => r && r.applicable && r.instrument && r.instrument !== 'none');
    if (!usable.length) return { merged: runs[0] || null, agreement: null, fleiss: null, uncertain: [], instrument: runs[0]?.instrument || 'none', applicable_runs: 0 };
    const instrument = majority(usable.map(r => r.instrument), []).value;
    const same = usable.filter(r => r.instrument === instrument);
    const base = same[0];
    const itemKey = it => `${String(it.response ?? '')}|${it.points ?? ''}`;
    const items = [], uncertain = [], votesPerItem = [];
    for (const item of base.items || []) {
        const id = String(item.item_id);
        const found = same.map(r => (r.items || []).find(x => String(x.item_id) === id) || null);
        const m = majority(found.map(f => f ? itemKey(f) : 'fehlt|'), []);
        votesPerItem.push(m.votes);
        const source = found.find(f => f && itemKey(f) === m.value) || item;
        items.push({ ...source, item_id: item.item_id, votes: m.votes, agreement: m.share });
        if (!m.unanimous) uncertain.push({ item_id: id, votes: m.votes, chosen: m.value });
    }
    const keys = [...new Set(votesPerItem.flatMap(v => Object.keys(v)))];
    return {
        merged: { ...base, items },
        instrument,
        applicable_runs: same.length,
        agreement: items.length ? mean(items.map(i => i.agreement)) : null,
        fleiss: same.length >= 2 && keys.length ? fleissFromVotes(votesPerItem, keys) : null,
        uncertain
    };
}

// ---------- Referenzbewertungen (Experten) ----------
const PEDRO_ITEM_IDS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', '11'];
const AMSTAR2_LEVELS = ['critically_low', 'low', 'moderate', 'high'];
const AMSTAR2_LABELS = { critically_low: 'Critically low', low: 'Low', moderate: 'Moderate', high: 'High' };

function normalizeAmstar2(value) {
    const v = String(value ?? '').toLowerCase().trim().replace(/[\s-]+/g, '_');
    if (!v) return null;
    if (['high', 'hoch'].includes(v)) return 'high';
    if (['moderate', 'moderat', 'mittel'].includes(v)) return 'moderate';
    if (['low', 'niedrig', 'gering'].includes(v)) return 'low';
    if (['critically_low', 'kritisch_niedrig', 'kritisch', 'criticallylow'].includes(v)) return 'critically_low';
    return null;
}

function normalizeYesNoRef(value) {
    const v = String(value ?? '').toLowerCase().trim();
    if (['yes', 'y', 'ja', 'j', '1', 'true', 'wahr', 'x'].includes(v)) return 'yes';
    if (['no', 'n', 'nein', '0', 'false', 'falsch'].includes(v)) return 'no';
    return null;
}

function normalizeDocKey(name) {
    return String(name || '').split(/[\\/]/).pop().toLowerCase().replace(/\.pdf$/i, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

// Bewertung der App aus einer fertigen Studie: established = Ergebnis von calculateEstablishedResult()
function agentAssessment(established, casqScore) {
    const out = { pedro: null, amstar2: null, casq: Number.isFinite(Number(casqScore)) && casqScore !== null ? Number(casqScore) : null };
    if (established?.applicable && established.instrument === 'PEDro Scale') {
        const items = {};
        PEDRO_ITEM_IDS.forEach(id => {
            const it = (established.items || []).find(x => String(x.item_id).trim() === id);
            items[id] = it && String(it.response).toLowerCase() === 'yes' ? 'yes' : 'no';   // nicht berichtet = nicht erfüllt (PEDro-Regel)
        });
        out.pedro = { total: established.score, items };
    }
    if (established?.applicable && established.instrument === 'AMSTAR 2') out.amstar2 = normalizeAmstar2(established.rating);
    return out;
}

// CSV (Trennzeichen ; , oder Tab, Anführungszeichen, UTF-8-BOM)
function parseCSV(text) {
    const src = String(text || '').replace(/^﻿/, '');
    const firstLine = src.split(/\r?\n/, 1)[0] || '';
    const delim = [';', '\t', ','].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (quoted) {
            if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
            else if (ch === '"') quoted = false;
            else cell += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === delim) { row.push(cell); cell = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && src[i + 1] === '\n') i++;
            row.push(cell); cell = '';
            if (row.some(c => c.trim() !== '')) rows.push(row);
            row = [];
        } else cell += ch;
    }
    row.push(cell);
    if (row.some(c => c.trim() !== '')) rows.push(row);
    return rows;
}

function headerKey(h) {
    return String(h || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
}

// Liefert { rows: [{ key, name, doi, pedro_total, pedro_items, amstar2, casq }], errors: [...] }
function parseExpertCsv(text) {
    const table = parseCSV(text);
    const errors = [];
    if (table.length < 2) return { rows: [], errors: ['Die Datei enthält keine Datenzeilen.'] };
    const headers = table[0].map(headerKey);
    const col = names => headers.findIndex(h => names.includes(h));
    const cDoc = col(['dokument', 'document', 'datei', 'file', 'filename', 'dateiname', 'title', 'titel']);
    const cDoi = col(['doi']);
    const cTotal = col(['pedrogesamt', 'pedrototal', 'pedro', 'pedroscore', 'pedrosumme']);
    const cAmstar = col(['amstar2', 'amstar', 'amstar2rating', 'amstar2bewertung']);
    const cCasq = col(['casqexperte', 'casq', 'casqexpert']);
    const cItems = {};
    PEDRO_ITEM_IDS.forEach(id => { const c = col([`pedro${id}`, `item${id}`, `p${id}`]); if (c >= 0) cItems[id] = c; });
    if (cDoc < 0 && cDoi < 0) return { rows: [], errors: ['Es fehlt die Spalte „dokument“ (Dateiname oder Titel) bzw. „doi“.'] };

    const rows = [];
    table.slice(1).forEach((r, i) => {
        const line = i + 2;
        const name = (cDoc >= 0 ? r[cDoc] : '')?.trim() || '';
        const doi = (cDoi >= 0 ? r[cDoi] : '')?.trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '') || '';
        if (!name && !doi) return;
        const entry = { key: normalizeDocKey(name || doi), name: name || doi, doi, pedro_total: null, pedro_items: {}, amstar2: null, casq: null };
        if (cTotal >= 0 && (r[cTotal] ?? '').trim() !== '') {
            const v = Number(String(r[cTotal]).replace(',', '.'));
            if (Number.isFinite(v) && v >= 0 && v <= 10) entry.pedro_total = v; else errors.push(`Zeile ${line}: PEDro-Gesamtwert „${r[cTotal]}“ liegt nicht zwischen 0 und 10.`);
        }
        for (const [id, c] of Object.entries(cItems)) {
            const raw = (r[c] ?? '').trim();
            if (!raw) continue;
            const v = normalizeYesNoRef(raw);
            if (v) entry.pedro_items[id] = v; else errors.push(`Zeile ${line}: PEDro-Item ${id} „${raw}“ ist weder ja noch nein.`);
        }
        if (cAmstar >= 0 && (r[cAmstar] ?? '').trim() !== '') {
            const v = normalizeAmstar2(r[cAmstar]);
            if (v) entry.amstar2 = v; else errors.push(`Zeile ${line}: AMSTAR-2-Wert „${r[cAmstar]}“ unbekannt (High, Moderate, Low, Critically low).`);
        }
        if (cCasq >= 0 && (r[cCasq] ?? '').trim() !== '') {
            const v = Number(String(r[cCasq]).replace(',', '.'));
            if (Number.isFinite(v) && v >= 0 && v <= 10) entry.casq = v; else errors.push(`Zeile ${line}: CASQ-Wert „${r[cCasq]}“ liegt nicht zwischen 0 und 10.`);
        }
        // Fehlt der PEDro-Gesamtwert, aber alle zehn Items sind angegeben, ergibt er sich daraus
        if (entry.pedro_total === null && PEDRO_ITEM_IDS.every(id => entry.pedro_items[id])) {
            entry.pedro_total = PEDRO_ITEM_IDS.filter(id => entry.pedro_items[id] === 'yes').length;
        }
        rows.push(entry);
    });
    return { rows, errors };
}

function csvCell(v) {
    const s = String(v ?? '');
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Vorlage mit den eigenen Dokumenten (Semikolon: öffnet in deutschem Excel direkt in Spalten)
function buildTemplateCsv(titles) {
    const header = ['dokument', 'doi', 'pedro_gesamt', ...PEDRO_ITEM_IDS.map(id => `pedro_${id}`), 'amstar2', 'casq_experte'];
    return '﻿' + [header, ...titles.map(t => [t, ...new Array(header.length - 1).fill('')])].map(r => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

// ---------- Gesamtauswertung je Modell ----------
// studies: [{ key, model, agent: agentAssessment(...) }]; refs: Map key → Referenz
function compareWithReferences(studies, refs) {
    const numeric = { pedro: [], casq: [] };
    const pedroItemPairs = [], amstarPairs = [];
    const perItem = Object.fromEntries(PEDRO_ITEM_IDS.map(id => [id, []]));
    const documents = [];
    for (const s of studies) {
        const ref = refs.get(s.key);
        if (!ref) continue;
        const used = [];
        if (s.agent.pedro && ref.pedro_total !== null && ref.pedro_total !== undefined) { numeric.pedro.push([s.agent.pedro.total, ref.pedro_total]); used.push('PEDro'); }
        if (s.agent.casq !== null && ref.casq !== null && ref.casq !== undefined) { numeric.casq.push([s.agent.casq, ref.casq]); used.push('CASQ'); }
        if (s.agent.pedro) {
            let any = false;
            for (const id of PEDRO_ITEM_IDS) {
                const e = ref.pedro_items?.[id];
                if (!e) continue;
                pedroItemPairs.push([s.agent.pedro.items[id], e]); perItem[id].push([s.agent.pedro.items[id], e]); any = true;
            }
            if (any) used.push('PEDro-Items');
        }
        if (s.agent.amstar2 && ref.amstar2) { amstarPairs.push([s.agent.amstar2, ref.amstar2]); used.push('AMSTAR 2'); }
        if (used.length) documents.push({ key: s.key, compared: used });
    }
    return {
        documents,
        pedro_total: numeric.pedro.length ? numericAgreement(numeric.pedro) : null,
        casq: numeric.casq.length ? numericAgreement(numeric.casq) : null,
        pedro_items: pedroItemPairs.length ? categoricalAgreement(pedroItemPairs, { categories: ['yes', 'no'] }) : null,
        pedro_item_detail: PEDRO_ITEM_IDS.map(id => ({ id, n: perItem[id].length,
            agreement: perItem[id].length ? perItem[id].filter(([a, b]) => a === b).length / perItem[id].length : null,
            kappa: perItem[id].length >= 5 ? cohenKappa(perItem[id], { categories: ['yes', 'no'] }).kappa : null })),
        amstar2: amstarPairs.length ? categoricalAgreement(amstarPairs, { categories: AMSTAR2_LEVELS, weighted: true }) : null
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        mean, sampleSd, median, seededRandom, bootstrapCI, cohenKappa, fleissKappa, pearson, icc21, blandAltman,
        numericAgreement, categoricalAgreement, interpretKappa, interpretICC, sampleSizeWarning, majority, scoreSpread,
        aggregateChecklistRuns, aggregateEstablishedRuns, normalizeAmstar2, normalizeYesNoRef, normalizeDocKey, agentAssessment,
        parseCSV, parseExpertCsv, buildTemplateCsv, compareWithReferences, PEDRO_ITEM_IDS, AMSTAR2_LEVELS, AMSTAR2_LABELS
    };
}
