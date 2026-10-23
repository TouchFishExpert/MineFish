import '../mindcraft/src/agent/agent.js';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {plantCrop} from '../mindcraft/src/agent/library/farming.js';
import {placeBlock} from '../mindcraft/src/agent/library/skills.js';
const require = createRequire(new URL('../mindcraft/package.json', import.meta.url));
const registry = require('prismarine-registry')('1.21.6');
const Item = require('prismarine-item')(registry);
const {Vec3} = require('vec3');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function make({confirm = true, occupied = false, soilName = 'farmland'} = {}) {
    const bot = new EventEmitter();
    const soil = {name: soilName, position: new Vec3(0, 62, 0)};
    let above = {name: occupied ? 'potatoes' : 'air', position: new Vec3(0, 63, 0)};
    Object.assign(bot, {version: '1.21.6', registry, _client: new EventEmitter(), username: 'testbot', output: '', QUICK_BAR_START: 36,
        entity: {id: 1, position: new Vec3(.5, 62.9375, .5), eyeHeight: 1.62},
        game: {gameMode: 'survival'}, supportFeature: feature => registry.supportFeature(feature),
        modes: {isOn: () => false}, lookAt: async () => {}, swingArm() {},
        findBlocks: () => [soil.position],
        blockAt(pos) {if (pos.x === 0 && pos.z === 0 && pos.y === 62) return soil; if (pos.x === 0 && pos.z === 0 && pos.y === 63) return above; return {name: 'air', position: pos};},
        async dig() {throw Error('Planting must never dig');}});
    const packets = [];
    bot._client.write = (name, data) => {
        packets.push({name, data});
        if (name === 'block_place' && confirm) {
            const crop = {beetroot_seeds: 'beetroots', wheat_seeds: 'wheat', carrot: 'carrots', potato: 'potatoes', melon_seeds: 'melon_stem'}[bot.heldItem.name];
            const old = above; above = {name: crop, position: old.position};
            bot.emit('blockUpdate', old, above);
        }
    };
    require('mineflayer/lib/plugins/inventory')(bot, {});
    bot.quickBarSlot = 0;
    bot.equip = async item => {bot.inventory.updateSlot(36, item);};
    function seed(name) {bot.inventory.updateSlot(36, new Item(registry.itemsByName[name].id, 6));}
    seed('beetroot_seeds');
    return {bot, soil, packets, seed, get above() {return above;}};
}
for (const [name, item, crop] of [['beetroot_seeds', 'beetroot_seeds', 'beetroots'], ['carrots', 'carrot', 'carrots'], ['potato', 'potato', 'potatoes'], ['wheat_seeds', 'wheat_seeds', 'wheat'], ['melon_seeds', 'melon_seeds', 'melon_stem']]) {
    const test = make(); test.seed(item);
    assert.equal(await placeBlock(test.bot, name, .5, 62.9375, .5), true);
    assert.equal(test.soil.name, 'farmland'); assert.equal(test.above.name, crop);
    assert.equal(test.packets.filter(p => p.name === 'block_dig').length, 0);
    const packet = test.packets.find(p => p.name === 'block_place');
    assert.equal(packet.data.direction, 1, 'The actual native packet targets the top face of farmland');
    assert.equal(packet.data.location.y, 62, 'Click soil, not the air block or plant');
    assert.equal(test.bot.listenerCount('blockUpdate'), 0);
}
for (const options of [{occupied: true}, {soilName: 'dirt'}]) {
    const test = make(options);
    assert.equal((await plantCrop(test.bot, 'beetroot_seeds', test.bot.entity.position)).success, false);
    assert.equal(test.packets.length, 0, 'Occupied crops and untilled soil are preserved');
}
const timedOut = make({confirm: false});
await assert.rejects(plantCrop(timedOut.bot, 'beetroot_seeds', timedOut.bot.entity.position, {timeoutMs: 35}), {name: 'PlantingTimeout'});
assert.equal(timedOut.soil.name, 'farmland'); assert.equal(timedOut.bot.listenerCount('blockUpdate'), 0);
const late = make(); let releaseEquip;
late.bot.equip = () => new Promise(resolve => {releaseEquip = resolve;});
await assert.rejects(plantCrop(late.bot, 'beetroot_seeds', late.bot.entity.position, {timeoutMs: 35}), {name: 'PlantingTimeout'});
releaseEquip(); await sleep(15); assert.equal(late.packets.length, 0);
console.log('PASS: real 1.21.6 native right-click packets, top face, fractional farmland height, five crop types, no digging, occupied crops and untilled soil preserved, explicit timeout, listener cleanup and no late planting after equipment timeout.');
