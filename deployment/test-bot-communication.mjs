import assert from 'node:assert/strict';
import {once} from 'node:events';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import convo from '../mindcraft/src/agent/conversation.js';
import {serverProxy} from '../mindcraft/src/agent/mindserver_proxy.js';
import {setSettings} from '../mindcraft/src/agent/settings.js';
import {actionsList} from '../mindcraft/src/agent/commands/actions.js';
import {Prompter} from '../mindcraft/src/models/prompter.js';
import {Agent} from '../mindcraft/src/agent/agent.js';
import {History} from '../mindcraft/src/agent/history.js';
import {createMindServer, registerAgent, getIO} from '../mindcraft/src/mindcraft/mindserver.js';

const require = createRequire(new URL('../mindcraft/package.json', import.meta.url));
const {io} = require('socket.io-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const received = [], history = [], sent = [];
let idle = true;
const agent = {name: 'bot', last_sender: null, shut_up: false,
    history: {add: async (name, message) => history.push({name, message}), save: async () => {}},
    self_prompter: {state: 1, isActive: () => false, isPaused: () => false},
    actions: {currentActionLabel: 'action:collectBlocks'}, isIdle: () => idle,
    openChat: async message => sent.push(message), handleMessage: async (name, message) => {received.push({name, message}); await agent.history.add(name, message);}};
setSettings({chat_bot_messages: true});
convo.initAgent(agent);
convo.updateAgents([{name: 'bot', in_game: true}, {name: 'DeepSeek', in_game: true}]);
assert.equal(convo.isOtherAgent('bot'), false);
await convo.observePublicChat('DeepSeek', '我在河边找到平地。');
assert.equal(received.length, 1, 'Public peer speech must wake the model');
assert.match(history.at(-1).message, /队友公开发言/);
await convo.observePublicChat('DeepSeek', '(To bot) 已收到。');
await convo.observePublicChat('DeepSeek', '!startConversation("bot", "你好")');
assert.equal(history.length, 1, 'IPC echoes must not be recorded a second time');
idle = false;
await convo.receiveFromBot('DeepSeek', {message: '!inventory()', start: true, end: false});
await sleep(20); assert.equal(received.length, 2, 'A busy game action must not delay peer model input');
idle = true;
await sleep(20); assert.equal(received.length, 2);
assert.match(received.at(-1).message, /inventory/);
idle = false;
await convo.receiveFromBot('DeepSeek', {message: '请告诉我位置', start: false, end: false});
await sleep(250); assert.match(received.at(-1).message, /请告诉我位置/, 'Plain dialogue may proceed during a game action');
idle = true;
const beforeStatus = received.length;
await convo.receiveFromBot('DeepSeek', {message: '我去采集。 !collectBlocks("potatoes", 2)', start: false, end: false});
await sleep(20); assert.equal(received.length, beforeStatus + 1, 'A teammate action update must be submitted to the model immediately');
assert.match(history.at(-1).message, /collectBlocks/);
await convo.receiveFromBot('DeepSeek', {message: '第一句', start: false, end: false});
await convo.receiveFromBot('DeepSeek', {message: '第二句', start: false, end: false});
await sleep(250); assert.match(received.at(-1).message, /第一句\n第二句/);
const beforeUnlimited = received.length;
const originalLog = console.log;
try {
    console.log = () => {};
    for (let index = 0; index < 128; index++) {
        await convo.receiveFromBot('DeepSeek', {message: `自由闲聊第${index}句`, start: false, end: false});
        await sleep(1);
    }
} finally {console.log = originalLog;}
assert.equal(received.length, beforeUnlimited + 128);
assert.equal(convo.inConversation('DeepSeek'), true, 'No automatic close or round limit after 128 successive peer messages');
let openConversationGoal;
await actionsList.find(action => action.name === '!goal').perform({self_prompter: {start: value => {openConversationGoal = value;}, setPromptPaused: () => {throw Error('An open but idle conversation cannot suspend a new goal');}}}, '继续自主活动');
assert.equal(openConversationGoal, '继续自主活动');
const count = received.length;
await convo.receiveFromBot('DeepSeek', {message: '不能回复这句', start: false, end: false});
await convo.receiveFromBot('DeepSeek', {message: '!endConversation("bot")', start: false, end: true});
await sleep(20); assert.equal(received.length, count + 1, 'An ending with content must flush queued input into the model');
assert.equal(convo.inConversation(), false);
convo.endConversation('DeepSeek'); // Must also be safe with no active conversation.
assert.ok(history.some(turn => turn.message.includes('不能回复这句')));
assert.ok((await convo.startConversation('bot', 'self')).error);
assert.ok((await convo.startConversation('absent', 'offline')).error);
let active = true, paused = false;
Object.assign(agent.self_prompter, {prompt: '保留的原目标', isActive: () => active,
    pause: () => {throw Error('Communication must never force-stop game actions');},
    setPromptPaused: prompt => {assert.equal(prompt, '保留的原目标'); agent.self_prompter.state = 2; active = false; paused = true;}, stopLoop: async () => {}});
await convo.receiveFromBot('DeepSeek', {message: '采集时也能听到我吗', start: true, end: false});
await sleep(20); assert.ok(paused); assert.match(received.at(-1).message, /采集时也能听到/);
agent.last_sender = 'DeepSeek'; agent.task = {taskStartTime: 1}; agent.self_prompter.isStopped = () => false;
const saved = History.prototype.getSaveData.call({agent, memory: '已有摘要', memory_meta: {}, turns: []});
assert.equal(saved.self_prompting_state, 1); assert.equal(saved.last_sender, null, 'Restart must resume the goal rather than recreate a stale conversation');
agent.self_prompter.state = 0;
assert.equal(History.prototype.getSaveData.call({agent, turns: []}).self_prompting_state, 0, 'An explicit stop must stay stopped');
convo.endAllConversations();
const prompt = await Prompter.prototype.replaceStrings.call({agent, profile: {}}, '$BOT_TEAMMATES');
assert.match(prompt, /你的游戏账号ID：bot/); assert.match(prompt, /在线AI队友账号：DeepSeek/);

const originalSocket = serverProxy.socket;
serverProxy.socket = {connected: true, timeout: () => ({emit: (_event, name, packet, callback) => {sent.push({name, packet}); callback(null, {success: true});}})};
await convo.startConversation('DeepSeek', '定向消息');
assert.equal(sent.at(-1).packet.start, true);
await convo.sendToBot('DeepSeek', '!endConversation("DeepSeek")', false, false);
await actionsList.find(action => action.name === '!endConversation').perform(agent, 'DeepSeek');
assert.equal(sent.filter(item => item.packet?.end).length, 1, 'Ending must deliver exactly once');
const chat = [];
serverProxy.socket.emit = () => {};
setSettings({translate_messages: false, only_chat_with: [], chat_ingame: true});
await Agent.prototype.openChat.call({bot: {chat: message => chat.push(message)}, name: 'bot'}, '(To DeepSeek) \t收到\n好的\u0000\u007f§');
assert.equal(chat.length, 1); assert.ok(!/[\u0000-\u001f\u007f§]/.test(chat[0]));
await Agent.prototype.openChat.call({bot: {chat: () => {throw Error('Empty tab output must not reach Minecraft');}}, name: 'bot'}, '\t');
serverProxy.socket = originalSocket;
let server; const clients = [];
const ack = (socket, event, ...args) => new Promise((resolve, reject) => socket.timeout(2000).emit(event, ...args, (error, value) => error ? reject(error) : resolve(value)));
const connect = async url => {const socket = io(url, {reconnection: false}); clients.push(socket); await once(socket, 'connect'); return socket;};
try {
    for (const name of ['bot', 'DeepSeek']) registerAgent({profile: {name}}, 0);
    server = createMindServer(false, 0); await once(server, 'listening');
    const url = `http://localhost:${server.address().port}`;
    const sender = await connect(url), peer = await connect(url), consoleClient = await connect(url);
    sender.emit('connect-agent-process', 'bot'); sender.emit('login-agent', 'bot');
    peer.emit('connect-agent-process', 'DeepSeek'); peer.emit('login-agent', 'DeepSeek');
    await ack(peer, 'get-settings', 'DeepSeek'); await ack(sender, 'get-settings', 'bot');
    const packet = {message: '真实中继测试', start: true, end: false};
    assert.ok((await ack(consoleClient, 'chat-message', 'DeepSeek', packet)).error);
    assert.ok((await ack(sender, 'chat-message', 'bot', packet)).error);
    assert.ok((await ack(sender, 'chat-message', 'DeepSeek', {message: 42})).error);
    const delivery = once(peer, 'chat-message');
    assert.equal((await ack(sender, 'chat-message', 'DeepSeek', packet)).success, true);
    assert.deepEqual(await delivery, ['bot', packet]);
    peer.disconnect(); await sleep(50);
    assert.ok((await ack(sender, 'chat-message', 'DeepSeek', packet)).error, 'Offline target must return an error without a server crash');
} finally {
    for (const socket of clients) socket.disconnect();
    if (server) await new Promise(resolve => getIO().close(resolve));
    convo.endAllConversations();
}
for (const name of ['bot', 'DeepSeek']) {
    const config = JSON.parse(fs.readFileSync(new URL(`../mindcraft/bots/${name}/console-settings.json`, import.meta.url)));
    assert.ok(!config.blocked_actions.includes('!startConversation'));
    assert.ok(config.profile.conversing.startsWith('你叫大肥鱼'));
    assert.ok(config.profile.conversing.includes('$BOT_TEAMMATES'));
}
console.log('PASS: immediate public/direct/action-status model input during busy actions, echo suppression, batching, final message delivery, self/offline rejection, dynamic teammate IDs, one end packet, registered-agent relay, acknowledgements, invalid sender/payload rejection, illegal-chat filtering, preserved personas and enabled native tools.');
