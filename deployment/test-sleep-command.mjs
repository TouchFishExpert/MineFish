import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import {Agent} from '../mindcraft/src/agent/agent.js';
import {ActionManager} from '../mindcraft/src/agent/action_manager.js';
import {executeCommand} from '../mindcraft/src/agent/commands/index.js';
import {goToBed} from '../mindcraft/src/agent/library/skills.js';
import {captureRuntimeState, prepareRuntimePrompt} from '../mindcraft/src/agent/runtime_observation.js';
import {Prompter} from '../mindcraft/src/models/prompter.js';
import {DeepSeek} from '../mindcraft/src/models/deepseek.js';

const require = createRequire(new URL('../mindcraft/package.json', import.meta.url));
const {Vec3} = require('vec3');
const bedPlugin = require('mineflayer/lib/plugins/bed.js');
const fixtures = [], checks = [];
const flush = async () => {for (let n = 0; n < 40; n++) await Promise.resolve();};
async function bounded(promise) {
    let timer;
    try {return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(Error('Sleep operation did not settle within 1500ms')), 1500);})]);}
    finally {clearTimeout(timer);}
}
function make(name = 'fixture', deferred = false) {
    const bot = new EventEmitter(), packets = [], kills = [], counts = {find: 0, activate: 0};
    const bed = {name: 'white_bed', metadata: 8, position: new Vec3(0, 64, 0)};
    Object.assign(bot, {entity: {id: 1, position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), onGround: true},
        _client: new EventEmitter(), entities: {}, game: {dimension: 'overworld', gameMode: 'survival'},
        time: {timeOfDay: 18000}, health: 20, food: 20, output: '', interrupt_code: false,
        supportFeature: () => false, canDigBlock: () => true, blockAt: () => bed,
        findBlocks: () => {counts.find++; return [bed.position];},
        activateBlock: async () => {counts.activate++; if (!deferred) bot.emit('entitySleep', bot.entity);},
        chat() {}, clearControlStates() {}, stopDigging() {}, deactivateItem() {},
        modes: {isOn: key => key === 'cheat', pause() {}},
        collectBlock: {cancelTask: async () => {}}, pvp: {stop() {}}});
    bot._client.write = (name, data) => {
        packets.push({name, data});
        if (name === 'entity_action' && data.actionId === 2) queueMicrotask(() => bot.emit('entityWake', bot.entity));
    };
    bedPlugin(bot);
    const agent = {name, bot, clearBotLogs: Agent.prototype.clearBotLogs, requestInterrupt: Agent.prototype.requestInterrupt,
        cleanKill: reason => kills.push(reason), history: {add: async () => {}},
        self_prompter: {isActive: () => false}, isIdle: () => !agent.actions.executing};
    agent.actions = new ActionManager(agent);
    const f = {agent, bot, packets, kills, counts, sleep: () => bot.emit('entitySleep', bot.entity), wake: () => bot.emit('entityWake', bot.entity)};
    fixtures.push(f); return f;
}
try {
    // Both requests enter in the same event-loop turn, before slot acquisition.
    const f = make('bot', true);
    const first = executeCommand(f.agent, '!goToBed', {origin: 'model'});
    const second = executeCommand(f.agent, '!goToBed()', {origin: 'model'});
    assert.match(await bounded(second), /已忽略重复/);
    await flush();
    const record = f.agent.actions.current, sequence = f.agent.actions.sequence;
    assert.equal(f.counts.find, 1); assert.equal(f.counts.activate, 1);
    assert.equal(f.bot.isSleeping, false);
    assert.match(captureRuntimeState(f.agent).action.phase, /尚未确认入睡/);
    assert.match(await executeCommand(f.agent, '!goToBed'), /继续原动作/);
    assert.equal(f.agent.actions.sequence, sequence); assert.equal(record.signal.aborted, false);
    checks.push('Simultaneous and awaiting-confirmation duplicates do not replace the action or click twice');

    f.sleep(); await flush();
    const state = captureRuntimeState(f.agent);
    assert.equal(state.vitals.sleeping, true);
    assert.equal(state.action.label, 'action:goToBed');
    assert.equal(state.action.actualState, '正在睡觉');
    assert.equal(state.action.phase, '已入睡，等待自然醒来');
    assert.match(prepareRuntimePrompt('角色', f.agent), /当前动作：action:goToBed；阶段：已入睡，等待自然醒来；实际状态：正在睡觉；sleeping=true/);
    assert.match(await executeCommand(f.agent, '!goToBed'), /当前已经入睡/);
    assert.equal(f.agent.actions.current, record); assert.equal(record.signal.aborted, false);
    assert.equal(f.packets.length, 0); assert.equal(f.counts.activate, 1);

    // Verify the actual HTTP payload, rather than just the formatting helper.
    process.env.DEEPSEEK_API_KEY = 'unit-sleep-state-key';
    const wire = [];
    const model = new DeepSeek('deepseek-flash', 'https://api.deepseek.com', {}, {publish: () => {}, fetch: async (_url, init) => {
        wire.push(JSON.parse(init.body));
        return new Response(JSON.stringify({id: 'sleep-fixture', choices: [{finish_reason: 'stop', message: {content: '我已经睡着了。'}}]}), {headers: {'content-type': 'application/json'}});
    }});
    const prompter = Object.assign(Object.create(Prompter.prototype), {agent: f.agent, profile: {conversing: '中文角色'},
        convo_examples: null, chat_model: model, checkCooldown: async () => {}, applyMemoryContext: x => x,
        replaceStrings: async x => x, _saveLog: async () => {}});
    await prompter.promptConvo([{role: 'user', content: '现在做什么', currentRound: true}]);
    const payload = wire[0].messages.map(x => x.content).join('\n');
    assert.match(payload, /当前动作：action:goToBed；阶段：已入睡/);
    assert.match(payload, /"sleeping":true/);
    checks.push('A real Prompter → DeepSeek SDK request includes the current sleep action and confirmed sleep state');

    const other = make('DeepSeek');
    const otherSleep = executeCommand(other.agent, '!goToBed'); await flush();
    assert.equal(other.counts.activate, 1); assert.equal(other.bot.isSleeping, true);
    assert.equal(f.agent.actions.current, record); assert.equal(record.signal.aborted, false);
    other.wake(); await bounded(otherSleep);
    checks.push('Sleep guards and pending reservations are isolated per bot');

    f.wake(); await bounded(first);
    assert.equal(f.agent.actions.current, null); assert.equal(f.packets.length, 0);
    const next = executeCommand(f.agent, '!goToBed'); await flush();
    assert.equal(f.counts.activate, 2); f.sleep(); await flush();
    const start = Date.now(); await bounded(f.agent.actions.stop()); await bounded(next);
    assert.equal(f.kills.length, 0); assert.equal(f.agent.actions.current, null);
    assert.equal(f.bot.isSleeping, false);
    assert.equal(f.packets.filter(x => x.name === 'entity_action' && x.data.actionId === 2).length, 1);
    checks.push({name: 'Natural wake permits a new sleep; explicit stop wakes through native Mineflayer and cancels immediately', elapsedMs: Date.now() - start});

    const replacementFixture = make('replacement');
    const before = executeCommand(replacementFixture.agent, '!goToBed'); await flush();
    let replacementStarted = false;
    const replacement = replacementFixture.agent.actions.runAction('action:move', async () => {replacementStarted = true;}, {timeout: -1});
    await bounded(before); await bounded(replacement);
    assert.equal(replacementStarted, true); assert.equal(replacementFixture.kills.length, 0);
    assert.equal(replacementFixture.bot.isSleeping, false);
    checks.push('A different action can replace sleeping without killing the bot process');

    const already = make('already'); already.sleep();
    assert.match(await executeCommand(already.agent, '!goToBed'), /当前已经入睡/);
    assert.equal(already.agent.actions.sequence, 0); assert.equal(already.counts.find, 0);
    await goToBed(already.bot);
    assert.equal(already.counts.find, 0); assert.equal(already.counts.activate, 0);
    checks.push('Already sleeping without an action record is preserved, including direct skill calls');

    const failing = make('failing'); failing.bot.sleep = async () => {throw Error('the bed is occupied');};
    assert.match(await executeCommand(failing.agent, '!goToBed'), /未能入睡/);
    assert.match(await executeCommand(failing.agent, '!goToBed'), /未能入睡/);
    assert.equal(failing.counts.find, 2);
    checks.push('A failed sleep releases its reservation, allowing a real retry');
    const activeSleep = make('wakeCommand');
    const sleeper = executeCommand(activeSleep.agent, '!goToBed'); await flush();
    assert.equal(activeSleep.bot.isSleeping, true);
    await bounded(executeCommand(activeSleep.agent, '!dismount()')); await bounded(sleeper);
    assert.equal(activeSleep.bot.isSleeping, false); assert.equal(activeSleep.kills.length, 0);
    checks.push('The new dismount command can replace an active sleep action and leaves the bot awake without killing it');
    const result = {at: new Date().toISOString(), passed: true, checks};
    fs.writeFileSync(new URL('./sleep-command-test-result.json', import.meta.url), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
} finally {
    for (const {agent} of fixtures) agent.runtimeObservation?.dispose();
}
