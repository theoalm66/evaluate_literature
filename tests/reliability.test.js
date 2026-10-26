const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../app/js/reliability.js');

const close = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('Cohen-Kappa: Lehrbuchbeispiel und Randfälle', () => {
    // 2×2: 20 ja/ja, 5 ja/nein, 10 nein/ja, 15 nein/nein → po = .70, pe = .50, κ = .40
    const pairs = [...Array(20).fill(['y', 'y']), ...Array(5).fill(['y', 'n']), ...Array(10).fill(['n', 'y']), ...Array(15).fill(['n', 'n'])];
    const k = r.cohenKappa(pairs);
    close(k.kappa, 0.4); close(k.observed, 0.7); close(k.expected, 0.5); assert.equal(k.n, 50);
    assert.equal(r.cohenKappa([['a', 'a'], ['b', 'b']]).kappa, 1);
    assert.equal(r.cohenKappa([['a', 'a'], ['a', 'a']]).kappa, null, 'ohne Variation nicht definiert');
    assert.equal(r.cohenKappa([]).kappa, null);
    assert.ok(r.cohenKappa([['a', 'b'], ['b', 'a']]).kappa < 0, 'systematische Gegensätze → negativ');
});

test('Gewichtetes Kappa (linear) bei geordneten Kategorien', () => {
    const pairs = [['A', 'A'], ['B', 'B'], ['C', 'C'], ['A', 'B'], ['B', 'C']];
    // von Hand: po_w = .8, pe_w = .56 → κ_w = .24/.44
    close(r.cohenKappa(pairs, { categories: ['A', 'B', 'C'], weighted: true }).kappa, 0.24 / 0.44);
    // ungewichtet fällt strenger aus
    assert.ok(r.cohenKappa(pairs, { categories: ['A', 'B', 'C'] }).kappa < 0.54);
});

test('Fleiss-Kappa: Beispiel aus der Literatur (10 Fälle, 14 Bewerter, 5 Kategorien)', () => {
    const counts = [[0, 0, 0, 0, 14], [0, 2, 6, 4, 2], [0, 0, 3, 5, 6], [0, 3, 9, 2, 0], [2, 2, 8, 1, 1],
        [7, 7, 0, 0, 0], [3, 2, 6, 3, 0], [2, 5, 3, 2, 2], [6, 5, 2, 1, 0], [0, 2, 2, 3, 7]];
    close(r.fleissKappa(counts), 0.210, 0.002);
    assert.equal(r.fleissKappa([[3, 0], [3, 0]]), null, 'ohne Variation nicht definiert');
});

test('ICC(2,1): Beispiel von Shrout & Fleiss (1979), Bland-Altman, Pearson', () => {
    const data = [[9, 2, 5, 8], [6, 1, 3, 2], [8, 4, 6, 8], [7, 1, 2, 6], [10, 5, 6, 9], [6, 2, 4, 7]];
    close(r.icc21(data), 0.29, 0.005);
    assert.equal(r.icc21([[1, 1], [2, 2], [3, 3], [4, 4]]) > 0.999, true, 'identische Bewertungen → 1');
    assert.equal(r.icc21([[1, 2]]), null);
    const ba = r.blandAltman([[5, 4], [6, 6], [7, 5], [8, 8]]);
    close(ba.bias, 0.75); close(ba.loa_high - ba.loa_low, 2 * 1.96 * r.sampleSd([1, 0, 2, 0]));
    close(r.pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1);
    assert.equal(r.pearson([1, 1, 1], [1, 2, 3]), null);
});

test('Numerische Übereinstimmung und reproduzierbares Bootstrap', () => {
    const pairs = [[7, 7], [6, 7], [8, 6], [5, 5], [9, 8], [4, 6], [7, 7], [6, 5]];
    const a = r.numericAgreement(pairs), b = r.numericAgreement(pairs);
    assert.equal(a.n, 8);
    close(a.mae, 0.875);
    close(a.bias, 0.125);
    assert.equal(a.within_share, 6 / 8);
    assert.deepEqual(a.ci, b.ci, 'gleiches Seed → gleiche Intervalle');
    assert.ok(a.ci.mae[0] <= a.mae && a.mae <= a.ci.mae[1]);
    assert.equal(r.numericAgreement(pairs.slice(0, 3)).ci, null, 'unter 5 Paaren keine Intervalle');
    assert.equal(r.numericAgreement([]).n, 0);
});

