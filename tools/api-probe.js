#!/usr/bin/env node
// Diagnosewerkzeug für OpenAI-kompatible Modell-Server (z.B. die Hochschul-API), unabhängig von der App.
// Misst mit denselben Anfragen, die die App stellt: Antwortzeit, Streaming-Verhalten, Wirkung von JSON-Schema und
// Reasoning-Parameter, Streuung bei Wiederholung und Verhalten bei parallelen Anfragen. Schreibt einen Bericht.
//
//   node tools/api-probe.js --url https://api.ai.rh-koeln.de/v1 --model <modell> --key <API-Key>
//
// Der API-Key kann auch über die Umgebungsvariable LIT_PROBE_KEY kommen (landet dann nicht in der Shell-Historie).
// Er wird nie ausgegeben oder in den Bericht geschrieben.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const HELP = `Verwendung: node tools/api-probe.js --url <Basis-URL mit /v1> --model <Modell> [Optionen]

  --key <Key>        API-Key (oder Umgebungsvariable LIT_PROBE_KEY)
  --text <Datei>     Textdatei als Dokument für die Extraktionsproben (z.B. der Text eines PDFs); sonst Beispieltext
  --chars <n>        Länge des Beispieltexts bzw. Kürzung der Datei (Standard 15000)
  --repeat <n>       Wiederholungen je Probe, zeigt die Streuung (Standard 3)
  --timeout <s>      Zeitlimit je Anfrage in Sekunden (Standard 330, damit ein Abbruch bei 300 s sichtbar wird)
  --only <ids>       nur diese Proben, durch Komma getrennt (siehe unten); Standard: alle
  --pause <s>        Pause zwischen den Anfragen (Standard 2)
  --out <Datei>      Bericht als JSON (Standard api-probe-bericht.json)
  --quick            Kurzlauf: 1 Wiederholung, Zeitlimit 120 s

