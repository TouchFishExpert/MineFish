import assert from 'node:assert/strict';
import { parseKickReason, normalizeKickReason } from '../mindcraft/src/agent/connection_handler.js';

const reason = {type:'compound',value:{translate:{type:'string',value:'multiplayer.disconnect.invalid_player_movement'}}};
assert.equal(parseKickReason(reason).msg, 'Disconnected: multiplayer.disconnect.invalid_player_movement');
assert.deepEqual(normalizeKickReason(reason), {translate:'multiplayer.disconnect.invalid_player_movement'});
assert.equal(parseKickReason({type:'compound',value:{translate:{type:'string',value:'multiplayer.disconnect.duplicate_login'}}}).type, 'name_conflict');
assert.equal(parseKickReason('{"text":"Connection timed out"}').type, 'network_error');
assert.equal(parseKickReason({type:'compound',value:{text:{type:'string',value:'Server maintenance'},extra:{type:'list',value:{type:'compound',value:[{text:{type:'string',value:'Please reconnect later'}}]}}}}).type, 'maintenance');
assert.equal(parseKickReason({text:'Custom server message',extra:[{text:'details'}]}).msg, 'Disconnected: Custom server message details');
console.log('PASS: typed NBT, JSON, plain components, and disconnect classification.');
