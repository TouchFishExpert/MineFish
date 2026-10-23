import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Doubao, DOUBAO_MODEL, DOUBAO_BASE_URL} from '../mindcraft/src/models/doubao.js';
import {selectAPI, createModel} from '../mindcraft/src/models/_model_map.js';
import {Prompter} from '../mindcraft/src/models/prompter.js';
import {ModelRequestError} from '../mindcraft/src/utils/model_failure.js';

process.env.ARK_API_KEY = 'unit-ark-private-key';
const sent = [], events = [], checks = [];
const completion = text => new Response(JSON.stringify({id: 'unit-doubao', model: DOUBAO_MODEL,
    choices: [{finish_reason: 'stop', message: {role: 'assistant', content: text, reasoning_content: '完整映射字段'}}],
    usage: {prompt_tokens: 10, completion_tokens: 3, total_tokens: 13}}), {headers: {'content-type': 'application/json'}});
const provider = new Doubao(null, null, {temperature: 0.3}, {publish: event => events.push(event), fetch: async (url, init) => {
    sent.push({url: String(url), body: JSON.parse(init.body), key: new Headers(init.headers).get('authorization')});
    return completion('豆包队友已就绪。***不应交给游戏的尾部');
}});
const history = Array.from({length: 35}, (_, n) => [
    {role: 'user', content: `要求${n}`, roundId: `r${n}`}, {role: 'assistant', content: `答复${n}`, roundId: `r${n}`}]).flat();
const original = JSON.stringify(history);
assert.equal(await provider.sendRequest(history, '中文系统提示词'), '豆包队友已就绪。');
assert.equal(sent[0].url, DOUBAO_BASE_URL + '/chat/completions');
assert.equal(sent[0].body.model, DOUBAO_MODEL);
assert.equal(sent[0].key, 'Bearer unit-ark-private-key');
assert.equal(sent[0].body.max_tokens, 2000);
assert.deepEqual(sent[0].body.thinking, {type: 'disabled'});
assert.equal(sent[0].body.stream, false);
assert.equal(sent[0].body.stop, undefined);
assert.deepEqual(sent[0].body.messages[0], {role: 'system', content: '中文系统提示词'});
assert.equal(sent[0].body.messages.filter(message => message.role === 'assistant').length, 10);
assert.ok(sent[0].body.messages.some(message => message.content === '要求25'));
assert.ok(!sent[0].body.messages.some(message => message.content === '要求24'));
assert.ok(sent[0].body.messages.every(message => Object.keys(message).every(key => ['role', 'content'].includes(key))));
assert.equal(JSON.stringify(history), original);
assert.ok(events.some(event => event.phase === 'response' && event.response.choices[0].message.reasoning_content === '完整映射字段'));
assert.ok(!JSON.stringify(events).includes(process.env.ARK_API_KEY));
checks.push('real SDK wire endpoint, independent Ark credential, disabled thinking, 2000-token output, native system role, last-ten-round window, stripped metadata, full redacted response traces and local stop delimiter');

const owner = {};
const summaryInput = Array.from({length: 30}, (_, n) => ({role: 'user', content: `摘要输入${n}`}));
await Prompter.prototype.requestModel.call(owner, provider, summaryInput, '维护短期记忆', 'memory');
assert.equal(sent.at(-1).body.messages.length, 31, 'Memory maintenance is not silently cut to ten recent inputs');
assert.equal(events.filter(event => event.phase === 'request').at(-1).purpose, 'memory');
assert.equal(owner.maxObservedModelRequests, 1);
checks.push('Prompter passes memory purpose through Doubao and retains the full bounded summary batch with the shared per-bot API queue');

const selected = selectAPI({api: 'doubao', model: DOUBAO_MODEL, url: DOUBAO_BASE_URL});
const discovered = createModel(selected);
assert.ok(discovered instanceof Doubao);
const requestsBeforeEmbed = sent.length;
await assert.rejects(provider.embed('测试'), /词重合度/);
assert.equal(sent.length, requestsBeforeEmbed);
checks.push('provider factory discovers doubao; embeddings intentionally use the existing local word-overlap fallback without a second API');

let failedRequests = 0;
const failures = [], originalError = console.error;
console.error = (...values) => failures.push(values.join(' '));
try {
    const denied = new Doubao(null, null, {}, {publish: event => events.push(event), fetch: async () => {
        failedRequests++;
        return new Response(JSON.stringify({error: {message: `Invalid key ${process.env.ARK_API_KEY}`}}),
            {status: 401, headers: {'content-type': 'application/json'}});
    }});
    await assert.rejects(denied.sendRequest([], '测试'), error => error instanceof ModelRequestError && error.status === 401
        && !error.message.includes(process.env.ARK_API_KEY));
    await assert.rejects(denied.sendRequest([], '再次测试'), ModelRequestError);
    assert.equal(failedRequests, 1, 'Authentication failure backs off instead of repeatedly calling');
    assert.ok(!JSON.stringify(failures).includes(process.env.ARK_API_KEY));
    assert.ok(!JSON.stringify(events).includes(process.env.ARK_API_KEY));
} finally {console.error = originalError;}
checks.push('typed, redacted authentication failure and 60-second circuit prevent repeated invalid calls');

const result = {at: new Date().toISOString(), passed: true, checks};
fs.writeFileSync(new URL('./doubao-provider-test-result.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
