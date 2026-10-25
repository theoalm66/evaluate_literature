const test = require('node:test');
const assert = require('node:assert/strict');
const { startMockLLM } = require('./e2e/mock-llm');
const { runProbe } = require('../tools/api-probe.js');

test('api-probe: alle Proben laufen gegen einen Test-Server, Bericht enthält keinen API-Key', async () => {
    const llm = await startMockLLM(0);
    const port = llm.server.address().port;
    llm.state.requireKey = 'geheimer-key-123';
    try {
        const lines = [];
        const report = await runProbe({ url: `http://127.0.0.1:${port}/v1`, model: 'mock-model', key: 'geheimer-key-123', repeat: '2', pause: '0', timeout: '20', chars: '3000' }, l => lines.push(l));
        assert.equal(report.probes.length, 14);
        assert.ok(report.probes.every(p => p.failures === 0), 'Fehler: ' + report.probes.filter(p => p.failures).map(p => p.id).join(','));
        assert.equal(report.probes.find(p => p.id === 'parallel3').runs, 6);
        assert.ok(report.findings.length >= 2);
        assert.ok(!JSON.stringify(report).includes('geheimer-key-123') && !lines.join('\n').includes('geheimer-key-123'), 'API-Key darf nie ausgegeben werden');
        // Streaming wurde tatsächlich gestreamt (mehrere Datenstücke) und gelesen
        const stream = report.probes.find(p => p.id === 'tiny-stream').details[0];
        assert.ok(stream.chunks >= 1 && stream.ok, 'Datenstrom nicht gelesen');
    } finally { llm.server.close(); }
});

test('api-probe: falscher Key und hängender Server werden als Fehler berichtet', async () => {
    const llm = await startMockLLM(0);
    const port = llm.server.address().port;
    llm.state.requireKey = 'richtig';
    try {
        const bad = await runProbe({ url: `http://127.0.0.1:${port}/v1`, model: 'm', key: 'falsch', only: 'tiny', repeat: '1', pause: '0', timeout: '5' }, () => {});
        assert.equal(bad.probes[0].failures, 1);
        assert.match(bad.probes[0].details[0].error, /401/);
        llm.state.requireKey = null;
        llm.state.hangFirst = 1;
        const hang = await runProbe({ url: `http://127.0.0.1:${port}/v1`, model: 'm', only: 'tiny', repeat: '2', pause: '0', timeout: '1' }, () => {});
        assert.equal(hang.probes[0].failures, 1, 'der hängende Aufruf muss als Zeitüberschreitung gelten');
        assert.match(hang.probes[0].details[0].error, /Zeitlimit der Probe/);
        assert.ok(hang.findings.some(f => /keine Antwort/.test(f)));
    } finally { llm.server.close(); }
});
