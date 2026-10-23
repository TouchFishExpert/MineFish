import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { installEatingCoordinator, consumeItem, getEatingState } from '../mindcraft/src/agent/library/eating.js';
import {Agent} from '../mindcraft/src/agent/agent.js';
import {ActionManager} from '../mindcraft/src/agent/action_manager.js';
import {setSettings} from '../mindcraft/src/agent/settings.js';
import {getCommand} from '../mindcraft/src/agent/commands/index.js';
const require = createRequire(new URL('../mindcraft/package.json', import.meta.url));
const { plugin } = require('mineflayer-auto-eat');

function createBot(loadAutoEat = true) {
    const bot = new EventEmitter();
    const pork = { name: 'cooked_porkchop', count: 29, type: 1 };
    const slots = []; slots[36] = pork;
    Object.assign(bot, {
        username: 'bot', _client: new EventEmitter(), entity: { id: 42 }, food: 14, health: 6, game: { gameMode: 'survival' }, interrupt_code: false,
        registry: { foodsByName: { cooked_porkchop: { foodPoints: 8, saturation: 12.8 } } },
        inventory: { slots, inventoryStart: 9, items: () => slots.slice(9, 45).filter(Boolean), findInventoryItem: name => slots.slice(9, 45).find(item => item?.name === name) },
        supportFeature: () => false, getEquipmentDestSlot: hand => hand === 'off-hand' ? 45 : 36,
        equip: async (item, hand) => { const slot = hand === 'off-hand' ? 45 : 36; const previousSlot = slots.indexOf(item); if (previousSlot !== slot) { slots[previousSlot] = slots[slot]; slots[slot] = item; } },
        activateCalls: 0, deactivateCalls: 0,
        activateItem() { this.activateCalls++; }, deactivateItem() { this.deactivateCalls++; },
        waitForTicks: async () => {}
    });
    Object.defineProperty(bot, 'heldItem', { get: () => slots[36] });
    if (loadAutoEat) plugin(bot);
    bot.consume = async () => {
        bot.activateItem(); await sleep(15);
        pork.count--; bot.food = 20;
        bot._client.emit('entity_status', { entityId: 42, entityStatus: 9 });
    };
    return bot;
}

// Match Mineflayer's deferred plugin lifecycle, rather than assuming loadPlugin is synchronous.
const deferred = createBot(false);
require('mineflayer/lib/plugin_loader.js')(deferred, {});
deferred.loadPlugin(plugin);
deferred.loadPlugin(installEatingCoordinator);
assert.equal(deferred.autoEat, undefined);
deferred.emit('inject_allowed');
assert.equal(getEatingState(deferred).coordinated, true);
assert.equal(deferred.autoEat.options.eatingTimeout, 3000);

// Reproduce the actual installed plugin bug using the old application assignment.
const broken = createBot(false);
require(fileURLToPath(new URL('./backups/planting-timeout-20261020/mindcraft/node_modules/mineflayer-auto-eat/dist/index.js', import.meta.url))).plugin(broken);
broken.autoEat.options = { priority: 'foodPoints', startAt: 14, bannedFood: ['rotten_flesh'] };
assert.equal(broken.autoEat.options.eatingTimeout, undefined);
let prematureFinish = false;
broken.on('autoeat_finished', () => { prematureFinish = true; });
await broken.autoEat.eat();
assert.equal(prematureFinish, true);
assert.equal(broken.autoEat.isEating, false);
assert.equal(broken.food, 14, 'The plugin claimed completion without receiving any server event or gaining food');

const offhandOnly = createBot();
installEatingCoordinator(offhandOnly);
offhandOnly.autoEat.options.eatingTimeout = 10;
let falseFinish = false;
offhandOnly.on('autoeat_finished', () => {falseFinish = true;});
await assert.rejects(offhandOnly.autoEat.eat(), {name: 'ConsumptionTimeout'});
assert.equal(falseFinish, false, 'Moving a food stack to offhand does not mean it was consumed');
assert.equal(offhandOnly.autoEat.isEating, false);

const bot = createBot();
installEatingCoordinator(bot);
assert.equal(bot.autoEat.options.eatingTimeout, 3000);
assert.equal(bot.autoEat.options.offhand, true);
assert.equal(bot.autoEat.options.checkOnItemPickup, true);
assert.equal(bot.autoEat.options.equipOldItem, true);
assert.equal(bot.autoEat.options.priority, 'foodPoints');
// Health events during manual consumption must not restart automatic use and cancel it.
const manual = consumeItem(bot, 'cooked_porkchop');
await sleep(2);
const releasesBefore = bot.deactivateCalls;
assert.equal(await bot.autoEat.eat(), false);
assert.equal(bot.deactivateCalls, releasesBefore);
bot.emit('health');
assert.equal((await manual).success, true);
assert.equal(bot.activateCalls, 1);
assert.equal(bot._client.listenerCount('entity_status'), 2, 'Only the plugin and diagnostic listeners remain after manual cleanup');
assert.equal((await consumeItem(bot, 'cooked_porkchop')).success, false, 'Full hunger must not start another use');
bot.food = 14;
bot.inventory.slots[10] = { name: 'wheat', count: 11, type: 2 };
assert.equal((await consumeItem(bot, 'wheat')).message.includes('not directly edible'), true);

// Manual requests wait for an already-running automatic meal, rather than stealing its hand.
const autoFirst = createBot();
installEatingCoordinator(autoFirst);
autoFirst.autoEat.options.eatingTimeout = 100;
const autoTask = autoFirst.autoEat.eat();
await sleep(2);
const queued = consumeItem(autoFirst, 'cooked_porkchop');
await sleep(2);
assert.equal(autoFirst.activateCalls, 1);
autoFirst._client.emit('entity_status', { entityId: 42, entityStatus: 9 });
await autoTask;
assert.equal((await queued).success, true);
assert.equal(autoFirst.activateCalls, 2);

