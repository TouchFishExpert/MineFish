import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { History } from '../mindcraft/src/agent/history.js';
import { setSettings } from '../mindcraft/src/agent/settings.js';
import { SUMMARY_LIMIT, memoryRevision, validateMemoryEdit } from '../mindcraft/src/agent/memory_edit.js';
import { requestAgentMemoryUpdate } from '../mindcraft/src/mindcraft/inspection.js';

const require = createRequire(new URL('../mindcraft/package.json', import.meta.url));
const { Server } = require('socket.io');
const { io } = require('socket.io-client');
const baseDir = fileURLToPath(new URL('./', import.meta.url));
const temporary = fs.mkdtempSync(path.join(baseDir, 'memory-edit-test-'));
const originalCwd = process.cwd();
process.chdir(temporary);
setSettings({ max_messages: 16 });
const agent = { name: 'bot', responseEpoch: 2, self_prompter: { state: 1, prompt: '陪玩', isStopped: () => false }, task: { taskStartTime: 123 }, last_sender: 'GGboy', prompter: {} };
try {
    const history = new History(agent);
    history.memory = '旧摘要';
    history.turns = [{ role: 'user', content: 'GGboy: 不要动建筑' }];
    await history.save();
    const originalFile = fs.readFileSync(history.memory_fp, 'utf8');
    assert.equal(SUMMARY_LIMIT, 2500);
    assert.equal(validateMemoryEdit({ summary: 'a'.repeat(SUMMARY_LIMIT + 1), baseRevision: memoryRevision('旧摘要') }), 'too-long');
    assert.equal(validateMemoryEdit({ summary: '记'.repeat(SUMMARY_LIMIT), baseRevision: memoryRevision('旧摘要') }), null);
    assert.equal(validateMemoryEdit({ summary: 'a', baseRevision: memoryRevision('旧摘要'), turns: [] }), 'invalid-request');
    assert.equal(validateMemoryEdit({ summary: 'a', baseRevision: 'bad' }), 'invalid-request');
    assert.deepEqual(history.editMemory({ summary: '冲突写入', baseRevision: memoryRevision('other') }), { error: 'conflict' });
    assert.equal(fs.readFileSync(history.memory_fp, 'utf8'), originalFile);
    assert.deepEqual(history.editMemory({ summary: '旧摘要', baseRevision: memoryRevision('旧摘要') }), { success: true, unchanged: true });
    assert.equal(fs.existsSync(path.join(path.dirname(history.memory_fp), 'memory-backups')), false);

    // A summary already in flight must not overwrite a manual correction.
    let resolveSummary;
    agent.prompter.promptMemSaving = () => new Promise(resolve => { resolveSummary = resolve; });
    const inFlight = history.summarizeMemories([]);
    const manual = 'GGboy 的基地坐标已修正。\n<img src=x onerror=alert(1)> 是普通文字';
    const saved = history.editMemory({ summary: manual, baseRevision: memoryRevision('旧摘要') });
    assert.equal(saved.success, true);
    assert.equal(agent.responseEpoch, 3);
    assert.equal(history.memory, manual);
    const backup = JSON.parse(fs.readFileSync(path.join(path.dirname(history.memory_fp), 'memory-backups', saved.backup), 'utf8'));
    assert.equal(backup.memory, '旧摘要');
    assert.deepEqual(backup.turns, history.turns);
    const disk = JSON.parse(fs.readFileSync(history.memory_fp, 'utf8'));
    assert.equal(disk.memory, manual);
    assert.equal(disk.memory_meta.source, 'manual');
    assert.equal(disk.self_prompt, '陪玩');
    assert.deepEqual(disk.turns, history.turns);
    resolveSummary('根据旧记忆生成的过期摘要');
    await inFlight;
    assert.equal(history.memory, manual);
    await history.save();
    const reloaded = new History(agent);
    reloaded.load();
    assert.equal(reloaded.memory, manual);
    assert.equal(reloaded.memory_meta.lastBackup, saved.backup);

    // Ordinary later compaction can update the edited memory, preserving backup metadata.
    agent.prompter.promptMemSaving = async () => '后续自动摘要';
    await history.summarizeMemories([]);
    assert.equal(history.memory, '后续自动摘要');
    assert.equal(history.memory_meta.source, 'automatic');
    assert.notEqual(history.memory_meta.lastBackup, saved.backup);
    assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(history.memory_fp), 'memory-backups', history.memory_meta.lastBackup))).memory, manual);
    assert.equal(history.editMemory({ summary: '不能覆盖', baseRevision: memoryRevision(manual) }).error, 'conflict');

    // A failed atomic replace cannot change live memory or pretend persistence succeeded.
    const normalFile = history.memory_fp;
    const blocked = path.join(temporary, 'blocked');
    fs.mkdirSync(blocked);
    history.memory_fp = blocked;
    assert.equal(history.editMemory({ summary: '保存失败', baseRevision: memoryRevision(history.memory) }).error, 'save-failed');
    assert.equal(history.memory, '后续自动摘要');
    assert.equal(fs.readdirSync(temporary).some(name => name.endsWith('.tmp')), false);
    history.memory_fp = normalFile;
    const fullSummary = '记'.repeat(SUMMARY_LIMIT);
    // A full manual save remains legal; automatic threshold maintenance is asynchronous.
    agent.prompter.promptSummaryCompression = async () => fullSummary;
    assert.equal(history.editMemory({ summary: fullSummary, baseRevision: memoryRevision(history.memory) }).success, true);
    const fullReloaded = new History(agent);
    fullReloaded.load();
    assert.equal(fullReloaded.memory, fullSummary);
    await history.compactionPromise;
    agent.prompter.promptMemSaving = async () => '新'.repeat(SUMMARY_LIMIT + 20);
    agent.prompter.promptSummaryCompression = async () => '完整重新压缩后的新摘要';
    await history.summarizeMemories([]);
    assert.equal(history.memory, '完整重新压缩后的新摘要');
    assert.equal(history.memory_meta.truncated, false);
    assert.equal(history.editMemory({ summary: '', baseRevision: memoryRevision(history.memory) }).success, true);
    assert.equal(JSON.parse(fs.readFileSync(normalFile, 'utf8')).memory, '');
} finally {
    process.chdir(originalCwd);
    // Remove only this explicitly created test directory under deployment.
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(baseDir));
    fs.rmSync(temporary, { recursive: true, force: true });
}

