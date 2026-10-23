import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../mindcraft/src/agent/agent.js';
import {searchWeb, getWebSearchState, WEB_SEARCH_LIMITS} from '../mindcraft/src/utils/deepseek_web_search.js';
import {getKey} from '../mindcraft/src/utils/keys.js';
import {Doubao} from '../mindcraft/src/models/doubao.js';
import {Prompter} from '../mindcraft/src/models/prompter.js';
import {enqueueModelRequest} from '../mindcraft/src/utils/model_request_queue.js';
import {captureRuntimeState} from '../mindcraft/src/agent/runtime_observation.js';

process.env.DEEPSEEK_API_KEY ||= 'unit-search-secret';
process.env.ARK_API_KEY ||= 'unit-ark-secret';
const checks = [], originalFetch = globalThis.fetch;
const gate = () => {let release; const promise = new Promise(resolve => {release = resolve;}); return {promise, release};};
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
const item = {title: '测试资料', url: 'https://example.com/source', summary: '搜索摘要'};
const completion = text => ({choices: [{finish_reason: 'stop', message: {content: text}}]});
const waitFor = async predicate => {
    for (let n = 0; n < 500; n++) {if (predicate()) return; await tick();}
    throw Error('Fixture stage did not arrive');
};
try {
    const wire = [], events = [], gates = {search: gate(), fetch: gate(), summary: gate()};
    let active = 0, peak = 0, finished = false;
    const transport = async (url, options) => {
        url = String(url); const body = JSON.parse(options.body);
        const tool = url.endsWith('/search') ? 'search' : url.endsWith('/fetch') ? 'fetch'
            : body.messages[0].content.includes('独立的联网资料整理模块') ? 'summary' : 'conversation';
        wire.push({url, body, tool}); peak = Math.max(peak, ++active);
        const authorization = new Headers(options.headers).get('authorization');
        if (['search', 'fetch'].includes(tool)) {
            assert.equal(new URL(url).host, 'api.deepseek.com');
            assert.equal(authorization, `Bearer ${getKey('DEEPSEEK_API_KEY')}`);
            assert.notEqual(authorization, `Bearer ${getKey('ARK_API_KEY')}`);
        } else {
            assert.equal(new URL(url).host, 'ark.cn-beijing.volces.com');
            assert.equal(authorization, `Bearer ${getKey('ARK_API_KEY')}`);
        }
        if (gates[tool]) await gates[tool].promise;
        active--;
        return response(tool === 'search' ? {results: [item]} : tool === 'fetch' ? {content: '真实读取的正文，仅用于独立整理。'}
            : completion(tool === 'summary' ? '中文搜索结论。[1]' : '已看到工具状态。'));
    };
    globalThis.fetch = transport;
    const model = new Doubao(undefined, undefined, undefined, {fetch: transport, publish: e => events.push(e)});
    const agent = {name: 'DouBaoFixture', responseEpoch: 0,
        history: {memory: 'PRIVATE_MEMORY_SENTINEL', recordEvent: (kind, result) => events.push({kind, result})}};
    const prompter = Object.assign(Object.create(Prompter.prototype), {agent, chat_model: model});
    agent.prompter = prompter;
    assert.equal(getWebSearchState(agent).status, 'idle');
    const blockerGate = gate();
    const blocker = enqueueModelRequest(prompter, () => blockerGate.promise);
    const first = searchWeb(agent, '测试豆包联网').then(value => {finished = true; return value;});
    const duplicate = searchWeb(agent, '  测试豆包联网  ');
    assert.equal(getWebSearchState(agent).requestState, 'queued'); assert.equal(wire.length, 0);
    assert.match(await searchWeb(agent, '另一个问题'), /本次没有重复启动/);
    assert.equal(finished, false);
    blockerGate.release(); await blocker;
    await waitFor(() => wire.some(row => row.tool === 'search'));
    assert.equal(captureRuntimeState(agent).tools.webSearch.requestState, 'requesting');
    assert.equal(getWebSearchState(agent).phase, 'search'); assert.equal(finished, false);
    gates.search.release(); await waitFor(() => wire.some(row => row.tool === 'fetch'));
    assert.equal(getWebSearchState(agent).phase, 'fetch'); assert.equal(getWebSearchState(agent).page, 1);
    // This actual chat request waits behind Fetch, then observes live tool state
    // at dispatch. It must not accidentally include webpage bodies or memory.
    const chat = prompter.requestModel(model, [], '观察当前状态', 'conversation');
    gates.fetch.release(); await waitFor(() => wire.some(row => row.tool === 'summary'));
    assert.equal(await chat, '已看到工具状态。');
    const chatWire = wire.find(row => row.tool === 'conversation');
    const live = JSON.parse(chatWire.body.messages[0].content.split('\n').at(-1)).tools.webSearch;
    assert.equal(live.running, true); assert.equal(live.operationId, getWebSearchState(agent).operationId);
    assert.equal(live.phase, 'fetch'); assert.equal(live.requestState, 'received');
    assert.ok(!JSON.stringify(chatWire.body).includes('真实读取的正文'));
    assert.equal(getWebSearchState(agent).phase, 'summary'); assert.equal(finished, false);
    gates.summary.release();
    const result = await first;
    assert.equal(await duplicate, result); assert.match(result, /中文搜索结论/);
    assert.match(result, /https:\/\/example.com\/source/);
    assert.deepEqual(wire.map(row => row.tool), ['search', 'fetch', 'conversation', 'summary']);
    assert.equal(peak, 1); assert.equal(prompter.maxObservedModelRequests, 1);
    assert.equal(getWebSearchState(agent).status, 'completed'); assert.equal(getWebSearchState(agent).running, false);
    assert.equal(getWebSearchState(agent).sourceCount, 1); assert.ok(Number.isFinite(getWebSearchState(agent).durationMs));
    const synthesis = wire.find(row => row.tool === 'summary').body;
    assert.ok(!JSON.stringify(synthesis).includes('PRIVATE_MEMORY_SENTINEL'));
    assert.equal(synthesis.model, model.model_name); assert.equal(model.openai.timeout, 30000);
    assert.ok(!JSON.stringify(events).includes(getKey('ARK_API_KEY')));
    checks.push('Doubao chat uses Ark while Search/Fetch use DeepSeek with separate credentials; original call awaits final Chinese result');
    checks.push('actual queued/requesting/received/fetch/summary state; state reaches next real SDK payload without page/history duplication');
    checks.push('duplicate query shares final text; different query returns busy without dispatch; per-bot API peak remains one; no timeout changes');

    // Fatal errors clear running, permit a new search, and retain truthful status.
    let calls = 0;
    globalThis.fetch = async () => {calls++; return response({}, 401);};
    const failure = {name: 'Failure', responseEpoch: 0, prompter: {chat_model: model}};
    assert.match(await searchWeb(failure, '认证失败'), /HTTP 401/);
    assert.equal(getWebSearchState(failure).running, false); assert.equal(getWebSearchState(failure).status, 'failed');
    await searchWeb(failure, '再次尝试'); assert.equal(calls, 2);
    assert.equal(getWebSearchState(agent).status, 'completed', 'Different bot states are isolated');
    checks.push('failure releases search job, retry is possible, and other bot status stays isolated');

    globalThis.fetch = async () => {throw Error('Cancelled fixture must not reach network');};
    const stopped = {name: 'Stopped', responseEpoch: 0, prompter: {chat_model: model}};
    const stopGate = gate(); const blocked = enqueueModelRequest(stopped.prompter, () => stopGate.promise);
    const cancelled = searchWeb(stopped, '已停止的搜索'); stopped.responseEpoch++;
    stopGate.release(); await blocked;
    assert.match(await cancelled, /已取消/); assert.equal(getWebSearchState(stopped).status, 'cancelled');
    assert.equal(getWebSearchState(stopped).running, false);
    assert.equal(WEB_SEARCH_LIMITS.requestMs, 12000); assert.equal(WEB_SEARCH_LIMITS.workflowMs, 60000);
    checks.push('stop cancels queued work, updates truthful final status, and leaves no running task');
} finally {globalThis.fetch = originalFetch;}
const report = {at: new Date().toISOString(), passed: true, checks};
fs.writeFileSync(new URL('./web-search-provider-state-test-result.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
