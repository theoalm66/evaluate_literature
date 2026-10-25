// ==========================================
// INTEGRITÄTSPRÜFUNG (rechnerisch, ohne LLM)
// ==========================================
// Prüft formale Auffälligkeiten direkt im PDF-Text:
//   - statcheck: berichtete p-Werte aus t, F, χ², r, z und Freiheitsgraden nachrechnen
//   - GRIM: passen Mittelwert und n bei ganzzahligen Daten überhaupt zusammen?
//   - Stichprobengrößen: welche N/n werden genannt?
//   - Registrierungsnummern (NCT, DRKS, PROSPERO, OSF, …)
//   - DOI; online zusätzlich Metadaten und Retractions/Corrections über Crossref
// Die Funktionen sind rein (außer der Crossref-Abfrage) und in Node testbar.

const ALPHA = 0.05;

// ---------- Verteilungsfunktionen ----------
function logGamma(x) {
    // Lanczos-Näherung (g = 7, n = 9)
    const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
        -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
    x -= 1;
    let a = c[0];
    const t = x + 7.5;
    for (let i = 1; i < 9; i++) a += c[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// Kettenbruch für die unvollständige Betafunktion (Numerical Recipes, betacf)
function betaContinuedFraction(a, b, x) {
    const MAX_ITER = 300, EPS = 3e-14, FPMIN = 1e-300;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAX_ITER; m++) {
        const m2 = 2 * m;
        let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
        d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
        c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
        d = 1 / d; h *= d * c;
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
        d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
        c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
        d = 1 / d;
        const del = d * c;
        h *= del;
        if (Math.abs(del - 1) < EPS) break;
    }
    return h;
}

// Regularisierte unvollständige Betafunktion I_x(a, b)
function regIncBeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    if (x < (a + 1) / (a + b + 2)) return front * betaContinuedFraction(a, b, x) / a;
    return 1 - front * betaContinuedFraction(b, a, 1 - x) / b;
}

// Regularisierte obere unvollständige Gammafunktion Q(a, x) = 1 - P(a, x)
function regUpperGamma(a, x) {
    if (x <= 0) return 1;
    const gln = logGamma(a);
    if (x < a + 1) {
        let sum = 1 / a, del = sum, ap = a;
        for (let n = 0; n < 500; n++) {
            ap += 1; del *= x / ap; sum += del;
            if (Math.abs(del) < Math.abs(sum) * 3e-14) break;
        }
        return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
    }
    const FPMIN = 1e-300;
    let b = x + 1 - a, c = 1 / FPMIN, d = 1 / b, h = d;
    for (let i = 1; i < 500; i++) {
        const an = -i * (i - a);
        b += 2;
        d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
        c = b + an / c; if (Math.abs(c) < FPMIN) c = FPMIN;
        d = 1 / d;
        const del = d * c;
        h *= del;
        if (Math.abs(del - 1) < 3e-14) break;
    }
    return Math.exp(-x + a * Math.log(x) - gln) * h;
}

// Zweiseitige p-Werte
const pValue = {
    t: (t, df) => regIncBeta(df / (df + t * t), df / 2, 0.5),
    F: (f, df1, df2) => f <= 0 ? 1 : regIncBeta(df2 / (df2 + df1 * f), df2 / 2, df1 / 2),
    chi2: (x, df) => regUpperGamma(df / 2, x / 2),
    z: z => regUpperGamma(0.5, (z * z) / 2),
    r: (r, df) => Math.abs(r) >= 1 ? 0 : pValue.t(r * Math.sqrt(df / (1 - r * r)), df)
};

function computeP(test, value, df) {
    const v = Math.abs(value);
    if (test === 't') return pValue.t(v, df[0]);
    if (test === 'F') return pValue.F(v, df[0], df[1]);
    if (test === 'chi2') return pValue.chi2(v, df[0]);
    if (test === 'r') return pValue.r(v, df[0]);
    if (test === 'z') return pValue.z(v);
    return null;
}

