// ==========================================
// ZEITSCHRIFTENKONTEXT
// ==========================================
// Zusatzinformation zur Publikation (VHB-Rating, ABDC, FT50, SJR). Sie geht NIE in den CASQ ein: Ein methodisch schwacher
// Artikel kann in einem Spitzenjournal stehen und umgekehrt. Die Werte stammen ausschließlich aus der Liste, die der Nutzer
// aus den offiziellen Quellen importiert; die App schreibt keine Ratings aus dem Gedächtnis ab und prüft sie nicht.
// Die Funktionen sind rein und in Node testbar.

const JOURNAL_COLUMNS = ['zeitschrift', 'issn', 'issn_2', 'vhb', 'abdc', 'ft50', 'sjr', 'sjr_quartil', 'bemerkung'];

function journalHeaderKey(h) {
    return String(h || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
}

// Vergleichsform eines Zeitschriftennamens: ohne Großschreibung, Akzente, Satzzeichen und führendes „The“.
function normalizeJournalName(name) {
    return String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/&/g, ' and ').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeIssn(value) {
    const m = String(value || '').match(/(\d{4})\s*-?\s*(\d{3}[\dxX])/);
    return m ? `${m[1]}-${m[2].toUpperCase()}` : null;
}

// ISSN nur nach dem Wort „ISSN“ (auch e-ISSN, ISSN (print)), damit keine beliebigen Zahlen erkannt werden.
function extractIssns(text) {
    const found = new Set();
    const re = /ISSN\s*(?:\((?:print|online|electronic)\)\s*)?[:\s]*([0-9]{4}\s*-?\s*[0-9]{3}[0-9xX])/gi;
    let m;
    while ((m = re.exec(String(text || ''))) !== null) {
        const issn = normalizeIssn(m[1]);
        if (issn) found.add(issn);
    }
    return [...found];
}

function normalizeFt50(value) {
    const v = String(value ?? '').trim().toLowerCase();
    if (['ja', 'yes', 'y', 'true', 'x', '1', 'ft50'].includes(v)) return 'ja';
    if (['nein', 'no', 'n', 'false', '0', '-'].includes(v)) return 'nein';
    return '';
}

// Liefert { rows: [{ name, issn, issn2, vhb, abdc, ft50, sjr, sjr_quartil, note }], errors: [...] }
function parseJournalCsv(text, parse = (typeof parseCSV === 'function' ? parseCSV : require('./reliability.js').parseCSV)) {
    const table = parse(text);
    const errors = [];
    if (table.length < 2) return { rows: [], errors: ['Die Datei enthält keine Datenzeilen.'] };
    const headers = table[0].map(journalHeaderKey);
    const col = names => headers.findIndex(h => names.includes(h));
    const cName = col(['zeitschrift', 'journal', 'name', 'titel', 'journaltitle', 'zeitschriftentitel', 'title']);
    const cIssn = col(['issn', 'issnprint', 'pissn']);
    const cIssn2 = col(['issn2', 'eissn', 'issnonline', 'issnelektronisch']);
    const cVhb = col(['vhb', 'vhb2024', 'vhbrating', 'vhbpmr', 'vhbpublicationmediarating2024']);
    const cAbdc = col(['abdc', 'abdc2025', 'abdcrating']);
    const cFt = col(['ft50', 'ft', 'financialtimes50']);
    const cSjr = col(['sjr', 'sjrwert', 'sjrscore', 'sjrindicator']);
    const cQuart = col(['sjrquartil', 'quartil', 'quartile', 'sjrq', 'sjrquartile']);
    const cNote = col(['bemerkung', 'note', 'notiz', 'kommentar', 'anmerkung']);
    if (cName < 0 && cIssn < 0) return { rows: [], errors: ['Es fehlt die Spalte „zeitschrift“ (oder „issn“).'] };

    const rows = [];
    const seen = new Set();
    table.slice(1).forEach((r, i) => {
        const cell = c => (c >= 0 ? String(r[c] ?? '').trim() : '');
        const name = cell(cName);
        const issn = normalizeIssn(cell(cIssn));
        const issn2 = normalizeIssn(cell(cIssn2));
        if (!name && !issn) { errors.push(`Zeile ${i + 2}: weder Zeitschrift noch ISSN angegeben.`); return; }
        if (cIssn >= 0 && cell(cIssn) && !issn) errors.push(`Zeile ${i + 2}: ISSN „${cell(cIssn)}“ ist ungültig (erwartet 1234-567X).`);
        const dedupe = `${normalizeJournalName(name)}|${issn || ''}`;
        if (seen.has(dedupe)) { errors.push(`Zeile ${i + 2}: „${name || issn}“ kommt doppelt vor, die erste Zeile gilt.`); return; }
        seen.add(dedupe);
        rows.push({ name, issn, issn2, vhb: cell(cVhb), abdc: cell(cAbdc), ft50: normalizeFt50(cell(cFt)), sjr: cell(cSjr), sjr_quartil: cell(cQuart), note: cell(cNote) });
    });
    return { rows, errors };
}

function buildJournalTemplateCsv() {
    return ['zeitschrift;issn;issn_2;vhb;abdc;ft50;sjr;sjr_quartil;bemerkung',
        'Beispiel: Journal of Marketing;0022-2429;1547-7185;;;;;;Werte aus den offiziellen Listen eintragen und diese Zeile löschen'].join('\r\n') + '\r\n';
}

function journalCsvCell(value) {
    const text = String(value ?? '');
    return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Zeitschriften aus bereits ausgewerteten Studien (Zeitschriftenkontext, sonst Crossref bzw. Extraktion), ohne Doppelte.
function collectJournalsFromStudies(studies) {
    const found = [];
    const add = ({ name, issns }) => {
        const key = normalizeJournalName(name);
        const hit = found.find(f => (key && f.key === key) || issns.some(i => f.issns.includes(i)));
        if (hit) {
            if (!hit.name && name) { hit.name = name; hit.key = key; }
            issns.forEach(i => { if (!hit.issns.includes(i)) hit.issns.push(i); });
        } else if (name || issns.length) found.push({ name: name || '', key, issns: [...issns] });
    };
    for (const r of studies || []) {
        const ctx = r?.journal_context || journalContext([], { crossref: r?.integrity?.online ? { journal: r.integrity.online.journal, issn: r.integrity.online.issn || [] } : null, textIssns: [], llmName: r?.extraction?.publication_venue || '' });
        if (ctx.venue_name || ctx.issns?.length) add({ name: ctx.venue_name || '', issns: ctx.issns || [] });
    }
    return found.map(f => ({ name: f.name, issn: f.issns[0] || '', issn2: f.issns[1] || '' }));
}

// Vorlage für den Import: Ihre bisherige Liste (mit allen Werten) plus die in Auswertungen erkannten Zeitschriften, die noch fehlen.
// Neue Zeilen enthalten nur Name und ISSN; die Ratings tragen Sie aus den offiziellen Listen nach.
function buildJournalTemplateFromStudies(existingRows, studies) {
    const rows = [...(existingRows || [])];
    let added = 0;
    for (const j of collectJournalsFromStudies(studies)) {
        const known = findJournal(rows, { names: [j.name], issns: [j.issn, j.issn2].filter(Boolean) });
        if (known) continue;
        rows.push({ name: j.name, issn: j.issn || null, issn2: j.issn2 || null, vhb: '', abdc: '', ft50: '', sjr: '', sjr_quartil: '', note: '' });
        added++;
    }
    if (!rows.length) return { csv: buildJournalTemplateCsv(), added: 0, total: 0 };
    const header = 'zeitschrift;issn;issn_2;vhb;abdc;ft50;sjr;sjr_quartil;bemerkung';
    const lines = rows.map(r => [r.name, r.issn, r.issn2, r.vhb, r.abdc, r.ft50, r.sjr, r.sjr_quartil, r.note].map(journalCsvCell).join(';'));
    return { csv: [header, ...lines].join('\r\n') + '\r\n', added, total: rows.length };
}

// Sucht die Zeitschrift in der Liste: erst über die ISSN (eindeutig), dann über den normalisierten Namen.
function findJournal(rows, { names = [], issns = [] } = {}) {
    const wantedIssns = new Set(issns.map(normalizeIssn).filter(Boolean));
    if (wantedIssns.size) {
        const row = rows.find(r => (r.issn && wantedIssns.has(r.issn)) || (r.issn2 && wantedIssns.has(r.issn2)));
        if (row) return { row, by: 'ISSN' };
    }
    for (const name of names) {
        const key = normalizeJournalName(name);
        if (!key) continue;
        const row = rows.find(r => normalizeJournalName(r.name) === key);
        if (row) return { row, by: 'Name' };
    }
    return null;
}

// Bestimmt die Zeitschrift (Crossref vor PDF-Text vor Extraktion) und ordnet sie der Liste zu.
//   candidates: { crossref: { journal, issn: [] } | null, textIssns: [], llmName: string }
function journalContext(rows, { crossref = null, textIssns = [], llmName = '' } = {}) {
    const cleanLlm = /^(not_reported|unknown|unclear|n\/a|-)?$/i.test(String(llmName || '').trim()) ? '' : String(llmName).trim();
    const crossrefName = String(crossref?.journal || '').trim();
    const venue = crossrefName || cleanLlm || '';
    const issns = [...new Set([...(crossref?.issn || []), ...textIssns].map(normalizeIssn).filter(Boolean))];
    const source = crossrefName ? 'Crossref' : cleanLlm ? 'Extraktion aus dem PDF' : issns.length ? 'ISSN im PDF-Text' : null;
    const base = { venue_name: venue || null, issns, source, list_size: rows.length, match: null };
    if (!venue && !issns.length) return { ...base, status: 'unknown_venue' };
    if (!rows.length) return { ...base, status: 'no_list' };
    const hit = findJournal(rows, { names: [crossrefName, cleanLlm].filter(Boolean), issns });
    if (!hit) return { ...base, status: 'not_in_list' };
    return { ...base, status: 'matched', match: { by: hit.by, ...hit.row } };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { JOURNAL_COLUMNS, normalizeJournalName, normalizeIssn, extractIssns, normalizeFt50, parseJournalCsv, buildJournalTemplateCsv, collectJournalsFromStudies, buildJournalTemplateFromStudies, findJournal, journalContext };
}
