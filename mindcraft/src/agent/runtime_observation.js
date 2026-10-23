import {getMaxHealth} from './library/health.js';
import {redactLog} from '../utils/log_redaction.js';
import {isDroppedItem} from './library/dropped_items.js';
import {getWebSearchState} from '../utils/deepseek_web_search.js';
import {ridingState, installRidingObservation} from './library/riding.js';
import {entityObservation} from './library/entity_observation.js';

export const LIVE_STATE_SLOT = '[[MINDCRAFT_LIVE_STATE_AT_SEND]]';
export const NEARBY_PICKUP_RADIUS = 16;
export const RECENT_PICKUP_LIMIT = 12;
const point = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]))
    ? Object.fromEntries(['x', 'y', 'z'].map(k => [k, Number(p[k].toFixed(3))])) : null;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const rounded = n => Number(n.toFixed(3));
const safe = (read, fallback = null) => {try {return read() ?? fallback;} catch {return fallback;}};
const excerpt = (text, size = 500) => redactLog(String(text || '')).slice(-size);

// Passive observation only. No movement controls, goals, waits, or model calls.
// A command name/control key is intention, never evidence of physical movement.
export class RuntimeObservation {
    constructor(agent, {now = Date.now, intervalMs = 100} = {}) {
        this.agent = agent; this.bot = agent.bot; this.now = now;
        installRidingObservation(this.bot);
        this.samples = []; this.events = []; this.listeners = [];
        this.pickups = []; this.pickupSequence = 0;
        this.lastPhysicsAt = null; this.lastPacketAt = null; this.lastCorrectionAt = null;
        this.lastProgressAt = now(); this.anchor = null; this.ended = false;
        const on = (emitter, event, fn) => {
            if (!emitter?.on) return;
            emitter.on(event, fn); this.listeners.push(() => emitter.removeListener(event, fn));
        };
        on(this.bot, 'physicsTick', () => {this.lastPhysicsAt = now(); this.sample();});
        on(this.bot._client, 'packet', () => {this.lastPacketAt = now();});
        // playerCollect drops the protocol's pickupItemCount. Read the server
        // packet while the item entity/metadata still exists; do not infer a
        // pickup from an entity disappearing or from its original stack size.
        on(this.bot._client, 'collect', packet => this.recordPickup(packet));
        on(this.bot, 'forcedMove', () => {
            this.lastCorrectionAt = now(); this.reset();
            this.notice('position-correction', '收到服务端位置设置/校正，已重新采样；不将这次坐标跳变算作走路。');
        });
        on(this.bot, 'spawn', () => this.reset());
        on(this.bot, 'path_update', result => {
            this.path = {at: now(), status: result.status, nodes: result.path?.length ?? null};
            if (['noPath', 'timeout'].includes(result.status)) this.notice('path', `寻路反馈：${result.status}`);
        });
        on(this.bot, 'path_reset', reason => {this.pathReset = {at: now(), reason: excerpt(reason, 120)};});
        on(this.bot, 'goal_updated', () => {this.path = null; this.pathReset = null; this.lastProgressAt = now();});
        on(this.bot, 'error', error => this.notice('error', error?.message || error));
        on(this.bot, 'entityHurt', entity => {
            if (entity && (entity === this.bot.entity || entity.id === this.bot.entity?.id)) this.notice('hurt', '收到自身受伤事件。');
        });
        on(this.bot, 'end', () => {this.ended = true; this.dispose();});
        this.sample();
        if (intervalMs > 0) {this.timer = setInterval(() => this.sample(), intervalMs); this.timer.unref?.();}
    }
    dispose() {clearInterval(this.timer); this.listeners.splice(0).forEach(remove => remove());}
    reset() {this.samples = []; this.anchor = null; this.lastProgressAt = this.now(); this.sample();}
    notice(kind, text) {
        this.events.push({at: this.now(), kind, text: excerpt(text, 220)});
        this.events = this.events.slice(-8);
    }
    recordPickup(packet) {
        const bot = this.bot, collected = bot.entities?.[packet.collectedEntityId];
        const position = point(collected?.position), origin = point(bot.entity?.position);
        if (!isDroppedItem(collected) || !position || !origin) return;
        const observedDistance = distance(collected.position, bot.entity.position);
        if (observedDistance > NEARBY_PICKUP_RADIUS) return;
        const collector = bot.entities?.[packet.collectorEntityId]
            || (packet.collectorEntityId === bot.entity?.id ? bot.entity : null);
        const self = packet.collectorEntityId === bot.entity?.id;
        const item = safe(() => collected.getDroppedItem());
        const event = redactLog({id: ++this.pickupSequence, at: new Date(this.now()).toISOString(),
            dimension: bot.game?.dimension ?? '未知',
            collector: {entityId: packet.collectorEntityId,
                name: excerpt(collector?.username || (self ? bot.username || this.agent.name : collector?.name) || '未知拾取者', 80),
                type: collector?.type || (self ? 'player' : '未知'), self},
            item: excerpt(item?.name || '未知物品', 100),
            count: Number.isSafeInteger(packet.pickupItemCount) && packet.pickupItemCount > 0 ? packet.pickupItemCount : null,
            position, distanceAtPickup: rounded(observedDistance)});
        this.pickups.push(event);
        this.pickups = this.pickups.slice(-RECENT_PICKUP_LIMIT);
        // Journal events do not append to the ten-round prompt window or start
        // a new model request. Every pickup remains in this bot's durable log.
        safe(() => this.agent.history?.recordEvent?.('nearby-item-pickup', event));
    }
    pickupSnapshot() {
        return {radiusBlocks: NEARBY_PICKUP_RADIUS, maxEvents: RECENT_PICKUP_LIMIT,
            olderEventsOmitted: Math.max(0, this.pickupSequence - this.pickups.length),
            events: structuredClone(this.pickups)};
    }
    sample() {
        const position = point(this.bot.entity?.position), at = this.now();
        if (!position) return;
        const previous = this.samples.at(-1);
        if (previous && distance(position, previous.position) > 4) {
            this.lastCorrectionAt = at; this.samples = []; this.anchor = null;
            this.notice('position-jump', '检测到坐标突变，已重新采样；跳变不计入移动速度。');
        }
        if (!this.anchor || distance(position, this.anchor) >= 0.05) {this.anchor = position; this.lastProgressAt = at;}
        if (this.samples.at(-1)?.at === at) this.samples.pop();
        this.samples.push({at, position, ground: this.bot.entity.onGround});
        this.samples = this.samples.filter(s => at - s.at <= 2000).slice(-50);
    }
    motion() {
        const now = this.now(); this.sample();
        const recent = this.samples.filter(s => now - s.at <= 400), first = recent[0], last = recent.at(-1);
        const durationMs = first ? last.at - first.at : 0;
        let horizontal = 0, vertical = 0;
        for (let i = 1; i < recent.length; i++) {
            const a = recent[i - 1].position, b = recent[i].position;
            horizontal += Math.hypot(b.x - a.x, b.z - a.z); vertical += Math.abs(b.y - a.y);
        }
        const physicsAgeMs = this.lastPhysicsAt === null ? null : now - this.lastPhysicsAt;
        const reliable = !this.ended && durationMs >= 200 && physicsAgeMs !== null && physicsAgeMs <= 1000;
        const moving = reliable ? horizontal >= 0.025 : null;
        const dy = first ? last.position.y - first.position.y : 0;
        const airborne = this.bot.entity?.onGround === false;
        const jumpHeld = this.bot.controlState?.jump === true;
        let state = '未知（采样不足或物理更新过期）';
        if (reliable) {
            const verticalState = airborne && vertical >= 0.025 ? (dy > 0.025 ? (jumpHeld ? '跳跃上升' : '上升') : dy < -0.025 ? '下落' : '腾空') : '';
            state = moving ? (verticalState === '跳跃上升' ? '正在移动跳跃' : `正在移动${verticalState ? '、' + verticalState : ''}`)
                : verticalState ? `水平静止、${verticalState}` : '静止中';
        }
        return {state, moving, position: point(this.bot.entity?.position), windowMs: durationMs,
            horizontalBlocks: rounded(horizontal), verticalBlocks: rounded(vertical),
            horizontalSpeed: durationMs ? rounded(horizontal * 1000 / durationMs) : null,
            unchangedForMs: now - this.lastProgressAt, physicsAgeMs,
            lastServerPacketAgeMs: this.lastPacketAt === null ? null : now - this.lastPacketAt,
            lastPositionCorrectionAgeMs: this.lastCorrectionAt === null ? null : now - this.lastCorrectionAt,
            onGround: this.bot.entity?.onGround ?? null, inWater: this.bot.entity?.isInWater ?? null,
            velocityPerTick: point(this.bot.entity?.velocity),
            controls: Object.keys(this.bot.controlState || {}).filter(key => this.bot.controlState[key] === true)};
    }
}

