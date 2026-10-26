const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../app/js/scoring.js');

const verifiedRef = [{ page: 3, quote: 'x', verified: true }];
const unverifiedRef = [{ page: 3, quote: 'x', verified: false }];

test('fillTemplate setzt PDF-Text wörtlich ein, auch mit $-Mustern', () => {
    const text = "Kosten: $& und $' sowie $` und $1";
    const out = s.fillTemplate('A {{SOURCE_TEXT}} B {{TITLE}} {{UNKNOWN}}', { SOURCE_TEXT: text, TITLE: '{{SOURCE_TEXT}}' });
    assert.equal(out, `A ${text} B {{SOURCE_TEXT}} {{UNKNOWN}}`);
});

test('findQuoteOnPages: exakt, Silbentrennung, Ligatur und unscharfer Treffer', () => {
    const pages = [
        { page: 1, text: 'Introduction and background of the study.' },
        { page: 2, text: 'We used a randomised metho- dology with ﬁfty participants recruited from three clinics in 2021.' }
    ];
    assert.equal(s.findQuoteOnPages('randomised methodology with fifty participants', pages)?.page, 2);
    const fuzzy = s.findQuoteOnPages('We used a randomised methodology with fifty participants recruited from three clinics', pages);
    assert.equal(fuzzy?.page, 2);
    assert.equal(s.findQuoteOnPages('participants were recruited online via social media advertising campaigns', pages), null);
    const long = [{ page: 7, text: 'Participants completed the questionnaire twice with an interval of two weeks between both sessions, and test retest reliability was high for all subscales.' }];
    // Ein geändertes Wort in der Mitte: kein exakter Treffer, aber ≥ 80 % der Wort-Trigramme stimmen
    const changed = s.findQuoteOnPages('Participants completed the questionnaire twice with an interval of two weeks between the sessions, and test retest reliability was high for all subscales.', long);
    assert.equal(changed?.page, 7);
    assert.equal(changed?.match, 'fuzzy');
    assert.equal(s.findQuoteOnPages('too short', pages), null);
});

test('CASQ nutzt feste Rubrik-Gewichte statt Modell-Gewichten', () => {
    const appraisal = {
        dimensions: [
            { name: 'Research question & theory', weight: 90 },
            { name: 'Statistical analysis', weight: 5 },
            { name: 'Limitations', weight: 5 }
        ]
    };
    const validation = {
        evidence_coverage: 99,
        validated_dimensions: [
            { name: 'Research Question and Theory', adjusted_score: 10, validation_status: 'supported', source_refs: verifiedRef },
            { name: 'Statistical analysis', adjusted_score: 4, validation_status: 'supported', source_refs: verifiedRef },
            { name: 'Limitations', adjusted_score: 4, validation_status: 'supported', source_refs: unverifiedRef }
        ]
    };
    const r = s.calculateValidatedCASQ(validation, appraisal, { study_family: 'Quantitative' });
    assert.equal(r.weights_source, 'rubric');
    assert.equal(r.rubric, 'quantitative');
    // Rubrik: 10 / 15 / 5 → (10*10 + 4*15 + 4*5) / 30 = 6.0 (mit Modell-Gewichten wären es 9.4)
    assert.equal(r.score.toFixed(2), '6.00');
    // Abdeckung: verifiziert nur 10 + 15 von 30 Gewicht
    assert.equal(r.coverage, 83);
    assert.equal(r.agent_coverage, 99);
});

