const test = require('node:test');
const assert = require('node:assert/strict');
// schemas.js nutzt im Browser die globale CASQ_RUBRICS aus scoring.js
global.CASQ_RUBRICS = require('../app/js/scoring.js').CASQ_RUBRICS;
const { agentSchema } = require('../app/js/schemas.js');

const AGENTS = ['extraction', 'analysis', 'casq', 'validation', 'casq_validation', 'synthesis', 'integrity'];

// Regeln des strikten Modus (OpenAI): jedes Objekt mit additionalProperties:false und allen Feldern in required
function checkStrict(schema, path = '$') {
    const types = [].concat(schema.type);
    if (types.includes('object')) {
        assert.equal(schema.additionalProperties, false, `${path}: additionalProperties`);
        assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${path}: required`);
        for (const [k, v] of Object.entries(schema.properties)) checkStrict(v, `${path}.${k}`);
    }
    if (types.includes('array')) checkStrict(schema.items, `${path}[]`);
    for (const t of types) assert.ok(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(t), `${path}: Typ ${t}`);
    if (schema.enum) for (const v of schema.enum) assert.ok(v === null || typeof v === 'string', `${path}: enum`);
}

// Kleiner Validator für die verwendeten Schema-Bausteine
function validate(schema, value, path = '$') {
    const types = [].concat(schema.type);
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
    const ok = types.includes(actual) || (actual === 'integer' && types.includes('number'));
    if (!ok) return [`${path}: erwartet ${types.join('|')}, ist ${actual}`];
    if (schema.enum && !schema.enum.includes(value)) return [`${path}: ${JSON.stringify(value)} nicht erlaubt`];
    if (actual === 'object') {
        const errs = [];
        for (const k of schema.required) if (!(k in value)) errs.push(`${path}.${k}: fehlt`);
        for (const k of Object.keys(value)) if (!schema.properties[k]) errs.push(`${path}.${k}: nicht vorgesehen`);
        for (const [k, v] of Object.entries(value)) if (schema.properties[k]) errs.push(...validate(schema.properties[k], v, `${path}.${k}`));
        return errs;
    }
    if (actual === 'array') return value.flatMap((v, i) => validate(schema.items, v, `${path}[${i}]`));
    return [];
}

test('Alle Agenten-Schemata erfüllen die Regeln des strikten Modus', () => {
    for (const agent of AGENTS) {
        const s = agentSchema(agent, { rubric: 'quantitative' });
        assert.ok(s && s.name && s.schema, agent);
        checkStrict(s.schema, agent);
    }
    assert.equal(agentSchema('unbekannt'), null);
});

test('CASQ-Schema erlaubt nur die IDs der gewählten Rubrik', () => {
    const s = agentSchema('casq', { rubric: 'review' }).schema;
    const ids = s.properties.casq_checklist.items.properties.id.enum;
    assert.equal(ids.length, 20);
    assert.ok(ids.every(id => id.startsWith('RV-')));
    const answer = { casq_checklist: [{ id: 'RV-2.1', response: 'yes', evidence: [{ page: 3, section: 'Methods', quote: 'We searched MEDLINE and Embase.' }], rationale: '' }] };
    assert.deepEqual(validate(s, answer), []);
    assert.ok(validate(s, { casq_checklist: [{ ...answer.casq_checklist[0], id: 'QN-1.1' }] }).length > 0, 'fremde ID muss scheitern');
    assert.ok(validate(s, { casq_checklist: [{ ...answer.casq_checklist[0], response: 'vielleicht' }] }).length > 0, 'freier Wert muss scheitern');
});

test('Typische Antworten passen zu den Schemata', () => {
    const synthesis = {
        topics: ['Bewegung'], synthesized_arguments: [], consistency_of_findings: 'moderate', strength_of_evidence: 'low',
        grade_assessment: { applicable: true, applicability_reason: 'Intervention', outcomes: [{ outcome: 'Schmerz', certainty: 'low', starting_point: 'high',
            downgrading: { risk_of_bias: 'one', inconsistency: 'none', indirectness: 'none', imprecision: 'one', publication_bias: 'none' }, upgrading_factors: [], rationale: '...' }], summary: '' },
        heterogeneity_notes: [], cross_study_limitations: [], narrative_summary: '...', meta_analysis_performed: false
    };
    assert.deepEqual(validate(agentSchema('synthesis').schema, synthesis), []);
    const integrity = {
        statistical_tests: [{ page: 4, reported: 't(28) = 2.10, p = .045', test: 't', df: '28', statistic: 2.1, reported_p: '= .045', estimated_p: 0.045, consistent: 'yes', significance_changed: false, note: '' }],
        grim: [], sample_sizes: [{ page: 2, value: 60, context: 'N = 60' }], sample_size_consistent: 'yes', sample_size_note: '',
        registrations: [], preregistration_mentioned: 'no', doi: 'not_reported', retraction_or_correction_mentioned: 'no', retraction_note: '', issues: [], summary: ''
    };
    assert.deepEqual(validate(agentSchema('integrity').schema, integrity), []);
    const ea = { instrument: 'PEDro Scale', applicable: true, applicability_reason: '', scope_note: '', scoring_type: 'numeric', official_score: 7, official_max: 10, official_rating: null,
        items: [{ item_id: '2', criterion: 'Random allocation', response: 'yes', points: 1, max_points: 1, critical: false, evidence: [{ page: null, section: '', quote: '' }], rationale: '' }], summary: '' };
    assert.deepEqual(validate(agentSchema('analysis').schema.properties.established_appraisal, ea), []);
});

test('Extraktion in Teilschritten: die Teile ergeben zusammen genau das vollständige Schema', () => {
    const { agentSchema, EXTRACTION_PARTS } = require('../app/js/schemas.js');
    const full = Object.keys(agentSchema('extraction').schema.properties).sort();
    const parts = Object.values(EXTRACTION_PARTS).flat();
    assert.equal(new Set(parts).size, parts.length, 'ein Schlüssel kommt in mehreren Teilen vor');
    assert.deepEqual([...parts].sort(), full);
    for (const part of Object.keys(EXTRACTION_PARTS)) {
        const schema = agentSchema('extraction', { part }).schema;
        assert.deepEqual(Object.keys(schema.properties), EXTRACTION_PARTS[part]);
        assert.deepEqual(schema.required, EXTRACTION_PARTS[part], 'strikter Modus verlangt alle Felder');
        assert.equal(schema.additionalProperties, false);
    }
});
