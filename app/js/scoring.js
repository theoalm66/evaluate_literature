// ==========================================
// JSON HARDCORE PARSER (Ultra-Stable Edition)
// ==========================================
function parseJSONRobust(str) {
    if (!str) return {};
    if (typeof str === 'object') return str; 
    
    let cleanStr = String(str).trim();
    
    if (cleanStr.startsWith('```')) {
        const firstNewline = cleanStr.indexOf('\n');
        if (firstNewline > -1) cleanStr = cleanStr.substring(firstNewline + 1);
        if (cleanStr.endsWith('```')) cleanStr = cleanStr.substring(0, cleanStr.length - 3).trim();
    }

    const thinkEnd = cleanStr.indexOf('</think>');
    if (thinkEnd > -1) {
        cleanStr = cleanStr.substring(thinkEnd + 8).trim();
    }

    const firstBrace = cleanStr.indexOf('{');
    const lastBrace = cleanStr.lastIndexOf('}');
    if (firstBrace > -1 && lastBrace > -1) {
        cleanStr = cleanStr.substring(firstBrace, lastBrace + 1);
    } else {
        return {};
    }

    try { 
        return JSON.parse(cleanStr); 
    } 
    catch (e) {
        let fixed = cleanStr;
        const lastComma = fixed.lastIndexOf(',');
        const lastOpenCurly = fixed.lastIndexOf('{');
        const lastOpenSquare = fixed.lastIndexOf('[');
        
        let cutPoint = Math.max(lastComma, lastOpenCurly, lastOpenSquare);
        if (cutPoint > -1 && cutPoint > fixed.length - 50) {
            fixed = fixed.substring(0, cutPoint);
        }
        fixed = fixed.replace(/,\s*$/, '');
        
        let openCurly = 0;
        let openSquare = 0;
        let inString = false;
        let escapeNext = false;
        
        for (let i = 0; i < fixed.length; i++) {
            const char = fixed[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (char === '\\') { escapeNext = true; continue; }
            if (char === '"') { inString = !inString; continue; }
            if (!inString) {
                if (char === '{') openCurly++;
                if (char === '}') openCurly--;
                if (char === '[') openSquare++;
                if (char === ']') openSquare--;
            }
        }
        
        if (inString) fixed += '"';
        while (openSquare > 0) { fixed += ']'; openSquare--; }
        while (openCurly > 0) { fixed += '}'; openCurly--; }

        try { 
            return JSON.parse(fixed);
        } catch (e2) {
            return {};
        }
    }
}


function buildEvidenceContext(pages, maxChars = 25000) {
    if (!Array.isArray(pages) || !pages.length) return "";
    const renderPage = p => `\n--- PAGE ${p.page} ---\n${p.text}\n`;
    const complete = pages.map(renderPage).join('');
    if (complete.length <= maxChars) return complete;

    const keywords = [
        'method', 'methodology', 'methodik', 'materials and methods', 'stichprobe', 'sample',
        'participants', 'data collection', 'datenerhebung', 'measures', 'measurement', 'messung',
        'analysis', 'statistical', 'statistik', 'results', 'ergebnisse', 'findings',
        'limitations', 'limitationen', 'discussion', 'diskussion', 'conflict of interest',
        'funding', 'preregistration', 'data availability', 'ethics', 'hypotheses', 'research question',
        'abstract', 'conclusion', 'conclusions'
    ];

    const selected = new Set();
    pages.slice(0, Math.min(4, pages.length)).forEach(p => selected.add(p.page));
    pages.slice(Math.max(0, pages.length - 3)).forEach(p => selected.add(p.page));

    for (const p of pages) {
        const lower = String(p.text || '').toLowerCase();
        if (keywords.some(k => lower.includes(k))) selected.add(p.page);
    }

    const ordered = pages.filter(p => selected.has(p.page));
    let out = '';
    for (const p of ordered) {
        const chunk = renderPage(p);
        if ((out + chunk).length > maxChars) continue;
        out += chunk;
    }

    if (out.length < Math.min(18000, maxChars * 0.5)) {
        for (const p of pages) {
            if (selected.has(p.page)) continue;
            const chunk = renderPage(p);
            if ((out + chunk).length > maxChars) break;
            out += chunk;
        }
    }
    return out;
}

function normalizeForMatch(text) {
    // NFKC löst Ligaturen (ﬁ, ﬂ) auf; Bindestriche samt folgendem Leerraum werden entfernt, damit
    // PDF-Silbentrennung ("metho- dology") und Bindestrich-Wörter auf beiden Seiten gleich aussehen.
    return String(text || '').normalize('NFKC').toLowerCase()
        .replace(/[\u00ad]/g, '')
        .replace(/[“”„‟]/g, '"').replace(/[’‘]/g, "'")
        .replace(/[-‐‑–]\s*/g, '')
        .replace(/\s+/g, ' ').trim();
}

function wordTrigrams(words) {
    const grams = new Set();
    for (let i = 0; i + 2 < words.length; i++) grams.add(words.slice(i, i + 3).join(' '));
    return grams;
}

// Anteil der Wort-Trigramme des Zitats, die auf der Seite vorkommen. Fängt kleine Abweichungen
// ab (ausgelassene Wörter, andere Satzzeichen), ohne frei formulierte Paraphrasen zu akzeptieren.
const FUZZY_QUOTE_THRESHOLD = 0.8;

function findQuoteOnPages(quote, pages) {
    const nq = normalizeForMatch(quote);
    if (!nq || nq.length < 12 || !Array.isArray(pages)) return null;
    const normalizedPages = pages.map(p => ({ page: p.page, text: normalizeForMatch(p.text) }));
    for (const p of normalizedPages) {
        if (p.text.includes(nq)) return { page: p.page, verified: true, match: 'exact', quote };
    }
    const words = nq.replace(/[^\p{L}\p{N} ]/gu, ' ').split(' ').filter(Boolean);
    if (words.length >= 8) {
        const probe = words.slice(0, Math.min(words.length, 14)).join(' ');
        for (const p of normalizedPages) {
            if (p.text.replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').includes(probe)) return { page: p.page, verified: true, match: 'prefix', quote };
        }
    }
    if (words.length >= 6) {
        const quoteGrams = wordTrigrams(words);
        let best = null;
        for (const p of normalizedPages) {
            const pageGrams = wordTrigrams(p.text.replace(/[^\p{L}\p{N} ]/gu, ' ').split(' ').filter(Boolean));
            let hits = 0;
            quoteGrams.forEach(g => { if (pageGrams.has(g)) hits++; });
            const ratio = hits / quoteGrams.size;
            if (ratio >= FUZZY_QUOTE_THRESHOLD && (!best || ratio > best.ratio)) best = { page: p.page, ratio };
        }
        if (best) return { page: best.page, verified: true, match: 'fuzzy', quote };
    }
    return null;
}

function verifyExtractionEvidenceRefs(extraction, pages) {
    const refs = Array.isArray(extraction?.evidence_locations) ? extraction.evidence_locations : [];
    extraction.evidence_locations = refs.map(ref => {
        const quote = String(ref?.quote || '').trim();
        const claimed = Number(ref?.page);
        const found = findQuoteOnPages(quote, pages);
        if (found) return { ...ref, page: found.page, verified: true };
        const validClaimed = Number.isInteger(claimed) && claimed > 0 && claimed <= (pages?.length || 0);
        return { ...ref, page: validClaimed ? claimed : null, verified: false };
    });
    return extraction;
}

function verifySourceRefs(validation, pages) {
    const dims = Array.isArray(validation?.validated_dimensions) ? validation.validated_dimensions : [];
    dims.forEach(d => {
        let refs = Array.isArray(d.source_refs) ? d.source_refs : [];
        if (!refs.length && d.evidence && typeof d.evidence === 'object') refs = [d.evidence];
        d.source_refs = refs.map(ref => {
            const quote = String(ref?.quote || '').trim();
            const claimed = Number(ref?.page);
            const found = findQuoteOnPages(quote, pages);
            if (found) return { page: found.page, section: ref?.section || 'unknown', quote, verified: true };
            const validClaimed = Number.isInteger(claimed) && claimed > 0 && claimed <= (pages?.length || 0);
            return { page: validClaimed ? claimed : null, section: ref?.section || 'unknown', quote, verified: false };
        }).filter(ref => ref.quote || ref.page);
    });
    return validation;
}


function verifyFrameworkEvidence(validation, appraisal, pages) {
    const fw = validation?.validated_framework || appraisal?.framework_appraisal;
    if (!fw) return validation;
    ['screening', 'criteria'].forEach(group => {
        const items = Array.isArray(fw[group]) ? fw[group] : [];
        items.forEach(item => {
            const refs = Array.isArray(item.evidence) ? item.evidence : [];
            item.evidence = refs.map(ref => {
                const quote = String(ref?.quote || '').trim();
                const claimed = Number(ref?.page);
                const found = findQuoteOnPages(quote, pages);
                if (found) return { page: found.page, section: ref?.section || 'unknown', quote, verified: true };
                const validClaimed = Number.isInteger(claimed) && claimed > 0 && claimed <= (pages?.length || 0);
                return { page: validClaimed ? claimed : null, section: ref?.section || 'unknown', quote, verified: false };
            }).filter(ref => ref.quote || ref.page);
        });
    });
    if (!validation.validated_framework) validation.validated_framework = fw;
    return validation;
}

function verifyEstablishedEvidence(validation, appraisal, pages) {
    const ea = validation?.validated_established_appraisal || appraisal?.established_appraisal;
    if (!ea) return validation;
    const items = Array.isArray(ea.items) ? ea.items : [];
    items.forEach(item => {
        const refs = Array.isArray(item.evidence) ? item.evidence : [];
        item.evidence = refs.map(ref => {
            const quote = String(ref?.quote || '').trim();
            const claimed = Number(ref?.page);
            const found = findQuoteOnPages(quote, pages);
            if (found) return { page: found.page, section: ref?.section || 'unknown', quote, verified: true };
            const validClaimed = Number.isInteger(claimed) && claimed > 0 && claimed <= (pages?.length || 0);
            return { page: validClaimed ? claimed : null, section: ref?.section || 'unknown', quote, verified: false };
        }).filter(ref => ref.quote || ref.page);
    });
    if (!validation.validated_established_appraisal) validation.validated_established_appraisal = ea;
    return validation;
}


function verifyJARSEvidence(validation, appraisal, pages) {
    const jq = validation?.validated_jars_quant || appraisal?.jars_quant;
    if (!jq) return validation;
    const items = Array.isArray(jq.criteria) ? jq.criteria : [];
    items.forEach(item => {
        const refs = Array.isArray(item.source_refs) ? item.source_refs : (Array.isArray(item.evidence) ? item.evidence : []);
        item.source_refs = refs.map(ref => {
            const quote = String(ref?.quote || '').trim();
            const claimed = Number(ref?.page);
            const found = findQuoteOnPages(quote, pages);
            if (found) return { page: found.page, section: ref?.section || 'unknown', quote, verified: true };
            const validClaimed = Number.isInteger(claimed) && claimed > 0 && claimed <= (pages?.length || 0);
            return { page: validClaimed ? claimed : null, section: ref?.section || 'unknown', quote, verified: false };
        }).filter(ref => ref.quote || ref.page);
    });
    if (!validation.validated_jars_quant) validation.validated_jars_quant = jq;
    return validation;
}

function calculateJARSMetrics(validation, appraisal) {
    const jq = validation?.validated_jars_quant || appraisal?.jars_quant || {};
    const items = Array.isArray(jq.criteria) ? jq.criteria : [];
    let reported=0, partial=0, notReported=0, notApplicable=0;
    items.forEach(it => {
        const s = String(it.status || '').toLowerCase();
        if (s === 'reported') reported++;
        else if (s === 'partial') partial++;
        else if (s === 'not_reported') notReported++;
        else if (s === 'not_applicable') notApplicable++;
    });
    const considered = reported + partial + notReported;
    const internalCompletion = considered ? Math.round(((reported + 0.5*partial) / considered) * 100) : null;
    return {reported, partial, not_reported:notReported, not_applicable:notApplicable, considered, internalCompletion};
}

function calculateEstablishedResult(validation, appraisal, extraction) {
    const ea = validation?.validated_established_appraisal || appraisal?.established_appraisal || {};
    let instrument = String(ea.instrument || 'none');
    if (!ea.applicable || instrument === 'none') {
        const fw = validation?.validated_framework || appraisal?.framework_appraisal || {};
        const fwName = String(fw.primary_framework || 'none');
        if (fwName !== 'none' && fwName !== 'Internal conceptual appraisal') {
            return { instrument:fwName, applicable:true, display:'kriteriumsweise', score:null, max:null, rating:null, items:ea.items||[], reason:'Etabliertes Checklisten-Framework ohne offiziellen numerischen Summenscore.' };
        }
        return { instrument, applicable:false, display:'kein passendes etabliertes Score-Instrument', score:null, max:null, rating:'not_applicable', items:ea.items||[], reason:ea.applicability_reason||'' };
    }
    const items = Array.isArray(ea.items) ? ea.items : [];
    const itemId = it => String(it?.item_id ?? '').trim();
    if (instrument === 'PEDro Scale') {
        let score = 0;
        const present = new Set();
        for (const it of items) {
            const id = itemId(it);
            if (!/^([1-9]|1[01])$/.test(id)) continue;
            present.add(id);
            if (id === '1') continue;
            score += String(it.response||'').toLowerCase()==='yes' ? 1 : 0;
        }
        // Fehlende Items zählen wie bei PEDro "nicht berichtet" = 0, werden aber sichtbar gemacht.
        const missing = PEDRO_SCORED_ITEMS.filter(id => !present.has(id));
        const display = missing.length ? `${score} / 10 (unvollständig)` : `${score} / 10`;
        return {instrument, applicable:true, score, max:10, rating:null, display, items, missing_items:missing, reason:ea.applicability_reason||''};
    }
    if (instrument === 'MINORS') {
        const flagged = extraction?.clinical_context?.is_comparative;
        const comparative = typeof flagged === 'boolean' ? flagged : (Number(ea.official_max) === 24 || items.length >= 12);
        const max = comparative ? 24 : 16;
        const itemCount = comparative ? 12 : 8;
        const hasIds = items.some(it => /^\d+$/.test(itemId(it)));
        const used = hasIds
            ? items.filter(it => { const n = Number(itemId(it)); return Number.isInteger(n) && n >= 1 && n <= itemCount; })
            : items.slice(0, itemCount);
        const score = used.reduce((a,it) => a + Math.max(0, Math.min(2, Number(it.points)||0)), 0);
        return {instrument, applicable:true, score, max, rating:null, display:`${score} / ${max}`, items, comparative, reason:ea.applicability_reason||''};
    }
    if (instrument === 'AMSTAR 2') {
        // Kritische Domänen sind durch das Instrument festgelegt (Shea et al. 2017), nicht durch das Modell.
        let criticalFlaws = 0, nonCriticalWeaknesses = 0;
        for (const it of items) {
            const resp = String(it.response || '').toLowerCase();
            if (resp === 'not_applicable') continue;
            const critical = AMSTAR2_CRITICAL_ITEMS.has(itemId(it));
            if (critical && resp === 'no') criticalFlaws++;
            else if (!critical && resp === 'no') nonCriticalWeaknesses++;
            else if (resp === 'partial_yes') nonCriticalWeaknesses++;
        }
        let rating = 'High';
        if (criticalFlaws > 1) rating = 'Critically low';
        else if (criticalFlaws === 1) rating = 'Low';
        else if (nonCriticalWeaknesses > 1) rating = 'Moderate';
        return {instrument, applicable:true, score:null, max:null, rating, display:rating, items, critical_flaws:criticalFlaws, non_critical_weaknesses:nonCriticalWeaknesses, reason:ea.applicability_reason||''};
    }
    if (instrument === 'COSMIN Risk of Bias') {
        // "Worst score counts" wird deterministisch berechnet; das Modell-Rating dient nur dem Abgleich.
        const order = {very_good:4, adequate:3, doubtful:2, inadequate:1};
        let worst = null;
        for (const it of items) {
            const r=String(it.response||'').toLowerCase().replace(/ /g,'_');
            if (order[r] && (!worst || order[r] < order[worst])) worst=r;
        }
        const agentRating = ea.official_rating && ea.official_rating !== 'not_applicable' ? String(ea.official_rating) : null;
        const rating = worst ? worst.replace(/_/g,' ') : (agentRating || 'unclear');
        const mismatch = !!(worst && agentRating && agentRating.toLowerCase().replace(/ /g,'_') !== worst);
        return {instrument, applicable:true, score:null, max:null, rating, display:rating, items, agent_rating:agentRating, rating_mismatch:mismatch, reason:ea.applicability_reason||''};
    }
    return {instrument, applicable:true, score:ea.official_score??null, max:ea.official_max??null, rating:ea.official_rating??null, display: ea.official_rating || (ea.official_score!=null ? `${ea.official_score}${ea.official_max?` / ${ea.official_max}`:''}` : 'siehe Kriterien'), items, reason:ea.applicability_reason||''};
}

function countFrameworkItems(items) {
    let yes = 0, no = 0, cantTell = 0, notApplicable = 0;
    (Array.isArray(items) ? items : []).forEach(item => {
        const raw = String(item?.framework_response ?? item?.response ?? 'cant_tell').toLowerCase().trim();
        if (raw === 'yes') yes++;
        else if (raw === 'no') no++;
        else if (raw === 'not_applicable') notApplicable++;
        else cantTell++;
    });
    const decidable = yes + no;
    const considered = yes + no + cantTell;
    return {
        yes, no, cant_tell: cantTell, not_applicable: notApplicable,
        fulfillment: decidable ? Math.round((yes / decidable) * 100) : null,
        decidability: considered ? Math.round((decidable / considered) * 100) : null,
        total_considered: considered
    };
}

function calculateFrameworkMetrics(validation, appraisal) {
    const fw = validation?.validated_framework || appraisal?.framework_appraisal || {};
    const screening = countFrameworkItems(fw.screening || []);
    const criteria = countFrameworkItems(fw.criteria || []);
    return {
        screening,
        criteria,
        framework: fw.primary_framework || null,
        category: fw.framework_category || null,
        yes: criteria.yes,
        no: criteria.no,
        cant_tell: criteria.cant_tell,
        not_applicable: criteria.not_applicable,
        fulfillment: criteria.fulfillment,
        decidability: criteria.decidability
    };
}

// ==========================================
// FESTE BEWERTUNGSREGELN (gehören zum Code, nicht zum Prompt)
// ==========================================
const SCORING_VERSION = '2026-10-casq-fixed-weights-1';

const PEDRO_SCORED_ITEMS = ['2','3','4','5','6','7','8','9','10','11'];
const AMSTAR2_CRITICAL_ITEMS = new Set(['2','4','7','9','11','13','15']);

// CASQ-Rubriken wie in Agent 3 beschrieben. Die Gewichte werden hier erzwungen, damit ein Modell sie
// nicht verschieben kann; Änderungen an den Gewichten im Prompt wirken sich deshalb nicht mehr aus.
const CASQ_RUBRICS = {
    quantitative: { label: 'Quantitativ', dimensions: [
        ['Research question & theory', 10], ['Design appropriateness', 15], ['Sample & external validity', 15],
        ['Measurement quality', 15], ['Statistical analysis', 15], ['Bias & internal validity', 15],
        ['Results interpretation', 5], ['Transparency & reproducibility', 5], ['Limitations', 5]] },
    qualitative: { label: 'Qualitativ', dimensions: [
        ['Research question & fit', 10], ['Sampling strategy', 15], ['Data collection quality', 15],
        ['Reflexivity', 10], ['Analytic rigor', 20], ['Credibility / triangulation / saturation', 15],
        ['Transferability', 5], ['Transparency', 5], ['Limitations', 5]] },
    mixed: { label: 'Mixed Methods', dimensions: [
        ['Research question & design fit', 10], ['Quantitative component', 25], ['Qualitative component', 25],
        ['Integration quality', 25], ['Inference quality', 10], ['Transparency', 5]] },
    review: { label: 'Review', dimensions: [
        ['Question & protocol', 10], ['Search strategy', 20], ['Screening & study selection', 15],
        ['Critical appraisal', 15], ['Data extraction', 10], ['Synthesis method', 15],
        ['Heterogeneity/publication bias', 10], ['Transparency', 5]] },
    theoretical: { label: 'Theoretisch', dimensions: [
        ['Conceptual clarity', 15], ['Literature foundation', 20], ['Logical coherence', 20], ['Novelty', 10],
        ['Boundary conditions', 10], ['Testability', 10], ['Integration', 10], ['Limitations & transparency', 5]] },
    methodological: { label: 'Methodenbeitrag', dimensions: [
        ['Methodological objective & scope', 10], ['Conceptual/methodological foundation', 15],
        ['Description of methods/instruments', 20], ['Empirical support/examples', 15],
        ['Validity & reliability discussion', 15], ['Critical reflection of strengths/limitations', 10],
        ['Reproducibility/transferability', 5], ['Literature integration', 5], ['Transparency', 5]] },
    multiple: { label: 'Multiple-study report', dimensions: [
        ['Overarching research logic', 10], ['Transparency of individual study methods', 15],
        ['Adequacy of designs across studies', 15], ['Measurement quality across studies', 10],
        ['Statistical/analytic rigor across studies', 10], ['Integration and progression across studies', 15],
        ['Cross-study interpretation', 10], ['Limitations/bias reflection', 10], ['Reproducibility/transparency', 5]] },
    narrative: { label: 'Narrative review / overview', dimensions: [
        ['Scope & purpose', 10], ['Literature foundation', 20], ['Selection transparency', 10],
        ['Synthesis rigor', 20], ['Critical appraisal/reflection', 15], ['Balance of evidence', 10],
        ['Limitations', 10], ['Transparency', 5]] }
};

const NAME_STOPWORDS = new Set(['and', 'of', 'the', 'across', 'und', 'der', 'die', 'das']);

function dimensionTokens(name) {
    return new Set(String(name || '').normalize('NFKC').toLowerCase().replace(/&/g, ' and ')
        .split(/[^\p{L}\p{N}]+/u).filter(t => t && !NAME_STOPWORDS.has(t)));
}

function tokenSimilarity(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    a.forEach(t => { if (b.has(t)) inter++; });
    return inter / (a.size + b.size - inter);
}

function preferredRubricKey(extraction, appraisal) {
    const docType = String(appraisal?.document_type_confirmed || extraction?.document_type || '').toLowerCase();
    const family = String(extraction?.study_family || '').toLowerCase();
    if (docType === 'systematic_review') return 'review';
    if (docType === 'narrative_review') return 'narrative';
    if (docType === 'methodological_paper') return 'methodological';
    if (docType === 'theoretical_conceptual_paper') return 'theoretical';
    if (docType === 'multiple_study_report') return 'multiple';
    if (family.includes('mixed')) return 'mixed';
    if (family.includes('qualitative')) return 'qualitative';
    if (family.includes('quantitative')) return 'quantitative';
    return null;
}

// Ordnet die vom Modell gelieferten Dimensionsnamen der passendsten Rubrik zu. Jede Rubrik-Dimension
// wird höchstens einmal vergeben; ohne ausreichende Übereinstimmung bleibt es bei den Modell-Gewichten.
const DIMENSION_MATCH_THRESHOLD = 0.5;

function matchCASQRubric(dimensionNames, preferredKey) {
    const names = dimensionNames.map(n => ({ name: n, tokens: dimensionTokens(n) }));
    let best = null;
    for (const [key, rubric] of Object.entries(CASQ_RUBRICS)) {
        const pairs = [];
        names.forEach((n, i) => rubric.dimensions.forEach(([rName], j) => {
            const sim = tokenSimilarity(n.tokens, dimensionTokens(rName));
            if (sim >= DIMENSION_MATCH_THRESHOLD) pairs.push({ i, j, sim });
        }));
        pairs.sort((x, y) => y.sim - x.sim);
        const usedNames = new Set(), usedDims = new Set(), mapping = new Map();
        for (const pr of pairs) {
            if (usedNames.has(pr.i) || usedDims.has(pr.j)) continue;
            usedNames.add(pr.i); usedDims.add(pr.j);
            const [rName, weight] = rubric.dimensions[pr.j];
            mapping.set(pr.i, { rubricName: rName, weight });
        }
        const better = !best || mapping.size > best.mapping.size || (mapping.size === best.mapping.size && key === preferredKey);
        if (better) best = { key, mapping };
    }
    if (!best || !names.length || best.mapping.size < Math.ceil(names.length / 2)) return null;
    return best;
}

function hasVerifiedRef(dim) {
    return Array.isArray(dim?.source_refs) && dim.source_refs.some(r => r && r.verified);
}

function calculateValidatedCASQ(validation, appraisal, extraction) {
    const validated = Array.isArray(validation?.validated_dimensions) ? validation.validated_dimensions : [];
    const fallback = Array.isArray(appraisal?.dimensions) ? appraisal.dimensions.map(d => ({
        name: d.name, adjusted_score: d.score, weight: d.weight,
        source_refs: Array.isArray(d.evidence) ? d.evidence : [],
        validation_status: d.status === 'not_applicable' ? 'not_applicable' : 'partially_supported'
    })) : [];
    const dims = validated.length ? validated : fallback;
    const appraisalWeights = new Map((appraisal?.dimensions || []).map(d => [String(d.name || '').toLowerCase(), Number(d.weight) || 0]));

    const rubricMatch = matchCASQRubric(dims.map(d => d.name), preferredRubricKey(extraction, appraisal));
    const weightFor = (d, i) => {
        if (rubricMatch) return rubricMatch.mapping.get(i)?.weight ?? 0;
        const originalWeight = appraisalWeights.get(String(d.name || '').toLowerCase());
        return Number.isFinite(originalWeight) ? originalWeight : (Number(d.weight) || 0);
    };

    let weighted = 0, weights = 0;
    let weightedMin = 0, weightedMax = 0, weightsRange = 0;
    let applicableWeight = 0, verifiedWeight = 0;
    const details = [];

    dims.forEach((d, i) => {
        const weight = weightFor(d, i);
        const status = d.validation_status;
        const score = Number(d.adjusted_score);
        const verified = hasVerifiedRef(d);
        const detail = { name: d.name, rubric_name: rubricMatch?.mapping.get(i)?.rubricName || null, weight, status, verified, counted: false };
        details.push(detail);
        if (status === 'not_applicable' || weight <= 0) return;
        applicableWeight += weight;
        const missing = ['unsupported', 'insufficient_information'].includes(status) || !Number.isFinite(score);
        // Spanne: fehlende Information einmal als 0 und einmal als 10 Punkte gerechnet.
        weightsRange += weight;
        if (missing) { weightedMax += 10 * weight; return; }
        const bounded = Math.max(0, Math.min(10, score));
        weighted += bounded * weight; weights += weight;
        weightedMin += bounded * weight; weightedMax += bounded * weight;
        detail.counted = true;
        if (verified) verifiedWeight += weight;
    });

    const score = weights > 0 ? weighted / weights : null;
    // Evidenzabdeckung = Gewichtsanteil der anwendbaren Dimensionen, die bewertet wurden UND einen
    // im PDF-Text wiedergefundenen Beleg haben. Die Selbstauskunft des Modells wird nur noch mitgeführt.
    const coverage = applicableWeight > 0 ? Math.round(verifiedWeight / applicableWeight * 100) : 0;
    const agentCoverage = Number(validation?.evidence_coverage);
    return {
        score,
        coverage,
        score_min: weightsRange > 0 && score !== null ? weightedMin / weightsRange : null,
        score_max: weightsRange > 0 && score !== null ? weightedMax / weightsRange : null,
        agent_coverage: Number.isFinite(agentCoverage) ? Math.max(0, Math.min(100, agentCoverage)) : null,
        weights_source: rubricMatch ? 'rubric' : 'agent',
        rubric: rubricMatch ? rubricMatch.key : null,
        rubric_label: rubricMatch ? CASQ_RUBRICS[rubricMatch.key].label : null,
        dimensions: details,
        scoring_version: SCORING_VERSION
    };
}

function isFiniteScore(value) {
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function formatCASQ(value) {
    return isFiniteScore(value) ? `${Number(value).toFixed(1)} / 10` : 'nicht berechenbar';
}

function formatCASQRange(min, max) {
    if (!isFiniteScore(min) || !isFiniteScore(max) || Math.abs(Number(max) - Number(min)) < 0.05) return '';
    return `Spanne ${Number(min).toFixed(1)}–${Number(max).toFixed(1)}`;
}

// Ersetzt Platzhalter wörtlich und in einem Durchgang. String.replace mit einem String als Ersatz würde
// $&, $' und $` im PDF-Text als Sonderzeichen auswerten; eingesetzter Text wird nicht erneut durchsucht.
function fillTemplate(template, values) {
    return String(template).replace(/\{\{(\w+)\}\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);
}

function qualityLabel(score, coverage) {
    if (score === null || coverage < 50) return 'UNSICHER / ZU WENIG EVIDENZ';
    if (score >= 8.0) return 'SEHR HOCH';
    if (score >= 6.5) return 'HOCH';
    if (score >= 5.0) return 'MITTEL';
    return 'NIEDRIG';
}

function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        parseJSONRobust, buildEvidenceContext, normalizeForMatch, findQuoteOnPages,
        verifyExtractionEvidenceRefs, verifySourceRefs, verifyFrameworkEvidence, verifyEstablishedEvidence, verifyJARSEvidence,
        calculateJARSMetrics, calculateEstablishedResult, countFrameworkItems, calculateFrameworkMetrics,
        calculateValidatedCASQ, matchCASQRubric, CASQ_RUBRICS, SCORING_VERSION,
        isFiniteScore, formatCASQ, formatCASQRange, qualityLabel, escapeHTML, fillTemplate
    };
}