test('CASQ-Spanne macht fehlende Information sichtbar', () => {
    const validation = {
        validated_dimensions: [
            { name: 'Conceptual clarity', adjusted_score: 8, validation_status: 'supported', source_refs: verifiedRef },
            { name: 'Literature foundation', adjusted_score: 8, validation_status: 'supported', source_refs: verifiedRef },
            { name: 'Testability', adjusted_score: null, validation_status: 'insufficient_information' },
            { name: 'Novelty', adjusted_score: 6, validation_status: 'not_applicable' }
        ]
    };
    const r = s.calculateValidatedCASQ(validation, {}, { document_type: 'theoretical_conceptual_paper' });
    assert.equal(r.rubric, 'theoretical');
    assert.equal(r.score, 8);
    // Gewichte 15 + 20 + 10 (Testability fehlt, Novelty nicht anwendbar)
    assert.equal(r.score_min.toFixed(2), (8 * 35 / 45).toFixed(2));
    assert.equal(r.score_max.toFixed(2), ((8 * 35 + 100) / 45).toFixed(2));
    assert.equal(s.formatCASQRange(r.score_min, r.score_max), 'Spanne 6.2–8.4');
});

test('CASQ fällt auf Modell-Gewichte zurück, wenn keine Rubrik passt', () => {
    const appraisal = { dimensions: [{ name: 'Foo', weight: 50 }, { name: 'Bar', weight: 50 }] };
    const validation = { validated_dimensions: [
        { name: 'Foo', adjusted_score: 6, validation_status: 'supported' },
        { name: 'Bar', adjusted_score: 8, validation_status: 'supported' }
    ] };
    const r = s.calculateValidatedCASQ(validation, appraisal, {});
    assert.equal(r.weights_source, 'agent');
    assert.equal(r.score, 7);
    assert.equal(r.coverage, 0);
});

test('AMSTAR 2: kritische Items sind fest, Modell-Flag wird ignoriert', () => {
    const ea = (items) => ({ validated_established_appraisal: { instrument: 'AMSTAR 2', applicable: true, items } });
    // Item 7 ist kritisch, obwohl das Modell critical:false meldet → Low
    let r = s.calculateEstablishedResult(ea([{ item_id: '7', response: 'no', critical: false }]), {});
    assert.equal(r.rating, 'Low');
    // Item 1 ist nicht kritisch, obwohl das Modell critical:true meldet → zwei nicht-kritische Schwächen = Moderate
    r = s.calculateEstablishedResult(ea([{ item_id: '1', response: 'no', critical: true }, { item_id: '3', response: 'no' }]), {});
    assert.equal(r.rating, 'Moderate');
    r = s.calculateEstablishedResult(ea([{ item_id: '2', response: 'no' }, { item_id: '9', response: 'no' }]), {});
    assert.equal(r.rating, 'Critically low');
    r = s.calculateEstablishedResult(ea([{ item_id: '11', response: 'not_applicable' }, { item_id: '5', response: 'no' }]), {});
    assert.equal(r.rating, 'High');
});

test('COSMIN: worst score counts schlägt das Modell-Rating', () => {
    const r = s.calculateEstablishedResult({ validated_established_appraisal: {
        instrument: 'COSMIN Risk of Bias', applicable: true, official_rating: 'Very good',
        items: [{ response: 'very_good' }, { response: 'doubtful' }, { response: 'adequate' }]
    } }, {});
    assert.equal(r.rating, 'doubtful');
    assert.equal(r.agent_rating, 'Very good');
    assert.equal(r.rating_mismatch, true);
});

test('MINORS: komparativ laut Extraktion, Zählung nach item_id', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ item_id: String(12 - i), points: 2 }));
    const r = s.calculateEstablishedResult({ validated_established_appraisal: { instrument: 'MINORS', applicable: true, items } }, {},
        { clinical_context: { is_comparative: false } });
    assert.equal(r.max, 16);
    assert.equal(r.score, 16); // nur Items 1–8, unabhängig von der Reihenfolge
    const r2 = s.calculateEstablishedResult({ validated_established_appraisal: { instrument: 'MINORS', applicable: true, items: items.slice(4) } }, {},
        { clinical_context: { is_comparative: true } });
    assert.equal(r2.max, 24);
    assert.equal(r2.score, 16);
});