// ---------- Text normalisieren ----------
function normalizeStatText(text) {
    return String(text || '').normalize('NFKC')
        .replace(/[−–—]/g, '-')      // Minus/Gedankenstrich → Bindestrich
        .replace(/[≤⩽]/g, '<').replace(/[≥⩾]/g, '>')
        .replace(/χ\s*(?:2|²)|chi\s*-?\s*(?:square[d]?|2|²)|Χ\s*(?:2|²)/gi, 'CHI2')
        .replace(/\s+/g, ' ');
}

function decimalsOf(numStr) {
    const m = String(numStr).match(/\.(\d+)/);
    return m ? m[1].length : 0;
}

function parseNum(str) {
    return Number(String(str).replace(/^\./, '0.').replace(/^-\./, '-0.'));
}

// ---------- statcheck ----------
const STAT_PATTERNS = [
    { test: 't', re: /\bt\s*\(\s*(\d+(?:\.\d+)?)\s*\)\s*=\s*(-?\s?\d*\.?\d+)\s*[,;]?\s*p\s*([<>=])\s*(\d*\.\d+|0|1)/g, df: m => [parseNum(m[1])], value: m => m[2], p: m => [m[3], m[4]] },
    { test: 'F', re: /\bF\s*\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)\s*=\s*(\d*\.?\d+)\s*[,;]?\s*p\s*([<>=])\s*(\d*\.\d+|0|1)/g, df: m => [parseNum(m[1]), parseNum(m[2])], value: m => m[3], p: m => [m[4], m[5]] },
    { test: 'chi2', re: /CHI2\s*\(\s*(\d+)\s*(?:,\s*[Nn]\s*=\s*[\d,]+\s*)?\)\s*=\s*(\d*\.?\d+)\s*[,;]?\s*p\s*([<>=])\s*(\d*\.\d+|0|1)/g, df: m => [parseNum(m[1])], value: m => m[2], p: m => [m[3], m[4]] },
    { test: 'r', re: /\br\s*\(\s*(\d+)\s*\)\s*=\s*(-?\s?\d*\.\d+)\s*[,;]?\s*p\s*([<>=])\s*(\d*\.\d+|0|1)/g, df: m => [parseNum(m[1])], value: m => m[2], p: m => [m[3], m[4]] },
    { test: 'z', re: /\b[zZ]\s*=\s*(-?\s?\d*\.?\d+)\s*[,;]?\s*p\s*([<>=])\s*(\d*\.\d+|0|1)/g, df: () => [], value: m => m[1], p: m => [m[2], m[3]] }
];

function formatStatLabel(test, df, valueStr, op, pStr) {
    const name = test === 'chi2' ? 'χ²' : test;
    const dfPart = df.length ? `(${df.join(', ')})` : '';
    return `${name}${dfPart} = ${valueStr}, p ${op} ${pStr}`;
}

// Bewertet eine Angabe wie statcheck: Rundung der Teststatistik und des p-Werts wird berücksichtigt.
function checkStatistic({ test, df, valueStr, op, pStr }) {
    const value = parseNum(valueStr.replace(/\s/g, ''));
    const dx = decimalsOf(valueStr);
    const reportedP = parseNum(pStr);
    const dp = decimalsOf(pStr);
    const half = x => 0.5 * Math.pow(10, -x);
    const pAt = v => computeP(test, v, df);
    const computed = pAt(value);
    if (computed === null || !Number.isFinite(computed)) return null;
    const vAbs = Math.abs(value);
    // Großer Wert der Statistik → kleiner p-Wert
    const pLow = pAt(vAbs + half(dx));
    const pHigh = pAt(Math.max(0, vAbs - half(dx)));
    let effOp = op, effP = reportedP;
    if (op === '=' && reportedP === 0) { effOp = '<'; effP = half(dp || 3); }   // "p = .000" heißt eigentlich p < .0005
    const consistentWith = (lo, hi) => {
        if (effOp === '=') return hi >= effP - half(dp) && lo <= effP + half(dp);
        if (effOp === '<') return lo < effP;
        return hi > effP;
    };
    const consistent = consistentWith(pLow, pHigh);
    const reportedSignificant = effOp === '<' ? effP <= ALPHA : effOp === '=' ? effP < ALPHA : false;
    const computedSignificant = computed < ALPHA;
    const grossError = !consistent && reportedSignificant !== computedSignificant;
    const oneTailed = !consistent && consistentWith(pLow / 2, pHigh / 2);
    return {
        test, df, value, reported_op: op, reported_p: reportedP, computed_p: computed,
        consistent, gross_error: grossError, one_tailed_possible: oneTailed,
        label: formatStatLabel(test, df, valueStr.replace(/\s/g, ''), op, pStr)
    };
}

