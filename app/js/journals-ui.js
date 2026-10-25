// ==========================================
// ZEITSCHRIFTENLISTE (Konfiguration) und Anzeige im Ergebnis
// ==========================================
// Die Liste liegt pro Nutzer lokal im Browser (IndexedDB, Tabelle meta), ist Teil von Export/Import und wird nicht mit dem Spark
// synchronisiert. Der CASQ bleibt davon unberührt.

const journalKey = user => `journals|${user}`;

async function loadJournals(user = currentUser) {
    if (!user) return { rows: [], updatedAt: null };
    const stored = await getMeta(journalKey(user));
    return stored && Array.isArray(stored.rows) ? stored : { rows: [], updatedAt: null };
}

async function saveJournals(rows, user = currentUser) {
    const value = { rows, updatedAt: new Date().toISOString() };
    await setMeta(journalKey(user), value);
    return value;
}

async function refreshJournalStatus() {
    const el = document.getElementById('journal-status');
    if (!el || !currentUser) return;
    const list = await loadJournals();
    el.textContent = list.rows.length
        ? `${list.rows.length} Zeitschrift(en) in Ihrer Liste (Stand ${new Date(list.updatedAt).toLocaleString()}).`
        : 'Noch keine Liste importiert – der Zeitschriftenkontext bleibt leer.';
}

async function importJournalCsv(fileList) {
    const file = fileList && fileList[0];
    document.getElementById('journal-csv-input').value = '';
    const msg = document.getElementById('journal-message');
    if (!file || !currentUser) return;
    const { rows, errors } = parseJournalCsv(await file.text());
    if (!rows.length) {
        msg.className = 'model-search-status err';
        msg.textContent = errors[0] || 'Keine Zeitschriften gefunden.';
        return;
    }
    // Die neue Datei ersetzt die bisherige Liste (so lässt sich die Liste jährlich aktualisieren).
    await saveJournals(rows);
    msg.className = `model-search-status ${errors.length ? 'warn' : 'ok'}`;
    msg.innerHTML = `${rows.length} Zeitschrift(en) übernommen; die bisherige Liste wurde ersetzt.`
        + (errors.length ? `<br><span style="color:#b45309;">${errors.length} Hinweis(e): ${escapeHTML(errors.slice(0, 5).join(' · '))}${errors.length > 5 ? ' …' : ''}</span>` : '');
    await refreshJournalStatus();
}

async function downloadJournalTemplate() {
    const msg = document.getElementById('journal-message');
    const studies = [];
    if (currentUser) for (const run of await listRuns(currentUser)) studies.push(...(run.result?.study_results || []));
    const existing = currentUser ? (await loadJournals()).rows : [];
    const { csv, added, total } = buildJournalTemplateFromStudies(existing, studies);
    msg.className = 'model-search-status ok';
    msg.textContent = total
        ? `Vorlage mit ${total} Zeitschrift(en): ${existing.length} aus Ihrer Liste, ${added} neu aus Ihren Auswertungen erkannt (nur Name und ISSN; die Ratings tragen Sie nach).`
        : 'Es gibt noch keine ausgewerteten Studien und keine Liste – die Vorlage enthält nur eine Beispielzeile.';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'zeitschriftenliste-vorlage.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function clearJournals() {
    if (!currentUser || !confirm('Zeitschriftenliste wirklich löschen?')) return;
    await saveJournals([]);
    document.getElementById('journal-message').textContent = '';
    await refreshJournalStatus();
}

// Kandidaten für die Zuordnung: Crossref (falls die Online-Prüfung lief), ISSN im PDF-Text, Name aus der Extraktion.
function journalContextForDoc(rows, doc, ext, integrity) {
    const head = (doc.pages || []).slice(0, 2).map(p => p.text).join('\n');
    return journalContext(rows, {
        crossref: integrity?.online?.journal || integrity?.online?.issn?.length ? { journal: integrity.online.journal, issn: integrity.online.issn || [] } : null,
        textIssns: extractIssns(head),
        llmName: ext?.publication_venue || ''
    });
}

function renderJournalContext(ctx) {
    if (!ctx) return '';
    const note = 'Zusatzinformation zur Publikation – geht nicht in den CASQ ein. Die Werte stammen aus Ihrer importierten Liste und werden von der App nicht geprüft.';
    const head = `<div style="font-weight:600;margin-bottom:.25rem;">Zeitschriftenkontext</div>`;
    const wrap = body => `<div style="margin:.8rem 0;padding:.75rem;background:#f8fafc;border:1px solid var(--border);border-radius:.5rem;font-size:.85rem;">${head}${body}<div style="font-size:.72rem;color:var(--text-light);margin-top:.35rem;">${escapeHTML(note)}</div></div>`;
    const venue = ctx.venue_name ? `<strong>${escapeHTML(ctx.venue_name)}</strong>${ctx.issns.length ? ` · ISSN ${escapeHTML(ctx.issns.join(', '))}` : ''} <span style="color:var(--text-light);">(erkannt über ${escapeHTML(ctx.source || 'unbekannt')})</span>` : '';
    if (ctx.status === 'unknown_venue') return wrap('Die Zeitschrift konnte aus dem PDF nicht bestimmt werden.');
    if (ctx.status === 'no_list') return wrap(`${venue}<br>Es ist noch keine Zeitschriftenliste hinterlegt (Konfiguration → Zeitschriftenkontext).`);
    if (ctx.status === 'not_in_list') return wrap(`${venue}<br>Diese Zeitschrift steht nicht in Ihrer Liste (${ctx.list_size} Einträge).`);
    const m = ctx.match;
    const cells = [
        ['VHB Publication Media Rating 2024', m.vhb], ['ABDC', m.abdc], ['FT50', m.ft50 === 'ja' ? 'ja' : m.ft50 === 'nein' ? 'nein' : ''],
        ['SJR', [m.sjr, m.sjr_quartil].filter(Boolean).join(' · ')]
    ].map(([label, value]) => `<div style="background:white;border:1px solid var(--border);border-radius:.4rem;padding:.45rem .6rem;"><div style="font-size:.7rem;color:var(--text-light);">${escapeHTML(label)}</div><div style="font-weight:700;">${escapeHTML(value || '–')}</div></div>`).join('');
    return wrap(`${venue}<br><span style="color:var(--text-light);font-size:.78rem;">in Ihrer Liste gefunden über ${escapeHTML(m.by)}${m.name && m.name !== ctx.venue_name ? ` als „${escapeHTML(m.name)}“` : ''}</span>`
        + `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.5rem;margin-top:.5rem;">${cells}</div>${m.note ? `<div style="margin-top:.4rem;font-size:.78rem;">Bemerkung: ${escapeHTML(m.note)}</div>` : ''}`);
}
