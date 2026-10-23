import Vec3 from 'vec3';
import {interactionDeadline} from './interaction_deadline.js';

const crops = {
    wheat_seeds: ['wheat_seeds', 'wheat'], wheat: ['wheat_seeds', 'wheat'],
    beetroot_seeds: ['beetroot_seeds', 'beetroots'], beetroots: ['beetroot_seeds', 'beetroots'],
    carrot: ['carrot', 'carrots'], carrots: ['carrot', 'carrots'],
    potato: ['potato', 'potatoes'], potatoes: ['potato', 'potatoes'],
    melon_seeds: ['melon_seeds', 'melon_stem'], pumpkin_seeds: ['pumpkin_seeds', 'pumpkin_stem'],
    torchflower_seeds: ['torchflower_seeds', 'torchflower_crop'], pitcher_pod: ['pitcher_pod', 'pitcher_crop']
};
export function isCropPlanting(name) { return Object.hasOwn(crops, name); }

export async function plantCrop(bot, name, target, {timeoutMs = 5000} = {}) {
    const [itemName, cropName] = crops[name];
    const item = bot.inventory.findInventoryItem(itemName);
    if (!item) return {success: false, message: `Don't have any ${itemName} to plant.`};
    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0);
    const targetPos = new Vec3(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z));
    const positions = [targetPos, targetPos.offset(0, -1, 0),
        ...(bot.findBlocks({matching: bot.registry.blocksByName.farmland.id, maxDistance: 4, count: 128}) || [])];
    const seen = new Set();
    const soil = positions.map(pos => bot.blockAt(pos)).filter(block => {
        if (!block || block.name !== 'farmland') return false;
        const key = block.position.toString();
        if (seen.has(key)) return false; seen.add(key);
        const above = bot.blockAt(block.position.offset(0, 1, 0));
        return above?.name === 'air' && eye.distanceTo(block.position.offset(.5, 1, .5)) <= 4.5;
    }).sort((a, b) => a.position.distanceTo(targetPos) - b.position.distanceTo(targetPos))[0];
    if (!soil) return {success: false, message: `No empty farmland within interaction reach for ${itemName}. No blocks were removed.`};
    const destination = soil.position.offset(0, 1, 0);
    const deadline = interactionDeadline(bot, 'Planting', timeoutMs);
    let onUpdate;
    const planted = () => bot.blockAt(soil.position)?.name === 'farmland' && bot.blockAt(destination)?.name === cropName;
    try {
        await deadline.step('equip seeds', () => bot.equip(item, 'hand'));
        if (bot.blockAt(soil.position)?.name !== 'farmland' || bot.blockAt(destination)?.name !== 'air')
            return {success: false, message: `Planting target changed at ${destination}; no blocks were removed.`};
        const confirmation = new Promise(resolve => {
            onUpdate = () => { if (planted()) resolve(); };
            bot.on('blockUpdate', onUpdate);
        });
        // Use the item on the TOP face of farmland (right-click). Never dig/clear the soil.
        await deadline.step('right-click farmland', () => bot.activateBlock(soil, new Vec3(0, 1, 0), new Vec3(.5, 1, .5)));
        if (!planted()) await deadline.step('server crop confirmation', () => confirmation);
        console.log('[Planting]', JSON.stringify({item: itemName, crop: cropName, position: destination, elapsedMs: deadline.elapsedMs, confirmed: true, soil: 'farmland'}));
        return {success: true, message: `Planted ${cropName} at ${destination}; server crop update confirmed, farmland preserved.`};
    } catch (error) {
        console.warn('[Planting]', JSON.stringify({item: itemName, position: destination, elapsedMs: deadline.elapsedMs, stage: deadline.stage, error: `${error.name}: ${error.message}`}));
        throw error;
    } finally {
        if (onUpdate) bot.removeListener('blockUpdate', onUpdate);
        deadline.dispose();
    }
}
