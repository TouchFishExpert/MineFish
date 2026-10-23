import { createHash } from 'node:crypto';

export const SUMMARY_LIMIT = 2500;
export const SUMMARY_COMPACT_TRIGGER = 2400;
export const SUMMARY_COMPACT_TARGET = 2000;
export const memoryRevision = summary => createHash('sha256').update(summary).digest('hex');

export function validateMemoryEdit(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)
        || Object.keys(request).some(key => !['summary', 'baseRevision'].includes(key))
        || typeof request.summary !== 'string' || typeof request.baseRevision !== 'string'
        || !/^[a-f0-9]{64}$/.test(request.baseRevision)) return 'invalid-request';
    if (request.summary.length > SUMMARY_LIMIT) return 'too-long';
    return null;
}
