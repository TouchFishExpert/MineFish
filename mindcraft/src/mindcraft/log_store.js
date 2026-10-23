import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {StringDecoder} from 'node:string_decoder';
import {formatWithOptions} from 'node:util';
import {redactLog} from '../utils/log_redaction.js';

export const logEvents = new EventEmitter();
logEvents.setMaxListeners(0);
export const SYSTEM_SCOPE = '$system';
const pending = new Map();
let storageError = null, consoleInstalled = false, sequence = 0;
function directory(agent) {
    if (agent === SYSTEM_SCOPE) return path.resolve('logs/console');
    if (typeof agent !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(agent)) throw Error('invalid-agent');
    return path.resolve('bots', agent, 'logs/console');
}
function callFile(agent, id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw Error('invalid-call');
    return path.join(directory(agent), 'api', `${id}.json`);
}
function append(file, value) {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.appendFileSync(file, JSON.stringify(value) + '\n', {mode: 0o600});
}
function safe(work) {
    try {const value = work(); storageError = null; return value;} catch (error) {
        if (!storageError) process.stderr.write('[ConsoleLogs] Log storage unavailable; check local disk and permissions.\n');
        storageError = error.code || 'storage-unavailable'; return null;
    }
}
// Read newest records in chunks, preserving complete records even when a line crosses chunk boundaries.
function* backwards(file) {
    let fd;
    try {fd = fs.openSync(file, 'r');} catch (error) {if (error.code === 'ENOENT') return; throw error;}
    try {
        let position = fs.fstatSync(fd).size, carry = Buffer.alloc(0);
        while (position > 0) {
            const size = Math.min(position, 65536), buffer = Buffer.alloc(size); position -= size;
            fs.readSync(fd, buffer, 0, size, position);
            const bytes = Buffer.concat([buffer, carry]);
            let end = bytes.length;
            for (let i = bytes.length - 1; i >= 0; i--) if (bytes[i] === 10) {
                if (i + 1 < end) {try {yield JSON.parse(bytes.subarray(i + 1, end).toString('utf8'));} catch {}}
                end = i;
            }
            carry = bytes.subarray(0, end);
        }
        if (carry.length) {try {yield JSON.parse(carry.toString('utf8'));} catch {}}
    } finally {fs.closeSync(fd);}
}
function* records(agent, prefix) {
    const root = directory(agent);
    let files;
    try {files = fs.readdirSync(root).filter(file => new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}\\.jsonl$`).test(file)).sort().reverse();}
    catch (error) {if (error.code === 'ENOENT') return; throw error;}
    for (const file of files) yield* backwards(path.join(root, file));
}
function page(agent, prefix, options, project = value => value) {
    const limit = Math.min(200, Math.max(1, Number(options?.limit) || (prefix === 'api' ? 30 : 150)));
    const values = [], seen = new Set(); let started = !options?.before, hasMore = false;
    for (const row of records(agent, prefix)) {
        const key = prefix === 'api' ? row.callId : row.id;
        if (!started) {if (row.id === options.before) started = true; seen.add(key); continue;}
        if (seen.has(key)) continue; seen.add(key);
        if (values.length === limit) {hasMore = true; break;}
        values.push(project(row));
    }
    return {items: redactLog(values), hasMore, before: values.at(-1)?.id || null, storageError};
}
export function appendSystemLog(agent, message, level = 'info', stream = 'console') {
    return safe(() => {
        const event = redactLog({id: randomUUID(), time: new Date().toISOString(), sequence: ++sequence, agent, level, stream, message: String(message)});
        append(path.join(directory(agent), `system-${event.time.slice(0, 10)}.jsonl`), event);
        logEvents.emit('system', event); return event;
    });
}
export const readSystemLogs = (agent, options) => page(agent, 'system', options);
export const readApiCalls = (agent, options) => page(agent, 'api', options);
export function readApiCall(agent, id) {return redactLog(JSON.parse(fs.readFileSync(callFile(agent, id), 'utf8')));}
export function readLatestConversationCall(agent) {
    let latest = null;
    for (const row of records(agent, 'api')) {
        if (row.purpose !== 'conversation') continue;
        if (!latest || row.startedAt > latest.startedAt) latest = row;
        // Requests are appended in send order. Responses to older calls can be
        // appended later, so do not mistake the newest response for a new input.
        if (row.status === 'pending') return readApiCall(agent, row.callId);
    }
    return latest ? readApiCall(agent, latest.callId) : null;
}
export function appendApiEvent(agent, incoming, processId) {
    return safe(() => {
        const event = redactLog(incoming), file = callFile(agent, event.id);
        let call;
        if (event.phase === 'request') call = {id: event.id, agent, processId, startedAt: event.startedAt,
            operationId: event.operationId, purpose: event.purpose || 'conversation', endpoint: event.endpoint, method: event.method,
            status: 'pending', request: event.request};
        else {call = JSON.parse(fs.readFileSync(file, 'utf8')); Object.assign(call, {finishedAt: event.finishedAt, durationMs: event.durationMs,
            status: event.status, httpStatus: event.httpStatus, response: event.response, error: event.error});}
        fs.mkdirSync(path.dirname(file), {recursive: true});
        const temporary = `${file}.${randomUUID()}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(call, null, 2) + '\n', {mode: 0o600}); fs.renameSync(temporary, file);
        const summary = {id: randomUUID(), callId: call.id, agent, startedAt: call.startedAt, updatedAt: new Date().toISOString(),
            purpose: call.purpose, status: call.status, durationMs: call.durationMs, httpStatus: call.httpStatus,
            model: call.request?.model, finishReason: call.response?.choices?.[0]?.finish_reason, usage: call.response?.usage};
        append(path.join(directory(agent), `api-${summary.updatedAt.slice(0, 10)}.jsonl`), summary);
        const key = `${agent}:${call.id}`;
        if (call.status === 'pending') pending.set(key, {agent, id: call.id, processId}); else pending.delete(key);
        logEvents.emit('api', summary); return call;
    });
}
export function interruptApiCalls(agent, processId) {
    for (const value of [...pending.values()]) if (value.agent === agent && value.processId === processId) {
        appendApiEvent(agent, {id: value.id, phase: 'error', status: 'interrupted', finishedAt: new Date().toISOString(),
            error: {name: 'AgentExited', message: '机器人进程已退出，没有收到本次调用的完整响应。'}}, processId);
    }
}
export function recoverInterruptedApiCalls(agent) {
    const seen = new Set();
    for (const row of records(agent, 'api')) {
        if (seen.has(row.callId)) continue; seen.add(row.callId);
        if (row.status !== 'pending') continue;
        appendApiEvent(agent, {id: row.callId, phase: 'error', status: 'interrupted', finishedAt: new Date().toISOString(),
            error: {name: 'ApplicationRestarted', message: '控制台服务已经重启，本次历史调用没有完整响应。'}}, null);
    }
}
export function captureAgentOutput(child, agent) {
    const cleanups = [];
    for (const [name, stream, destination] of [['stdout', child.stdout, process.stdout], ['stderr', child.stderr, process.stderr]]) {
        if (!stream?.on) continue;
        const decoder = new StringDecoder('utf8'); let buffered = '', finished = false;
        const write = line => {const safeLine = redactLog(line.replace(/\r$/, '')); appendSystemLog(agent, safeLine, name === 'stderr' ? 'error' : 'info', name); destination.write(safeLine + '\n');};
        const data = chunk => {buffered += typeof chunk === 'string' ? chunk : decoder.write(chunk); let split;
            while ((split = buffered.indexOf('\n')) !== -1) {write(buffered.slice(0, split)); buffered = buffered.slice(split + 1);}};
        const finish = () => {if (finished) return; finished = true; buffered += decoder.end(); if (buffered) write(buffered);
            stream.removeListener('data', data); stream.removeListener('end', finish); stream.removeListener('close', finish);};
        stream.on('data', data); stream.once('end', finish); stream.once('close', finish);
        // Child 'exit' can precede its final pipe data. Keep reading until the stream drains.
        cleanups.push(() => {if (stream.readableEnded || stream.destroyed) finish();});
    }
    return () => cleanups.forEach(cleanup => cleanup());
}
export function installConsoleLogCapture() {
    if (consoleInstalled) return; consoleInstalled = true;
    for (const [method, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error'], ['debug', 'debug']]) {
        const original = console[method].bind(console);
        console[method] = (...args) => {const message = redactLog(formatWithOptions({colors: false}, ...args)); appendSystemLog(SYSTEM_SCOPE, message, level); original(message);};
    }
}