test('Deutung und Warnung bei kleiner Stichprobe', () => {
    assert.equal(r.interpretKappa(0.55), 'moderat');
    assert.equal(r.interpretKappa(0.9), 'nahezu perfekt');
    assert.equal(r.interpretKappa(-0.1), 'schlechter als Zufall');
    assert.equal(r.interpretKappa(null), 'nicht berechenbar');
    assert.equal(r.interpretICC(0.8), 'gut');
    assert.equal(r.interpretICC(0.3), 'schlecht');
    assert.match(r.sampleSizeWarning(3), /Weniger als 5/);
    assert.match(r.sampleSizeWarning(12), /Nur 12/);
    assert.equal(r.sampleSizeWarning(40), '');
});

test('Mehrheitsentscheid: Gleichstand → vorsichtigere Antwort', () => {
    const m = r.majority(['yes', 'yes', 'partial']);
    assert.equal(m.value, 'yes'); assert.equal(m.unanimous, false); close(m.share, 2 / 3);
    assert.equal(r.majority(['yes', 'no']).value, 'no');
    assert.equal(r.majority(['yes', 'partial']).value, 'partial');
    assert.equal(r.majority(['yes', 'yes']).unanimous, true);
    const s = r.scoreSpread([7, 8, 6.5]);
    assert.equal(s.median, 7); assert.equal(s.min, 6.5); assert.equal(s.max, 8);
    assert.equal(r.scoreSpread([null, NaN]).median, null);
});

test('Mehrfachbewertung der CASQ-Prüffragen: Mehrheit, unsichere Fragen, Kappa', () => {
    const ans = (id, response, quote) => ({ id, response, evidence: quote ? [{ page: 1, quote }] : [], rationale: `Grund ${id}` });
    const runs = [
        [ans('Q1', 'yes', 'zitat1'), ans('Q2', 'yes', 'zitat2'), ans('Q3', 'no')],
        [ans('Q1', 'yes', 'zitat1b'), ans('Q2', 'partial', 'zitat2b'), ans('Q3', 'no')],
        [ans('Q1', 'yes', 'zitat1c'), ans('Q2', 'yes', 'zitat2c'), ans('Q3', 'not_reported')]
    ];
    const agg = r.aggregateChecklistRuns(runs, ['Q1', 'Q2', 'Q3']);
    assert.deepEqual(agg.merged.map(m => m.response), ['yes', 'yes', 'no']);
    assert.equal(agg.merged[1].evidence[0].quote, 'zitat2', 'Beleg stammt aus einem Durchlauf mit der Mehrheitsantwort');
    assert.match(agg.merged[1].rationale, /\[Mehrheit 2\/3\]/);
    assert.deepEqual(agg.uncertain.map(u => u.id), ['Q2', 'Q3']);
    close(agg.agreement, (1 + 2 / 3 + 2 / 3) / 3);
    close(agg.unanimous_share, 1 / 3);
    assert.ok(agg.fleiss !== null && agg.fleiss > 0 && agg.fleiss < 1);
    // fehlende Antwort in einem Durchlauf zählt als "nicht berichtet"
    const missing = r.aggregateChecklistRuns([[ans('Q1', 'yes', 'z')], []], ['Q1']);
    assert.equal(missing.merged[0].response, 'not_reported', 'Gleichstand yes/not_reported → vorsichtigere Antwort');
});

