// ==========================================
// WORKFLOW AGENTEN
// ==========================================


// Hinweis an das Modell, wenn Seitenbilder angehängt sind
function visualNote(doc) {
    if (!doc.visuals?.length) return '';
    const list = doc.visuals.map(v => `S. ${v.page}${v.reason ? ` (${v.reason})` : ''}`).join(', ');
    return `\n\nZUSÄTZLICH: Angehängt sind Bilder dieser PDF-Seiten: ${list}. Nutze sie, um Tabellen und Abbildungen (z.B. Flussdiagramme, Forest Plots, Ergebnistabellen) korrekt zu lesen. Gib als Beleg die Seitenzahl an; bei Angaben aus Bildern setze section auf "Tabelle" bzw. "Abbildung".`;
}

// Modellaufruf mit Seitenbildern; lehnt der Server Bilder ab, wird ohne Bilder wiederholt und das Modell
// für den Rest der Sitzung als "nur Text" vermerkt.
async function callWithVisuals(prompt, meta, doc) {
    if (!doc.visuals?.length || doc.vision_status !== 'used') return callLLM(prompt, meta);
    try {
        return await callLLM(prompt + visualNote(doc), { ...meta, images: doc.visuals.map(v => v.dataUrl), imagePages: doc.visuals.map(v => v.page) });
    } catch (err) {
        rethrowIfStopped(err);
        if (!/API Fehler \(4\d\d\)/.test(err?.message || '')) throw err;
        log(`${doc.title}: Das Modell lehnt Bilder ab – weiter nur mit Text.`, 'warning');
        visionSupport[visionKey()] = { state: 'no', detail: 'Bilder beim Aufruf abgelehnt.', checkedAt: new Date().toLocaleTimeString() };
        doc.vision_status = 'rejected';
        updateVisionHint();
        return callLLM(prompt, meta);
    }
}

// Extraktion in Teilschritten: Teil 1 klassifiziert (ohne Bilder), Teil 2 holt Methoden und Messung, Teil 3 Ergebnisse und Belege
// (beide mit Seitenbildern). So bleibt jeder Aufruf kurz genug für Server mit Zeitlimit.
const EXTRACTION_PART_TITLES = { classification: 'Dokumenttyp und Design', methods: 'Stichprobe, Methoden und Messung', results: 'Ergebnisse, Limitationen und Belege' };

// Ausgabegrenzen je Teil: Läuft ein Modell in eine Wiederholungsschleife, bricht es ab, statt bis zur (oft sehr hohen) Grenze
// weiterzuschreiben. Reasoning-Modelle denken zuerst und brauchen Spielraum, deshalb nicht zu knapp.
const EXTRACTION_PART_MAX_TOKENS = { classification: 6000, methods: 8000, results: 10000 };

function extractionPartInstruction(part, partIndex, partCount, known) {
    const lines = [`TEILAUFGABE (Teil ${partIndex} von ${partCount}: ${EXTRACTION_PART_TITLES[part]}): Liefere AUSSCHLIESSLICH diese Schlüssel des JSON-SCHEMA: ${EXTRACTION_PARTS[part].join(', ')}. Lass alle anderen Schlüssel weg. Höchstens 12 Einträge je Liste, keine Wiederholungen, jede Angabe knapp.`];
    if (known.document_type) lines.push(`Bereits bestimmt (Teil 1): Dokumenttyp ${known.document_type}, Studienfamilie ${known.study_family || 'unklar'}, Design ${known.study_design || 'unklar'}.`);
    return lines.join('\n') + '\n';
}

async function runExtraction(doc, promptBase, promptVersionId, split) {
    if (!split) {
        const prompt = fillTemplate(promptBase, { TITLE: doc.title, SOURCE_TEXT: doc.evidence_text, PART_INSTRUCTION: '' });
        return parseJSONRobust(await callWithVisuals(prompt, { agent: 'extraction', doc: doc.title, promptVersionId, schema: agentSchema('extraction') }, doc));
    }
    const parts = Object.keys(EXTRACTION_PARTS);
    const merged = {};
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        log(`Evidence Extraction – Teil ${i + 1}/${parts.length} (${EXTRACTION_PART_TITLES[part]}): ${doc.title}`, 'info');
        const instruction = extractionPartInstruction(part, i + 1, parts.length, merged);
        // Eigene Prompts ohne Platzhalter bekommen die Teilaufgabe vorangestellt.
        const template = promptBase.includes('{{PART_INSTRUCTION}}') ? promptBase : `{{PART_INSTRUCTION}}\n${promptBase}`;
        const prompt = fillTemplate(template, { TITLE: doc.title, SOURCE_TEXT: doc.evidence_text, PART_INSTRUCTION: instruction });
        const configuredMax = parseInt(document.getElementById('max-output-tokens').value, 10) || 8192;
        const meta = { agent: 'extraction', part, doc: doc.title, promptVersionId, schema: agentSchema('extraction', { part }),
            maxTokens: Math.min(configuredMax, EXTRACTION_PART_MAX_TOKENS[part]) };
        const answer = parseJSONRobust(await (part === 'classification' ? callLLM(prompt, meta) : callWithVisuals(prompt, meta, doc)));
        Object.assign(merged, answer);
    }
    return merged;
}

