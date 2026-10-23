import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {Agent} from '../mindcraft/src/agent/agent.js';
import {History} from '../mindcraft/src/agent/history.js';
import convo from '../mindcraft/src/agent/conversation.js';
import {serverProxy} from '../mindcraft/src/agent/mindserver_proxy.js';
import {setSettings} from '../mindcraft/src/agent/settings.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const temporary = fs.mkdtempSync(path.join(directory, 'peer-wait-test-'));
const previousDirectory = process.cwd(), originalSocket = serverProxy.socket;
const originalLog = console.log, originalSetInterval = globalThis.setInterval, originalNow = Date.now;
const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => {await new Promise(resolve => setTimeout(resolve, 15)); await tick();};
const checks = [];
let fixture;
process.chdir(temporary);
setSettings({max_messages: 1, max_commands: -1, translate_messages: false, chat_bot_messages: false});
console.log = () => {};

async function make(name = 'bot') {
    if (fixture) {convo.endAllConversations(); convo._stopMonitor();}
    convo.convos = {}; convo.activeConversation = null; convo.activePeerRequests = 0;
    const counters = {model: 0, summary: 0, compaction: 0, pause: 0, resume: 0, actionStops: 0};
    const inputs = [], routed = [], sent = [];
    const bot = Object.assign(new EventEmitter(), {modes: {flushBehaviorLog: () => ''}});
    const agent = {name, bot, responseEpoch: 0, shut_up: false, last_sender: null,
        task: {taskStartTime: 1}, checkTaskDone: async () => {}, isIdle: () => true,
        actions: {executing: true, currentActionLabel: 'action:stay', stop() {counters.actionStops++;}},
        self_prompter: {state: 1, prompt: '原有自主目标', isActive() {return this.state === 1;},
            isPaused() {return this.state === 2;}, isStopped() {return this.state === 0;}, shouldInterrupt: () => false,
            setPromptPaused() {counters.pause++; this.state = 2;}, stopLoop: async () => {},
            start() {counters.resume++; this.state = 1;}},
        routeResponse: async (source, message) => routed.push({source, message}),
        prompter: {promptMemSaving: async () => '',
            promptConvo: async messages => {counters.model++; inputs.push(messages); return '收到';}}};
    agent.history = new History(agent);
    agent.history.maintainSummary = async () => {counters.summary++;};
    agent.history.compactSummaryIfNeeded = async () => {counters.compaction++;};
    agent.handleMessage = Agent.prototype.handleMessage.bind(agent);
    const roundId = agent.history.beginRound();
    await agent.history.add('GGboy', '继续原有任务', {roundId, maintainSummary: false});
    await agent.history.add(name, '知道了', {roundId, maintainSummary: false});
    agent.history.endRound(roundId);
    convo.initAgent(agent);
    convo.updateAgents([{name, in_game: true}, {name: name === 'bot' ? 'DeepSeek' : 'bot', in_game: true}]);
    serverProxy.socket = {connected: true, timeout() {return this;}, emit(event, recipient, message, callback) {
        sent.push({event, recipient, message}); callback(null, {success: true});
    }};
    fixture = {agent, counters, inputs, routed, sent};
    return fixture;
}

