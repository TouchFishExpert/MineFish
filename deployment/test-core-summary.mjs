import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {readCoreSummary, coreSummaryPath, CORE_SUMMARY_LIMIT, withCoreSummary} from '../mindcraft/src/utils/core_summary.js';
import {ensureCoreSummary, setCoreSummary} from '../mindcraft/src/agent/core_summary.js';
import {executeCommand, isAction} from '../mindcraft/src/agent/commands/index.js';
import {Prompter} from '../mindcraft/src/models/prompter.js';
import {History} from '../mindcraft/src/agent/history.js';
import {Agent} from '../mindcraft/src/agent/agent.js';
import {SelfPrompter} from '../mindcraft/src/agent/self_prompter.js';
import {setSettings} from '../mindcraft/src/agent/settings.js';
import {createMindServer, registerAgent, getIO} from '../mindcraft/src/mindcraft/mindserver.js';
const require = createRequire(new URL('../mindcraft/package.json', import.meta.url));
const {io} = require('socket.io-client');
const root = path.dirname(fileURLToPath(import.meta.url));
const temporary = fs.mkdtempSync(path.join(root, 'core-summary-test-')), previous = process.cwd();
process.chdir(temporary); setSettings({max_messages: 16});
let server, consoleClient;
const agent = {name: 'bot', self_prompter: {state: 0, isStopped: () => true}, task: {taskStartTime: 1}};
try {
    assert.equal(CORE_SUMMARY_LIMIT, 1000); assert.equal(readCoreSummary('bot').text, '');
    assert.throws(() => coreSummaryPath('../outside')); ensureCoreSummary('bot'); ensureCoreSummary('DeepSeek');
    const empty = readCoreSummary('bot'); const original = fs.readFileSync(coreSummaryPath('bot'));
    const command = `!setCoreSummary("和GGboy一起种田，安静而珍贵的陪伴。", "${empty.revision}")`;
    assert.match(await executeCommand(agent, command), /仅允许 AI/);
    assert.deepEqual(fs.readFileSync(coreSummaryPath('bot')), original, 'User-forced commands cannot edit core summary');
    assert.match(await executeCommand(agent, command, {origin: 'model'}), /已保存/);
    const first = readCoreSummary('bot'); assert.equal(first.version, 1); assert.match(first.text, /GGboy/);
    assert.equal(readCoreSummary('DeepSeek').text, '', 'Each account owns a separate file');
    assert.equal(isAction('!setCoreSummary'), false, 'A memory edit cannot interrupt a game action');
    assert.equal(setCoreSummary(agent, '不能覆盖', empty.revision).error, 'conflict');
    assert.equal(setCoreSummary(agent, '字'.repeat(1001), first.revision).error, 'too-long');
    assert.equal(readCoreSummary('bot').text, first.text);
    assert.equal(setCoreSummary(agent, '字'.repeat(1000), first.revision).success, true);
    const full = readCoreSummary('bot'); assert.equal(full.text.length, 1000);
    assert.equal(setCoreSummary(agent, '', full.revision).success, true); assert.equal(readCoreSummary('bot').text, '');
    const cleared = readCoreSummary('bot'); assert.equal(setCoreSummary(agent, '我想珍惜这些经历。', cleared.revision).success, true);
    ensureCoreSummary('bot'); assert.equal(readCoreSummary('bot').text, '我想珍惜这些经历。', 'Initialization cannot overwrite existing memories');
    assert.ok(fs.readdirSync('bots/bot/core-summary-backups').length >= 4);
    // Exercise the actual model-output branch, including escaped quotes/newlines and no chat leak.
    setSettings({max_messages: 16, max_commands: -1, translate_messages: false, show_command_syntax: 'full'});
    const remembered = '浩老板说"欢迎回家"。\n我想一直记得这句话。';
    const responses = [`记下这段。 !setCoreSummary(${JSON.stringify(remembered)}, "${readCoreSummary('bot').revision}")`, '记好了。'];
    const chat = [], turns = [];
    const runner = {name: 'bot', responseEpoch: 0, shut_up: false, checkTaskDone: async () => {},
        bot: {modes: {flushBehaviorLog: () => ''}}, history: {add: async (source, text) => turns.push({source, text}), save: async () => {}, getHistory: () => []},
        prompter: {promptConvo: async () => responses.shift()}, routeResponse: (_source, text) => chat.push(text), isIdle: () => false};
    runner.self_prompter = new SelfPrompter(runner);
    await Agent.prototype.handleMessage.call(runner, 'Tester', '请自行选择珍贵的回忆');
    assert.equal(readCoreSummary('bot').text, remembered);
    assert.deepEqual(chat, ['记下这段。', '记好了。']);
    assert.ok(!chat.some(text => text.includes('!setCoreSummary') || text.includes(remembered)), 'Tool arguments stay out of game chat');
    assert.ok(turns.some(turn => turn.text.includes('核心摘要已保存')), 'Tool success is returned to the model context');
    const history = new History(agent); history.memory = '短期摘要'; history.clear(); await history.save();
    assert.equal(readCoreSummary('bot').text, remembered, 'Short-memory clearing cannot erase the independent core summary');
    const prompt = Prompter.prototype.applyMemoryContext.call({agent}, 'base system prompt', 'conversation');
    assert.ok(prompt.includes('最珍贵') && prompt.includes('最有情感') && prompt.includes('新增、修改或删除'));
    assert.ok(prompt.includes(readCoreSummary('bot').text)); assert.ok(prompt.includes(readCoreSummary('bot').revision));
    assert.equal(agent.memoryUsage.coreChars, readCoreSummary('bot').text.length);
    assert.ok(withCoreSummary('base', readCoreSummary('bot')).includes('!setCoreSummary'));
    fs.writeFileSync(coreSummaryPath('DeepSeek'), '{invalid');
    assert.equal(readCoreSummary('DeepSeek').available, false);
    assert.equal(setCoreSummary({name: 'DeepSeek'}, '保留损坏文件', empty.revision).error, 'read-failed');
    assert.equal(fs.readFileSync(coreSummaryPath('DeepSeek'), 'utf8'), '{invalid');

    registerAgent({profile: {name: 'bot'}}, 0); server = createMindServer(false, 0); await once(server, 'listening');
    consoleClient = io(`http://localhost:${server.address().port}`, {reconnection: false}); await once(consoleClient, 'connect');
    const emit = (event, ...args) => new Promise((resolve, reject) => consoleClient.timeout(2000).emit(event, ...args, (error, value) => error ? reject(error) : resolve(value)));
    const value = await emit('get-core-summary', 'bot'); assert.equal(value.coreSummary.text, readCoreSummary('bot').text, 'Offline console read is supported');
    assert.equal((await emit('get-core-summary', '../outside')).error, 'not-found');
    const bytes = fs.readFileSync(coreSummaryPath('bot'));
    assert.equal((await emit('update-agent-core-summary', 'bot', {text: '不允许用户写入', origin: 'model'})).error, 'read-only');
    assert.deepEqual(fs.readFileSync(coreSummaryPath('bot')), bytes);

    class Element {
        constructor(tag) {this.tagName = tag; this.children = []; this.textContent = '';}
        append(...nodes) {this.children.push(...nodes);}
    }
    const pending = [], sent = [];
    const browser = {document: {createElement: tag => new Element(tag)}, setInterval: () => 1, clearInterval() {}, Date};
    vm.createContext(browser); const source = fs.readFileSync(new URL('../mindcraft/src/mindcraft/public/core-summary-panel.js', import.meta.url), 'utf8');
    vm.runInContext(source, browser);
    const panel = browser.createCoreSummaryPanel({on() {}, timeout: () => ({emit: (...args) => {sent.push(args[0]); pending.push(args.at(-1));}})});
    panel.open('bot'); panel.open('DeepSeek');
    pending[0](null, {coreSummary: {available: true, text: '旧账号不应覆盖新账号', limit: 1000, version: 1}});
    assert.equal(panel.element.children[2].textContent, '正在读取核心摘要…');
    const html = '<img src=x onerror=alert(1)>珍贵的记忆';
    pending[1](null, {coreSummary: {available: true, text: html, limit: 1000, version: 2}});
    assert.equal(panel.element.children[2].textContent, html);
    assert.ok(panel.element.children.some(node => node.textContent === 'AI把自己认为最珍贵的记忆记录在这里'));
    assert.ok(!panel.element.children.some(node => ['textarea', 'input', 'button'].includes(node.tagName)));
    assert.ok(sent.every(event => event === 'get-core-summary'), 'Frontend never sends a mutation request');
    console.log('PASS: AI-only dispatcher permission, per-bot persistence, 1000 boundary, CAS conflict, modification/deletion/backups, short-memory isolation, prompt loading, corrupt-file protection, offline read, server write denial, readonly safe frontend and account-switch isolation.');
} finally {
    consoleClient?.disconnect(); if (server) await new Promise(resolve => getIO().close(resolve));
    process.chdir(previous); assert.equal(path.dirname(temporary), root); fs.rmSync(temporary, {recursive: true, force: true});
}
