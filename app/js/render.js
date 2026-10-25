// ==========================================
let sourceReferenceRegistry = [];
let activeSourceReference = null;

function registerSourceReference(title, ref) {
    const id = sourceReferenceRegistry.length;
    sourceReferenceRegistry.push({ title, ...ref });
    return id;
}

function renderSourceRefs(title, refs) {
    if (!Array.isArray(refs) || !refs.length) return '';
    return `<div class="source-ref-wrap">${refs.map(ref => {
        const id = registerSourceReference(title, ref);
        const pageLabel = ref.page ? `S. ${ref.page}` : 'Seite ?';
        const cls = ref.verified ? 'source-ref' : 'source-ref unverified';
        const mark = ref.verified ? '✓' : '?';
        return `<button type="button" class="${cls}" onclick="showSourceReference(${id})" title="Quellenbeleg anzeigen">📄 ${escapeHTML(pageLabel)} ${mark}</button>`;
    }).join('')}</div>`;
}

function showSourceReference(id) {
    const ref = sourceReferenceRegistry[id];
    if (!ref) return;
    activeSourceReference = ref;
    document.getElementById('source-modal-meta').textContent = `${ref.title || 'Publikation'} · PDF-Seite ${ref.page || '?'} · ${ref.section || 'Sektion unbekannt'} · ${ref.verified ? 'Zitat im Seitentext verifiziert' : 'Zitat nicht eindeutig automatisch verifiziert'}`;
    document.getElementById('source-modal-quote').textContent = ref.quote || 'Kein wörtlicher Kurzbeleg verfügbar.';
    document.getElementById('source-modal-note').textContent = ref.verified ? 'Die Seitenzuordnung wurde nach dem LLM-Schritt lokal gegen den mit PDF.js extrahierten Seitentext geprüft.' : 'Bitte diesen Beleg manuell im PDF prüfen. Die Seite stammt gegebenenfalls aus der Modellangabe, das Zitat konnte aber nicht eindeutig im extrahierten Seitentext gefunden werden.';
    const hasCurrentFile = selectedFiles.some(f => f.name === ref.title) && ref.page;
    document.getElementById('source-open-pdf').style.display = hasCurrentFile ? 'inline-block' : 'none';
    document.getElementById('source-modal').classList.add('open');
}

function closeSourceReference() {
    document.getElementById('source-modal').classList.remove('open');
    activeSourceReference = null;
}