test('Mehrfachbewertung etablierter Instrumente (PEDro): Item-Mehrheit', () => {
    const run = (responses, instrument = 'PEDro Scale') => ({
        instrument, applicable: true,
        items: responses.map((resp, i) => ({ item_id: String(i + 2), response: resp, points: resp === 'yes' ? 1 : 0 }))
    });
    const agg = r.aggregateEstablishedRuns([run(['yes', 'yes', 'no']), run(['yes', 'no', 'no']), run(['yes', 'yes', 'yes'])]);
    assert.equal(agg.instrument, 'PEDro Scale');
    assert.deepEqual(agg.merged.items.map(i => i.response), ['yes', 'yes', 'no']);
    assert.deepEqual(agg.uncertain.map(u => u.item_id), ['3', '4']);
    close(agg.agreement, (1 + 2 / 3 + 2 / 3) / 3);
    // abweichendes Instrument eines Durchlaufs wird überstimmt
    const mixed = r.aggregateEstablishedRuns([run(['yes']), run(['yes']), { instrument: 'MINORS', applicable: true, items: [] }]);
    assert.equal(mixed.instrument, 'PEDro Scale'); assert.equal(mixed.applicable_runs, 2);
    const none = r.aggregateEstablishedRuns([{ instrument: 'none', applicable: false, items: [] }]);
    assert.equal(none.applicable_runs, 0);
});

