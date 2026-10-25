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
const SCORING_VERSION = '2026-10-casq2-5';

const PEDRO_SCORED_ITEMS = ['2','3','4','5','6','7','8','9','10','11'];
const AMSTAR2_CRITICAL_ITEMS = new Set(['2','4','7','9','11','13','15']);

// CASQ-Rubriken: feste Gewichte je Dimension (wie bisher) und je Dimension konkrete, im Text prüfbare
// Prüffragen (CASQ 2.0). Das Modell beantwortet nur die Fragen; Punkte, Gewichte und Deckelung rechnet
// der Code. Mit "!" markierte Fragen sind kritisch: Ein "no" oder "not_reported" begrenzt den CASQ.
// Mit "#" markierte Fragen sind Berichtspunkte einer Reporting-Leitlinie (z.B. PRISMA 2020); daraus ergibt sich ein
// getrennt ausgewiesener interner Erfüllungsgrad (kein offizieller Score).
function defineRubric(prefix, label, dims, reportingLabel) {
    return {
        label, prefix, reportingLabel: reportingLabel || null,
        dimensions: dims.map(([name, weight, questions], i) => ({
            name, weight,
            questions: questions.map((q, j) => ({
                id: `${prefix}-${i + 1}.${j + 1}`,
                text: q.replace(/^[!#\s]+/, ''),
                critical: /^[!#\s]*!/.test(q),
                reporting: /^[!#\s]*#/.test(q)
            }))
        }))
    };
}

const CASQ_RUBRICS = {
    quantitative: defineRubric('QN', 'Quantitativ', [
        ['Research question & theory', 10, [
            'Forschungsfrage oder Ziel ist explizit formuliert.',
            'Hypothesen bzw. erwartete Zusammenhänge sind vorab benannt.',
            'Theoretischer Rahmen oder Vorbefunde begründen die Fragestellung.']],
        ['Design appropriateness', 15, [
            'Das Studiendesign ist explizit benannt.',
            '! Das Design kann die Fragestellung beantworten (z.B. kausale Aussagen nur mit dafür geeignetem Design).',
            'Eine Vergleichs- oder Kontrollbedingung ist vorhanden, soweit die Fragestellung sie erfordert.']],
        ['Sample & external validity', 15, [
            'Zielpopulation sowie Ein- und Ausschlusskriterien sind beschrieben.',
            'Rekrutierung bzw. Stichprobenziehung ist beschrieben.',
            'Der Stichprobenumfang ist begründet (z.B. Power-Analyse).',
            'Rücklauf, Ausfälle bzw. Drop-outs sind berichtet.',
            'Merkmale der Stichprobe sind berichtet (z.B. Tabelle).']],
        ['Measurement quality', 15, [
            'Zentrale Konstrukte bzw. Outcomes sind operationalisiert (Instrument/Messverfahren benannt).',
            'Reliabilität der Messinstrumente ist berichtet oder mit Quelle belegt.',
            'Validität der Messinstrumente ist berichtet oder mit Quelle belegt.']],
        ['Statistical analysis', 15, [
            'Die Analyseverfahren sind nachvollziehbar beschrieben.',
            '! Die Verfahren passen zu Datenniveau, Design und Fragestellung.',
            'Effektgrößen und Konfidenzintervalle (nicht nur p-Werte) sind berichtet.',
            'Der Umgang mit fehlenden Daten ist beschrieben.']],
        ['Bias & internal validity', 15, [
            '! Confounding bzw. Gruppenunterschiede werden kontrolliert (z.B. Randomisierung, Adjustierung).',
            'Verblindung oder andere Maßnahmen gegen Mess- bzw. Beobachtungsverzerrung sind beschrieben, soweit möglich.',
            'Eine Präregistrierung oder vorab festgelegte Analysen sind belegt.']],
        ['Results interpretation', 5, [
            'Die Schlussfolgerungen gehen nicht über die Daten hinaus (keine unbegründete Kausalität oder Verallgemeinerung).',
            'Die Ergebnisse werden im Kontext bisheriger Forschung eingeordnet.']],
        ['Transparency & reproducibility', 5, [
            'Daten, Analysecode oder Materialien sind verfügbar oder der Zugang ist beschrieben.',
            'Finanzierung und Interessenkonflikte sind offengelegt.']],
        ['Limitations', 5, [
            'Limitationen werden konkret benannt.',
            'Mögliche Auswirkungen der Limitationen auf die Ergebnisse werden diskutiert.']]
    ]),
    qualitative: defineRubric('QL', 'Qualitativ', [
        ['Research question & fit', 10, [
            'Forschungsfrage oder Ziel ist explizit formuliert.',
            'Der qualitative Zugang ist für die Fragestellung begründet.',
            'Die methodologische Tradition ist benannt (z.B. Grounded Theory, Phänomenologie, Inhaltsanalyse).']],
        ['Sampling strategy', 15, [
            'Die Auswahlstrategie ist beschrieben und begründet (z.B. purposive, theoretisches Sampling).',
            'Teilnehmende und Setting sind beschrieben.',
            'Ein Kriterium für den Stichprobenumfang ist genannt (z.B. Sättigung).']],
        ['Data collection quality', 15, [
            'Die Erhebungsmethode ist beschrieben (z.B. Interview, Fokusgruppe, Beobachtung).',
            'Leitfaden oder Erhebungsinstrument ist zugänglich oder inhaltlich beschrieben.',
            'Aufzeichnung und Transkription sind beschrieben.']],
        ['Reflexivity', 10, [
            'Rolle, Hintergrund und Vorannahmen der Forschenden werden reflektiert.',
            'Die Beziehung zwischen Forschenden und Teilnehmenden ist beschrieben.']],
        ['Analytic rigor', 20, [
            '! Die Analysemethode ist benannt und ihre Schritte sind beschrieben.',
            'Die Kodierung ist nachvollziehbar (z.B. Kategoriensystem, Beispiele).',
            'Mehrere Kodierende oder ein Konsensverfahren sind beschrieben.',
            'Die Befunde sind mit Zitaten aus den Daten belegt.']],
        ['Credibility / triangulation / saturation', 15, [
            'Verfahren zur Absicherung sind beschrieben (z.B. Triangulation, Member Checking, Peer Debriefing).',
            'Abweichende oder widersprechende Fälle werden berücksichtigt.',
            'Sättigung bzw. Vollständigkeit der Analyse ist begründet.']],
        ['Transferability', 5, [
            'Der Kontext ist so beschrieben, dass sich die Übertragbarkeit beurteilen lässt.']],
        ['Transparency', 5, [
            'Ethikvotum und Einwilligung der Teilnehmenden sind berichtet.',
            'Finanzierung und Interessenkonflikte sind offengelegt.']],
        ['Limitations', 5, [
            'Limitationen werden konkret benannt.']]
    ]),
    mixed: defineRubric('MM', 'Mixed Methods', [
        ['Research question & design fit', 10, [
            'Der Einsatz von Mixed Methods ist für die Fragestellung begründet.',
            'Das Mixed-Methods-Design ist benannt (z.B. konvergent, explanativ-sequenziell).']],
        ['Quantitative component', 25, [
            'Die Stichprobe der quantitativen Komponente ist beschrieben.',
            'Die Messinstrumente sind beschrieben und angemessen.',
            'Die quantitative Analyse ist angemessen und nachvollziehbar.']],
        ['Qualitative component', 25, [
            'Auswahl und Datenerhebung der qualitativen Komponente sind beschrieben.',
            'Die qualitative Analysemethode ist beschrieben.',
            'Die qualitativen Befunde sind mit Daten belegt.']],
        ['Integration quality', 25, [
            '! Die Integration der Komponenten ist explizit beschrieben (wann und wie).',
            'Die Ergebnisse beider Komponenten werden zusammengeführt (z.B. Joint Display).',
            'Abweichungen zwischen den Komponenten werden adressiert.']],
        ['Inference quality', 10, [
            'Die Gesamtschlüsse stützen sich auf beide Komponenten.',
            'Limitationen beider Komponenten werden benannt.']],
        ['Transparency', 5, [
            'Daten oder Materialien sind verfügbar oder beschrieben.',
            'Finanzierung und Interessenkonflikte sind offengelegt.']]
    ]),
    review: defineRubric('RV', 'Systematisches Review', [
        ['Question & protocol', 10, [
            'Die Fragestellung ist strukturiert formuliert (z.B. PICO).',
            'Ein vorab registriertes oder veröffentlichtes Protokoll ist belegt (z.B. PROSPERO).']],
        ['Search strategy', 20, [
            '! Mindestens zwei Literaturdatenbanken wurden durchsucht.',
            'Die Suchstrings sind berichtet.',
            'Suchzeitraum und Datum der Suche sind angegeben.',
            'Weitere Quellen wurden berücksichtigt (z.B. Referenzlisten, graue Literatur, Register).']],
        ['Screening & study selection', 15, [
            'Ein- und Ausschlusskriterien sind explizit.',
            'Die Auswahl erfolgte durch mindestens zwei Personen unabhängig.',
            'Ein Flussdiagramm mit Zahlen liegt vor (z.B. PRISMA).']],
        ['Critical appraisal', 15, [
            '! Das Risk of Bias der eingeschlossenen Studien wurde mit einem benannten Instrument bewertet.',
            'Die Ergebnisse dieser Bewertung sind je Studie berichtet.']],
        ['Data extraction', 10, [
            'Die Datenextraktion erfolgte standardisiert (z.B. Formular).',
            'Die Extraktion wurde doppelt durchgeführt oder kontrolliert.']],
        ['Synthesis method', 15, [
            'Die Synthesemethode ist benannt und begründet.',
            'Bei einer Meta-Analyse ist das statistische Modell angemessen beschrieben.',
            'Die Merkmale der eingeschlossenen Studien sind tabellarisch berichtet.']],
        ['Heterogeneity/publication bias', 10, [
            'Heterogenität wurde untersucht (z.B. I², Subgruppen).',
            'Publikationsbias wurde geprüft oder diskutiert.']],
        ['Transparency', 5, [
            'Finanzierung und Interessenkonflikte sind offengelegt.',
            'Extraktionstabellen oder Daten sind verfügbar.']]
    ]),
    theoretical: defineRubric('TH', 'Theoretisch', [
        ['Conceptual clarity', 15, [
            'Die zentralen Begriffe sind definiert.',
            'Die Abgrenzung zu verwandten Konzepten ist dargestellt.']],
        ['Literature foundation', 20, [
            'Die einschlägige Literatur ist aufgearbeitet.',
            'Gegenpositionen werden berücksichtigt.',
            'Zentrale Aussagen sind mit Quellen belegt.']],
        ['Logical coherence', 20, [
            '! Die Argumentation ist in nachvollziehbaren Schritten aufgebaut.',
            'Die Schlussfolgerungen folgen aus den dargelegten Prämissen.',
            'Die Argumentation ist frei von erkennbaren Widersprüchen.']],
        ['Novelty', 10, [
            'Der neue Beitrag gegenüber bestehender Theorie ist explizit benannt.']],
        ['Boundary conditions', 10, [
            'Geltungsbereich und Randbedingungen der Aussagen sind genannt.']],
        ['Testability', 10, [
            'Es werden überprüfbare Aussagen oder Propositionen abgeleitet.',
            'Es gibt Hinweise, wie die Aussagen empirisch geprüft werden können.']],
        ['Integration', 10, [
            'Der Beitrag wird in bestehende Theorien eingeordnet.']],
        ['Limitations & transparency', 5, [
            'Grenzen des Ansatzes werden benannt.',
            'Finanzierung und Interessenkonflikte sind offengelegt.']]
    ]),
    methodological: defineRubric('MT', 'Methodenbeitrag', [
        ['Methodological objective & scope', 10, [
            'Ziel und Anwendungsbereich der Methode bzw. des Instruments sind benannt.',
            'Die Zielgruppe der Anwendung ist benannt.']],
        ['Conceptual/methodological foundation', 15, [
            'Die methodischen Grundlagen werden hergeleitet.',
            'Der Bezug zu etablierten Methoden ist dargestellt.']],
        ['Description of methods/instruments', 20, [
            '! Das Vorgehen ist so beschrieben, dass andere es anwenden können.',
            'Instrumente oder Materialien sind beschrieben oder zugänglich.',
            'Entscheidungs- bzw. Auswertungsregeln sind beschrieben.']],
        ['Empirical support/examples', 15, [
            'Die Anwendung wird an Beispielen oder Daten gezeigt.',
            'Empirische Belege sind mit Quellen versehen.']],
        ['Validity & reliability discussion', 15, [
            'Gütekriterien werden diskutiert.',
            'Belege zu Reliabilität bzw. Validität werden berichtet.']],
        ['Critical reflection of strengths/limitations', 10, [
            'Grenzen und Fehlerquellen der Methode werden benannt.',
            'Es wird gegenüber alternativen Methoden abgewogen.']],
        ['Reproducibility/transferability', 5, [
            'Voraussetzungen für die Übertragung auf andere Kontexte sind benannt.']],
        ['Literature integration', 5, [
            'Der Beitrag ist in die Methodenliteratur eingeordnet.']],
        ['Transparency', 5, [
            'Materialien oder Code sind verfügbar.',
            'Finanzierung und Interessenkonflikte sind offengelegt.']]
    ]),
    multiple: defineRubric('MS', 'Multiple-study report', [
        ['Overarching research logic', 10, [
            'Ein gemeinsamer Rahmen und ein übergreifendes Ziel sind formuliert.',
            'Die Abfolge der Teilstudien ist begründet.']],
        ['Transparency of individual study methods', 15, [
            '! Die Methoden jeder Teilstudie sind berichtet.',
            'Die Stichprobe jeder Teilstudie ist beschrieben.']],
        ['Adequacy of designs across studies', 15, [
            'Die Designs passen zu den jeweiligen Teilfragen.',
            'Die Designwahl erlaubt Replikation oder Konvergenz der Befunde.']],
        ['Measurement quality across studies', 10, [
            'Die Messinstrumente sind benannt.',
            'Reliabilität bzw. Validität der Instrumente ist berichtet.']],
        ['Statistical/analytic rigor across studies', 10, [
            'Die Analysen sind nachvollziehbar beschrieben.',
            'Effektgrößen bzw. Konfidenzintervalle sind berichtet.']],
        ['Integration and progression across studies', 15, [
            'Die Teilstudien bauen erkennbar aufeinander auf.',
            'Die Ergebnisse werden über die Teilstudien hinweg zusammengeführt.']],
        ['Cross-study interpretation', 10, [
            'Es gibt eine Gesamtdiskussion über alle Teilstudien.',
            'Die Gesamtschlüsse gehen nicht über die Daten hinaus.']],
        ['Limitations/bias reflection', 10, [
            'Limitationen sind je Teilstudie oder insgesamt benannt.',
            'Mögliche Verzerrungen werden diskutiert.']],
        ['Reproducibility/transparency', 5, [
            'Daten, Materialien oder Präregistrierungen sind verfügbar.',
            'Finanzierung und Interessenkonflikte sind offengelegt.']]
    ]),
    narrative: defineRubric('NR', 'Narrative Übersicht', [
        ['Scope & purpose', 10, [
            'Ziel und Fragestellung der Übersicht sind formuliert.',
            'Rahmen bzw. Zielgruppe der Übersicht sind benannt.']],
        ['Literature foundation', 20, [
            'Ein breites Spektrum einschlägiger Quellen wird berücksichtigt.',
            'Aktuelle Literatur wird berücksichtigt.',
            '! Zentrale Aussagen sind mit Quellen belegt.']],
        ['Selection transparency', 10, [
            'Das Vorgehen bei der Literaturauswahl ist beschrieben.']],
        ['Synthesis rigor', 20, [
            'Die Befunde werden strukturiert zusammengeführt.',
            'Unterschiede zwischen Studien werden herausgearbeitet.']],
        ['Critical appraisal/reflection', 15, [
            'Die Qualität der zitierten Studien wird berücksichtigt.',
            'Die Stärke der Evidenz wird bei Aussagen unterschieden.']],
        ['Balance of evidence', 10, [
            'Widersprechende Befunde werden dargestellt.']],
        ['Limitations', 10, [
            'Die Grenzen der Übersicht werden benannt.']],
        ['Transparency', 5, [
            'Finanzierung und Interessenkonflikte sind offengelegt.']]
    ]),
    // Fachspezifische Rubriken für Marketing, Medien, Digitalisierung, E-Commerce und Handel.
    // Kriterien sind aus etablierten Methodenempfehlungen abgeleitet (siehe RUBRIC_REFERENCES); es sind keine offiziellen Scores.
    survey_sem: defineRubric('SM', 'Befragung / SEM / PLS-SEM', [
        ['Research question & model justification', 8, [
            'Forschungsfrage und Hypothesen sind explizit formuliert und theoretisch begründet.',
            'Das Strukturmodell (Konstrukte und Pfade) ist nachvollziehbar dargestellt.',
            'Die Wahl des Verfahrens (PLS-SEM bzw. kovarianzbasierte SEM) ist begründet.']],
        ['Sampling & response quality', 12, [
            'Grundgesamtheit und Stichprobenziehung bzw. Rekrutierung sind beschrieben.',
            'Rücklauf, Ausschlüsse und Datenbereinigung (z.B. Aufmerksamkeitsprüfungen) sind berichtet.',
            'Non-Response-Bias oder die Repräsentativität der Stichprobe werden geprüft oder diskutiert.',
            'Merkmale der Stichprobe sind berichtet.']],
        ['Statistical power & sample adequacy', 8, [
            '! Der Stichprobenumfang ist begründet (Power-Analyse, Mindestumfang-Regel oder Verhältnis zum Modell).',
            'Der Umgang mit fehlenden Daten ist beschrieben.']],
        ['Construct operationalization', 10, [
            'Alle Konstrukte sind mit Items operationalisiert und die Messmodelle (reflektiv bzw. formativ) sind begründet.',
            'Die Skalen stammen aus etablierten Quellen oder ihre Entwicklung ist beschrieben.',
            'Itemformulierungen, Antwortformat und Erhebungssprache bzw. Übersetzung sind dokumentiert.']],
        ['Indicator reliability', 6, [
            'Indikatorladungen sind berichtet und anhand üblicher Schwellenwerte bewertet.']],
        ['Internal consistency', 6, [
            'Interne Konsistenz bzw. Konstruktreliabilität (z.B. Cronbachs Alpha, rho_A, Composite Reliability) ist berichtet.']],
        ['Convergent validity', 6, [
            'Konvergenzvalidität ist berichtet (z.B. durchschnittlich extrahierte Varianz, AVE).']],
        ['Discriminant validity', 8, [
            '! Diskriminanzvalidität ist geprüft (z.B. HTMT oder Fornell-Larcker) und die Ergebnisse sind berichtet.']],
        ['Structural model evaluation', 12, [
            'Kollinearität im Strukturmodell wird geprüft (z.B. VIF).',
            'Pfadkoeffizienten sind mit Signifikanz bzw. Konfidenzintervallen (z.B. Bootstrapping mit Angabe der Resamples) berichtet.',
            'Erklärte Varianz (R²) und Effektstärken (f²) sind berichtet.',
            '! Die Interpretation der Pfade bleibt im Rahmen des Designs (keine unbegründeten Kausalaussagen aus Querschnittsdaten).']],
        ['Predictive assessment', 6, [
            'Die Vorhersagekraft wird über die Erklärkraft hinaus geprüft (z.B. PLSpredict, Out-of-Sample) oder ihr Fehlen wird begründet.']],
        ['Common method bias', 8, [
            'Common Method Bias ist durch Verfahren (Design) oder Statistik (z.B. Marker-Variable, Full-Collinearity-VIF) adressiert.']],
        ['Robustness', 6, [
            'Robustheits- oder Alternativanalysen sind berichtet (z.B. alternative Modelle, Mediation/Moderation geprüft, Endogenität).']],
        ['Transparency & limitations', 4, [
            'Limitationen werden konkret benannt.',
            'Fragebogen, Daten oder Analysecode sind verfügbar oder der Zugang ist beschrieben.']]
    ]),
    experiment: defineRubric('EX', 'Experiment / A/B-Test', [
        ['Research question & hypotheses', 8, [
            'Forschungsfrage und Hypothesen sind vorab formuliert und theoretisch begründet.',
            'Unabhängige und abhängige Variablen sind klar benannt.']],
        ['Design & random assignment', 14, [
            'Das Experimentaldesign ist benannt (z.B. between-/within-subjects, Feld-, Labor-, Online-Experiment).',
            '! Die Zuordnung zu den Bedingungen ist zufällig (Between-Subjects) bzw. die Reihenfolge der Bedingungen ist randomisiert oder ausbalanciert (Within-Subjects); eine fehlende Zufallszuteilung ist begründet und kontrolliert.',
            'Das Zuteilungsverfahren (Randomisierung, Blockbildung, Auslieferung beim A/B-Test) ist beschrieben.']],
        ['Experimental control & manipulation', 12, [
            'Die Manipulation ist konkret beschrieben (Stimuli, Dauer, Ablauf).',
            '! Die Wirksamkeit der Manipulation ist belegt (Manipulationscheck oder Pretest der Stimuli). Besteht die Manipulation nur aus objektiv definierten Reizunterschieden (z.B. sprachliche oder physikalische Reizkategorien), ist die Frage nicht anwendbar.',
            'Eine geeignete Kontroll- bzw. Vergleichsbedingung ist vorhanden.']],
        ['Stimulus realism & construct validity', 8, [
            'Die Stimuli sind realistisch bzw. ihre Auswahl ist begründet (z.B. Pretest, reale Marken oder fiktive Marken mit Begründung).',
            'Die Operationalisierung der Konstrukte entspricht dem theoretischen Konstrukt.']],
        ['Sample, power & exclusions', 14, [
            'Stichprobe und Rekrutierung (z.B. Panel, Studierende, Kundenstamm) sind beschrieben.',
            'Der Stichprobenumfang ist begründet (Power-Analyse, Simulation oder Orientierung an vergleichbaren Studien).',
            'Aufmerksamkeitskontrollen und Ausschlusskriterien sind vorab festgelegt und berichtet.',
            'Ausfälle je Bedingung (Attrition) sind berichtet.']],
        ['Measurement', 8, [
            'Abhängige Variablen und Messinstrumente sind benannt.',
            'Reliabilität bzw. Validität der Messung ist berichtet oder mit Quelle belegt.']],
        ['Statistical analysis', 14, [
            'Die Analyseverfahren sind nachvollziehbar beschrieben.',
            '! Die Verfahren passen zu Design und Daten (z.B. Berücksichtigung von Messwiederholung, Voraussetzungen geprüft).',
            'Effektgrößen mit Konfidenzintervallen (nicht nur p-Werte) sind berichtet.',
            'Mehrfachtests werden berücksichtigt bzw. die Zahl der Tests ist transparent.']],
        ['Confounds & internal validity', 10, [
            '! Mögliche Störvariablen und Alternativerklärungen werden kontrolliert oder diskutiert (z.B. Demand-Effekte, Reihenfolge, Selbstselektion).',
            'Bei Feld- und A/B-Tests: Laufzeit, Traffic-Zuweisung und Störeinflüsse (z.B. Saison, parallele Aktionen) sind beschrieben.']],
        ['Robustness & transparency', 6, [
            'Robustheitsanalysen oder eine Replikation (auch in Folgestudien desselben Artikels) sind berichtet.',
            'Präregistrierung, Materialien oder Daten sind verfügbar, soweit relevant.']],
        ['Interpretation & limitations', 6, [
            'Die Schlussfolgerungen gehen nicht über die Daten hinaus (Generalisierbarkeit, Praxisrelevanz).',
            'Limitationen werden konkret benannt.']]
    ]),
    platform_data: defineRubric('PD', 'Plattform- / Social-Media- / Big-Data-Studie', [
        ['Research question & claims', 6, [
            'Forschungsfrage und Ziel sind explizit formuliert.',
            'Der Geltungsbereich der Aussagen (Plattform, Zeitraum, Population) ist benannt.']],
        ['Data provenance', 14, [
            '! Die Herkunft der Daten ist benannt (API, Scraping, kommerzieller Datensatz, interne Systeme, Panel).',
            'Zugang, Erhebungszeitraum und Erhebungsweise (Suchbegriffe, Abfragen, Filter) sind beschrieben.',
            'Datenschutz- bzw. Nutzungsbedingungen der Quelle sind erwähnt.']],
        ['Sampling & selection', 14, [
            'Einschluss- und Ausschlusskriterien für Konten, Beiträge oder Transaktionen sind beschrieben.',
            '! Mögliche Selektionsverzerrung wird benannt und diskutiert (z.B. nur öffentliche Beiträge, nur aktive Nutzer, nur ein Händler).',
            'Umfang der Daten (Anzahl Konten, Beiträge, Transaktionen) und Zeitraum sind berichtet.']],
        ['Platform effects', 8, [
            'Einflüsse der Plattform werden berücksichtigt (z.B. Empfehlungsalgorithmus, API-Beschränkungen, Änderungen der Plattform im Zeitraum).']],
        ['Data integrity', 10, [
            'Bots, Fake-Konten, Spam oder Duplikate werden behandelt (Erkennung und Bereinigung).',
            'Der Umgang mit gelöschten, fehlenden oder unvollständigen Daten ist beschrieben.']],
        ['Measurement', 10, [
            'Zentrale Maße (z.B. Engagement, Sentiment, Conversion, Reichweite) sind eindeutig operationalisiert.',
            'Automatische Verfahren (z.B. Sentiment-, Themen- oder Klassifikationsmodell) sind validiert (z.B. manuell kodierte Stichprobe, Gütemaße).']],
        ['Analytics', 14, [
            'Die Analyse- bzw. Modellierungsverfahren sind nachvollziehbar beschrieben.',
            '! Bei Vorhersagemodellen: Trainings- und Testdaten sind getrennt und Datenlecks (Leakage) sind ausgeschlossen.',
            'Mehrfachtests bzw. die Zahl der geprüften Modelle und Hypothesen werden berücksichtigt.',
            'Robustheits- oder Sensitivitätsanalysen sind berichtet.']],
        ['Causal claims', 10, [
            '! Kausale Aussagen sind nur dann gemacht, wenn ein tragfähiges Identifikationsdesign vorliegt (z.B. Experiment, Instrument, Differenz-von-Differenzen); sonst werden nur Zusammenhänge formuliert.',
            'Alternative Erklärungen und Störgrößen werden diskutiert.']],
        ['Reproducibility', 6, [
            'Code, Daten oder Zugang zu den Daten sind verfügbar, oder Einschränkungen sind begründet.',
            'Modellparameter, Software und Versionen sind dokumentiert.']],
        ['Ethics & privacy', 6, [
            'Umgang mit personenbezogenen Daten (Anonymisierung, Rechtsgrundlage) ist beschrieben.',
            'Ethikvotum bzw. eine ethische Abwägung ist berichtet, soweit relevant.']],
        ['Limitations', 2, [
            'Limitationen werden konkret benannt.']]
    ]),
    review_business: defineRubric('RB', 'Systematisches Review (Management / Marketing / Digital)', [
        ['Rationale, objectives & protocol', 10, [
            '# Forschungslücke bzw. Begründung der Übersicht sind dargestellt.',
            '# Ziel und Forschungsfragen sind explizit formuliert.',
            '# Ein Protokoll bzw. das Vorgehen wurde vorab festgelegt oder registriert (z.B. OSF, PROSPERO) oder das Vorgehen folgt einem benannten Rahmen (z.B. SPAR-4-SLR, PRISMA).']],
        ['Identification (SPAR-4-SLR: Assembling)', 18, [
            '! # Mindestens zwei Literaturdatenbanken wurden durchsucht (z.B. Scopus, Web of Science, EBSCO).',
            '# Die vollständigen Suchstrings sind berichtet.',
            '# Suchzeitraum und Datum der Suche sind angegeben.',
            '# Weitere Quellen wurden berücksichtigt (z.B. Vorwärts-/Rückwärtssuche, Konferenzbeiträge, graue Literatur).',
            'Die Wahl der Datenbanken und Suchbegriffe ist begründet.']],
        ['Selection & screening (SPAR-4-SLR: Arranging/Purification)', 16, [
            '# Ein- und Ausschlusskriterien sind explizit.',
            '# Die Auswahl erfolgte durch mindestens zwei Personen unabhängig oder mit Konsensverfahren.',
            '# Ein Flussdiagramm mit Zahlen je Schritt liegt vor (z.B. PRISMA-Diagramm).',
            '# Gründe für den Ausschluss nach der Volltextprüfung sind berichtet.']],
        ['Data extraction & coding', 10, [
            '# Ein Kodierschema bzw. Extraktionsformular ist beschrieben.',
            '# Die Kodierung erfolgte doppelt oder wurde kontrolliert (z.B. Übereinstimmung der Kodierenden).']],
        ['Quality appraisal (SPAR-4-SLR: Assessing)', 12, [
            '! # Die Qualität bzw. Verzerrungsanfälligkeit der eingeschlossenen Studien wird mit einem benannten Verfahren bewertet (ein Journal-Ranking allein genügt nicht).',
            '# Die Ergebnisse der Qualitätsbewertung sind berichtet und fließen in die Synthese ein.']],
        ['Synthesis', 16, [
            '# Die Synthesemethode ist benannt und begründet (z.B. thematisch, Framework-basiert, Meta-Analyse).',
            '# Die Merkmale der eingeschlossenen Studien sind tabellarisch berichtet.',
            '! Die Syntheseergebnisse (Themen, Framework) folgen nachvollziehbar aus den Daten.',
            '# Widersprüchliche Befunde und Heterogenität werden herausgearbeitet.']],
        ['Reporting bias & certainty', 6, [
            '# Verzerrungen durch die Auswahl (z.B. Publikationsbias, nur englische Quellen) werden diskutiert.',
            '# Die Belastbarkeit der Evidenz wird eingeschätzt.']],
        ['Contribution & future research', 6, [
            'Beitrag und Forschungsagenda ergeben sich aus den Befunden.',
            'Implikationen für Theorie oder Praxis sind abgeleitet.']],
        ['Transparency & limitations', 6, [
            '# Limitationen der Übersicht werden konkret benannt.',
            '# Finanzierung und Interessenkonflikte sind offengelegt.',
            '# Extraktionstabelle bzw. Daten sind verfügbar.']]
    ], 'PRISMA-2020-Berichtserfüllung'),
    bibliometric: defineRubric('BB', 'Bibliometrische Analyse', [
        ['Objective & scope', 10, [
            'Ziel und Forschungsfragen sind formuliert.',
            'Das untersuchte Feld bzw. Thema ist abgegrenzt.']],
        ['Data source & search', 20, [
            '! Die Datenbank ist benannt und ihre Wahl begründet (z.B. Scopus, Web of Science).',
            '! Der vollständige Suchstring ist berichtet.',
            'Zeitraum und Abfragedatum sind angegeben.',
            'Filter nach Dokumenttyp, Sprache und Fachgebiet sind beschrieben.']],
        ['Data cleaning', 14, [
            'Die Zahl der Dokumente je Schritt (Treffer, Ausschlüsse, Endmenge) ist berichtet.',
            'Deduplizierung und Bereinigung (z.B. Autorennamen, Schlagwort-Thesaurus) sind beschrieben.']],
        ['Methods & software', 16, [
            'Die Analyseverfahren (z.B. Co-Zitation, bibliografische Kopplung, Co-Word, Co-Autorschaft) sind benannt und begründet.',
            'Software und Version sind genannt (z.B. VOSviewer, Bibliometrix).',
            'Parameter sind berichtet (z.B. Schwellenwerte, Normalisierung, Cluster-Algorithmus).']],
        ['Validity of mapping', 12, [
            'Die Cluster bzw. Themen werden inhaltlich gedeutet und nicht nur algorithmisch übernommen.',
            'Die Robustheit gegenüber Parametern oder Datenwahl wird geprüft.']],
        ['Interpretation', 12, [
            '! Die Schlüsse gehen nicht über die bibliometrische Evidenz hinaus (Zitationszahlen sind kein Qualitätsurteil).',
            'Befunde werden eingeordnet und eine Forschungsagenda wird abgeleitet.']],
        ['Database limitations', 8, [
            'Verzerrungen der Datenbank (Abdeckung, Sprache, Disziplin) werden diskutiert.',
            'Limitationen werden konkret benannt.']],
        ['Reproducibility', 8, [
            'Daten, Suchstring oder Analyseskripte sind verfügbar oder der Zugang ist beschrieben.']]
    ]),
    case_study: defineRubric('CS', 'Fallstudie', [
        ['Research question & case logic', 12, [
            'Die Forschungsfrage ist explizit formuliert.',
            'Die Fallstudie als Methode ist für die Fragestellung begründet.',
            'Ein theoretischer Rahmen oder Propositionen leiten die Untersuchung.']],
        ['Case selection', 16, [
            '! Die Fallauswahl ist begründet (z.B. theoretisches Sampling, typischer, kritischer oder extremer Fall).',
            'Die Zahl der Fälle (Einzel- oder Mehrfallstudie) ist begründet.',
            'Fall und Kontext sind ausreichend beschrieben.']],
        ['Data sources & collection', 16, [
            'Mehrere Datenquellen werden genutzt (z.B. Interviews, Dokumente, Beobachtung).',
            'Umfang und Zeitraum der Erhebung sind berichtet (z.B. Zahl und Rollen der Befragten).',
            'Interviewleitfaden oder Erhebungsprotokoll sind beschrieben bzw. zugänglich.']],
        ['Triangulation & chain of evidence', 16, [
            '! Die Befunde werden durch Triangulation mehrerer Quellen oder Perspektiven abgesichert.',
            'Die Beweiskette ist nachvollziehbar (Aussagen sind mit Belegen aus den Daten verknüpft, z.B. Zitate, Dokumente).',
            'Verzerrungen durch einzelne Informanten werden berücksichtigt.']],
        ['Analysis (within-/cross-case)', 16, [
            '! Die Analysemethode ist benannt und ihre Schritte sind beschrieben.',
            'Eine Within-Case-Analyse der einzelnen Fälle liegt vor.',
            'Bei mehreren Fällen: ein Cross-Case-Vergleich ist durchgeführt.',
            'Die Kodierung ist nachvollziehbar und der Abgleich mit der Theorie erfolgt iterativ.']],
        ['Construct & theory building', 8, [
            'Konstrukte bzw. Schlussfolgerungen sind durch die Daten belegt.',
            'Die Befunde werden mit der Literatur verglichen.']],
        ['Credibility & reflexivity', 8, [
            'Gütesicherung ist beschrieben (z.B. Validierung durch Befragte, mehrere Forschende).',
            'Rolle und Vorannahmen der Forschenden werden reflektiert.']],
        ['Generalizability & limitations', 8, [
            'Die Verallgemeinerung wird als analytisch (theoriebezogen) und nicht statistisch eingeordnet.',
            'Limitationen werden konkret benannt.']]
    ]),
    scale_development: defineRubric('SD', 'Skalenentwicklung / -validierung', [
        ['Construct definition & content domain', 12, [
            'Das Konstrukt ist definiert und gegen verwandte Konstrukte abgegrenzt.',
            'Die erwartete Dimensionalität ist theoretisch begründet.']],
        ['Item generation', 12, [
            'Der Itempool stammt aus Literatur, qualitativen Vorstudien oder Expertenwissen.',
            'Die inhaltliche Validität wurde geprüft (z.B. Expertenurteil, Q-Sort, Delphi).']],
        ['Pretest & item purification', 10, [
            'Ein Pretest bzw. eine Pilotstudie ist beschrieben.',
            'Die Itemreduktion ist nachvollziehbar (Kriterien und Zahl der entfernten Items).']],
        ['Sample & data', 12, [
            '! Die Stichprobengröße ist für die Analysen angemessen und begründet.',
            'Für Exploration und Bestätigung werden unabhängige Stichproben genutzt.',
            'Die Stichproben sind beschrieben (Rekrutierung, Merkmale, Datenbereinigung).']],
        ['Dimensionality (EFA/CFA)', 16, [
            '! Die Faktorenstruktur ist geprüft (EFA und/oder CFA).',
            'Kriterien für Faktorenzahl und Itemauswahl sind berichtet (z.B. Ladungen, Kreuzladungen).',
            'Gütemaße des Modells sind berichtet (z.B. CFI, RMSEA, SRMR).']],
        ['Reliability', 10, [
            'Reliabilität je Dimension ist berichtet (z.B. Cronbachs Alpha, Composite Reliability).']],
        ['Validity', 18, [
            'Konvergenzvalidität ist berichtet (z.B. AVE).',
            '! Diskriminanzvalidität ist geprüft (z.B. Fornell-Larcker, HTMT).',
            'Nomologische bzw. Kriteriumsvalidität ist anhand verwandter Konstrukte oder Kriterien geprüft.',
            'Die Skala wird gegen etablierte Messinstrumente verglichen.']],
        ['Cross-validation & replication', 6, [
            'Die Struktur wurde an einer unabhängigen Stichprobe bestätigt (oder in weiteren Studien des Artikels).',
            'Messinvarianz, Test-Retest oder Stabilität der Skala wurden geprüft.']],
        ['Common method bias & limitations', 4, [
            'Common Method Bias wird adressiert und Limitationen werden benannt.']]
    ])
};

// Methodische Grundlage je Rubrik – wird bei jedem Ergebnis neben dem CASQ angezeigt. Die Rubriken sind keine
// offiziellen Instrumente; der CASQ ist ein intern berechneter Vergleichsindex.
const RUBRIC_REFERENCES = {
    survey_sem: 'Etablierte SEM-/PLS-SEM-Berichts- und Bewertungsempfehlungen (u. a. Hair, Risher, Sarstedt & Ringle 2019), Gütekriterien der Skalenmessung',
    experiment: 'Grundsätze experimenteller Forschung; Berichtsreferenz APA JARS (Reporting-Standard, kein Risk-of-Bias-Instrument)',
    review_business: 'PRISMA 2020 (Reporting-Leitlinie) und SPAR-4-SLR (Prozessrahmen für Reviews in Management und Marketing); ausgewiesen als interner Erfüllungsgrad, nicht als offizieller Score',
    bibliometric: 'Grundsätze bibliometrischer Analysen und ihrer Berichterstattung (aus der Methodenliteratur abgeleitet)',
    case_study: 'Fallstudien-Methodik im Sinne von Eisenhardt und Yin (Fallauswahl, Datenquellen, Triangulation, Beweiskette, Within-/Cross-Case-Analyse)',
    scale_development: 'Etablierte psychometrische Praxis der Skalenentwicklung in der Marketingforschung (Konstruktdefinition, Itemgenerierung, EFA/CFA, Reliabilität, Validität)',
    platform_data: 'Grundsätze der Computational- und Social-Media-Forschung (aus der Methodenliteratur abgeleitet)',
    quantitative: 'Allgemeine Methodenstandards der empirischen Forschung (intern abgeleitet)',
    qualitative: 'Allgemeine Gütekriterien qualitativer Forschung (intern abgeleitet)',
    mixed: 'Grundsätze der Mixed-Methods-Forschung (intern abgeleitet)',
    review: 'Grundsätze systematischer Reviews, u. a. PRISMA 2020 (Reporting-Leitlinie; hier nur als interner Erfüllungsgrad, kein offizieller PRISMA-Score)',
    theoretical: 'Allgemeine Kriterien theoretischer Beiträge (intern abgeleitet)',
    methodological: 'Allgemeine Kriterien von Methodenbeiträgen (intern abgeleitet)',
    multiple: 'Berichtskriterien für Artikel mit mehreren Studien (intern abgeleitet, angelehnt an APA JARS)',
    narrative: 'Allgemeine Kriterien narrativer Übersichten (intern abgeleitet)'
};
Object.entries(RUBRIC_REFERENCES).forEach(([key, text]) => { CASQ_RUBRICS[key].reference = text; });

// Methodenklasse einer Studie: Das Modell liefert method_class in der Extraktion; fehlt sie (ältere Läufe),
// wird sie aus Studiendesign, Methoden und Analyseverfahren abgeleitet.
const METHOD_CLASSES = ['survey_sem', 'experiment', 'platform_data', 'case_study', 'bibliometric', 'scale_development',
    'qualitative', 'other_quantitative', 'not_applicable'];
const RUBRIC_BY_METHOD_CLASS = { survey_sem: 'survey_sem', experiment: 'experiment', platform_data: 'platform_data',
    case_study: 'case_study', bibliometric: 'bibliometric', scale_development: 'scale_development' };

function methodClassOf(extraction) {
    const declared = String(extraction?.method_class || '').toLowerCase().trim();
    if (METHOD_CLASSES.includes(declared)) return declared;
    const list = v => Array.isArray(v) ? v.join(' ') : String(v ?? '');
    const text = [extraction?.study_design, list(extraction?.methods), list(extraction?.analysis_methods), list(extraction?.data_collection)].join(' ').toLowerCase();
    if (/bibliometric|science mapping|co-?citation|bibliographic coupling|vosviewer|bibliometrix/.test(text)) return 'bibliometric';
    if (/case stud|fallstudie/.test(text)) return 'case_study';
    if (/scale development|scale validation|skalenentwicklung|skalenvalidierung|measurement development|psychometric|exploratory factor/.test(text)) return 'scale_development';
    if (/pls[- ]?sem|smartpls|cb[- ]?sem|structural equation|strukturgleichung|\bsem\b/.test(text)) return 'survey_sem';
    if (/experiment|a\/b[- ]?test|between[- ]subjects|within[- ]subjects|randomi[sz]ed/.test(text)) return 'experiment';
    if (/scrap|clickstream|web[- ]?tracking|scanner data|transaction data|big data|text mining|topic model|sentiment analysis|machine learning|social media data|api data/.test(text)) return 'platform_data';
    if (/survey|questionnaire|befragung|fragebogen/.test(text)) return 'survey_sem';
    return 'other_quantitative';
}

// Gesundheits-/klinischer Kontext: nur dann gelten PEDro, MINORS, AMSTAR 2 und COSMIN als Kandidaten.
function isHealthContext(extraction) {
    const cc = extraction?.clinical_context || {};
    if (cc.is_health_clinical || cc.is_physiotherapy_rehabilitation || cc.is_surgical || cc.is_measurement_property_study || cc.is_PROM_study) return true;
    return /health|clinical|medic|patient|nurs|gesundheit|klinisch|pflege|physio|rehab/i.test(String(extraction?.research_domain || ''));
}

// Management-/Marketing-/Digitalbezug: dann gilt für systematische Reviews die Business-Rubrik (PRISMA/SPAR-4-SLR).
function isBusinessContext(extraction) {
    if (isHealthContext(extraction)) return false;
    return /business|marketing|manag|media|digital|commerce|retail|consumer|information system|social media|advertis|brand|wirtschaft|betriebs|handel|medien/i.test(String(extraction?.research_domain || ''));
}

const MEDICAL_INSTRUMENTS_HIDDEN_REASON = 'Fachgebiet ohne Gesundheitsbezug: die medizinischen Instrumente (PEDro, MINORS, AMSTAR 2, COSMIN) werden nicht angewendet. Die Bewertung erfolgt über die fachspezifischen Prüffragen (CASQ-Rubrik).';

// Ersetzt eine etablierte Bewertung durch "nicht anwendbar", wenn kein Gesundheitsbezug vorliegt und die
// medizinischen Instrumente nicht ausdrücklich zugelassen sind. Gibt true zurück, wenn etwas ersetzt wurde.
function restrictMedicalInstruments(holder, extraction, allowMedical) {
    if (!holder || allowMedical || isHealthContext(extraction)) return false;
    const stub = { instrument: 'none', applicable: false, applicability_reason: MEDICAL_INSTRUMENTS_HIDDEN_REASON, scope_note: '',
        scoring_type: 'none', official_score: null, official_max: null, official_rating: null, items: [], summary: '' };
    let changed = false;
    ['established_appraisal', 'validated_established_appraisal'].forEach(k => {
        if (holder[k] !== undefined && holder[k]?.applicable) { holder[k] = { ...stub }; changed = true; }
    });
    return changed;
}

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
    const empirical = ['', 'primary_empirical_study', 'systematic_review', 'narrative_review', 'other', 'unclear'].includes(docType);
    const methodClass = methodClassOf(extraction);
    if (methodClass === 'bibliometric' && empirical) return 'bibliometric';
    if (docType === 'systematic_review') return isBusinessContext(extraction) ? 'review_business' : 'review';
    if (docType === 'narrative_review') return 'narrative';
    if (docType === 'methodological_paper') return 'methodological';
    if (docType === 'theoretical_conceptual_paper') return 'theoretical';
    if (docType === 'multiple_study_report') return 'multiple';
    if (methodClass === 'case_study' && !family.includes('review')) return 'case_study';
    if (family.includes('mixed')) return 'mixed';
    if (family.includes('qualitative')) return 'qualitative';
    // Fachspezifische Rubrik nach Methodenklasse (Befragung/SEM, Experiment, Plattform-/Big-Data, Skalenentwicklung)
    if (family.includes('quantitative') || !family) {
        const byMethod = RUBRIC_BY_METHOD_CLASS[methodClass];
        // Klinische Studien (z.B. RCT) behalten die allgemeine quantitative Rubrik mit Verblindung und Zuteilung;
        // die Experiment-Rubrik ist auf Marketing-/Verhaltensexperimente zugeschnitten.
        if (byMethod && !(byMethod === 'experiment' && isHealthContext(extraction))) return byMethod;
    }
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
        names.forEach((n, i) => rubric.dimensions.forEach(({ name: rName }, j) => {
            const sim = tokenSimilarity(n.tokens, dimensionTokens(rName));
            if (sim >= DIMENSION_MATCH_THRESHOLD) pairs.push({ i, j, sim });
        }));
        pairs.sort((x, y) => y.sim - x.sim);
        const usedNames = new Set(), usedDims = new Set(), mapping = new Map();
        for (const pr of pairs) {
            if (usedNames.has(pr.i) || usedDims.has(pr.j)) continue;
            usedNames.add(pr.i); usedDims.add(pr.j);
            const { name: rName, weight } = rubric.dimensions[pr.j];
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

// ==========================================
// CASQ 2.0: Prüffragen statt freier Punkte
// ==========================================
const CASQ_RESPONSE_VALUE = { yes: 1, partial: 0.5, no: 0, not_reported: 0 };
const CASQ_DOWNGRADE = { yes: 'partial', partial: 'no' };
const CASQ_CAP_ONE_FLAW = 5;
const CASQ_CAP_MORE_FLAWS = 3;

function normalizeChecklistResponse(raw) {
    const r = String(raw ?? '').toLowerCase().trim().replace(/[\s-]+/g, '_');
    if (['yes', 'ja', 'erfüllt', 'fulfilled'].includes(r)) return 'yes';
    if (['partial', 'partially', 'partial_yes', 'teilweise'].includes(r)) return 'partial';
    if (['no', 'nein', 'not_fulfilled'].includes(r)) return 'no';
    if (['not_applicable', 'n/a', 'na', 'nicht_anwendbar'].includes(r)) return 'not_applicable';
    return 'not_reported';  // auch cant_tell, unclear, insufficient_information oder fehlende Antwort
}

// Rubrik für eine Publikation: aus Dokumenttyp bzw. Studienfamilie der Extraktion.
function selectCASQRubric(extraction) {
    const key = preferredRubricKey(extraction, null);
    if (key) return key;
    const family = String(extraction?.study_family || '').toLowerCase();
    if (family.includes('review')) return 'narrative';
    if (family.includes('theor')) return 'theoretical';
    if (family.includes('method')) return 'methodological';
    return 'quantitative';
}

function casqChecklistText(rubricKey) {
    const rubric = CASQ_RUBRICS[rubricKey];
    return rubric.dimensions.flatMap(dim => dim.questions.map(q =>
        `${q.id} [${dim.name}] ${q.text}${q.critical ? ' [KRITISCH]' : ''}`)).join('\n');
}

function checklistAnswers(list) {
    const map = new Map();
    (Array.isArray(list) ? list : []).forEach(a => { if (a && a.id) map.set(String(a.id).trim(), a); });
    return map;
}

// Antworten von Agent 4 (validiert) haben Vorrang vor denen von Agent 3.
function mergedChecklistAnswers(validation, appraisal) {
    const merged = checklistAnswers(appraisal?.casq_checklist);
    checklistAnswers(validation?.validated_casq_checklist).forEach((a, id) => merged.set(id, { ...a, validated: true }));
    return merged;
}

function verifyChecklistEvidence(validation, appraisal, pages) {
    [appraisal?.casq_checklist, validation?.validated_casq_checklist].forEach(list => {
        (Array.isArray(list) ? list : []).forEach(item => {
            const refs = Array.isArray(item?.evidence) ? item.evidence : [];
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
    return validation;
}

// Berechnet den CASQ aus den Prüffrage-Antworten:
//   yes = 1, partial = 0,5, no = 0, not_reported = 0, not_applicable entfällt
//   yes/partial ohne im PDF wiedergefundenes Zitat → eine Stufe herab
//   Dimension = 10 × Mittelwert, CASQ = gewichtetes Mittel der Dimensionen
//   kritische Frage mit no/not_reported → CASQ höchstens 5 (bei mehreren höchstens 3)
//   Spanne: Obergrenze, wenn alles nicht Berichtete erfüllt wäre
function calculateCASQ2(validation, appraisal, rubricKey) {
    const rubric = CASQ_RUBRICS[rubricKey];
    const answers = mergedChecklistAnswers(validation, appraisal);
    if (!rubric || !answers.size) return null;

    let weighted = 0, weightedMax = 0, weights = 0;
    let total = 0, decided = 0, claimed = 0, verifiedClaims = 0, missing = 0;
    const criticalFlaws = [], criticalNo = [];
    const dimensions = rubric.dimensions.map(dim => {
        const values = [], valuesMax = [];
        const questions = dim.questions.map(q => {
            const answer = answers.get(q.id);
            if (!answer) missing++;
            const response = normalizeChecklistResponse(answer?.response);
            const verified = Array.isArray(answer?.evidence) && answer.evidence.some(r => r && r.verified);
            const detail = { id: q.id, text: q.text, critical: q.critical, response, effective: response, verified,
                downgraded: false, validated: !!answer?.validated, evidence: answer?.evidence || [],
                note: answer?.validation_note || answer?.rationale || '' };
            if (response === 'not_applicable') return detail;
            if (CASQ_DOWNGRADE[response] && !verified) { detail.effective = CASQ_DOWNGRADE[response]; detail.downgraded = true; }
            total++;
            if (detail.effective !== 'not_reported') decided++;
            if (response === 'yes' || response === 'partial') { claimed++; if (verified) verifiedClaims++; }
            if (q.critical && (detail.effective === 'no' || detail.effective === 'not_reported')) criticalFlaws.push(q.id);
            if (q.critical && detail.effective === 'no') criticalNo.push(q.id);
            values.push(CASQ_RESPONSE_VALUE[detail.effective]);
            valuesMax.push(detail.effective === 'not_reported' ? 1 : CASQ_RESPONSE_VALUE[detail.effective]);
            return detail;
        });
        const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
        const score = values.length ? 10 * mean(values) : null;
        if (score !== null) {
            weighted += dim.weight * score;
            weightedMax += dim.weight * 10 * mean(valuesMax);
            weights += dim.weight;
        }
        return { name: dim.name, weight: dim.weight, score, questions };
    });
    if (!weights) return null;

    // Berichtserfüllung (z.B. PRISMA 2020): Anteil erfüllter Berichtspunkte, getrennt vom CASQ ausgewiesen
    let reporting = null;
    if (rubric.reportingLabel) {
        const items = dimensions.flatMap((d, i) => d.questions.filter((_, j) => rubric.dimensions[i].questions[j].reporting));
        const considered = items.filter(q => q.response !== 'not_applicable');
        if (considered.length) {
            const points = considered.reduce((a, q) => a + CASQ_RESPONSE_VALUE[q.effective], 0);
            reporting = { label: rubric.reportingLabel, compliance: points / considered.length, considered: considered.length,
                fulfilled: considered.filter(q => q.effective === 'yes').length };
        }
    }

    const capFor = flaws => flaws.length >= 2 ? CASQ_CAP_MORE_FLAWS : flaws.length === 1 ? CASQ_CAP_ONE_FLAW : 10;
    const raw = weighted / weights;
    const cap = capFor(criticalFlaws);
    const score = Math.min(raw, cap);
    const scoreMax = Math.max(score, Math.min(weightedMax / weights, capFor(criticalNo)));
    return {
        version: 'casq2',
        rubric: rubricKey,
        rubric_label: rubric.label,
        rubric_reference: rubric.reference || null,
        reporting,
        score,
        score_uncapped: raw,
        score_min: score,
        score_max: scoreMax,
        cap: cap < 10 ? cap : null,
        critical_flaws: criticalFlaws,
        information_grade: total ? decided / total : 0,
        evidence_rate: claimed ? verifiedClaims / claimed : null,
        unanswered: missing,
        dimensions,
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
        calculateValidatedCASQ, matchCASQRubric, CASQ_RUBRICS, RUBRIC_REFERENCES, METHOD_CLASSES, methodClassOf, isHealthContext, isBusinessContext, restrictMedicalInstruments, SCORING_VERSION,
        normalizeChecklistResponse, selectCASQRubric, casqChecklistText, verifyChecklistEvidence, calculateCASQ2,
        isFiniteScore, formatCASQ, formatCASQRange, qualityLabel, escapeHTML, fillTemplate
    };
}
