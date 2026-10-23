import {checkAction} from '../action_context.js';
import {interactionDeadline} from './interaction_deadline.js';

const observations = new WeakMap();
const point = value => value && ['x', 'y', 'z'].every(key => Number.isFinite(value[key]))
    ? Object.fromEntries(['x', 'y', 'z'].map(key => [key, Number(value[key].toFixed(3))])) : null;
const equines = new Set(['horse', 'donkey', 'mule', 'skeleton_horse', 'zombie_horse', 'camel']);
export function vehicleKind(entity) {
    const name = entity?.name || '';
    if (name === 'boat' || name === 'chest_boat' || /_(?:boat|raft)$/.test(name)) return 'boat';
    if (equines.has(name)) return 'equine';
    if (name === 'minecart') return 'minecart';
    return null;
}

export function installRidingObservation(bot) {
    if (!bot || observations.has(bot)) return;
    const snapshots = new Map(); observations.set(bot, snapshots);
    // This Mineflayer build misses removal when set_passengers lists the other
    // remaining passengers. Reconcile only from a real server packet, never from
    // pressing Shift or assuming the leave request succeeded.
    const onPassengers = ({entityId, passengers}) => {
        if (!Number.isSafeInteger(entityId) || !Array.isArray(passengers) || !passengers.every(Number.isSafeInteger)) return;
        const previous = snapshots.get(entityId)?.ids || [];
        snapshots.set(entityId, {ids: passengers.slice(), receivedAt: Date.now()});
        // The native cache appends passengers and can retain old ordering or
        // duplicates. Replace it with the complete order sent by the server.
        const observedVehicle = bot.entities?.[entityId] || [bot.vehicle, bot.entity?.vehicle].find(entity => entity?.id === entityId);
        if (observedVehicle) {
            observedVehicle.passengers = passengers.map(id => bot.entities?.[id]
                || (id === bot.entity?.id ? bot.entity : null) || {id});
            for (const id of previous.filter(id => !passengers.includes(id))) {
                const entity = id === bot.entity?.id ? bot.entity : bot.entities?.[id];
                if (entity?.vehicle?.id === entityId) entity.vehicle = null;
            }
            for (const id of passengers) {
                const entity = id === bot.entity?.id ? bot.entity : bot.entities?.[id];
                if (entity) entity.vehicle = observedVehicle;
            }
        }
        const vehicle = bot.vehicle || bot.entity?.vehicle;
        if (passengers.includes(bot.entity?.id) && observedVehicle) bot.vehicle = observedVehicle;
        else if (vehicle?.id === entityId) {
            if (bot.vehicle?.id === entityId) bot.vehicle = null;
            if (bot.entity?.vehicle?.id === entityId) bot.entity.vehicle = null;
            bot.emit('dismount', vehicle);
        }
        bot.emit('riding-state-updated', {vehicleId: entityId});
    };
    const onDismount = vehicle => {
        if (bot.entity?.vehicle && (!vehicle || bot.entity.vehicle.id === vehicle.id)) bot.entity.vehicle = null;
    };
    bot._client?.on?.('set_passengers', onPassengers);
    bot.on?.('dismount', onDismount);
    const forget = entity => snapshots.delete(entity.id);
    const reset = () => snapshots.clear();
    bot.on?.('entityGone', forget); bot.on?.('spawn', reset);
    bot.once?.('end', () => {
        bot._client?.removeListener('set_passengers', onPassengers); bot.removeListener('dismount', onDismount);
        bot.removeListener('entityGone', forget); bot.removeListener('spawn', reset); snapshots.clear();
    });
}

