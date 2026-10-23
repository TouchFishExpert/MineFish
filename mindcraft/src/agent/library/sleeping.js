import {setTimeout as delay} from 'node:timers/promises';
import {checkAction} from '../action_context.js';

const isBed = (bot, block) => Boolean(block && (bot.isABed ? bot.isABed(block) : /(?:^|_)bed$/.test(block.name)));
const key = position => `${position.x},${position.y},${position.z}`;

// Canonicalize both halves to the head. Occupancy on either half excludes it.
export function inspectBed(bot, block) {
    if (!isBed(bot, block)) return null;
    const metadata = bot.parseBedMetadata?.(block);
    const properties = block.getProperties?.() || block._properties || {};
    let head = block;
    if (metadata?.part === false && metadata.headOffset) {
        head = bot.blockAt(block.position.plus(metadata.headOffset));
        if (!isBed(bot, head)) return null;
    } else if (!metadata && properties.part === 'foot') {
        const offsets = {north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0]};
        const offset = offsets[properties.facing];
        head = offset && bot.blockAt(block.position.offset(...offset));
        if (!isBed(bot, head)) return null;
    }
    const occupied = value => {
        const props = value.getProperties?.() || value._properties || {};
        const flag = props.occupied ?? bot.parseBedMetadata?.(value)?.occupied;
        return flag === true || flag === 1 || flag === 'true';
    };
    const headMetadata = bot.parseBedMetadata?.(head);
    const headProperties = head.getProperties?.() || head._properties || {};
    const offsets = {north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0]};
    const offset = headMetadata?.headOffset || (offsets[headProperties.facing] && {
        x: offsets[headProperties.facing][0], y: 0, z: offsets[headProperties.facing][2]});
    const foot = offset ? bot.blockAt(head.position.offset(-offset.x, -offset.y, -offset.z)) : null;
    if (offset && !isBed(bot, foot)) return null;
    return {block: head, occupied: occupied(block) || occupied(head) || Boolean(foot && occupied(foot))};
}

export function nearestEmptyBeds(bot) {
    const positions = bot.findBlocks({matching: block => isBed(bot, block),
        useExtraInfo: block => {const bed = inspectBed(bot, block); return Boolean(bed && !bed.occupied);},
        maxDistance: 32, count: 128});
    const seen = new Set(), beds = [];
    for (const position of positions) {
        const result = inspectBed(bot, bot.blockAt(position));
        if (!result || result.occupied || seen.has(key(result.block.position))) continue;
        seen.add(key(result.block.position)); beds.push(result.block);
    }
    return beds.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
}

export async function sleepInNearestEmptyBed(bot, {navigate, log}) {
    checkAction(bot);
    if (bot.isSleeping) {log('当前已经入睡，继续保持睡眠；未重复寻找或点击床。'); return true;}
    const beds = nearestEmptyBeds(bot);
    if (!beds.length) {log('32 格内没有找到已加载的空床；不会尝试使用被占用的床。'); return false;}
    for (const candidate of beds) {
        checkAction(bot);
        if (await navigate(candidate.position) === false) {log(`无法到达空床 ${candidate.position}，尝试下一张。`); continue;}
        checkAction(bot);
        const fresh = inspectBed(bot, bot.blockAt(candidate.position));
        if (!fresh || fresh.occupied) {log(`床 ${candidate.position} 已被占用或不再可用，改找下一张空床。`); continue;}
        const signal = bot._actionSignal;
        try {
            try {await bot.sleep(fresh.block);}
            catch (error) {
                checkAction(bot);
                const latest = inspectBed(bot, bot.blockAt(candidate.position));
                if (/occupied/i.test(error.message) || latest?.occupied) {
                    log(`床 ${candidate.position} 刚被占用，尝试下一张空床。`); continue;
                }
                throw error;
            }
            checkAction(bot);
            log('已经入睡，正在等待自然醒来。');
            bot.modes.pause('unstuck');
            while (bot.isSleeping) {checkAction(bot); await delay(500, undefined, {signal});}
            log('已经醒来。'); return true;
        } finally {
            if (signal?.aborted && bot.isSleeping) {
                try {await bot.wake();}
                catch (error) {console.warn('Sleep cancellation wake failed:', error.message);}
            }
        }
    }
    log('附近候选空床已被占用、失效或无法到达，未能入睡。');
    return false;
}