test('PEDro: Item 1 zählt nicht, fehlende Items werden markiert', () => {
    const items = [
        { item_id: '1', response: 'yes' }, { item_id: '2', response: 'yes' }, { item_id: '3', response: 'yes' },
        { item_id: '4', response: 'no' }, { item_id: '5', response: 'yes' }
    ];
    const r = s.calculateEstablishedResult({ validated_established_appraisal: { instrument: 'PEDro Scale', applicable: true, items } }, {});
    assert.equal(r.score, 3);
    assert.deepEqual(r.missing_items, ['6', '7', '8', '9', '10', '11']);
    assert.equal(r.display, '3 / 10 (unvollständig)');
});

test('qualityLabel bleibt kompatibel', () => {
    assert.equal(s.qualityLabel(9, 80), 'SEHR HOCH');
    assert.equal(s.qualityLabel(9, 40), 'UNSICHER / ZU WENIG EVIDENZ');
    assert.equal(s.qualityLabel(null, 90), 'UNSICHER / ZU WENIG EVIDENZ');
});

// ---------------- CASQ 2.0 ----------------
const allQuestions = key => s.CASQ_RUBRICS[key].dimensions.flatMap(d => d.questions);
const answer = (id, response, verified = true) => ({ id, response, evidence: verified ? [{ page: 1, quote: 'x', verified: true }] : [] });

test('CASQ 2.0: alles erfüllt und belegt ergibt 10, Informationsgrad 100 %', () => {
    const appraisal = { casq_checklist: allQuestions('quantitative').map(q => answer(q.id, 'yes')) };
    const r = s.calculateCASQ2({}, appraisal, 'quantitative');
    assert.equal(r.score, 10);
    assert.equal(r.information_grade, 1);
    assert.equal(r.evidence_rate, 1);
    assert.equal(r.cap, null);
});

test('CASQ 2.0: ohne Zitat wird herabgestuft, Validierung hat Vorrang', () => {
    const qs = allQuestions('narrative');
    const appraisal = { casq_checklist: qs.map(q => answer(q.id, 'yes', false)) };
    let r = s.calculateCASQ2({}, appraisal, 'narrative');
    // alles "ja" ohne Beleg → "teilweise" → 5.0; die kritische Frage bleibt erfüllt (teilweise ist kein Mangel)
    assert.equal(r.score, 5);
    assert.equal(r.evidence_rate, 0);
    assert.ok(r.dimensions.every(d => d.questions.every(q => q.downgraded && q.effective === 'partial')));
    // Agent 4 bestätigt mit Beleg → wieder "ja"
    r = s.calculateCASQ2({ validated_casq_checklist: qs.map(q => answer(q.id, 'yes')) }, appraisal, 'narrative');
    assert.equal(r.score, 10);
});

test('CASQ 2.0: kritische Mängel deckeln, nicht Berichtetes erzeugt eine Spanne', () => {
    const qs = allQuestions('quantitative');
    const responses = Object.fromEntries(qs.map(q => [q.id, 'yes']));
    responses['QN-5.2'] = 'no';            // kritisch: Verfahren passen nicht
    const one = s.calculateCASQ2({}, { casq_checklist: qs.map(q => answer(q.id, responses[q.id])) }, 'quantitative');
    assert.equal(one.cap, 5);
    assert.equal(one.score, 5);
    assert.deepEqual(one.critical_flaws, ['QN-5.2']);
    assert.ok(one.score_uncapped > 9);

    responses['QN-6.1'] = 'not_reported';  // zweiter kritischer Punkt, aber nur "nicht berichtet"
    const two = s.calculateCASQ2({}, { casq_checklist: qs.map(q => answer(q.id, responses[q.id])) }, 'quantitative');
    assert.equal(two.cap, 3);
    assert.equal(two.score, 3);
    // Obergrenze: wäre QN-6.1 erfüllt, bliebe nur ein kritischer Mangel → höchstens 5
    assert.equal(two.score_max, 5);
});

