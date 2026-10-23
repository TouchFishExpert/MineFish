import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {captureRuntimeState, installRuntimeObservation, prepareRuntimePrompt, LIVE_STATE_SLOT} from '../mindcraft/src/agent/runtime_observation.js';
import {Prompter} from '../mindcraft/src/models/prompter.js';
import {DeepSeek} from '../mindcraft/src/models/deepseek.js';
import {ActionManager} from '../mindcraft/src/agent/action_manager.js';
import {registerLogSecret} from '../mindcraft/src/utils/log_redaction.js';
const require = createRequire(new URL('../mindcraft/package.json', import.meta.url));
const {Vec3} = require('vec3');
const agents = [];
function fixture(name = 'fixture') {
    let clock = 100000, blockName = 'stone';
    const bot = new EventEmitter(); bot._client = new EventEmitter();
    Object.assign(bot, {entity: {id: 1, position: new Vec3(0, 64, 0), velocity: new Vec3(1, 0, 0), onGround: true},
        entities: {}, controlState: {forward: true}, health: 20, food: 18, game: {dimension: 'overworld'},
        time: {timeOfDay: 5000}, registry: {biomes: {1: {name: 'plains'}}}, world: {getBiome: () => 1},
        blockAt: position => position.y === 65 ? null : {name: blockName}, output: '', interrupt_code: false});
    const agent = {name, bot, actions: {currentActionLabel: 'action:goToCoordinates', current: {
        id: name + '-action', startedAt: clock, signal: new AbortController().signal, operations: new Set()}},
        clearBotLogs: () => {bot.output = ''; bot.interrupt_code = false;}, self_prompter: {isActive: () => false}};
    class GoalNear {constructor() {this.x = 30; this.y = 64; this.z = 0; this.rangeSq = 1;}}
    bot.pathfinder = {goal: new GoalNear(), isMoving: () => true};
    const observer = installRuntimeObservation(agent, {now: () => clock, intervalMs: 0});
    const advance = (ms = 100, dx = 0, dy = 0) => {
        clock += ms; bot.entity.position = bot.entity.position.offset(dx, dy, 0); bot.emit('physicsTick');
    };
    agents.push(agent);
    return {agent, bot, observer, advance, freeze: ms => {clock += ms;}, setBlock: name => {blockName = name;}};
}
try {
    const f = fixture('bot');
    assert.equal(captureRuntimeState(f.agent).motion.moving, null, 'No fabricated movement before enough samples');
    for (let n = 0; n < 25; n++) f.advance();
    let state = captureRuntimeState(f.agent);
    assert.equal(state.action.label, 'action:goToCoordinates'); assert.equal(state.motion.state, '静止中');
    assert.equal(state.motion.moving, false); assert.equal(state.motion.horizontalSpeed, 0);
    assert.equal(state.action.navigation.pathfinderDriving, true); assert.equal(state.action.noMovementWarning, true);
    assert.ok(state.motion.controls.includes('forward'), 'Control intent cannot override stationary samples or synthetic velocity');
    assert.equal(state.environment.head, '未加载'); assert.ok(state.environment.unloadedBlocks > 0);
    f.bot.emit('path_update', {status: 'noPath', path: []});
    f.bot.emit('error', new Error('local navigation failure')); f.bot.output = 'Navigation has not reached destination';
    state = captureRuntimeState(f.agent);
    assert.equal(state.action.navigation.lastPath.status, 'noPath'); assert.match(state.action.recentOutput, /not reached/);
    assert.ok(state.recentEvents.some(e => e.text.includes('local navigation failure')));

    for (let n = 0; n < 4; n++) f.advance(100, .2);
    state = captureRuntimeState(f.agent); assert.equal(state.motion.state, '正在移动'); assert.equal(state.motion.horizontalSpeed, 2);
    f.bot.controlState.jump = true; f.bot.entity.onGround = false;
    for (let n = 0; n < 4; n++) f.advance(100, .2, .15);
    assert.equal(captureRuntimeState(f.agent).motion.state, '正在移动跳跃');
    f.bot.entity.onGround = true;
    for (let n = 0; n < 5; n++) f.advance();
    assert.equal(captureRuntimeState(f.agent).motion.state, '静止中', 'Moving and jump keys still held cannot fabricate observed motion');
    f.bot.entity.position = new Vec3(200, 70, 200); f.bot.emit('forcedMove');
    assert.equal(captureRuntimeState(f.agent).motion.moving, null, 'Teleport/correction is not walking');
    for (let n = 0; n < 4; n++) f.advance();
    assert.equal(captureRuntimeState(f.agent).motion.state, '静止中');
    f.freeze(2000); assert.equal(captureRuntimeState(f.agent).motion.moving, null, 'Stale physics cannot claim current stationary/moving state');

    const other = fixture('DeepSeek'); for (let n = 0; n < 4; n++) other.advance();
    other.bot.entities[2] = {username: 'GGboy', position: new Vec3(3, 64, 0)};
    other.setBlock('farmland'); state = captureRuntimeState(other.agent);
    assert.equal(state.environment.feet, 'farmland'); assert.equal(state.environment.entitiesWithin16[0].name, 'GGboy');
    assert.ok(!state.recentEvents.some(e => e.text.includes('local navigation failure')), 'Per-bot observations stay isolated');

    // Feed real action-manager failures back after logs have been cleared.
    other.agent.actions = new ActionManager(other.agent);
    const failed = await other.agent.actions.runAction('action:move', async () => {throw new Error('GoalNotReached: fixture');}, {timeout: -1});
    assert.equal(failed.success, false); state = captureRuntimeState(other.agent);
    assert.equal(state.action.label, null); assert.equal(state.action.lastResult.state, '异常退出');
    assert.match(state.action.lastResult.error, /GoalNotReached/);
    assert.match(state.action.lastResult.output, /GoalNotReached/);

    // Actual Prompter -> DeepSeek SDK -> HTTP body. Observe after asynchronous
    // preparation, even for a customized profile with no $STATS placeholder.
    process.env.DEEPSEEK_API_KEY = 'unit-live-state-key'; const wire = [];
    const model = new DeepSeek('deepseek-flash', 'https://api.deepseek.com', {}, {fetch: async (_url, init) => {
        wire.push(JSON.parse(init.body));
        return new Response(JSON.stringify({id: 'fixture-response', choices: [{finish_reason: 'stop', message: {content: '状态已读取'}}]}), {headers: {'content-type': 'application/json'}});
    }, publish: () => {}});
    let loggedPrompt;
    const prompter = Object.assign(Object.create(Prompter.prototype), {agent: other.agent, profile: {conversing: '自定义角色，没有状态占位符'},
        convo_examples: null, chat_model: model, checkCooldown: async () => {}, applyMemoryContext: p => p,
        replaceStrings: async p => {await Promise.resolve(); other.setBlock('dirt'); other.advance(100, .3); return p;},
        _saveLog: async p => {loggedPrompt = p;}});
    const history = [{role: 'user', content: '看看当前情况', roundId: 'current', currentRound: true}], before = JSON.stringify(history);
    assert.equal(await prompter.promptConvo(history), '状态已读取');
    let content = wire[0].messages.map(m => m.content).join('\n');
    assert.ok(content.includes('【本次调用前的实时状态】')); assert.ok(content.includes('"feet":"dirt"'));
    assert.ok(content.includes('"position":{"x":0.3')); assert.ok(content.includes('GoalNotReached'));
    assert.ok(content.includes(loggedPrompt)); assert.equal(JSON.stringify(history), before, 'Snapshot is ephemeral, not appended to ten-round history');
    assert.equal((content.match(/【本次调用前的实时状态】/g) || []).length, 1);
    assert.ok(!content.includes(LIVE_STATE_SLOT));
    let releaseAction;
    const busy = other.agent.actions.runAction('action:goToCoordinates', () => new Promise(resolve => {releaseAction = resolve;}), {timeout: -1});
    await new Promise(resolve => setImmediate(resolve));
    for (let n = 0; n < 5; n++) other.advance();
    prompter.replaceStrings = async p => p;
    await prompter.promptConvo(history, {priority: true});
    content = wire[1].messages.map(m => m.content).join('\n');
    const busyState = JSON.parse(content.split('\n').find(line => line.startsWith('{"capturedAt":')));
    assert.equal(busyState.action.label, 'action:goToCoordinates'); assert.equal(busyState.action.phase, '调用尚未返回');
    assert.equal(busyState.motion.state, '静止中'); assert.ok(other.agent.actions.current, 'Model call must finish while the real action promise remains pending');
    releaseAction(); await busy;
    await prompter.requestModel(model, [], '压缩记忆，不需要环境', 'memory-compaction');
    assert.ok(!wire[2].messages.some(m => m.content.includes('本次调用前的实时状态')), 'No new status payload in memory-maintenance requests');
    const expanded = await Prompter.prototype.replaceStrings.call({agent: other.agent}, '$STATS', []);
    assert.equal(expanded, LIVE_STATE_SLOT);
    assert.ok(!prepareRuntimePrompt(expanded, other.agent).includes(LIVE_STATE_SLOT));
    registerLogSecret('fixture-secret'); other.bot.output = 'fixture-secret';
    assert.ok(!prepareRuntimePrompt('test', other.agent).includes('fixture-secret'));
    console.log('PASS: physical coordinate sampling distinguishes commanded-but-stationary, moving, jumping, stopped, teleport and stale physics; fresh bounded environment and path/error feedback; actual SDK wire content sampled after async preparation, per-bot isolation, one ephemeral snapshot, no history accumulation or memory-call payload.');
} finally {for (const agent of agents) agent.runtimeObservation?.dispose();}
