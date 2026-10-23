import {interactionDeadline} from './interaction_deadline.js';
const states = new WeakMap();
const alwaysConsumable = new Set(['potion', 'milk_bucket', 'golden_apple', 'enchanted_golden_apple']);

function sample(bot, name) {
    // inventory.items() excludes the offhand in this Mineflayer version.
    const items = bot.inventory.slots.slice(bot.inventory.inventoryStart ?? 9).filter(Boolean);
    return { food: bot.food, health: bot.health, count: items.filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0), heldItem: bot.heldItem?.name || null };
}

export function installEatingCoordinator(bot) {
    if (states.has(bot)) return states.get(bot);
    const auto = bot.autoEat;
    // Keep eatingTimeout, offhand, pickup checks and equipment restoration from the plugin.
    Object.assign(auto.options, { priority: 'foodPoints', startAt: 14 });
    const state = { autoTask: null, manualQueued: 0, manualTail: Promise.resolve() };
    states.set(bot, state);
    const originalEat = auto.eat.bind(auto);
    auto.eat = (...args) => {
        if (state.manualQueued || state.autoTask) return Promise.resolve(false);
        const task = Promise.resolve().then(() => originalEat(...args));
        state.autoTask = task;
        return task.finally(() => { if (state.autoTask === task) state.autoTask = null; });
    };
    let automaticAttempt = null;
    bot.on('autoeat_started', (item, offhand) => { automaticAttempt = { item: item.name, offhand, startedAt: Date.now(), before: sample(bot, item.name), status9: false }; });
    bot._client.on('entity_status', packet => { if (automaticAttempt && packet.entityId === bot.entity.id && packet.entityStatus === 9) automaticAttempt.status9 = true; });
    bot.on('autoeat_finished', () => {
        if (!automaticAttempt) return;
        const { item, offhand, startedAt, before, status9 } = automaticAttempt;
        const after = sample(bot, item);
        console.log('[Eating]', JSON.stringify({ time: new Date().toISOString(), source: 'automatic', item, offhand, elapsedMs: Date.now() - startedAt, before, after, status9, confirmed: status9 || after.count < before.count || after.food > before.food }));
        automaticAttempt = null;
    });
    bot.on('autoeat_error', error => {
        console.warn('[Eating]', JSON.stringify({ source: 'automatic', error: error.message, food: bot.food, health: bot.health }));
        state.lastResult = {source: 'automatic', status: 'failed', error: `${error.name}: ${error.message}`, at: new Date().toISOString()};
        if (bot.modes && typeof bot.modes.behavior_log === 'string') bot.modes.behavior_log += `Automatic eating failed: ${error.name}: ${error.message}\n`;
        automaticAttempt = null;
    });
    return state;
}

export function getEatingState(bot) {
    const state = states.get(bot);
    const options = bot.autoEat?.options;
    return { coordinated: Boolean(state), manualQueued: state?.manualQueued || 0, automaticBusy: Boolean(state?.autoTask), lastResult: state?.lastResult || null, enabled: bot.autoEat ? !bot.autoEat.disabled : false,
        options: options ? { priority: options.priority, startAt: options.startAt, eatingTimeout: options.eatingTimeout, attemptTimeout: options.attemptTimeout, offhand: options.offhand, equipOldItem: options.equipOldItem, checkOnItemPickup: options.checkOnItemPickup } : null };
}

