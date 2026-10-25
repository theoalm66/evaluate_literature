// ==========================================
// PDF EINLESEN (pdf.js) – layout-bewusst
// ==========================================
// pdf.js liefert pro Seite kleine Textstücke mit Position. Bisher wurden sie mit Leerzeichen zu einer
// einzigen Zeile verbunden; Tabellen verloren dabei ihre Zeilen/Spalten. Jetzt wird aus den Positionen
// der Zeilenaufbau rekonstruiert, größere horizontale Abstände (Tabellenspalten) werden zu Tabulatoren,
// und Wortteile ohne Abstand werden nicht mehr durch Leerzeichen zerrissen.
// Die Reihenfolge der Stücke bleibt die der PDF-Datei – damit bleiben zweispaltige Layouts lesbar.

const LINE_TOLERANCE = 0.5;     // Anteil der Schriftgröße, ab dem ein y-Versatz eine neue Zeile ist
const WORD_GAP = 0.12;          // ab diesem Abstand (× Schriftgröße) wird ein Leerzeichen eingefügt
const COLUMN_GAP = 1.2;         // ab diesem Abstand ein Tabulator (Tabellenspalte)
const MAX_VISUAL_PAGES = 6;     // höchstens so viele Seitenbilder je PDF an das Modell
const VISUAL_TARGET_WIDTH = 1400;

function buildPageText(items) {
    let out = '';
    let prev = null;
    for (const item of items || []) {
        const str = item?.str ?? '';
        const t = item?.transform || [1, 0, 0, 1, 0, 0];
        const size = Math.hypot(t[2], t[3]) || item?.height || 10;
        const x = t[4], y = t[5];
        if (!str.trim()) {
            // Leere bzw. reine Leerraum-Stücke: pdf.js nutzt sie als Zeilenende-Markierung, manche PDF-Erzeuger
            // (z.B. Chromium) füllen damit Tabellenlücken. Ihre Breite würde den Abstand verfälschen.
            if (item?.hasEOL && prev) prev.eol = true;
            continue;
        }
        if (prev) {
            const ref = Math.max(size, prev.size);
            const gap = x - (prev.x + prev.width);
            const newLine = prev.eol || Math.abs(y - prev.y) > ref * LINE_TOLERANCE || gap < -ref * 2;
            if (newLine) out += '\n';
            else if (gap > ref * COLUMN_GAP) out += '\t';
            else if (gap > ref * WORD_GAP && !/\s$/.test(out) && !/^\s/.test(str)) out += ' ';
        }
        out += str;
        prev = { x, y, width: item.width || 0, size, eol: !!item.hasEOL };
    }
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const TABLE_CAPTION = /^\s*(?:Table|Tabelle|Tab\.)\s*(?:\d+|[IVX]+)\b/im;
const FIGURE_CAPTION = /^\s*(?:Fig\.|Figure|Abb\.|Abbildung)\s*\d+\b/im;

// Erkennt Tabellen (Beschriftung oder mehrere Zeilen mit Spalten) und Abbildungen (Beschriftung oder Bilder).
function detectPageFeatures(text, imageCount = 0) {
    const chars = String(text || '').replace(/\s/g, '').length;
    const tabularLines = String(text || '').split('\n').filter(l => (l.match(/\t/g) || []).length >= 2).length;
    const figure = FIGURE_CAPTION.test(text);
    return {
        chars,
        images: imageCount,
        table: TABLE_CAPTION.test(text) || tabularLines >= 4,
        figure,
        // Seiten mit (fast) keinem Text: gescannt (Bild ohne Abbildungsbeschriftung) oder leer
        scanned: chars < 40 && imageCount > 0 && !figure,
        empty: chars < 40 && imageCount === 0 && !figure
    };
}

function summarizeExtraction(pages) {
    const list = pages || [];
    const pick = key => list.filter(p => p.features?.[key]).map(p => p.page);
    const totalChars = list.reduce((a, p) => a + (p.features?.chars || 0), 0);
    return {
        pages: list.length,
        chars: totalChars,
        table_pages: pick('table'),
        figure_pages: pick('figure'),
        image_pages: list.filter(p => (p.features?.images || 0) > 0).map(p => p.page),
        scanned_pages: pick('scanned'),
        empty_pages: pick('empty'),
        // Keine verwertbare Textschicht: Analyse wäre nur Raten
        textless: list.length > 0 && totalChars < 200,
        mostly_scanned: list.length > 0 && pick('scanned').length / list.length >= 0.5
    };
}

// Welche Seiten zusätzlich als Bild ans Modell gehen: zuerst Tabellen/Abbildungen mit Beschriftung,
// dann Seiten mit tabellenartigen Zeilen oder Bildern (Seite 1 mit Verlagslogo nur, wenn beschriftet).
function selectVisualPages(pages, max = MAX_VISUAL_PAGES) {
    const scored = (pages || []).map(p => {
        const f = p.features || {};
        const captioned = TABLE_CAPTION.test(p.text) || FIGURE_CAPTION.test(p.text);
        const score = (captioned ? 3 : 0) + (f.table ? 2 : 0) + (f.figure ? 2 : 0) + (f.images > 0 && p.page > 1 ? 1 : 0) + (f.scanned ? 2 : 0);
        return { page: p.page, score, reason: [f.table && 'Tabelle', f.figure && 'Abbildung', f.scanned && 'gescannt', !f.table && !f.figure && f.images > 0 && 'Bild'].filter(Boolean).join(', ') };
    }).filter(p => p.score > 0);
    return scored.sort((a, b) => b.score - a.score || a.page - b.page).slice(0, max).sort((a, b) => a.page - b.page);
}

async function countImages(page) {
    try {
        const ops = await page.getOperatorList();
        const OPS = pdfjsLib.OPS;
        const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintJpegXObject].filter(v => v !== undefined));
        return ops.fnArray.reduce((n, fn) => n + (imageOps.has(fn) ? 1 : 0), 0);
    } catch (e) {
        return 0;
    }
}

async function renderPageImage(page) {
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, VISUAL_TARGET_WIDTH / base.width) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const url = canvas.toDataURL('image/jpeg', 0.8);
    canvas.width = canvas.height = 0;
    return url;
}

// Liest ein PDF ein. Mit renderVisuals werden Seiten mit Tabellen/Abbildungen zusätzlich als Bild erzeugt.
async function extractPdf(file, { renderVisuals = false } = {}) {
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    let fullText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const text = buildPageText(content.items);
        const features = detectPageFeatures(text, await countImages(page));
        pages.push({ page: i, text, features });
        fullText += `\n--- PAGE ${i} ---\n${text}\n`;
    }
    const quality = summarizeExtraction(pages);
    const visuals = [];
    if (renderVisuals) {
        for (const sel of selectVisualPages(pages)) {
            try {
                visuals.push({ page: sel.page, reason: sel.reason, dataUrl: await renderPageImage(await pdf.getPage(sel.page)) });
            } catch (e) {
                console.warn(`Seite ${sel.page} konnte nicht als Bild erzeugt werden:`, e);
            }
        }
    }
    pdf.destroy();
    return { fullText, pages, numPages: pages.length, quality, visuals };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildPageText, detectPageFeatures, summarizeExtraction, selectVisualPages };
}
