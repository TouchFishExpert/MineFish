export const IDLE_WAKEUP_MS = 60000;

// Independent of Agent.update(): a paused or stalled decision loop must not be
// responsible for scheduling its own recovery. This never cancels a game action.
export class IdleWakeup {
    constructor(agent, {now = Date.now, schedule = setInterval, cancel = clearInterval} = {}) {
        this.agent = agent;
        this.now = now;
        this.schedule = schedule;
        this.cancel = cancel;
        this.suspended = false;
        this.suspendReason = null;
        this.activeDecisions = 0;
        this.waking = false;
        this.idleSince = null;
        this.lastWakeAt = null;
        this.wakeCount = 0;
        this.timer = null;
    }

    restore(saved, legacyGoalState) {
        // Older STOPPED saves cannot distinguish a deliberate player stop from
        // normal inactivity. Preserve that stop on migration instead of revoking it.
        this.suspended = typeof saved?.suspended === 'boolean' ? saved.suspended : legacyGoalState === 0;
        this.suspendReason = this.suspended ? (saved?.reason || 'legacy-stopped') : null;
    }

    getSaveData() {return {suspended: this.suspended, reason: this.suspendReason};}

    suspend(reason = 'explicit-stop') {
        this.suspended = true;
        this.suspendReason = reason;
        this.idleSince = null;
    }

    resume() {
        this.suspended = false;
        this.suspendReason = null;
        this.idleSince = null;
    }

    beginDecision() {
        this.activeDecisions++;
        this.idleSince = null;
        return () => {
            this.activeDecisions = Math.max(0, this.activeDecisions - 1);
            this.idleSince = null;
        };
    }

    blockedReason() {
        const a = this.agent;
        if (a._shuttingDown || a._disconnectHandled) return 'offline';
        if (this.suspended || a.shut_up) return 'explicit-stop';
        if (this.waking) return 'waking';
        if (a.bot?.isSleeping || (a.actions?.executing && /(?:^|:)stay$/.test(a.actions.currentActionLabel || ''))) return 'intentional-wait';
        if (a.actions?.executing || a.actions?.pendingActions > 0 || a.actions?.resume_func) return 'action';
        if (this.activeDecisions || a.prompter?.activeModelRequests > 0) return 'model';
        return null;
    }

    start() {
        if (this.timer !== null) return;
        this.idleSince = this.blockedReason() ? null : this.now();
        this.timer = this.schedule(() => {void this.tick();}, 1000);
        this.timer?.unref?.();
    }

    stop() {
        if (this.timer !== null) this.cancel(this.timer);
        this.timer = null;
        this.idleSince = null;
    }

    async tick() {
        if (this.blockedReason()) {this.idleSince = null; return false;}
        const now = this.now();
        if (this.idleSince === null) this.idleSince = now;
        if (now - this.idleSince < IDLE_WAKEUP_MS) return false;
        this.waking = true;
        this.idleSince = null;
        this.lastWakeAt = new Date(now).toISOString();
        this.wakeCount++;
        console.log(`[IdleWakeup] ${this.agent.name}: no action or pending decision for 60 seconds; waking model.`);
        try {
            await this.agent.handleMessage('system', '[空闲自动唤醒] 你已经连续60秒没有执行动作，也没有待处理的模型请求；当前并非你主动等待或睡觉。请结合现有记忆、上下文和当前环境，自主决定接下来做什么。可以自由与玩家或AI队友交流，不必等别人提供新目标。若你希望等待，请调用内置等待动作并给出时长。', -1, {idleWakeup: true});
            return true;
        } catch (error) {
            console.error(`[IdleWakeup] ${this.agent.name}: ${error.message}`);
            return false;
        } finally {
            this.waking = false;
            // A fresh full minute is required before another wake; never overlap.
            this.idleSince = this.blockedReason() ? null : this.now();
        }
    }

    getState() {
        const blocked = this.blockedReason();
        const elapsed = !blocked && this.idleSince !== null ? Math.max(0, this.now() - this.idleSince) : 0;
        return {enabled: !this.suspended, intervalMs: IDLE_WAKEUP_MS, state: blocked || 'idle',
            idleMs: elapsed, remainingMs: blocked ? null : Math.max(0, IDLE_WAKEUP_MS - elapsed),
            lastWakeAt: this.lastWakeAt, wakeCount: this.wakeCount, activeDecisions: this.activeDecisions,
            suspendedReason: this.suspendReason};
    }
}