test('CSV: Trennzeichen, Anführungszeichen, Umlaute, BOM', () => {
    assert.deepEqual(r.parseCSV('\uFEFFa;b\r\n"x;y";"sagt ""hallo"""\r\n'), [['a', 'b'], ['x;y', 'sagt "hallo"']]);
    assert.deepEqual(r.parseCSV('a,b\n1,2\n\n3,4'), [['a', 'b'], ['1', '2'], ['3', '4']]);
    assert.deepEqual(r.parseCSV('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
});

test('Expertenbewertungen aus CSV: Spalten, Prüfungen, PEDro-Summe aus Items', () => {
    const csv = [
        'Dokument;DOI;PEDro gesamt;PEDro_2;pedro_3;pedro_4;pedro_5;pedro_6;pedro_7;pedro_8;pedro_9;pedro_10;pedro_11;AMSTAR 2;CASQ Experte',
        'Studie-A.pdf;https://doi.org/10.1/ABC;7;ja;ja;nein;ja;nein;nein;ja;ja;ja;ja;moderat;7,5',
        'Studie B;;;y;y;y;n;n;n;y;y;y;n;;',
        'Studie C;;11;;;;;;;;;;;High;',
        'Studie D;;5;;;;;;;;;;;banane;12'
    ].join('\n');
    const { rows, errors } = r.parseExpertCsv(csv);
    assert.equal(rows.length, 4);
    assert.equal(rows[0].key, r.normalizeDocKey('Studie-A.pdf'));
    assert.equal(rows[0].key, r.normalizeDocKey('C:\\Daten\\studie a.PDF'), 'Pfad, Endung, Groß-/Kleinschreibung egal');
    assert.equal(rows[0].doi, '10.1/abc');
    assert.equal(rows[0].pedro_total, 7);
    assert.equal(rows[0].pedro_items['4'], 'no');
    assert.equal(rows[0].amstar2, 'moderate');
    assert.equal(rows[0].casq, 7.5);
    assert.equal(rows[1].pedro_total, 6, 'Summe aus den zehn Items');
    assert.equal(rows[2].pedro_total, null, '11 liegt außerhalb 0–10');
    assert.equal(rows[3].amstar2, null);
    assert.equal(rows[3].casq, null);
    assert.equal(errors.length, 3);
    assert.ok(errors.some(e => e.includes('Zeile 4') && e.includes('11')));
    assert.deepEqual(r.parseExpertCsv('foo;bar\n1;2').errors, ['Es fehlt die Spalte „dokument“ (Dateiname oder Titel) bzw. „doi“.']);
    assert.match(r.parseExpertCsv('dokument\n').errors[0], /keine Datenzeilen/);
});

test('Vorlage enthält alle Spalten und die Dokumente', () => {
    const csv = r.buildTemplateCsv(['a.pdf', 'b;c.pdf']);
    const lines = csv.replace('\uFEFF', '').trim().split('\r\n');
    assert.equal(lines[0], 'dokument;doi;pedro_gesamt;pedro_2;pedro_3;pedro_4;pedro_5;pedro_6;pedro_7;pedro_8;pedro_9;pedro_10;pedro_11;amstar2;casq_experte');
    assert.ok(lines[1].startsWith('a.pdf;;'));
    assert.ok(lines[2].startsWith('"b;c.pdf";'));
    // Vorlage lässt sich wieder einlesen
    assert.equal(r.parseExpertCsv(csv).rows.length, 2);
});

test('Abgleich mit Referenzen: PEDro-Summe, Items, AMSTAR 2, CASQ', () => {
    const pedro = (total, yes) => ({ total, items: Object.fromEntries(r.PEDRO_ITEM_IDS.map(id => [id, yes.includes(id) ? 'yes' : 'no'])) });
    const studies = [
        { key: 'a', agent: { pedro: pedro(7, ['2', '3', '5', '8', '9', '10', '11']), amstar2: null, casq: 7 } },
        { key: 'b', agent: { pedro: pedro(5, ['2', '3', '8', '9', '10']), amstar2: null, casq: 5 } },
        { key: 'c', agent: { pedro: null, amstar2: 'low', casq: 6 } },
        { key: 'd', agent: { pedro: pedro(4, ['2', '3']), amstar2: null, casq: null } },
        { key: 'ohne-ref', agent: { pedro: pedro(9, r.PEDRO_ITEM_IDS), amstar2: null, casq: 9 } }
    ];
    const exp = (total, yes) => ({ pedro_total: total, pedro_items: Object.fromEntries(r.PEDRO_ITEM_IDS.map(id => [id, yes.includes(id) ? 'yes' : 'no'])), amstar2: null, casq: null });
    const refs = new Map([
        ['a', { ...exp(7, ['2', '3', '5', '8', '9', '10', '11']), casq: 8 }],
        ['b', { ...exp(6, ['2', '3', '4', '8', '9', '10']), casq: 5 }],
        ['c', { pedro_total: null, pedro_items: {}, amstar2: 'moderate', casq: 6 }],
        ['d', { ...exp(4, ['2', '3']) }]
    ]);
    const res = r.compareWithReferences(studies, refs);
    assert.equal(res.documents.length, 4);
    assert.equal(res.pedro_total.n, 3);                 // a, b, d
    close(res.pedro_total.mae, 1 / 3);
    close(res.pedro_total.bias, -1 / 3);
    assert.equal(res.casq.n, 3);                        // a, b, c
    close(res.casq.mae, 1 / 3);
    assert.equal(res.pedro_items.n, 30);
    // eine Abweichung bei Item 4/5 von b: 28 von 30 gleich, plus a und d stimmen
    assert.ok(res.pedro_items.exact_agreement > 0.9 && res.pedro_items.kappa > 0.8);
    assert.ok(res.pedro_items.pabak !== null);
    assert.equal(res.pedro_item_detail.length, 10);
    assert.equal(res.pedro_item_detail[0].n, 3);
    assert.equal(res.pedro_item_detail[0].kappa, null, 'unter 5 Dokumenten kein Kappa je Item');
    assert.equal(res.amstar2.n, 1);
    close(res.amstar2.exact_agreement, 0);
    assert.equal(r.compareWithReferences([], new Map()).pedro_total, null);
});

test('Bewertung der App aus einem etablierten Ergebnis', () => {
    const established = { applicable: true, instrument: 'PEDro Scale', score: 4, items: [{ item_id: '2', response: 'yes' }, { item_id: '3', response: 'no' }] };
    const a = r.agentAssessment(established, 7.64);
    assert.equal(a.pedro.total, 4);
    assert.equal(a.pedro.items['2'], 'yes');
    assert.equal(a.pedro.items['3'], 'no');
    assert.equal(a.pedro.items['11'], 'no', 'nicht berichtet = nicht erfüllt');
    assert.equal(a.casq, 7.64);
    assert.equal(r.agentAssessment({ applicable: true, instrument: 'AMSTAR 2', rating: 'Critically low' }, null).amstar2, 'critically_low');
    assert.equal(r.agentAssessment({ applicable: false, instrument: 'none' }, null).pedro, null);
    assert.equal(r.agentAssessment(null, 'x').casq, null);
});