const defaults = JSON.parse(fs.readFileSync(new URL('../mindcraft/profiles/defaults/_default.json', import.meta.url), 'utf8'));
assert.ok(defaults.saving_memory.includes(`limited to ${SUMMARY_LIMIT} characters`));
for (const placeholder of ['$NAME', '$MEMORY', '$TO_SUMMARIZE']) assert.ok(defaults.saving_memory.includes(placeholder));

assert.deepEqual(await requestAgentMemoryUpdate(null, {}), { error: 'invalid-request' });
const request = { summary: '中文摘要', baseRevision: memoryRevision('') };
assert.deepEqual(await requestAgentMemoryUpdate(null, request), { error: 'not-found' });
assert.deepEqual(await requestAgentMemoryUpdate({ in_game: false }, request), { error: 'offline' });
const http = createServer();
const server = new Server(http);
http.listen(0, '127.0.0.1');
await once(http, 'listening');
const connected = once(server, 'connection');
const client = io(`http://127.0.0.1:${http.address().port}`, { reconnection: false });
try {
    const [socket] = await connected;
    const connection = { in_game: true, socket };
    client.on('update-memory', (value, callback) => { assert.deepEqual(value, request); callback({ success: true, backup: 'example.json' }); });
    assert.deepEqual(await requestAgentMemoryUpdate(connection, request), { success: true, backup: 'example.json' });
    client.off('update-memory');
    assert.deepEqual(await requestAgentMemoryUpdate(connection, request, 30), { error: 'timeout' });
} finally {
    client.disconnect();
    await new Promise(resolve => server.close(resolve));
}
console.log('PASS: persisted manual edit/backup/reload, conflict and length validation, in-flight compaction guard, later compaction, failed save rollback, real Socket.IO write acknowledgement and timeout.');