export function installRuntimeObservation(agent, options) {
    if (agent.runtimeObservation?.bot === agent.bot) return agent.runtimeObservation;
    agent.runtimeObservation?.dispose();
    return agent.runtimeObservation = new RuntimeObservation(agent, options);
}

function environment(bot) {
    const p = bot.entity?.position;
    const block = (dx, dy, dz) => safe(() => bot.blockAt(p.offset(dx, dy, dz))?.name, '未加载');
    const types = new Map(); let unloaded = 0;
    // Fixed 5x5x4 local volume; no unbounded world/path searches on the API path.
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) for (let y = -1; y <= 2; y++) {
        const name = block(x, y, z);
        if (name === '未加载') unloaded++;
        else if (!['air', 'cave_air', 'void_air'].includes(name)) types.set(name, (types.get(name) || 0) + 1);
    }
    const priority = e => e.type === 'player' || e.username ? 0 : ['item_frame', 'glow_item_frame', 'painting', 'armor_stand'].includes(e.name) ? 2 : 1;
    const nearby = Object.values(bot.entities || {}).filter(e => e !== bot.entity && point(e.position) && p && distance(e.position, p) <= 16)
        .sort((a, b) => priority(a) - priority(b) || distance(a.position, p) - distance(b.position, p));
    return {dimension: bot.game?.dimension ?? '未知', biome: safe(() => bot.registry.biomes[bot.world.getBiome(p)].name, '未知'),
        timeOfDay: bot.time?.timeOfDay ?? null, weather: bot.thunderState > 0 ? '雷雨' : bot.rainState > 0 ? '下雨' : '晴',
        feet: block(0, 0, 0), head: block(0, 1, 0), below: block(0, -1, 0),
        adjacentFeet: {north: block(0, 0, -1), south: block(0, 0, 1), east: block(1, 0, 0), west: block(-1, 0, 0)},
        localBlockScan: '脚部方块周围x/z各2格，y为-1至+2；不代表全部已加载区块',
        localBlocks: Object.fromEntries([...types].sort((a, b) => b[1] - a[1]).slice(0, 20)), unloadedBlocks: unloaded,
        entitiesWithin16: nearby.slice(0, 12).map(e => entityObservation(bot, e)
            || {name: e.username || e.name || e.type, position: point(e.position), distance: rounded(distance(e.position, p))}),
        omittedEntities: Math.max(0, nearby.length - 12)};
}

