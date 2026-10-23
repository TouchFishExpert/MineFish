import assert from 'node:assert/strict';
import fs from 'node:fs';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import '../mindcraft/src/agent/agent.js';
import {getCommandDocs, isAction} from '../mindcraft/src/agent/commands/index.js';
import {nearestEmptyBeds, sleepInNearestEmptyBed} from '../mindcraft/src/agent/library/sleeping.js';
import {leaveBedOrVehicle, ridingState} from '../mindcraft/src/agent/library/riding.js';
import {captureRuntimeState} from '../mindcraft/src/agent/runtime_observation.js';
import {inAction} from '../mindcraft/src/agent/action_context.js';
const require = createRequire(new URL('../mindcraft/package.json', import.meta.url));
const {Vec3} = require('vec3'), registry = require('minecraft-data')('1.21.6');
const Block = require('prismarine-block')(registry), bedPlugin = require('mineflayer/lib/plugins/bed');
const checks = [], bots = [];
function fixture() {
    const bot = new EventEmitter(); bot._client = new EventEmitter(); const packets = [], blocks = new Map(), activated = [];
    Object.assign(bot, {entity: {id: 1, position: new Vec3(0, 64, 0), onGround: true}, registry, entities: {},
        game: {dimension: 'overworld', gameMode: 'survival'}, time: {timeOfDay: 18000}, modes: {pause() {}},
        supportFeature: name => name === 'blockStateId', canDigBlock: () => true, health: 20, food: 20,
        blockAt: p => blocks.get(p.toString()) || null,
        findBlocks: options => [...blocks.values()].filter(options.matching).map(b => b.position).reverse(),
        activateBlock: async block => {activated.push(block.position.x); queueMicrotask(() => bot.emit('entitySleep', bot.entity));
            setTimeout(() => bot.emit('entityWake', bot.entity), 5);},
        setControlState: (key, state) => {packets.push({key, state});}});
    bot._client.write = (name, data) => {packets.push({name, data});
        if (name === 'entity_action' && data.actionId === 2) queueMicrotask(() => bot.emit('entityWake', bot.entity));};
    bedPlugin(bot);
    const bed = (x, occupied = false) => {
        for (const part of ['head', 'foot']) {
            const value = Block.fromProperties(registry.blocksByName.white_bed.id, {facing: 'north', part, occupied: String(occupied)}, 0);
            value.position = new Vec3(x, 64, part === 'head' ? 0 : 1); blocks.set(value.position.toString(), value);
        }
    };
    bots.push(bot); return {bot, blocks, packets, activated, bed};
}
try {
    const f = fixture(); f.bed(1, true); f.bed(4); f.bed(9);
    const bedrock = {name: 'bedrock', position: new Vec3(0, 64, -1)}; f.blocks.set(bedrock.position.toString(), bedrock);
    assert.deepEqual(nearestEmptyBeds(f.bot).map(b => b.position.x), [4, 9]);
    const logs = [];
    await sleepInNearestEmptyBed(f.bot, {navigate: async p => {f.bot.entity.position = p.clone(); return true;}, log: text => logs.push(text)});
    assert.deepEqual(f.activated, [4]);
    const inconsistent = fixture(); inconsistent.bed(2); inconsistent.bed(6);
    const foot = Block.fromProperties(registry.blocksByName.white_bed.id, {facing: 'north', part: 'foot', occupied: 'true'}, 0);
    foot.position = new Vec3(2, 64, 1); inconsistent.blocks.set(foot.position.toString(), foot);
    assert.deepEqual(nearestEmptyBeds(inconsistent.bot).map(b => b.position.x), [6], 'Occupancy on either half excludes the entire bed');
    checks.push('Real 1.21.6 block states and native Mineflayer bed plugin: skip nearest occupied bed, deduplicate halves, exclude bedrock, choose closest empty bed');

    const race = fixture(); race.bed(3); race.bed(7);
    const visited = [];
    await sleepInNearestEmptyBed(race.bot, {navigate: async p => {visited.push(p.x); race.bot.entity.position = p.clone(); if (p.x === 3) race.bed(3, true); return true;}, log() {}});
    assert.deepEqual(visited, [3, 7]); assert.deepEqual(race.activated, [7]);
    const all = fixture(); all.bed(1, true);
    assert.equal(await sleepInNearestEmptyBed(all.bot, {navigate: () => {throw Error('must not navigate');}, log() {}}), false);
    checks.push('Occupancy is rechecked after walking; a newly occupied bed is skipped; all occupied returns an honest failure');

    assert.equal(isAction('!dismount'), true); assert.match(getCommandDocs({blocked_actions: []}), /!dismount/);
    for (const name of ['oak_boat', 'minecart', 'horse']) {
        const f = fixture(), vehicle = {id: 10, name, position: new Vec3(0, 64, 0), passengers: [f.bot.entity, {id: 2}]};
        f.bot.vehicle = vehicle; f.bot.entity.vehicle = vehicle;
        const before = captureRuntimeState({name, bot: f.bot});
        assert.equal(before.posture.mounted, true); assert.equal(before.posture.vehicle.name, name);
        f.bot.setControlState = (key, state) => {
            f.packets.push({key, state});
            if (key === 'sneak' && state) {
                assert.equal(ridingState(f.bot).mounted, true, 'Pressing Shift is not proof of dismount');
                queueMicrotask(() => f.bot._client.emit('set_passengers', {entityId: 10, passengers: [2]}));
            }
        };
        const result = await leaveBedOrVehicle(f.bot);
        assert.match(result, /服务端已确认/); assert.equal(ridingState(f.bot).mounted, false);
        assert.deepEqual(f.packets.filter(p => p.key), [{key: 'sneak', state: false}, {key: 'sneak', state: true}, {key: 'sneak', state: false}]);
        assert.deepEqual(vehicle.passengers.map(e => e.id), [2]);
        const after = captureRuntimeState({name, bot: f.bot}); assert.equal(after.posture.mounted, false);
        // Each observation belongs to its own agent; release both passive samplers.
        f.bot.emit('end');
    }
    checks.push('Boat/minecart/horse use Shift, preserve other passengers, wait for actual set_passengers removal; mounted state is exposed to model snapshots');

    const sleeping = fixture(); sleeping.bot.emit('entitySleep', sleeping.bot.entity);
    assert.match(await leaveBedOrVehicle(sleeping.bot), /已主动下床/);
    assert.equal(sleeping.bot.isSleeping, false); assert.ok(sleeping.packets.some(p => p.data?.actionId === 2));
    const stuck = fixture(); stuck.bot.vehicle = {id: 20, name: 'horse'};
    await assert.rejects(leaveBedOrVehicle(stuck.bot, {timeoutMs: 30}), /timed out/);
    assert.equal(ridingState(stuck.bot).mounted, true); assert.deepEqual(stuck.packets.at(-1), {key: 'sneak', state: false});
    const controller = new AbortController();
    const cancelled = inAction({bot: stuck.bot, signal: controller.signal}, () => leaveBedOrVehicle(stuck.bot));
    controller.abort(new Error('test cancellation')); await assert.rejects(cancelled, /test cancellation/);
    assert.deepEqual(stuck.packets.at(-1), {key: 'sneak', state: false});
    checks.push('Native wake confirms active exit from bed; no server reply yields timeout instead of success; cancellation releases Shift and listeners');
    const report = {at: new Date().toISOString(), passed: true, checks};
    fs.writeFileSync(new URL('./empty-bed-dismount-test-result.json', import.meta.url), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
} finally {for (const bot of bots) bot.emit('end');}
