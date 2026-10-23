import {randomUUID} from 'node:crypto';
import Vec3 from 'vec3';

const pending = new WeakMap();
const round = value => Math.round(value * 1000) / 1000;
const position = vector => ({x: vector.x, y: vector.y, z: vector.z});
const output = (bot, message) => {bot.output += message + '\n';};
const normalized = name => String(name).replace(/^minecraft:/, '').replace(/^generic\./, '');

function attribute(bot, name, fallback) {
    const prop = Object.entries(bot.entity.attributes || {}).find(([key]) => normalized(key) === name)?.[1];
    if (!prop || !Number.isFinite(prop.value)) return fallback;
    let base = prop.value;
    for (const mod of prop.modifiers || []) if (mod.operation === 0 || mod.operation === 'add_value') base += mod.amount;
    let value = base;
    for (const mod of prop.modifiers || []) if (mod.operation === 1 || mod.operation === 'add_multiplied_base') value += base * mod.amount;
    for (const mod of prop.modifiers || []) if (mod.operation === 2 || mod.operation === 'add_multiplied_total') value *= 1 + mod.amount;
    return Number.isFinite(value) ? value : fallback;
}

function effect(bot, name) {
    const id = bot.registry?.effectsByName?.[name]?.id;
    return id === undefined ? null : bot.entity.effects?.[id] || null;
}

function enchantment(item, name) {
    return Math.max(0, ...(item?.enchants || []).filter(enchant => normalized(enchant.name) === name).map(enchant => Number(enchant.lvl) || 0));
}

// Estimates vanilla Java health points (2 HP = one heart), not a promise of server-side damage.
export function estimateFallDamage(bot, height, landingName) {
    const notes = ['原版 Java 估算；服务器模组、游戏规则和落地过程可能改变实际伤害。普通护甲值不减免摔落伤害；未计入吸收生命。'];
    const safeDistance = attribute(bot, 'safe_fall_distance', 3);
    const multiplier = Math.max(0, attribute(bot, 'fall_damage_multiplier', 1));
    // Use synchronized safe_fall_distance when available; do not double-count Jump Boost modifiers.
    const jump = effect(bot, 'JumpBoost');
    const hasSafeAttribute = Object.keys(bot.entity.attributes || {}).some(key => normalized(key) === 'safe_fall_distance');
    const jumpAllowance = !hasSafeAttribute && jump ? jump.amplifier + 1 : 0;
    if (hasSafeAttribute && jump) notes.push('以服务器安全摔落距离为准，未另叠加弹跳减免，可能保守高估。');
    const baseDamageHp = Math.max(0, Math.ceil((height - safeDistance - jumpAllowance) * multiplier - 1e-6));
    let damage = baseDamageHp;
    let feather = 0, protection = 0;
    try {
        feather = enchantment(bot.inventory?.slots?.[8], 'feather_falling');
        protection = [5, 6, 7, 8].reduce((sum, slot) => sum + enchantment(bot.inventory?.slots?.[slot], 'protection'), 0);
    } catch {notes.push('附魔读取失败；按无附魔估算。'); feather = protection = 0;}
    let landingMultiplier = 1;
    if (landingName === 'hay_block' || landingName === 'honey_block') landingMultiplier = 0.2;
    if (landingName.endsWith('_bed')) landingMultiplier = 0.5;
    if (landingName === 'slime_block') notes.push('史莱姆弹跳及潜行状态另有影响；暂按普通地面保守估算。');
    if (['pointed_dripstone', 'cactus', 'magma_block', 'campfire', 'soul_campfire'].includes(landingName)) notes.push('落点还可能造成额外伤害；此处数值只估算普通摔落伤害。');
    // Vanilla applies landing-block reduction before ceil, then Resistance and protection enchantments.
    damage = Math.max(0, Math.ceil((height - safeDistance - jumpAllowance) * multiplier * landingMultiplier - 1e-6));
    const resistance = effect(bot, 'Resistance');
    if (resistance) damage *= Math.max(0, 1 - 0.2 * (resistance.amplifier + 1));
    damage *= 1 - Math.min(20, feather * 3 + protection) / 25;
    const slow = effect(bot, 'SlowFalling');
    if (slow) {
        const conservativeFlightTicks = Math.ceil(height / 0.1) + 20;
        if (slow.duration >= conservativeFlightTicks || slow.duration === -1) damage = 0;
        else notes.push('缓降可能在落地前结束；未用它降低预计伤害。');
    }
    if (effect(bot, 'Levitation')) notes.push('当前有漂浮效果；实际落地时间和路径不确定。');
    if (['creative', 'spectator'].includes(bot.game?.gameMode)) damage = 0;
    const healthHp = Number.isFinite(bot.health) ? bot.health : null;
    return {units: 'HP；2 HP = 1颗心', heightBlocks: round(height), baseDamageHp, baseDamageHearts: round(baseDamageHp / 2),
        estimatedDamageHp: round(damage), estimatedDamageHearts: round(damage / 2), healthHp,
        estimatedRemainingHp: healthHp === null ? null : round(Math.max(0, healthHp - damage)),
        potentiallyLethal: healthHp === null ? null : damage >= healthHp,
        safeFallDistance: safeDistance, fallDamageMultiplier: multiplier, featherFallingLevel: feather, protectionPoints: protection,
        resistanceLevel: resistance ? resistance.amplifier + 1 : 0, notes};
}

