const test = require('node:test');
const assert = require('node:assert/strict');
const j = require('../app/js/journals.js');

test('Zeitschriftennamen und ISSN werden vereinheitlicht', () => {
    assert.equal(j.normalizeJournalName('The Journal of Marketing & Media'), 'journal of marketing and media');
    assert.equal(j.normalizeJournalName('  Journal   of Marketing '), 'journal of marketing');
    assert.equal(j.normalizeIssn('0022-2429'), '0022-2429');
    assert.equal(j.normalizeIssn('0749596x'), '0749-596X');
    assert.equal(j.normalizeIssn('abc'), null);
});

test('ISSN werden nur nach dem Wort „ISSN“ erkannt', () => {
    const text = 'Journal of Memory and Language 100 (2018)\nISSN 0749-596X, e-ISSN: 1096-0821\nDOI 10.1016/j.jml.2018.03.004 Seite 2020-1234 Tabelle 1000-2000';
    assert.deepEqual(j.extractIssns(text).sort(), ['0749-596X', '1096-0821']);
    assert.deepEqual(j.extractIssns('Zahlen 1234-5678 ohne Schlüsselwort'), []);
});

const CSV = `zeitschrift;issn;issn_2;vhb;abdc;ft50;sjr;sjr_quartil;bemerkung
Journal of Marketing;0022-2429;1547-7185;A+;A*;ja;11,2;Q1;Test
Journal of Memory and Language;0749-596X;;B;A;nein;2,1;Q1;
;;;A+;;;;;ohne Namen
Kaputt;12;;;;;;;
Journal of Marketing;0022-2429;;;;;;;doppelt`;

test('Zeitschriftenliste: CSV mit Trennzeichen, Dubletten und Fehlern', () => {
    const { rows, errors } = j.parseJournalCsv(CSV);
    assert.equal(rows.length, 3);   // Zeile ohne Angaben und Dublette entfallen; „Kaputt“ bleibt (Name vorhanden) mit Hinweis
    assert.equal(rows[0].vhb, 'A+');
    assert.equal(rows[0].ft50, 'ja');
    assert.equal(rows[1].ft50, 'nein');
    assert.equal(rows[0].issn2, '1547-7185');
    assert.ok(errors.some(e => /ungültig/.test(e)));
    assert.ok(errors.some(e => /doppelt/.test(e)));
    assert.ok(errors.some(e => /weder Zeitschrift noch ISSN/.test(e)));
    assert.deepEqual(j.parseJournalCsv('foo;bar\n1;2').errors, ['Es fehlt die Spalte „zeitschrift“ (oder „issn“).']);
    assert.ok(j.parseJournalCsv(j.buildJournalTemplateCsv()).rows.length === 1);
});

test('Zuordnung: ISSN vor Name, Crossref vor Extraktion, ehrliche Zustände', () => {
    const { rows } = j.parseJournalCsv(CSV);
    // über ISSN, auch bei abweichendem Namen
    let c = j.journalContext(rows, { crossref: { journal: 'J. Mark.', issn: ['0022-2429'] } });
    assert.equal(c.status, 'matched');
    assert.equal(c.match.by, 'ISSN');
    assert.equal(c.match.abdc, 'A*');
    assert.equal(c.source, 'Crossref');
    // zweite ISSN
    assert.equal(j.journalContext(rows, { crossref: { journal: 'x', issn: ['1547-7185'] } }).match.vhb, 'A+');
    // über Namen aus der Extraktion, ISSN aus dem Text
    c = j.journalContext(rows, { llmName: 'the journal of memory and language' });
    assert.equal(c.status, 'matched');
    assert.equal(c.match.by, 'Name');
    assert.equal(c.source, 'Extraktion aus dem PDF');
    c = j.journalContext(rows, { textIssns: ['0749-596X'] });
    assert.equal(c.match.by, 'ISSN');
    assert.equal(c.source, 'ISSN im PDF-Text');
    // nicht in der Liste, keine Liste, unbekannt
    assert.equal(j.journalContext(rows, { llmName: 'Unbekannte Zeitschrift' }).status, 'not_in_list');
    assert.equal(j.journalContext([], { llmName: 'Journal of Marketing' }).status, 'no_list');
    assert.equal(j.journalContext(rows, { llmName: 'not_reported' }).status, 'unknown_venue');
    assert.equal(j.journalContext(rows, {}).status, 'unknown_venue');
});

test('Der Zeitschriftenkontext ändert den CASQ nicht', () => {
    const s = require('../app/js/scoring.js');
    const ids = s.CASQ_RUBRICS.experiment.dimensions.flatMap(d => d.questions).map(q => ({ id: q.id, response: 'yes', evidence: [{ page: 1, quote: 'x', verified: true }] }));
    const before = s.calculateCASQ2({}, { casq_checklist: ids }, 'experiment').score;
    const ctx = j.journalContext(j.parseJournalCsv(CSV).rows, { llmName: 'Journal of Marketing' });
    assert.equal(ctx.status, 'matched');
    assert.equal(s.calculateCASQ2({}, { casq_checklist: ids, journal_context: ctx }, 'experiment').score, before);
});
