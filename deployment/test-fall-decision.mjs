import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {assessDigDown, estimateFallDamage, previewDigDown, confirmDigDown, digDownWithAssessment} from '../mindcraft/src/agent/library/fall_risk.js';
import {Agent} from '../mindcraft/src/agent/agent.js';
import {executeCommand, getCommandDocs, parseCommandMessage} from '../mindcraft/src/agent/commands/index.js';
import {ActionManager} from '../mindcraft/src/agent/action_manager.js';
import {setSettings} from '../mindcraft/src/agent/settings.js';
const require = createRequire(new URL('../mindcraft/package.json', import.meta.url));
const registry = require('prismarine-registry')('1.21.6');
const Item = require('prismarine-item')(registry);
const {Vec3} = require('vec3');

function make(height = 5, {health = 20, landing = 'stone', unknown = false, complete = true} = {}) {
    const bot = new EventEmitter(), changed = new Map();
    const floorY = 69 - height;
    let digs = 0;
    const block = (name, pos) => ({name, stateId: registry.blocksByName[name]?.defaultState ?? 0, position: pos,
        boundingBox: ['air', 'water', 'lava'].includes(name) ? 'empty' : 'block',
        shapes: ['air', 'water', 'lava'].includes(name) ? [] : [[0, 0, 0, 1, 1, 1]], canHarvest: () => true});
    Object.assign(bot, {registry, version: '1.21.6', username: 'fixture', health, output: '', interrupt_code: false,
        entity: {position: new Vec3(.5, 70, .5), onGround: true, attributes: {}, effects: {}},
        game: {gameMode: 'survival', minY: -64}, inventory: {slots: []}, heldItem: null,
        modes: {isOn: () => false}, tool: {equipForBlock: async () => {}},
        blockAt(pos) {
            if (unknown && pos.y < 68) return null;
            const key = `${pos.x},${pos.y},${pos.z}`;
            if (changed.has(key)) return block(changed.get(key), pos);
            return block(pos.y === 69 ? 'stone' : pos.y === floorY ? landing : pos.y < floorY ? 'stone' : 'air', pos);
        },
        async dig(target) {
            digs++;
            changed.set(`${target.position.x},${target.position.y},${target.position.z}`, 'air');
            if (complete) {
                const report = estimateFallDamage(bot, bot.entity.position.y - (floorY + 1), landing);
                bot.entity.position.y = floorY + 1;
                bot.health = Math.max(0, bot.health - report.estimatedDamageHp);
                bot.entity.onGround = true;
            }
        }});
    const agent = {name: 'fixture', bot, blocked_actions: [],
        clearBotLogs() {bot.output = ''; bot.interrupt_code = false;},
        requestInterrupt() {bot.interrupt_code = true;},
        isIdle() {return !this.actions.executing;}, self_prompter: {isActive: () => false},
        cleanKill(reason) {throw Error(reason);}};
    agent.actions = new ActionManager(agent);
    return {bot, agent, changed, get digs() {return digs;}};
}
const extractToken = message => message.match(/!confirmDigDown\("([a-f0-9-]{36})"\)/)?.[1];

for (const [height, damageHp] of [[1, 0], [3, 0], [5, 2], [10, 7], [23, 20]]) {
    const fixture = make(height);
    const report = assessDigDown(fixture.bot);
    assert.equal(report.known, true); assert.equal(report.damage.heightBlocks, height);
    assert.equal(report.damage.estimatedDamageHp, damageHp);
    assert.equal(report.damage.estimatedDamageHearts, damageHp / 2);
    assert.equal(report.damage.potentiallyLethal, height === 23);
    assert.equal(fixture.digs, 0);
}
const armor = make(10);
armor.bot.inventory.slots[8] = new Item(registry.itemsByName.diamond_boots.id, 1);
armor.bot.inventory.slots[8].enchants = [{name: 'feather_falling', lvl: 4}];
assert.equal(estimateFallDamage(armor.bot, 10, 'stone').estimatedDamageHp, 3.64);
for (const slot of [5, 6, 7]) armor.bot.inventory.slots[slot] = {enchants: [{name: 'protection', lvl: 4}]};
assert.equal(estimateFallDamage(armor.bot, 10, 'stone').estimatedDamageHp, 1.4);
armor.bot.entity.effects[registry.effectsByName.Resistance.id] = {amplifier: 0, duration: 1000};
assert.equal(estimateFallDamage(armor.bot, 10, 'stone').estimatedDamageHp, 1.12);
armor.bot.entity.effects[registry.effectsByName.SlowFalling.id] = {amplifier: 0, duration: 1000};
assert.equal(estimateFallDamage(armor.bot, 10, 'stone').estimatedDamageHp, 0);
const custom = make(10);
custom.bot.entity.attributes = {'minecraft:safe_fall_distance': {value: 4, modifiers: [{operation: 0, amount: 1}]}, 'minecraft:fall_damage_multiplier': {value: 0.5, modifiers: []}};
assert.equal(estimateFallDamage(custom.bot, 10, 'stone').baseDamageHp, 3);