function findStatistics(pages) {
    const results = [];
    const seen = new Set();
    for (const page of pages || []) {
        const text = normalizeStatText(page.text);
        for (const pattern of STAT_PATTERNS) {
            pattern.re.lastIndex = 0;
            let m;
            while ((m = pattern.re.exec(text)) !== null) {
                const [op, pStr] = pattern.p(m);
                const checked = checkStatistic({ test: pattern.test, df: pattern.df(m), valueStr: pattern.value(m), op, pStr });
                if (!checked) continue;
                const key = `${page.page}|${checked.label}`;
                if (seen.has(key)) continue;
                seen.add(key);
                results.push({ ...checked, page: page.page, context: text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 20).trim() });
            }
        }
    }
    return results;
}

// ---------- GRIM ----------
// Nur aussagekräftig für Mittelwerte ganzzahliger Einzelwerte (z.B. ein Likert-Item) und n < 10^Nachkommastellen.
function grimConsistent(mean, n, decimals) {
    if (!(n > 0) || n >= Math.pow(10, decimals)) return null;
    const k = Math.round(mean * n);
    for (const cand of [k - 1, k, k + 1]) {
        if (Math.abs(Number((cand / n).toFixed(decimals)) - mean) < 1e-9) return true;
    }
    return false;
}

function findGrimCandidates(pages) {
    const out = [];
    const re = /\(([^()]{0,120})\)/g;
    for (const page of pages || []) {
        const text = normalizeStatText(page.text);
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(text)) !== null) {
            const inner = m[1];
            const mean = inner.match(/\bM\s*=\s*(\d+\.\d+)/);
            const n = inner.match(/\b[nN]\s*=\s*(\d+)\b/);
            if (!mean || !n) continue;
            const dec = decimalsOf(mean[1]);
            const result = grimConsistent(parseNum(mean[1]), Number(n[1]), dec);
            if (result === null) continue;
            out.push({ page: page.page, mean: parseNum(mean[1]), mean_text: mean[1], n: Number(n[1]), consistent: result, context: `(${inner.trim()})` });
        }
    }
    return out;
}

// ---------- Stichprobengrößen ----------
function findSampleSizes(pages) {
    const out = [];
    // Ein Satzpunkt nach der Zahl ist erlaubt ("N = 60."), eine Dezimalstelle nicht ("n = 2.5").
    const re = /\b([Nn])\s*=\s*(\d{1,3}(?:,\d{3})+|\d+)(?!\d|\.\d)/g;
    for (const page of pages || []) {
        const text = normalizeStatText(page.text);
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(text)) !== null) {
            out.push({ page: page.page, symbol: m[1], value: Number(m[2].replace(/,/g, '')),
                context: text.slice(Math.max(0, m.index - 50), m.index + m[0].length + 30).trim() });
        }
    }
    return out;
}

function summarizeSampleSizes(sizes, extractedN) {
    const totals = [...new Set(sizes.filter(s => s.symbol === 'N').map(s => s.value))].sort((a, b) => b - a);
    const subgroups = [...new Set(sizes.filter(s => s.symbol === 'n').map(s => s.value))].sort((a, b) => b - a);
    const nExtracted = Number(String(extractedN ?? '').replace(/[^\d]/g, '')) || null;
    return {
        totals, subgroups, extracted_n: nExtracted,
        // Mehrere verschiedene Gesamt-N sind nicht automatisch falsch (z.B. Ausfälle), aber prüfenswert.
        multiple_totals: totals.length > 1,
        extracted_n_found: nExtracted ? sizes.some(s => s.value === nExtracted) : null
    };
}

