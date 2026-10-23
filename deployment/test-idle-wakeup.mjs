import assert from 'node:assert/strict';
import {IdleWakeup, IDLE_WAKEUP_MS} from '../mindcraft/src/agent/idle_wakeup.js';
import {Agent} from '../mindcraft/src/agent/agent.js';
import {SelfPrompter} from '../mindcraft/src/agent/self_prompter.js';
import {History} from '../mindcraft/src/agent/history.js';
import {actionsList} from '../mindcraft/src/agent/commands/actions.js';
import {setSettings} from '../mindcraft/src/agent/settings.js';
let now = 0, timerCallback, cancelled = false;
const calls = [];
const agent = {name: 'test', actions: {executing: false}, bot: {}, prompter: {activeModelRequests: 0}, handleMessage: async (...args) => {calls.push(args);}};
const watcher = new IdleWakeup(agent, {now: () => now, schedule: (callback, interval) => {assert.equal(interval, 1000); timerCallback = callback; return 7;}, cancel: id => {assert.equal(id, 7); cancelled = true;}});
watcher.start(); watcher.start(); assert.equal(IDLE_WAKEUP_MS, 60000);
now = 59999; assert.equal(await watcher.tick(), false); assert.equal(calls.length, 0);
now = 60000; assert.equal(await watcher.tick(), true); assert.equal(calls.length, 1);
assert.equal(calls[0][0], 'system'); assert.equal(calls[0][2], -1); assert.equal(calls[0][3].idleWakeup, true);
now += 59999; assert.equal(await watcher.tick(), false);
now++; assert.equal(await watcher.tick(), true); assert.equal(calls.length, 2);

let release;
agent.handleMessage = async (...args) => {calls.push(args); await new Promise(resolve => {release = resolve;});};
now += 60000; const pending = watcher.tick(); await new Promise(resolve => setImmediate(resolve));
now += 120000; assert.equal(await watcher.tick(), false, 'Never overlap a pending wake');
release(); await pending; assert.equal(watcher.wakeCount, 3);
agent.handleMessage = async (...args) => {calls.push(args);};
const beforeBusy = calls.length;
for (const kind of ['stay', 'sleep', 'action', 'handoff', 'follow', 'model', 'decision']) {
    now += 120000;
    if (kind === 'stay') Object.assign(agent.actions, {executing: true, currentActionLabel: 'action:stay'});
    if (kind === 'sleep') agent.bot.isSleeping = true;
    if (kind === 'action') agent.actions.executing = true;
    if (kind === 'handoff') agent.actions.pendingActions = 1;
    if (kind === 'follow') agent.actions.resume_func = () => {};
    if (kind === 'model') agent.prompter.activeModelRequests = 1;
    const end = kind === 'decision' ? watcher.beginDecision() : null;
    if (kind === 'stay' || kind === 'sleep') assert.equal(watcher.getState().state, 'intentional-wait');
    assert.equal(await watcher.tick(), false); assert.equal(calls.length, beforeBusy);
    Object.assign(agent.actions, {executing: false, currentActionLabel: '', pendingActions: 0, resume_func: null});
    agent.bot.isSleeping = false; agent.prompter.activeModelRequests = 0; end?.();
    await watcher.tick(); now += 59999; assert.equal(await watcher.tick(), false, 'Waiting/busy time must not leak into the new idle minute');
}
watcher.suspend(); now += 1000000; assert.equal(await watcher.tick(), false);
const restored = new IdleWakeup(agent); restored.restore(watcher.getSaveData(), 1); assert.equal(restored.suspended, true);
const legacy = new IdleWakeup(agent); legacy.restore(undefined, 0); assert.equal(legacy.suspended, true);
legacy.restore({suspended: false}, 0); assert.equal(legacy.suspended, false, 'Normal goal completion may remain wakeable');
watcher.resume(); await watcher.tick(); now += 60000; timerCallback(); await new Promise(resolve => setImmediate(resolve));
assert.equal(watcher.wakeCount, 4, 'Independent timer wakes even without calling Agent.update');
watcher.stop(); assert.ok(cancelled); assert.equal(watcher.timer, null);

// Real handler: an old self-prompt interrupt cannot suppress the wake, but stop can.
setSettings({max_commands: -1, translate_messages: false});
const a = {name: 'test', responseEpoch: 0, shut_up: false, checkTaskDone: async () => {},
    bot: {modes: {flushBehaviorLog: () => ''}}, history: {add: async () => {}, save: async () => {}, getHistory: () => []},
    routeResponse: async () => {}, actions: {stop: async () => {}, cancelResume() {}}, clearBotLogs() {}};
a.self_prompter = new SelfPrompter(a); a.self_prompter.interrupt = true;
a.idle_wakeup = new IdleWakeup(a); let requests = 0;
a.prompter = {promptConvo: async () => {requests++; return '\t';}};
await Agent.prototype.handleMessage.call(a, 'system', '空闲唤醒测试', -1, {idleWakeup: true});
assert.equal(requests, 1); assert.equal(a.idle_wakeup.activeDecisions, 0);
let started, respond; const ready = new Promise(resolve => {started = resolve;});
a.prompter.promptConvo = async () => {started(); return new Promise(resolve => {respond = resolve;});};
const inFlight = Agent.prototype.handleMessage.call(a, 'system', '稍后被停止的唤醒', -1, {idleWakeup: true});
await ready; a.responseEpoch++; a.idle_wakeup.suspend(); let stale = false; a.shutUp = () => {stale = true;};
respond('!stfu'); await inFlight; assert.equal(stale, false);
a.task = {taskStartTime: 1};
assert.equal(History.prototype.getSaveData.call({agent: a}).idle_wakeup.suspended, true);
a.self_prompter.startLoop = () => {}; a.self_prompter.start('恢复自主活动'); assert.equal(a.idle_wakeup.suspended, false);
assert.ok(actionsList.find(action => action.name === '!stop'));
console.log('PASS: exact 60-second threshold, one wake per idle period, no overlap, explicit wait/sleep/action/model/decision exclusions, full new minute after busy work, independent timer, persisted explicit stop, migration, stale interrupt recovery and manual stop cancelling in-flight wake.');