function sourceInfoFor(doc) {
    return {
        quality: doc.quality,
        text_chars: doc.full_text?.length ?? null,
        evidence_chars: doc.evidence_text?.length ?? null,
        visual_pages: (doc.visuals || []).map(v => ({ page: v.page, reason: v.reason })),
        vision_status: doc.vision_status
    };
}

// Integritätsprüfung einer Publikation: rechnerisch im Browser und/oder per LLM (Agent 6), je nach Auswahl.
// Fehler hier brechen die Analyse nicht ab – das Ergebnis der Studie bleibt erhalten.
async function runIntegrityChecks(doc, ext, options, promptVersionId) {
    if (!options.computed && !options.online && !options.llm) return null;
    const result = { options, computed: null, online: null, llm: null, llm_error: null, comparison: null };
    if (options.computed) {
        result.computed = runComputedIntegrity(doc.pages, ext);
        const st = result.computed.statistics_summary;
        log(`Integrität (rechnerisch) ${doc.title}: ${st.total} Teststatistik(en), ${st.inconsistent} inkonsistent, ${st.gross_errors} mit geänderter Signifikanz.`, st.gross_errors ? 'warning' : 'info');
    }
    if (options.online) {
        const doi = result.computed?.doi ?? findDoi(doc.pages);
        const firstPages = doc.pages.slice(0, 2).map(p => p.text).join(' ');
        result.online = await checkDoiOnline(doi, firstPages);
        if (result.online.retracted) log(`ACHTUNG ${doc.title}: Laut Crossref liegt eine Retraction vor.`, 'error');
    }
    if (options.llm) {
        try {
            log(`Integrität (LLM, Agent 6): ${doc.title}`, 'info');
            const prompt = fillTemplate(getCurrentPrompt('integrity'), { TITLE: doc.title, SOURCE_TEXT: doc.evidence_text });
            result.llm = parseJSONRobust(await callWithVisuals(prompt, { agent: 'integrity', doc: doc.title, promptVersionId, schema: agentSchema('integrity') }, doc));
        } catch (err) {
            rethrowIfStopped(err);
            result.llm_error = err?.message || String(err);
            log(`Integrität (LLM) für ${doc.title} fehlgeschlagen: ${result.llm_error}`, 'warning');
        }
    }
    if (result.computed && result.llm) result.comparison = compareIntegrity(result.computed, result.llm);
    return result;
}

function integritySummaryForSynthesis(integrity) {
    if (!integrity) return null;
    const st = integrity.computed?.statistics_summary;
    return {
        statcheck: st ? { tests: st.total, inconsistent: st.inconsistent, significance_changed: st.gross_errors } : null,
        retracted: integrity.online?.retracted ?? null,
        corrected: integrity.online?.corrected ?? null,
        registrations: integrity.computed?.registrations?.ids?.map(r => r.id) || [],
        llm_issues: Array.isArray(integrity.llm?.issues) ? integrity.llm.issues.slice(0, 5) : []
    };
}

