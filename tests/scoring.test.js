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
