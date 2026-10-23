import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {History} from '../mindcraft/src/agent/history.js';
import {Prompter} from '../mindcraft/src/models/prompter.js';
import {setSettings} from '../mindcraft/src/agent/settings.js';
import {SUMMARY_COMPACT_TRIGGER, SUMMARY_COMPACT_TARGET, memoryRevision} from '../mindcraft/src/agent/memory_edit.js';
const root = path.dirname(fileURLToPath(import.meta.url));
const temporary = fs.mkdtempSync(path.join(root, 'summary-threshold-'));
const previous = process.cwd(); process.chdir(temporary);
setSettings({max_messages: 100});
let sequence = 0;
function make() {
    const agent = {name: 'T' + ++sequence, responseEpoch: 0, self_prompter: {state: 1, prompt: '自由活动', isStopped: () => false},
        task: {taskStartTime: 1}, prompter: {promptMemSaving: async () => '正常摘要'}};
    agent.history = new History(agent); return agent;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle(history) {
    for (let i = 0; i < 8; i++) {if (history.compactionPromise) await history.compactionPromise; await tick(); if (!history.compactionPromise) return;}
    throw Error('Compression did not settle');
}
try {
    assert.equal(SUMMARY_COMPACT_TRIGGER, 2400); assert.equal(SUMMARY_COMPACT_TARGET, 2000);
    const below = make(); let calls = 0;
    below.prompter.promptSummaryCompression = async () => {calls++; return '压缩摘要';};
    below.history.memory = '字'.repeat(2399); await below.history.add('GGboy', '你好'); await tick(); assert.equal(calls, 0);

    const threshold = make(); let release;
    threshold.history.memory = '事实：家在(1,63,2)。' + '旧'.repeat(2400 - '事实：家在(1,63,2)。'.length);
    const original = threshold.history.memory;
    threshold.prompter.promptSummaryCompression = input => {calls++; assert.equal(input, original); return new Promise(resolve => {release = resolve;});};
    fs.writeFileSync(`bots/${threshold.name}/manual-memory.json`, 'owner-only-unchanged');
    await threshold.history.add('GGboy', '新增消息'); await tick();
    assert.ok(release && threshold.history.compactionPromise, 'Player message returns before background compression finishes');
    assert.equal(threshold.history.memory, original);
    await threshold.history.add('GGboy', '压缩期间的新消息');
    release('家在(1,63,2)；保留当前任务和玩家要求。'); await settle(threshold.history);
    assert.equal(threshold.history.memory, '家在(1,63,2)；保留当前任务和玩家要求。');
    assert.equal(threshold.history.turns.length, 2, 'Summary-only compression cannot remove conversation turns');
    assert.equal(fs.readFileSync(`bots/${threshold.name}/manual-memory.json`, 'utf8'), 'owner-only-unchanged');
    const saved = JSON.parse(fs.readFileSync(threshold.history.memory_fp));
    const backup = JSON.parse(fs.readFileSync(`bots/${threshold.name}/memory-backups/${saved.memory_meta.lastBackup}`));
    assert.equal(backup.memory, original); assert.equal(saved.memory_meta.truncated, false);

    const oversized = make(); let shrinks = 0;
    oversized.prompter.promptMemSaving = async () => '长'.repeat(2600) + '必须保留的尾部事实';
    oversized.prompter.promptSummaryCompression = async input => {shrinks++; assert.ok(input.endsWith('必须保留的尾部事实')); return '重新归纳，仍保留必须保留的尾部事实';};
    assert.equal(await oversized.history.summarizeMemories([]), true);
    assert.equal(shrinks, 1); assert.equal(oversized.history.memory, '重新归纳，仍保留必须保留的尾部事实');

    const fail = make(); fail.history.memory = '原'.repeat(2500); fail.history.turns = [{role: 'user', content: '未处理对话'}];
    let failures = 0; fail.prompter.promptSummaryCompression = async () => {failures++; return '仍'.repeat(2400);};
    await fail.history.compactSummaryIfNeeded('test');
    assert.equal(failures, 2); assert.equal(fail.history.memory, '原'.repeat(2500)); assert.equal(fail.history.turns.length, 1);
    await fail.history.add('GGboy', '下一条消息'); assert.equal(failures, 2, 'Failed output cannot cause an API storm');
    assert.equal(fail.history.summaryCompression.state, 'failed');
    fail.prompter.promptMemSaving = async () => '正常摘要也成功释放空间';
    await fail.history.summarizeMemories([]);
    assert.equal(fail.history.summaryCompression.state, 'completed');
    assert.equal(fail.history.summaryCompression.error, undefined);
    const empty = make(); empty.history.memory = '原'.repeat(2400); empty.prompter.promptSummaryCompression = async () => '';
    await empty.history.compactSummaryIfNeeded(); assert.equal(empty.history.memory.length, 2400);

    const stale = make(); stale.history.memory = '旧'.repeat(2400); let completeOld;
    stale.prompter.promptSummaryCompression = () => new Promise(resolve => {completeOld = resolve;});
    const job = stale.history.compactSummaryIfNeeded(); await tick();
    stale.history.editMemory({summary: '用户手动修改的最新内容', baseRevision: memoryRevision(stale.history.memory)});
    completeOld('过时压缩'); await job;
    assert.equal(stale.history.memory, '用户手动修改的最新内容');

    const newFullEdit = make(); newFullEdit.history.memory = '旧'.repeat(2400); let resolveFirst, attempts = 0;
    newFullEdit.prompter.promptSummaryCompression = input => {
        if (++attempts === 1) return new Promise(resolve => {resolveFirst = resolve;});
        assert.equal(input, '新'.repeat(2450)); return Promise.resolve('用户新内容的压缩结果');
    };
    newFullEdit.history.compactSummaryIfNeeded(); await tick();
    newFullEdit.history.editMemory({summary: '新'.repeat(2450), baseRevision: memoryRevision(newFullEdit.history.memory)});
    resolveFirst('不能覆盖新内容的旧结果'); await settle(newFullEdit.history);
    assert.equal(newFullEdit.history.memory, '用户新内容的压缩结果'); assert.equal(attempts, 2);

    const cleared = make(); cleared.history.memory = '旧'.repeat(2400); let resolveClear;
    cleared.prompter.promptSummaryCompression = () => new Promise(resolve => {resolveClear = resolve;});
    const clearJob = cleared.history.compactSummaryIfNeeded(); await tick(); cleared.history.clear(); resolveClear('旧结果'); await clearJob;
    assert.equal(cleared.history.memory, '');

    const atomic = make(); atomic.history.memory = '必须保留的原文';
    fs.mkdirSync(`bots/${atomic.name}/blocked`); atomic.history.memory_fp = `bots/${atomic.name}/blocked`;
    assert.throws(() => atomic.history.commitSummary('新文本')); assert.equal(atomic.history.memory, '必须保留的原文');
    assert.equal(fs.readdirSync(`bots/${atomic.name}`).some(file => file.endsWith('.tmp')), false);

    const prompter = Object.create(Prompter.prototype); let captured;
    Object.assign(prompter, {checkCooldown: async () => {}, chat_model: {}, _saveLog: async () => {}, requestModel: async (_model, messages, prompt, purpose) => {captured = {messages, prompt, purpose}; return '压缩正文';}});
    assert.equal(await prompter.promptSummaryCompression('只整理这段摘要'), '压缩正文');
    assert.equal(captured.purpose, 'memory-compaction'); assert.ok(captured.prompt.includes('2000') && captured.prompt.includes('2400'));
    assert.equal(captured.messages.length, 1); assert.ok(captured.messages[0].content.includes('只整理这段摘要'));
    console.log('PASS: exact 2400-character background trigger, 2399 skip, complete original input/no truncation, backups, context/manual memory preservation, oversize retries and backoff, newer edits and clear winning races, atomic commit rollback, real compression prompt and API-purpose mapping.');
} finally {
    process.chdir(previous); assert.equal(path.dirname(temporary), root); fs.rmSync(temporary, {recursive: true, force: true});
}