// ---------- Registrierungen ----------
const REGISTRY_PATTERNS = [
    { registry: 'ClinicalTrials.gov', re: /\bNCT\s?\d{8}\b/g, url: id => `https://clinicaltrials.gov/study/${id}` },
    { registry: 'DRKS', re: /\bDRKS\s?\d{8}\b/g, url: id => `https://drks.de/search/de/trial/${id}` },
    { registry: 'ISRCTN', re: /\bISRCTN\s?\d{8}\b/g, url: id => `https://www.isrctn.com/${id}` },
    { registry: 'PROSPERO', re: /\bCRD\s?\d{11}\b/g, url: id => `https://www.crd.york.ac.uk/prospero/display_record.php?ID=${id}` },
    { registry: 'ANZCTR', re: /\bACTRN\s?\d{14}\b/g, url: id => `https://www.anzctr.org.au/TrialSearch.aspx?searchTxt=${id}` },
    { registry: 'ChiCTR', re: /\bChiCTR[-A-Z0-9]{6,}\b/g, url: id => `https://www.chictr.org.cn/searchprojEN.html?regno=${id}` },
    { registry: 'EU-CTR (EudraCT)', re: /\b\d{4}-\d{6}-\d{2}\b(?=[^.]{0,40})/g, near: /eudract/i, url: id => `https://www.clinicaltrialsregister.eu/ctr-search/search?query=${id}` },
    { registry: 'OSF', re: /\bosf\.io\/[a-z0-9]{4,6}\b/gi, url: id => `https://${id}` },
    { registry: 'AsPredicted', re: /\baspredicted\.org\/[A-Za-z0-9_\-/.]+/gi, url: id => `https://${id}` },
    { registry: 'INPLASY', re: /\bINPLASY\s?\d{6,}\b/g, url: id => `https://inplasy.com/?s=${id}` }
];

function findRegistrations(pages) {
    const found = new Map();
    for (const page of pages || []) {
        const text = normalizeStatText(page.text);
        for (const p of REGISTRY_PATTERNS) {
            p.re.lastIndex = 0;
            let m;
            while ((m = p.re.exec(text)) !== null) {
                if (p.near && !p.near.test(text.slice(Math.max(0, m.index - 60), m.index + 60))) continue;
                const id = m[0].replace(/\s/g, '').replace(/[.,;)]+$/, '');
                if (!found.has(id)) found.set(id, { id, registry: p.registry, url: p.url(id), page: page.page });
            }
        }
    }
    const fullText = (pages || []).map(p => p.text).join(' ');
    return {
        ids: [...found.values()],
        preregistration_mentioned: /pre-?regist|präregist|prospectively regist|trial regist|registered (?:at|with|in)|registriert/i.test(fullText)
    };
}

// ---------- DOI ----------
function findDoi(pages) {
    // Die eigene DOI steht fast immer auf den ersten Seiten; weiter hinten folgen DOIs zitierter Arbeiten.
    const re = /\b(10\.\d{4,9}\/[^\s"<>]+)/i;
    for (const page of (pages || []).slice(0, 2)) {
        const m = normalizeStatText(page.text).match(re);
        if (m) return m[1].replace(/[.,;:)\]]+$/, '');
    }
    return null;
}

async function fetchJsonWithTimeout(url, ms = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
        if (!res.ok) return { status: res.status, data: null };
        return { status: res.status, data: await res.json() };
    } finally {
        clearTimeout(timer);
    }
}

function titleMatchesText(title, text) {
    const words = String(title || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 3);
    if (!words.length) return null;
    const haystack = String(text || '').toLowerCase();
    return words.filter(w => haystack.includes(w)).length / words.length >= 0.7;
}

