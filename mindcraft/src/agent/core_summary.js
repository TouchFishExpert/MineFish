import {mkdirSync, existsSync, writeFileSync, renameSync, unlinkSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {CORE_SUMMARY_LIMIT, coreSummaryPath, readCoreSummary} from '../utils/core_summary.js';

export function ensureCoreSummary(name) {
    const file = coreSummaryPath(name);
    if (!existsSync(file)) {
        mkdirSync(path.dirname(file), {recursive: true});
        try {writeFileSync(file, JSON.stringify({text: '', version: 0, updatedAt: null, lastBackup: null}, null, 2) + '\n', {flag: 'wx', mode: 0o600});}
        catch (error) {if (error.code !== 'EEXIST') throw error;}
    }
    return readCoreSummary(name);
}

// Only the model-only command imports this writer. The web console imports the reader.
export function setCoreSummary(agent, text, baseRevision) {
    if (typeof text !== 'string' || typeof baseRevision !== 'string' || !/^[a-f0-9]{64}$/.test(baseRevision)) return {error: 'invalid-request'};
    if (text.length > CORE_SUMMARY_LIMIT) return {error: 'too-long', limit: CORE_SUMMARY_LIMIT};
    const current = readCoreSummary(agent.name);
    if (!current.available) return {error: 'read-failed'};
    if (baseRevision !== current.revision) return {error: 'conflict', current};
    if (text === current.text) return {success: true, unchanged: true, current};
    const file = coreSummaryPath(agent.name), directory = path.join(path.dirname(file), 'core-summary-backups');
    const backup = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`;
    const value = {text, version: current.version + 1, updatedAt: new Date().toISOString(), lastBackup: backup, source: 'model'};
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        mkdirSync(directory, {recursive: true});
        writeFileSync(path.join(directory, backup), JSON.stringify(current, null, 2) + '\n', {flag: 'wx', mode: 0o600});
        writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
        renameSync(temporary, file);
    } catch {
        try {unlinkSync(temporary);} catch {}
        return {error: 'save-failed'};
    }
    console.log(`[CoreSummary] ${agent.name}: saved version ${value.version}, ${text.length}/${CORE_SUMMARY_LIMIT} characters.`);
    return {success: true, current: readCoreSummary(agent.name)};
}
