import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { History } from '../mindcraft/src/agent/history.js';
import { setSettings } from '../mindcraft/src/agent/settings.js';
import { Prompter } from '../mindcraft/src/models/prompter.js';
import { readManualMemory } from '../mindcraft/src/utils/manual_memory.js';
const root = fileURLToPath(new URL('./', import.meta.url));
const temporary = fs.mkdtempSync(path.join(root, 'memory-durability-test-'));
const cwd = process.cwd();
process.chdir(temporary);
setSettings({ max_messages: 6 });
const agent = { name: 'bot', responseEpoch: 0, self_prompter: { state: 1, prompt: '继续陪玩', isStopped: () => false }, task: { taskStartTime: 1 }, prompter: {} };
try {
    const history = new History(agent); agent.history = history;
    history.memory = '原来的完整摘要';
    for (let i = 0; i < 5; i++) await history.add('GGboy', `消息${i}`);
    const original = history.getHistory();
    for (const invalid of ['', ' \n\t', null, '模型服务暂时没有响应，请稍后再试。']) {
        agent.prompter.promptMemSaving = async () => invalid;
        assert.equal(await history.summarizeMemories(original), false);
        assert.equal(history.memory, '原来的完整摘要');
    }
    let resolve, calls = 0;
    agent.prompter.promptMemSaving = () => { calls++; return new Promise(r => { resolve = r; }); };
    const first = history.add('GGboy', '触发压缩');
    const concurrent = history.add('GGboy', '压缩期间的新消息');
    await new Promise(r => setImmediate(r));
    assert.equal(calls, 1);
    const pending = JSON.parse(fs.readFileSync(history.memory_fp));
    assert.equal(pending.memory, '原来的完整摘要');
    assert.equal(pending.turns.length, 7, 'Recent input is persisted without waiting for summary API completion');
    resolve('包含旧事和新事的新摘要');
    await Promise.all([first, concurrent]);
    await history.compactionPromise;
    const stored = JSON.parse(fs.readFileSync(history.memory_fp));
    assert.equal(stored.memory, '包含旧事和新事的新摘要');
    assert.ok(stored.turns.some(t => t.content.includes('压缩期间的新消息')));
    const backup = JSON.parse(fs.readFileSync(path.join('bots/bot/memory-backups', stored.memory_meta.lastBackup)));
    assert.equal(backup.memory, '原来的完整摘要');
    assert.equal(backup.turns.length, 7);
    const archive = fs.readFileSync(history.full_history_fp, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(archive.length, 7);
    assert.deepEqual(archive.slice(0, 5).map(({role, content}) => ({role, content})), original.map(({role, content}) => ({role, content})));
    history.max_messages = 1;
    agent.prompter.promptMemSaving = async () => { throw Error('API unavailable'); };
    await history.add('GGboy', '不能丢失');
    await history.compactionPromise;
    assert.equal(history.turns.length, 8);
    assert.equal(JSON.parse(fs.readFileSync(history.memory_fp)).turns.length, 8);
    assert.equal(fs.readFileSync(history.full_history_fp, 'utf8').trim().split('\n').length, 8);

    fs.writeFileSync('bots/bot/manual-memory.json', JSON.stringify({ text: '浩老板是 GGboy；仓库需要授权。', version: 8, updatedAt: new Date().toISOString() }));
    let actualPrompt;
    const prompter = Object.create(Prompter.prototype);
    Object.assign(prompter, { agent, profile: { conversing: '摘要:$MEMORY', coding: '摘要:$MEMORY' }, checkCooldown: async () => {}, _saveLog: async () => {}, convo_examples: null, coding_examples: null,
        chat_model: { sendRequest: async (_turns, prompt) => { actualPrompt = prompt; return '收到'; } },
        code_model: { sendRequest: async (_turns, prompt) => { actualPrompt = prompt; return '动作'; } }
    });
    await prompter.promptConvo([]);
    assert.ok(actualPrompt.startsWith('长期记忆：\n浩老板是 GGboy；仓库需要授权。'));
    assert.equal(agent.memoryUsage.manualRevision, readManualMemory('bot').revision);
    assert.equal(agent.memoryUsage.manualVersion, 8);
    assert.equal(agent.memoryUsage.kind, 'conversation');
    await prompter.promptCoding([]);
    assert.equal(agent.memoryUsage.kind, 'coding');
    assert.equal(JSON.stringify(agent.memoryUsage).includes('浩老板'), false, 'Usage telemetry must contain no memory text');
} finally {
    process.chdir(cwd);
    assert.equal(path.dirname(temporary), path.resolve(root));
    fs.rmSync(temporary, { recursive: true, force: true });
}
console.log('PASS: blank/failure summary rejection, serialized compression, durable in-flight context, automatic backup and archive, failed request retention, actual prompt context and usage revision matching.');
