// Shared read-only view. The agent imports this module, never the console writer.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MANUAL_MEMORY_LIMIT = 2000;

export function manualMemoryPath(name) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_]{1,16}$/.test(name)) throw new Error('Invalid agent name');
    return path.join('bots', name, 'manual-memory.json');
}

function snapshot(text = '', version = 0, updatedAt = null, lastBackup = null) {
    return {
        available: true, text, version, updatedAt, lastBackup,
        limit: MANUAL_MEMORY_LIMIT,
        revision: createHash('sha256').update(JSON.stringify([version, text])).digest('hex')
    };
}

export function readManualMemory(name) {
    try {
        const data = JSON.parse(readFileSync(manualMemoryPath(name), 'utf8'));
        if (typeof data.text !== 'string' || data.text.length > MANUAL_MEMORY_LIMIT
            || !Number.isSafeInteger(data.version) || data.version < 0) throw new Error('Invalid manual memory');
        return snapshot(data.text, data.version, typeof data.updatedAt === 'string' ? data.updatedAt : null,
            typeof data.lastBackup === 'string' ? data.lastBackup : null);
    } catch (error) {
        if (error.code === 'ENOENT') return snapshot();
        return { available: false, error: 'read-failed', text: '', revision: null, limit: MANUAL_MEMORY_LIMIT };
    }
}

export function withManualMemory(prompt, memory) {
    if (!memory.available) throw new Error('Fixed memory could not be read.');
    // Only facts are added to the prompt. Editing permissions are enforced by the console.
    return memory.text.trim() ? `长期记忆：\n${memory.text}\n\n${prompt}` : prompt;
}