try {
    {
        const {agent, counters} = await make();
        const messages = ['!stay()', '!stay(300)', '我先等你回来。 !stay(300)', '!stay(-1)', '!stay(1.5)'];
        for (const message of messages) {
            await convo.observePublicChat('DeepSeek', message);
            await convo.receiveFromBot('DeepSeek', {message, start: true, end: false});
        }
        await flush();
        assert.deepEqual(counters, {model: 0, summary: 0, compaction: 0, pause: 0, resume: 0, actionStops: 0});
        assert.equal(convo.inConversation(), false);
        assert.equal(convo.activeConversation, null);
        assert.equal(convo.publicInbox.size, 0, 'Wait status must not be scheduled for a delayed public flush');
        assert.equal(agent.actions.currentActionLabel, 'action:stay');
        const rows = agent.history.getHistory().filter(row => row.content.includes('[队友等待状态，'));
        assert.equal(rows.length, messages.length * 2);
        for (const message of messages) assert.ok(rows.some(row => row.content.includes(`DeepSeek: ${message}`)));
        const saved = JSON.parse(fs.readFileSync(agent.history.memory_fp, 'utf8'));
        assert.equal(saved.turns.filter(row => row.content.includes('[队友等待状态，')).length, rows.length);
        const journal = fs.readFileSync(agent.history.journal.file, 'utf8').trim().split('\n').map(JSON.parse);
        assert.equal(journal.filter(row => row.content.includes('[队友等待状态，')).length, rows.length);
        await agent.handleMessage('GGboy', '队友刚才在干什么？');
        assert.equal(counters.model, 1);
        assert.ok(fixture.inputs[0].some(row => row.content.includes('!stay(300)')),
            'The next genuine model call includes the saved peer status');
        assert.ok(counters.summary > 0, 'Normal input still starts the existing memory maintenance');
        checks.push('public/direct stay variants are persisted in the active window and permanent journal without chat/memory API, action cancellation, autonomy pause, conversation creation or deferred wake; next human request sees them');
    }
    {
        const {agent, counters} = await make();
        agent.actions.executing = false;
        let monitorTick, now = 100000;
        Date.now = () => now;
        globalThis.setInterval = callback => {monitorTick = callback; return null;};
        await convo.startConversation('DeepSeek', '我先等等。 !stay(300)');
        globalThis.setInterval = originalSetInterval;
        assert.equal(convo.awaiting_response, false, 'Sending stay must not wait for a reply');
        const baseline = counters.model;
        now += 61000; monitorTick(); await tick();
        assert.equal(counters.model, baseline, 'No reply-timeout wake caused by an outgoing wait status');
        convo.awaiting_response = true;
        await convo.receiveFromBot('DeepSeek', {message: '!stay()', start: false, end: false});
        assert.equal(convo.awaiting_response, false);
        now += 61000; monitorTick(); await tick();
        assert.equal(counters.model, baseline, 'A received wait status acknowledges the peer without a later timeout prompt');
        assert.equal(convo.inConversation('DeepSeek'), true, 'An existing conversation remains available');
        assert.ok(agent.history.getHistory().some(row => row.content.includes('DeepSeek: !stay()')));
        Date.now = originalNow;
        checks.push('outgoing/received wait status does not arm the conversation reply watchdog; simulated 61-second monitor intervals produce no model wake');
    }
    {
        const {counters, inputs} = await make();
        await convo.receiveFromBot('DeepSeek', {message: '请告诉我你的位置', start: true, end: false});
        await convo.receiveFromBot('DeepSeek', {message: '!stay(300)', start: false, end: false});
        await flush();
        assert.equal(counters.model, 1, 'A status arriving in the same event-loop turn must not cancel real queued dialogue');
        assert.ok(inputs[0].some(row => row.content.includes('请告诉我你的位置')));
        assert.ok(inputs[0].some(row => row.content.includes('[队友等待状态，')));
        await convo.receiveFromBot('DeepSeek', {message: '你找到矿了吗？', start: false, end: false});
        await flush(); assert.equal(counters.model, 2);
        checks.push('ordinary peer conversation still wakes immediately; coalesced meaningful input survives an adjacent wait status');
    }
    {
        const {agent, counters} = await make('DeepSeek');
        await convo.receiveFromBot('bot', {message: '!stay(300)', start: true, end: false});
        await convo.observePublicChat('GGboy', '!stay(300)');
        assert.equal(counters.model, 0);
        assert.ok(agent.history.getHistory().some(row => row.content.includes('bot: !stay(300)')));
        assert.ok(!agent.history.getHistory().some(row => row.content.includes('GGboy: !stay(300)')));
        assert.ok(!agent.history.getHistory().some(row => row.content.includes('DeepSeek: !stay(300)')));
        checks.push('same policy applies independently to DeepSeek and bot; non-bot messages are excluded from the peer-status path');
    }
    const result = {at: new Date().toISOString(), passed: true, checks};
    fs.writeFileSync(path.join(directory, 'peer-wait-context-test-result.json'), JSON.stringify(result, null, 2));
    originalLog(JSON.stringify(result, null, 2));
} finally {
    Date.now = originalNow; globalThis.setInterval = originalSetInterval;
    convo.endAllConversations(); convo._stopMonitor();
    serverProxy.socket = originalSocket; console.log = originalLog;
    process.chdir(previousDirectory);
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(directory));
    fs.rmSync(temporary, {recursive: true, force: true});
}
