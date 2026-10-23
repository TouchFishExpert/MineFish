import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { getAgentInspection } from '../mindcraft/src/agent/library/inspection.js';
import { requestAgentInspection } from '../mindcraft/src/mindcraft/inspection.js';
const require = createRequire(new URL('../mindcraft/package.json', import.meta.url));
const { Server } = require('socket.io');
const { io } = require('socket.io-client');

const entity = { id: 10, position: { x: 10, y: 63, z: 12 } };
const boat = { id: 99, name: 'oak_boat', position: { x: 110, y: 63, z: 12 }, passengers: [entity] };
entity.vehicle = boat; // A circular entity graph must not be serialized.
const agent = {
    name: 'bot',
    settings: { DEEPSEEK_API_KEY: 'private-key-do-not-expose' },
    history: { memory: '<img src=x onerror=alert(1)> 已记住基地', turns: [{ role: 'user', content: 'GGboy: 基地坐标', privateValue: 'hidden' }], max_messages: 16 },
    self_prompter: { isStopped: () => false, isPaused: () => false, prompt: '自主伴玩' },
    memory_bank: { getJson: () => ({ '基地': [10, 63, 12], invalid: [null, NaN, 0] }) },
    bot: { entity, vehicle: boat, game: { dimension: 'overworld' }, players: { bot: { entity }, GGboy: { entity }, unloaded: {}, stale: { entity: { isValid: false, position: entity.position } } } }
};
const before = JSON.stringify(agent.history);
const value = getAgentInspection(agent);
assert.equal(value.memory.summary, agent.history.memory);
assert.equal(value.memory.recentTurns, undefined, 'The duplicate recent-dialogue projection has been removed');
assert.equal(JSON.stringify(value).includes('private-key-do-not-expose'), false);
assert.equal(JSON.stringify(value).includes('privateValue'), false);
assert.equal(JSON.stringify(agent.history), before);
assert.equal(value.locations.bot.position.x, 10);
assert.equal(value.locations.bot.vehicle.position.x, 110);
assert.equal(value.locations.bot.vehicle.passengerListed, true);
assert.equal(value.locations.players.find(p => p.name === 'unloaded').entityLoaded, false);
assert.equal(value.locations.players.find(p => p.name === 'stale').position, null);
assert.equal(value.memory.namedPlaces.find(p => p.name === 'invalid').position, null);
assert.equal(value.memory.placesPersisted, false);
assert.equal(Number.isNaN(Date.parse(value.sampledAt)), false);
agent.self_prompter.isStopped = () => true;
assert.equal(getAgentInspection(agent).goal.state, 'stopped');
agent.self_prompter.isStopped = () => false;
agent.self_prompter.isPaused = () => true;
assert.equal(getAgentInspection(agent).goal.state, 'paused');
assert.deepEqual(await requestAgentInspection(null), { error: 'not-found' });
assert.deepEqual(await requestAgentInspection({ in_game: false }), { error: 'offline' });

// Exercise real Socket.IO acknowledgement and timeout behavior in an isolated local server.
const http = createServer();
const server = new Server(http);
http.listen(0, '127.0.0.1');
await once(http, 'listening');
const connected = once(server, 'connection');
const client = io(`http://127.0.0.1:${http.address().port}`, { reconnection: false });
try {
    const [socket] = await connected;
    client.on('get-inspection', callback => callback(value));
    const connection = { in_game: true, socket };
    assert.deepEqual(await requestAgentInspection(connection), { snapshot: value });
    client.off('get-inspection');
    client.on('get-inspection', callback => callback(null));
    assert.deepEqual(await requestAgentInspection(connection), { error: 'unavailable' });
    client.off('get-inspection');
    assert.deepEqual(await requestAgentInspection(connection, 30), { error: 'timeout' });
} finally {
    client.disconnect();
    await new Promise(resolve => server.close(resolve));
}

const html = readFileSync(new URL('../mindcraft/src/mindcraft/public/index.html', import.meta.url), 'utf8');
for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
const ui = readFileSync(new URL('../mindcraft/src/mindcraft/public/inspection-panel.js', import.meta.url), 'utf8');
new vm.Script(ui);
assert.equal(/innerHTML|insertAdjacentHTML|eval\(/.test(ui), false);
assert.equal(/send-message|set-agent-settings|stop-agent/.test(ui), false);
console.log('PASS: read-only snapshot, private fields excluded, unloaded players, distinct vehicle coordinates, real Socket.IO ack/offline/timeout, frontend syntax and text-only rendering.');