export function vehicleSeats(bot, vehicle, passengerId = bot.entity?.id) {
    installRidingObservation(bot);
    const snapshot = observations.get(bot).get(vehicle.id);
    const kind = vehicleKind(vehicle), name = vehicle.name || '';
    const capacity = kind === 'boat' ? name.includes('chest') ? 1 : 2
        : kind === 'equine' ? name === 'camel' ? 2 : 1 : kind === 'minecart' ? 1 : null;
    const ids = snapshot?.ids || null;
    const index = ids?.indexOf(passengerId) ?? -1;
    const seatIndex = index >= 0 ? index : null;
    const saddleItem = vehicle.equipment?.[7]; // Protocol 1.21.6 equipment slot 7: saddle.
    const saddled = saddleItem === undefined ? null : saddleItem?.name === 'saddle';
    let seatRole = 'unknown', canControl = null, controlReason = '尚未收到该载具的有序乘客列表，座位和驾驶能力未知。';
    if (seatIndex !== null) {
        if (kind === 'boat') {
            seatRole = seatIndex === 0 ? 'driver' : 'passenger'; canControl = seatIndex === 0;
            controlReason = canControl ? '按原版船规则，第一位乘客处于驾驶位。' : '后排乘坐位，不能控制船。';
        } else if (kind === 'equine') {
            seatRole = seatIndex === 0 ? 'driver' : 'passenger';
            canControl = seatIndex > 0 ? false : saddled;
            controlReason = seatIndex > 0 ? '后排乘坐位，不能控制坐骑。'
                : saddled === true ? '驾驶位，已观察到鞍装备；按原版规则具备驾驶条件。'
                : saddled === false ? '驾驶位，但服务端装备数据显示没有鞍，尚不能操控。' : '驾驶位，但鞍装备状态未知，不能确认驾驶能力。';
        } else if (kind === 'minecart') {
            seatRole = 'passenger'; canControl = false; controlReason = '矿车乘坐位；不是船式方向驾驶，运动取决于轨道和动力。';
        } else controlReason = '已确认乘坐顺序；该实体类型的驾驶规则尚未实现。';
    }
    return {capacity, capacitySource: capacity === null ? 'unknown' : 'vanilla-1.21.6-rule',
        passengerIds: ids?.slice() ?? null, passengerCount: ids?.length ?? null,
        availableSeats: capacity !== null && ids ? Math.max(0, capacity - ids.length) : null,
        seatIndex, seatNumber: seatIndex === null ? null : seatIndex + 1, seatRole,
        canControl, ...(kind === 'equine' ? {saddled} : {}),
        source: snapshot ? 'server-passenger-packet' : 'unknown', controlReason};
}

export function ridingState(bot) {
    installRidingObservation(bot);
    const vehicle = bot.vehicle || bot.entity?.vehicle;
    return {mounted: Boolean(vehicle), vehicle: vehicle ? {id: vehicle.id ?? null,
        name: vehicle.name || vehicle.displayName || vehicle.type || '未知坐骑',
        position: point(vehicle.position), ...vehicleSeats(bot, vehicle)} : null};
}

export async function leaveBedOrVehicle(bot, {timeoutMs = 5000} = {}) {
    checkAction(bot);
    const before = {sleeping: Boolean(bot.isSleeping), ...ridingState(bot)};
    if (!before.sleeping && !before.mounted) return '当前已经站起，未在床上或坐骑/载具中，无需下乘。';
    const deadline = interactionDeadline(bot, 'Dismount', timeoutMs);
    let confirm;
    const confirmation = new Promise(resolve => {confirm = resolve;});
    const check = () => {if (!bot.isSleeping && !ridingState(bot).mounted) confirm();};
    bot.on('wake', check); bot.on('dismount', check);
    const monitor = setInterval(check, 50);
    try {
        if (before.sleeping) await deadline.step('发送起床请求', () => bot.wake());
        if (before.mounted) {
            await deadline.step('按下 Shift 下乘', () => {
                // Native Mineflayer maps sneak to player_input.inputs.shift in
                // Java 1.21.6. Its dismount() currently sends jump instead.
                bot.setControlState('sneak', false);
                bot.setControlState('sneak', true);
            });
        }
        check();
        await deadline.step('等待服务端确认起床/下乘', () => confirmation);
        return before.mounted ? `已离开 ${before.vehicle.name}；服务端已确认下乘，当前未睡觉、未乘坐载具。`
            : '已主动下床，服务端已确认醒来。';
    } finally {
        clearInterval(monitor); bot.removeListener('wake', check); bot.removeListener('dismount', check);
        deadline.dispose();
        if (before.mounted) bot.setControlState('sneak', false);
    }
}
