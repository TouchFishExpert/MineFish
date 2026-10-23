import {AsyncLocalStorage} from 'node:async_hooks';
const storage = new AsyncLocalStorage();
const installed = new WeakSet();
export const cancellationError = (message = 'Action cancelled.') => Object.assign(new Error(message), {name: 'ActionCancelled'});
export function actionContext(bot) {const context = storage.getStore(); return context?.bot === bot ? context : null;}
export function checkAction(bot) {actionContext(bot)?.signal.throwIfAborted();}
export function inAction(context, work) {return storage.run(context, work);}
export function outsideAction(work) {return storage.exit(work);}

// Track the actual operation, not only a raced outer promise. Handoff waits for
// these operations to settle before another action can touch the same bot.
function track(bot, work) {
    const context = actionContext(bot);
    checkAction(bot);
    const result = work();
    if (!context || !result?.then) return result;
    const promise = Promise.resolve(result).then(value => {context.signal.throwIfAborted(); return value;});
    context.operations.add(promise);
    promise.finally(() => context.operations.delete(promise)).catch(() => {});
    return promise;
}
export async function drainAction(context) {while (context.operations.size) await Promise.allSettled([...context.operations]);}
export function stopNavigation(bot) {
    bot.pathfinder?.stop();
    // Clearing the goal settles goto even when a path node cannot be reached.
    bot.pathfinder?.setGoal(null);
    bot.clearControlStates?.();
}

export function installActionCancellation(bot) {
    if (installed.has(bot)) return;
    installed.add(bot);
    Object.defineProperty(bot, '_actionSignal', {configurable: true, get: () => actionContext(bot)?.signal});
    bot._checkActionCancellation = () => checkAction(bot);
    const wrap = (object, key) => {
        if (typeof object?.[key] !== 'function') return;
        const original = object[key];
        object[key] = function (...args) {return track(bot, () => original.apply(this, args));};
    };
    for (const key of ['equip', 'unequip', 'dig', 'openContainer', 'openBlock', 'openEntity', 'transfer', 'toss', 'tossStack', 'activateBlock', 'activateEntity', 'consume']) wrap(bot, key);
    wrap(bot.tool, 'equipForBlock'); wrap(bot.collectBlock, 'collect'); wrap(bot.pvp, 'attack');
    if (bot.look) {
        const look = bot.look;
        bot.look = function (...args) {
            return track(bot, async () => {
                const signal = actionContext(bot)?.signal;
                // Native look(force=true) finishes the previous smooth-look
                // task. This also releases activateBlock's lookAt await.
                const abort = () => outsideAction(() => {
                    Promise.resolve(look.call(bot, bot.entity.yaw, bot.entity.pitch, true)).catch(() => {});
                });
                signal?.addEventListener('abort', abort, {once: true});
                try {return await look.apply(this, args);}
                finally {signal?.removeEventListener('abort', abort);}
            });
        };
    }
    if (bot._client?.write) {
        const write = bot._client.write;
        const mutations = new Set(['block_dig', 'block_place', 'use_item', 'use_item_on', 'use_entity', 'window_click', 'held_item_slot', 'arm_animation']);
        bot._client.write = function (name, ...args) {
            if (mutations.has(name)) checkAction(bot);
            if (name === 'use_entity') actionContext(bot)?.beforeEntityInteraction?.(args[0]);
            return write.call(this, name, ...args);
        };
    }
    if (bot.setControlState) {
        const set = bot.setControlState;
        bot.setControlState = function (key, value) {if (value) checkAction(bot); return set.call(this, key, value);};
    }
    if (bot.pathfinder?.setGoal) {
        const set = bot.pathfinder.setGoal;
        bot.pathfinder.setGoal = function (goal, ...args) {if (goal) checkAction(bot); return set.call(this, goal, ...args);};
    }
    if (bot.pathfinder?.goto) {
        const goto = bot.pathfinder.goto;
        bot.pathfinder.goto = function (goal, ...args) {
            return track(bot, async () => {
                const signal = actionContext(bot)?.signal;
                const abort = () => outsideAction(() => stopNavigation(bot));
                let anchor = bot.entity.position.clone(), lastProgress = Date.now(), stalled = null;
                signal?.addEventListener('abort', abort, {once: true});
                const monitor = setInterval(() => {
                    try {
                    if (bot.entity.position.distanceTo(anchor) >= 0.25) {anchor = bot.entity.position.clone(); lastProgress = Date.now();}
                    const digMs = bot.targetDigBlock && bot.digTime ? bot.digTime(bot.targetDigBlock) : 0;
                    const allowed = Math.max(8000, Number.isFinite(digMs) ? digMs + 3000 : 8000);
                    if (Date.now() - lastProgress > allowed) {
                        stalled = Object.assign(new Error(`Navigation made no progress for ${Date.now() - lastProgress}ms at ${bot.entity.position}; goal was cancelled.`), {name: 'NavigationStalled'});
                        abort();
                    }
                    } catch (error) {stalled = error; abort();}
                }, 250);
                try {checkAction(bot); return await goto.call(this, goal, ...args);}
                catch (error) {checkAction(bot); throw stalled || error;}
                finally {clearInterval(monitor); signal?.removeEventListener('abort', abort);}
            });
        };
    }
}

// Only short container interactions get this deadline, after navigation.
export async function containerInteraction(bot, work, timeoutMs = 5000) {
    installActionCancellation(bot);
    const parent = actionContext(bot), controller = new AbortController();
    const context = {...parent, bot, signal: controller.signal, operations: parent?.operations || new Set()};
    const cancel = () => controller.abort(parent.signal.reason);
    if (parent?.signal.aborted) cancel(); else parent?.signal.addEventListener('abort', cancel, {once: true});
    const timer = setTimeout(() => controller.abort(Object.assign(new Error(`Container interaction timed out after ${timeoutMs}ms; completion was not confirmed.`), {name: 'ContainerTimeout'})), timeoutMs);
    try {return await inAction(context, work);}
    finally {
        clearTimeout(timer); parent?.signal.removeEventListener('abort', cancel);
        outsideAction(() => {if (bot.currentWindow) {
            try {bot.closeWindow(bot.currentWindow);} catch (error) {console.warn('Container cleanup:', error.message);}
        }});
    }
}
