const test = require('node:test');
const assert = require('node:assert/strict');
const st = require('../app/js/stages.js');

const pages = n => Array.from({ length: n }, (_, i) => ({ page: i + 1, text: `Seite ${i + 1} ` + 'x'.repeat(90) }));

test('Etappen: Seiten werden lückenlos auf Abschnitte im Limit verteilt', () => {
    const p = pages(10);   // je Seite ca. 120 Zeichen inkl. Marker
    const total = st.fullEvidenceLength(p);
    const { stages, truncated, covered_chars, total_chars } = st.splitStages(p, 400);
    assert.ok(stages.length >= 3 && stages.length <= 5, 'Etappenzahl ' + stages.length);
    assert.equal(truncated, false);
    assert.equal(total_chars, total);
    assert.equal(covered_chars, total);
    assert.ok(stages.every(s => s.text.length <= 400));
    assert.deepEqual(stages.flatMap(s => s.pages), p.map(x => x.page), 'jede Seite genau einmal, in Reihenfolge');
    assert.equal(stages[0].from, 1);
    assert.match(stages[1].text, /--- PAGE \d+ ---/);
    // ins Limit passt alles: eine Etappe
    assert.equal(st.splitStages(p, 100000).stages.length, 1);
});

test('Etappen: zu lange Einzelseite wird gekürzt, Höchstzahl der Etappen gilt', () => {
    const big = [{ page: 1, text: 'y'.repeat(5000) }, ...pages(2)];
    const r = st.splitStages(big, 1000);
    assert.ok(r.stages[0].text.length <= 1000);
    const many = st.splitStages(pages(40), 300, 4);
    assert.equal(many.stages.length, 4);
    assert.equal(many.truncated, true);
});

test('Extraktionen der Etappen werden zusammengeführt', () => {
    const a = { document_type: 'primary_empirical_study', study_design: 'Survey', research_domain: 'unclear', summary: 'Erste Zusammenfassung', methods: ['PLS-SEM'],
        sample: { n: 'not_reported', population: 'Käufer' }, clinical_context: { is_health_clinical: false, evidence: 'x' }, main_results: [{ result: 'A' }] };
    const b = { document_type: 'unclear', study_design: 'Experiment', research_domain: 'Marketing', summary: 'Zweite', methods: ['PLS-SEM', 'Bootstrapping'],
        sample: { n: '412', population: 'andere' }, clinical_context: { is_health_clinical: true, evidence: 'y' }, main_results: [{ result: 'B' }, { result: 'A' }] };
    const m = st.mergeExtractions([a, b]);
    assert.equal(m.document_type, 'primary_empirical_study');   // erste aussagekräftige Angabe
    assert.equal(m.study_design, 'Survey');
    assert.equal(m.research_domain, 'Marketing');               // erste Etappe „unclear“ → spätere Angabe
    assert.equal(m.summary, 'Erste Zusammenfassung');
    assert.deepEqual(m.methods, ['PLS-SEM', 'Bootstrapping']);
    assert.equal(m.sample.n, '412');
    assert.equal(m.sample.population, 'Käufer');
    assert.equal(m.clinical_context.is_health_clinical, true);  // ODER über die Etappen
    assert.equal(m.main_results.length, 2);
    assert.deepEqual(st.mergeExtractions([]), {});
    assert.deepEqual(st.mergeExtractions([null, a]).methods, ['PLS-SEM']);
});

test('Prüffragen der Etappen: die beste Antwort zählt, Belege bleiben erhalten', () => {
    const ev = [{ page: 12, quote: 'q', verified: false }];
    const s1 = [{ id: 'Q1', response: 'not_reported', evidence: [] }, { id: 'Q2', response: 'no', evidence: [] }, { id: 'Q3', response: 'not_applicable' }, { id: 'Q4', response: 'partial', evidence: [] }];
    const s2 = [{ id: 'Q1', response: 'yes', evidence: ev, rationale: 'gefunden' }, { id: 'Q2', response: 'not_reported', evidence: [] }, { id: 'Q3', response: 'not_applicable' }, { id: 'Q4', response: 'yes', evidence: [] }];
    const s3 = [{ id: 'Q1', response: 'partial', evidence: [] }, { id: 'Q4', response: 'yes', evidence: ev }];
    const merged = st.mergeChecklistStages([s1, s2, s3], ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']);
    const by = id => merged.find(m => m.id === id);
    assert.equal(by('Q1').response, 'yes');
    assert.deepEqual(by('Q1').evidence, ev);
    assert.match(by('Q1').rationale, /Etappe 2\/3/);
    assert.equal(by('Q2').response, 'no');                // „nein“ (berichtet, nicht erfüllt) vor „nicht berichtet“
    assert.equal(by('Q3').response, 'not_applicable');
    assert.deepEqual(by('Q4').evidence, ev, 'bei Gleichstand die Antwort mit Beleg');
    assert.equal(by('Q5'), undefined);
});

test('Mehraufwand und Modellvorschläge', () => {
    assert.equal(st.estimateStagedCalls({ stages: 4, splitExtraction: false, repeatRuns: 1 }), 6);   // 4 + 4 statt 1 + 1
    assert.equal(st.estimateStagedCalls({ stages: 3, splitExtraction: true, repeatRuns: 3 }), 12);   // 9 + 9 statt 3 + 3
    const candidates = [
        { id: 'openai', label: 'OpenAI gpt-4o-mini', contextTokens: 128000 },
        { id: 'gemini', label: 'Gemini', contextTokens: 1000000 },
        { id: 'klein', label: 'Kleines Modell', contextTokens: 8192 },
        { id: 'unbekannt', label: 'ohne Angabe', contextTokens: 0 }
    ];
    // 326.300 Zeichen ≈ 102.000 Token: nur Fenster mit Platz für Antwort (16.384) und Anweisungen (12.000) kommen infrage
    const fit = st.modelSuggestions(candidates, 326300, 16384).map(c => c.id);
    assert.deepEqual(fit, ['gemini']);
    assert.deepEqual(st.modelSuggestions(candidates, 100000, 8192).map(c => c.id), ['openai', 'gemini']);   // kleinstes passendes Fenster zuerst
    assert.deepEqual(st.modelSuggestions(candidates, 4000000, 8192), []);
});
