// ==========================================
// WORKFLOW AGENTEN
// ==========================================
async function extractTextFromPDF(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({data: arrayBuffer}).promise;
    let fullText = "";
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items.map(item => item.str).join(" ");
        pages.push({ page: i, text: pageText });
        fullText += `\n--- PAGE ${i} ---\n${pageText}\n`;
    }
    return { fullText, pages, numPages: pdf.numPages };
}


async function startWorkflow() {
    if (selectedFiles.length === 0) { alert("Bitte lade zuerst PDFs hoch!"); return; }

    savePrompt('extraction'); savePrompt('analysis'); savePrompt('validation'); savePrompt('synthesis');

    document.getElementById('btn-start').disabled = true;
    document.getElementById('terminal').style.display = 'flex';
    document.getElementById('btn-toggle-terminal').textContent = 'Terminal ausblenden';
    document.getElementById('results-view').classList.remove('active');
    document.getElementById('terminal').innerHTML = '';
    [1,2,3,4,5].forEach(i => {
        const st = document.getElementById(`step-${i}`); st.classList.remove('active','done');
    });

    const currentProvider = document.getElementById('llm-provider').value;
    let currentModel = "";
    if (currentProvider.startsWith('custom')) currentModel = document.getElementById(currentProvider + '-model').value || 'Lokales Custom-Modell';
    if (currentProvider === 'spark') currentModel = document.getElementById('spark-model').value || 'Spark-Modell (Standard)';
    if (currentProvider === 'openai') currentModel = document.getElementById('openai-model').value || 'OpenAI Modell';
    if (currentProvider === 'gemini') currentModel = document.getElementById('gemini-model').value || 'Gemini Modell';

    const maxEvChars = parseInt(document.getElementById('max-evidence-chars').value, 10) || 50000;
    const maxOutTokens = parseInt(document.getElementById('max-output-tokens').value, 10) || 8192;
    const llmTemp = parseFloat(document.getElementById('llm-temperature').value) || 0.0;

    window.currentRunMetrics = [];
    currentRunSteps = [];

    const promptVersionIds = {
        extraction: getCurrentPromptVersionId('extraction'),
        analysis: getCurrentPromptVersionId('analysis'),
        validation: getCurrentPromptVersionId('validation'),
        synthesis: getCurrentPromptVersionId('synthesis')
    };

    const promptDates = {
        extraction: getCurrentPromptDate('extraction'),
        analysis: getCurrentPromptDate('analysis'),
        validation: getCurrentPromptDate('validation'),
        synthesis: getCurrentPromptDate('synthesis')
    };

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
            try {
                const parsed = await extractTextFromPDF(file);
                const evidenceText = buildEvidenceContext(parsed.pages, maxEvChars);
                docs.push({ title: file.name, full_text: parsed.fullText, evidence_text: evidenceText, pages: parsed.pages, num_pages: parsed.numPages });
                log(`${file.name}: ${parsed.numPages} Seiten, ${parsed.fullText.length.toLocaleString()} Zeichen gelesen, ${evidenceText.length.toLocaleString()} Zeichen Evidenzkontext.`, 'success');
            } catch (err) {
                registerFailure(file.name, 'Ingestion', err);
            }
        }
        setStep(1, 'done');

        // PHASE 2: Extraction – nur erfolgreich eingelesene PDFs weiterverarbeiten.
        setStep(2, 'active');
        log('PHASE 2: Extrahiere Studiendesign und belegte Methodenevidenz je Publikation...', 'info');
        const extPromptBase = getCurrentPrompt('extraction');
        for (const doc of docs) {
            try {
                log(`Evidence Extraction: ${doc.title}`, 'info');
                const prompt = fillTemplate(extPromptBase, { TITLE: doc.title, SOURCE_TEXT: doc.evidence_text });
                let ext = parseJSONRobust(await callLLM(prompt, { agent: 'extraction', doc: doc.title, promptVersionId: promptVersionIds.extraction }));
                ext.title = doc.title;
                ext = verifyExtractionEvidenceRefs(ext, doc.pages);
                extractedDocs.push({ doc, ext });
            } catch (err) {
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
                const prompt = fillTemplate(analysisPromptBase, { STUDY_DATA: JSON.stringify(ext, null, 2), SOURCE_TEXT: doc.evidence_text, ...casqFields });
                const appraisal = parseJSONRobust(await callLLM(prompt, { agent: 'analysis', doc: doc.title, promptVersionId: promptVersionIds.analysis }));
                appraisal.title = doc.title;
                appraisal.casq_rubric = rubricKey;
                appraisedDocs.push({ doc, ext, appraisal, rubricKey, casqFields });
            } catch (err) {
                registerFailure(doc.title, 'Critical Appraisal', err);
            }
        }
        setStep(3, 'done');

        // PHASE 4: Validation – nur vollständig appraisierte Studien validieren.
        setStep(4, 'active');
        log('PHASE 4: Evidence Validation – prüfe Scores und Begründungen gegen Originaltext...', 'info');
        const validationPromptBase = getCurrentPrompt('validation');
        for (const item of appraisedDocs) {
            const { doc, ext, appraisal, rubricKey, casqFields } = item;
            try {
                log(`Validiere Evidenz: ${doc.title}`, 'info');
                const validationInput = { extraction: ext, appraisal };
                const prompt = fillTemplate(validationPromptBase, { VALIDATION_DATA: JSON.stringify(validationInput, null, 2), SOURCE_TEXT: doc.evidence_text, ...casqFields });
                let validation = parseJSONRobust(await callLLM(prompt, { agent: 'validation', doc: doc.title, promptVersionId: promptVersionIds.validation }));
                validation.title = doc.title;
                validation = verifySourceRefs(validation, doc.pages);
                validation = verifyFrameworkEvidence(validation, appraisal, doc.pages);
                validation = verifyEstablishedEvidence(validation, appraisal, doc.pages);
                validation = verifyJARSEvidence(validation, appraisal, doc.pages);
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
                studyResults.push({
                    title: doc.title, extraction: ext, appraisal, validation,
                    casq_score: validation.casq_score,
                    evidence_coverage: validation.evidence_coverage,
                    quality_label: validation.quality_label
                });
            } catch (err) {
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
                    embedded_study_appraisals: r.validation.validated_embedded_study_appraisals || r.appraisal.embedded_study_appraisals || []
                }));
                const synPrompt = fillTemplate(getCurrentPrompt('synthesis'), { APPRAISALS_DATA: JSON.stringify(synthInput, null, 2) });
                synthesis = parseJSONRobust(await callLLM(synPrompt, { agent: 'synthesis', doc: null, promptVersionId: promptVersionIds.synthesis }));
                synthesis.num_studies_included = studyResults.length;
                synthesis.meta_analysis_performed = false;
            } catch (err) {
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
        // Nur noch unerwartete, laufweite Fehler landen hier. Bereits erzeugte Ergebnisse werden soweit möglich gerettet.
        log(`KRITISCHER WORKFLOW-FEHLER: ${err.message}`, 'error');
        console.error(err);
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
                failed_documents: [...failures, {title:'Gesamtlauf', phase:'Workflow', error: err.message}],
                synthesis,
                validation: {
                    casq_score: meanCASQ === null ? null : Number(meanCASQ.toFixed(1)),
                    evidence_coverage: Math.round(meanCoverage),
                    overall_quality: qualityLabel(meanCASQ, meanCoverage),
                    note: 'Teilergebnis nach kritischem Workflow-Fehler.'
                }
            };
            await saveToHistory(globalResults, currentRunSteps);
            renderResults(globalResults);
        }
    } finally {
        currentRunSteps = null;
        document.getElementById('btn-start').disabled = false;
    }
}
