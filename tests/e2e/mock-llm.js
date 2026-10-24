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

const pedroItems = ['1','2','3','4','5','6','7','8','9'].map(id => ({
    item_id: id, criterion: `PEDro ${id}`, response: ['2','3','8','9'].includes(id) || id === '1' ? 'yes' : 'no',
    points: id !== '1' && ['2','3','8','9'].includes(id) ? 1 : 0, max_points: id === '1' ? 0 : 1,
    evidence: id === '3' ? [{ page: 2, section: 'Methods', quote: Q.alloc }] : []
}));

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

function checklist(prompt, validated) {
    return checklistIds(prompt).map(id => {
        let [response, quote] = CHECKLIST_SPECIAL[id] || ['yes', id.startsWith('QN-6') ? Q.alloc : id.startsWith('QN-5') ? Q.stats : id.startsWith('QN-9') ? Q.limits : Q.rq];
        if (validated && id === 'QN-1.2') response = 'partial';
        return { id, response, evidence: quote ? [{ page: 1, section: 'Methods', quote }] : [], [validated ? 'validation_note' : 'rationale']: `Test ${id}` };
    });
}

function answerFor(prompt) {
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
        established_appraisal: { instrument: 'PEDro Scale', applicable: true, applicability_reason: 'Physiotherapie-RCT', items: pedroItems },
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
    if (prompt.includes('Du bist Agent 5')) return {
        topics: ['Bewegungstherapie'], narrative_summary: 'Testsynthese.', consistency_of_findings: 'unclear',
        strength_of_evidence: 'low', grade_assessment: { applicable: false, outcomes: [] }
    };
    return {};
}

function startMockLLM(port) {
    const calls = [];
    const server = http.createServer((req, res) => {
        const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
        if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            if (req.url.endsWith('/models')) { res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'mock' }] })); }
            const payload = JSON.parse(body || '{}');
            const prompt = payload.messages?.find(m => m.role === 'user')?.content || '';
            calls.push(prompt);
            const content = JSON.stringify(answerFor(prompt));
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: Math.round(prompt.length / 4), completion_tokens: Math.round(content.length / 4) } }));
        });
    });
    return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, calls })));
}

module.exports = { startMockLLM, QUOTES: Q };
