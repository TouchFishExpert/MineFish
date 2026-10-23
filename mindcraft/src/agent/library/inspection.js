// Read-only, explicit projection: never serialize the agent, settings, or entity graphs.
import { SUMMARY_LIMIT, SUMMARY_COMPACT_TRIGGER, SUMMARY_COMPACT_TARGET, memoryRevision } from '../memory_edit.js';
import { readManualMemory } from '../../utils/manual_memory.js';
import {readCoreSummary} from '../../utils/core_summary.js';
import { getEatingState } from './eating.js';
import convoManager from '../conversation.js';
import {WORK_CONTEXT_ROUNDS, workingRoundCount} from '../working_context.js';
import {ridingState} from './riding.js';
function position(value) {
    if (!value || !['x', 'y', 'z'].every(axis => Number.isFinite(value[axis]))) return null;
    return Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, Math.round(value[axis] * 100) / 100]));
}

function vehicle(entity, fallback) {
    const value = entity?.vehicle || fallback;
    if (!value) return null;
    const passengers = Array.isArray(value.passengers) ? value.passengers : null;
    return {
        id: value.id ?? null,
        name: value.name || value.displayName || 'unknown',
        position: position(value.position),
        passengerListed: passengers ? passengers.some(p => (typeof p === 'number' ? p : p?.id) === entity?.id) : null,
        passengers: passengers?.map(p => typeof p === 'number' ? String(p) : String(p?.username || p?.id || '?')) ?? null
    };
}

export function getAgentInspection(agent) {
    const bot = agent.bot;
    const botVehicle = ridingState(bot).vehicle;
    const history = agent.history;
    const prompter = agent.self_prompter;
    const places = Object.entries(agent.memory_bank?.getJson() || {}).map(([name, coords]) => ({
        name,
        position: Array.isArray(coords) ? position({ x: coords[0], y: coords[1], z: coords[2] }) : null
    }));
    return {
        name: agent.name,
        sampledAt: new Date().toISOString(),
        runtime: {
            activeModelRequests: agent.prompter?.activeModelRequests || 0,
            queuedModelRequests: agent.prompter?.queuedModelRequests || 0,
            modelConcurrencyLimit: 1,
            maxObservedModelRequests: agent.prompter?.maxObservedModelRequests || 0,
            peerRequests: convoManager.activePeerRequests || 0,
            loopRunning: Boolean(prompter?.loop_active),
            idleWakeup: agent.idle_wakeup?.getState() || null
        },
        manualMemory: readManualMemory(agent.name),
        coreSummary: readCoreSummary(agent.name),
        memoryUsage: agent.memoryUsage ? {
            kind: agent.memoryUsage.kind,
            appliedAt: agent.memoryUsage.appliedAt,
            manualRevision: agent.memoryUsage.manualRevision,
            manualVersion: agent.memoryUsage.manualVersion,
            manualChars: agent.memoryUsage.manualChars,
            coreRevision: agent.memoryUsage.coreRevision,
            coreChars: agent.memoryUsage.coreChars,
            summaryChars: agent.memoryUsage.summaryChars
        } : null,
        eating: getEatingState(bot),
        memory: {
            summary: typeof history?.memory === 'string' ? history.memory : '',
            summaryLimit: SUMMARY_LIMIT,
            summaryCompactTrigger: SUMMARY_COMPACT_TRIGGER,
            summaryCompactTarget: SUMMARY_COMPACT_TARGET,
            summaryCompression: history?.summaryCompression ? {...history.summaryCompression} : null,
            revision: memoryRevision(typeof history?.memory === 'string' ? history.memory : ''),
            updatedAt: history?.memory_meta?.updatedAt || null,
            source: history?.memory_meta?.source || 'unknown',
            lastBackup: history?.memory_meta?.lastBackup || null,
            workingRoundLimit: WORK_CONTEXT_ROUNDS,
            workingRounds: workingRoundCount(history?.turns || []),
            workingChars: (history?.turns || []).reduce((total, turn) => total + (turn.content?.length || 0), 0),
            workingLog: `bots/${agent.name}/work-context-log.jsonl`,
            namedPlaces: places,
            placesPersisted: false
        },
        goal: {
            state: !prompter || prompter.isStopped() ? 'stopped' : prompter.isPaused() ? 'paused' : 'active',
            prompt: prompter?.prompt || ''
        },
        locations: {
            source: 'mineflayer-client-cache',
            dimension: bot.game?.dimension ?? null,
            bot: {
                position: position(bot.entity?.position),
                    vehicle: botVehicle ? {...vehicle(bot.entity, bot.vehicle), ...botVehicle} : null
            },
            players: Object.entries(bot.players || {}).filter(([name]) => name !== agent.name).map(([name, player]) => ({
                name,
                entityLoaded: Boolean(player.entity && player.entity.isValid !== false),
                position: player.entity?.isValid === false ? null : position(player.entity?.position),
                vehicle: player.entity?.isValid === false ? null : vehicle(player.entity)
            }))
        }
    };
}
