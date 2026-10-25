// ==========================================
// JSON-SCHEMATA DER AGENTEN-ANTWORTEN
// ==========================================
// Werden als response_format "json_schema" mitgeschickt. Server mit strukturierter Ausgabe (vLLM,
// OpenAI, LM Studio, …) erzwingen damit Aufbau und erlaubte Werte – keine abgebrochenen oder frei
// erfundenen Felder mehr. Alle Felder sind Pflicht (so verlangt es der strikte Modus von OpenAI);
// "nicht vorhanden" wird über null bzw. not_reported ausgedrückt.

const S = {
    str: () => ({ type: 'string' }),
    num: () => ({ type: 'number' }),
    int: () => ({ type: 'integer' }),
    bool: () => ({ type: 'boolean' }),
    enum: values => ({ type: 'string', enum: values }),
    arr: items => ({ type: 'array', items }),
    obj: props => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false }),
    nullable: schema => schema.enum
        ? { ...schema, type: [schema.type, 'null'], enum: [...schema.enum, null] }
        : { ...schema, type: [schema.type, 'null'] }
};

const REPORTED = ['reported', 'partial', 'not_reported', 'not_applicable'];
const FRAMEWORK_RESPONSE = ['yes', 'no', 'cant_tell', 'not_applicable'];
const CHECKLIST_RESPONSE = ['yes', 'partial', 'no', 'not_reported', 'not_applicable'];
const DOCUMENT_TYPES = ['primary_empirical_study', 'multiple_study_report', 'systematic_review', 'narrative_review',
    'methodological_paper', 'theoretical_conceptual_paper', 'other', 'unclear'];
const ESTABLISHED_INSTRUMENTS = ['PEDro Scale', 'MINORS', 'AMSTAR 2', 'COSMIN Risk of Bias', 'none'];
const ESTABLISHED_RESPONSE = ['yes', 'no', 'partial_yes', 'very_good', 'adequate', 'doubtful', 'inadequate', 'not_applicable'];
const OFFICIAL_RATINGS = ['High', 'Moderate', 'Low', 'Critically low', 'Very good', 'Adequate', 'Doubtful', 'Inadequate', 'not_applicable'];

const evidenceRef = () => S.obj({ page: S.nullable(S.int()), section: S.str(), quote: S.str() });
const valueWithEvidence = () => S.obj({ value: S.str(), evidence: S.str() });

function extractionSchema() {
    return S.obj({
        evidence_locations: S.arr(S.obj({ claim: S.str(), section: S.str(), page: S.nullable(S.int()), quote: S.str() })),
        document_type: S.enum(DOCUMENT_TYPES),
        document_type_rationale: S.str(),
        study_family: S.enum(['Quantitative', 'Qualitative', 'Mixed Methods', 'Review', 'Theoretical', 'Methodological', 'Other', 'Unclear']),
        study_design: S.str(),
        embedded_studies: S.arr(S.obj({
            label: S.str(), study_family: S.str(), study_design: S.str(), sample_n: S.str(),
            methods: S.arr(S.str()), main_results: S.arr(S.str()),
            role_in_document: S.enum(['primary', 'illustrative', 'validation', 'secondary']), evidence: S.str()
        })),
        multi_study_reporting: S.obj(Object.fromEntries(['shared_introduction', 'study_sequence_logic', 'per_study_method',
            'per_study_results', 'per_study_discussion', 'general_discussion', 'overall_limitations'].map(k => [k, S.enum(REPORTED)]))),
        research_domain: S.str(),
        clinical_context: S.obj({
            is_health_clinical: S.bool(), is_physiotherapy_rehabilitation: S.bool(), is_surgical: S.bool(),
            is_intervention_study: S.bool(), is_measurement_property_study: S.bool(), is_PROM_study: S.bool(),
            is_comparative: S.bool(), evidence: S.str()
        }),
        publication_year: S.str(),
        research_question: valueWithEvidence(),
        hypotheses: S.arr(valueWithEvidence()),
        theoretical_framework: valueWithEvidence(),
        sample: S.obj({ n: S.str(), population: S.str(), sampling: S.str(), inclusion_exclusion: S.str(), power_analysis: S.str() }),
        methods: S.arr(S.str()),
        data_collection: S.arr(S.str()),
        measures: S.arr(S.obj({ construct: S.str(), instrument: S.str(), reliability_validity: S.str(), evidence: S.str() })),
        analysis_methods: S.arr(S.str()),
        datasets: S.arr(S.str()),
        main_results: S.arr(S.obj({ result: S.str(), effect_size: S.str(), p_value: S.str(), confidence_interval: S.str(), evidence: S.str() })),
        limitations_reported: S.arr(S.obj({ limitation: S.str(), evidence: S.str() })),
        transparency: S.obj({ preregistration: S.str(), data_availability: S.str(), code_availability: S.str(), funding: S.str(), conflicts_of_interest: S.str() }),
        key_arguments: S.arr(S.str()),
        summary: S.str(),
        extraction_uncertainties: S.arr(S.str())
    });
}

