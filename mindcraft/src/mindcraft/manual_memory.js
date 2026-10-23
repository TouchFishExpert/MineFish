// This writer is owned by MindServer. No agent or model tool imports it.
import { writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { MANUAL_MEMORY_LIMIT, manualMemoryPath, readManualMemory } from '../utils/manual_memory.js';

function updateManualMemory(name, request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)
        || Object.keys(request).some(key => !['text', 'baseRevision'].includes(key))
        || typeof request.text !== 'string' || typeof request.baseRevision !== 'string'
        || !/^[a-f0-9]{64}$/.test(request.baseRevision)) return { error: 'invalid-request' };
    if (request.text.length > MANUAL_MEMORY_LIMIT) return { error: 'too-long' };
    const previous = readManualMemory(name);
    if (!previous.available) return { error: 'read-failed' };
    if (request.baseRevision !== previous.revision) return { error: 'conflict' };
    if (request.text === previous.text) return { success: true, unchanged: true };
    const file = manualMemoryPath(name);
    const backupDir = path.join(path.dirname(file), 'manual-memory-backups');
    const backup = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`;
    const temporary = `${file}.${randomUUID()}.tmp`;
    const next = { text: request.text, version: previous.version + 1, updatedAt: new Date().toISOString(), lastBackup: backup };
    try {
        mkdirSync(backupDir, { recursive: true });
        writeFileSync(path.join(backupDir, backup), JSON.stringify(previous, null, 2), { flag: 'wx', mode: 0o600 });
        writeFileSync(temporary, JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600 });
        renameSync(temporary, file);
    } catch {
        try { unlinkSync(temporary); } catch { /* No temporary file to remove. */ }
        return { error: 'save-failed' };
    }
    return { success: true, backup };
}

export function updateManualMemoryFromConsole(socket, connections, name, request) {
    // Use server-owned socket identity, never a client-supplied sender/role flag.
    if (socket.data?.agentProcess || Object.values(connections).some(connection => connection.socket === socket)) return { error: 'forbidden' };
    if (typeof name !== 'string' || !Object.hasOwn(connections, name)) return { error: 'not-found' };
    const result = updateManualMemory(name, request);
    return { ...result, manualMemory: readManualMemory(name) };
}
