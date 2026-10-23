import '../mindcraft/src/agent/agent.js'; // Match the application's module initialization order.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { goToGoal, goToPlayer, teleportToPlayer, configureNavigationMovements, findSafePlayerLanding } from '../mindcraft/src/agent/library/skills.js';
import { queryList } from '../mindcraft/src/agent/commands/queries.js';
import settings from '../mindcraft/settings.js';
const require = createRequire(new URL('../mindcraft/package.json', import.meta.url));
const goto = require('mineflayer-pathfinder/lib/goto.js');
const { Vec3 } = require('vec3');
const { goals, Movements } = require('mineflayer-pathfinder');
settings.allow_navigation_teleport = false;

function makeBot(status, atGoal = false) {
    const bot = new EventEmitter();
    bot.username = 'bot';
    bot.registry = require('prismarine-registry')('1.21.6');
    bot.entity = { position: new Vec3(-13, 70, 11) };
    bot.output = '';
    bot.blockAt = () => null;
    bot.clearControlStates = () => {};
    bot.players = { GGboy: { gamemode: 1, entity: { position: new Vec3(-48, 102, 42) } } };
    bot.modes = { pause() {}, unpause() {}, isOn: () => false };
    bot.pathfinder = {
        getPathTo: () => ({status, path: []}), setMovements() {},
        setGoal(goal) {
            this.goal = goal;
            if (!goal) return;
            setImmediate(() => {
                if (atGoal) {
                    bot.entity.position = bot.players.GGboy.entity.position.clone();
                    bot.emit('goal_reached', goal);
                } else bot.emit('path_update', { status, path: [] });
            });
        },
        goto(goal) { return goto(bot, goal); },
    };
    return bot;
}

for (const [status, errorName] of [['noPath', 'NoPath'], ['timeout', 'Timeout']]) {
    const bot = makeBot(status);
    await assert.rejects(goto(bot, new goals.GoalFollow(bot.players.GGboy.entity, 3)), { name: errorName }, 'Empty failed paths must reject, not succeed');
    assert.equal(bot.listenerCount('path_update'), 0);
}
const blocked = makeBot('noPath');
assert.equal(await goToPlayer(blocked, 'GGboy', 3), false);
assert.match(blocked.output, /Could not reach GGboy/);
assert.doesNotMatch(blocked.output, /You have reached GGboy/);
assert.equal(blocked.pathfinder.goal, null, 'Failed navigation clears its movement goal');

const success = makeBot('success', true);
assert.equal(await goToPlayer(success, 'GGboy', 3), true);
assert.match(success.output, /You have reached GGboy/);
const falseSuccess = makeBot('success');
falseSuccess.pathfinder.goto = async () => {};
await assert.rejects(goToGoal(falseSuccess, new goals.GoalFollow(falseSuccess.players.GGboy.entity, 3)), /GoalNotReached/);

const missing = makeBot('noPath');
assert.equal(await goToPlayer(missing, 'Nobody', 3), false);
missing.players.Nobody = {};
assert.equal(await goToPlayer(missing, 'Nobody', 3), false);
const locate = queryList.find(query => query.name === '!playerPosition');
assert.match(locate.perform({ bot: blocked }, 'GGboy'), /Gamemode: creative/);
assert.match(locate.perform({ bot: missing }, 'Nobody'), /entity is not loaded/);

const partial = makeBot('partial');
const partialGoal = new goals.GoalFollow(partial.players.GGboy.entity, 3);
let prematurelyResolved = false;
const pending = goto(partial, partialGoal).then(() => { prematurelyResolved = true; });
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(prematurelyResolved, false, 'An empty partial search does not imply arrival');
partial.entity.position = partial.players.GGboy.entity.position.clone();
partial.emit('goal_reached', partialGoal);
await pending;
const movements = configureNavigationMovements(blocked, new Movements(blocked));
assert.equal(movements.canDig, false);
assert.equal(movements.allow1by1towers, true);
assert.ok(movements.scafoldingBlocks.includes(blocked.registry.itemsByName.dirt.id));
assert.ok(movements.scafoldingBlocks.includes(blocked.registry.itemsByName.cobblestone.id));

settings.allow_navigation_teleport = true;
const teleport = makeBot('noPath');
const air = { name: 'air', boundingBox: 'empty', shapes: [] };
const stone = { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
teleport.blockAt = position => position.y === 101 ? stone : air;
const landing = findSafePlayerLanding(teleport, teleport.players.GGboy.entity.position);
assert.ok(landing);
let sentCommand;
teleport.chat = command => { sentCommand = command; teleport.entity.position = landing.clone(); };
assert.equal(await teleportToPlayer(teleport, 'GGboy'), true);
assert.match(sentCommand, /^\/tp @s /);
assert.match(teleport.output, /Verified distance/);
const airborne = makeBot('noPath');
airborne.blockAt = () => air;
airborne.chat = () => { throw Error('Must not teleport into unsupported air'); };
assert.equal(await teleportToPlayer(airborne, 'GGboy'), false);
const denied = makeBot('noPath');
denied.blockAt = teleport.blockAt;
denied.chat = () => denied.emit('messagestr', 'You do not have permission');
assert.equal(await teleportToPlayer(denied, 'GGboy'), false);
assert.doesNotMatch(denied.output, /Teleported to a safe surface/);
const walking = makeBot('noPath');
walking.blockAt = teleport.blockAt;
walking.chat = () => { throw Error('Walking must not silently use teleport'); };
assert.equal(await goToPlayer(walking, 'GGboy'), false);
console.log('PASS: truthful path failures/arrival, partial search, player query, inventory scaffolding, safe teleport, airborne and permission failures.');
