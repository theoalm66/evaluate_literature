// OpenAI-kompatibler Fake-Endpunkt, der je Agent eine feste Antwort liefert.
const http = require('http');

const Q = {
    rq: 'This randomised controlled trial examined whether supervised exercise reduces chronic low back pain.',
    alloc: 'Allocation was concealed using sealed opaque envelopes prepared by an independent researcher.',
    stats: 'Outcomes were analysed by intention to treat using linear mixed models with baseline adjustment.',
    limits: 'A limitation is that therapists could not be blinded to group allocation.'
};

const quantitativeDims = [
    ['Research question & theory', Q.rq, 8, 'supported'],
    ['Design appropriateness', Q.rq, 8, 'supported'],
    ['Sample & external validity', 'The sample was clearly representative of all patients worldwide.', 6, 'partially_supported'],
    ['Measurement quality', null, null, 'insufficient_information'],
    ['Statistical analysis', Q.stats, 9, 'supported'],
    ['Bias & internal validity', Q.alloc, 7, 'supported'],
    ['Results interpretation', Q.stats, 7, 'supported'],
    ['Transparency & reproducibility', null, null, 'not_applicable'],
    ['Limitations', Q.limits, 8, 'supported']
];

// Bei Temperatur > 0 (Mehrfachbewertung) weicht jeder dritte Aufruf in zwei Antworten ab: Item 4 und QN-2.1
const varies = ctx => ctx && ctx.temperature > 0 && ctx.index % 3 === 1;

function pedroItemsFor(ctx) {
    const yes = ['2', '3', '8', '9'];
    return ['1','2','3','4','5','6','7','8','9'].map(id => {
        const isYes = id === '1' || yes.includes(id) || (id === '4' && varies(ctx));
        return { item_id: id, criterion: `PEDro ${id}`, response: isYes ? 'yes' : 'no',
            points: id !== '1' && isYes ? 1 : 0, max_points: id === '1' ? 0 : 1,
            evidence: id === '3' ? [{ page: 2, section: 'Methods', quote: Q.alloc }] : [] };
    });
}
const pedroItems = pedroItemsFor(null);

