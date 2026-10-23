import '../mindcraft/src/agent/agent.js';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {mock} from 'node:test';
import fs from 'node:fs';
import {Agent} from '../mindcraft/src/agent/agent.js';
import {ActionManager} from '../mindcraft/src/agent/action_manager.js';
import {containerInteraction} from '../mindcraft/src/agent/action_context.js';
const require = createRequire(new URL('../mindcraft/package.json', import.meta.url));
const {Vec3} = require('vec3');
const {pathfinder, goals} = require('mineflayer-pathfinder');
const registry = require('prismarine-registry')('1.21.6');
const inventoryPlugin = require('mineflayer/lib/plugins/inventory.js');
const chestPlugin = require('mineflayer/lib/plugins/chest.js');
const Block = require('prismarine-block')(registry);
const Item = require('prismarine-item')(registry);
const checks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const flush = async () => {for (let n = 0; n < 40; n++) await Promise.resolve();};
async function bounded(work) {let timer; try {return await Promise.race([work, new Promise((resolve, reject) => {timer = setTimeout(() => reject(Error('Cancellation failed to settle within 1200ms')), 1200);})]);} finally {clearTimeout(timer);}}
function make() {
    const bot = new EventEmitter(), packets = [], kills = [];
    Object.assign(bot, {registry, version: '1.21.6', _client: new EventEmitter(), supportFeature: registry.supportFeature,
        entity: {position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0)}, output: '', interrupt_code: false,
        clearControlStates() {}, stopDigging() {}, collectBlock: {cancelTask: async () => {}}, pvp: {stop() {}},
        modes: {isOn: () => false}, blockAt: () => null});
    bot._client.write = (name, data) => {packets.push({name, data});};
    inventoryPlugin(bot, {hideErrors: true}); pathfinder(bot); chestPlugin(bot);
    const agent = {bot, clearBotLogs: Agent.prototype.clearBotLogs, requestInterrupt: Agent.prototype.requestInterrupt,
        cleanKill: reason => kills.push(reason), history: {add: async () => {}},
        isIdle: () => !agent.actions.executing, self_prompter: {isActive: () => false}};
    agent.actions = new ActionManager(agent);
    const chest = Block.fromStateId(registry.blocksByName.chest.minStateId, 0); chest.position = new Vec3(0, 64, 0);
    return {bot, agent, chest, packets, kills};
}