Proben: models, tiny, tiny-stream, tiny-json, tiny-schema, schema-small, extract1, extract1-noschema, extract1-stream,
        extract2, reasoning-param, speed, speed-stream, parallel3`;

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) args[key] = true;
        else { args[key] = next; i++; }
    }
    return args;
}

// ---------- Hilfen ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = ms => ms === null || ms === undefined ? '–' : `${(ms / 1000).toFixed(1)} s`;
const median = arr => { const s = [...arr].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

function loadAppParts() {
    const appDir = path.join(__dirname, '..', 'app', 'js');
    const prompts = new Function(`${fs.readFileSync(path.join(appDir, 'prompts.js'), 'utf8')}\nreturn { DEFAULT_PROMPTS, DEFAULT_SYSTEM_PROMPT };`)();
    const { fillTemplate } = require(path.join(appDir, 'scoring.js'));
    const { agentSchema, EXTRACTION_PARTS } = require(path.join(appDir, 'schemas.js'));
    return { ...prompts, fillTemplate, agentSchema, EXTRACTION_PARTS };
}

const SAMPLE_PARAGRAPH = 'In dieser Online-Befragung wurden 412 Käuferinnen und Käufer eines großen Onlinehändlers zu ihrer Wahrnehmung von Social-Media-Werbung und ihrer Kaufabsicht befragt. '
    + 'Die Konstrukte wurden mit etablierten Skalen auf einer siebenstufigen Likert-Skala erfasst (Cronbachs Alpha zwischen 0,81 und 0,92). '
    + 'Das Strukturmodell wurde mit PLS-SEM geschätzt, die Signifikanz der Pfade wurde mit 5.000 Bootstrap-Stichproben geprüft. '
    + 'Die Stichprobe wurde über ein Online-Panel rekrutiert; 37 Fälle wurden wegen fehlgeschlagener Aufmerksamkeitsprüfung ausgeschlossen. '
    + 'Die Ergebnisse zeigen einen signifikanten Pfad von wahrgenommener Relevanz auf Kaufabsicht (β = 0,41, p < 0,001, f² = 0,18). ';

function buildDocument(args) {
    const limit = parseInt(args.chars, 10) || 15000;
    if (typeof args.text === 'string') return fs.readFileSync(args.text, 'utf8').slice(0, limit);
    let text = '--- PAGE 1 ---\nTitel: Wirkung von Social-Media-Werbung auf die Kaufabsicht\n';
    for (let page = 1; text.length < limit; page++) text += `\n--- PAGE ${page} ---\n${SAMPLE_PARAGRAPH.repeat(4)}`;
    return text.slice(0, limit);
}

// ---------- Anfrage ----------
// Liefert Zeiten bis zu den Antwortköpfen, bis zum ersten Datenteil und bis zum Ende, plus Fehler und Inhalt.
async function request(cfg, body, { stream = false, timeoutMs = cfg.timeoutMs, method = 'POST', endpoint = '/chat/completions' } = {}) {
    const result = { ok: false, status: null, headersMs: null, firstChunkMs: null, totalMs: null, chunks: 0, bytes: 0, error: null, content: '', reasoning: 0, finish: null, usage: null, model: null };
    const started = performance.now();
    try {
        const res = await fetch(cfg.url + endpoint, {
            method,
            headers: { 'Content-Type': 'application/json', ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) },
            body: method === 'POST' ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(timeoutMs)
        });
        result.status = res.status;
        result.headersMs = performance.now() - started;
        result.contentType = res.headers.get('content-type');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let raw = '';
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (result.firstChunkMs === null) result.firstChunkMs = performance.now() - started;
            result.chunks++;
            result.bytes += value.length;
            raw += decoder.decode(value, { stream: true });
        }
        result.totalMs = performance.now() - started;
        if (!res.ok) { result.error = `HTTP ${res.status}: ${raw.replace(/\s+/g, ' ').slice(0, 220)}`; return result; }
        if (endpoint === '/models') { result.ok = true; result.content = raw; return result; }
        if (raw.trimStart().startsWith('{')) {
            const json = JSON.parse(raw);
            const message = json.choices?.[0]?.message || {};
            result.content = message.content ?? '';
            result.reasoning = String(message.reasoning_content ?? message.reasoning ?? '').length;
            result.finish = json.choices?.[0]?.finish_reason ?? null;
            result.usage = json.usage || null;
            result.model = json.model || null;
        } else {
            for (const line of raw.split('\n')) {
                if (!line.startsWith('data:')) continue;
                const payload = line.slice(5).trim();
                if (!payload || payload === '[DONE]') continue;
                try {
                    const chunk = JSON.parse(payload);
                    const delta = chunk.choices?.[0]?.delta || {};
                    result.content += delta.content || '';
                    result.reasoning += String(delta.reasoning_content ?? delta.reasoning ?? '').length;
                    if (chunk.choices?.[0]?.finish_reason) result.finish = chunk.choices[0].finish_reason;
                    if (chunk.usage) result.usage = chunk.usage;
                    if (chunk.model) result.model = chunk.model;
                } catch (e) { /* unvollständige Zeile */ }
            }
        }
        result.ok = true;
    } catch (err) {
        result.totalMs = performance.now() - started;
        result.error = err?.name === 'TimeoutError' ? `keine vollständige Antwort nach ${Math.round(timeoutMs / 1000)} s (Zeitlimit der Probe)` : `${err?.cause?.code || err?.name || 'Fehler'}: ${err?.message || err}`;
    }
    return result;
}

function jsonValid(text) {
    const t = String(text || '');
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b < a) return false;
    try { JSON.parse(t.slice(a, b + 1)); return true; } catch (e) { return false; }
}

function chatBody(cfg, userContent, extra = {}) {
    return {
        model: cfg.model,
        messages: [{ role: 'system', content: cfg.systemPrompt }, { role: 'user', content: userContent }],
        temperature: 0,
        max_tokens: 200,
        ...extra
    };
}

const schemaFormat = (name, schema) => ({ response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } } });

// ---------- Proben ----------
function buildProbes(cfg, parts, document) {
    const tinyPrompt = 'Antworte nur mit {"ok": true}';
    const smallSchema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
    const extractionPrompt = part => {
        const known = part === 'classification' ? '' : 'Bereits bestimmt (Teil 1): Dokumenttyp primary_empirical_study, Studienfamilie Quantitative, Design Online-Befragung.\n';
        const instruction = `TEILAUFGABE (Teil ${part === 'classification' ? 1 : 2} von 3): Liefere AUSSCHLIESSLICH diese Schlüssel des JSON-SCHEMA: ${parts.EXTRACTION_PARTS[part].join(', ')}. Lass alle anderen Schlüssel weg. Höchstens 12 Einträge je Liste, keine Wiederholungen, jede Angabe knapp.\n${known}`;
        return parts.fillTemplate(parts.DEFAULT_PROMPTS.extraction, { TITLE: 'Probe.pdf', SOURCE_TEXT: document, PART_INSTRUCTION: instruction });
    };
    const numbers = Array.from({ length: 150 }, (_, i) => i + 1).join(', ');
    const speedPrompt = `Antworte nur mit JSON: {"zahlen": [${numbers}]} – gib genau diese Zahlen aus.`;
    const extract = (part, extra, maxTokens) => chatBody(cfg, extractionPrompt(part), { max_tokens: maxTokens, ...extra });
    return [
        { id: 'models', title: 'Modellliste abrufen (GET /models)', run: () => request(cfg, null, { method: 'GET', endpoint: '/models', timeoutMs: 60000 }) },
        { id: 'tiny', title: 'Kurzaufruf, normal', run: () => request(cfg, chatBody(cfg, tinyPrompt, { max_tokens: 30 })) },
        { id: 'tiny-stream', title: 'Kurzaufruf, Streaming', run: () => request(cfg, chatBody(cfg, tinyPrompt, { max_tokens: 30, stream: true, stream_options: { include_usage: true } }), { stream: true }) },
        { id: 'tiny-json', title: 'Kurzaufruf, JSON-Modus (json_object)', run: () => request(cfg, chatBody(cfg, tinyPrompt, { max_tokens: 30, response_format: { type: 'json_object' } })) },
        { id: 'tiny-schema', title: 'Kurzaufruf, kleines JSON-Schema (strict)', run: () => request(cfg, chatBody(cfg, tinyPrompt, { max_tokens: 30, ...schemaFormat('probe', smallSchema) })) },
        { id: 'schema-small', title: 'Kurzaufruf, Extraktions-Schema Teil 1 (13 Felder) mit kurzem Text', run: () => request(cfg, chatBody(cfg, 'Titel: Test. Online-Befragung mit 200 Teilnehmenden im Marketing. Fülle das JSON aus.', { max_tokens: 1500, ...schemaFormat('extraction_result', parts.agentSchema('extraction', { part: 'classification' }).schema) })) },
        { id: 'extract1', title: `Extraktion Teil 1 mit Schema und ${document.length.toLocaleString('de-DE')} Zeichen Text (wie die App)`, run: () => request(cfg, extract('classification', schemaFormat('extraction_result', parts.agentSchema('extraction', { part: 'classification' }).schema), 3000)) },
        { id: 'extract1-noschema', title: 'Extraktion Teil 1 ohne Schema (einfacher Modus)', run: () => request(cfg, extract('classification', {}, 3000)) },
        { id: 'extract1-stream', title: 'Extraktion Teil 1 mit Schema, Streaming', run: () => request(cfg, extract('classification', { ...schemaFormat('extraction_result', parts.agentSchema('extraction', { part: 'classification' }).schema), stream: true, stream_options: { include_usage: true } }, 3000), { stream: true }) },
        { id: 'extract2', title: 'Extraktion Teil 2 (Methoden) mit Schema', run: () => request(cfg, extract('methods', schemaFormat('extraction_result', parts.agentSchema('extraction', { part: 'methods' }).schema), 4000)) },
        { id: 'reasoning-param', title: 'Kurzaufruf mit chat_template_kwargs (Reasoning abschalten)', run: () => request(cfg, chatBody(cfg, tinyPrompt, { max_tokens: 30, chat_template_kwargs: { enable_thinking: false } })) },
        { id: 'speed', title: 'Erzeugungstempo (ca. 450 Token Ausgabe), normal', run: () => request(cfg, chatBody(cfg, speedPrompt, { max_tokens: 900 })) },
        { id: 'speed-stream', title: 'Erzeugungstempo, Streaming (zeigt, ob wirklich gestreamt wird)', run: () => request(cfg, chatBody(cfg, speedPrompt, { max_tokens: 900, stream: true, stream_options: { include_usage: true } }), { stream: true }) },
        { id: 'parallel3', title: 'Drei Kurzaufrufe gleichzeitig (Warteschlange / Ratenbegrenzung)', parallel: 3, run: () => request(cfg, chatBody(cfg, tinyPrompt, { max_tokens: 30 })) }
    ];
}

async function runProbe(args, log = console.log) {
    const cfg = {
        url: String(args.url || '').replace(/\/+$/, ''),
        model: args.model,
        key: typeof args.key === 'string' ? args.key : process.env.LIT_PROBE_KEY || '',
        timeoutMs: (parseFloat(args.timeout) || (args.quick ? 120 : 330)) * 1000,
        systemPrompt: ''
    };
    if (!cfg.url) throw new Error('--url fehlt');
    if (!cfg.model && !args.only) throw new Error('--model fehlt');
    const parts = loadAppParts();
    cfg.systemPrompt = parts.DEFAULT_SYSTEM_PROMPT;
    const repeat = args.quick ? 1 : parseInt(args.repeat, 10) || 3;
    const pauseMs = (args.pause !== undefined ? parseFloat(args.pause) : 2) * 1000;
    const only = typeof args.only === 'string' ? args.only.split(',').map(s => s.trim()) : null;
    const probes = buildProbes(cfg, parts, buildDocument(args)).filter(p => !only || only.includes(p.id));

    log(`Probe gegen ${cfg.url}, Modell ${cfg.model || '(ohne)'}, ${probes.length} Proben × ${repeat}, Zeitlimit ${cfg.timeoutMs / 1000} s${cfg.key ? '' : ' (ohne API-Key)'}\n`);
    const report = { started: new Date().toISOString(), url: cfg.url, model: cfg.model, repeat, timeoutSeconds: cfg.timeoutMs / 1000, probes: [] };
    for (const probe of probes) {
        log(`▶ ${probe.title}`);
        const runs = [];
        for (let i = 0; i < repeat; i++) {
            const results = probe.parallel ? await Promise.all(Array.from({ length: probe.parallel }, () => probe.run())) : [await probe.run()];
            runs.push(...results);
            for (const r of results) {
                const flag = r.ok ? 'ok ' : 'FEHLER';
                const tokens = r.usage?.completion_tokens;
                log(`   ${flag} gesamt ${fmt(r.totalMs)}, Antwortkopf ${fmt(r.headersMs)}, erstes Datenstück ${fmt(r.firstChunkMs)}, ${r.chunks} Stücke${tokens ? `, ${tokens} Token (${(tokens / (r.totalMs / 1000)).toFixed(0)}/s)` : ''}${r.error ? `\n      ${r.error}` : ''}`);
                if (r.ok && probe.id !== 'models') log(`      Antwort: ${r.content.length} Zeichen, JSON ${jsonValid(r.content) ? 'gültig' : 'UNGÜLTIG oder abgeschnitten'}, Reasoning ${r.reasoning} Zeichen, Abschluss: ${r.finish || 'unbekannt'}`);
            }
            if (pauseMs && i < repeat - 1) await sleep(pauseMs);
        }
        const okTimes = runs.filter(r => r.ok).map(r => r.totalMs);
        report.probes.push({
            id: probe.id, title: probe.title, runs: runs.length, failures: runs.filter(r => !r.ok).length,
            medianMs: median(okTimes), minMs: okTimes.length ? Math.min(...okTimes) : null, maxMs: okTimes.length ? Math.max(...okTimes) : null,
            details: runs.map(r => ({ ok: r.ok, status: r.status, totalMs: Math.round(r.totalMs), headersMs: r.headersMs && Math.round(r.headersMs), firstChunkMs: r.firstChunkMs && Math.round(r.firstChunkMs),
                chunks: r.chunks, bytes: r.bytes, contentType: r.contentType, finish: r.finish, contentChars: r.content.length, reasoningChars: r.reasoning, jsonValid: probe.id === 'models' ? undefined : jsonValid(r.content), completionTokens: r.usage?.completion_tokens ?? null, error: r.error, sample: probe.id === 'models' ? undefined : r.content.slice(0, 160) }))
        });
        log('');
        if (pauseMs) await sleep(pauseMs);
    }
    report.findings = interpret(report);
    log('Zusammenfassung');
    for (const p of report.probes) log(`  ${p.id.padEnd(18)} ${String(p.runs - p.failures).padStart(2)}/${p.runs} ok   Median ${fmt(p.medianMs).padStart(8)}   min ${fmt(p.minMs).padStart(8)}   max ${fmt(p.maxMs).padStart(8)}`);
    log('\nAuswertung');
    report.findings.forEach(f => log(`  • ${f}`));
    return report;
}

// Einfache, vorsichtige Deutung der Messwerte.
function interpret(report) {
    const by = id => report.probes.find(p => p.id === id);
    const f = [];
    const failed = report.probes.filter(p => p.failures);
    const timeouts = report.probes.flatMap(p => p.details).filter(d => /Zeitlimit der Probe/.test(d.error || ''));
    const total = report.probes.reduce((a, p) => a + p.runs, 0);
    if (!failed.length) f.push(`Alle ${total} Anfragen waren erfolgreich.`);
    else f.push(`${failed.reduce((a, p) => a + p.failures, 0)} von ${total} Anfragen scheiterten (${failed.map(p => p.id).join(', ')}).`);
    if (timeouts.length) f.push(`${timeouts.length} Anfrage(n) bekamen innerhalb von ${report.timeoutSeconds} s keine Antwort. Das passt zu einem hängenden oder überlasteten Dienst.`);
    const tiny = by('tiny'), tinySchema = by('tiny-schema'), schemaSmall = by('schema-small'), e1 = by('extract1'), e1n = by('extract1-noschema');
    if (tiny?.medianMs && tinySchema?.medianMs && tinySchema.medianMs > 3 * tiny.medianMs && tinySchema.medianMs > 5000)
        f.push(`Das kleine JSON-Schema macht den Kurzaufruf deutlich langsamer (${fmt(tiny.medianMs)} → ${fmt(tinySchema.medianMs)}): Schema-Unterstützung des Servers ist ein Bremsklotz.`);
    if (tiny?.medianMs && schemaSmall?.medianMs && schemaSmall.medianMs > 5 * tiny.medianMs && schemaSmall.medianMs > 10000)
        f.push(`Das große Extraktions-Schema braucht deutlich länger als ein Kurzaufruf (${fmt(schemaSmall.medianMs)}): Der Server kompiliert/verarbeitet komplexe Schemata langsam. Empfehlung: in der App „JSON-Schema nicht verwenden“.`);
    if (e1?.medianMs && e1n?.medianMs && e1.medianMs > 2 * e1n.medianMs) f.push(`Extraktion mit Schema ist deutlich langsamer als ohne (${fmt(e1.medianMs)} gegenüber ${fmt(e1n.medianMs)}).`);
    if (e1 && e1n && e1.failures > e1n.failures) f.push('Mit Schema scheitern mehr Extraktionsaufrufe als ohne: Schema abschalten.');
    for (const id of ['tiny-stream', 'speed-stream', 'extract1-stream']) {
        const p = by(id);
        const d = p?.details.filter(x => x.ok && x.firstChunkMs && x.totalMs > 3000);
        if (d?.length) {
            const buffered = d.filter(x => x.firstChunkMs > 0.9 * x.totalMs).length;
            f.push(buffered === d.length
                ? `Streaming (${id}): Der erste Datenteil kommt erst am Ende (${buffered}/${d.length}). Der Server oder ein Gateway puffert die Antwort, Streaming hilft gegen Zeitlimits nicht.`
                : `Streaming (${id}): Daten kommen fortlaufend an. Streaming funktioniert und kann Zeitlimits entschärfen.`);
        }
    }
    const answered = report.probes.filter(p => p.id !== 'models').flatMap(p => p.details).filter(d => d.ok);
    const cut = answered.filter(d => d.finish === 'length');
    if (cut.length) f.push(`${cut.length} Antwort(en) wurden an der Token-Grenze abgeschnitten (Abschluss „length“). Mit Reasoning verbraucht das Modell einen Teil des Budgets zum Denken.`);
    const thinking = answered.filter(d => d.reasoningChars > 0);
    if (thinking.length) f.push(`${thinking.length} Antwort(en) enthalten Reasoning-Text (im Mittel ${Math.round(thinking.reduce((a, d) => a + d.reasoningChars, 0) / thinking.length)} Zeichen): Das Modell denkt vor der Antwort, das kostet Zeit und Token.`);
    const speed = by('speed');
    const tok = speed?.details.find(d => d.ok && d.completionTokens);
    if (tok) f.push(`Erzeugungstempo: etwa ${(tok.completionTokens / (tok.totalMs / 1000)).toFixed(0)} Token/s. Für ${(5 * 60 * (tok.completionTokens / (tok.totalMs / 1000))).toFixed(0)} Token Ausgabe in 5 Minuten.`);
    const spread = report.probes.filter(p => p.minMs && p.maxMs && p.maxMs > 5 * p.minMs && p.maxMs > 20000);
    if (spread.length) f.push(`Starke Streuung bei gleicher Anfrage (${spread.map(p => `${p.id}: ${fmt(p.minMs)} bis ${fmt(p.maxMs)}`).join('; ')}): zeitweise überlasteter Dienst bzw. Warteschlange.`);
    const par = by('parallel3');
    if (par?.medianMs && tiny?.medianMs && par.maxMs > 2.5 * tiny.maxMs && par.maxMs > 8000) f.push('Parallele Anfragen werden hintereinander abgearbeitet oder gedrosselt (Warteschlange).');
    // Zufällige Sofort-Fehler (5xx in unter 1 s): kein Parameterproblem, sondern ein instabiler Dienst
    const all = report.probes.flatMap(p => p.details);
    const instant5xx = all.filter(d => !d.ok && d.status >= 500 && d.totalMs < 1500);
    if (instant5xx.length) f.push(`${instant5xx.length} von ${all.length} Anfragen scheiterten sofort (unter 1,5 s) mit einem 5xx-Fehler, auch einfache Aufrufe. Das sind zufällige Fehler des Dienstes (z.B. ein defekter Knoten hinter dem Gateway), keine Folge bestimmter Parameter. Die App wiederholt solche Aufrufe automatisch.`);
    const rp = by('reasoning-param');
    if (rp) {
        const rejected = rp.details.filter(d => !d.ok && (d.status === 400 || d.status === 422));
        if (rejected.length === rp.runs) f.push(`„Reasoning abschalten“ (chat_template_kwargs) wird abgelehnt: ${rp.details[0]?.error || ''}`);
        else if (rp.failures === 0) f.push('„Reasoning abschalten“ (chat_template_kwargs) wird angenommen.');
        else f.push(`„Reasoning abschalten“ (chat_template_kwargs): nicht eindeutig (${rp.failures} von ${rp.runs} fehlgeschlagen, kein 400/422). Bei zufälligen 5xx-Fehlern des Dienstes mit --only reasoning-param --repeat 6 wiederholen.`);
    }
    return f;
}

module.exports = { runProbe, parseArgs, interpret, buildDocument };

if (require.main === module) {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || args.h || !args.url) { console.log(HELP); process.exit(args.url ? 0 : 1); }
    runProbe(args).then(report => {
        const out = typeof args.out === 'string' ? args.out : 'api-probe-bericht.json';
        fs.writeFileSync(out, JSON.stringify(report, null, 2));
        console.log(`\nBericht geschrieben: ${out} (ohne API-Key). Bitte diese Datei oder die Ausgabe oben senden.`);
    }).catch(err => { console.error(`Fehler: ${err.message}\n\n${HELP}`); process.exit(1); });
}