export function captureRuntimeState(agent) {
    if (!agent.bot) return {capturedAt: new Date().toISOString(), name: agent.name,
        tools: {webSearch: getWebSearchState(agent)}, unavailable: '客户端尚未初始化，实际状态未知。'};
    const observer = installRuntimeObservation(agent), bot = agent.bot, now = observer.now(), record = agent.actions?.current;
    const goal = bot.pathfinder?.goal;
    const navigation = goal ? {kind: goal.constructor?.name, ...Object.fromEntries(['x', 'y', 'z', 'range', 'rangeSq'].filter(k => Number.isFinite(goal[k])).map(k => [k, goal[k]])),
        targetPlayer: goal.entity?.username, pathfinderDriving: safe(() => bot.pathfinder.isMoving()),
        lastPath: observer.path, lastReset: observer.pathReset} : null;
    const motion = observer.motion(), riding = ridingState(bot);
    return redactLog({capturedAt: new Date(now).toISOString(), name: agent.name, motion,
        action: {label: agent.actions?.currentActionLabel || null,
            phase: record ? record.signal.aborted ? '正在取消并清理'
                : record.label === 'action:goToBed' || agent.actions?.currentActionLabel === 'action:goToBed'
                    ? bot.isSleeping ? '已入睡，等待自然醒来' : '睡觉动作进行中，尚未确认入睡'
                    : '调用尚未返回' : '无动作调用',
            actualState: bot.isSleeping ? '正在睡觉' : riding.mounted ? `正在乘坐 ${riding.vehicle.name}（${riding.vehicle.seatRole === 'driver' ? '驾驶位' : riding.vehicle.seatRole === 'passenger' ? '乘坐位' : '座位未知'}）；${motion.state}` : motion.state,
            id: record?.id, arguments: record?.arguments || [], elapsedMs: record ? now - record.startedAt : null, pendingNativeOperations: record?.operations?.size ?? 0,
            timedout: record?.timedout ?? false, error: record?.error ? excerpt(record.error) : null,
            navigation, noMovementWarning: Boolean(navigation && motion.moving === false && motion.unchangedForMs >= 2000 && !bot.targetDigBlock),
            diggingTarget: bot.targetDigBlock ? {name: bot.targetDigBlock.name, position: point(bot.targetDigBlock.position)} : null,
            usingItem: Boolean(bot.usingHeldItem), openWindow: bot.currentWindow?.type ?? null,
            recentOutput: excerpt(bot.output), lastResult: agent.actions?.lastResult || null},
        vitals: {health: bot.health ?? null, maxHealth: getMaxHealth(bot), hunger: bot.food ?? null, sleeping: Boolean(bot.isSleeping), mainHand: bot.heldItem?.name ?? null},
        posture: {sleeping: Boolean(bot.isSleeping), ...riding},
        tools: {webSearch: getWebSearchState(agent)},
        environment: environment(bot), recentPickups: observer.pickupSnapshot(),
        recentEvents: observer.events.filter(e => now - e.at <= 120000).slice(-4)});
}

