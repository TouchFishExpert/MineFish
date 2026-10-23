import assert from 'node:assert/strict';
import { AgentProcess } from '../mindcraft/src/process/agent_process.js';

const agent = new AgentProcess('test', 18080);
let duplicateStarted = false;
agent.running = true;
agent.process = { killed: false };
agent.restartTimer = setTimeout(() => { duplicateStarted = true; }, 25);
agent.start();
await new Promise(resolve => setTimeout(resolve, 60));
assert.equal(duplicateStarted, false, 'Manual start must cancel queued reconnect');
assert.equal(agent.restartTimer, null);
assert.equal(agent.process.killed, false, 'Existing live process is retained');
console.log('PASS: queued reconnect cancellation and duplicate process protection.');
