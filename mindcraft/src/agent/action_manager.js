import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cancellationError, inAction, outsideAction, installActionCancellation, drainAction} from './action_context.js';

const skipped = () => ({success: false, message: null, interrupted: true, timedout: false});
export class ActionManager {
    constructor(agent) {
        this.agent = agent;
        this.executing = false; this.currentActionLabel = ''; this.currentActionFn = null;
        this.timedout = false; this.resume_func = null; this.resume_name = '';
        this.last_action_time = 0; this.recent_action_counter = 0; this.pendingActions = 0;
        this.current = null; this.sequence = 0; this.handoff = Promise.resolve();
    }
    resumeAction() {return this._executeResume();}
    runAction(label, fn, {timeout, resume = false} = {}) {
        return resume ? this._executeResume(label, fn, timeout) : this._executeAction(label, fn, timeout);
    }
    cancelResume() {this.resume_func = null; this.resume_name = null;}
    async _executeResume(label = null, fn = null, timeout = 10) {
        const fresh = fn != null;
        if (fresh) {assert(label != null, 'actionLabel is required for new resume'); this.resume_func = fn; this.resume_name = label;}
        if (this.resume_func && (this.agent.isIdle() || fresh) && (!this.agent.self_prompter.isActive() || fresh) && (!this.pendingActions || fresh))
            return this._executeAction(this.resume_name, this.resume_func, timeout);
        return {success: false, message: null, interrupted: false, timedout: false};
    }
    interruptCurrent(reason = cancellationError()) {
        const record = this.current;
        if (record && !record.signal.aborted) record.controller.abort(reason);
    }
    async stop() {
        ++this.sequence;
        const record = this.current;
        if (record) await this._stopRecord(record);
        await this.handoff;
    }
    _stopRecord(record) {
        if (record.stopping) return record.stopping;
        let timer;
        const deadline = new Promise((resolve, reject) => {
            timer = setTimeout(() => {
                const message = `Code execution refused stop after 10 seconds. Killing process. Action=${record.label}; id=${record.id}`;
                try {this.agent.cleanKill(message);} catch (error) {console.error(error.message);}
                reject(new Error(message));
            }, 10000);
        });
        record.stopping = Promise.race([record.done, deadline]).finally(() => clearTimeout(timer));
        record.stopping.catch(() => {});
        console.log(`[Action] cancelling ${record.label}; id=${record.id}`);
        this.interruptCurrent(cancellationError(`Action ${record.label} was replaced or stopped.`));
        outsideAction(() => {
            try {const cleanup = this.agent.requestInterrupt(); cleanup?.catch?.(error => console.warn('Interrupt cleanup:', error.message));}
            catch (error) {console.warn('Interrupt cleanup:', error.message);}
        });
        return record.stopping;
    }
    _executeAction(label, fn, timeout = 10) {
        const request = ++this.sequence;
        if (label.startsWith('action:') && fn !== this.resume_func) this.cancelResume();
        this.pendingActions++;
        const acquire = this.handoff.catch(() => {}).then(async () => {
            try {
                if (request !== this.sequence) return null;
                if (this.current) await this._stopRecord(this.current);
                if (request !== this.sequence) return null;
                installActionCancellation(this.agent.bot);
                this.agent.clearBotLogs(); this.timedout = false;
                const controller = new AbortController();
                let resolveDone, resolveResult;
                const record = {id: randomUUID(), label, fn, bot: this.agent.bot, controller, signal: controller.signal,
                    operations: new Set(), timedout: false, startedAt: Date.now(),
                    done: new Promise(resolve => {resolveDone = resolve;}), result: new Promise(resolve => {resolveResult = resolve;})};
                record.resolveDone = resolveDone; record.resolveResult = resolveResult;
                this.current = record; this.executing = true; this.currentActionLabel = label; this.currentActionFn = fn;
                if (timeout > 0) record.timer = setTimeout(() => {
                    if (this.current !== record) return;
                    record.timedout = true; this.timedout = true;
                    const message = `Code execution timed out after ${timeout} minutes. Attempting force stop.`;
                    void this.agent.history.add('system', message);
                    void this._stopRecord(record).catch(error => console.error(error.message));
                }, timeout * 60000);
                console.log(`[Action] started ${label}; id=${record.id}`);
                void this._runRecord(record);
                return record;
            } finally {this.pendingActions--;}
        });
        // Lock only cancellation + assignment, not the body of the running action.
        this.handoff = acquire.then(() => {}, () => {});
        return acquire.then(record => record ? record.result : skipped());
    }
    async _runRecord(record) {
        let error;
        try {await inAction(record, () => record.fn());} catch (caught) {error = caught; record.error = String(caught);}
        // Drain actual operations left by third-party Promise.race helpers.
        await drainAction(record);
        clearTimeout(record.timer);
        const interrupted = record.signal.aborted || Boolean(this.agent.bot.interrupt_code);
        let message = this.getBotOutputSummary(interrupted, record.timedout);
        if (error && !interrupted) {
            this.cancelResume();
            console.error('Code execution triggered catch:', error);
            message += `!!Code threw exception!!\nError: ${error}\nStack trace:\n${error.stack || ''}\n`;
        }
        const result = {success: !error && !interrupted, message, interrupted, timedout: record.timedout};
        this.lastResult = {id: record.id, label: record.label, finishedAt: new Date().toISOString(),
            state: record.timedout ? '超时' : interrupted ? '已中断' : error ? '异常退出' : '调用已返回（是否达成目标以输出/环境为准）',
            error: error ? String(error).slice(0, 300) : null, output: message.split('\nStack trace:')[0].slice(-600)};
        if (this.current === record) {
            this.current = null; this.executing = false; this.currentActionLabel = ''; this.currentActionFn = null;
            this.agent.clearBotLogs();
        }
        console.log(`[Action] finished ${record.label}; id=${record.id}; interrupted=${interrupted}; elapsedMs=${Date.now() - record.startedAt}`);
        record.resolveDone(); record.resolveResult(result);
        this.agent.bot.emit('action-finished', {id: record.id, label: record.label, interrupted, timedout: record.timedout});
        if (!interrupted && !this.pendingActions) this.agent.bot.emit('idle');
    }
    getBotOutputSummary(interrupted = this.agent.bot.interrupt_code, timedout = this.timedout) {
        const {bot} = this.agent;
        if (interrupted && !timedout) return '';
        const text = bot.output || '';
        bot.output = '';
        return text.length > 500 ? `Action output is very long (${text.length} chars) and has been shortened.\nFirst outputs:\n${text.slice(0, 250)}\n...skipping many lines.\nFinal outputs:\n${text.slice(-250)}` : `Action output:\n${text}`;
    }
}