export async function consumeItem(bot, name, {timeoutMs = 5000} = {}) {
    const state = installEatingCoordinator(bot);
    const previous = state.manualTail;
    let release;
    state.manualTail = new Promise(resolve => { release = resolve; });
    state.manualQueued++;
    let usingItem = false;
    let status9 = false;
    let resolveConfirmation, before;
    const deadline = interactionDeadline(bot, 'Consumption', timeoutMs);
    const onStatus = packet => { if (packet.entityId === bot.entity.id && packet.entityStatus === 9) {status9 = true; resolveConfirmation?.();} };
    const onChange = () => { if (before) {const after = sample(bot, name); if (after.count < before.count || after.food > before.food) resolveConfirmation?.();} };
    try {
        await deadline.step('manual queue', () => previous);
        await deadline.step('automatic meal handoff', () => state.autoTask?.catch(() => {}));
        if (bot.interrupt_code) return { success: false, message: 'Consumption cancelled before starting.' };
        const item = name ? (bot.inventory.findInventoryItem(name) || (bot.inventory.slots[45]?.name === name ? bot.inventory.slots[45] : null)) : null;
        if (!item) return { success: false, message: `You do not have any ${name || 'specified food'} to eat.` };
        if (!bot.registry.foodsByName[name] && !alwaysConsumable.has(name)) return { success: false, message: `${name} is not directly edible or drinkable. Process it into food first.` };
        if (bot.food >= 20 && bot.game.gameMode !== 'creative' && !alwaysConsumable.has(name)) return { success: false, message: 'Hunger is already full; ordinary food cannot be eaten now.' };
        bot.deactivateItem();
        await deadline.step('equip food', () => bot.equip(item, 'hand'));
        if (bot.interrupt_code) return { success: false, message: 'Consumption cancelled while equipping food.' };
        before = sample(bot, name);
        const startedAt = Date.now();
        bot._client.on('entity_status', onStatus);
        bot.on('health', onChange);
        bot.inventory.on?.('updateSlot', onChange);
        const confirmation = new Promise(resolve => { resolveConfirmation = resolve; });
        usingItem = true;
        let error = null;
        try { await deadline.step('consume food', () => Promise.race([Promise.resolve().then(() => bot.consume()), confirmation])); } catch (caught) { error = caught; }
        const after = sample(bot, name);
        const confirmed = status9 || after.count < before.count || after.food > before.food;
        console.log('[Eating]', JSON.stringify({ time: new Date().toISOString(), source: 'manual', item: name, elapsedMs: Date.now() - startedAt, status9, confirmed, interrupted: Boolean(bot.interrupt_code), before, after, error: error?.message || null }));
        if (confirmed) {
            state.lastResult = {source: 'manual', status: 'confirmed', item: name, elapsedMs: deadline.elapsedMs, at: new Date().toISOString()};
            return { success: true, message: `Consumed ${name}; server completion or food/inventory change confirmed (hunger ${before.food} -> ${after.food}, count ${before.count} -> ${after.count}).` };
        }
        if (bot.interrupt_code) return { success: false, message: `Consumption of ${name} was interrupted; no successful consumption was confirmed.` };
        if (error) throw error;
        throw Object.assign(new Error(`Consumption of ${name} ended without a consumption signal or inventory/hunger change.`), {name: 'ConsumptionUnconfirmed'});
    } catch (caught) {
        const error = caught.name === 'ConsumptionTimeout' || caught.name === 'InteractionCancelled' || caught.name === 'ConsumptionUnconfirmed' ? caught
            : Object.assign(new Error(`${name}: ${caught.message}`), {name: /timed?\s*out|timeout/i.test(caught.message) ? 'ConsumptionTimeout' : 'ConsumptionError', cause: caught});
        state.lastResult = {source: 'manual', status: 'failed', item: name, stage: deadline.stage, elapsedMs: deadline.elapsedMs, error: `${error.name}: ${error.message}`, at: new Date().toISOString()};
        console.warn('[Eating]', JSON.stringify(state.lastResult));
        throw error;
    } finally {
        bot._client.removeListener('entity_status', onStatus);
        bot.removeListener('health', onChange);
        bot.inventory.removeListener?.('updateSlot', onChange);
        deadline.dispose();
        if (usingItem) { try { bot.deactivateItem(); } catch { /* Disconnected while consuming. */ } }
        state.manualQueued--;
        release();
    }
}