// Exercise actual command parsing, ActionManager output truncation, tool equip and skills.breakBlockAt.
const fixture = make(10);
let result = await executeCommand(fixture.agent, '!digDown(1)');
assert.equal(fixture.digs, 0, 'First request only reports a drop; it cannot dig before model choice');
assert.equal(result.includes('has been shortened'), false);
assert.match(result, /高度10格/); assert.match(result, /7HP\/3.5颗心/); assert.match(result, /剩余13HP/);
let token = extractToken(result); assert.ok(token, 'Confirmation ID reaches the model through real action output');
assert.deepEqual(parseCommandMessage(`!confirmDigDown("${token}")`).args, [token]);
result = await executeCommand(fixture.agent, `!confirmDigDown("${token}")`);
assert.equal(fixture.digs, 1); assert.equal(fixture.bot.health, 13); assert.match(result, /已落地/);
await executeCommand(fixture.agent, `!confirmDigDown("${token}")`); assert.equal(fixture.digs, 1, 'A confirmation is single use');
const docs = getCommandDocs(fixture.agent); assert.ok(docs.includes('!inspectDrop') && docs.includes('!confirmDigDown'));

// Even a predicted lethal result is a model choice, not a hard HP/height veto.
const lethal = make(10, {health: 3});
token = extractToken(previewDigDown(lethal.bot));
await confirmDigDown(lethal.bot, token, async (bot, x, y, z) => {await bot.dig(bot.blockAt(new Vec3(x, y, z))); return true;});
assert.equal(lethal.digs, 1); assert.equal(lethal.bot.health, 0); assert.match(lethal.bot.output, /死亡/);

for (const change of ['health', 'position', 'terrain']) {
    const stale = make(5); token = extractToken(previewDigDown(stale.bot));
    if (change === 'health') stale.bot.health--;
    if (change === 'position') stale.bot.entity.position.x += .1;
    if (change === 'terrain') stale.changed.set('0,64,0', 'magma_block');
    let performed = false;
    assert.equal(await confirmDigDown(stale.bot, token, () => {performed = true;}), false);
    assert.equal(performed, false); assert.match(stale.bot.output, /旧评估不再适用/);
}
for (const options of [{unknown: true}, {landing: 'water'}, {landing: 'lava'}]) {
    const unknown = make(5, options); assert.equal(extractToken(previewDigDown(unknown.bot)), undefined); assert.equal(unknown.digs, 0);
}
const edge = make(5); edge.bot.entity.position.x = .05;
assert.equal(assessDigDown(edge.bot).known, false, 'Adjacent support is reported instead of promising a fall that cannot happen');
const one = make(1); assert.equal(await digDownWithAssessment(one.bot, 1, async (bot, x, y, z) => {await bot.dig(bot.blockAt(new Vec3(x, y, z))); return true;}), true);
const aborted = make(5); token = extractToken(previewDigDown(aborted.bot)); aborted.bot.interrupt_code = true;
await confirmDigDown(aborted.bot, token, () => {throw Error('Must not dig after cancellation');}); assert.equal(aborted.digs, 0);
const timeout = make(5, {complete: false}); token = extractToken(previewDigDown(timeout.bot));
await assert.rejects(confirmDigDown(timeout.bot, token, async () => true, {timeoutMs: 25, pollMs: 5}), {name: 'DropLandingTimeout'});

// The real agent must hand the estimate to the next model turn before executing the chosen drop.
const feedback = make(5); const turns = []; let modelCalls = 0;
Object.assign(feedback.agent, {responseEpoch: 0, shut_up: false, checkTaskDone: async () => {}, routeResponse: async () => {},
    self_prompter: {isActive: () => false, shouldInterrupt: () => false, handleUserPromptedCmd() {}},
    history: {add: async (role, content) => turns.push({role, content}), save() {}, getHistory: () => structuredClone(turns)},
    prompter: {async promptConvo(history) {
        modelCalls++;
        if (modelCalls === 1) return '!inspectDrop';
        if (modelCalls === 2) {
            const assessment = history.find(turn => turn.role === 'system' && turn.content.includes('落差评估'))?.content;
            assert.ok(assessment); assert.match(assessment, /2HP\/1颗心/); assert.match(assessment, /剩余18HP/);
            assert.equal(feedback.digs, 0); return `!confirmDigDown("${extractToken(assessment)}")`;
        }
        assert.ok(history.some(turn => turn.role === 'system' && turn.content.includes('已落地')));
        return '已经落地了。';
    }}});
feedback.bot.modes.flushBehaviorLog = () => '';
setSettings({max_commands: 3, translate_messages: false, show_command_syntax: 'full'});
await Agent.prototype.handleMessage.call(feedback.agent, 'system', '评估落差后自行决定是否落下');
assert.equal(modelCalls, 3); assert.equal(feedback.digs, 1);
console.log('PASS: Java 1.21.6 3/5/10-block damage, real enchantments, effects/attributes, complete model-visible assessment, command parsing and actual action/skill execution, model-confirmed drops including lethal estimates, replay/stale rejection, liquids/unloaded/adjacent support, immediate landing completion, cancellation and explicit local landing timeout.');
