import {actionContext, checkAction, inAction, drainAction, installActionCancellation} from '../action_context.js';
import {ridingState, vehicleKind, installRidingObservation} from './riding.js';

const valid = entity => entity && entity.isValid !== false && entity.position
    && ['x', 'y', 'z'].every(key => Number.isFinite(entity.position[key]));
const distance = (bot, entity) => Math.hypot(...['x', 'y', 'z'].map(key => entity.position[key] - bot.entity.position[key]));
const describe = entity => `${entity.name} id=${entity.id}`;
function verifyTarget(bot, target, identity = {name: target.name, uuid: target.uuid}) {
    const fresh = bot.entities?.[target.id];
    if (fresh !== target || !valid(fresh) || fresh.name !== identity.name || (identity.uuid && fresh.uuid !== identity.uuid))
        throw Error(`实体 id=${target.id} 已消失或身份发生变化；请重新查询，本次不会更换目标。`);
    if (distance(bot, fresh) > 3) throw Error(`${describe(fresh)} 已移动到交互范围外，当前距离 ${distance(bot, fresh).toFixed(2)} 格；请重新查询。`);
    return fresh;
}

export function selectInteractionEntity(bot, type, entityId = null) {
    installRidingObservation(bot);
    if (entityId !== null && entityId !== undefined) {
        if (!Number.isSafeInteger(entityId) || entityId < 0) throw Error('实体 ID 必须为非负整数。');
        const entity = bot.entities?.[entityId];
        if (!valid(entity)) throw Error(`实体 id=${entityId} 已消失或未加载；请重新查询 !entities，本次不会更换目标。`);
        if (entity.name !== type) throw Error(`实体 id=${entityId} 实际类型为 ${entity.name}，与 ${type} 不符；本次不会更换目标。`);
        if (distance(bot, entity) > 64) throw Error(`实体 id=${entityId} 已超出 64 格交互搜索范围；请重新查询。`);
        return entity;
    }
    const entities = Object.values(bot.entities || {}).filter(entity => valid(entity) && entity !== bot.entity
        && entity.name === type && distance(bot, entity) <= 64)
        .sort((a, b) => distance(bot, a) - distance(bot, b));
    const target = entities[0];
    if (!target) throw Error(`64 格内没有找到可用的 ${type}。`);
    return target;
}

// One local deadline covers native right-click + server mount confirmation.
// A child action signal prevents a timed-out smooth look from clicking later.
async function mountAndConfirm(bot, target, timeoutMs) {
    installActionCancellation(bot);
    const parent = actionContext(bot), controller = new AbortController();
    const identity = {name: target.name, uuid: target.uuid};
    const context = {...parent, bot, signal: controller.signal, operations: parent?.operations || new Set(),
        beforeEntityInteraction: payload => {
            if (payload.target !== target.id) throw Error('上乘交互目标不一致，已取消。');
            verifyTarget(bot, target, identity);
        }};
    const onCancel = () => controller.abort(parent.signal.reason);
    if (parent?.signal.aborted) onCancel(); else parent?.signal.addEventListener('abort', onCancel, {once: true});
    const timeout = Object.assign(new Error(`上乘 ${describe(target)} 在 ${timeoutMs}ms 内未获服务端确认。`), {name: 'MountTimeout'});
    const timer = setTimeout(() => controller.abort(timeout), timeoutMs);
    let confirm, rejectConfirmation;
    const confirmation = new Promise((resolve, reject) => {confirm = resolve; rejectConfirmation = reject;});
    confirmation.catch(() => {});
    const check = () => {
        const state = ridingState(bot);
        if (state.mounted && state.vehicle.id === target.id && state.vehicle.source === 'server-passenger-packet'
            && state.vehicle.seatIndex !== null) confirm(state);
    };
    const abort = () => rejectConfirmation(controller.signal.reason);
    const ended = () => controller.abort(new Error('连接已断开，无法确认上乘。'));
    controller.signal.addEventListener('abort', abort, {once: true});
    bot.on('mount', check); bot.on('riding-state-updated', check); bot.on('end', ended);
    try {
        return await inAction(context, async () => {
            checkAction(bot);
            if (controller.signal.aborted) throw controller.signal.reason;
            await Promise.race([bot.activateEntity(target), confirmation]);
            check();
            const state = await confirmation;
            checkAction(bot);
            return state;
        });
    } finally {
        clearTimeout(timer); parent?.signal.removeEventListener('abort', onCancel);
        if (!controller.signal.aborted) controller.abort(new Error('上乘交互已结束。'));
        controller.signal.removeEventListener('abort', abort);
        bot.removeListener('mount', check); bot.removeListener('riding-state-updated', check); bot.removeListener('end', ended);
        await drainAction(context);
    }
}

export async function interactWithEntity(bot, {type, entityId = null, toolName, navigate, equip, log, timeoutMs = 5000}) {
    checkAction(bot);
    const mounting = toolName === 'hand' && Boolean(vehicleKind({name: type}));
    const target = selectInteractionEntity(bot, type, entityId);
    const id = target.id, uuid = target.uuid;
    if (mounting) {
        const current = ridingState(bot);
        if (current.mounted) {
            if (current.vehicle.id === id) {log(`当前已经乘坐 ${describe(target)}，未重复右键。`); return true;}
            throw Error(`当前正乘坐 ${current.vehicle.name} id=${current.vehicle.id}，请先 !dismount()。`);
        }
    }
    if (await navigate(target.position) === false) throw Error(`未能到达 ${describe(target)} 附近，尚未发送交互请求。`);
    checkAction(bot);
    const fresh = bot.entities?.[id];
    if (fresh !== target || !valid(fresh) || fresh.name !== type || (uuid && fresh.uuid !== uuid))
        throw Error(`实体 id=${id} 已消失或身份发生变化；请重新查询，本次不会更换目标。`);
    if (distance(bot, fresh) > 3) throw Error(`${describe(fresh)} 已移动到交互范围外，当前距离 ${distance(bot, fresh).toFixed(2)} 格；请重新查询。`);
    if (toolName === 'hand') await bot.unequip('hand');
    else if (!await equip(toolName)) return false;
    checkAction(bot);
    verifyTarget(bot, target, {name: type, uuid});
    if (mounting) {
        if (bot.getControlState?.('sneak')) bot.setControlState('sneak', false);
        const state = await mountAndConfirm(bot, fresh, timeoutMs);
        log(`服务端已确认乘坐 ${describe(fresh)}；座位 ${state.vehicle.seatNumber}；角色 ${state.vehicle.seatRole}；${state.vehicle.controlReason}`);
    } else {
        await bot.useOn(fresh);
        log(`已向 ${describe(fresh)} 发送 ${toolName} 的右键交互请求；具体效果尚未单独确认。`);
    }
    return true;
}
