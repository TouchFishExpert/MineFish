import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../mindcraft/src/agent/agent.js';
import {getCommand, getCommandDocs, isAction, executeCommand} from '../mindcraft/src/agent/commands/index.js';
import {DeepSeekWebSearch, deepSeekToolURL, searchWeb, WEB_SEARCH_LIMITS} from '../mindcraft/src/utils/deepseek_web_search.js';
import {DeepSeek} from '../mindcraft/src/models/deepseek.js';
import {enqueueModelRequest} from '../mindcraft/src/utils/model_request_queue.js';

process.env.DEEPSEEK_API_KEY = 'unit-web-search-key-123456';
const checks = [], wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}});
const item = n => ({title: `来源${n}`, url: `https://example.com/page-${n}`, date: '2026-10-22T00:00:00Z', summary: `搜索摘要${n}`});
const completion = {choices: [{finish_reason: 'stop', message: {content: '村民需要合适的床和食物。[1]'}}]};
const summary = async () => '中文综合结论。[1]';
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const [base, expected] of [['https://api.deepseek.com', 'https://api.deepseek.com/v1/tools/search'],
    ['https://api.deepseek.com/v1/', 'https://api.deepseek.com/v1/tools/search'],
    ['https://example.com/proxy/v1?secret=hidden', 'https://example.com/proxy/v1/tools/search']])
    assert.equal(deepSeekToolURL(base, 'search'), expected);
assert.throws(() => deepSeekToolURL('https://user:password@example.com', 'fetch'));
assert.equal(isAction('!webSearch'), false);
assert.ok(getCommandDocs({blocked_actions: []}).includes('!webSearch:'));
checks.push('tool registration; query does not acquire/cancel world action; root/v1 URL normalization');