async function startWorkflow() {
    if (selectedFiles.length === 0) { alert("Bitte lade zuerst PDFs hoch!"); return; }

    PROMPT_TYPES.forEach(type => savePrompt(type));
    // Mehrfachbewertung: Anzahl Durchläufe von Agent 3 und 3b und deren Temperatur (bei 0 wären alle Läufe gleich)
    const splitExtraction = !!document.getElementById('opt-split-extraction')?.checked;
    const journalList = (await loadJournals()).rows;
    const allowMedical = !!document.getElementById('opt-medical-instruments')?.checked;
    const repeatRuns = Math.max(1, Math.min(7, parseInt(document.getElementById('opt-repeat-runs').value, 10) || 1));
    const repeatTempInput = parseFloat(document.getElementById('opt-repeat-temperature').value);
    const runTemperature = Number.isFinite(repeatTempInput) ? Math.max(0, Math.min(1.5, repeatTempInput)) : 0.4;
    const integrityOptions = {
        computed: document.getElementById('opt-integrity-computed').checked,
        online: document.getElementById('opt-integrity-online').checked,
        llm: document.getElementById('opt-integrity-llm').checked
    };

    runControl = { controller: new AbortController(), stopped: false };
    document.getElementById('btn-start').disabled = true;
    const stopButton = document.getElementById('btn-stop');
    stopButton.style.display = '';
    stopButton.disabled = false;
    stopButton.textContent = '⏹ Stopp';
    document.getElementById('terminal').style.display = 'flex';
    document.getElementById('btn-toggle-terminal').textContent = 'Terminal ausblenden';
    document.getElementById('results-view').classList.remove('active');
    document.getElementById('terminal').innerHTML = '';
    [1,2,3,4,5].forEach(i => {
        const st = document.getElementById(`step-${i}`); st.classList.remove('active','done');
    });

    const currentProvider = document.getElementById('llm-provider').value;
    let currentModel = "";
    if (isUrlProvider(currentProvider)) currentModel = document.getElementById(currentProvider + '-model').value || 'Lokales Custom-Modell';
    if (currentProvider === 'spark') currentModel = document.getElementById('spark-model').value || 'Spark-Modell (Standard)';
    if (currentProvider === 'openai') currentModel = document.getElementById('openai-model').value || 'OpenAI Modell';
    if (currentProvider === 'gemini') currentModel = document.getElementById('gemini-model').value || 'Gemini Modell';

    const maxEvChars = parseInt(document.getElementById('max-evidence-chars').value, 10) || 50000;
    const maxOutTokens = parseInt(document.getElementById('max-output-tokens').value, 10) || 8192;
    const llmTemp = parseFloat(document.getElementById('llm-temperature').value) || 0.0;

    // Bildverarbeitung vor dem Lauf klären (der Testaufruf landet nicht im Agent-Protokoll)
    const visionWanted = document.getElementById('opt-vision').checked;
    let visionActive = false;
    if (visionWanted) {
        const vision = await probeVisionSupport();
        visionActive = vision.state === 'yes';
        log(visionActive ? 'Bildverarbeitung: Modell versteht Bilder – Tabellen/Abbildungen werden als Bild mitgeschickt.'
            : `Bildverarbeitung: ${vision.state === 'no' ? 'Modell verarbeitet keine Bilder' : 'nicht prüfbar'} – Tabellen/Abbildungen nur als Text.`, visionActive ? 'success' : 'warning');
    }

    if (['hochschule', 'endpoint'].includes(currentProvider) && maxOutTokens > 12000) {
        log(`Hinweis: „Max. Output Tokens“ steht auf ${maxOutTokens.toLocaleString('de-DE')}. Läuft das Modell in eine Wiederholungsschleife, schreibt es bis zu dieser Grenze weiter und überschreitet das Zeitlimit des Servers (oft 5 Minuten). Empfohlen: 8.000.`, 'warning');
    }

    const ownTimeout = callTimeoutByProvider[currentProvider] || 0;
    if (ownTimeout > 0 && ownTimeout < 30) {
        log(`Hinweis: „Zeitlimit je Aufruf“ steht auf ${ownTimeout} s. Das ist für Modellantworten fast immer zu kurz (üblich sind 20 bis 180 s); die Aufrufe werden abgebrochen, bevor das Modell antworten kann. Empfohlen: 120 bis 180 oder 0.`, 'warning');
    }

    window.currentRunMetrics = [];
    currentRunSteps = [];

    const promptVersionIds = Object.fromEntries(PROMPT_TYPES.map(type => [type, getCurrentPromptVersionId(type)]));
    const promptDates = Object.fromEntries(PROMPT_TYPES.map(type => [type, getCurrentPromptDate(type)]));

    const failures = [];
    const docs = [];
    const extractedDocs = [];
    const appraisedDocs = [];
    const studyResults = [];
    let synthesis = {
        topics: [], synthesized_arguments: [], consistency_of_findings: 'unclear',
        strength_of_evidence: 'unclear', heterogeneity_notes: [], cross_study_limitations: [],
        narrative_summary: 'Keine studienübergreifende Synthese verfügbar.', meta_analysis_performed: false,
        grade_assessment: { applicable: false, outcomes: [] }
    };

    let stoppedByUser = false;
    const registerFailure = (title, phase, err) => {
        const message = err?.message || String(err);
        failures.push({ title, phase, error: message });
        log(`ÜBERSPRUNGEN [${phase}] ${title}: ${message}`, 'error');
        console.error(`${phase} fehlgeschlagen für ${title}:`, err);
    };

    try {
        // PHASE 1: Ingestion – Fehler eines PDFs stoppen nicht den Gesamtlauf.
        setStep(1, 'active');
        log('PHASE 1: Lese PDFs vollständig ein und markiere Seiten...', 'info');
        for (const file of selectedFiles) {
            throwIfStopped();
            try {
                const parsed = await extractPdf(file, { renderVisuals: visionActive });
                const q = parsed.quality;
                if (q.textless) throw new Error('Gescanntes PDF erkannt: Die Datei enthält keinen auslesbaren Text. OCR wird nicht unterstützt – bitte eine durchsuchbare Fassung verwenden (z.B. die PDF der Zeitschrift oder eine vorher mit OCR-Software wie OCRmyPDF aufbereitete Datei).');
                const evidenceText = buildEvidenceContext(parsed.pages, maxEvChars);
                const visionStatus = !visionWanted ? 'off' : !visionActive ? 'unsupported' : parsed.visuals.length ? 'used' : 'none';
                docs.push({ title: file.name, full_text: parsed.fullText, evidence_text: evidenceText, pages: parsed.pages, num_pages: parsed.numPages,
                    quality: q, visuals: parsed.visuals, vision_status: visionStatus });
                log(`${file.name}: ${parsed.numPages} Seiten, ${parsed.fullText.length.toLocaleString()} Zeichen gelesen, ${evidenceText.length.toLocaleString()} Zeichen Evidenzkontext`
                    + `${q.table_pages.length ? `, Tabellen S. ${q.table_pages.join(', ')}` : ''}${q.figure_pages.length ? `, Abbildungen S. ${q.figure_pages.join(', ')}` : ''}`
                    + `${parsed.visuals.length ? `, ${parsed.visuals.length} Seitenbild(er) für das Modell` : ''}.`, 'success');
                if (q.scanned_pages.length) log(`${file.name}: ${q.scanned_pages.length} Seite(n) ohne Textschicht, vermutlich gescannt: S. ${q.scanned_pages.join(', ')}. Ihr Inhalt fehlt im Text (OCR wird nicht unterstützt) – Ergebnisse können unvollständig sein.`, 'warning');
            } catch (err) {
                rethrowIfStopped(err);
                registerFailure(file.name, 'Ingestion', err);
            }
        }
        setStep(1, 'done');

        // PHASE 2: Extraction – nur erfolgreich eingelesene PDFs weiterverarbeiten.
        setStep(2, 'active');
        log('PHASE 2: Extrahiere Studiendesign und belegte Methodenevidenz je Publikation...', 'info');
        const extPromptBase = getCurrentPrompt('extraction');
        for (const doc of docs) {
            throwIfStopped();
            try {
                log(`Evidence Extraction: ${doc.title}`, 'info');
                let ext = await runExtraction(doc, extPromptBase, promptVersionIds.extraction, splitExtraction);
                ext.title = doc.title;
                ext = verifyExtractionEvidenceRefs(ext, doc.pages);
                extractedDocs.push({ doc, ext });
            } catch (err) {
                rethrowIfStopped(err);
                registerFailure(doc.title, 'Extraction', err);
            }
        }
        setStep(2, 'done');

        // PHASE 3: Appraisal – ein Modell-/Netzwerkfehler betrifft nur die einzelne Studie.
        setStep(3, 'active');
        log('PHASE 3: Design-spezifisches Critical Appraisal je Publikation...', 'info');
        const analysisPromptBase = getCurrentPrompt('analysis');
        for (const item of extractedDocs) {
            const { doc, ext } = item;
            try {
                log(`Critical Appraisal: ${doc.title} (${ext.study_family || 'Unclear'} / ${ext.study_design || 'Unclear'})`, 'info');
                // CASQ-Prüffragen passend zum Dokumenttyp (vom Code gewählt, nicht vom Modell)
                const rubricKey = selectCASQRubric(ext);
                const casqFields = { CASQ_RUBRIC: `${CASQ_RUBRICS[rubricKey].label} (${rubricKey})`, CASQ_CHECKLIST: casqChecklistText(rubricKey) };
                const healthContext = isHealthContext(ext) ? 'ja' : (allowMedical ? 'nein (medizinische Instrumente vom Nutzer zugelassen)' : 'nein');
                const prompt = fillTemplate(analysisPromptBase, { STUDY_DATA: JSON.stringify(ext, null, 2), SOURCE_TEXT: doc.evidence_text, HEALTH_CONTEXT: healthContext, ...casqFields });
                const casqPrompt = fillTemplate(getCurrentPrompt('casq'), { STUDY_DATA: JSON.stringify(ext, null, 2), SOURCE_TEXT: doc.evidence_text, ...casqFields });

                // Mehrfachbewertung: Agent 3 und 3b laufen repeatRuns-mal (mit der eingestellten Wiederholungs-Temperatur);
                // je Frage entscheidet die Mehrheit. Ein einzelner fehlgeschlagener Durchlauf wird übersprungen.
                const analysisRuns = [], casqRuns = [];
                let analysisError = null;
                for (let run = 1; run <= repeatRuns; run++) {
                    throwIfStopped();
                    const runInfo = repeatRuns > 1 ? { run, temperature: runTemperature } : {};
                    try {
                        if (repeatRuns > 1) log(`Critical Appraisal (Agent 3) – Durchlauf ${run}/${repeatRuns}: ${doc.title}`, 'info');
                        analysisRuns.push(parseJSONRobust(await callLLM(prompt, { agent: 'analysis', doc: doc.title, promptVersionId: promptVersionIds.analysis, schema: agentSchema('analysis'), ...runInfo })));
                    } catch (err) {
                        rethrowIfStopped(err);
                        analysisError = err;
                        if (repeatRuns > 1) log(`Durchlauf ${run}/${repeatRuns} (Agent 3) fehlgeschlagen: ${err?.message || err}`, 'warning');
                    }
                    // Agent 3b: CASQ-Prüffragen in einem eigenen, kürzeren Aufruf. Ein Fehler hier kostet nur den CASQ.
                    try {
                        log(`CASQ-Prüffragen (Agent 3b)${repeatRuns > 1 ? ` – Durchlauf ${run}/${repeatRuns}` : ''}: ${doc.title} – Rubrik ${CASQ_RUBRICS[rubricKey].label}`, 'info');
                        const casq = parseJSONRobust(await callLLM(casqPrompt, { agent: 'casq', doc: doc.title, promptVersionId: promptVersionIds.casq, schema: agentSchema('casq', { rubric: rubricKey }), ...runInfo }));
                        if (Array.isArray(casq.casq_checklist)) casqRuns.push(casq.casq_checklist);
                    } catch (err) {
                        rethrowIfStopped(err);
                        log(`CASQ-Prüffragen für ${doc.title} fehlgeschlagen: ${err?.message || err}`, 'warning');
                    }
                }
                if (!analysisRuns.length) throw analysisError || new Error('Agent 3 hat keine auswertbare Antwort geliefert.');
                // Medizinische Instrumente nur bei Gesundheitsbezug (oder ausdrücklicher Freigabe) – der Code entscheidet, nicht das Modell.
                const hiddenMedical = analysisRuns.map(r => restrictMedicalInstruments(r, ext, allowMedical)).some(Boolean);
                if (hiddenMedical) log(`${doc.title}: kein Gesundheitsbezug – PEDro/MINORS/AMSTAR 2/COSMIN werden nicht angewendet.`, 'info');

                const appraisal = analysisRuns[0];
                appraisal.title = doc.title;
                appraisal.casq_rubric = rubricKey;
                const reliability = repeatRuns > 1 ? { runs_requested: repeatRuns, temperature: runTemperature, analysis_runs: analysisRuns.length, casq_runs: casqRuns.length, established: null, casq: null } : null;

                if (analysisRuns.length > 1) {
                    const est = aggregateEstablishedRuns(analysisRuns.map(r => r.established_appraisal));
                    if (est.merged) appraisal.established_appraisal = est.merged;
                    reliability.established = {
                        instrument: est.instrument, applicable_runs: est.applicable_runs, agreement: est.agreement, fleiss: est.fleiss, uncertain: est.uncertain,
                        runs: analysisRuns.map(r => {
                            const e = calculateEstablishedResult({}, { established_appraisal: r.established_appraisal }, ext);
                            return { applicable: e.applicable, instrument: e.instrument, display: e.display, score: e.score, rating: e.rating };
                        })
                    };
                }
                if (casqRuns.length === 1) {
                    appraisal.casq_checklist = casqRuns[0];
                } else if (casqRuns.length > 1) {
                    const ids = CASQ_RUBRICS[rubricKey].dimensions.flatMap(d => d.questions.map(q => q.id));
                    const agg = aggregateChecklistRuns(casqRuns, ids, normalizeChecklistResponse);
                    appraisal.casq_checklist = agg.merged;
                    // CASQ je Durchlauf, mit derselben Belegprüfung gegen das PDF wie im Normalfall
                    const perRun = casqRuns.map(list => {
                        const copy = JSON.parse(JSON.stringify(list));
                        verifyChecklistEvidence({}, { casq_checklist: copy }, doc.pages);
                        return calculateCASQ2({}, { casq_checklist: copy }, rubricKey)?.score ?? null;
                    });
                    reliability.casq = { ...scoreSpread(perRun), agreement: agg.agreement, unanimous_share: agg.unanimous_share, fleiss: agg.fleiss, uncertain: agg.uncertain };
                }
                if (reliability) log(`Mehrfachbewertung ${doc.title}: CASQ ${reliability.casq?.scores?.map(v => v === null ? '–' : v.toFixed(1)).join(' / ') || 'nicht berechenbar'}; ${reliability.casq?.uncertain?.length ?? 0} unsichere Prüffrage(n).`, 'info');
                appraisedDocs.push({ doc, ext, appraisal, rubricKey, casqFields, reliability });
            } catch (err) {
                rethrowIfStopped(err);
                registerFailure(doc.title, 'Critical Appraisal', err);
            }
        }
        setStep(3, 'done');

        // PHASE 4: Validation – nur vollständig appraisierte Studien validieren.
        setStep(4, 'active');
        log('PHASE 4: Evidence Validation – prüfe Scores und Begründungen gegen Originaltext...', 'info');
        const validationPromptBase = getCurrentPrompt('validation');
        for (const item of appraisedDocs) {
            const { doc, ext, appraisal, rubricKey, casqFields, reliability } = item;
            try {
                log(`Validiere Evidenz: ${doc.title}`, 'info');
                // Die CASQ-Antworten validiert Agent 4b separat; Agent 4 bekommt sie nicht mit.
                const { casq_checklist: casqAnswers, ...appraisalForValidation } = appraisal;
                const validationInput = { extraction: ext, appraisal: appraisalForValidation };
                const prompt = fillTemplate(validationPromptBase, { VALIDATION_DATA: JSON.stringify(validationInput, null, 2), SOURCE_TEXT: doc.evidence_text, ...casqFields });
                let validation = parseJSONRobust(await callLLM(prompt, { agent: 'validation', doc: doc.title, promptVersionId: promptVersionIds.validation, schema: agentSchema('validation') }));
                // Agent 4b: CASQ-Antworten gegen den Text prüfen
                if (Array.isArray(casqAnswers) && casqAnswers.length) {
                    try {
                        log(`Validiere CASQ-Prüffragen (Agent 4b): ${doc.title}`, 'info');
                        const cvPrompt = fillTemplate(getCurrentPrompt('casq_validation'), { CASQ_ANSWERS: JSON.stringify(casqAnswers, null, 2), SOURCE_TEXT: doc.evidence_text, ...casqFields });
                        const cv = parseJSONRobust(await callLLM(cvPrompt, { agent: 'casq_validation', doc: doc.title, promptVersionId: promptVersionIds.casq_validation, schema: agentSchema('casq_validation', { rubric: rubricKey }) }));
                        if (Array.isArray(cv.validated_casq_checklist)) validation.validated_casq_checklist = cv.validated_casq_checklist;
                    } catch (err) {
                        rethrowIfStopped(err);
                        log(`CASQ-Validierung für ${doc.title} fehlgeschlagen – es zählen die Antworten von Agent 3b: ${err?.message || err}`, 'warning');
                    }
                }
                validation.title = doc.title;
                validation = verifySourceRefs(validation, doc.pages);
                validation = verifyFrameworkEvidence(validation, appraisal, doc.pages);
                validation = verifyEstablishedEvidence(validation, appraisal, doc.pages);
                validation = verifyJARSEvidence(validation, appraisal, doc.pages);
                restrictMedicalInstruments(validation, ext, allowMedical);
                restrictMedicalInstruments(appraisal, ext, allowMedical);
                validation = verifyChecklistEvidence(validation, appraisal, doc.pages);
                const round1 = v => v === null || v === undefined ? null : Number(v.toFixed(1));
                const casq2 = calculateCASQ2(validation, appraisal, rubricKey);
                if (casq2) {
                    validation.casq_score = round1(casq2.score);
                    validation.casq_min = round1(casq2.score_min);
                    validation.casq_max = round1(casq2.score_max);
                    validation.casq_details = casq2;
                    validation.evidence_coverage = casq2.evidence_rate === null ? 0 : Math.round(casq2.evidence_rate * 100);
                    validation.information_grade = Math.round(casq2.information_grade * 100);
                    validation.quality_label = qualityLabel(validation.casq_score, validation.information_grade);
                    if (casq2.unanswered) log(`${doc.title}: ${casq2.unanswered} CASQ-Prüffrage(n) ohne Antwort – als „nicht berichtet“ gewertet.`, 'warning');
                } else {
                    // Ältere bzw. angepasste Prompts ohne Prüffragen: bisherige Dimensionsbewertung
                    const calc = calculateValidatedCASQ(validation, appraisal, ext);
                    validation.casq_score = round1(calc.score);
                    validation.casq_min = round1(calc.score_min);
                    validation.casq_max = round1(calc.score_max);
                    validation.casq_details = { weights_source: calc.weights_source, rubric: calc.rubric, rubric_label: calc.rubric_label, dimensions: calc.dimensions, scoring_version: calc.scoring_version };
                    validation.evidence_coverage_agent = calc.agent_coverage;
                    validation.evidence_coverage = calc.coverage;
                    validation.quality_label = qualityLabel(validation.casq_score, calc.coverage);
                }
                const integrity = await runIntegrityChecks(doc, ext, integrityOptions, promptVersionIds.integrity);
                const journal_context = journalContextForDoc(journalList, doc, ext, integrity);
                studyResults.push({
                    title: doc.title, extraction: ext, appraisal, validation,
                    casq_score: validation.casq_score,
                    evidence_coverage: validation.evidence_coverage,
                    quality_label: validation.quality_label,
                    integrity,
                    journal_context,
                    reliability,
                    source_info: sourceInfoFor(doc)
                });
            } catch (err) {
                rethrowIfStopped(err);
                registerFailure(doc.title, 'Evidence Validation', err);
            }
        }
        setStep(4, 'done');

        // PHASE 5: Synthese – auch ein Fehler hier darf fertige Einzelstudien nicht verwerfen.
        setStep(5, 'active');
        log('PHASE 5: Evidenzgewichtete Cross-Study-Synthese...', 'info');
        if (studyResults.length > 0) {
            try {
                const synthInput = studyResults.map(r => ({
                    title: r.title,
                    study_family: r.extraction.study_family,
                    study_design: r.extraction.study_design,
                    sample: r.extraction.sample,
                    main_results: r.extraction.main_results,
                    limitations_reported: r.extraction.limitations_reported,
                    casq_score: r.casq_score,
                    evidence_coverage: r.evidence_coverage,
                    quality_label: r.quality_label,
                    established_appraisal: r.validation.validated_established_appraisal || r.appraisal.established_appraisal,
                    // Deterministisch berechnetes Ergebnis (z.B. AMSTAR-2-Rating), maßgeblich gegenüber Modellangaben.
                    established_result_computed: (({ instrument, applicable, display, score, max, rating }) => ({ instrument, applicable, display, score, max, rating }))(calculateEstablishedResult(r.validation, r.appraisal, r.extraction)),
                    framework_appraisal: r.validation.validated_framework || r.appraisal.framework_appraisal,
                    bias_domains: r.appraisal.bias_domains,
                    critical_limitations: r.appraisal.critical_limitations,
                    validation_summary: r.validation.validation_summary,
                    jars_quant: r.validation.validated_jars_quant || r.appraisal.jars_quant || null,
                    embedded_study_appraisals: r.validation.validated_embedded_study_appraisals || r.appraisal.embedded_study_appraisals || [],
                    integrity_flags: integritySummaryForSynthesis(r.integrity)
                }));
                const synPrompt = fillTemplate(getCurrentPrompt('synthesis'), { APPRAISALS_DATA: JSON.stringify(synthInput, null, 2) });
                synthesis = parseJSONRobust(await callLLM(synPrompt, { agent: 'synthesis', doc: null, promptVersionId: promptVersionIds.synthesis, schema: agentSchema('synthesis') }));
                synthesis.num_studies_included = studyResults.length;
                synthesis.meta_analysis_performed = false;
            } catch (err) {
                rethrowIfStopped(err);
                registerFailure('Cross-Study-Synthese', 'Synthesis', err);
                synthesis = {
                    topics: [], synthesized_arguments: [], consistency_of_findings: 'unclear',
                    strength_of_evidence: 'unclear', heterogeneity_notes: [],
                    cross_study_limitations: ['Die studienübergreifende Synthese konnte technisch nicht erstellt werden. Die validierten Einzelstudien bleiben verfügbar.'],
                    narrative_summary: `Die Synthese ist fehlgeschlagen; ${studyResults.length} validierte Einzelstudie(n) wurden dennoch erhalten.`,
                    meta_analysis_performed: false, num_studies_included: studyResults.length,
                    grade_assessment: { applicable: false, outcomes: [] }
                };
            }
        } else {
            log('Keine vollständig validierte Studie verfügbar; Synthese wird übersprungen.', 'warning');
        }
        setStep(5, 'done');

        const validScores = studyResults.map(r => r.casq_score).filter(v => Number.isFinite(v));
        const meanCASQ = validScores.length ? validScores.reduce((a,b) => a+b, 0) / validScores.length : null;
        const meanCoverage = studyResults.length ? studyResults.reduce((a,r) => a + (Number(r.evidence_coverage)||0), 0) / studyResults.length : 0;
        const validation = {
            casq_score: meanCASQ === null ? null : Number(meanCASQ.toFixed(1)),
            evidence_coverage: Math.round(meanCoverage),
            overall_quality: qualityLabel(meanCASQ, meanCoverage),
            note: 'Der Gesamtwert ist der deskriptive Mittelwert der validierten Studien-CASQ-Werte; die Einzelwerte bleiben maßgeblich.'
        };

        let avgTokensPerSec = 0;
        if (window.currentRunMetrics && window.currentRunMetrics.length > 0) {
            const sum = window.currentRunMetrics.reduce((a, b) => a + b, 0);
            avgTokensPerSec = Math.round(sum / window.currentRunMetrics.length);
        }

        const extractions = extractedDocs.map(x => x.ext);
        const appraisals = appraisedDocs.map(x => x.appraisal);
        const validations = studyResults.map(x => x.validation);

        if (studyResults.length > 0) {
            log(`🎉 Workflow abgeschlossen: ${studyResults.length} Studie(n) vollständig ausgewertet${failures.length ? `, ${failures.length} Fehler/Überspringung(en)` : ''}.`, failures.length ? 'warning' : 'success');
        } else {
            log('Workflow beendet, aber keine Studie konnte vollständig ausgewertet werden.', 'error');
        }

        globalResults = {
            date: new Date().toLocaleString(),
            model: currentModel,
            provider: currentProvider,
            temperature: llmTemp,
            maxTokens: maxOutTokens,
            maxEvidence: maxEvChars,
            tokensPerSec: avgTokensPerSec,
            prompts_used: promptDates,
            prompt_version_ids: promptVersionIds,
            scoring_version: SCORING_VERSION,
            extractions, appraisals, validations, study_results: studyResults,
            failed_documents: failures,
            synthesis, validation
        };
        await saveToHistory(globalResults, currentRunSteps);
        renderResults(globalResults);
    } catch (err) {
        // Nur noch unerwartete, laufweite Fehler und der Abbruch durch den Nutzer landen hier. Bereits fertig ausgewertete Studien bleiben erhalten.
        stoppedByUser = err instanceof RunStopped;
        if (stoppedByUser) log(`⏹ Analyse vom Nutzer abgebrochen.${studyResults.length ? ` ${studyResults.length} bereits fertig ausgewertete Studie(n) bleiben als Teilergebnis erhalten.` : ' Es liegen keine fertigen Ergebnisse vor.'}`, 'warning');
        else {
            log(`KRITISCHER WORKFLOW-FEHLER: ${err.message}`, 'error');
            console.error(err);
        }
        if (studyResults.length > 0) {
            const validScores = studyResults.map(r => r.casq_score).filter(v => Number.isFinite(v));
            const meanCASQ = validScores.length ? validScores.reduce((a,b) => a+b, 0) / validScores.length : null;
            const meanCoverage = studyResults.reduce((a,r) => a + (Number(r.evidence_coverage)||0), 0) / studyResults.length;
            globalResults = {
                date: new Date().toLocaleString(), model: currentModel, provider: currentProvider,
                temperature: llmTemp, maxTokens: maxOutTokens, maxEvidence: maxEvChars,
                tokensPerSec: 0, prompts_used: promptDates, prompt_version_ids: promptVersionIds, scoring_version: SCORING_VERSION,
                extractions: extractedDocs.map(x => x.ext), appraisals: appraisedDocs.map(x => x.appraisal),
                validations: studyResults.map(x => x.validation), study_results: studyResults,
                failed_documents: [...failures, { title: 'Gesamtlauf', phase: stoppedByUser ? 'Abbruch' : 'Workflow', error: stoppedByUser ? 'Vom Nutzer abgebrochen; nicht ausgewertete Dokumente fehlen.' : err.message }],
                synthesis,
                validation: {
                    casq_score: meanCASQ === null ? null : Number(meanCASQ.toFixed(1)),
                    evidence_coverage: Math.round(meanCoverage),
                    overall_quality: qualityLabel(meanCASQ, meanCoverage),
                    note: stoppedByUser ? 'Teilergebnis nach Abbruch durch den Nutzer.' : 'Teilergebnis nach kritischem Workflow-Fehler.'
                }
            };
            await saveToHistory(globalResults, currentRunSteps);
            renderResults(globalResults);
        }
    } finally {
        currentRunSteps = null;
        runControl = null;
        document.getElementById('btn-start').disabled = false;
        document.getElementById('btn-stop').style.display = 'none';
        [1, 2, 3, 4, 5].forEach(i => document.getElementById(`step-${i}`)?.classList.remove('active'));
    }
}


// Hält die laufende Analyse an: der gerade laufende Modellaufruf wird abgebrochen, weitere werden nicht mehr gestartet.
function stopWorkflow() {
    if (!runControl || runControl.stopped) return;
    runControl.stopped = true;
    runControl.controller.abort();
    const button = document.getElementById('btn-stop');
    button.disabled = true;
    button.textContent = 'Wird abgebrochen …';
    log('⏹ Stopp angefordert – der laufende Modellaufruf wird abgebrochen.', 'warning');
}
