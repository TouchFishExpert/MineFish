import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ActionManager } from '../mindcraft/src/agent/action_manager.js';
import { initModes } from '../mindcraft/src/agent/modes.js';
import { actionsList } from '../mindcraft/src/agent/commands/actions.js';

function makeAgent() {
    const bot = new EventEmitter();
    Object.assign(bot, { output: '', interrupt_code: false });
    const agent = {
        bot,
        self_prompter: { isActive: () => false, stop: async () => agent.actions.stop() },
        history: { save: async () => {} },
        clearBotLogs() { bot.output = ''; bot.interrupt_code = false; },
        requestInterrupt() { bot.interrupt_code = true; agent.cancelCurrent?.(); },
        cleanKill(message) { throw Error(message); },
        isIdle() { return !agent.actions.executing; },
        prompter: { getInitModes: () => ({ self_preservation: false, unstuck: false, cowardice: false,
            self_defense: true, hunting: false, item_collecting: false, torch_placing: false,
            elbow_room: false, idle_staring: false, cheat: false }) },
    };
    agent.actions = new ActionManager(agent);
    return agent;
}

// Exercise the real scheduler, including a pathfinder-style rejection during interruption.
const agent = makeAgent();
const events = [];
let followingStarted;
const started = new Promise(resolve => { followingStarted = resolve; });
const follow = () => new Promise((resolve, reject) => {
    events.push('follow');
    followingStarted();
    agent.cancelCurrent = () => reject(Object.assign(Error('Path was stopped'), { name: 'PathStopped' }));
});
const first = agent.actions.runAction('action:followPlayer', follow, { resume: true });
await started;
const defense = agent.actions.runAction('mode:self_defense', async () => { events.push('defense'); });
assert.equal(agent.actions.pendingActions, 1, 'A replacement action reserves the cancellation handoff');
assert.equal((await first).interrupted, true, 'Expected cancellation is not an execution error');
await defense;
assert.equal(agent.actions.resume_func, follow, 'Defensive interruption retains following');
const resumed = agent.actions.resumeAction();
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(events, ['follow', 'defense', 'follow'], 'Following can resume after defense');
const retreat = agent.actions.runAction('action:moveAway', async () => { events.push('retreat'); });
await resumed;
await retreat;
assert.equal(agent.actions.resume_func, null, 'A new user action supersedes the old follow');
await agent.actions.resumeAction();
assert.equal(events.length, 4, 'The superseded action does not restart');
const beforeStop = agent.actions.runAction('action:followPlayer', follow, { resume: true });
await new Promise(resolve => setImmediate(resolve));
await actionsList.find(action => action.name === '!stop').perform(agent);
await beforeStop;
assert.equal(agent.actions.resume_func, null, 'Explicit stop cancels follow recovery');
await agent.actions.resumeAction();
assert.equal(agent.isIdle(), true, 'Explicit stop leaves the robot idle');

// Test real mode dispatch: hostile sensing must not steal retreat or an in-flight handoff.
initModes(agent);
agent.bot.nearestEntity = () => { throw Error('Defense must not scan for targets in this state'); };
agent.actions.executing = true;
for (const label of ['action:moveAway', 'action:goToPlayer']) {
    agent.actions.currentActionLabel = label;
    await agent.bot.modes.update();
}
agent.actions.currentActionLabel = 'action:collectBlocks';
agent.actions.pendingActions = 1;
await agent.bot.modes.update();
agent.actions.pendingActions = 0;
let scanned = false;
agent.bot.nearestEntity = () => { scanned = true; return null; };
await agent.bot.modes.update();
assert.equal(scanned, true, 'Defense still watches for enemies during ordinary work');
console.log('PASS: interrupted follow recovery, explicit command replacement, retreat priority, and handoff reservation.');