// A resolved native promise alone is not evidence of successful eating.
const cancelled = createBot(); installEatingCoordinator(cancelled);
cancelled.consume = async () => {};
await assert.rejects(consumeItem(cancelled, 'cooked_porkchop'), {name: 'ConsumptionUnconfirmed'});
cancelled.consume = async () => { throw Error('Promise timed out.'); };
await assert.rejects(consumeItem(cancelled, 'cooked_porkchop'), {name: 'ConsumptionTimeout'});
assert.equal(cancelled._client.listenerCount('entity_status'), 2);
cancelled.consume = async () => { cancelled.inventory.slots[36].count--; };
assert.equal((await consumeItem(cancelled, 'cooked_porkchop')).success, true, 'The eating gate must release after a timeout');

// A real five-second deadline, including a plugin promise that never settles.
const stalled = createBot(); installEatingCoordinator(stalled);
stalled.consume = () => new Promise(() => {});
const timeoutStarted = performance.now();
await assert.rejects(consumeItem(stalled, 'cooked_porkchop'), {name: 'ConsumptionTimeout'});
const elapsed = performance.now() - timeoutStarted;
assert.ok(elapsed >= 4900 && elapsed < 5700, `Expected five-second error return, got ${elapsed}ms`);
assert.equal(getEatingState(stalled).manualQueued, 0);
assert.equal(stalled._client.listenerCount('entity_status'), 2);
stalled.consume = async () => {stalled.inventory.slots[36].count--;};
const successStarted = performance.now();
assert.equal((await consumeItem(stalled, 'cooked_porkchop')).success, true);
assert.ok(performance.now() - successStarted < 200, 'Success must not wait for the deadline');

const lateEquip = createBot(); installEatingCoordinator(lateEquip);
let releaseEquip, lateUses = 0;
lateEquip.equip = () => new Promise(resolve => {releaseEquip = resolve;});
lateEquip.consume = async () => {lateUses++;};
await assert.rejects(consumeItem(lateEquip, 'cooked_porkchop', {timeoutMs: 35}), {name: 'ConsumptionTimeout'});
releaseEquip(); await sleep(15);
assert.equal(lateUses, 0, 'A late equipment result cannot start consumption after timeout');

const automatic = createBot(); installEatingCoordinator(automatic);
automatic.modes = {behavior_log: ''}; automatic.autoEat.options.eatingTimeout = 25;
let finished = 0;
automatic.on('autoeat_finished', () => finished++);
const automaticError = new Promise(resolve => automatic.once('autoeat_error', resolve));
automatic.emit('health');
assert.equal((await automaticError).name, 'ConsumptionTimeout');
assert.equal(finished, 0);
assert.match(automatic.modes.behavior_log, /ConsumptionTimeout/);

const automaticEquip = createBot(); installEatingCoordinator(automaticEquip);
automaticEquip.autoEat.options.attemptTimeout = 35;
let releaseAutomaticEquip;
automaticEquip.equip = () => new Promise(resolve => {releaseAutomaticEquip = resolve;});
await assert.rejects(automaticEquip.autoEat.eat(), {name: 'ConsumptionTimeout'});
releaseAutomaticEquip(); await sleep(15);
assert.equal(automaticEquip.activateCalls, 0);
assert.equal(automaticEquip.autoEat.isEating, false);

// Exercise the real command -> ActionManager -> history -> next model request path.
const feedbackBot = createBot(); installEatingCoordinator(feedbackBot);
feedbackBot.output = '';
feedbackBot.modes = {flushBehaviorLog: () => ''};
let uses = 0;
feedbackBot.consume = async () => {if (++uses === 1) throw Error('Promise timed out.'); feedbackBot.inventory.slots[36].count--;};
const turns = []; let modelCalls = 0;
const agent = {name: 'bot', bot: feedbackBot, responseEpoch: 0, shut_up: false,
    checkTaskDone: async () => {}, clearBotLogs() {feedbackBot.output = ''; feedbackBot.interrupt_code = false;},
    requestInterrupt() {feedbackBot.interrupt_code = true;}, routeResponse: async () => {},
    self_prompter: {isActive: () => true, shouldInterrupt: () => false, handleUserPromptedCmd() {}},
    history: {add: async (role, content) => {turns.push({role, content});}, save() {}, getHistory: () => structuredClone(turns)},
    isIdle() {return !this.actions.executing;},
    prompter: {async promptConvo(history) {
        modelCalls++;
        if (modelCalls === 1) return '!consume("cooked_porkchop")';
        if (modelCalls === 2) {assert.ok(history.some(turn => turn.role === 'system' && turn.content.includes('ConsumptionTimeout')), 'Timeout must reach the next model request'); return '!consume("cooked_porkchop")';}
        assert.ok(history.some(turn => turn.role === 'system' && turn.content.includes('Consumed cooked_porkchop')));
        return '重试后已经吃好了。';
    }}
};
agent.actions = new ActionManager(agent);
setSettings({max_commands: 3, translate_messages: false});
// The fixture has no Minecraft connection to initialize mcdata; the edible item is validated by consumeItem itself.
const parameter = getCommand('!consume').params.item_name;
const originalType = parameter.type;
try {parameter.type = 'string'; await Agent.prototype.handleMessage.call(agent, 'system', '进食测试');}
finally {parameter.type = originalType;}
assert.equal(modelCalls, 3); assert.equal(uses, 2);
console.log('PASS: original premature-finish reproduced; manual/automatic exclusion; consumption evidence; real five-second deadline; success returns immediately; native timeout remains an error; late equipment cannot start use; automatic timeout never emits finished and reaches behavior context; state and listeners released.');
