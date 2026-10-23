import {vehicleKind, vehicleSeats} from './riding.js';
import {isDroppedItem} from './dropped_items.js';

const point = value => value && ['x', 'y', 'z'].every(key => Number.isFinite(value[key]))
    ? Object.fromEntries(['x', 'y', 'z'].map(key => [key, Number(value[key].toFixed(3))])) : null;
export function entityObservation(bot, entity) {
    const position = point(entity.position), origin = point(bot.entity?.position);
    if (!Number.isSafeInteger(entity.id) || !position || !origin) return null;
    const result = {id: entity.id, name: entity.username || entity.name || entity.type, type: entity.name || entity.type,
        position, distance: Number(Math.hypot(...['x', 'y', 'z'].map(key => position[key] - origin[key])).toFixed(3))};
    if (vehicleKind(entity)) {
        const seats = vehicleSeats(bot, entity);
        result.seats = {capacity: seats.capacity, capacitySource: seats.capacitySource,
            passengerIds: seats.passengerIds, availableSeats: seats.availableSeats,
            ...(Object.hasOwn(seats, 'saddled') ? {saddled: seats.saddled} : {})};
    }
    return result;
}

export function formatNearbyEntityDetails(bot, entities, {maxEntries = 24, maxChars = 3200} = {}) {
    const priority = entity => vehicleKind(entity) ? 0 : entity.type === 'player' ? 1
        : ['item_frame', 'glow_item_frame', 'painting', 'armor_stand'].includes(entity.name) ? 3 : 2;
    const details = entities.filter(entity => entity !== bot.entity && entity.isValid !== false && !isDroppedItem(entity))
        .map(entity => ({entity, observation: entityObservation(bot, entity)}))
        .filter(({observation}) => observation && observation.distance <= 16)
        .sort((a, b) => priority(a.entity) - priority(b.entity) || a.observation.distance - b.observation.distance);
    const lines = []; let bodyChars = 0;
    for (const {observation: value} of details) {
        if (lines.length >= maxEntries) break;
        const seats = value.seats;
        const line = `id=${value.id} type=${value.type} name=${String(value.name).replace(/[\r\n]/g, ' ').slice(0, 40)} @(${Object.values(value.position).join(',')}) 距离=${value.distance}`
            + (seats ? ` 乘客=${seats.passengerIds === null ? '未知' : `[${seats.passengerIds.join(',')}]`} 原版容量=${seats.capacity} 预计空位=${seats.availableSeats ?? '未知'}`
                + (Object.hasOwn(seats, 'saddled') ? ` 鞍=${seats.saddled ?? '未知'}` : '') : '');
        if (bodyChars + line.length + 1 > maxChars) break;
        bodyChars += line.length + 1; lines.push(line);
    }
    return '实体明细（16格内，坐标显示至3位小数；ID仅对当前连接/实体有效）：\n'
        + (lines.join('\n') || '无')
        + (details.length > lines.length ? `\n附近实体较多，已省略 ${details.length - lines.length} 个明细；优先显示载具和坐骑。` : '');
}
