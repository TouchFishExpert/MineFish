import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import {installRuntimeObservation, captureRuntimeState, prepareRuntimePrompt, NEARBY_PICKUP_RADIUS, RECENT_PICKUP_LIMIT} from '../mindcraft/src/agent/runtime_observation.js';
import {Prompter} from '../mindcraft/src/models/prompter.js';
import {DeepSeek} from '../mindcraft/src/models/deepseek.js';
import {enqueueModelRequest} from '../mindcraft/src/utils/model_request_queue.js';
const require = createRequire(new URL('../mindcraft/package.json', import.meta.url));
const registry = require('prismarine-registry')('1.21.6');
const Entity = require('prismarine-entity')('1.21.6');
const Item = require('prismarine-item')('1.21.6');
const {Vec3} = require('vec3');
const injectEntities = require('mineflayer/lib/plugins/entities.js');
const checks = [], fixtures = [];
let clock = Date.parse('2026-10-23T01:00:00Z');
function fixture(name) {
    const bot = new EventEmitter(); bot._client = new EventEmitter(); bot._client.username = name;
    Object.assign(bot, {version: '1.21.6', registry, supportFeature: registry.supportFeature, controlState: {},
        game: {dimension: 'overworld'}, time: {timeOfDay: 6000}, blockAt: () => ({name: 'air'}),
        world: {getBiome: () => 1}, food: 20, health: 20});
    injectEntities(bot); bot._client.emit('login', {entityId: 1}); bot.entity.position = new Vec3(0, 64, 0);
    const journal = [], agent = {name, bot, history: {turns: [], recordEvent: (kind, value) => journal.push({kind, value})},
        actions: {currentActionLabel: 'action:stay'}};
    const observer = installRuntimeObservation(agent, {now: () => clock, intervalMs: 0});
    const player = new Entity(2); Object.assign(player, {type: 'player', name: 'player', username: 'GGboy', position: new Vec3(3, 64, 0)}); bot.entities[2] = player;
    function drop(id, position = new Vec3(3, 64, 0), name = 'wheat', count = 64) {
        const entity = new Entity(id); entity.name = 'item'; entity.position = position;
        entity.metadata[registry.supportFeature('metadataIxOfItem')] = Item.toNotch(new Item(registry.itemsByName[name].id, count));
        bot.entities[id] = entity; return entity;
    }
    function pickup(id, count = 3, collector = 2) {bot._client.emit('collect', {collectedEntityId: id, collectorEntityId: collector, pickupItemCount: count});}
    fixtures.push(agent); return {agent, bot, observer, journal, drop, pickup};
}
try {
    const f = fixture('bot');
    let nativeEvent = false; f.bot.once('playerCollect', (collector, item) => {nativeEvent = collector.username === 'GGboy' && item.name === 'item';});
    f.drop(10); f.pickup(10, 3);
    let view = captureRuntimeState(f.agent).recentPickups, event = view.events[0];
    assert.equal(nativeEvent, true); assert.equal(view.radiusBlocks, 16);
    assert.equal(event.item, 'wheat'); assert.equal(event.count, 3, 'actual packet count, not original stack count=64');
    assert.equal(event.collector.name, 'GGboy'); assert.equal(event.collector.self, false);
    assert.deepEqual(event.position, {x: 3, y: 64, z: 0}); assert.equal(event.at, '2026-10-23T01:00:00.000Z');
    assert.equal(f.journal[0].kind, 'nearby-item-pickup'); assert.equal(f.agent.history.turns.length, 0);
    f.bot._client.emit('entity_destroy', {entityIds: [10]});
    assert.equal(captureRuntimeState(f.agent).recentPickups.events[0].item, 'wheat', 'snapshot survives entity removal');
    checks.push('native 1.21.6 entities plugin and item metadata: collector/item/location/time; actual pickup count survives entity removal');

    f.drop(11, new Vec3(16, 64, 0)); f.pickup(11);
    assert.equal(f.observer.pickups.length, 2);
    f.drop(12, new Vec3(16.0001, 64, 0)); f.pickup(12);
    assert.equal(f.observer.pickups.length, 2, 'unrounded 16-block boundary');
    f.drop(13, new Vec3(0, 80, 0)); f.pickup(13);
    assert.equal(f.observer.pickups.length, 3, 'vertical boundary included');
    f.drop(14, new Vec3(12, 76, 0)); f.pickup(14);
    assert.equal(f.observer.pickups.length, 3, 'distance includes height');
    const xp = new Entity(15); xp.name = 'experience_orb'; xp.position = new Vec3(1, 64, 0); f.bot.entities[15] = xp; f.pickup(15);
    f.pickup(99999);
    assert.equal(f.observer.pickups.length, 3, 'XP and unknown entities are not fabricated as items');
    f.drop(16); f.bot._client.emit('entity_destroy', {entityIds: [16]});
    assert.equal(f.observer.pickups.length, 3, 'disappearance alone is not pickup evidence');
    checks.push('3D radius exactly 16 blocks; excludes out-of-range items, XP, unknown entities and disappearance-only events');

    f.drop(17); f.pickup(17, 2, 1);
    assert.equal(f.observer.pickups.at(-1).collector.self, true); assert.equal(f.observer.pickups.at(-1).collector.name, 'bot');
    f.drop(18).metadata = {}; f.pickup(18, undefined, 77);
    assert.equal(f.observer.pickups.at(-1).item, '未知物品'); assert.equal(f.observer.pickups.at(-1).collector.name, '未知拾取者');
    f.drop(19); f.bot._client.emit('collect', {collectedEntityId: 19, collectorEntityId: 2});
    assert.equal(f.observer.pickups.at(-1).count, null);
    const other = fixture('DeepSeek');
    assert.deepEqual(captureRuntimeState(other.agent).recentPickups.events, []);
    const before = JSON.stringify(f.observer.pickupSnapshot());
    captureRuntimeState(f.agent); prepareRuntimePrompt('test', f.agent);
    assert.equal(JSON.stringify(f.observer.pickupSnapshot()), before, 'dashboard/prompt reads never consume observations');
    clock += 3600000;
    assert.ok(f.observer.pickupSnapshot().events.length > 0, 'idle time cannot expire undelivered pickup facts');
    checks.push('self pickup, unknown names/metadata/count handled truthfully; per-bot isolation; snapshot reads and idle time do not erase events');

    for (let i = 0; i < 40; i++) {f.drop(100 + i); f.pickup(100 + i, 1);}
    view = f.observer.pickupSnapshot();
    assert.equal(view.events.length, RECENT_PICKUP_LIMIT); assert.equal(view.olderEventsOmitted, f.journal.length - RECENT_PICKUP_LIMIT);
    assert.equal(f.journal.length, f.observer.pickupSequence); assert.equal(f.agent.history.turns.length, 0);
    view.events[0].item = 'mutated'; assert.notEqual(f.observer.pickups[0].item, 'mutated');
    checks.push('fixed 12-event prompt bound with omitted count; every event journaled; cloned snapshots cannot mutate stored evidence');

    // The API slot is busy first: a pickup arriving while queued must still be
    // present in the real SDK HTTP body built at dispatch, without another call.
    process.env.DEEPSEEK_API_KEY = 'unit-pickup-key'; const wire = [];
    const model = new DeepSeek('deepseek-flash', undefined, {}, {publish: () => {}, fetch: async (_url, options) => {
        wire.push(JSON.parse(options.body)); return new Response(JSON.stringify({choices: [{finish_reason: 'stop', message: {content: '已看到拾取信息'}}]}), {headers: {'content-type': 'application/json'}});
    }});
    const p = Object.assign(Object.create(Prompter.prototype), {agent: other.agent});
    let release; const blocking = enqueueModelRequest(p, () => new Promise(resolve => {release = resolve;}));
    const pending = p.requestModel(model, [], '角色提示词', 'conversation');
    other.drop(200, new Vec3(4, 64, 0), 'potato', 10); other.pickup(200, 4);
    assert.equal(wire.length, 0, 'pickup itself cannot call API');
    release(); await blocking; await pending;
    const payload = wire[0].messages.map(m => m.content).join('\n');
    const sentState = JSON.parse(payload.split('\n').find(line => line.startsWith('{"capturedAt":')));
    assert.equal(sentState.recentPickups.events[0].item, 'potato'); assert.equal(sentState.recentPickups.events[0].count, 4);
    assert.equal(other.agent.actions.currentActionLabel, 'action:stay'); assert.equal(p.maxObservedModelRequests, 1);
    assert.equal(other.journal.length, 1); assert.equal(other.agent.history.turns.length, 0);
    await p.requestModel(model, [], '摘要维护', 'memory');
    assert.ok(!wire[1].messages.some(m => m.content.includes('recentPickups')), 'no live world payload in memory-only calls');
    checks.push('actual Prompter->DeepSeek SDK: pickup while queued enters next normal request at dispatch; no extra API call/action interruption/history bloat');

    assert.equal(other.bot._client.listenerCount('collect'), 2, 'native handler plus one observer');
    installRuntimeObservation(other.agent);
    assert.equal(other.bot._client.listenerCount('collect'), 2, 'idempotent installation');
    other.bot.emit('end'); assert.equal(other.bot._client.listenerCount('collect'), 1, 'observer detached on disconnect');
    checks.push('one listener per bot; disconnect releases observer listener');
    const evidence = {at: new Date().toISOString(), passed: true, radiusBlocks: NEARBY_PICKUP_RADIUS, maxEvents: RECENT_PICKUP_LIMIT, checks};
    fs.writeFileSync(new URL('./pickup-observation-test-result.json', import.meta.url), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
} finally {for (const agent of fixtures) agent.runtimeObservation?.dispose();}
