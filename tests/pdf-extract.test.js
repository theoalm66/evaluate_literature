const test = require('node:test');
const assert = require('node:assert/strict');
const x = require('../app/js/pdf-extract.js');

// Hilfsfunktion: Textstück mit Position (Schriftgröße 10, Breite ≈ 5 pro Zeichen)
const item = (str, px, py, extra = {}) => ({ str, transform: [10, 0, 0, 10, px, py], width: str.length * 5, height: 10, ...extra });

test('Zeilen werden aus den Positionen rekonstruiert, Tabellenspalten durch Tabulatoren getrennt', () => {
    const items = [
        item('Table 1. Baseline', 50, 700),
        item('Group A', 150, 680), item('Group B', 250, 680),
        item('Age', 50, 665), item('54.2', 150, 665), item('55.1', 250, 665),
        item('n', 50, 650), item('30', 150, 650), item('30', 250, 650)
    ];
    assert.equal(x.buildPageText(items), 'Table 1. Baseline\nGroup A\tGroup B\nAge\t54.2\t55.1\nn\t30\t30');
});

test('Leerraum-Stücke über Tabellenlücken (Chromium) stören die Spaltenerkennung nicht', () => {
    const items = [
        item('Group A', 192, 800), { str: ' ', transform: [12, 0, 0, 12, 236, 800], width: 205 }, item('Group B', 390, 800, { hasEOL: true }),
        item('Age', 7, 785), { str: ' ', transform: [12, 0, 0, 12, 28, 785], width: 218 }, item('54.2', 192, 785)
    ];
    assert.equal(x.buildPageText(items), 'Group A\tGroup B\nAge\t54.2');
});

test('Wortteile ohne Abstand werden nicht zerrissen, normale Wortabstände bleiben', () => {
    // "partici" + "pants" direkt aneinander (Kerning), dann normales Wort mit Abstand
    const items = [item('partici', 50, 500), item('pants', 85, 500), item('were', 113, 500)];
    assert.equal(x.buildPageText(items), 'participants were');
});

test('Zeilenende-Markierung, hochgestellte Zeichen und Spaltensprung', () => {
    const items = [
        item('First line', 50, 500, { hasEOL: true }),
        item('second', 50, 488),
        item('2', 80, 492, { transform: [6, 0, 0, 6, 80, 492], width: 3 }),   // hochgestellt, gleiche Zeile
        item('right column text', 320, 488),                                // großer Abstand → Tabulator
        item('back left', 50, 476)
    ];
    assert.equal(x.buildPageText(items), 'First line\nsecond2\tright column text\nback left');
});

test('Seitenmerkmale: Tabellen, Abbildungen, gescannte und leere Seiten', () => {
    assert.equal(x.detectPageFeatures('Results\nTable 2. Outcomes\nA\tB\tC').table, true);
    assert.equal(x.detectPageFeatures('Figure 1. CONSORT flow diagram').figure, true);
    assert.equal(x.detectPageFeatures('a\tb\tc\nd\te\tf\ng\th\ti\nj\tk\tl').table, true);
    assert.equal(x.detectPageFeatures('As shown in Table 2 the effect').table, false);   // nur Verweis im Fließtext
    const scanned = x.detectPageFeatures('', 1);
    assert.equal(scanned.scanned, true);
    assert.equal(x.detectPageFeatures('  ', 0).empty, true);

    const pages = [
        { page: 1, text: 'Title', features: { ...x.detectPageFeatures('x'.repeat(500), 1) } },
        { page: 2, text: '', features: x.detectPageFeatures('', 1) },
        { page: 3, text: 'Table 1. Baseline\nA\tB\tC', features: x.detectPageFeatures('Table 1. Baseline\nA\tB\tC', 0) },
        { page: 4, text: 'Figure 2. Forest plot', features: x.detectPageFeatures('Figure 2. Forest plot', 1) }
    ];
    const q = x.summarizeExtraction(pages);
    assert.deepEqual(q.table_pages, [3]);
    assert.deepEqual(q.figure_pages, [4]);
    assert.deepEqual(q.scanned_pages, [2]);
    assert.equal(q.textless, false);
    assert.equal(x.summarizeExtraction([{ page: 1, text: '', features: x.detectPageFeatures('', 1) }]).textless, true);
    // Seitenbilder: beschriftete Tabelle/Abbildung und gescannte Seite, nicht das Logo auf Seite 1
    assert.deepEqual(x.selectVisualPages(pages).map(p => p.page), [2, 3, 4]);
    assert.equal(x.selectVisualPages(pages, 1).length, 1);
});