// Prüffragen-IDs werden aus dem Prompt gelesen (wie ein echtes Modell sie sieht).
function checklistIds(prompt) {
    return [...prompt.matchAll(/^([A-Z]{2}-\d+\.\d+) \[/gm)].map(m => m[1]);
}

// Agent 3: fast alles erfüllt; eine Antwort mit nicht auffindbarem Zitat, eine "nicht berichtet",
// eine "nicht anwendbar", eine "nein". Agent 4 stuft QN-1.2 auf "teilweise" herab.
const CHECKLIST_SPECIAL = {
    'QN-3.3': ['yes', 'The sample was clearly representative of all patients worldwide.'],
    'QN-4.2': ['not_reported', null],
    'QN-8.1': ['not_applicable', null],
    'QN-6.3': ['no', null]
};

function checklist(prompt, validated, ctx) {
    return checklistIds(prompt).map(id => {
        let [response, quote] = CHECKLIST_SPECIAL[id] || ['yes', id.startsWith('QN-6') ? Q.alloc : id.startsWith('QN-5') ? Q.stats : id.startsWith('QN-9') ? Q.limits : Q.rq];
        if (validated && id === 'QN-1.2') response = 'partial';
        if (!validated && id === 'QN-2.1' && varies(ctx)) response = 'partial';
        return { id, response, evidence: quote ? [{ page: 1, section: 'Methods', quote }] : [], [validated ? 'validation_note' : 'rationale']: `Test ${id}` };
    });
}

function answerFor(prompt, ctx) {
    if (prompt.includes('Du bist Agent 3b')) return { casq_checklist: checklist(prompt, false, ctx) };
    if (prompt.includes('Du bist Agent 4b')) return { validated_casq_checklist: checklist(prompt, true) };
    if (prompt.includes('Du bist Agent 2') && ctx.domain === 'review') return {
        document_type: 'systematic_review', study_family: 'Review', study_design: 'Systematic literature review (SPAR-4-SLR)', method_class: 'not_applicable',
        research_domain: 'Marketing / E-Commerce', clinical_context: { is_health_clinical: false },
        evidence_locations: [{ claim: 'Fragestellung', section: 'Introduction', page: 9, quote: Q.rq }],
        research_question: { value: 'Wie wirkt Social-Media-Werbung auf Kaufabsichten?' }, methods: ['SLR'], main_results: [{ result: 'Themenlandkarte' }]
    };
    if (prompt.includes('Du bist Agent 2') && ctx.domain === 'business') return {
        document_type: 'primary_empirical_study', study_family: 'Quantitative', study_design: 'Cross-sectional online survey', method_class: 'survey_sem',
        research_domain: 'Business / Marketing', clinical_context: { is_health_clinical: false, is_physiotherapy_rehabilitation: false, is_comparative: false, is_intervention_study: false },
        evidence_locations: [{ claim: 'Fragestellung', section: 'Introduction', page: 9, quote: Q.rq }],
        research_question: { value: 'Beeinflusst Social-Media-Werbung die Kaufabsicht?' },
        sample: { n: '412', population: 'Online-Käufer' }, methods: ['PLS-SEM'], main_results: [{ result: 'Pfad signifikant' }]
    };
    if (prompt.includes('Du bist Agent 2')) return {
        document_type: 'primary_empirical_study', study_family: 'Quantitative', study_design: 'Randomised controlled trial',
        clinical_context: { is_health_clinical: true, is_physiotherapy_rehabilitation: true, is_comparative: true, is_intervention_study: true },
        evidence_locations: [{ claim: 'Fragestellung', section: 'Introduction', page: 9, quote: Q.rq }],
        research_question: { value: 'Reduziert betreutes Training chronische Rückenschmerzen?' },
        sample: { n: '60', population: 'Erwachsene mit chronischen Rückenschmerzen' },
        methods: ['RCT'], main_results: [{ result: 'Schmerzreduktion' }], limitations_reported: [{ limitation: 'Keine Verblindung der Therapeuten' }]
    };
    if (prompt.includes('Du bist Agent 3')) return {
        document_type_confirmed: 'primary_empirical_study',
        established_appraisal: { instrument: 'PEDro Scale', applicable: true, applicability_reason: 'Physiotherapie-RCT', items: pedroItemsFor(ctx) },
        framework_appraisal: { primary_framework: 'none' },
        ...(checklistIds(prompt).length ? { casq_checklist: checklist(prompt, false) }
            : { dimensions: quantitativeDims.map(([name, , score, status]) => ({ name, score, weight: 11, status: status === 'not_applicable' ? 'not_applicable' : 'applicable' })) }),
        critical_strengths: ['Verdeckte Zuteilung'], critical_limitations: ['Keine Therapeutenverblindung']
    };
    if (prompt.includes('Du bist Agent 4')) return {
        evidence_coverage: 95,
        validated_established_appraisal: { instrument: 'PEDro Scale', applicable: true, applicability_reason: 'Physiotherapie-RCT', items: pedroItems },
        ...(checklistIds(prompt).length ? { validated_casq_checklist: checklist(prompt, true) } : {
            validated_dimensions: quantitativeDims.map(([name, quote, score, status]) => ({
                name, original_score: score, adjusted_score: score, weight: 11, validation_status: status,
                source_refs: quote ? [{ page: 1, section: 'Methods', quote }] : []
            }))
        }),
        validation_summary: 'Testvalidierung $& mit Sonderzeichen.'
    };
    if (prompt.includes('Du bist Agent 6')) return {
        statistical_tests: [
            { page: 1, reported: 't(28) = 2.10, p = .045', test: 't', df: '28', statistic: 2.10, reported_p: '= .045', estimated_p: 0.045, consistent: 'yes', significance_changed: false },
            { page: 1, reported: 'F(2, 57) = 1.20, p < .05', test: 'F', df: '2, 57', statistic: 1.20, reported_p: '< .05', estimated_p: 0.04, consistent: 'yes', significance_changed: false, note: 'LLM übersieht den Fehler' }
        ],
        grim: [], sample_sizes: [{ page: 1, value: 60, context: 'N = 60' }], sample_size_consistent: 'yes', sample_size_note: 'Stimmig.',
        registrations: [{ id: 'NCT01234567', registry: 'ClinicalTrials.gov', page: 1 }], preregistration_mentioned: 'yes',
        doi: '10.1234/test.2026.001', retraction_or_correction_mentioned: 'no', issues: ['Test-Auffälligkeit'], summary: 'Testfazit Integrität.'
    };
    if (prompt.includes('Du bist Agent 5')) return {
        topics: ['Bewegungstherapie'], narrative_summary: 'Testsynthese.', consistency_of_findings: 'unclear',
        strength_of_evidence: 'low', grade_assessment: { applicable: false, outcomes: [] }
    };
    return {};
}

function startMockLLM(port) {
    const calls = [];            // Text der Agent-Aufrufe (ohne Bildprüfung)
    const imageCalls = [];       // { agent, images } je Aufruf mit Bildern
    const state = { streamed: [], failSchema500: 0, rejectStream: false, rejectKwargs: false, payloads: [], sseContentType: 'text/event-stream', streamAsOneJson: false, domain: 'health', vision: true, jsonSchema: true, requireKey: null, agentCalls: {} };
    const temps = [];            // Agent und Temperatur je Aufruf
    const formats = [];          // response_format-Typ je Aufruf
    const server = http.createServer((req, res) => {
        const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
        if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            // Optionaler API-Key-Zwang (Hochschul-API-Test): ohne passenden Bearer-Key 401
            if (state.requireKey && req.headers.authorization !== `Bearer ${state.requireKey}`) {
                res.writeHead(401, { ...cors, 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
            }
            if (req.url.endsWith('/models')) { res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'mock-model', max_model_len: 32768 }, { id: 'mock-embedding-model' }, { id: 'zweites-modell' }] })); }
            const payload = JSON.parse(body || '{}');
            const raw = payload.messages?.find(m => m.role === 'user')?.content || '';
            const parts = Array.isArray(raw) ? raw : [{ type: 'text', text: raw }];
            const prompt = parts.filter(p => p.type === 'text').map(p => p.text).join('\n');
            const images = parts.filter(p => p.type === 'image_url').length;
            if (images && !state.vision) {
                res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: { message: 'This model does not support image input.' } }));
            }
            const format = payload.response_format?.type || 'none';
            if (format === 'json_schema' && !state.jsonSchema) {
                res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: { message: 'response_format json_schema is not supported by this server' } }));
            }
            if (!prompt.includes('Welche Farbe')) state.payloads.push(payload);
            if (payload.chat_template_kwargs && state.rejectKwargs) {
                res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: { message: 'Unrecognized request argument: chat_template_kwargs' } }));
            }
            // Datenstrom abgelehnt (manche Server kennen stream_options nicht)
            if (payload.stream && state.rejectStream) {
                res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: { message: 'stream_options is not supported' } }));
            }
            // Serverfehler 500 bei JSON-Schema (wie bei manchen Gateways), solange state.failSchema500 > 0
            if (format === 'json_schema' && state.failSchema500 > 0) {
                state.failSchema500--;
                res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ statusCode: 500, message: 'Internal Server Error' }));
            }
            const isProbe = prompt.includes('Welche Farbe');
            if (!isProbe) formats.push(format);
            if (!isProbe) calls.push(prompt);
            if (images && !isProbe) imageCalls.push({ agent: (prompt.match(/Du bist Agent (\d)/) || [])[1], images });
            const agentTag = (prompt.match(/Du bist Agent (\d+b?)/) || [])[1] || '?';
            const index = (state.agentCalls[agentTag] = (state.agentCalls[agentTag] ?? -1) + 1);
            if (!isProbe) temps.push({ agent: agentTag, temperature: payload.temperature });
            const content = JSON.stringify(isProbe ? { farbe: images ? 'rot' : 'unbekannt' } : answerFor(prompt, { temperature: payload.temperature, index, domain: state.domain }));
            if (payload.stream && state.streamAsOneJson) {   // Server ignoriert Streaming und antwortet normal
                res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ model: 'mock-model', choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
            }
            if (payload.stream) {
                state.streamed.push(!!payload.stream_options);
                res.writeHead(200, { ...cors, 'Content-Type': state.sseContentType });
                const half = Math.floor(content.length / 2);
                const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
                send({ model: 'mock-model', choices: [{ delta: { role: 'assistant' } }] });
                send({ model: 'mock-model', choices: [{ delta: { reasoning_content: 'ignoriert' } }] });
                send({ model: 'mock-model', choices: [{ delta: { content: content.slice(0, half) } }] });
                send({ model: 'mock-model', choices: [{ delta: { content: content.slice(half) }, finish_reason: 'stop' }] });
                send({ model: 'mock-model', choices: [], usage: { prompt_tokens: Math.round(prompt.length / 4), completion_tokens: Math.round(content.length / 4) } });
                res.write('data: [DONE]\n\n');
                return res.end();
            }
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ model: 'mock-model', choices: [{ message: { content } }], usage: { prompt_tokens: Math.round(prompt.length / 4), completion_tokens: Math.round(content.length / 4) } }));
        });
    });
    return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, calls, imageCalls, state, formats, temps })));
}

module.exports = { startMockLLM, QUOTES: Q };