test('CASQ 2.0: nicht anwendbar fällt heraus, fehlende Antworten zählen als nicht berichtet', () => {
    const qs = allQuestions('theoretical');
    const list = qs.slice(1).map(q => answer(q.id, q.id === 'TH-4.1' ? 'not_applicable' : 'yes'));
    const r = s.calculateCASQ2({}, { casq_checklist: list }, 'theoretical');
    assert.equal(r.unanswered, 1);                       // TH-1.1 fehlt
    const novelty = r.dimensions.find(d => d.name === 'Novelty');
    assert.equal(novelty.score, null);                  // einzige Frage nicht anwendbar
    const clarity = r.dimensions.find(d => d.name === 'Conceptual clarity');
    assert.equal(clarity.score, 5);                     // 1 von 2 erfüllt
    assert.ok(r.score_max > r.score);
    assert.equal(s.calculateCASQ2({}, {}, 'theoretical'), null, 'ohne Antworten: alter Rechenweg');
});

test('CASQ 2.0: Rubrikwahl, Antwort-Synonyme und Prüffragentext', () => {
    assert.equal(s.selectCASQRubric({ document_type: 'systematic_review' }), 'review');
    assert.equal(s.selectCASQRubric({ document_type: 'primary_empirical_study', study_family: 'Qualitative' }), 'qualitative');
    assert.equal(s.selectCASQRubric({ document_type: 'other', study_family: 'Review' }), 'narrative');
    assert.equal(s.selectCASQRubric({}), 'quantitative');
    assert.equal(s.normalizeChecklistResponse('Partial_yes'), 'partial');
    assert.equal(s.normalizeChecklistResponse('cant_tell'), 'not_reported');
    assert.equal(s.normalizeChecklistResponse('N/A'), 'not_applicable');
    const text = s.casqChecklistText('review');
    assert.match(text, /^RV-1\.1 \[Question & protocol\]/);
    assert.match(text, /RV-2\.1 .*\[KRITISCH\]/);
    for (const rubric of Object.values(s.CASQ_RUBRICS)) {
        assert.equal(rubric.dimensions.reduce((a, d) => a + d.weight, 0), 100);
        assert.ok(rubric.dimensions.every(d => d.questions.length > 0));
    }
});

test('Alle Rubriken: Gewichte ergeben 100, IDs sind eindeutig, jede Rubrik nennt ihre Grundlage', () => {
    const allIds = new Set();
    for (const [key, rubric] of Object.entries(s.CASQ_RUBRICS)) {
        const sum = rubric.dimensions.reduce((a, d) => a + d.weight, 0);
        assert.equal(sum, 100, `${key}: Gewichte ergeben ${sum}`);
        assert.ok(rubric.reference && rubric.reference.length > 20, `${key}: Grundlage fehlt`);
        rubric.dimensions.forEach(d => assert.ok(d.questions.length > 0, `${key}/${d.name} ohne Fragen`));
        rubric.dimensions.flatMap(d => d.questions).forEach(q => {
            assert.ok(!allIds.has(q.id), `ID doppelt: ${q.id}`);
            allIds.add(q.id);
        });
    }
    ['survey_sem', 'experiment', 'platform_data'].forEach(k => assert.ok(s.CASQ_RUBRICS[k], k));
});

