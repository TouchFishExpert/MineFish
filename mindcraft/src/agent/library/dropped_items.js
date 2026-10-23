export const DROPPED_ITEMS_CHAR_LIMIT = 100;
export const DROPPED_ITEMS_TRUNCATION_NOTICE = '当前附近掉落物太多，已截断';
const heading = '附近掉落物（名称×数量@(x,y,z)）：';
const length = text => Array.from(text).length;

export function isDroppedItem(entity) {
    return ['item', 'Item', 'item_stack'].includes(entity?.name);
}

// Only serialize item identity/count and observed coordinates, never item NBT.
export function formatDroppedItems(nearbyEntities, random = Math.random) {
    const entries = [];
    for (const entity of nearbyEntities) {
        if (!isDroppedItem(entity) || !['x', 'y', 'z'].every(k => Number.isFinite(entity.position?.[k]))) continue;
        let item;
        try {item = entity.getDroppedItem?.();} catch { /* Metadata may not have arrived yet. */ }
        const name = String(item?.name || '未知物品').replace(/[\r\n\u0000-\u001f]/g, ' ');
        const count = Number.isInteger(item?.count) && item.count > 0 ? item.count : '?';
        const coords = ['x', 'y', 'z'].map(k => String(Math.round(entity.position[k] * 10) / 10)).join(',');
        const suffix = `×${count}@(${coords})`;
        entries.push({name, suffix, line: name + suffix});
    }
    if (!entries.length) return heading + '无';
    const complete = heading + '\n' + entries.map(e => e.line).join('\n');
    if (length(complete) <= DROPPED_ITEMS_CHAR_LIMIT) return complete;

    // Randomize whole entries, preserving complete coordinates. Reserve space
    // for the explanation so the ENTIRE drop section stays within 100 chars.
    for (let i = entries.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [entries[i], entries[j]] = [entries[j], entries[i]];
    }
    const prefix = heading + '\n', ending = '\n' + DROPPED_ITEMS_TRUNCATION_NOTICE;
    const budget = DROPPED_ITEMS_CHAR_LIMIT - length(prefix) - length(ending);
    let body = '';
    for (const entry of entries) {
        const next = body ? body + '\n' + entry.line : entry.line;
        if (length(next) <= budget) body = next;
    }
    if (!body) {
        // An unusually long item name must not cut a coordinate in half.
        const {name, suffix} = entries[0];
        const available = budget - length(suffix);
        body = Array.from(name).slice(0, Math.max(0, available - 1)).join('') + '…' + suffix;
    }
    return prefix + body + ending;
}