// Fragt Crossref nach Metadaten und nach Mitteilungen, die diese DOI aktualisieren (Retraction,
// Correction, Expression of Concern; enthält seit 2023 auch die Daten von Retraction Watch).
async function checkDoiOnline(doi, firstPagesText) {
    if (!doi) return { checked: false, reason: 'Keine DOI im Text gefunden.' };
    if (typeof navigator !== 'undefined' && !navigator.onLine) return { doi, checked: false, reason: 'Offline – Crossref nicht abfragbar.' };
    try {
        const enc = encodeURIComponent(doi);
        const [work, updates] = await Promise.all([
            fetchJsonWithTimeout(`https://api.crossref.org/works/${enc}`),
            fetchJsonWithTimeout(`https://api.crossref.org/works?filter=updates:${enc}&rows=20`)
        ]);
        if (work.status === 404) return { doi, checked: true, found: false, reason: 'DOI ist bei Crossref nicht registriert.' };
        const meta = work.data?.message || {};
        const notices = [];
        for (const item of updates.data?.message?.items || []) {
            for (const u of item['update-to'] || []) {
                if (String(u.DOI || '').toLowerCase() === doi.toLowerCase()) {
                    notices.push({ type: u.type || 'update', label: u.label || u.type, notice_doi: item.DOI, date: u.updated?.['date-time'] || null });
                }
            }
        }
        const title = Array.isArray(meta.title) ? meta.title[0] : meta.title;
        return {
            doi, checked: true, found: true,
            title: title || null,
            journal: Array.isArray(meta['container-title']) ? meta['container-title'][0] : null,
            year: meta.issued?.['date-parts']?.[0]?.[0] || null,
            title_matches_document: titleMatchesText(title, firstPagesText),
            notices,
            retracted: notices.some(n => /retract/i.test(n.type)),
            corrected: notices.some(n => /correct|erratum/i.test(n.type)),
            concern: notices.some(n => /concern/i.test(n.type))
        };
    } catch (err) {
        return { doi, checked: false, reason: `Crossref nicht erreichbar (${err?.name === 'AbortError' ? 'Zeitüberschreitung' : err?.message || err}).` };
    }
}

// ---------- Gesamtprüfung ----------
function runComputedIntegrity(pages, extraction) {
    const statistics = findStatistics(pages);
    const sampleSizes = findSampleSizes(pages);
    return {
        statistics,
        statistics_summary: {
            total: statistics.length,
            inconsistent: statistics.filter(s => !s.consistent).length,
            gross_errors: statistics.filter(s => s.gross_error).length
        },
        grim: findGrimCandidates(pages),
        sample_sizes: sampleSizes.slice(0, 40),
        sample_summary: summarizeSampleSizes(sampleSizes, extraction?.sample?.n),
        registrations: findRegistrations(pages),
        doi: findDoi(pages)
    };
}

// ---------- Vergleich Code ↔ LLM ----------
function statKey(test, df, value) {
    const t = String(test || '').toLowerCase().replace(/χ²|chi2|chi-?square/, 'chi2');
    const dfs = (Array.isArray(df) ? df : String(df ?? '').split(/[,;\s]+/)).filter(x => x !== '' && x !== undefined).map(Number);
    return `${t}|${dfs.join(',')}|${Math.abs(Number(value)).toFixed(2)}`;
}

function normalizeYesNo(v) {
    const s = String(v ?? '').toLowerCase().trim();
    if (['yes', 'true', 'ja'].includes(s)) return 'yes';
    if (['no', 'false', 'nein'].includes(s)) return 'no';
    return 'unclear';
}

function compareIntegrity(computed, llm) {
    const llmTests = Array.isArray(llm?.statistical_tests) ? llm.statistical_tests : [];
    const llmByKey = new Map(llmTests.map(t => [statKey(t.test, t.df, t.statistic), t]));
    const rows = [];
    const matched = new Set();
    for (const s of computed?.statistics || []) {
        const key = statKey(s.test, s.df, s.value);
        const l = llmByKey.get(key);
        if (l) matched.add(key);
        rows.push({ key, code: s, llm: l || null });
    }
    for (const [key, l] of llmByKey) if (!matched.has(key)) rows.push({ key, code: null, llm: l });
    const both = rows.filter(r => r.code && r.llm);
    const agree = both.filter(r => (r.code.consistent ? 'yes' : 'no') === normalizeYesNo(r.llm.consistent)).length;
    return {
        rows,
        found_by_code: rows.filter(r => r.code).length,
        found_by_llm: rows.filter(r => r.llm).length,
        found_by_both: both.length,
        verdict_agreement: both.length ? agree / both.length : null
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        pValue, computeP, regIncBeta, regUpperGamma, checkStatistic, findStatistics, normalizeStatText,
        grimConsistent, findGrimCandidates, findSampleSizes, summarizeSampleSizes, findRegistrations, findDoi,
        titleMatchesText, runComputedIntegrity, compareIntegrity, statKey
    };
}