// Exact two-stage protocol, bounded independent synthesis, dedup and complete API traces.
{
    const wire = [], events = []; let summaryInput, summarySystem;
    const client = new DeepSeekWebSearch({apiKey: process.env.DEEPSEEK_API_KEY, publish: e => events.push(e), fetch: async (url, options) => {
        const body = JSON.parse(options.body); wire.push({url, body});
        if (url.endsWith('/search')) return response({results: [item(1), item(1), {...item(2), url: 'file:///secret'}, item(3), item(4)]});
        return response({title: '读取后的标题', content: '正文资料'.repeat(6000)});
    }});
    const report = await client.search('Minecraft 村民繁殖', {summarize: async (messages, prompt) => {summaryInput = messages; summarySystem = prompt; return '结论'.repeat(3000);}});
    assert.equal(report.status, 'completed'); assert.equal(report.sources.length, 3);
    assert.equal(wire.length, 4); assert.deepEqual(wire[0].body, {query: 'Minecraft 村民繁殖', count: 5, need_content: false});
    for (const row of wire.slice(1)) assert.deepEqual(Object.keys(row.body), ['url']);
    const input = JSON.parse(summaryInput[0].content);
    assert.ok(input.sources.every(s => s.read && Array.from(s.content).length === 4000 && s.contentTruncated));
    assert.ok(summarySystem.includes('不可信资料'));
    assert.ok(Array.from(report.text).length <= 5000); assert.ok(report.text.includes('https://example.com/page-4'));
    assert.equal(events.length, 8); assert.equal(new Set(events.map(e => e.operationId)).size, 1);
    assert.equal(events[0].purpose, 'web-search-search'); assert.equal(events[2].purpose, 'web-search-fetch');
    assert.ok(!JSON.stringify(events).includes(process.env.DEEPSEEK_API_KEY));
    assert.equal(events[3].response.content.length, '正文资料'.repeat(6000).length, 'full response retained in API logs, bounded before synthesis');
    checks.push('Search then Fetch; dedup/invalid URLs; 3-page/4000-character input and 1500-character synthesis bounds; complete redacted traces');
}
// Empty, invalid and Unicode queries never create hidden synthesis requests.
{
    let calls = 0, summaries = 0;
    const client = new DeepSeekWebSearch({apiKey: 'test', publish: () => {}, fetch: async () => {calls++; return response({results: []});}});
    for (const query of ['', ' ', '🙂'.repeat(129)]) assert.equal((await client.search(query, {summarize: summary})).status, 'failed');
    assert.equal(calls, 0);
    const report = await client.search('🙂'.repeat(128), {summarize: async () => {summaries++;}});
    assert.equal(report.status, 'empty'); assert.equal(calls, 1); assert.equal(summaries, 0);
    checks.push('128 Unicode-character validation; empty results return without fetching or synthesis');
}
// A blocked page, timeout or bad schema cannot be mistaken for read content.
{
    let pages = 0, modelInput;
    const client = new DeepSeekWebSearch({apiKey: 'test', publish: () => {}, limits: {requestMs: 25}, fetch: async (url, options) => {
        if (url.endsWith('/search')) return response({results: [item(1), item(2), item(3)]});
        pages++;
        if (pages === 1) return response({error: {message: 'forbidden'}}, 403);
        if (pages === 2) return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true}));
        return response({content: '成功读到的正文'});
    }});
    // Timeout signals are unref'ed; keep the test fixture alive while awaiting it.
    const keepAlive = setInterval(() => {}, 1000);
    try {
        const report = await client.search('部分来源失败', {summarize: async messages => {modelInput = JSON.parse(messages[0].content); return '有限资料的结论。[3]';}});
        assert.equal(report.status, 'partial'); assert.equal(pages, 3);
        assert.deepEqual(modelInput.sources.map(s => s.read), [false, false, true]);
        assert.ok(report.text.includes('仅搜索摘要，正文未读取')); assert.ok(report.text.includes('超时'));
        assert.ok(report.text.includes('HTTP 403'));
    } finally {clearInterval(keepAlive);}
    const invalid = new DeepSeekWebSearch({apiKey: 'test', publish: () => {}, fetch: async () => response({not_results: []})});
    assert.equal((await invalid.search('无效协议')).status, 'failed');
    checks.push('403 does not retry; page timeout/invalid schema explicitly reported; partial sources continue');
}
// Only transient HTTP failures retry, with a shared operation ID.
{
    for (const status of [429, 503, 401, 402, 400]) {
        let calls = 0; const events = [];
        const client = new DeepSeekWebSearch({apiKey: 'test', publish: e => events.push(e), fetch: async () => {
            calls++; return calls === 1 ? response({error: {}}, status, {'retry-after': '.001'}) : response({results: []});
        }});
        const result = await client.search('重试规则');
        assert.equal(calls, [429, 503].includes(status) ? 2 : 1);
        assert.equal(result.status, calls === 2 ? 'empty' : 'failed');
        assert.equal(new Set(events.map(e => e.operationId)).size, 1);
    }
    checks.push('one retry for 429/5xx; no blind retries for auth/balance/invalid request errors');
}
// Synthesis failure preserves collected evidence without claiming a generated answer.
{
    const client = new DeepSeekWebSearch({apiKey: 'test', publish: () => {}, fetch: async url => response(url.endsWith('/search') ? {results: [item(1)]} : {content: '真实取得的网页正文'})});
    const report = await client.search('综合模型失败', {summarize: async () => {throw Error('fixture');}});
    assert.equal(report.status, 'partial'); assert.ok(report.text.includes('未生成综合结论')); assert.ok(report.text.includes('真实取得的网页正文'));
    checks.push('summary failure returns bounded collected evidence and explicit partial status');
}
// Real command entry + actual SDK synthesis share the bot's existing slot with chat.
{
    const originalFetch = globalThis.fetch, agents = [], allWire = [], active = {bot: 0, DeepSeek: 0}, peaks = {bot: 0, DeepSeek: 0};
    let total = 0, peakTotal = 0;
    try {
        for (const name of ['bot', 'DeepSeek']) {
            const agent = {name, responseEpoch: 0, blocked_actions: [], actions: {currentActionLabel: 'action:stay'},
                history: {memory: 'PRIVATE_MEMORY_SENTINEL', recordEvent() {}}};
            const transport = async (url, options) => {
                const body = JSON.parse(options.body); allWire.push({name, url: String(url), body});
                peaks[name] = Math.max(peaks[name], ++active[name]); peakTotal = Math.max(peakTotal, ++total);
                await wait(5); active[name]--; total--;
                return response(String(url).endsWith('/search') ? {results: [item(1)]} : String(url).endsWith('/fetch') ? {content: '村民繁殖需要合适的床和食物。'} : completion);
            };
            const model = new DeepSeek('deepseek-flash', 'https://api.deepseek.com/v1', {max_tokens: 2000}, {fetch: transport, publish: () => {}});
            agent.prompter = {chat_model: model}; agent.transport = transport; agents.push(agent);
        }
        // Web client is created synchronously before the first await, once per model.
        const work = [];
        for (const agent of agents) {
            globalThis.fetch = agent.transport;
            work.push(executeCommand(agent, '!webSearch("Minecraft 村民繁殖")', {origin: 'model'}));
            work.push(enqueueModelRequest(agent.prompter, () => agent.prompter.chat_model.sendRequest([], 'ordinary fixture request', undefined, {purpose: 'memory'})));
        }
        const reports = await Promise.all(work);
        assert.ok(reports[0].includes('村民需要')); assert.ok(reports[2].includes('村民需要'));
        assert.deepEqual(peaks, {bot: 1, DeepSeek: 1}); assert.equal(peakTotal, 2);
        for (const agent of agents) {
            assert.equal(agent.prompter.maxObservedModelRequests, 1); assert.equal(agent.prompter.activeModelRequests, 0);
            assert.equal(agent.actions.currentActionLabel, 'action:stay');
        }
        const summaries = allWire.filter(r => r.body.messages?.[0]?.content.includes('独立的联网资料整理模块'));
        assert.equal(summaries.length, 2);
        // The existing provider's strictFormat merges system + user into one
        // user message. Check its actual payload, rather than assuming 2 roles.
        assert.ok(summaries.every(r => r.body.messages.length === 1 && r.body.messages[0].content.includes('"question":"Minecraft 村民繁殖"') && !JSON.stringify(r.body).includes('PRIVATE_MEMORY_SENTINEL')));
        checks.push('actual command + SDK + two bots: HTTP peak per bot=1, cross-bot=2; no action interruption; no gameplay/history/memory in synthesis');
    } finally {globalThis.fetch = originalFetch;}
}
// Stop while queued suppresses every remaining stage and releases the queue.
{
    const agent = {name: 'Cancelled', responseEpoch: 0, prompter: {chat_model: new DeepSeek('deepseek-flash', undefined, {}, {fetch: async () => {throw Error('must not call');}, publish: () => {}})}};
    let release; const blocking = enqueueModelRequest(agent.prompter, () => new Promise(resolve => {release = resolve;}));
    const result = searchWeb(agent, '停止时丢弃'); await tick();
    agent.responseEpoch++; release('done'); await blocking;
    assert.match(await result, /已取消/); assert.equal(agent.prompter.activeModelRequests, 0);
    checks.push('stop invalidates queued network stages; no HTTP sent after cancellation');
}
// The optional abort signal reaches the SDK; no global model timeout was changed.
{
    let gotSignal = false;
    const model = new DeepSeek('deepseek-flash', undefined, {}, {publish: () => {}, fetch: async (_url, options) => {
        gotSignal = Boolean(options.signal);
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true}));
    }});
    const controller = new AbortController();
    const pending = assert.rejects(model.sendRequest([], 'fixture', undefined, {purpose: 'web-search-summary', signal: controller.signal}));
    await wait(5); controller.abort(); await pending; assert.equal(gotSignal, true);
    assert.equal(model.openai.timeout, 30000);
    checks.push('workflow cancellation reaches SDK HTTP transport; existing 30s chat timeout unchanged');
}
fs.writeFileSync(new URL('./web-search-test-result.json', import.meta.url), JSON.stringify({at: new Date().toISOString(), passed: true, limits: WEB_SEARCH_LIMITS, checks}, null, 2));
console.log(JSON.stringify({passed: true, checks}, null, 2));
