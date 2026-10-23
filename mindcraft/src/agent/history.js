import { writeFileSync, readFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import settings from './settings.js';
import { SUMMARY_COMPACT_TRIGGER, SUMMARY_COMPACT_TARGET, memoryRevision, validateMemoryEdit } from './memory_edit.js';
import {ContextJournal} from './context_journal.js';
import {WORK_CONTEXT_ROUNDS, selectWorkingContext, tagLegacyRounds} from './working_context.js';

export const SUMMARY_MAINTENANCE_INTERVAL_MS = 60000;
const SUMMARY_RETRY_MAX_MS = 300000;

export class History {
    constructor(agent) {
        this.agent = agent;
        this.name = agent.name;
        this.memory_fp = `./bots/${this.name}/memory.json`;
        this.journal = new ContextJournal(this.name);
        this.full_history_fp = this.journal.file;
        this.round_limit = WORK_CONTEXT_ROUNDS;
        this.activeRounds = new Map();
        this.summaryCursor = this.journal.end;
        this.summaryPending = 0;

        mkdirSync(`./bots/${this.name}/histories`, { recursive: true });

        this.turns = [];

        // Natural language memory as a summary of recent messages + previous memory
        this.memory = '';
        this.memory_meta = {};
        this.memoryEditEpoch = 0;
        this.compactionPromise = null;
        this.nextSummaryRetryAt = 0;
        this.nextSummaryRunAt = 0;
        this.summaryFailures = 0;
        this.summaryCompression = {state: 'idle', triggerChars: SUMMARY_COMPACT_TRIGGER, targetChars: SUMMARY_COMPACT_TARGET};

        // Background summary cadence only; the API window has its own round limit.
        this.max_messages = settings.max_messages;
    }

    beginRound(trigger = null) {
        const id = randomUUID(); this.activeRounds.set(id, {trigger, turns: []}); return id;
    }

    endRound(id) {this.activeRounds.delete(id);}

    recordEvent(kind, value) {return this.journal.append(kind, value);}

    getHistory({roundId = null} = {}) {
        let turns = selectWorkingContext(this.turns, {currentRoundId: roundId});
        const trigger = this.activeRounds.get(roundId)?.trigger;
        if (trigger && !turns.some(turn => turn.roundId === roundId && turn.role !== 'assistant')) {
            const role = trigger.source === 'system' ? 'system' : trigger.source === this.name ? 'assistant' : 'user';
            const content = role === 'user' ? `${trigger.source}: ${trigger.content}` : trigger.content;
            turns.unshift({role, content, roundId, currentRound: true});
        } else if (roundId) turns = turns.map(turn => turn.roundId === roundId ? {...turn, currentRound: true} : turn);
        return structuredClone(turns);
    }

    pruneWindow() {this.turns = selectWorkingContext(this.turns);}

    async maintainSummary() {
        if (Date.now() < this.nextSummaryRetryAt || this.summaryPending < this.max_messages) return;
        return this.runCompaction(async () => {
            // One bounded batch per maintenance pass. A backlog must not own the
            // bot's single API slot continuously or replay old events in a burst.
            const batch = this.journal.readBatch(this.summaryCursor);
            if (batch.nextOffset === this.summaryCursor) {
                this.deferSummaryRetry();
                console.warn('[ContextJournal] No complete pending record; summary maintenance will retry later.');
                return;
            }
            if (!batch.events.length) {this.summaryCursor = batch.nextOffset; await this.save(); return;}
            const turns = batch.events.map(({role, content}) => ({role, content}));
            if (!await this.summarizeMemories(turns)) {
                if (Date.now() >= this.nextSummaryRetryAt) this.deferSummaryRetry();
                return;
            }
            this.summaryCursor = batch.nextOffset;
            this.summaryPending = Math.max(0, this.summaryPending - batch.events.length);
            console.log(`[MemoryMaintenance] ${this.name}: consumed=${batch.events.length}; pending=${this.summaryPending}; cursor=${this.summaryCursor}`);
            await this.save();
        });
    }

    async summarizeMemories(turns) {
        console.log("Storing memories...");
        const editEpoch = this.memoryEditEpoch;
        let summary = await this.agent.prompter.promptMemSaving(turns);
        // A request that started before a manual edit must never overwrite that edit.
        if (editEpoch !== this.memoryEditEpoch) {
            console.log('Discarded an outdated summary after a memory edit.');
            return false;
        }

        if (typeof summary !== 'string' || !summary.trim() || summary.trim() === '模型服务暂时没有响应，请稍后再试。') {
            console.warn('Rejected an empty or failed memory summary; keeping previous memory and context.');
            return false;
        }
        summary = summary.trim();

        // Oversized model output is compressed semantically, never sliced at the character limit.
        if (summary.length >= SUMMARY_COMPACT_TRIGGER) {
            summary = await this.compressCandidate(summary, editEpoch, 'generated-summary');
            if (summary === null) return false;
        }
        if (editEpoch !== this.memoryEditEpoch) return false;
        this.commitSummary(summary, {reason: 'conversation-summary'});
        return true;
    }

    async compressCandidate(input, editEpoch, reason) {
        this.summaryCompression = {state: 'running', triggerChars: SUMMARY_COMPACT_TRIGGER, targetChars: SUMMARY_COMPACT_TARGET,
            reason, startedAt: new Date().toISOString(), beforeChars: input.length};
        console.log(`[MemoryCompression] ${this.name}: ${input.length} characters; target ${SUMMARY_COMPACT_TARGET}.`);
        try {
            let candidate = input;
            for (let attempt = 1; attempt <= 2; attempt++) {
                const response = await this.agent.prompter.promptSummaryCompression(candidate, {targetChars: SUMMARY_COMPACT_TARGET, attempt});
                if (editEpoch !== this.memoryEditEpoch) {
                    this.summaryCompression = {...this.summaryCompression, state: 'superseded'};
                    console.log('[MemoryCompression] Newer manual edit retained; stale compression discarded.');
                    return null;
                }
                const text = typeof response === 'string' ? response.trim() : '';
                if (!text || text === '模型服务暂时没有响应，请稍后再试。') throw Error('Empty or failed compression response');
                if (text.length <= SUMMARY_COMPACT_TARGET) {
                    this.nextSummaryRetryAt = 0;
                    this.summaryCompression = {...this.summaryCompression, state: 'completed', afterChars: text.length, finishedAt: new Date().toISOString()};
                    console.log(`[MemoryCompression] ${this.name}: ${input.length} -> ${text.length} characters.`);
                    return text;
                }
                candidate = text;
            }
            throw Error(`Compression output exceeds target ${SUMMARY_COMPACT_TARGET} characters`);
        } catch (error) {
            if (editEpoch !== this.memoryEditEpoch) {
                this.summaryCompression = {...this.summaryCompression, state: 'superseded'};
                return null;
            }
            // Retry on later activity after a delay; never make every incoming message start another API call.
            this.deferSummaryRetry();
            this.summaryCompression = {...this.summaryCompression, state: 'failed', error: error.message, retryAt: this.nextSummaryRetryAt};
            console.warn('[MemoryCompression] Keeping original summary and context:', error.message);
            return null;
        }
    }

    commitSummary(summary, compression = null) {
        const previousChars = this.memory.length;
        const backup = this.backupMemory();
        const meta = {...this.memory_meta, source: 'automatic', updatedAt: new Date().toISOString(), truncated: false, lastBackup: backup};
        if (compression) meta.compression = {...compression, previousChars: this.memory.length, outputChars: summary.length};
        const temporary = `${this.memory_fp}.${randomUUID()}.tmp`;
        try {
            writeFileSync(temporary, JSON.stringify(this.getSaveData(summary, meta), null, 2), {flag: 'wx', mode: 0o600});
            renameSync(temporary, this.memory_fp);
        } catch (error) {
            try {unlinkSync(temporary);} catch {}
            throw error;
        }
        this.memory = summary;
        this.memory_meta = meta;
        this.summaryFailures = 0;
        if (previousChars >= SUMMARY_COMPACT_TRIGGER) {
            this.nextSummaryRetryAt = 0;
            this.summaryCompression = {state: 'completed', triggerChars: SUMMARY_COMPACT_TRIGGER, targetChars: SUMMARY_COMPACT_TARGET,
                reason: compression?.reason || 'conversation-summary', beforeChars: previousChars, afterChars: summary.length, finishedAt: new Date().toISOString()};
        }
        console.log('Memory updated to: ', this.memory);
        console.log('Saved memory to:', this.memory_fp);
    }

    runCompaction(work) {
        if (this.compactionPromise) return this.compactionPromise;
        if (Date.now() < Math.max(this.nextSummaryRunAt, this.nextSummaryRetryAt)) {
            this.scheduleSummaryMaintenance();
            return Promise.resolve(false);
        }
        clearTimeout(this.summaryTimer);
        const editEpoch = this.memoryEditEpoch;
        const job = Promise.resolve().then(work).catch(error => {
            this.deferSummaryRetry();
            this.summaryCompression = {...this.summaryCompression, state: 'failed', error: error.message, retryAt: this.nextSummaryRetryAt};
            console.error('Memory compression failed; original context was retained:', error.message);
        }).finally(() => {
            if (this.compactionPromise === job) this.compactionPromise = null;
            this.nextSummaryRunAt = editEpoch === this.memoryEditEpoch ? Date.now() + SUMMARY_MAINTENANCE_INTERVAL_MS : 0;
            // A newer manual edit wins and may need its own compression. Normal
            // backlog work resumes on a timer instead of a hot microtask loop.
            if (editEpoch !== this.memoryEditEpoch && this.memory.length >= SUMMARY_COMPACT_TRIGGER)
                queueMicrotask(() => {void this.compactSummaryIfNeeded('manual-edit');});
            else this.scheduleSummaryMaintenance();
            void this.save();
        });
        this.compactionPromise = job;
        return job;
    }

    deferSummaryRetry() {
        const failures = ++this.summaryFailures;
        this.nextSummaryRetryAt = Date.now() + Math.min(SUMMARY_RETRY_MAX_MS, 60000 * 2 ** Math.min(failures - 1, 3));
    }

    scheduleSummaryMaintenance() {
        clearTimeout(this.summaryTimer);
        if (this.memory.length < SUMMARY_COMPACT_TRIGGER && this.summaryPending < this.max_messages) return;
        const waitMs = Math.max(0, this.nextSummaryRunAt - Date.now(), this.nextSummaryRetryAt - Date.now());
        this.summaryTimer = setTimeout(() => {
            const job = this.memory.length >= SUMMARY_COMPACT_TRIGGER
                ? this.compactSummaryIfNeeded('scheduled-summary') : this.maintainSummary();
            void job;
        }, waitMs);
        this.summaryTimer.unref?.();
    }

    compactSummaryIfNeeded(reason = 'summary-threshold') {
        if (this.memory.length < SUMMARY_COMPACT_TRIGGER || Date.now() < this.nextSummaryRetryAt) return Promise.resolve(false);
        return this.runCompaction(async () => {
            if (this.memory.length < SUMMARY_COMPACT_TRIGGER) return false;
            const original = this.memory, editEpoch = this.memoryEditEpoch;
            await this.save();
            const compressed = await this.compressCandidate(original, editEpoch, reason);
            if (compressed === null || editEpoch !== this.memoryEditEpoch || this.memory !== original) return false;
            this.commitSummary(compressed, {reason, triggerChars: SUMMARY_COMPACT_TRIGGER, targetChars: SUMMARY_COMPACT_TARGET});
            // Summary-only compression never removes or archives current conversation turns.
            return true;
        });
    }

    backupMemory() {
        const directory = path.join(path.dirname(this.memory_fp), 'memory-backups');
        const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`;
        mkdirSync(directory, { recursive: true });
        writeFileSync(path.join(directory, filename), JSON.stringify(this.getSaveData(), null, 2), { flag: 'wx', mode: 0o600 });
        return filename;
    }

    async add(name, content, {roundId = null, maintainSummary = true} = {}) {
        let role = 'assistant';
        if (name === 'system') {
            role = 'system';
        }
        else if (name !== this.name) {
            role = 'user';
            content = `${name}: ${content}`;
        }
        if (!roundId) {
            const last = this.turns.at(-1);
            roundId = name === 'system' && last ? last.roundId : role === 'assistant' && last?.role !== 'assistant' ? last?.roundId : null;
            roundId ||= randomUUID();
        }
        // Commit the permanent record before removing anything from the window.
        const turn = this.journal.append('message', {role, content, source: name, roundId});
        const active = this.activeRounds.get(roundId);
        if (active && !this.turns.some(item => item.roundId === roundId)) this.turns.push(...active.turns);
        this.turns.push(turn); active?.turns.push(turn);
        this.summaryPending++;
        this.pruneWindow();
        await this.save();
        // Passive peer status belongs in context, but must not start a model
        // request (including memory maintenance) merely because it arrived.
        if (!maintainSummary) return;
        // Archiving and summary generation never gate the size of the API window.
        if (this.summaryPending >= this.max_messages && typeof this.agent.prompter?.promptMemSaving === 'function') void this.maintainSummary();
        else void this.compactSummaryIfNeeded();
    }

    getSaveData(memory = this.memory, meta = this.memory_meta) {
        // A conversation temporarily pauses decision making. Persist the user's
        // original active goal, so a disconnect cannot leave it paused forever.
        const conversationPaused = this.agent.self_prompter.state === 2 && this.agent._conversationGoalState === 1;
        return {
                memory,
                memory_meta: meta,
                turns: selectWorkingContext(this.turns),
                working_context: {version: 1, roundLimit: WORK_CONTEXT_ROUNDS, journal: 'work-context-log.jsonl',
                    summaryCursor: this.summaryCursor || 0, summaryPending: this.summaryPending || 0,
                    nextSummaryRunAt: this.nextSummaryRunAt, nextSummaryRetryAt: this.nextSummaryRetryAt, summaryFailures: this.summaryFailures},
                self_prompting_state: conversationPaused ? 1 : this.agent.self_prompter.state,
                self_prompt: this.agent.self_prompter.isStopped() ? null : this.agent.self_prompter.prompt,
                taskStart: this.agent.task.taskStartTime,
                last_sender: conversationPaused ? null : this.agent.last_sender,
                idle_wakeup: this.agent.idle_wakeup?.getSaveData(),
                places: structuredClone(this.agent.memory_bank?.getJson() || {})
        };
    }

    // All file operations and the in-memory commit are synchronous, so normal saves cannot
    // interleave with an edit. A failed commit leaves the running summary unchanged.
    editMemory(request) {
        const error = validateMemoryEdit(request);
        if (error) return { error };
        if (request.baseRevision !== memoryRevision(this.memory)) return { error: 'conflict' };
        if (request.summary === this.memory) return { success: true, unchanged: true };
        const backupDir = path.join(path.dirname(this.memory_fp), 'memory-backups');
        const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`;
        const temporary = `${this.memory_fp}.${randomUUID()}.tmp`;
        const meta = { source: 'manual', updatedAt: new Date().toISOString(), lastBackup: filename };
        try {
            mkdirSync(backupDir, { recursive: true });
            writeFileSync(path.join(backupDir, filename), JSON.stringify(this.getSaveData(), null, 2), { flag: 'wx', mode: 0o600 });
            writeFileSync(temporary, JSON.stringify(this.getSaveData(request.summary, meta), null, 2), { flag: 'wx', mode: 0o600 });
            renameSync(temporary, this.memory_fp);
        } catch {
            try { unlinkSync(temporary); } catch { /* Temporary file may not exist. */ }
            return { error: 'save-failed' };
        }
        this.memory = request.summary;
        this.memory_meta = meta;
        this.memoryEditEpoch++;
        this.nextSummaryRetryAt = 0;
        this.nextSummaryRunAt = 0;
        this.summaryFailures = 0;
        clearTimeout(this.summaryTimer);
        // Discard already requested replies based on the old summary; leave ongoing actions alone.
        if (typeof this.agent.responseEpoch === 'number') this.agent.responseEpoch++;
        void this.compactSummaryIfNeeded('manual-edit');
        return { success: true, backup: filename };
    }

    async save() {
        this.pruneWindow();
        const temporary = `${this.memory_fp}.${randomUUID()}.tmp`;
        try {
            writeFileSync(temporary, JSON.stringify(this.getSaveData(), null, 2), { flag: 'wx', mode: 0o600 });
            renameSync(temporary, this.memory_fp);
            console.log('Saved memory to:', this.memory_fp);
        } catch (error) {
            try { unlinkSync(temporary); } catch { /* A failed write may not create the temporary file. */ }
            console.error('Failed to save history:', error);
            throw error;
        }
    }

    load() {
        try {
            if (!existsSync(this.memory_fp)) {
                console.log('No memory file found.');
                return null;
            }
            const data = JSON.parse(readFileSync(this.memory_fp, 'utf8'));
            this.memory = data.memory || '';
            this.memory_meta = data.memory_meta || {};
            this.memoryEditEpoch++;
            const original = data.turns || [];
            this.summaryCursor = Number.isSafeInteger(data.working_context?.summaryCursor) ? Math.min(data.working_context.summaryCursor, this.journal.end) : this.journal.end;
            this.summaryPending = Number.isSafeInteger(data.working_context?.summaryPending) ? Math.max(0, data.working_context.summaryPending) : 0;
            this.nextSummaryRunAt = Number(data.working_context?.nextSummaryRunAt) || 0;
            this.nextSummaryRetryAt = Number(data.working_context?.nextSummaryRetryAt) || 0;
            this.summaryFailures = Number(data.working_context?.summaryFailures) || 0;
            if (data.working_context?.version === 1) this.turns = selectWorkingContext(original);
            else {
                // Archive all legacy pending text before bounding it. Persist the
                // migration without touching the not-yet-restored goal state.
                this.turns = tagLegacyRounds(original).map(turn => this.journal.append('message', {...turn, source: 'legacy-import'}));
                this.summaryPending += original.length;
                this.pruneWindow();
                const migrated = {...data, turns: this.turns, working_context: {version: 1, roundLimit: WORK_CONTEXT_ROUNDS,
                    journal: 'work-context-log.jsonl', summaryCursor: this.summaryCursor, summaryPending: this.summaryPending}};
                const temporary = `${this.memory_fp}.${randomUUID()}.tmp`;
                try {writeFileSync(temporary, JSON.stringify(migrated, null, 2), {flag: 'wx', mode: 0o600}); renameSync(temporary, this.memory_fp);}
                catch (error) {try {unlinkSync(temporary);} catch {} throw error;}
            }
            data.turns = this.turns;
            console.log('Loaded memory:', this.memory);
            return data;
        } catch (error) {
            console.error('Failed to load history:', error);
            throw error;
        }
    }

    clear() {
        this.recordEvent('context-cleared', {previousMessages: this.turns.length});
        this.turns = [];
        this.activeRounds.clear();
        this.summaryCursor = this.journal.end;
        this.summaryPending = 0;
        this.memory = '';
        this.memory_meta = {};
        this.memoryEditEpoch++;
        this.nextSummaryRunAt = 0;
        this.nextSummaryRetryAt = 0;
        this.summaryFailures = 0;
        clearTimeout(this.summaryTimer);
    }
}