function collisionTop(block, x, z) {
    const localX = x - block.position.x, localZ = z - block.position.z;
    const shapes = block.shapes || (block.boundingBox === 'block' ? [[0, 0, 0, 1, 1, 1]] : []);
    const tops = shapes.filter(shape => localX + 0.299 > shape[0] && localX - 0.299 < shape[3] && localZ + 0.299 > shape[2] && localZ - 0.299 < shape[5]).map(shape => block.position.y + shape[4]);
    return tops.length ? Math.max(...tops) : null;
}

export function assessDigDown(bot) {
    const origin = position(bot.entity.position);
    const targetPos = new Vec3(Math.floor(origin.x), Math.floor(origin.y - 1e-4), Math.floor(origin.z));
    const target = bot.blockAt(targetPos);
    const base = {origin, target: target ? {name: target.name, stateId: target.stateId, position: position(target.position)} : null};
    const fail = reason => ({...base, known: false, reason});
    if (bot.entity.onGround === false) return fail('当前未站稳；先落地再检查脚下。');
    if (!target) return fail('脚下方块尚未加载。');
    if (['water', 'lava', 'bubble_column'].includes(target.name)) return fail('脚下是液体；此动作只处理挖开支撑方块后的垂直落地。');
    if (collisionTop(target, origin.x, origin.z) === null) return fail('当前位置没有可挖的脚下支撑方块。');
    // A single block cannot release the whole body when another support column is underneath it.
    for (let x = Math.floor(origin.x - 0.299); x <= Math.floor(origin.x + 0.299); x++) {
        for (let z = Math.floor(origin.z - 0.299); z <= Math.floor(origin.z + 0.299); z++) {
            if (x === targetPos.x && z === targetPos.z) continue;
            const block = bot.blockAt(new Vec3(x, targetPos.y, z));
            if (!block) return fail('相邻支撑方块尚未加载。');
            const top = collisionTop(block, origin.x, origin.z);
            if (top !== null && top >= origin.y - 0.05) return fail(`身体仍由相邻方块支撑；先站到 (${targetPos.x + 0.5}, ${origin.y}, ${targetPos.z + 0.5}) 附近中心再评估。`);
        }
    }
    const minY = bot.game?.minY ?? -64;
    const column = [];
    for (let y = targetPos.y - 1; y >= minY; y--) {
        const block = bot.blockAt(new Vec3(targetPos.x, y, targetPos.z));
        if (!block) return fail('下方区块尚未加载，无法确认落点和伤害。');
        column.push([y, block.stateId ?? block.name]);
        if (['water', 'lava', 'bubble_column', 'powder_snow', 'cobweb', 'ladder', 'vine', 'scaffolding', 'fire', 'soul_fire'].includes(block.name)) return fail(`下方有 ${block.name}，不能按普通垂直摔落估算；请换路线。`);
        const top = collisionTop(block, origin.x, origin.z);
        if (top === null) continue;
        const landing = {name: block.name, stateId: block.stateId, position: position(block.position), surfaceY: top};
        const damage = estimateFallDamage(bot, origin.y - top, block.name);
        return {...base, known: true, landing, column, damage};
    }
    return fail('直到世界底部也未找到已加载落点，不能计算普通落地伤害。');
}

