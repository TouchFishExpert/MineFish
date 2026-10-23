import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Prompter} from '../mindcraft/src/models/prompter.js';
import {DeepSeek} from '../mindcraft/src/models/deepseek.js';
import {setSettings} from '../mindcraft/src/agent/settings.js';
import {enqueueModelRequest} from '../mindcraft/src/utils/model_request_queue.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = (p, model, purpose = 'conversation', extra = {}) => Prompter.prototype.requestModel.call(p, model, [], 'test', purpose, extra);
const checks = [];

// Separate model instances and all request purposes share one bot-local slot.
{
    const p = {}, starts = [], finishes = []; let active = 0, peak = 0;
    const model = {sendRequest: () => new Promise(resolve => {
        starts.push('text'); peak = Math.max(peak, ++active); finishes.push(() => {active--; resolve('ok');});
    }), sendVisionRequest: () => new Promise(resolve => {
        starts.push('vision'); peak = Math.max(peak, ++active); finishes.push(() => {active--; resolve('image');});
    })};
    const jobs = ['conversation', 'memory', 'memory-compaction', 'coding', 'planning', 'vision'].map(purpose => request(p, {...model}, purpose));
    assert.equal(starts.length, 1); assert.equal(p.activeModelRequests, 1); assert.equal(p.queuedModelRequests, 5);
    for (let i = 0; i < jobs.length; i++) {assert.equal(starts.length, i + 1); finishes[i](); await jobs[i]; await tick();}
    assert.equal(peak, 1); assert.equal(p.maxObservedModelRequests, 1); assert.equal(p.queuedModelRequests, 0); assert.equal(p.activeModelRequests, 0);
    assert.equal(starts.at(-1), 'vision'); checks.push('all purposes and separate provider objects: peak=1');
}
{
    const p = {}; let rejectFirst;
    const first = request(p, {sendRequest: () => new Promise((_, reject) => {rejectFirst = reject;})});
    const failure = assert.rejects(first, /fixture-failure/);
    const next = request(p, {sendRequest: async () => 'recovered'}, 'memory');
    rejectFirst(new Error('fixture-failure')); await failure; assert.equal(await next, 'recovered');
    assert.equal(p.activeModelRequests, 0); assert.equal(p.queuedModelRequests, 0);
    let entered = false;
    assert.equal(await request(p, {sendRequest: async () => {entered = true;}}, 'conversation', {isCurrent: () => false}), '');
    assert.equal(entered, false); checks.push('failure releases slot; invalidated queued request never reaches provider');
}
// Real conversation generation checks queued freshness independently for human
// and peer input; a superseded human input does not consume another API call.
{
    const sent = []; let release;
    const p = Object.assign(Object.create(Prompter.prototype), {agent: {name: 'fixture', responseEpoch: 0},
        profile: {conversing: 'role'}, checkCooldown: async () => {}, replaceStrings: async p => p,
        applyMemoryContext: p => p, _saveLog: async () => {},
        chat_model: {sendRequest: async messages => {sent.push(messages.at(-1).content); return 'done';}}});
    const blocking = enqueueModelRequest(p, () => new Promise(resolve => {release = resolve;}));
    const old = p.promptConvo([{role: 'user', content: 'old'}]); await tick();
    const latest = p.promptConvo([{role: 'user', content: 'latest'}]); await tick();
    const peer = p.promptConvo([{role: 'user', content: 'peer'}], {priority: true}); await tick();
    assert.equal(p.queuedModelRequests, 3); assert.deepEqual(sent, []);
    release('ok'); await blocking;
    assert.equal(await old, ''); assert.equal(await latest, 'done'); assert.equal(await peer, 'done');
    assert.deepEqual(sent, ['latest', 'peer']); assert.equal(p.maxObservedModelRequests, 1);
    checks.push('queued stale generation skipped; human/peer lanes preserved, no reply-count cap');
}
// Constructor wiring ensures embedding selection cannot bypass the same slot.
{
    const root = path.dirname(fileURLToPath(import.meta.url)), cwd = process.cwd();
    const temp = fs.mkdtempSync(path.join(root, 'api-queue-test-'));
    const originalEmbed = DeepSeek.prototype.embed; process.chdir(temp);
    try {
        process.env.DEEPSEEK_API_KEY = 'unit-queue-key'; setSettings({base_profile: 'survival'});
        let finishEmbedding, generated = false;
        DeepSeek.prototype.embed = () => new Promise(resolve => {finishEmbedding = resolve;});
        const p = new Prompter({name: 'QueueFixture'}, {name: 'QueueFixture', model: {api: 'deepseek', model: 'deepseek-chat'}, embedding: 'deepseek'});
        DeepSeek.prototype.embed = originalEmbed;
        const embedding = p.embedding_model.embed('text');
        const convo = p.requestModel({sendRequest: async () => {generated = true; return 'ok';}}, [], 'test', 'conversation');
        assert.equal(generated, false); assert.equal(p.activeModelRequests, 1); assert.equal(p.queuedModelRequests, 1);
        finishEmbedding([1, 0]); await embedding; assert.equal(await convo, 'ok');
        assert.equal(p.maxObservedModelRequests, 1); checks.push('embedding constructor path shares conversation queue');
    } finally {
        DeepSeek.prototype.embed = originalEmbed; process.chdir(cwd);
        assert.equal(path.dirname(temp), root); fs.rmSync(temp, {recursive: true, force: true});
    }
}
// Actual OpenAI SDK HTTP retries retain the bot slot. Two bots still overlap.
{
    const p = {}, q = {}, active = {bot: 0, DeepSeek: 0}, peaks = {bot: 0, DeepSeek: 0};
    const attempts = {bot: 0, DeepSeek: 0}; let total = 0, globalPeak = 0;
    const model = name => new DeepSeek('deepseek-flash', 'https://api.deepseek.com', {}, {publish: () => {}, fetch: async () => {
        peaks[name] = Math.max(peaks[name], ++active[name]); globalPeak = Math.max(globalPeak, ++total);
        await delay(20); active[name]--; total--; attempts[name]++;
        const retry = name === 'bot' && attempts[name] === 1;
        return new Response(JSON.stringify(retry ? {error: {message: 'retry fixture'}} : {id: 'queue', choices: [{finish_reason: 'stop', message: {content: 'ok'}}]}),
            {status: retry ? 503 : 200, headers: {'content-type': 'application/json', 'retry-after-ms': '1'}});
    }});
    const a = model('bot'), b = model('DeepSeek');
    await Promise.all([request(p, a), request(p, a, 'memory'), request(p, a, 'vision', {imageBuffer: null}).catch(() => {}), request(q, b), request(q, b, 'memory-compaction')]);
    assert.deepEqual(peaks, {bot: 1, DeepSeek: 1}); assert.equal(globalPeak, 2); assert.equal(attempts.bot, 3);
    assert.equal(p.maxObservedModelRequests, 1); assert.equal(q.maxObservedModelRequests, 1);
    checks.push('actual SDK retry peak per bot=1; two bots HTTP peak=2');
}
// Fresh state is sampled at dispatch after waiting, and exact prompt logging
// receives that prepared value, rather than the earlier queued snapshot.
{
    const p = {agent: {name: 'fresh-at-send'}}; let release;
    const blocking = enqueueModelRequest(p, () => new Promise(resolve => {release = resolve;}));
    let sentPrompt, prepared;
    const waiting = request(p, {sendRequest: async (_messages, prompt) => {sentPrompt = prompt; return 'ok';}}, 'conversation', {onPrepared: prompt => {prepared = prompt;}});
    p.agent.name = 'updated-while-queued'; release('ok'); await blocking; await waiting;
    assert.ok(sentPrompt.includes('updated-while-queued')); assert.ok(!sentPrompt.includes('fresh-at-send'));
    assert.equal(sentPrompt, prepared); checks.push('runtime observation prepared at send, not enqueue; exact prompt callback');
}
fs.writeFileSync(new URL('./model-request-queue-test-result.json', import.meta.url), JSON.stringify({at: new Date().toISOString(), passed: true, checks}, null, 2));
console.log(JSON.stringify({passed: true, checks}, null, 2));