function jarsSchema(validated) {
    return S.obj({
        applicable: S.bool(),
        scope_note: S.str(),
        criteria: S.arr(S.obj({
            criterion: S.str(), status: S.enum(REPORTED),
            [validated ? 'source_refs' : 'evidence']: S.arr(evidenceRef()),
            [validated ? 'validation_note' : 'rationale']: S.str()
        })),
        reporting_summary: S.str()
    });
}

function embeddedSchema() {
    return S.arr(S.obj({
        label: S.str(), study_design: S.str(), selected_instrument: S.str(), applicable: S.bool(), result: S.str(),
        criteria: S.arr(S.obj({ criterion: S.str(), response: S.str(), rationale: S.str() }))
    }));
}

function establishedSchema(validated) {
    return S.obj({
        instrument: S.enum(ESTABLISHED_INSTRUMENTS),
        applicable: S.bool(),
        applicability_reason: S.str(),
        scope_note: S.str(),
        scoring_type: S.enum(['numeric', 'categorical', 'none']),
        official_score: S.nullable(S.num()),
        official_max: S.nullable(S.num()),
        official_rating: S.nullable(S.enum(OFFICIAL_RATINGS)),
        items: S.arr(S.obj({
            item_id: S.str(), criterion: S.str(), response: S.enum(ESTABLISHED_RESPONSE),
            points: S.nullable(S.num()), max_points: S.nullable(S.num()), critical: S.bool(),
            evidence: S.arr(evidenceRef()), [validated ? 'validation_note' : 'rationale']: S.str()
        })),
        summary: S.str()
    });
}

function frameworkSchema(validated) {
    const criterion = () => S.arr(S.obj({ criterion: S.str(), framework_response: S.enum(FRAMEWORK_RESPONSE), evidence: S.arr(evidenceRef()), [validated ? 'validation_note' : 'rationale']: S.str() }));
    return S.obj({
        primary_framework: S.str(),
        ...(validated ? {} : { secondary_framework: S.str() }),
        framework_category: S.str(),
        screening: criterion(),
        criteria: criterion(),
        framework_summary: S.str()
    });
}

function analysisSchema() {
    return S.obj({
        document_type_confirmed: S.enum(DOCUMENT_TYPES),
        study_design_confirmed: S.str(),
        jars_quant: jarsSchema(false),
        embedded_study_appraisals: embeddedSchema(),
        established_appraisal: establishedSchema(false),
        framework_appraisal: frameworkSchema(false),
        bias_domains: S.arr(S.obj({ domain: S.str(), evidence: S.str(), rating: S.enum(['low', 'some_concerns', 'high', 'unclear', 'not_applicable']), rationale: S.str() })),
        critical_strengths: S.arr(S.str()),
        critical_limitations: S.arr(S.str()),
        reporting_gaps: S.arr(S.str()),
        appraisal_summary: S.str()
    });
}