test('Fachspezifische Rubriken: Routing nach method_class und Rückfall auf Schlüsselwörter', () => {
    const base = { document_type: 'primary_empirical_study', study_family: 'Quantitative' };
    assert.equal(s.selectCASQRubric({ ...base, method_class: 'survey_sem' }), 'survey_sem');
    assert.equal(s.selectCASQRubric({ ...base, method_class: 'experiment' }), 'experiment');
    assert.equal(s.selectCASQRubric({ ...base, method_class: 'platform_data' }), 'platform_data');
    assert.equal(s.selectCASQRubric({ ...base, method_class: 'other_quantitative' }), 'quantitative');
    // ältere Extraktionen ohne method_class
    assert.equal(s.selectCASQRubric({ ...base, study_design: 'Cross-sectional survey, PLS-SEM' }), 'survey_sem');
    assert.equal(s.selectCASQRubric({ ...base, study_design: 'Online A/B test', methods: ['randomized field experiment'] }), 'experiment');
    assert.equal(s.selectCASQRubric({ ...base, study_design: 'Observational', analysis_methods: ['Sentiment analysis of scraped tweets'] }), 'platform_data');
    assert.equal(s.selectCASQRubric({ ...base, study_design: 'Observational' }), 'quantitative');
    // klinische Studien behalten die allgemeine quantitative Rubrik
    assert.equal(s.selectCASQRubric({ ...base, study_design: 'Randomised controlled trial', clinical_context: { is_health_clinical: true } }), 'quantitative');
    // Dokumenttyp und qualitative Familie haben Vorrang
    assert.equal(s.selectCASQRubric({ document_type: 'systematic_review', study_family: 'Review', method_class: 'survey_sem' }), 'review');
    assert.equal(s.selectCASQRubric({ ...base, study_family: 'Qualitative', method_class: 'survey_sem' }), 'qualitative');
    assert.equal(s.selectCASQRubric({ document_type: 'theoretical_conceptual_paper', study_family: 'Theoretical', study_design: 'survey of the literature' }), 'theoretical');
});

test('Gesundheitsbezug und Ausblenden der medizinischen Instrumente', () => {
    const business = { research_domain: 'Business / Marketing', clinical_context: { is_health_clinical: false } };
    const health = { research_domain: 'Health/Clinical', clinical_context: { is_health_clinical: true } };
    assert.equal(s.isHealthContext(business), false);
    assert.equal(s.isHealthContext(health), true);
    assert.equal(s.isHealthContext({ research_domain: 'Digital Health Marketing' }), true);

    const pedro = () => ({ established_appraisal: { instrument: 'PEDro Scale', applicable: true, items: [{ item_id: '2', response: 'yes' }] } });
    const a = pedro();
    assert.equal(s.restrictMedicalInstruments(a, business, false), true);
    assert.equal(a.established_appraisal.applicable, false);
    assert.equal(a.established_appraisal.instrument, 'none');
    assert.equal(s.calculateEstablishedResult({}, a, business).applicable, false);

    const v = { validated_established_appraisal: pedro().established_appraisal };
    assert.equal(s.restrictMedicalInstruments(v, business, false), true);
    assert.equal(v.validated_established_appraisal.applicable, false);

    const keep = pedro();
    assert.equal(s.restrictMedicalInstruments(keep, health, false), false);
    assert.equal(keep.established_appraisal.applicable, true);
    const allowed = pedro();
    assert.equal(s.restrictMedicalInstruments(allowed, business, true), false, 'ausdrücklich freigegeben');
    assert.equal(allowed.established_appraisal.applicable, true);
});

test('CASQ 2.0 auf einer neuen Rubrik: Berechnung, kritische Deckelung und Grundlage', () => {
    const rubric = s.CASQ_RUBRICS.survey_sem;
    const list = rubric.dimensions.flatMap(d => d.questions).map(q => ({ id: q.id, response: 'yes', evidence: verifiedRef }));
    let r = s.calculateCASQ2({}, { casq_checklist: list }, 'survey_sem');
    assert.equal(r.score, 10);
    assert.equal(r.rubric_reference, rubric.reference);
    const critical = rubric.dimensions.flatMap(d => d.questions).find(q => q.critical);
    const flawed = list.map(a => a.id === critical.id ? { ...a, response: 'no' } : a);
    r = s.calculateCASQ2({}, { casq_checklist: flawed }, 'survey_sem');
    assert.ok(r.score <= 5 && r.cap === 5);
});