function openCurrentSourcePDF() {
    if (!activeSourceReference) return;
    const file = selectedFiles.find(f => f.name === activeSourceReference.title);
    if (!file || !activeSourceReference.page) return;
    const url = URL.createObjectURL(file);
    window.open(`${url}#page=${activeSourceReference.page}`, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// RENDER & USER HISTORY
// ==========================================
function renderResults(res) {
    sourceReferenceRegistry = [];
    
    document.getElementById('terminal').style.display = 'none';
    document.getElementById('btn-toggle-terminal').textContent = 'Terminal anzeigen';
    
    document.getElementById('results-view').classList.add('active');

    document.getElementById('res-model').textContent = res.model || 'Unbekannt';
    const overallScore = res.validation?.casq_score;
    document.getElementById('res-casq').textContent = formatCASQ(overallScore);
    document.getElementById('res-evidence').textContent = `${Math.round(Number(res.validation?.evidence_coverage) || 0)} %`;

    const rows = res.study_results || (res.extractions || []).map((ex, i) => ({
        title: ex.title, extraction: ex, appraisal: res.appraisals?.[i] || {}, validation: res.validations?.[i] || {},
        casq_score: res.validations?.[i]?.casq_score ?? null,
        evidence_coverage: res.validations?.[i]?.evidence_coverage ?? 0,
        quality_label: res.validations?.[i]?.quality_label || 'nicht verfügbar'
    }));

    const establishedResults = (res.study_results || []).map(r => calculateEstablishedResult(r.validation || {}, r.appraisal || {}, r.extraction || {}));
    const establishedApplicable = establishedResults.filter(x => x.applicable);
    const jarsApplicable = rows.filter(r => (r.validation?.validated_jars_quant || r.appraisal?.jars_quant)?.applicable);
    if (jarsApplicable.length) {
        const methodCount = establishedApplicable.length;
        document.getElementById('res-established').textContent = methodCount
            ? `APA JARS-Quant (Reporting) + ${methodCount} methodisches Instrument`
            : 'APA JARS-Quant (Reporting)';
    } else {
        document.getElementById('res-established').textContent = establishedApplicable.length ? `${establishedApplicable.length}/${establishedResults.length} Studie(n)` : 'keines anwendbar';
    }
    const grade = res.synthesis?.grade_assessment || {};
    const gradeOutcomes = Array.isArray(grade.outcomes) ? grade.outcomes : [];
    const gradeLabel = grade.applicable ? (gradeOutcomes.length === 1 ? String(gradeOutcomes[0].certainty || 'unclear').replace(/_/g,' ') : `${gradeOutcomes.length} Outcome(s)`) : 'nicht anwendbar';
    document.getElementById('res-grade').textContent = gradeLabel;
    document.getElementById('res-grade-detail').innerHTML = grade.applicable ? `<div style="margin:0 0 1rem 0;padding:1rem;background:#f8fafc;border:1px solid var(--border);border-radius:.5rem;"><h3 style="margin:0 0 .6rem 0;">GRADE – Sicherheit der Evidenz</h3>${gradeOutcomes.map(o=>`<div style="padding:.55rem 0;border-bottom:1px solid var(--border);"><strong>${escapeHTML(o.outcome||'Outcome')}</strong>: <span style="font-weight:700;">${escapeHTML(String(o.certainty||'unclear').replace(/_/g,' '))}</span><div style="font-size:.82rem;color:var(--text-light);">${escapeHTML(o.rationale||'')}</div></div>`).join('')}<div style="font-size:.75rem;color:var(--text-light);margin-top:.55rem;">GRADE bewertet den Evidenzkörper pro Outcome, nicht die Qualität einer einzelnen Studie.</div></div>` : '';

    document.getElementById('res-topics').innerHTML = (res.synthesis?.topics || []).map(t => `<li>${escapeHTML(t)}</li>`).join('');
    document.getElementById('res-summary').textContent = res.synthesis?.narrative_summary || '-';

    let studiesHtml = '';
    const failedDocs = Array.isArray(res.failed_documents) ? res.failed_documents : [];
    if (failedDocs.length) {
        studiesHtml += `<div style="margin:0 0 1rem 0;padding:1rem;background:#fff7ed;border:1px solid #fdba74;border-radius:.5rem;">
            <h3 style="margin:0 0 .6rem 0;color:#9a3412;">⚠️ Nicht vollständig verarbeitete Dokumente</h3>
            <div style="font-size:.85rem;color:#7c2d12;margin-bottom:.5rem;">Der Lauf wurde fortgesetzt. Bereits erfolgreiche Studienergebnisse bleiben erhalten.</div>
            ${failedDocs.map(f => `<div style="padding:.35rem 0;border-top:1px solid #fed7aa;"><strong>${escapeHTML(f.title || 'Dokument')}</strong> · ${escapeHTML(f.phase || 'Phase')}<br><span style="font-size:.8rem;">${escapeHTML(f.error || 'Unbekannter Fehler')}</span></div>`).join('')}
        </div>`;
    }
    rows.forEach(r => {
        const ex = r.extraction || {}, ap = r.appraisal || {}, va = r.validation || {};
        const casqRange = formatCASQRange(va.casq_min, va.casq_max);
        const scoreTxt = formatCASQ(r.casq_score) + (casqRange ? ` (${casqRange})` : '');
        const casqDetails = va.casq_details || null;
        const dimDetails = Array.isArray(casqDetails?.dimensions) ? casqDetails.dimensions : [];
        const dims = (va.validated_dimensions || ap.dimensions || []).map((d, i) => {
            const sc = d.adjusted_score ?? d.score;
            const status = d.validation_status ?? d.status ?? '';
            const refs = d.source_refs || [];
            const det = dimDetails[i];
            const weightCell = det ? `${escapeHTML(det.weight)}${det.rubric_name && det.rubric_name !== d.name ? `<div style="font-size:.7rem;color:var(--text-light);">≙ ${escapeHTML(det.rubric_name)}</div>` : ''}${casqDetails.weights_source === 'rubric' && !det.rubric_name ? '<div style="font-size:.7rem;color:#b45309;">nicht in Rubrik</div>' : ''}` : escapeHTML(d.weight ?? '-');
            return `<tr><td>${escapeHTML(d.name)}</td><td>${Number.isFinite(Number(sc)) ? escapeHTML(sc) : '-'}</td><td>${weightCell}</td><td>${escapeHTML(status)}</td><td>${escapeHTML(d.validation_note || d.rationale || '')}${renderSourceRefs(r.title, refs)}</td></tr>`;
        }).join('');
        const casqNote = casqDetails ? `<div style="font-size:.75rem;color:var(--text-light);margin:.35rem 0 .6rem;">${casqDetails.weights_source === 'rubric'
            ? `Gewichte fest aus der CASQ-Rubrik <strong>${escapeHTML(casqDetails.rubric_label || casqDetails.rubric)}</strong> (nicht vom Modell).`
            : '<span style="color:#b45309;">Dimensionen passten zu keiner CASQ-Rubrik – Gewichte stammen aus der Modellantwort.</span>'}
            ${casqRange ? ` Die Spanne zeigt den CASQ, wenn nicht belegbare Dimensionen mit 0 bzw. 10 Punkten gerechnet würden.` : ''}
            Evidenzabdeckung = Gewichtsanteil der Dimensionen mit im PDF wiedergefundenem Beleg${Number.isFinite(Number(va.evidence_coverage_agent)) ? ` (Selbstauskunft Agent 4: ${Math.round(va.evidence_coverage_agent)} %)` : ''}.</div>` : '';
        const strengths = (ap.critical_strengths || []).map(x => `<li>${escapeHTML(x)}</li>`).join('');
        const limits = (ap.critical_limitations || []).map(x => `<li>${escapeHTML(x)}</li>`).join('');
        const established = calculateEstablishedResult(va, ap, ex);
        const establishedNotes = [];
        if (established.missing_items?.length) establishedNotes.push(`PEDro-Items fehlen in der Modellantwort und wurden als „nicht erfüllt“ gezählt: ${established.missing_items.join(', ')}.`);
        if (established.rating_mismatch) establishedNotes.push(`Das Modell nannte „${established.agent_rating}“; nach „worst score counts“ ergibt sich „${established.rating}“.`);
        if (established.instrument === 'AMSTAR 2' && established.applicable) establishedNotes.push(`Kritische Mängel (Items 2, 4, 7, 9, 11, 13, 15): ${established.critical_flaws}; nicht-kritische Schwächen: ${established.non_critical_weaknesses}.`);
        if (established.instrument === 'MINORS' && established.applicable) establishedNotes.push(established.comparative ? 'Komparative Studie: 12 Items, max. 24 Punkte.' : 'Nicht-komparative Studie: 8 Items, max. 16 Punkte.');
        const establishedNotesHtml = establishedNotes.length ? `<div style="margin-top:.5rem;font-size:.78rem;color:#065f46;">${establishedNotes.map(n => `<div>• ${escapeHTML(n)}</div>`).join('')}</div>` : '';
        const ea = va.validated_established_appraisal || ap.established_appraisal || {};
        const jq = va.validated_jars_quant || ap.jars_quant || {};
        const eaRows = (ea.items || []).map(item => {
            const pts = item.points === undefined || item.points === null ? '' : ` · ${escapeHTML(item.points)}${item.max_points ? '/' + escapeHTML(item.max_points) : ''} P.`;
            return `<tr><td>${escapeHTML(item.item_id || '')}</td><td>${escapeHTML(item.criterion || '-')}</td><td>${escapeHTML(item.response || '-')} ${pts}</td><td>${escapeHTML(item.validation_note || item.rationale || '')}${renderSourceRefs(r.title, item.evidence || [])}</td></tr>`;
        }).join('');
        const establishedHtml = established.applicable ? `<div style="margin:.9rem 0;padding:1rem;background:#ecfdf5;border:1px solid #a7f3d0;border-left:4px solid var(--success);border-radius:.55rem;">
            <div style="display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:flex-start;"><div><div style="font-size:.72rem;color:#047857;font-weight:700;">PRIMÄRE WISSENSCHAFTLICHE BEWERTUNG</div><div style="font-size:1.05rem;font-weight:700;">${escapeHTML(established.instrument || 'Instrument')}</div><div style="font-size:.8rem;color:var(--text-light);">${escapeHTML(established.reason || '')}</div></div><div style="font-size:1.25rem;font-weight:800;">${escapeHTML(established.display)}</div></div>
            ${established.summary ? `<div style="margin-top:.55rem;font-size:.85rem;"><strong>Instrument-Fazit:</strong> ${escapeHTML(established.summary)}</div>` : ''}
            ${establishedNotesHtml}
        </div>` : (jq?.applicable ? `<div style="margin:.9rem 0;padding:1rem;background:#ecfdf5;border:1px solid #a7f3d0;border-left:4px solid var(--success);border-radius:.55rem;">
            <div style="font-size:.72rem;color:#047857;font-weight:700;">PRIMÄRER ETABLIERTER STANDARD</div>
            <div style="font-size:1.05rem;font-weight:700;">APA JARS-Quant</div>
            <div style="font-size:.82rem;color:var(--text-light);">Offizieller APA-Reporting-Standard auf Dokumentebene; kein numerischer Qualitätsscore und kein Risk-of-Bias-Instrument.</div>
        </div>` : `<div style="margin:.9rem 0;padding:1rem;background:#fff7ed;border:1px solid #fed7aa;border-left:4px solid #f97316;border-radius:.55rem;">
            <div style="font-size:.72rem;color:#9a3412;font-weight:700;">PRIMÄRE WISSENSCHAFTLICHE BEWERTUNG</div>
            <div style="font-size:1.05rem;font-weight:700;">Kein etabliertes Einzelstudien-Instrument direkt anwendbar</div>
            <div style="font-size:.82rem;color:var(--text-light);">Für diese Publikation wurde bewusst kein unpassender offizieller Score erzwungen.</div>
            ${established.summary ? `<div style="margin-top:.55rem;font-size:.85rem;"><strong>Instrument-Fazit:</strong> ${escapeHTML(established.summary)}</div>` : ''}
        </div>`);

        const fw = va.validated_framework || ap.framework_appraisal || {};
        const fwMetric = calculateFrameworkMetrics(va, ap);
        const renderFwRows = (items) => (items || []).map(item => {
            const resp = item.framework_response || item.response || 'cant_tell';
            const badgeStyle = resp === 'yes' ? 'background:#ecfdf5;color:#047857;border:1px solid #a7f3d0;' : resp === 'no' ? 'background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;' : resp === 'not_applicable' ? 'background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;' : 'background:#fffbeb;color:#92400e;border:1px solid #fde68a;';
            return `<tr><td>${escapeHTML(item.criterion || '-')}</td><td><span style="display:inline-block;padding:.15rem .4rem;border-radius:.3rem;${badgeStyle}">${escapeHTML(resp)}</span></td><td>${escapeHTML(item.validation_note || item.rationale || '')}${renderSourceRefs(r.title, item.evidence || [])}</td></tr>`;
        }).join('');
        const fwScreenRows = renderFwRows(fw.screening || []);
        const fwCriteriaRows = renderFwRows(fw.criteria || []);
        const jqm = calculateJARSMetrics(va, ap);
        const jqRows = (jq.criteria || []).map(c => {
            const s = c.status || 'not_reported';
            const badge = s === 'reported' ? 'background:#ecfdf5;color:#047857;border:1px solid #a7f3d0;' :
                          s === 'partial' ? 'background:#fffbeb;color:#92400e;border:1px solid #fde68a;' :
                          s === 'not_applicable' ? 'background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;' :
                          'background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;';
            const refs = c.source_refs || c.evidence || [];
            return `<tr><td>${escapeHTML(c.criterion || '-')}</td><td><span style="display:inline-block;padding:.15rem .4rem;border-radius:.3rem;${badge}">${escapeHTML(s)}</span></td><td>${escapeHTML(c.validation_note || c.rationale || '')}${renderSourceRefs(r.title, refs)}</td></tr>`;
        }).join('');
        const jarsHtml = jq.applicable ? `<div style="margin:.9rem 0;padding:1rem;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:.55rem;">
            <div style="display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:.6rem;">
                <div><div style="font-size:.72rem;color:#166534;font-weight:700;">OFFIZIELLER REPORTING-STANDARD</div><div style="font-size:1.05rem;font-weight:700;color:#14532d;">APA JARS-Quant</div><div style="font-size:.78rem;color:#166534;">Dokumentebene · Reporting Quality · kein Risk-of-Bias-Score</div></div>
                <div style="background:white;border:1px solid #bbf7d0;padding:.55rem .7rem;border-radius:.4rem;"><div style="font-size:.7rem;color:var(--text-light);">INTERNE ORIENTIERUNG*</div><div style="font-weight:700;font-size:1.1rem;">${jqm.internalCompletion === null ? 'n/a' : jqm.internalCompletion + ' %'}</div><div style="font-size:.7rem;color:var(--text-light);">${jqm.reported} berichtet · ${jqm.partial} teilweise · ${jqm.not_reported} nicht berichtet</div></div>
            </div>
            ${jq.scope_note ? `<div style="font-size:.82rem;margin-bottom:.5rem;"><strong>Scope:</strong> ${escapeHTML(jq.scope_note)}</div>` : ''}
            <div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:.82rem;"><thead><tr><th style="text-align:left;">JARS-Quant-Kriterium</th><th>Status</th><th style="text-align:left;">Begründung / Evidenz</th></tr></thead><tbody>${jqRows}</tbody></table></div>
            ${jq.reporting_summary ? `<div style="margin-top:.55rem;font-size:.85rem;"><strong>Reporting-Fazit:</strong> ${escapeHTML(jq.reporting_summary)}</div>` : ''}
            <div style="margin-top:.5rem;font-size:.74rem;color:#166534;"><strong>* Kein offizieller APA-JARS-Score.</strong> Der Prozentwert ist nur ein interner Reporting-Erfüllungsgrad.</div>
        </div>` : '';

        const embeddedApps = va.validated_embedded_study_appraisals || ap.embedded_study_appraisals || [];
        const embeddedHtml = embeddedApps.length ? `<div style="margin:.9rem 0;padding:1rem;background:#f8fafc;border:1px solid var(--border);border-radius:.55rem;"><strong>Methodische Bewertung der Teilstudien</strong><div style="font-size:.78rem;color:var(--text-light);margin:.25rem 0 .55rem;">Getrennt von der JARS-Reporting-Bewertung des Gesamtartikels.</div>${embeddedApps.map(es => `<div style="padding:.5rem 0;border-top:1px solid var(--border);"><strong>${escapeHTML(es.label || 'Teilstudie')}</strong> · ${escapeHTML(es.study_design || 'Design unklar')}<br><span style="font-size:.8rem;">Instrument: <strong>${escapeHTML(es.selected_instrument || 'none')}</strong> · ${es.applicable ? escapeHTML(es.result || 'bewertet') : 'nicht anwendbar / zu wenig Information'}</span></div>`).join('')}</div>` : '';

        const isMMAT = String(fw.primary_framework || '').toUpperCase().includes('MMAT');
        const screeningLabel = fwMetric.screening.total_considered
            ? `${fwMetric.screening.yes}/${fwMetric.screening.total_considered} yes`
            : 'nicht verfügbar';
        const criteriaLabel = fwMetric.criteria.total_considered
            ? `${fwMetric.criteria.yes} yes / ${fwMetric.criteria.no} no / ${fwMetric.criteria.cant_tell} can't tell`
            : 'nicht durchgeführt';
        const frameworkHtml = fw.primary_framework && fw.primary_framework !== 'none' ? `<div style="margin:.9rem 0;padding:1rem;background:#f8fafc;border:1px solid var(--border);border-radius:.55rem;">
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:.6rem;margin-bottom:.8rem;">
                <div style="background:white;border:1px solid var(--border);border-left:4px solid var(--primary);padding:.65rem;border-radius:.4rem;"><div style="font-size:.72rem;color:var(--text-light);">FRAMEWORK</div><div style="font-weight:700;">${escapeHTML(fw.primary_framework)}</div><div style="font-size:.72rem;color:var(--text-light);">${escapeHTML(fw.framework_category || '')}</div></div>
                ${isMMAT ? `<div style="background:white;border:1px solid var(--border);border-left:4px solid var(--success);padding:.65rem;border-radius:.4rem;"><div style="font-size:.72rem;color:var(--text-light);">MMAT SCREENING</div><div style="font-weight:700;font-size:1.1rem;">${escapeHTML(screeningLabel)}</div><div style="font-size:.72rem;color:var(--text-light);">nur Eingangsvoraussetzung, kein Qualitäts-Score</div></div>` : ''}
                <div style="background:white;border:1px solid var(--border);border-left:4px solid var(--success);padding:.65rem;border-radius:.4rem;"><div style="font-size:.72rem;color:var(--text-light);">${isMMAT ? 'DESIGNSPEZIFISCHE KRITERIEN' : 'KRITERIEN'}</div><div style="font-weight:700;font-size:1.1rem;">${escapeHTML(criteriaLabel)}</div><div style="font-size:.72rem;color:var(--text-light);">${fwMetric.criteria.fulfillment === null ? 'kein Erfüllungsgrad berechenbar' : 'interner Erfüllungsgrad: ' + fwMetric.criteria.fulfillment + ' %'}</div></div>
                <div style="background:white;border:1px solid var(--border);border-left:4px solid var(--warning);padding:.65rem;border-radius:.4rem;"><div style="font-size:.72rem;color:var(--text-light);">ENTSCHEIDBARKEIT KRITERIEN</div><div style="font-weight:700;font-size:1.1rem;">${fwMetric.criteria.decidability === null ? 'n/a' : fwMetric.criteria.decidability + ' %'}</div><div style="font-size:.72rem;color:var(--text-light);">${fwMetric.criteria.cant_tell} × cant_tell</div></div>
                <div style="background:white;border:1px solid var(--border);border-left:4px solid #64748b;padding:.65rem;border-radius:.4rem;"><div style="font-size:.72rem;color:var(--text-light);">CASQ INTERN</div><div style="font-weight:700;font-size:1.1rem;">${scoreTxt}</div><div style="font-size:.72rem;color:var(--text-light);">separater Vergleichsindex</div></div>
            </div>
            <div style="margin-bottom:.55rem;"><strong>Critical-Appraisal-Framework:</strong> ${escapeHTML(fw.primary_framework)}${fw.framework_category ? ` · ${escapeHTML(fw.framework_category)}` : ''}${fw.secondary_framework && fw.secondary_framework !== 'none' ? ` <span style="color:var(--text-light);">(+ ${escapeHTML(fw.secondary_framework)})</span>` : ''}</div>
            ${isMMAT && fwScreenRows ? `<div style="margin-top:.55rem;"><strong>MMAT Screening (2 Eingangskriterien)</strong><div style="font-size:.75rem;color:var(--text-light);margin:.15rem 0 .35rem;">Die Screening-Fragen prüfen nur, ob eine methodische Bewertung sinnvoll möglich ist. Sie dürfen nicht als vollständige MMAT-Qualitätsbewertung interpretiert werden.</div><div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:.82rem;"><thead><tr><th style="text-align:left;">Screening-Frage</th><th>Antwort</th><th style="text-align:left;">Begründung / Evidenz</th></tr></thead><tbody>${fwScreenRows}</tbody></table></div></div>` : ''}
            ${fwCriteriaRows ? `<div style="margin-top:.7rem;"><strong>${isMMAT ? 'MMAT designspezifische Kriterien' : 'Framework-Kriterien'}</strong><div style="overflow-x:auto;margin-top:.3rem;"><table style="width:100%;border-collapse:collapse;font-size:.82rem;"><thead><tr><th style="text-align:left;">Prüfpunkt</th><th>Antwort</th><th style="text-align:left;">Begründung / Evidenz</th></tr></thead><tbody>${fwCriteriaRows}</tbody></table></div></div>` : `<div style="margin-top:.65rem;padding:.6rem;background:#fffbeb;border:1px solid #fde68a;border-radius:.4rem;color:#92400e;font-size:.8rem;"><strong>Framework-Appraisal unvollständig:</strong> Es liegen keine designspezifischen Kriterien vor. Ein positives Screening allein ist keine Qualitätsbewertung.</div>`}
            ${fw.framework_summary ? `<div style="margin-top:.5rem;font-size:.85rem;"><strong>Framework-Fazit:</strong> ${escapeHTML(fw.framework_summary)}</div>` : ''}
            <div style="margin-top:.5rem;font-size:.75rem;color:var(--text-light);"><strong>MMAT/CASP sind Checklisten ohne offiziellen Summenscore.</strong> Ein ggf. angezeigter Erfüllungsgrad ist ausschließlich eine interne Orientierung und basiert nur auf den designspezifischen Kriterien, niemals auf den Screening-Fragen.</div>
        </div>` : `<div style="margin:.8rem 0;padding:.75rem;background:#fffbeb;border:1px solid #fde68a;border-radius:.5rem;font-size:.85rem;color:#92400e;"><strong>Framework-Bewertung nicht anwendbar oder nicht verfügbar.</strong> Bei Methodenbeiträgen, narrativen Übersichten oder heterogenen Multi-Study-Reports ist das häufig korrekt und wissenschaftlich sauberer als ein erzwungenes Einzelstudien-Framework.</div>`;
        studiesHtml += `
            <div style="background:white;padding:1rem;border:1px solid var(--border);border-radius:.5rem;margin-bottom:1rem;">
                <h4 style="margin-bottom:.4rem;color:#0f172a;">${escapeHTML(r.title)}</h4>
                ${renderSourceInfo(r.source_info)}
                <div style="font-size:.9rem;margin-bottom:.35rem;"><strong>Dokumenttyp:</strong> ${escapeHTML(ex.document_type || ap.document_type_confirmed || 'unclear')}</div>
                <div style="font-size:.9rem;margin-bottom:.7rem;"><strong>${escapeHTML(ex.study_family || 'Unclear')} / ${escapeHTML(ex.study_design || 'Unclear')}</strong> &nbsp; | &nbsp; Etabliert: <strong>${escapeHTML(jq?.applicable ? ('APA JARS-Quant (Reporting)' + (established.applicable ? ' + ' + established.display : '')) : established.display)}</strong> &nbsp; | &nbsp; CASQ intern: <strong>${scoreTxt}</strong>${casqDetails?.cap ? ` <span style="color:#b91c1c;">(gedeckelt auf ${casqDetails.cap.toFixed(1)}: ${casqDetails.critical_flaws.length} kritische Mängel, Details unten)</span>` : ''} &nbsp; | &nbsp; ${va.casq_details?.version === 'casq2' ? `Informationsgrad: <strong>${Math.round(Number(va.information_grade)||0)} %</strong> &nbsp; | &nbsp; Belege verifiziert` : va.casq_details ? 'Evidenz (verifiziert)' : 'Evidenz'}: <strong>${Math.round(Number(r.evidence_coverage)||0)} %</strong></div>
                <div style="font-size:.9rem;color:var(--text-light);margin-bottom:.7rem;">
                    <strong>Methoden:</strong> ${escapeHTML((ex.methods || []).join(', ') || '-')}<br>
                    <strong>Forschungsfrage:</strong> ${escapeHTML(ex.research_question?.value || '-')}<br>
                    <strong>Stichprobe:</strong> N=${escapeHTML(ex.sample?.n || 'not_reported')}; ${escapeHTML(ex.sample?.population || '')}
                    ${renderSourceRefs(r.title, (ex.evidence_locations || []).slice(0, 6).map(x => ({page:Number(x.page)||null,section:x.section||'unknown',quote:x.quote||'',verified:!!x.verified})))}
                </div>
                ${establishedHtml}
                ${jarsHtml}
                ${embeddedHtml}
                ${frameworkHtml}
                ${casqDetails?.version === 'casq2' ? renderCASQ2(casqDetails, r.title)
                    : dims ? `<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:.82rem;"><thead><tr><th style="text-align:left;">CASQ-Dimension</th><th>Score</th><th>Gewicht</th><th>Status</th><th style="text-align:left;">Begründung / Validation</th></tr></thead><tbody>${dims}</tbody></table></div>${casqNote}` : ''}
                ${r.integrity ? renderIntegrity(r.integrity, r.title) : ''}
                ${r.reliability ? renderReliability(r.reliability, r) : ''}
                ${strengths ? `<div style="margin-top:.7rem;"><strong>Stärken</strong><ul style="margin-left:1.2rem;">${strengths}</ul></div>` : ''}
                ${limits ? `<div style="margin-top:.5rem;"><strong>Kritische Limitationen</strong><ul style="margin-left:1.2rem;">${limits}</ul></div>` : ''}
                ${va.validation_summary ? `<div style="margin-top:.5rem;"><strong>Validierung:</strong> ${escapeHTML(va.validation_summary)}</div>` : ''}
            </div>`;
    });
    document.getElementById('res-studies').innerHTML = studiesHtml || '<p>Keine Studienergebnisse verfügbar.</p>';
}

const CASQ_RESPONSE_LABEL = { yes: 'ja', partial: 'teilweise', no: 'nein', not_reported: 'nicht berichtet', not_applicable: 'nicht anwendbar' };
const CASQ_RESPONSE_STYLE = {
    yes: 'background:#ecfdf5;color:#047857;border:1px solid #a7f3d0;',
    partial: 'background:#fffbeb;color:#92400e;border:1px solid #fde68a;',
    no: 'background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;',
    not_reported: 'background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;',
    not_applicable: 'background:#f8fafc;color:#94a3b8;border:1px dashed #cbd5e1;'
};

// CASQ 2.0: Prüffragen je Dimension mit Antwort, Beleg und berechnetem Teilscore.
function renderCASQ2(d, title) {
    const pct = v => v === null || v === undefined ? 'n/a' : `${Math.round(v * 100)} %`;
    const badge = resp => `<span style="display:inline-block;padding:.1rem .4rem;border-radius:.3rem;white-space:nowrap;${CASQ_RESPONSE_STYLE[resp] || ''}">${escapeHTML(CASQ_RESPONSE_LABEL[resp] || resp)}</span>`;
    const rows = d.dimensions.map(dim => {
        const head = `<tr style="background:#f8fafc;"><td colspan="4" style="padding:.4rem;"><strong>${escapeHTML(dim.name)}</strong> · Gewicht ${escapeHTML(dim.weight)} · Teilscore ${dim.score === null ? 'nicht anwendbar' : dim.score.toFixed(1) + ' / 10'}</td></tr>`;
        const qs = dim.questions.map(q => `<tr>
            <td style="white-space:nowrap;vertical-align:top;">${escapeHTML(q.id)}</td>
            <td style="vertical-align:top;">${escapeHTML(q.text)}${q.critical ? ' <span style="font-size:.7rem;font-weight:700;color:#b91c1c;">KRITISCH</span>' : ''}</td>
            <td style="vertical-align:top;">${badge(q.effective)}${q.downgraded ? `<div style="font-size:.7rem;color:#92400e;margin-top:.15rem;">Modell: ${escapeHTML(CASQ_RESPONSE_LABEL[q.response])} – kein Zitat im PDF gefunden</div>` : ''}</td>
            <td style="vertical-align:top;">${escapeHTML(q.note)}${renderSourceRefs(title, q.evidence)}</td></tr>`).join('');
        return head + qs;
    }).join('');
    const capNote = d.cap ? `<div style="color:#b91c1c;font-size:.8rem;margin-top:.35rem;"><strong>Gedeckelt auf ${d.cap.toFixed(1)}</strong> wegen kritischer Mängel (${escapeHTML(d.critical_flaws.join(', '))}); ohne Deckel ${d.score_uncapped.toFixed(1)}.</div>` : '';
    // „Warum dieser Wert?“: kritische Mängel mit Fragetext und Antwort, dazu die schwächsten Dimensionen
    const flawed = new Set(d.critical_flaws || []);
    const flawList = d.dimensions.flatMap(dim => dim.questions).filter(q => flawed.has(q.id))
        .map(q => `<li><strong>${escapeHTML(q.id)}</strong> ${escapeHTML(q.text)} <span style="color:#b91c1c;">(Antwort: ${escapeHTML(CASQ_RESPONSE_LABEL[q.effective] || q.effective)}${q.downgraded ? ', herabgestuft' : ''})</span></li>`).join('');
    const weakest = d.dimensions.filter(dim => dim.score !== null).sort((a, b) => a.score - b.score).slice(0, 3)
        .map(dim => `${escapeHTML(dim.name)} (${dim.score.toFixed(1)})`).join(', ');
    const whyBox = `<div style="font-size:.8rem;margin:.4rem 0;padding:.55rem .7rem;background:#fff;border:1px solid var(--border);border-radius:.4rem;"><strong>Warum dieser Wert?</strong>${flawList ? `<div style="margin-top:.25rem;">Kritische Fragen mit „nein“ oder „nicht berichtet“ (sie begrenzen den CASQ):</div><ul style="margin:.2rem 0 0 1.2rem;">${flawList}</ul>` : '<div style="margin-top:.25rem;">Keine kritischen Mängel; der Wert ergibt sich aus den Antworten je Dimension.</div>'}${weakest ? `<div style="margin-top:.35rem;">Schwächste Dimensionen: ${weakest}.</div>` : ''}</div>`;
    return `<div style="margin:.9rem 0;padding:1rem;background:#f8fafc;border:1px solid var(--border);border-radius:.55rem;">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.6rem;margin-bottom:.6rem;">
            <div style="background:white;border:1px solid var(--border);border-left:4px solid #64748b;padding:.6rem;border-radius:.4rem;"><div style="font-size:.72rem;color:var(--text-light);">CASQ (INTERNER INDEX) · ${escapeHTML(d.rubric_label)}</div><div style="font-weight:700;font-size:1.1rem;">${formatCASQ(d.score)}</div><div style="font-size:.72rem;color:var(--text-light);">${escapeHTML(formatCASQRange(d.score_min, d.score_max)) || 'keine Spanne'}</div></div>
            <div style="background:white;border:1px solid var(--border);border-left:4px solid var(--warning);padding:.6rem;border-radius:.4rem;"><div style="font-size:.72rem;color:var(--text-light);">INFORMATIONSGRAD</div><div style="font-weight:700;font-size:1.1rem;">${pct(d.information_grade)}</div><div style="font-size:.72rem;color:var(--text-light);">Prüffragen mit Angaben im Text</div></div>
            <div style="background:white;border:1px solid var(--border);border-left:4px solid var(--success);padding:.6rem;border-radius:.4rem;"><div style="font-size:.72rem;color:var(--text-light);">BELEGE VERIFIZIERT</div><div style="font-weight:700;font-size:1.1rem;">${pct(d.evidence_rate)}</div><div style="font-size:.72rem;color:var(--text-light);">„ja/teilweise“ mit Zitat im PDF</div></div>
            <div style="background:white;border:1px solid var(--border);border-left:4px solid ${d.critical_flaws.length ? 'var(--danger)' : 'var(--success)'};padding:.6rem;border-radius:.4rem;"><div style="font-size:.72rem;color:var(--text-light);">KRITISCHE MÄNGEL</div><div style="font-weight:700;font-size:1.1rem;">${d.critical_flaws.length}</div><div style="font-size:.72rem;color:var(--text-light);">${d.critical_flaws.length ? escapeHTML(d.critical_flaws.join(', ')) : 'keine'}</div></div>
        </div>
        ${capNote}
        ${whyBox}
        ${d.reporting ? `<div style="background:white;border:1px solid var(--border);border-left:4px solid var(--primary);padding:.6rem;border-radius:.4rem;margin:.4rem 0;"><div style="font-size:.72rem;color:var(--text-light);">${escapeHTML(d.reporting.label.toUpperCase())}</div><div style="font-weight:700;font-size:1.1rem;">${Math.round(d.reporting.compliance * 100)} % (${d.reporting.fulfilled} von ${d.reporting.considered} Berichtspunkten erfüllt)</div><div style="font-size:.72rem;color:var(--text-light);">interner Erfüllungsgrad der Berichtspunkte – kein offizieller Score; getrennt vom CASQ</div></div>` : ''}
        <div style="font-size:.78rem;color:var(--text-light);margin:.2rem 0 .4rem;"><strong>Methodische Grundlage der Prüffragen:</strong> ${escapeHTML(d.rubric_reference || RUBRIC_REFERENCES[d.rubric] || 'intern abgeleitet')}. Der CASQ ist ein intern berechneter Vergleichsindex, kein offizieller Score.</div>
        <details style="margin-top:.5rem;"><summary style="cursor:pointer;font-weight:600;">CASQ-Prüffragen (${d.dimensions.reduce((a, x) => a + x.questions.length, 0)})</summary>
            <div style="overflow-x:auto;margin-top:.4rem;"><table style="width:100%;min-width:640px;border-collapse:collapse;font-size:.8rem;table-layout:fixed;"><colgroup><col style="width:4.5rem;"><col style="width:40%;"><col style="width:8.5rem;"><col></colgroup><thead><tr><th style="text-align:left;">ID</th><th style="text-align:left;">Prüffrage</th><th style="text-align:left;">Antwort</th><th style="text-align:left;">Begründung / Beleg</th></tr></thead><tbody>${rows}</tbody></table></div>
        </details>
        <div style="font-size:.72rem;color:var(--text-light);margin-top:.5rem;">Berechnung im Code: ja = 1, teilweise = 0,5, nein / nicht berichtet = 0; „ja/teilweise“ ohne im PDF gefundenes Zitat wird eine Stufe herabgesetzt. Teilscore = 10 × Mittelwert, CASQ = gewichtetes Mittel; ein kritischer Mangel begrenzt auf 5, mehrere auf 3. Die Spanne zeigt den Wert, wenn alles nicht Berichtete erfüllt wäre.</div>
    </div>`;
}

// Wie wurde das PDF gelesen? Seiten, Tabellen/Abbildungen und ob sie als Bild ans Modell gingen.
function renderSourceInfo(info) {
    if (!info?.quality) return '';
    const q = info.quality;
    const pagesText = list => list.length ? `S. ${list.join(', ')}` : 'keine erkannt';
    const visionText = {
        used: `🖼️ als Bild ausgewertet: ${info.visual_pages.map(v => `S. ${v.page}`).join(', ')}`,
        none: '🖼️ Bildauswertung aktiv, aber keine Tabellen/Abbildungen erkannt',
        unsupported: '<span class="warn">🖼️ nur als Text – das Modell verarbeitet keine Bilder</span>',
        rejected: '<span class="warn">🖼️ nur als Text – das Modell hat die Bilder abgelehnt</span>',
        off: '🖼️ Bildauswertung ausgeschaltet – Tabellen/Abbildungen nur als Text'
    }[info.vision_status] || '';
    const scanned = q.scanned_pages.length ? ` · <span class="warn">⚠ ohne Textschicht (gescannt?): S. ${q.scanned_pages.join(', ')}</span>` : '';
    return `<div class="source-info">📄 ${q.pages} Seiten gelesen · Tabellen: ${pagesText(q.table_pages)} · Abbildungen: ${pagesText(q.figure_pages)}${scanned}${visionText ? ` · ${visionText}` : ''}</div>`;
}

// ---------- Integritätsprüfung: rechnerisch und per LLM nebeneinander ----------
function integrityBadge(kind, text) {
    const styles = {
        ok: 'background:#ecfdf5;color:#047857;border:1px solid #a7f3d0;',
        warn: 'background:#fffbeb;color:#92400e;border:1px solid #fde68a;',
        bad: 'background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;',
        none: 'background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;'
    };
    return `<span style="display:inline-block;padding:.1rem .4rem;border-radius:.3rem;white-space:nowrap;font-size:.75rem;${styles[kind] || styles.none}">${escapeHTML(text)}</span>`;
}

function codeStatVerdict(s) {
    if (!s) return integrityBadge('none', 'nicht gefunden');
    if (s.consistent) return integrityBadge('ok', 'passt');
    if (s.gross_error) return integrityBadge('bad', s.one_tailed_possible ? 'Signifikanz geändert (einseitig?)' : 'Signifikanz geändert');
    return integrityBadge('warn', s.one_tailed_possible ? 'abweichend (einseitig?)' : 'abweichend');
}

function llmStatVerdict(l) {
    if (!l) return integrityBadge('none', 'nicht gefunden');
    const v = String(l.consistent || '').toLowerCase();
    const p = Number.isFinite(Number(l.estimated_p)) ? ` · p≈${Number(l.estimated_p).toPrecision(2)}` : '';
    if (v === 'yes') return integrityBadge('ok', 'passt' + p);
    if (v === 'no') return integrityBadge(l.significance_changed ? 'bad' : 'warn', (l.significance_changed ? 'Signifikanz geändert' : 'abweichend') + p);
    return integrityBadge('none', 'unklar' + p);
}

function link(url, text) {
    return `<a href="${escapeHTML(url)}" target="_blank" rel="noopener">${escapeHTML(text)}</a>`;
}

function renderIntegrity(integ, title) {
    const { options = {}, computed, online, llm, llm_error: llmError, comparison } = integ;
    const showCode = !!(computed || online);
    const showLlm = !!options.llm;
    const fmtP = p => p === null || p === undefined ? '–' : p < 0.001 ? '< .001' : p.toFixed(3).replace(/^0/, '');

    // Kennzahlen
    const chips = [];
    if (computed) {
        const st = computed.statistics_summary;
        chips.push(`<div class="integ-chip"><div class="integ-chip-title">RECHNERISCH (statcheck)</div><div class="integ-chip-value">${st.total} Tests</div><div>${st.inconsistent} abweichend · ${st.gross_errors} Signifikanz geändert</div></div>`);
    }
    if (showLlm) {
        const tests = Array.isArray(llm?.statistical_tests) ? llm.statistical_tests : [];
        const bad = tests.filter(t => String(t.consistent).toLowerCase() === 'no').length;
        chips.push(`<div class="integ-chip"><div class="integ-chip-title">LLM (Agent 6)</div><div class="integ-chip-value">${llm ? tests.length + ' Tests' : 'fehlgeschlagen'}</div><div>${llm ? `${bad} abweichend` : escapeHTML(llmError || '')}</div></div>`);
    }
    if (comparison) {
        chips.push(`<div class="integ-chip"><div class="integ-chip-title">ÜBEREINSTIMMUNG</div><div class="integ-chip-value">${comparison.verdict_agreement === null ? 'n/a' : Math.round(comparison.verdict_agreement * 100) + ' %'}</div><div>${comparison.found_by_both} gemeinsam · ${comparison.found_by_code - comparison.found_by_both} nur Code · ${comparison.found_by_llm - comparison.found_by_both} nur LLM</div></div>`);
    }
    if (online) {
        const status = !online.checked ? integrityBadge('none', 'nicht geprüft') : online.retracted ? integrityBadge('bad', 'RETRACTED') : online.concern ? integrityBadge('warn', 'Expression of Concern') : online.corrected ? integrityBadge('warn', 'Korrektur vorhanden') : online.found ? integrityBadge('ok', 'keine Rücknahme bekannt') : integrityBadge('warn', 'DOI unbekannt');
        chips.push(`<div class="integ-chip"><div class="integ-chip-title">CROSSREF</div><div class="integ-chip-value">${status}</div><div>${escapeHTML(online.checked ? (online.journal || '') : online.reason || '')}</div></div>`);
    }

    // Statistik-Tabelle: Zeilen aus dem Vergleich bzw. aus der jeweils vorhandenen Seite
    const rows = comparison ? comparison.rows
        : computed ? computed.statistics.map(c => ({ code: c, llm: null }))
        : (llm?.statistical_tests || []).map(l => ({ code: null, llm: l }));
    const statRows = rows.map(({ code, llm: l }) => `<tr>
        <td>${escapeHTML(code?.page ?? l?.page ?? '')}</td>
        <td>${escapeHTML(code?.label || l?.reported || '')}</td>
        ${showCode ? `<td>${code ? fmtP(code.computed_p) : '–'}</td><td>${codeStatVerdict(code)}</td>` : ''}
        ${showLlm ? `<td>${llmStatVerdict(l)}${l?.note ? `<div style="font-size:.72rem;color:var(--text-light);">${escapeHTML(l.note)}</div>` : ''}</td>` : ''}
    </tr>`).join('');
    const statTable = rows.length ? `<div style="overflow-x:auto;"><table class="integ-table"><thead><tr><th>S.</th><th>Angabe im Text</th>${showCode ? '<th>p nachgerechnet</th><th>Rechnerisch</th>' : ''}${showLlm ? '<th>LLM</th>' : ''}</tr></thead><tbody>${statRows}</tbody></table></div>`
        : '<div style="font-size:.85rem;color:var(--text-light);">Keine Teststatistiken im Format „t(df) = x, p = y“ gefunden.</div>';

    // Weitere Prüfungen nebeneinander
    const cell = html => `<td style="vertical-align:top;">${html || '<span style="color:var(--text-light);">–</span>'}</td>`;
    const grimCode = computed ? (computed.grim.length ? computed.grim.map(g => `${g.consistent ? integrityBadge('ok', 'möglich') : integrityBadge('warn', 'unmöglich')} S. ${g.page}: M = ${escapeHTML(g.mean_text ?? g.mean)}, n = ${g.n}`).join('<br>') + '<div style="font-size:.72rem;color:var(--text-light);">Nur aussagekräftig bei ganzzahligen Einzelwerten (z.B. ein Likert-Item).</div>' : 'keine Kandidaten (M und n in einer Klammer)') : '';
    const grimLlm = (llm?.grim || []).map(g => `${String(g.consistent).toLowerCase() === 'no' ? integrityBadge('warn', 'unmöglich') : String(g.consistent).toLowerCase() === 'yes' ? integrityBadge('ok', 'möglich') : integrityBadge('none', 'n/a')} ${escapeHTML(g.reported || '')}`).join('<br>');
    const ss = computed?.sample_summary;
    const sampleCode = ss ? `Gesamt-N: ${ss.totals.length ? escapeHTML(ss.totals.join(', ')) : '–'}${ss.multiple_totals ? ' ' + integrityBadge('warn', 'mehrere Werte') : ''}<br>Teilgruppen n: ${ss.subgroups.length ? escapeHTML(ss.subgroups.slice(0, 8).join(', ')) : '–'}${ss.extracted_n ? `<br>Extrahiertes N = ${escapeHTML(ss.extracted_n)} ${ss.extracted_n_found ? integrityBadge('ok', 'im Text gefunden') : integrityBadge('warn', 'nicht als N/n im Text')}` : ''}` : '';
    const sampleLlm = llm ? `${String(llm.sample_size_consistent).toLowerCase() === 'no' ? integrityBadge('warn', 'Widerspruch') : String(llm.sample_size_consistent).toLowerCase() === 'yes' ? integrityBadge('ok', 'stimmig') : integrityBadge('none', 'unklar')} ${escapeHTML(llm.sample_size_note || '')}` : '';
    const reg = computed?.registrations;
    const regCode = reg ? `${reg.ids.length ? reg.ids.map(x => `${link(x.url, x.id)} (${escapeHTML(x.registry)}, S. ${x.page})`).join('<br>') : 'keine Registrierungsnummer gefunden'}<br>Präregistrierung erwähnt: ${reg.preregistration_mentioned ? 'ja' : 'nein'}` : '';
    const regLlm = llm ? `${(llm.registrations || []).map(x => escapeHTML(`${x.id} (${x.registry || '?'})`)).join('<br>') || 'keine'}<br>Präregistrierung erwähnt: ${escapeHTML(llm.preregistration_mentioned || '–')}` : '';
    const doi = online?.checked && online.found ? online : null;
    const doiValue = computed?.doi || online?.doi || null;
    const doiCode = (computed || online) ? `${doiValue ? link(`https://doi.org/${doiValue}`, doiValue) : 'keine DOI gefunden'}${doi ? `<br>${escapeHTML(doi.title || '')}${doi.year ? ` (${doi.year})` : ''} ${doi.title_matches_document === false ? integrityBadge('warn', 'Titel passt nicht zum PDF') : doi.title_matches_document ? integrityBadge('ok', 'Titel passt') : ''}${doi.notices.map(n => `<br>${integrityBadge(/retract/i.test(n.type) ? 'bad' : 'warn', n.label || n.type)} ${link(`https://doi.org/${n.notice_doi}`, n.notice_doi)}`).join('')}` : online && !online.checked ? `<br><span style="color:var(--text-light);">${escapeHTML(online.reason)}</span>` : ''}` : '';
    const doiLlm = llm ? `${escapeHTML(llm.doi || '–')}<br>Retraction/Korrektur im Text erwähnt: ${escapeHTML(llm.retraction_or_correction_mentioned || '–')}${llm.retraction_note ? ` – ${escapeHTML(llm.retraction_note)}` : ''}` : '';
    const sideBySide = `<div style="overflow-x:auto;margin-top:.6rem;"><table class="integ-table"><thead><tr><th>Prüfung</th>${showCode ? '<th>Rechnerisch</th>' : ''}${showLlm ? '<th>LLM</th>' : ''}</tr></thead><tbody>
        <tr><td><strong>GRIM</strong></td>${showCode ? cell(grimCode) : ''}${showLlm ? cell(grimLlm) : ''}</tr>
        <tr><td><strong>Stichprobengrößen</strong></td>${showCode ? cell(sampleCode) : ''}${showLlm ? cell(sampleLlm) : ''}</tr>
        <tr><td><strong>Registrierung</strong></td>${showCode ? cell(regCode) : ''}${showLlm ? cell(regLlm) : ''}</tr>
        <tr><td><strong>DOI / Retraction</strong></td>${showCode ? cell(doiCode) : ''}${showLlm ? cell(doiLlm) : ''}</tr>
    </tbody></table></div>`;
    const llmIssues = Array.isArray(llm?.issues) && llm.issues.length ? `<div style="margin-top:.5rem;font-size:.85rem;"><strong>Auffälligkeiten laut LLM:</strong><ul style="margin-left:1.2rem;">${llm.issues.map(x => `<li>${escapeHTML(x)}</li>`).join('')}</ul></div>` : '';
    const llmSummary = llm?.summary ? `<div style="margin-top:.35rem;font-size:.85rem;"><strong>LLM-Fazit:</strong> ${escapeHTML(llm.summary)}</div>` : '';

    return `<div class="integ-box">
        <div style="font-size:.72rem;color:#1e3a8a;font-weight:700;">INTEGRITÄTSPRÜFUNG</div>
        <div class="integ-chips">${chips.join('')}</div>
        <details open><summary style="cursor:pointer;font-weight:600;margin:.4rem 0;">Statistische Angaben (${rows.length})</summary>${statTable}</details>
        ${sideBySide}
        ${llmIssues}${llmSummary}
        <div style="font-size:.72rem;color:var(--text-light);margin-top:.5rem;">Rechnerisch: zweiseitige p-Werte aus Teststatistik und Freiheitsgraden (wie statcheck), Rundung der berichteten Werte berücksichtigt; durchsucht den <em>gesamten</em> PDF-Text. Das LLM sieht nur den Evidenzkontext. Abweichungen sind Hinweise, keine Beweise – z.B. bei einseitigen Tests, Korrekturen für multiples Testen oder Fehlern beim Auslesen des PDFs.</div>
    </div>`;
}

async function saveToHistory(res, steps) {
    if (!currentUser) return;
    try {
        await saveRun(currentUser, res, steps);
    } catch (err) {
        log(`Lauf konnte nicht gespeichert werden: ${err?.message || err}`, 'error');
        console.error(err);
    }
}

async function loadHistory() {
    if (!currentUser) return;
    const list = document.getElementById('history-list');
    const runs = await listRuns(currentUser);
    const estimate = await storageEstimate();
    document.getElementById('history-storage').textContent = estimate?.usage
        ? `${runs.length} Lauf/Läufe · lokal belegt: ${(estimate.usage / 1048576).toFixed(1)} MB von ca. ${(estimate.quota / 1048576).toFixed(0)} MB`
        : `${runs.length} Lauf/Läufe`;
    if (runs.length === 0) {
        list.innerHTML = "<p>Noch keine Historie vorhanden.</p>";
        return;
    }
    list.innerHTML = runs.map(run => {
        const h = run.result || {};
        return `
        <div class="history-item" onclick="viewHistoryItem('${run.id}')">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.25rem; gap: .5rem; flex-wrap: wrap;">
                <strong>${escapeHTML(h.date || new Date(run.createdAt).toLocaleString())}</strong>
                <span style="font-size: 0.8rem; background: var(--bg); padding: 0.2rem 0.5rem; border-radius: 0.25rem; border: 1px solid var(--border);">
                    🤖 ${escapeHTML(h.model || 'Unbekannt')}
                </span>
            </div>
            <div style="font-size: 0.9rem; color: var(--text-light);">
                ${h.extractions ? h.extractions.length : 0} Dokument(e) analysiert | <strong>Score:</strong> ${escapeHTML(h.validation?.casq_score ?? '-')} (${escapeHTML(h.validation?.overall_quality || '-')})<br>

                <!-- Detaillierte Parameter- & Performance-Ansicht -->
                <div style="margin-top: 0.4rem; font-size: 0.75rem; display: flex; gap: 0.4rem; flex-wrap: wrap;">
                    <span class="version-badge" title="LLM-Provider">⚙️ ${escapeHTML(h.provider || '-')}</span>
                    <span class="version-badge" title="Durchschnittliche Token-Rate" style="background: #ecfdf5; color: #065f46; font-weight: bold;">⚡ ${h.tokensPerSec ? h.tokensPerSec + ' Tok/s' : '-'}</span>
                    <span class="version-badge" title="Temperature">🌡️ Temp: ${h.temperature !== undefined ? escapeHTML(h.temperature) : '-'}</span>
                    <span class="version-badge" title="Max Output Tokens">📤 Out: ${escapeHTML(h.maxTokens || '-')}</span>
                    <span class="version-badge" title="Max Evidence (Input Limit)">📥 In: ${escapeHTML(h.maxEvidence || '-')}</span>
                    <span class="version-badge" title="Genutzte Prompt-Version (Extraction)">📝 Prompt: ${escapeHTML(h.prompts_used?.extraction || '-')}</span>
                    ${run.legacy ? '<span class="version-badge" title="Aus der Einzeldatei-Version übernommen">↪ übernommen</span>' : ''}
                </div>
                <div class="history-actions">
                    ${run.legacy ? '' : `<button class="btn btn-secondary btn-small" onclick="event.stopPropagation(); downloadRunSteps('${run.id}')">Agent-Protokoll (JSON)</button>`}
                    <button class="btn btn-secondary btn-small" onclick="event.stopPropagation(); removeRun('${run.id}')">Löschen</button>
                </div>
            </div>
        </div>`;
    }).join('');
}

async function viewHistoryItem(id) {
    const run = await getRun(id);
    if (!run) return;
    globalResults = run.result;
    switchTab('dashboard');
    [1,2,3,4,5].forEach(i => setStep(i, 'done'));
    renderResults(globalResults);
}

function downloadJSON(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function downloadRunSteps(id) {
    const run = await getRun(id);
    const steps = await getRunSteps(id);
    downloadJSON(`agent-protokoll-${(run?.createdAt || id).slice(0, 19).replace(/[:T]/g, '-')}.json`, { run_id: id, created_at: run?.createdAt, model: run?.model, steps });
}

async function removeRun(id) {
    if (!confirm('Diesen Lauf inklusive Agent-Protokoll löschen?')) return;
    await deleteRun(id);
    loadHistory();
}

async function exportHistory() {
    const data = await exportUserData(currentUser);
    downloadJSON(`publikations-agent-${currentUser}-${new Date().toISOString().slice(0, 10)}.json`, data);
}

async function importHistory(fileList) {
    const file = fileList && fileList[0];
    document.getElementById('history-import').value = '';
    if (!file) return;
    try {
        const result = await importUserData(currentUser, JSON.parse(await file.text()));
        loadPromptsToUI();
        alert(`Import abgeschlossen: ${result.runs} Lauf/Läufe, ${result.prompts} Prompt-Version(en) und ${result.references} Referenzbewertung(en) übernommen.`);
        loadHistory();
    } catch (err) {
        alert(`Import fehlgeschlagen: ${err?.message || err}`);
    }
}
