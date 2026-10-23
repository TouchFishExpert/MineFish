import assert from 'node:assert/strict';
import fs from 'node:fs';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import '../mindcraft/src/agent/agent.js';
import {parseCommandMessage, getCommandDocs, getCommand} from '../mindcraft/src/agent/commands/index.js';
import {selectInteractionEntity, interactWithEntity} from '../mindcraft/src/agent/library/entity_interaction.js';
import {installRidingObservation, ridingState, vehicleSeats, leaveBedOrVehicle} from '../mindcraft/src/agent/library/riding.js';
import {formatNearbyEntityDetails} from '../mindcraft/src/agent/library/entity_observation.js';
import {captureRuntimeState, prepareRuntimePrompt} from '../mindcraft/src/agent/runtime_observation.js';
import {Prompter} from '../mindcraft/src/models/prompter.js';
import {DeepSeek} from '../mindcraft/src/models/deepseek.js';

const require = createRequire(new URL('../mindcraft/package.json', import.meta.url)), {Vec3} = require('vec3');
const fixtures = [], checks = [], response = text => new Response(JSON.stringify({choices: [{finish_reason: 'stop', message: {content: text}}]}), {headers: {'content-type': 'application/json'}});
function fixture() {
    const bot = new EventEmitter(), packets = [], visits = [], logs = [];
    let releaseLook;
    Object.assign(bot, {entity: {id: 1, username: 'Fixture', type: 'player', position: new Vec3(0, 64, 0), onGround: true},
        username: 'Fixture', _client: new EventEmitter(), entities: {}, registry: {biomes: {}}, game: {dimension: 'overworld'},
        blockAt: () => null, health: 20, food: 20, inventory: {slots: []},
        look: async (_yaw, _pitch, force) => {
            if (force) {releaseLook?.(); releaseLook = null; return;}
            if (bot.blockLook) return new Promise(resolve => {releaseLook = resolve;});
        },
        lookAt: async (_position, force) => bot.look(0, 0, force),
        unequip: async () => {}, getControlState: () => false,
        setControlState: (_key, value) => {
            if (value && bot.vehicle) queueMicrotask(() => bot._client.emit('set_passengers', {entityId: bot.vehicle.id, passengers: []}));
        },
        activateEntity: async target => {
            await bot.lookAt(target.position.offset(0, 1, 0), false);
            bot._client.write('use_entity', {target: target.id, mouse: 0, sneaking: false, hand: 0});
            if (bot.confirmMount !== false) queueMicrotask(() => bot._client.emit('set_passengers', {entityId: target.id, passengers: bot.mountOrder || [1]}));
        },
        useOn: async target => bot._client.write('use_entity', {target: target.id, mouse: 0, hand: 0})});
    bot._client.write = (name, payload) => packets.push({name, payload});
    bot.entities[1] = bot.entity; installRidingObservation(bot);
    const entity = (id, name, x, options = {}) => {
        const value = {id, uuid: `uuid-${id}`, name, type: 'mob', position: new Vec3(x, 64, 0), isValid: true, passengers: [], ...options};
        bot.entities[id] = value; return value;
    };
    const navigate = async position => {visits.push(position.clone()); bot.entity.position = position.offset(-1, 0, 0); return true;};
    const interact = options => interactWithEntity(bot, {type: 'horse', toolName: 'hand', navigate, equip: async () => true, log: message => logs.push(message), ...options});
    const f = {bot, packets, visits, logs, entity, interact}; fixtures.push(f); return f;
}
try {
    assert.deepEqual(parseCommandMessage('!useOn("hand", "horse")').args, ['hand', 'horse', null]);
    assert.deepEqual(parseCommandMessage('!useOn("hand", "horse", 123)').args, ['hand', 'horse', 123]);
    for (const command of ['!useOn("hand")', '!useOn("hand", "horse", 1, 2)', '!useOn("hand", "horse", -1)', '!useOn("hand", "horse", 1.5)'])
        assert.equal(typeof parseCommandMessage(command), 'string');
    assert.match(getCommandDocs({blocked_actions: []}), /entity_id: \(number, optional; 可省略\)/);
    const optionalCommand = getCommand('!getCraftingPlan');
    if (optionalCommand) assert.equal(parseCommandMessage('!getCraftingPlan("stone_pickaxe")').args[1], 1);
    checks.push('Two-argument useOn remains valid; optional numeric entity ID, strict integer/range/count checks, optional parameter docs and defaults');

    const f = fixture(), near = f.entity(10, 'horse', 2), far = f.entity(20, 'horse', 8);
    assert.equal(selectInteractionEntity(f.bot, 'horse').id, 10);
    assert.equal(selectInteractionEntity(f.bot, 'horse', 20).id, 20);
    assert.throws(() => selectInteractionEntity(f.bot, 'spruce_boat', 20), /类型.*不符/);
    assert.throws(() => selectInteractionEntity(f.bot, 'horse', 999), /不会更换目标/);
    await f.interact({entityId: 20});
    assert.equal(f.visits[0].x, 8); assert.equal(f.packets[0].payload.target, 20);
    assert.equal(ridingState(f.bot).vehicle.id, 20); assert.match(f.logs.at(-1), /服务端已确认/);
    await leaveBedOrVehicle(f.bot); assert.equal(ridingState(f.bot).mounted, false);
    await f.interact({}); assert.equal(f.packets.at(-1).payload.target, 20, 'Nearest is evaluated from the current location');
    checks.push('Explicit ID selects the farther exact entity; nearest selection remains available; server mount confirmation is required and dismount remains compatible');

    const disappearing = fixture(); const target = disappearing.entity(7, 'horse', 4); disappearing.entity(8, 'horse', 1);
    await assert.rejects(disappearing.interact({entityId: 7, navigate: async () => {delete disappearing.bot.entities[7]; return true;}}), /不会更换目标/);
    assert.equal(disappearing.packets.length, 0);
    disappearing.bot.entities[7] = target;
    await assert.rejects(disappearing.interact({entityId: 7, navigate: async () => {disappearing.entity(7, 'horse', 2, {uuid: 'different'}); return true;}}), /身份发生变化/);
    assert.equal(disappearing.packets.length, 0);
    const moving = fixture(); moving.entity(9, 'horse', 2);
    await assert.rejects(moving.interact({entityId: 9, navigate: async () => {moving.bot.entities[9].position.x = 20; return true;}}), /交互范围外/);
    checks.push('Despawn, ID reuse/identity change, type mismatch and moving out of reach fail honestly without clicking a different target');

    const seating = fixture(), boat = seating.entity(30, 'spruce_boat', 2), other = seating.entity(2, 'player', 0, {username: 'GGboy', type: 'player'});
    boat.passengers = [other, seating.bot.entity, seating.bot.entity]; seating.bot.vehicle = boat;
    assert.equal(ridingState(seating.bot).vehicle.seatRole, 'unknown', 'Native passenger cache alone is not authoritative order');
    seating.bot._client.emit('set_passengers', {entityId: 30, passengers: [1, 2]});
    assert.equal(ridingState(seating.bot).vehicle.seatRole, 'driver'); assert.equal(ridingState(seating.bot).vehicle.canControl, true);
    assert.deepEqual(boat.passengers.map(p => p.id), [1, 2]);
    seating.bot._client.emit('set_passengers', {entityId: 30, passengers: [2, 1]});
    assert.equal(ridingState(seating.bot).vehicle.seatRole, 'passenger'); assert.equal(ridingState(seating.bot).vehicle.seatNumber, 2);
    assert.equal(ridingState(seating.bot).vehicle.canControl, false);
    const snapshot = captureRuntimeState({name: 'SeatFixture', bot: seating.bot});
    assert.match(snapshot.action.actualState, /乘坐位/); assert.deepEqual(snapshot.posture.vehicle.passengerIds, [2, 1]);
    checks.push('Raw server passenger order corrects stale/duplicate native cache; boat driver/front and passenger/rear states change live, unknown data stays unknown');

    const horses = fixture(), horse = horses.entity(40, 'horse', 1, {equipment: []});
    horses.bot._client.emit('set_passengers', {entityId: 40, passengers: [1]});
    assert.equal(ridingState(horses.bot).vehicle.canControl, null);
    horse.equipment[7] = {name: 'saddle'}; assert.equal(ridingState(horses.bot).vehicle.canControl, true);
    horse.equipment[7] = null; assert.equal(ridingState(horses.bot).vehicle.canControl, false);
    const cart = horses.entity(41, 'minecart', 1);
    horses.bot._client.emit('set_passengers', {entityId: 40, passengers: []});
    horses.bot._client.emit('set_passengers', {entityId: 41, passengers: [1]});
    assert.equal(ridingState(horses.bot).vehicle.seatRole, 'passenger'); assert.equal(ridingState(horses.bot).vehicle.canControl, false);
    const camel = horses.entity(42, 'camel', 2, {equipment: {7: {name: 'saddle'}}});
    horses.bot._client.emit('set_passengers', {entityId: 41, passengers: []});
    horses.bot._client.emit('set_passengers', {entityId: 42, passengers: [2, 1]});
    assert.equal(ridingState(horses.bot).vehicle.seatRole, 'passenger'); assert.equal(ridingState(horses.bot).vehicle.canControl, false);
    checks.push('Horse driver-seat is distinct from saddle/control eligibility (unknown/yes/no); camel rear cannot control; minecart is a rail passenger seat');

    const full = fixture(); full.entity(50, 'oak_boat', 1); full.entity(51, 'oak_boat', 3); full.entity(52, 'bamboo_raft', 4);
    full.bot._client.emit('set_passengers', {entityId: 50, passengers: [2, 3]});
    assert.equal(selectInteractionEntity(full.bot, 'oak_boat').id, 50, 'Legacy nearest-instance choice is preserved');
    full.bot.confirmMount = false;
    await assert.rejects(full.interact({type: 'oak_boat', entityId: 50, timeoutMs: 30}), /未获服务端确认/);
    assert.equal(full.packets[0].payload.target, 50, 'Server rules decide whether the requested seat is available');
    const chest = full.entity(53, 'oak_chest_boat', 2); assert.equal(vehicleSeats(full.bot, chest).capacity, 1);
    full.bot._client.emit('set_passengers', {entityId: 51, passengers: []});
    await assert.rejects(full.interact({type: 'oak_boat', entityId: 51, timeoutMs: 30, navigate: async position => {full.bot.entity.position = position.clone(); full.bot._client.emit('set_passengers', {entityId: 51, passengers: [2, 3]}); return true;}}), /未获服务端确认/);
    checks.push('Nearest-instance compatibility; server rejection/full seat returns timeout without target substitution; capacity is explicitly a vanilla estimate, not an extra mount restriction');

    const noReply = fixture(); noReply.entity(60, 'horse', 1); noReply.bot.confirmMount = false;
    const time = Date.now(); await assert.rejects(noReply.interact({entityId: 60, timeoutMs: 30}), /未获服务端确认/);
    assert.equal(ridingState(noReply.bot).mounted, false); assert.ok(Date.now() - time < 500);
    const blocked = fixture(); blocked.entity(61, 'horse', 1); blocked.bot.blockLook = true;
    await assert.rejects(blocked.interact({entityId: 61, timeoutMs: 30}), /未获服务端确认/);
    assert.equal(blocked.packets.length, 0); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(blocked.packets.length, 0);
    const movedDuringLook = fixture(); const movingTarget = movedDuringLook.entity(62, 'horse', 1);
    movedDuringLook.bot.blockLook = true;
    const movedRequest = movedDuringLook.interact({entityId: 62});
    await new Promise(resolve => setImmediate(resolve));
    movingTarget.position.x = 20;
    await movedDuringLook.bot.look(0, 0, true);
    await assert.rejects(movedRequest, /交互范围外/); assert.equal(movedDuringLook.packets.length, 0);
    checks.push('No mount packet yields a local timeout, never success; timeout during native smooth look cancels and drains it, preventing a late click');

    for (let i = 100; i < 140; i++) full.entity(i, 'armor_stand', 1 + (i - 100) / 100);
    const text = formatNearbyEntityDetails(full.bot, Object.values(full.bot.entities));
    assert.match(text, /id=52 type=bamboo_raft/); assert.match(text, /id=50 type=oak_boat/); assert.match(text, /已省略/);
    assert.ok(text.length <= 3500);
    const query = await getCommand('!entities').perform({name: 'Fixture', bot: full.bot});
    assert.match(query, /id=50 type=oak_boat/); assert.match(query, /附近掉落物/);
    const wire = [];
    process.env.DEEPSEEK_API_KEY ||= 'unit-seat-key';
    const model = new DeepSeek('deepseek-flash', undefined, {}, {publish() {}, fetch: async (_url, options) => {wire.push(JSON.parse(options.body)); return response('已收到座位状态');}});
    const agent = {name: 'SeatFixture', bot: seating.bot};
    const prompter = Object.assign(Object.create(Prompter.prototype), {agent, chat_model: model});
    await prompter.requestModel(model, [], getCommandDocs({blocked_actions: []}), 'conversation');
    const sent = wire[0].messages.map(m => m.content).join('\n');
    assert.match(sent, /entity_id: \(number, optional/); assert.match(sent, /"seatRole":"passenger"/);
    assert.match(sent, /"passengerIds":\[2,1\]/); assert.match(sent, /"id":30/);
    checks.push('Actual entities query exposes bounded ID/type/position/seat details; actual SDK payload includes optional tool parameter, nearby IDs and confirmed own seat state');
    const result = {at: new Date().toISOString(), passed: true, checks};
    fs.writeFileSync(new URL('./entity-target-seats-test-result.json', import.meta.url), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
} finally {for (const {bot} of fixtures) bot.emit('end');}
