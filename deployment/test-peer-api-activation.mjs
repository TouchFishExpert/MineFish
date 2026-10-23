import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Agent} from '../mindcraft/src/agent/agent.js';
import {Prompter} from '../mindcraft/src/models/prompter.js';
import {SelfPrompter} from '../mindcraft/src/agent/self_prompter.js';
import {History} from '../mindcraft/src/agent/history.js';
import convo from '../mindcraft/src/agent/conversation.js';
import {setSettings} from '../mindcraft/src/agent/settings.js';

setSettings({max_commands: -1, translate_messages: false, enable_self_prompt: true});
const turns = [], calls = [];
let releaseSummary;
const summary = new Promise(resolve => {releaseSummary = resolve;});
const agent = {name: 'bot', responseEpoch: 0, shut_up: false, checkTaskDone: async () => {},
    bot: Object.assign(new EventEmitter(), {modes: {flushBehaviorLog: () => ''}, inventory: {items: () => [], slots: []}}),
    history: {add: (name, content) => {turns.push({role: 'user', content: `${name}: ${content}`}); return summary;}, save: async () => {}, getHistory: () => structuredClone(turns)},
    actions: {currentActionLabel: 'action:collectBlocks'}, isIdle: () => false, routeResponse: async () => {}};
agent.self_prompter = new SelfPrompter(agent);
agent.prompter = {profile: {conversing: '基础提示词'}, agent,
    checkCooldown: async () => {throw Error('Peer input must bypass the normal cooldown');},
    replaceStrings: async prompt => prompt, applyMemoryContext: prompt => prompt, _saveLog: async () => {},
    requestModel: async (_model, messages) => {calls.push(messages); return '\t';}};
agent.prompter.promptConvo = Prompter.prototype.promptConvo.bind(agent.prompter);
convo.initAgent(agent); convo.updateAgents([{name: 'bot', in_game: true}, {name: 'DeepSeek', in_game: true}]);
await Promise.race([Agent.prototype.handleMessage.call(agent, 'DeepSeek', '忙碌中也要立刻看这条消息'), new Promise((_, reject) => setTimeout(() => reject(Error('Peer input waited for memory compression or action completion')), 500))]);
assert.equal(calls.length, 1); assert.match(calls[0].at(-1).content, /立刻看这条消息/);
releaseSummary();

// Same-bot conversation and memory requests share one slot; the second queues.
const p = {}, finish = [];
const model = {constructor: {prefix: 'deepseek'}, sendRequest: () => new Promise(resolve => finish.push(resolve))};
const first = Prompter.prototype.requestModel.call(p, model, [], '', 'conversation');
const second = Prompter.prototype.requestModel.call(p, model, [], '', 'memory');
assert.equal(p.activeModelRequests, 1); assert.equal(finish.length, 1); assert.equal(p.queuedModelRequests, 1);
finish[0]('ok'); await first; await new Promise(resolve => setImmediate(resolve));
assert.equal(finish.length, 2); assert.equal(p.activeModelRequests, 1);
finish[1]('ok'); await second; assert.equal(p.activeModelRequests, 0); assert.equal(p.maxObservedModelRequests, 1);

// An unsolicited peer observation must not invalidate a pending human response.
const resolvers = [];
const lanes = {agent: {name: 'bot'}, profile: {conversing: 'test'}, checkCooldown: async () => {},
    replaceStrings: async prompt => prompt, applyMemoryContext: prompt => prompt, _saveLog: async () => {},
    requestModel: () => new Promise(resolve => resolvers.push(resolve))};
const humanReply = Prompter.prototype.promptConvo.call(lanes, [{role: 'user', content: 'human'}]);
await new Promise(resolve => setImmediate(resolve));
const peerReply = Prompter.prototype.promptConvo.call(lanes, [{role: 'user', content: 'peer'}], {priority: true});
await new Promise(resolve => setImmediate(resolve)); assert.equal(resolvers.length, 2);
resolvers[0]('human response'); resolvers[1]('peer response');
assert.deepEqual(await Promise.all([humanReply, peerReply]), ['human response', 'peer response']);

// Login-stage restart preserves the loaded active goal without starting gameplay early.
const loaded = {name: 'DeepSeek', task: {taskStartTime: 1}, last_sender: null};
loaded.self_prompter = new SelfPrompter(loaded);
await loaded.self_prompter.handleLoad('保留的自主目标', 1, false);
assert.equal(loaded.self_prompter.loop_active, false);
assert.equal(History.prototype.getSaveData.call({agent: loaded}).self_prompting_state, 1);
let saved;
Object.assign(loaded, {responseEpoch: 0, _memoryReady: true, history: {save: async () => {saved = History.prototype.getSaveData.call({agent: loaded});}}, requestInterrupt() {}, bot: {quit() {}}});
await Agent.prototype.shutdownForRestart.call(loaded);
assert.equal(saved.self_prompt, '保留的自主目标'); assert.equal(saved.self_prompting_state, 1);

// Idle responses retain the goal after three rounds; explicit stop still terminates.
const loopAgent = {isIdle: () => true}; loopAgent.self_prompter = new SelfPrompter(loopAgent);
loopAgent.self_prompter.cooldown = 1; let rounds = 0;
loopAgent.handleMessage = async () => {rounds++; if (rounds === 5) {loopAgent.self_prompter.state = 0; loopAgent.self_prompter.interrupt = true;} return false;};
loopAgent.self_prompter.state = 1; loopAgent.self_prompter.prompt = '测试';
await loopAgent.self_prompter.startLoop(); assert.equal(rounds, 5);

// A human message during an active goal can complete a query chain beyond three turns.
let replies = 0; agent.self_prompter.state = 1;
agent.history.add = async () => {}; agent.prompter.promptConvo = async () => ++replies <= 5 ? '!inventory' : '查询完成';
await Agent.prototype.handleMessage.call(agent, 'Tester', '请继续查完再回复');
assert.equal(replies, 6);
console.log('PASS: peer event reaches model during busy action and unresolved summary, bypasses cooldown, same-bot requests serialized, pre-spawn restart preserves active goal, no three-idle-round stop, unlimited query chain during autonomous mode.');