function validationSchema() {
    return S.obj({
        evidence_coverage: S.nullable(S.num()),
        validated_jars_quant: jarsSchema(true),
        validated_embedded_study_appraisals: embeddedSchema(),
        validated_established_appraisal: establishedSchema(true),
        validated_framework: frameworkSchema(true),
        unsupported_claims: S.arr(S.str()),
        validation_summary: S.str()
    });
}

// CASQ-Prüffragen: Die erlaubten IDs sind genau die der gewählten Rubrik.
function casqSchema(rubricKey, validated) {
    const ids = CASQ_RUBRICS[rubricKey].dimensions.flatMap(d => d.questions.map(q => q.id));
    const item = validated
        ? S.obj({ id: S.enum(ids), original_response: S.enum(CHECKLIST_RESPONSE), response: S.enum(CHECKLIST_RESPONSE), evidence: S.arr(evidenceRef()), validation_note: S.str() })
        : S.obj({ id: S.enum(ids), response: S.enum(CHECKLIST_RESPONSE), evidence: S.arr(evidenceRef()), rationale: S.str() });
    return S.obj({ [validated ? 'validated_casq_checklist' : 'casq_checklist']: S.arr(item) });
}

function synthesisSchema() {
    const level = S.enum(['none', 'one', 'two']);
    return S.obj({
        topics: S.arr(S.str()),
        synthesized_arguments: S.arr(S.str()),
        consistency_of_findings: S.enum(['high', 'moderate', 'low', 'unclear']),
        strength_of_evidence: S.enum(['high', 'moderate', 'low', 'very_low', 'unclear']),
        grade_assessment: S.obj({
            applicable: S.bool(),
            applicability_reason: S.str(),
            outcomes: S.arr(S.obj({
                outcome: S.str(),
                certainty: S.enum(['high', 'moderate', 'low', 'very_low', 'unclear']),
                starting_point: S.enum(['high', 'low', 'unclear']),
                downgrading: S.obj({ risk_of_bias: level, inconsistency: level, indirectness: level, imprecision: level, publication_bias: level }),
                upgrading_factors: S.arr(S.str()),
                rationale: S.str()
            })),
            summary: S.str()
        }),
        heterogeneity_notes: S.arr(S.str()),
        cross_study_limitations: S.arr(S.str()),
        narrative_summary: S.str(),
        meta_analysis_performed: S.bool()
    });
}

function integritySchema() {
    return S.obj({
        statistical_tests: S.arr(S.obj({
            page: S.nullable(S.int()), reported: S.str(), test: S.enum(['t', 'F', 'chi2', 'r', 'z']), df: S.str(),
            statistic: S.nullable(S.num()), reported_p: S.str(), estimated_p: S.nullable(S.num()),
            consistent: S.enum(['yes', 'no', 'unclear']), significance_changed: S.bool(), note: S.str()
        })),
        grim: S.arr(S.obj({ page: S.nullable(S.int()), reported: S.str(), consistent: S.enum(['yes', 'no', 'not_applicable']), note: S.str() })),
        sample_sizes: S.arr(S.obj({ page: S.nullable(S.int()), value: S.num(), context: S.str() })),
        sample_size_consistent: S.enum(['yes', 'no', 'unclear']),
        sample_size_note: S.str(),
        registrations: S.arr(S.obj({ id: S.str(), registry: S.str(), page: S.nullable(S.int()) })),
        preregistration_mentioned: S.enum(['yes', 'no']),
        doi: S.str(),
        retraction_or_correction_mentioned: S.enum(['yes', 'no']),
        retraction_note: S.str(),
        issues: S.arr(S.str()),
        summary: S.str()
    });
}

// Schema je Agent; ctx.rubric wird für die CASQ-Agenten gebraucht.
function agentSchema(agent, ctx = {}) {
    const build = {
        extraction: extractionSchema,
        analysis: analysisSchema,
        casq: () => casqSchema(ctx.rubric, false),
        validation: validationSchema,
        casq_validation: () => casqSchema(ctx.rubric, true),
        synthesis: synthesisSchema,
        integrity: integritySchema
    }[agent];
    return build ? { name: `${agent}_result`, schema: build() } : null;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { agentSchema, S };
}
