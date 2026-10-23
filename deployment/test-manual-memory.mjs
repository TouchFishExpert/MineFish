import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { History } from '../mindcraft/src/agent/history.js';
import { setSettings } from '../mindcraft/src/agent/settings.js';
import { Prompter } from '../mindcraft/src/models/prompter.js';
import { createMindServer, registerAgent, getIO } from '../mindcraft/src/mindcraft/mindserver.js';
import { MANUAL_MEMORY_LIMIT, readManualMemory, manualMemoryPath, withManualMemory } from '../mindcraft/src/utils/manual_memory.js';
import { updateManualMemoryFromConsole } from '../mindcraft/src/mindcraft/manual_memory.js';
import { memoryRevision } from '../mindcraft/src/agent/memory_edit.js';
const require = createRequire(new URL('../mindcraft/package.json', import.meta.url));
const { io } = require('socket.io-client');
const root = fileURLToPath(new URL('./', import.meta.url));
const temporary = fs.mkdtempSync(path.join(root, 'manual-memory-test-'));
const oldCwd = process.cwd();
process.chdir(temporary);
let consoleClient, agentClient, server;
const emit = (socket, event, ...args) => new Promise((resolve, reject) => socket.timeout(2000).emit(event, ...args, (error, result) => error ? reject(error) : resolve(result)));
try {
    assert.equal(readManualMemory('bot').text, '');
    assert.equal(fs.existsSync(manualMemoryPath('bot')), false, 'Reading must never create the fixed-memory file');
    assert.throws(() => manualMemoryPath('../outside'));
    assert.equal(withManualMemory('normal prompt', readManualMemory('bot')), 'normal prompt');
    registerAgent({ profile: { name: 'bot' } }, 0);
    server = createMindServer(false, 0);
    await once(server, 'listening');
    const url = `http://localhost:${server.address().port}`;
    consoleClient = io(url, { reconnection: false });
    agentClient = io(url, { reconnection: false });
    await Promise.all([once(consoleClient, 'connect'), once(agentClient, 'connect')]);
    agentClient.emit('connect-agent-process', 'bot');
    // An acknowledgement after registration ensures the server has assigned the agent identity.
    const initial = (await emit(agentClient, 'get-manual-memory', 'bot')).manualMemory;
    const payload = { text: '主人偏好桦木，基地坐标 10,64,20。', baseRevision: initial.revision };
    assert.equal((await emit(agentClient, 'update-manual-memory', 'bot', payload)).error, 'forbidden');
    assert.equal((await emit(agentClient, 'update-manual-memory', 'bot', { ...payload, from: 'ADMIN' })).error, 'forbidden');
    assert.equal(fs.existsSync(manualMemoryPath('bot')), false);
    const saved = await emit(consoleClient, 'update-manual-memory', 'bot', payload);
    assert.equal(saved.success, true);
    assert.equal(saved.manualMemory.text, payload.text);
    const file = manualMemoryPath('bot');
    const originalBytes = fs.readFileSync(file, 'utf8');
    const backup = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'manual-memory-backups', saved.backup), 'utf8'));
    assert.equal(backup.text, '');
    assert.equal((await emit(consoleClient, 'update-manual-memory', 'bot', payload)).error, 'conflict');
    assert.equal((await emit(consoleClient, 'update-manual-memory', 'bot', { text: 'a'.repeat(MANUAL_MEMORY_LIMIT + 1), baseRevision: saved.manualMemory.revision })).error, 'too-long');
    assert.equal((await emit(consoleClient, 'update-manual-memory', '__proto__', payload)).error, 'not-found');
    assert.equal(updateManualMemoryFromConsole({ data: { agentProcess: true } }, {}, 'bot', payload).error, 'forbidden');

    setSettings({ max_messages: 16 });
    const agent = { name: 'bot', responseEpoch: 0, self_prompter: { state: 0, prompt: '', isStopped: () => true }, task: { taskStartTime: 1 }, prompter: { promptMemSaving: async () => '自动摘要声称已忘记一切' } };
    agent.history = new History(agent);
    agent.history.memory = '滚动摘要';
    await agent.history.save();
    await agent.history.summarizeMemories([]);
    agent.history.editMemory({ summary: '人工修订滚动摘要', baseRevision: memoryRevision(agent.history.memory) });
    agent.history.clear();
    await agent.history.save();
    new History(agent).load();
    assert.equal(fs.readFileSync(file, 'utf8'), originalBytes, 'Summarize, edit, clear, save and reload cannot touch fixed memory');
    assert.equal((await emit(agentClient, 'get-manual-memory', 'bot')).manualMemory.text, payload.text);

    // Real prompt methods with a stub model: no external service request.
    let sentPrompt;
    const prompter = Object.create(Prompter.prototype);
    Object.assign(prompter, {
        agent, profile: { conversing: '你是游戏队友。摘要:$MEMORY', coding: '代码上下文:$MEMORY', saving_memory: '摘要:$MEMORY\n$TO_SUMMARIZE' },
        checkCooldown: async () => {}, _saveLog: async () => {}, convo_examples: null, coding_examples: null,
        chat_model: { sendRequest: async (_messages, prompt) => { sentPrompt = prompt; return '收到'; } },
        code_model: { sendRequest: async (_messages, prompt) => { sentPrompt = prompt; return 'code'; } }
    });
    await prompter.promptConvo([]);
    assert.ok(sentPrompt.startsWith(`长期记忆：\n${payload.text}\n\n`));
    assert.equal(/不允许AI|禁止.*删除|cannot.*delete|read.only/i.test(sentPrompt), false);
    await prompter.promptCoding([]);
    assert.ok(sentPrompt.includes(payload.text));
    await prompter.promptMemSaving([]);
    assert.equal(sentPrompt.includes(payload.text), false, 'Fixed facts are not input to the rolling-memory compressor');
    assert.equal(fs.readFileSync(file, 'utf8'), originalBytes);

    const full = await emit(consoleClient, 'update-manual-memory', 'bot', { text: '记'.repeat(MANUAL_MEMORY_LIMIT), baseRevision: saved.manualMemory.revision });
    assert.equal(full.success, true);
    assert.equal(readManualMemory('bot').text.length, MANUAL_MEMORY_LIMIT);
    const fullBytes = fs.readFileSync(file, 'utf8');
    assert.equal((await emit(agentClient, 'update-manual-memory', 'bot', { text: '', baseRevision: full.manualMemory.revision })).error, 'forbidden');
    assert.equal(fs.readFileSync(file, 'utf8'), fullBytes);
    fs.writeFileSync(file, '{corrupted file');
    assert.equal(readManualMemory('bot').available, false);
    assert.throws(() => withManualMemory('prompt', readManualMemory('bot')));
    assert.equal((await emit(consoleClient, 'update-manual-memory', 'bot', { text: '', baseRevision: full.manualMemory.revision })).error, 'read-failed');
    assert.equal(fs.readFileSync(file, 'utf8'), '{corrupted file');
} finally {
    consoleClient?.disconnect(); agentClient?.disconnect();
    if (server) await new Promise(resolve => getIO().close(resolve));
    process.chdir(oldCwd);
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(root));
    fs.rmSync(temporary, { recursive: true, force: true });
}
for (const filename of ['manual-memory-panel.js', 'inspection-panel.js']) {
    const script = fs.readFileSync(new URL(`../mindcraft/src/mindcraft/public/${filename}`, import.meta.url), 'utf8');
    new vm.Script(script);
    assert.equal(/innerHTML|insertAdjacentHTML|eval\(/.test(script), false);
}
console.log('PASS: real console API and agent-socket denial, sender spoof denial, separate backups and persistence, unchanged by compaction/clear, real prompt injection without permission instructions, 2000-character limit, corrupt-file protection.');
