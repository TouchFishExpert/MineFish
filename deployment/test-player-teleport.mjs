import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setSettings } from '../mindcraft/src/agent/settings.js';
import { teleportPlayerToCoordinates, teleportPlayerToPlayer } from '../mindcraft/src/agent/library/teleport.js';
setSettings({ allow_player_teleport: true });
function makeBot(feedback) {
    const bot = new EventEmitter();
    Object.assign(bot, { username: 'bot', players: { GGboy: {}, CKL: {} }, entity: { position: {x:0,y:64,z:0} }, output: '', sent: [] });
    bot.chat = command => { bot.sent.push(command); feedback?.(bot, command); };
    return bot;
}
const coordinates = makeBot(bot => bot.emit('messagestr', 'Teleported GGboy to 10.5, 64, -2', 'system', {}, null));
assert.equal(await teleportPlayerToCoordinates(coordinates, 'GGboy', 10.5, 64, -2), true);
assert.deepEqual(coordinates.sent, ['/tp GGboy 10.5 64 -2']);
assert.match(coordinates.output, /Server confirmed/);
const player = makeBot(bot => bot.emit('messagestr', '已将GGboy传送至CKL', 'system', {}, null));
assert.equal(await teleportPlayerToPlayer(player, 'GGboy', 'CKL'), true);
assert.deepEqual(player.sent, ['/tp GGboy CKL']);
const denied = makeBot(bot => {
    bot.emit('messagestr', 'Teleported GGboy to CKL', 'chat', {}, 'not-a-server-sender');
    bot.emit('messagestr', 'You do not have permission', 'system', {}, null);
});
assert.equal(await teleportPlayerToPlayer(denied, 'GGboy', 'CKL'), false, 'A player chat message cannot confirm a command');
assert.doesNotMatch(denied.output, /Server confirmed/);
const invalid = makeBot();
assert.equal(await teleportPlayerToPlayer(invalid, '@a', 'CKL'), false);
assert.equal(await teleportPlayerToPlayer(invalid, 'GGboy\n/stop', 'CKL'), false);
assert.equal(await teleportPlayerToPlayer(invalid, '__proto__', 'CKL'), false);
assert.equal(await teleportPlayerToCoordinates(invalid, 'GGboy', NaN, 64, 0), false);
assert.equal(await teleportPlayerToCoordinates(invalid, 'GGboy', 0, 999, 0), false);
assert.equal(invalid.sent.length, 0, 'Invalid commands never reach the server');
invalid.interrupt_code = true;
assert.equal(await teleportPlayerToPlayer(invalid, 'GGboy', 'CKL'), false);
assert.equal(invalid.sent.length, 0);
assert.equal(coordinates.listenerCount('messagestr'), 0);
console.log('PASS: named-player teleport, server confirmation, denial, spoofed feedback, invalid arguments and cancellation.');
