const test = require('node:test');
const assert = require('node:assert/strict');
const i = require('../app/js/integrity.js');

const page = (n, text) => ({ page: n, text });

test('statcheck: konsistente, inkonsistente und grob falsche Angaben', () => {
    const pages = [page(4, 'The effect was significant, t(28) = 2.10, p = .045. The interaction F(2, 57) = 1.20, p < .05 was not. '
        + 'A trend r(28) = .30, p = .11 and χ2(1, N = 120) = 3.84, p = .050 as well as z = −2.58, p = .01.')];
    const stats = i.findStatistics(pages);
    const byTest = Object.fromEntries(stats.map(s => [s.test, s]));
    assert.equal(stats.length, 5);
    assert.equal(byTest.t.consistent, true);
    assert.equal(byTest.F.consistent, false);          // F(2,57)=1.20 hat p ≈ .31
    assert.equal(byTest.F.gross_error, true);           // als signifikant berichtet
    assert.equal(byTest.r.consistent, true);
    assert.equal(byTest.chi2.consistent, true);
    assert.deepEqual(byTest.chi2.df, [1]);
    assert.equal(byTest.z.consistent, true);
    assert.equal(byTest.z.value, -2.58);
    assert.match(byTest.F.label, /F\(2, 57\) = 1\.20, p < \.05/);
});

test('statcheck: Rundung, p = .000 und möglicherweise einseitig', () => {
    // t(20) = 2.09 → p ≈ .0496; als ".05" berichtet ist das durch Rundung gedeckt
    assert.equal(i.checkStatistic({ test: 't', df: [20], valueStr: '2.09', op: '=', pStr: '.05' }).consistent, true);
    // "p = .000" wird als p < .0005 gelesen
    assert.equal(i.checkStatistic({ test: 't', df: [50], valueStr: '5.20', op: '=', pStr: '.000' }).consistent, true);
    // einseitig: t(30) = 1.80 → zweiseitig .082, einseitig .041
    const one = i.checkStatistic({ test: 't', df: [30], valueStr: '1.80', op: '=', pStr: '.041' });
    assert.equal(one.consistent, false);
    assert.equal(one.one_tailed_possible, true);
    assert.equal(one.gross_error, true);
});

test('GRIM: unmögliche Mittelwerte bei kleinen Stichproben', () => {
    assert.equal(i.grimConsistent(3.50, 15, 2), false);  // möglich wären nur 52/15 = 3.47 oder 53/15 = 3.53
    assert.equal(i.grimConsistent(3.45, 17, 2), false);  // 58/17 = 3.41, 59/17 = 3.47
    assert.equal(i.grimConsistent(3.47, 15, 2), true);   // 52/15 = 3.4667
    assert.equal(i.grimConsistent(3.53, 15, 2), true);   // 53/15 = 3.5333
    assert.equal(i.grimConsistent(3.5, 200, 1), null);   // n zu groß für eine Aussage
    const found = i.findGrimCandidates([page(3, 'Group A (M = 3.48, SD = 1.1, n = 25) and group B (M = 2.53, n = 15).')]);
    assert.equal(found.length, 2);
    assert.equal(found.find(f => f.n === 25).consistent, true);   // 87/25 = 3.48
    assert.equal(found.find(f => f.n === 15).consistent, true);   // 38/15 = 2.533
});

test('Stichprobengrößen, Registrierungen und DOI', () => {
    const pages = [
        page(1, 'doi: 10.1016/j.jclinepi.2021.03.005. Registered at ClinicalTrials.gov (NCT01234567) and DRKS00012345.'),
        page(2, 'In total N = 120 patients were randomised; analysed N = 112 (n = 56 per group). PROSPERO CRD42019123456; osf.io/ab3cd.'),
        page(9, 'Reference: Smith 2019, doi 10.1000/other.')
    ];
    const sizes = i.findSampleSizes(pages);
    const summary = i.summarizeSampleSizes(sizes, '120 Patienten');
    assert.deepEqual(summary.totals, [120, 112]);
    assert.equal(summary.multiple_totals, true);
    assert.equal(summary.extracted_n_found, true);
    assert.deepEqual(i.summarizeSampleSizes(i.findSampleSizes([page(1, 'In total N = 60. Mean n = 2.5 per cell.')]), null).totals, [60]);
    assert.deepEqual(i.findSampleSizes([page(1, 'n = 2.5')]), []);
    const reg = i.findRegistrations(pages);
    assert.deepEqual(reg.ids.map(r => r.registry).sort(), ['ClinicalTrials.gov', 'DRKS', 'OSF', 'PROSPERO']);
    assert.equal(reg.preregistration_mentioned, true);
    assert.equal(i.findDoi(pages), '10.1016/j.jclinepi.2021.03.005');
});

test('Vergleich Code ↔ LLM ordnet Tests einander zu', () => {
    const computed = i.runComputedIntegrity([page(4, 't(28) = 2.10, p = .045 and F(2, 57) = 1.20, p < .05')], {});
    const llm = { statistical_tests: [
        { test: 't', df: '28', statistic: 2.1, consistent: 'yes' },
        { test: 'F', df: '2, 57', statistic: 1.2, consistent: 'yes' },     // LLM übersieht den Fehler
        { test: 'z', df: '', statistic: 3.1, consistent: 'no' }            // nur vom LLM gefunden
    ] };
    const cmp = i.compareIntegrity(computed, llm);
    assert.equal(cmp.found_by_both, 2);
    assert.equal(cmp.found_by_code, 2);
    assert.equal(cmp.found_by_llm, 3);
    assert.equal(cmp.verdict_agreement, 0.5);
});

test('Crossref-Titelabgleich', () => {
    assert.equal(i.titleMatchesText('Supervised exercise for chronic low back pain', 'SUPERVISED EXERCISE for Chronic Low Back Pain: an RCT'), true);
    assert.equal(i.titleMatchesText('Something completely different here', 'Supervised exercise for chronic low back pain'), false);
});
