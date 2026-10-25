const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../app/js/providers.js');

test('Modellliste: OpenAI-Format, Duplikate, Sortierung, Embedding-Modelle ausgeblendet', () => {
    const r = p.parseModelList({ object: 'list', data: [
        { id: 'qwen3-235b-a22b' }, { id: 'meta-llama-3.1-8b-instruct' }, { id: 'e5-mistral-7b-instruct' },
        { id: 'qwen3-embedding-4b' }, { id: 'whisper-large-v3' }, { id: 'gemma-3-27b-it' }, { id: 'gemma-3-27b-it' }
    ] });
    assert.deepEqual(r.models, ['gemma-3-27b-it', 'meta-llama-3.1-8b-instruct', 'qwen3-235b-a22b']);
    assert.equal(r.hidden, 3);
    assert.equal(r.all.length, 6);
});

test('Modellliste: andere Antwortformen und leere Antworten', () => {
    assert.deepEqual(p.parseModelList(['b', 'a']).models, ['a', 'b']);
    assert.deepEqual(p.parseModelList({ models: [{ name: 'x' }] }).models, ['x']);
    assert.deepEqual(p.parseModelList({ data: [] }).models, []);
    assert.deepEqual(p.parseModelList(null).models, []);
    assert.deepEqual(p.parseModelList({ data: [{ id: '' }, {}] }).models, []);
});

test('Provider-Zuordnung', () => {
    assert.equal(p.isUrlProvider('hochschule'), true);
    assert.equal(p.isUrlProvider('endpoint'), true);
    assert.equal(p.isUrlProvider('custom2'), true);
    assert.equal(p.isUrlProvider('openai'), false);
    assert.equal(p.isUrlProvider('spark'), false);
    assert.deepEqual(p.MODEL_PROVIDERS, ['hochschule', 'endpoint']);
});