export function prepareRuntimePrompt(prompt, agent) {
    const state = captureRuntimeState(agent);
    return prompt.replaceAll(LIVE_STATE_SLOT, '') + '\n\n【本次调用前的实时状态】\n'
        + (state.action ? `当前动作：${state.action.label || '无'}；阶段：${state.action.phase}；实际状态：${state.action.actualState}；sleeping=${state.vitals.sleeping}。\n` : '')
        + '以下为最新客户端实体/物理采样与已加载环境；优先于历史状态。动作名、按键和寻路器状态只表示调用意图；实际移动以坐标采样为准。静止不等于完成，调用未返回不等于正在移动；异常线索不等于已确定原因。未加载/过期数据为未知，客户端位置并非服务端连续权威确认。\n'
        + 'recentPickups 是服务端确认的附近掉落物拾取记录：collector 为拾取者，item 为物品，count 为实际拾取数量（null 表示未知），position 为拾取位置。保留本次连接最近12条，按 id/at 判断新旧；不是每轮都刚刚发生，空列表表示尚未记录到，不代表远处没有拾取。\n'
        + 'tools.webSearch 是联网工具的实际状态：running=true 表示原调用尚未返回；requestState=queued 是等待 API 槽位，requesting 是请求已开始，received 是已收到接口结果正在处理，retry-backoff 是等待重试。原调用会返回完整结果，无需重复启动相同搜索。完成状态属于最近一次搜索，并不表示此刻仍在搜索。\n'
        + 'posture.vehicle 的 seatIndex 从0开始、seatNumber 从1开始，seatRole 为驾驶位(driver)/乘坐位(passenger)/未知(unknown)。乘坐顺序来自服务端；容量和canControl按原版1.21.6规则及已观察到的装备推断，null表示未知，不代表正在驾驶、已经移动或已获服务器额外权限；模组可改变规则。马处于驾驶位仍需确认鞍；矿车不按船的方式转向。环境实体的 id 可用于 !useOn 第三个可选参数，失效时重新查询，不编造ID。\n'
        + JSON.stringify(state);
}
