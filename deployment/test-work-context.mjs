import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {History} from '../mindcraft/src/agent/history.js';
import {selectWorkingContext, workingRoundCount} from '../mindcraft/src/agent/working_context.js';
import {ContextJournal} from '../mindcraft/src/agent/context_journal.js';
import {DeepSeek} from '../mindcraft/src/models/deepseek.js';
import {Prompter} from '../mindcraft/src/models/prompter.js';
import {Agent} from '../mindcraft/src/agent/agent.js';
import {SelfPrompter} from '../mindcraft/src/agent/self_prompter.js';
import {ModelRequestError, LEGACY_MODEL_FAILURE} from '../mindcraft/src/utils/model_failure.js';
import {setSettings} from '../mindcraft/src/agent/settings.js';
import convo from '../mindcraft/src/agent/conversation.js';

const root = path.dirname(fileURLToPath(import.meta.url)), previous = process.cwd();
const temporary = fs.mkdtempSync(path.join(root, 'work-context-test-'));
process.chdir(temporary); process.env.DEEPSEEK_API_KEY = 'unit-context-key';
setSettings({max_messages: 16, max_commands: -1, translate_messages: false});
const make = name => {
    const agent = {name, responseEpoch: 0, last_sender: null, task: {taskStartTime: 1},
        prompter: {promptMemSaving: async () => {throw Error('summary unavailable');}}};
    agent.self_prompter = new SelfPrompter(agent); agent.history = new History(agent); return agent;
};
const read = history => fs.readFileSync(history.journal.file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function round(history, index) {
    const id = history.beginRound({source: 'GGboy', content: `要求-${index}-结束`});
    await history.add('GGboy', `要求-${index}-结束`, {roundId: id});
    await history.add(history.name, `!command_${index}()`, {roundId: id});
    await history.add('system', `结果-${index}-结束`, {roundId: id});
    history.endRound(id); return id;
}
try {
    const legacy = [];
    for (let n = 0; n < 40; n++) legacy.push({role: 'user', content: `U${n}`}, {role: 'assistant', content: `A${n}`}, {role: 'system', content: `T${n}`});
    const selected = selectWorkingContext([...legacy, {role: 'user', content: '当前输入'}]);
    assert.equal(workingRoundCount(selected), 10); assert.equal(selected.length, 31);
    assert.equal(selected[0].content, 'U30'); assert.equal(selected.at(-1).content, '当前输入');
    for (let n = 30; n < 40; n++) assert.ok(selected.some(t => t.content === `A${n}`) && selected.some(t => t.content === `T${n}`));
    const oldPinned = selectWorkingContext(legacy.map((turn, i) => ({...turn, roundId: `p${Math.floor(i / 3)}`, currentRound: i === 0})));
    assert.equal(workingRoundCount(oldPinned), 10, 'Pinning an older in-flight round cannot create an eleventh replied round');

    const a = make('WindowBot'), h = a.history; h.memory = '保留的短期记忆'; let failures = 0;
    a.prompter.promptMemSaving = async () => {failures++; throw Error('summary unavailable');};
    const silent = console.log; console.log = () => {};
    try {for (let n = 0; n < 120; n++) await round(h, n);} finally {console.log = silent;}
    if (h.compactionPromise) await h.compactionPromise;
    assert.equal(failures, 1, 'Failed summaries back off instead of retrying on every message');
    assert.equal(h.memory, '保留的短期记忆'); assert.equal(workingRoundCount(h.turns), 10); assert.equal(h.turns.length, 30);
    assert.equal(JSON.parse(fs.readFileSync(h.memory_fp)).turns.length, 30);
    assert.equal(read(h).filter(e => e.kind === 'message').length, 360, 'Every old message stays in the append-only journal');
    assert.ok(h.turns.every(t => !t.content.includes('要求-0-结束')));
    const bytes = fs.readFileSync(h.journal.file), reloaded = new History(a); reloaded.load();
    assert.equal(workingRoundCount(reloaded.turns), 10); assert.deepEqual(fs.readFileSync(h.journal.file), bytes, 'Restart never re-appends or rewrites existing journal records');

    // An action finishing after many concurrent rounds restores its own command/result pair.
    const old = h.beginRound({source: 'GGboy', content: '未完成的旧动作'});
    await h.add('GGboy', '未完成的旧动作', {roundId: old}); await h.add(a.name, '!oldAction()', {roundId: old});
    console.log = () => {}; try {for (let n = 120; n < 140; n++) await round(h, n);} finally {console.log = silent;}
    await h.add('system', '旧动作终于完成', {roundId: old}); h.endRound(old);
    assert.ok(h.getHistory().some(t => t.content === '!oldAction()'));
    assert.ok(h.getHistory().some(t => t.content === '旧动作终于完成'));
    assert.equal(workingRoundCount(h.getHistory()), 10);
    const current = h.beginRound({source: 'GGboy', content: '当前还没有答复的请求'});
    const pending = h.getHistory({roundId: current}); assert.equal(pending[0].content, 'GGboy: 当前还没有答复的请求');
    assert.equal(workingRoundCount(pending), 10); h.endRound(current);

    // Migration keeps an archive of legacy pending messages and preserves the old goal.
    fs.mkdirSync('bots/LegacyBot', {recursive: true});
    fs.writeFileSync('bots/LegacyBot/memory.json', JSON.stringify({memory: '旧摘要', turns: legacy, self_prompting_state: 1, self_prompt: '继续生存'}));
    const migrated = make('LegacyBot').history; migrated.load();
    assert.equal(read(migrated).length, 120); assert.equal(workingRoundCount(migrated.turns), 10);
    assert.equal(JSON.parse(fs.readFileSync(migrated.memory_fp)).self_prompt, '继续生存');
    const migratedBytes = fs.readFileSync(migrated.journal.file); make('LegacyBot').history.load();
    assert.deepEqual(fs.readFileSync(migrated.journal.file), migratedBytes);

    // A large permanent log is read a batch at a time using a durable byte cursor.
    const journal = new ContextJournal('BatchBot');
    for (let n = 0; n < 180; n++) journal.append('message', {role: 'user', content: `中文消息${n}`, roundId: `r${n}`});
    let offset = 0, recovered = [];
    while (offset < journal.end) {const b = journal.readBatch(offset, {maxMessages: 23}); assert.ok(b.events.length <= 23); recovered.push(...b.events); assert.ok(b.nextOffset > offset); offset = b.nextOffset;}
    assert.equal(recovered.length, 180); assert.equal(recovered.at(-1).content, '中文消息179');

    // Backlog is summarized from the journal in bounded batches while new input
    // remains immediately usable, and restart resumes from the saved byte offset.
    const summarizing = make('SummaryBot'); let finishSummary, summaryCalls = 0, summarizedMessages = 0;
    summarizing.prompter.promptMemSaving = async turns => {
        summaryCalls++; summarizedMessages += turns.length;
        assert.ok(turns.length <= 50);
        if (summaryCalls === 1) return await new Promise(resolve => {finishSummary = resolve;});
        return '归纳后的短期记忆';
    };
    console.log = () => {};
    try {for (let n = 0; n < 60; n++) await round(summarizing.history, n);} finally {console.log = silent;}
    assert.ok(finishSummary); assert.equal(summaryCalls, 1);
    assert.equal(workingRoundCount(summarizing.history.turns), 10);
    finishSummary('第一批短期记忆'); await summarizing.history.compactionPromise; await tick();
    assert.equal(summaryCalls, 1, 'A backlog does not run another batch immediately');
    assert.ok(summarizing.history.nextSummaryRunAt >= Date.now() + 59000);
    // Advance the maintenance eligibility explicitly; do not wait real minutes.
    while (summarizing.history.summaryPending >= 16) {
        summarizing.history.nextSummaryRunAt = 0;
        await summarizing.history.maintainSummary();
    }
    assert.ok(summaryCalls > 1 && summaryCalls < 10);
    assert.ok(summarizing.history.summaryPending < 16);
    assert.equal(summarizedMessages + summarizing.history.summaryPending, 180);
    const checkpoint = summarizing.history.summaryCursor;
    const summaryReload = new History(summarizing); summaryReload.load();
    assert.equal(summaryReload.summaryCursor, checkpoint);
    assert.equal(summaryReload.summaryPending, summarizing.history.summaryPending);
    assert.equal(read(summaryReload).length, 180);
    const beforeFailedAppend = structuredClone(h.turns), append = h.journal.append;
    h.journal.append = () => {throw Error('disk unavailable');};
    await assert.rejects(h.add('GGboy', '不能在归档失败时丢掉旧窗口'), /disk unavailable/);
    assert.deepEqual(h.turns, beforeFailedAppend);
    h.journal.append = append;

    // Exercise the actual SDK request: even a caller passing full legacy history is bounded.
    let wire, requests = 0;
    const completion = {id: 'unit', model: 'deepseek-flash', choices: [{message: {role: 'assistant', content: '已收到'}, finish_reason: 'stop'}], usage: {prompt_tokens: 1, completion_tokens: 1}};
    const sdk = new DeepSeek('deepseek-flash', 'https://api.deepseek.com', {}, {fetch: async (_url, options) => {requests++; wire = JSON.parse(options.body); return new Response(JSON.stringify(completion), {status: 200, headers: {'content-type': 'application/json'}});}, publish() {}});
    await sdk.sendRequest(legacy, '系统提示');
    assert.equal(wire.messages.filter(m => m.role === 'assistant').length, 10);
    assert.ok(!JSON.stringify(wire).includes('U0')); assert.ok(JSON.stringify(wire).includes('U30'));
    assert.ok(wire.messages.every(m => Object.keys(m).every(k => ['role', 'content'].includes(k))));
    const failed = new DeepSeek('deepseek-flash', 'https://api.deepseek.com', {}, {fetch: async () => {requests++; return new Response(JSON.stringify({error: {message: 'Insufficient Balance'}}), {status: 402, headers: {'content-type': 'application/json'}});}, publish() {}});
    const beforeFailure = requests;
    await assert.rejects(failed.sendRequest([], '测试'), ModelRequestError);
    await assert.rejects(failed.sendRequest([], '测试摘要', undefined, {purpose: 'memory'}), ModelRequestError);
    assert.equal(requests, beforeFailure + 1, 'Billing failures open a short circuit shared by conversation and summary requests');

    const runner = make('RuntimeBot'); let chats = 0;
    Object.assign(runner, {shut_up: false, checkTaskDone: async () => {}, bot: {modes: {flushBehaviorLog: () => ''}}, routeResponse: () => {chats++;}, isIdle: () => true});
    runner.prompter = Object.assign(Object.create(Prompter.prototype), {agent: runner, profile: {conversing: 'base'}, convo_examples: null, checkCooldown: async () => {}, replaceStrings: async x => x, applyMemoryContext: x => x, _saveLog: async () => {}, requestModel: async () => {throw new ModelRequestError('余额不足', 402);}});
    await Agent.prototype.handleMessage.call(runner, 'GGboy', '请看看周围');
    assert.equal(chats, 0); assert.ok(!runner.history.turns.some(t => t.role === 'assistant'));
    assert.ok(read(runner.history).some(e => e.kind === 'model-request-failed'));
    let delivered = 0; runner.handleMessage = async () => {delivered++;};
    convo.initAgent(runner); convo.updateAgents([{name: 'RuntimeBot', in_game: true}, {name: 'DeepSeek', in_game: true}]);
    await convo.observePublicChat('DeepSeek', LEGACY_MODEL_FAILURE);
    await convo.receiveFromBot('DeepSeek', {message: LEGACY_MODEL_FAILURE, start: true, end: false});
    await convo.observePublicChat('DeepSeek', '!stats');
    await convo.observePublicChat('DeepSeek', '先歇着。 !stay(120)');
    await convo.observePublicChat('DeepSeek', '先歇着。 !stay(120)');
    assert.equal(delivered, 0); assert.equal(read(runner.history).filter(e => e.kind === 'peer-message-ignored').length, 3);
    assert.equal(read(runner.history).filter(e => e.kind === 'message' && e.content.includes('[队友等待状态，')).length, 2,
        'Peer stays are retained as context without dispatch, including repeated announcements');
    console.log = () => {}; try {for (let n = 0; n < 150; n++) await convo.observePublicChat('DeepSeek', `自由聊天${n}`);} finally {console.log = silent;}
    assert.equal(delivered, 150, 'Normal communication has no round/count cap');
    const beforeClear = fs.readFileSync(h.journal.file); h.clear(); await h.save();
    assert.ok(fs.readFileSync(h.journal.file).subarray(0, beforeClear.length).equals(beforeClear), 'Clear only resets the window, never deletes journal history');
    assert.equal(JSON.parse(fs.readFileSync(h.memory_fp)).turns.length, 0);
    console.log('PASS: 10 complete rounds plus current input, permanent append-only journal, bounded API payload after summary failure, byte-cursor batches, restart/migration, concurrent command-result association, typed failures without chat echo, passive-status filtering and unrestricted normal peer conversation.');
} finally {
    process.chdir(previous); assert.equal(path.dirname(temporary), root); fs.rmSync(temporary, {recursive: true, force: true});
}