function fingerprint(report) {
    return JSON.stringify({origin: Object.fromEntries(Object.entries(report.origin).map(([key, value]) => [key, round(value)])),
        target: report.target, landing: report.landing, column: report.column, damage: report.damage});
}

export function previewDigDown(bot) {
    pending.delete(bot);
    const report = assessDigDown(bot);
    if (!report.known) return `落差评估未完成：${report.reason} 未挖掘、未移动。`;
    const token = randomUUID();
    pending.set(bot, {token, fingerprint: fingerprint(report)});
    const d = report.damage, p = report.landing.position;
    const message = `落差评估（未挖掘/移动）：高度${d.heightBlocks}格，落点${report.landing.name}(${p.x},${p.y},${p.z})；基础伤害${d.baseDamageHp}HP/${d.baseDamageHearts}颗心，按装备效果预计${d.estimatedDamageHp}HP/${d.estimatedDamageHearts}颗心；当前${d.healthHp}HP，预计剩余${d.estimatedRemainingHp}HP，可能致死=${d.potentiallyLethal}。\n${d.notes.join('')}\n由你决定；继续此处挖开支撑并落下用 !confirmDigDown("${token}")，也可选其他路线。`;
    console.log('[FallAssessment]', JSON.stringify({token, ...report}));
    return message;
}

async function executeDrop(bot, report, breakBlock, {timeoutMs, pollMs = 40} = {}) {
    if (bot.interrupt_code) return false;
    const startHealth = bot.health;
    const p = report.target.position;
    if (!await breakBlock(bot, p.x, p.y, p.z)) return false;
    const limit = timeoutMs ?? Math.max(5000, report.damage.heightBlocks * (effect(bot, 'SlowFalling') ? 450 : 80) + 3000);
    const end = Date.now() + limit;
    while (Date.now() < end) {
        if (bot.interrupt_code) return false;
        if (bot.health <= 0) {output(bot, '落下后生命值为0；实际结果为死亡。'); return false;}
        const pos = bot.entity.position;
        if (Math.hypot(pos.x - report.origin.x, pos.z - report.origin.z) > 0.6) {output(bot, '落下过程中水平位置改变，原落点不再适用；未宣称到达。'); return false;}
        if (bot.entity.onGround && Math.abs(pos.y - report.landing.surfaceY) <= 0.12) {
            output(bot, `已落地：${JSON.stringify({position: position(pos), predictedDamageHp: report.damage.estimatedDamageHp, observedHealthLossHp: round(Math.max(0, startHealth - bot.health)), healthHp: bot.health})}。血量以服务器随后更新为准。`);
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    const error = new Error(`脚下方块已处理，但 ${limit}ms 内未确认到达预计落点；请重新查询位置和脚下方块。`);
    error.name = 'DropLandingTimeout'; throw error;
}

export async function confirmDigDown(bot, token, breakBlock, options) {
    const saved = pending.get(bot);
    pending.delete(bot);
    if (!saved || saved.token !== token) {output(bot, '落差确认无效或已使用；请先 !inspectDrop 取得当前评估。'); return false;}
    const report = assessDigDown(bot);
    if (!report.known || fingerprint(report) !== saved.fingerprint) {
        output(bot, '位置、血量、装备效果或落点已变化，旧评估不再适用。\n' + previewDigDown(bot)); return false;
    }
    // No HP/height veto here: the model has seen the estimate and explicitly chosen this drop.
    output(bot, `已确认落差：${report.damage.heightBlocks}格；预计 ${report.damage.estimatedDamageHp}HP (${report.damage.estimatedDamageHearts}颗心)，预计剩余 ${report.damage.estimatedRemainingHp}HP，可能致死=${report.damage.potentiallyLethal}。`);
    return executeDrop(bot, report, breakBlock, options);
}

export async function digDownWithAssessment(bot, distance, breakBlock) {
    if (!Number.isSafeInteger(distance) || distance < 1) throw Error('Distance must be a positive integer.');
    for (let dug = 0; dug < distance; dug++) {
        if (bot.interrupt_code) return false;
        const report = assessDigDown(bot);
        if (!report.known || report.damage.heightBlocks > 1.01 || report.damage.estimatedDamageHp > 0) {
            output(bot, `已挖 ${dug} 格。\n${previewDigDown(bot)}`); return false;
        }
        pending.delete(bot);
        if (!await executeDrop(bot, report, breakBlock)) return false;
    }
    output(bot, `Dug down ${distance} blocks.`); return true;
}
