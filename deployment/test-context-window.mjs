import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {appendApiEvent, readApiCall} from '../mindcraft/src/mindcraft/log_store.js';
import {readContextWindow} from '../mindcraft/src/mindcraft/context_window.js';
import {registerLogSecret} from '../mindcraft/src/utils/log_redaction.js';
import {createMindServer, registerAgent, getIO} from '../mindcraft/src/mindcraft/mindserver.js';
const require = createRequire(new URL('../mindcraft/package.json', import.meta.url));
const {io} = require('socket.io-client');
const temporary = fs.mkdtempSync(new URL('./context-window-test-', import.meta.url));
const previous = process.cwd(); process.chdir(temporary);
let server; const clients = [];
const request = (id, purpose, time, messages) => ({phase: 'request', id, purpose, startedAt: time, endpoint: 'https://api.deepseek.com/chat/completions', method: 'POST', request: {model: 'deepseek-flash', messages}});
const response = id => ({phase: 'response', id, status: 'completed', httpStatus: 200, finishedAt: new Date().toISOString(), response: {choices: [{message: {content: '回复'}}]}});
try {
    assert.deepEqual(readContextWindow('empty'), {context: null});
    const secret = 'context-unit-secret-1122'; registerLogSecret(secret);
    const a = randomUUID(), b = randomUUID(), summary = randomUUID(), other = randomUUID();
    appendApiEvent('bot', request(a, 'conversation', '2026-10-21T10:00:00.000Z', [{role: 'system', content: '旧提示'}, {role: 'user', content: '旧上下文'}]), 1);
    const messages = [{role: 'system', content: '实际系统提示与中文记忆'.repeat(12000) + secret},
        {role: 'user', content: '<img src=x onerror=alert(1)> 当前输入'},
        {role: 'assistant', content: '!inventory'}, {role: 'tool', content: '原始工具结果\n保留换行', tool_call_id: 'tool-1'}];
    appendApiEvent('bot', request(b, 'conversation', '2026-10-21T10:00:01.000Z', messages), 1);
    appendApiEvent('bot', request(summary, 'memory-compaction', '2026-10-21T10:00:02.000Z', [{role: 'user', content: '摘要压缩输入'}]), 1);
    appendApiEvent('bot', response(a), 1); // Older HTTP response finishes after newer conversation request.
    appendApiEvent('DeepSeek', request(other, 'conversation', '2026-10-21T10:00:03.000Z', [{role: 'user', content: '另一机器人独立上下文'}]), 2);
    const window = readContextWindow('bot').context;
    assert.equal(window.id, b); assert.equal(window.status, 'pending');
    assert.deepEqual(window.messages, readApiCall('bot', b).request.messages);
    assert.ok(window.text.length > 100000); assert.ok(window.text.includes('【系统】\n')); assert.ok(window.text.includes('tool_call_id'));
    assert.ok(window.text.includes('<img src=x')); assert.ok(!window.text.includes(secret));
    assert.ok(!window.text.includes('摘要压缩输入')); assert.ok(!window.text.includes('另一机器人独立上下文'));
    assert.equal(window.chars, window.messages.reduce((sum, message) => sum + message.content.length, 0));
    assert.equal(window.chars, window.systemChars + window.workChars);
    const unchanged = readContextWindow('bot', {ifCallId: b});
    assert.equal(unchanged.unchanged, true); assert.equal(unchanged.context.text, undefined); assert.equal(unchanged.context.messages, undefined);
    appendApiEvent('bot', response(b), 1);
    assert.equal(readContextWindow('bot', {ifCallId: b}).context.status, 'completed');
    assert.equal(readContextWindow('DeepSeek').context.id, other);

    registerAgent({profile: {name: 'bot'}}, 0); registerAgent({profile: {name: 'DeepSeek'}}, 1);
    server = createMindServer(false, 0); await once(server, 'listening');
    const connect = async () => {const socket = io(`http://localhost:${server.address().port}`, {reconnection: false}); clients.push(socket); await once(socket, 'connect'); return socket;};
    const client = await connect(), robot = await connect();
    const emit = (socket, ...args) => new Promise((resolve, reject) => socket.timeout(2000).emit(...args, (error, result) => error ? reject(error) : resolve(result)));
    const beforeBytes = fs.statSync('bots/bot/logs/console/api-2026-10-21.jsonl').size;
    assert.equal((await emit(client, 'get-context-window', 'bot', {})).context.id, b, 'Offline bot still exposes its last actual request to the local operator');
    assert.equal((await emit(client, 'get-context-window', 'missing', {})).error, 'not-found');
    assert.equal((await emit(client, 'get-context-window', '../escape', {})).error, 'not-found');
    robot.emit('connect-agent-process', 'bot'); await emit(robot, 'get-settings', 'bot');
    assert.equal((await emit(robot, 'get-context-window', 'DeepSeek', {})).error, 'forbidden');
    assert.equal(fs.statSync('bots/bot/logs/console/api-2026-10-21.jsonl').size, beforeBytes, 'Reading does not issue model calls or write context');
    const ui = fs.readFileSync(new URL('../mindcraft/src/mindcraft/public/inspection-panel.js', import.meta.url), 'utf8');
    assert.ok(ui.includes("['context', '上下文窗口']")); assert.ok(ui.includes('text.readOnly = true'));
    assert.ok(!ui.includes('近期对话')); assert.ok(!ui.includes("make('details'")); assert.ok(!ui.includes('innerHTML'));
    console.log('PASS: exact complete wire messages >100KB, latest request rather than late response or memory call, per-bot isolation, no truncation, safe redaction, counts, unchanged-payload optimization, offline read, socket authorization, no API side effects, old list removed and continuous read-only view.');
} finally {
    clients.forEach(socket => socket.disconnect()); if (server) await new Promise(resolve => getIO().close(resolve));
    process.chdir(previous);
    assert.equal(path.dirname(temporary), path.dirname(fileURLToPath(import.meta.url)));
    fs.rmSync(temporary, {recursive: true, force: true});
}
