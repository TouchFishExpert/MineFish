import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import {Agent} from '../mindcraft/src/agent/agent.js';
import {ActionManager} from '../mindcraft/src/agent/action_manager.js';
import {stay} from '../mindcraft/src/agent/library/skills.js';
import convo from '../mindcraft/src/agent/conversation.js';
import {setSettings} from '../mindcraft/src/agent/settings.js';

setSettings({translate_messages: false, max_commands: -1});
const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
function make() {
    const bot = Object.assign(new EventEmitter(), {output: '', interrupt_code: false,
        modes: {pause() {}, flushBehaviorLog: () => ''}, stopDigging() {}, clearControlStates() {},
        collectBlock: {cancelTask: async () => {}}, pathfinder: {stop() {}, setGoal() {}}, pvp: {stop() {}}});
    const events = [], calls = [], routed = [], turns = [];
    const agent = {name: 'bot', bot, responseEpoch: 0, shut_up: false, last_sender: null,
        checkTaskDone: async () => {}, isIdle: () => !agent.actions.executing,
        self_prompter: {state: 0, isActive: () => false, isPaused: () => false, shouldInterrupt: () => false},
        history: {recordEvent: (kind, value) => events.push({kind, ...value}),
            add: async (name, message) => turns.push({name, message}), save: async () => {}, getHistory: () => []},
        clearBotLogs: Agent.prototype.clearBotLogs, requestInterrupt: Agent.prototype.requestInterrupt,
        cleanKill: message => {throw Error(message);}, routeResponse: async (source, message) => routed.push({source, message}),
        prompter: {promptConvo: async history => {calls.push(history); return '收到';}}};
    agent.actions = new ActionManager(agent);
    agent.handleMessage = Agent.prototype.handleMessage.bind(agent);
    convo.initAgent(agent); convo.updateAgents([{name: 'bot', in_game: true}, {name: 'DeepSeek', in_game: true}]);
    return {bot, agent, events, calls, routed, turns};
}

const log = console.log;
console.log = () => {};
try {
    {
        const {agent, events, calls, routed} = make();
        // Production initializes the manager before Mineflayer creates its bot.
        const createdBot = agent.bot;
        agent.bot = undefined; convo.initAgent(agent);
        agent.bot = createdBot; convo.bindBot(createdBot);
        const waiting = agent.actions.runAction('action:stay', () => stay(agent.bot, 0.01), {timeout: -1});
        await tick();
        for (let n = 0; n < 200; n++) await convo.observePublicChat('DeepSeek', `公开消息 ${n}`);
        assert.equal(calls.length, 0); assert.equal(events.filter(event => event.kind === 'peer-public-deferred').length, 200);
        assert.equal(convo.publicInbox.size, 1); assert.equal(convo.publicInbox.get('DeepSeek').count, 200);
        assert.equal(agent.actions.currentActionLabel, 'action:stay');
        await waiting; await tick(); await tick();
        assert.equal(calls.length, 1); assert.equal(routed.length, 1);
        assert.match(routed[0].source, /DeepSeek/);
        assert.equal(convo.publicInbox.size, 0);
        checks.push('production startup binding; actual stay suppresses 200 public triggers; natural completion dispatches one latest-per-sender batch');
    }
    {
        const {agent, calls} = make();
        const waiting = agent.actions.runAction('action:stay', () => stay(agent.bot, -1), {timeout: -1});
        await tick(); await convo.observePublicChat('DeepSeek', '等你有空再说');
        await agent.actions.stop(); await waiting; await tick();
        assert.equal(calls.length, 0); assert.equal(convo.publicInbox.size, 0);
        checks.push('manual stop closes buffered observations without waking the model');
    }
    {
        const {agent, calls} = make();
        const waiting = agent.actions.runAction('action:stay', () => stay(agent.bot, -1), {timeout: -1});
        await tick();
        await convo.observePublicChat('DeepSeek', '普通公屏话'); assert.equal(calls.length, 0);
        await convo.receiveFromBot('DeepSeek', {message: '定向问你位置', start: true, end: false});
        await sleep(20); assert.equal(calls.length, 1);
        await agent.handleMessage('GGboy', '你现在在做什么'); assert.equal(calls.length, 2);
        assert.equal(agent.actions.currentActionLabel, 'action:stay');
        await agent.actions.stop(); await waiting; await tick(); convo.endAllConversations();
        checks.push('direct bot communication and player messages still reach the model during stay');
    }
    {
        const {agent, calls, routed} = make(); let finish;
        agent.prompter.promptConvo = () => {calls.push('started before wait'); return new Promise(resolve => {finish = resolve;});};
        const pending = convo.observePublicChat('DeepSeek', '等待开始前的消息'); await tick();
        const waiting = agent.actions.runAction('action:stay', () => stay(agent.bot, -1), {timeout: -1}); await tick();
        finish('去别处看看 !moveAway(5)'); await pending;
        assert.equal(calls.length, 1); assert.equal(routed.length, 0); assert.equal(agent.actions.currentActionLabel, 'action:stay');
        assert.equal(convo.publicInbox.size, 1);
        await agent.actions.stop(); await waiting; await tick();
        checks.push('a public-model reply already in flight cannot break a subsequently started stay');
    }
    {
        const {agent, calls} = make();
        agent.actions.executing = true; agent.actions.currentActionLabel = 'action:collectBlocks';
        for (let n = 0; n < 128; n++) await convo.observePublicChat('DeepSeek', `正常工作通信 ${n}`);
        assert.equal(calls.length, 128);
        agent.actions.executing = false; agent.actions.currentActionLabel = '';
        checks.push('public peer communication outside stay retains unlimited immediate processing');
    }
    {
        const {agent, calls} = make();
        const first = agent.actions.runAction('action:stay', () => stay(agent.bot, -1), {timeout: -1}); await tick();
        await convo.observePublicChat('DeepSeek', '跨过连续等待的一句话');
        const second = agent.actions.runAction('action:stay', () => stay(agent.bot, 0.01), {timeout: -1});
        await first; await tick(); assert.equal(calls.length, 0); assert.equal(convo.publicInbox.size, 1);
        await second; await tick(); await tick(); assert.equal(calls.length, 1);
        checks.push('chained stays retain the inbox and flush once at the final natural completion');
    }
} finally {console.log = log; convo.endAllConversations();}
const result = {at: new Date().toISOString(), passed: true, checks};
fs.writeFileSync(new URL('./public-chat-stay-test-result.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