test('Etappe 2: Routing für Fallstudie, Bibliometrie, Skalenentwicklung und Business-Review', () => {
    const base = { document_type: 'primary_empirical_study', study_family: 'Qualitative' };
    assert.equal(s.selectCASQRubric({ ...base, method_class: 'case_study' }), 'case_study');
    assert.equal(s.selectCASQRubric({ ...base, study_family: 'Mixed Methods', study_design: 'Multiple case study' }), 'case_study');
    assert.equal(s.selectCASQRubric({ ...base, method_class: 'qualitative' }), 'qualitative');
    assert.equal(s.selectCASQRubric({ document_type: 'systematic_review', study_family: 'Review', method_class: 'bibliometric' }), 'bibliometric');
    assert.equal(s.selectCASQRubric({ document_type: 'primary_empirical_study', study_family: 'Quantitative', study_design: 'Bibliometric analysis with VOSviewer' }), 'bibliometric');
    assert.equal(s.selectCASQRubric({ document_type: 'primary_empirical_study', study_family: 'Quantitative', method_class: 'scale_development' }), 'scale_development');
    assert.equal(s.selectCASQRubric({ document_type: 'primary_empirical_study', study_family: 'Quantitative', study_design: 'Scale development with EFA and CFA' }), 'scale_development');
    // Reviews: Business-Rubrik nur bei Management-/Marketingbezug, sonst die allgemeine
    assert.equal(s.selectCASQRubric({ document_type: 'systematic_review', research_domain: 'Business / Marketing' }), 'review_business');
    assert.equal(s.selectCASQRubric({ document_type: 'systematic_review', research_domain: 'Health/Clinical', clinical_context: { is_health_clinical: true } }), 'review');
    assert.equal(s.selectCASQRubric({ document_type: 'systematic_review' }), 'review');
    // Methodenbeitrag über Bibliometrie bleibt Methodenbeitrag
    assert.equal(s.selectCASQRubric({ document_type: 'methodological_paper', study_design: 'bibliometric method' }), 'methodological');
});

test('PRISMA-Berichtserfüllung wird getrennt vom CASQ ausgewiesen', () => {
    const rubric = s.CASQ_RUBRICS.review_business;
    assert.equal(rubric.reportingLabel, 'PRISMA-2020-Berichtserfüllung');
    const questions = rubric.dimensions.flatMap(d => d.questions);
    const reportingIds = questions.filter(q => q.reporting).map(q => q.id);
    assert.ok(reportingIds.length >= 15 && reportingIds.length < questions.length, 'nicht alle Fragen sind Berichtspunkte');
    // alle erfüllt, außer einem Berichtspunkt (nein) und einer Nicht-Berichtsfrage (nein)
    const nonReporting = questions.find(q => !q.reporting && !q.critical);
    const list = questions.map(q => ({ id: q.id, response: q.id === reportingIds[3] || q.id === nonReporting.id ? 'no' : 'yes', evidence: verifiedRef }));
    const r = s.calculateCASQ2({}, { casq_checklist: list }, 'review_business');
    assert.equal(r.reporting.label, 'PRISMA-2020-Berichtserfüllung');
    assert.equal(r.reporting.considered, reportingIds.length);
    assert.equal(r.reporting.fulfilled, reportingIds.length - 1);
    assert.ok(Math.abs(r.reporting.compliance - (reportingIds.length - 1) / reportingIds.length) < 1e-9);
    // andere Rubriken haben keinen Berichtsblock
    assert.equal(s.calculateCASQ2({}, { casq_checklist: [{ id: 'QN-1.1', response: 'yes', evidence: verifiedRef }] }, 'quantitative').reporting, null);
});


test('Mixed Methods wird auch erkannt, wenn nur das Design so benannt ist', () => {
    const base = { document_type: 'primary_empirical_study', study_family: 'Quantitative' };
    assert.equal(s.selectCASQRubric({ ...base, study_design: 'Mixed-methods study (survey and interviews)' }), 'mixed');
    assert.equal(s.selectCASQRubric({ ...base, study_design: 'mixed methods' }), 'mixed');
    assert.equal(s.selectCASQRubric({ ...base, study_design: 'Observational cohort study' }), 'quantitative');
    assert.equal(s.selectCASQRubric({ ...base, study_design: 'Experiment', method_class: 'experiment' }), 'experiment');
    // Dokumenttypen haben weiter Vorrang
    assert.equal(s.selectCASQRubric({ document_type: 'systematic_review', study_family: 'Review', study_design: 'mixed methods review' }), 'review');
});
