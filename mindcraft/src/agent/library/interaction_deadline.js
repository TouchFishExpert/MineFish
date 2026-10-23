import {actionContext} from '../action_context.js';
// A deadline for one short interaction, not a minimum wait or a global action timer.
export function interactionDeadline(bot, name, timeoutMs = 5000) {
    const startedAt = Date.now();
    let stage = 'starting', reason, rejectAbort;
    const aborted = new Promise((resolve, reject) => { rejectAbort = reject; });
    aborted.catch(() => {});
    const abort = error => { if (!reason) { reason = error; rejectAbort(error); } };
    const timeoutError = () => Object.assign(new Error(`${name} timed out after ${timeoutMs}ms during ${stage}; no successful completion was confirmed.`), {name: `${name}Timeout`, stage, elapsedMs: Date.now() - startedAt});
    const timer = setTimeout(() => abort(timeoutError()), timeoutMs);
    const signal = actionContext(bot)?.signal;
    const onAbort = () => abort(signal.reason);
    signal?.addEventListener('abort', onAbort, {once: true});
    const cancellation = setInterval(() => {
        if (bot.interrupt_code) abort(Object.assign(new Error(`${name} cancelled during ${stage}.`), {name: 'InteractionCancelled', stage}));
    }, 25);
    function check() {
        if (reason) throw reason;
        signal?.throwIfAborted();
        if (bot.interrupt_code) throw Object.assign(new Error(`${name} cancelled during ${stage}.`), {name: 'InteractionCancelled', stage});
        if (Date.now() - startedAt >= timeoutMs) throw timeoutError();
    }
    return {
        get elapsedMs() { return Date.now() - startedAt; },
        get stage() { return stage; },
        check,
        async step(nextStage, work) {
            stage = nextStage; check();
            const result = await Promise.race([Promise.resolve().then(() => { check(); return work(); }), aborted]);
            check(); return result;
        },
        dispose() { clearTimeout(timer); clearInterval(cancellation); signal?.removeEventListener('abort', onAbort); }
    };
}
