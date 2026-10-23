import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {redactLog} from './log_redaction.js';

const context = new AsyncLocalStorage();
export const withApiTraceContext = (value, work) => context.run(value, work);
export function publishApiTrace(event) {
    if (!process.connected || typeof process.send !== 'function') return;
    try {process.send({type: 'agent-api-log', event: redactLog(event)}, () => {});} catch {}
}
const body = value => {try {return JSON.parse(value);} catch {return value;}};
export function tracedFetch(fetch, publish = publishApiTrace) {
    const record = value => {try {publish(redactLog(value));} catch { /* Logging cannot fail the model call. */ }};
    return async (url, options = {}) => {
        const id = randomUUID(), startedAt = new Date().toISOString(), started = Date.now();
        const metadata = {id, startedAt, ...context.getStore(), endpoint: String(url), method: options.method || 'POST'};
        record({...metadata, phase: 'request', request: body(typeof options.body === 'string' ? options.body : String(options.body ?? ''))});
        try {
            const response = await fetch(url, options);
            // Clone before SDK parsing: preserves choices, reasoning, usage, errors and each HTTP retry.
            const responseText = await response.clone().text();
            record({...metadata, phase: 'response', finishedAt: new Date().toISOString(), durationMs: Date.now() - started,
                status: response.ok ? 'completed' : 'failed', httpStatus: response.status, response: body(responseText)});
            return response;
        } catch (error) {
            record({...metadata, phase: 'error', finishedAt: new Date().toISOString(), durationMs: Date.now() - started,
                status: 'failed', error: {name: error.name, message: error.message, code: error.code}});
            throw error;
        }
    };
}