// Actual native window wait must cancel and remove its listener, without killing.
{
    const {bot, agent, chest, kills} = make(); bot.activateBlock = () => {};
    let continued = false;
    const first = agent.actions.runAction('action:viewChest', async () => {await bot.openContainer(chest); continued = true;}, {timeout: -1});
    await flush(); assert.equal(bot.listenerCount('windowOpen'), 1);
    const started = Date.now();
    const next = agent.actions.runAction('action:next', async () => {}, {timeout: -1});
    assert.equal((await bounded(first)).interrupted, true); await bounded(next);
    assert.equal(bot.listenerCount('windowOpen'), 0); assert.equal(continued, false); assert.equal(kills.length, 0);
    bot.emit('windowOpen', {}); await flush(); assert.equal(continued, false);
    checks.push({name: 'open-container abort + no late continuation/listener', elapsedMs: Date.now() - started});
}
// A raced library completion cannot release the action slot while its actual
// activation is still pending. A stale continuation cannot emit a block packet.
{
    const {bot, agent, chest, packets} = make(); let releaseActivation;
    bot.activateBlock = async () => {await new Promise(resolve => {releaseActivation = resolve;}); bot._client.write('block_place', {});};
    const first = agent.actions.runAction('action:open', () => bot.openContainer(chest), {timeout: -1});
    await flush(); let nextStarted = false;
    const next = agent.actions.runAction('action:replacement', async () => {nextStarted = true;}, {timeout: -1});
    await flush(); assert.equal(nextStarted, false); assert.equal(agent.actions.executing, true);
    releaseActivation(); await bounded(first); await bounded(next);
    assert.equal(packets.filter(packet => packet.name === 'block_place').length, 0);
    checks.push({name: 'drain actual operation before handoff; no stale mutation packet'});
}
{
    const {bot, agent, chest, packets} = make(); let finishLook;
    bot.look = async (_yaw, _pitch, force) => {if (force) {finishLook?.(); return;} await new Promise(resolve => {finishLook = resolve;});};
    bot.activateBlock = async () => {await bot.look(1, 0, false); bot._client.write('block_place', {});};
    const first = agent.actions.runAction('action:open', () => bot.openContainer(chest), {timeout: -1});
    await flush(); const next = agent.actions.runAction('action:next', async () => {}, {timeout: -1});
    assert.equal((await bounded(first)).interrupted, true); await bounded(next);
    assert.equal(packets.filter(packet => packet.name === 'block_place').length, 0);
    checks.push({name: 'cancel open releases native smooth-look wait before handoff'});
}
{
    const {bot, agent, kills} = make();
    const first = agent.actions.runAction('action:navigate', () => bot.pathfinder.goto(new goals.GoalNear(30, 64, 0, 1)), {timeout: -1});
    await flush(); assert.equal(bot.listenerCount('goal_updated'), 1);
    const start = Date.now(); const stopped = agent.actions.stop();
    assert.equal((await bounded(first)).interrupted, true); await bounded(stopped);
    assert.equal(bot.pathfinder.goal, null); assert.equal(bot.listenerCount('goal_updated'), 0); assert.equal(kills.length, 0);
    checks.push({name: 'actual pathfinder goto cancellation without movement progress', elapsedMs: Date.now() - start});
}
{
    const {agent} = make(); const started = []; let active = 0, peak = 0;
    const requests = Array.from({length: 50}, (_, index) => agent.actions.runAction(`action:${index}`, async () => {
        started.push(index); peak = Math.max(peak, ++active); await delay(2); --active;
    }, {timeout: -1}));
    await bounded(Promise.all(requests));
    assert.equal(peak, 1); assert.deepEqual(started, [49]); assert.equal(agent.actions.executing, false);
    checks.push({name: '50 simultaneous requests: one action slot, newest pending request wins', peak});
}
{
    const {bot, agent} = make(); let finishOld, reachedNew = false;
    const first = agent.actions.runAction('action:old', () => new Promise(resolve => {
        finishOld = resolve; bot._actionSignal.addEventListener('abort', () => resolve(), {once: true});
    }), {timeout: -1});
    await flush();
    const queued = agent.actions.runAction('action:queued', async () => {reachedNew = true;}, {timeout: -1});
    await agent.actions.stop(); await bounded(first); await bounded(queued); finishOld();
    assert.equal(reachedNew, false); assert.equal(agent.actions.pendingActions, 0);
    checks.push({name: 'explicit stop invalidates queued actions'});
}
{
    const {bot, agent, chest, kills} = make(); bot.activateBlock = () => {};
    const start = Date.now();
    const result = await bounded(agent.actions.runAction('action:open', () => containerInteraction(bot, () => bot.openContainer(chest), 60), {timeout: -1}));
    assert.equal(result.success, false); assert.equal(result.interrupted, false); assert.match(result.message, /ContainerTimeout/);
    assert.equal(bot.listenerCount('windowOpen'), 0); assert.equal(kills.length, 0);
    checks.push({name: 'local container deadline returns failure, never a minimum wait', elapsedMs: Date.now() - start});
}
{
    const {bot, agent, chest, packets} = make();
    const window = require('prismarine-windows')('1.21.6').createWindow(2, 'minecraft:generic_9x3', 'Chest');
    window.updateSlot(window.inventoryStart, new Item(registry.itemsByName.potato.id, 4));
    bot.quickBarSlot = 0; bot.QUICK_BAR_START = 36;
    bot.activateBlock = () => {bot.currentWindow = window; bot.emit('windowOpen', window);};
    const start = Date.now();
    const result = await bounded(agent.actions.runAction('action:deposit', () => containerInteraction(bot, async () => {
        const opened = await bot.openContainer(chest); await opened.deposit(registry.itemsByName.potato.id, null, 2);
    }), {timeout: -1}));
    assert.equal(result.success, true); assert.equal(window.containerItems().reduce((sum, item) => sum + item.count, 0), 2);
    assert.ok(Date.now() - start < 1000); assert.equal(bot.currentWindow, null);
    assert.ok(packets.some(packet => packet.name === 'window_click'));
    checks.push({name: 'actual native container deposit succeeds and closes immediately', elapsedMs: Date.now() - start});
}
// A transfer cancelled after its first click must not execute later clicks.
{
    const {bot, agent, chest, packets} = make();
    const window = require('prismarine-windows')('1.21.6').createWindow(3, 'minecraft:generic_9x3', 'Chest');
    window.updateSlot(window.inventoryStart, new Item(registry.itemsByName.potato.id, 4));
    bot.quickBarSlot = 0; bot.QUICK_BAR_START = 36;
    bot.activateBlock = () => {bot.currentWindow = window; bot.emit('windowOpen', window);};
    const write = bot._client.write;
    bot._client.write = (name, data) => {write(name, data); if (name === 'window_click') agent.actions.interruptCurrent();};
    const result = await bounded(agent.actions.runAction('action:deposit', () => containerInteraction(bot, async () => {
        const opened = await bot.openContainer(chest); await opened.deposit(registry.itemsByName.potato.id, null, 2);
    }), {timeout: -1}));
    assert.equal(result.interrupted, true); assert.equal(packets.filter(packet => packet.name === 'window_click').length, 1);
    checks.push({name: 'cancel during actual transfer prevents subsequent inventory clicks'});
}
{
    const {bot, agent, packets} = make();
    const {CollectBlock} = require('mineflayer-collectblock/lib/CollectBlock.js');
    const {Targets} = require('mineflayer-collectblock/lib/Targets.js');
    const block = Block.fromStateId(registry.blocksByName.oak_log.defaultState, 0); block.position = new Vec3(1, 64, 0);
    let finishEquip, digs = 0;
    bot.world = {}; bot.blockAt = () => block; bot.pathfinder.goto = async () => {};
    bot.tool = {equipForBlock: async () => {await new Promise(resolve => {finishEquip = resolve;}); bot._client.write('held_item_slot', {});}};
    bot.dig = async () => {digs++;};
    bot.collectBlock = Object.assign(Object.create(CollectBlock.prototype), {bot, targets: new Targets(bot), movements: null, chestLocations: [], itemFilter: () => false});
    const first = agent.actions.runAction('action:collectBlocks', () => bot.collectBlock.collect(block), {timeout: -1});
    await flush(); assert.equal(typeof finishEquip, 'function');
    let replaced = false;
    const next = agent.actions.runAction('action:replacement', async () => {replaced = true;}, {timeout: -1});
    await flush(); assert.equal(replaced, false);
    finishEquip(); await bounded(first); await bounded(next);
    assert.equal(digs, 0); assert.equal(packets.filter(packet => packet.name === 'held_item_slot').length, 0);
    assert.equal(bot.collectBlock.activeCollection, null);
    assert.equal(bot.listenerCount('itemDrop'), 0);
    checks.push({name: 'actual collector cancellation drains delayed equipment; no late dig/equip/pickup'});
}
{
    const one = make(), two = make(); let active = 0, peak = 0;
    const work = async () => {peak = Math.max(peak, ++active); await delay(10); active--;};
    await bounded(Promise.all([one.agent.actions.runAction('action:one', work), two.agent.actions.runAction('action:two', work)]));
    assert.equal(peak, 2); checks.push({name: 'different bots can act concurrently', peak});
}
{
    mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date'], now: 100000});
    try {
        const {bot, agent} = make();
        const request = agent.actions.runAction('action:stalled', () => bot.pathfinder.goto(new goals.GoalNear(30, 64, 0, 1)), {timeout: -1});
        await flush();
        for (let n = 0; n < 90; n++) {mock.timers.tick(100); await flush();}
        const result = await request;
        assert.equal(result.success, false); assert.match(result.message, /NavigationStalled/);
        assert.equal(bot.listenerCount('goal_updated'), 0);
        checks.push({name: 'navigation without progress returns NavigationStalled and cleans listeners'});
    } finally {mock.timers.reset();}
}
const result = {at: new Date().toISOString(), passed: true, checks};
fs.writeFileSync(new URL('./action-cancellation-test-result.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
