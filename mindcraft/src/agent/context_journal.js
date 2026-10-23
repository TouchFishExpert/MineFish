import {appendFileSync, openSync, closeSync, readSync, statSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {redactLog} from '../utils/log_redaction.js';

export class ContextJournal {
    constructor(name) {
        if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw Error('Invalid agent name');
        this.name = name;
        this.file = path.join('bots', name, 'work-context-log.jsonl');
        mkdirSync(path.dirname(this.file), {recursive: true});
        appendFileSync(this.file, '', {mode: 0o600});
        this.end = statSync(this.file).size;
        if (this.end) {
            const fd = openSync(this.file, 'r'), last = Buffer.alloc(1);
            try {readSync(fd, last, 0, 1, this.end - 1);} finally {closeSync(fd);}
            // Preserve even an interrupted partial record; separate future lines.
            if (last[0] !== 10) {appendFileSync(this.file, '\n'); this.end++;}
        }
    }

    append(kind, value = {}) {
        const event = redactLog({...value, id: value.id || randomUUID(), time: value.time || new Date().toISOString(), agent: this.name, kind});
        const bytes = Buffer.from(JSON.stringify(event) + '\n');
        appendFileSync(this.file, bytes, {mode: 0o600});
        this.end += bytes.length;
        return event;
    }

    // Reads only the next bounded batch, never parses the full permanent log.
    readBatch(offset, {maxMessages = 50, maxChars = 12000, maxRecords = 200} = {}) {
        const fd = openSync(this.file, 'r'), end = statSync(this.file).size;
        let position = Math.min(Math.max(0, offset), end), nextOffset = position, carry = Buffer.alloc(0), chars = 0, records = 0;
        const events = [];
        try {
            while (position < end) {
                const buffer = Buffer.alloc(Math.min(16384, end - position));
                const count = readSync(fd, buffer, 0, buffer.length, position); if (!count) break;
                position += count; carry = Buffer.concat([carry, buffer.subarray(0, count)]);
                let newline;
                while ((newline = carry.indexOf(10)) >= 0) {
                    const line = carry.subarray(0, newline), consumed = newline + 1;
                    let event; try {event = JSON.parse(line.toString('utf8'));} catch {}
                    const message = event?.kind === 'message';
                    if (message && events.length && chars + event.content.length > maxChars) return {events, nextOffset, records};
                    nextOffset += consumed; carry = carry.subarray(consumed); records++;
                    if (message) {events.push(event); chars += event.content.length;}
                    if (events.length >= maxMessages || records >= maxRecords) return {events, nextOffset, records};
                }
            }
            return {events, nextOffset, records};
        } finally {closeSync(fd);}
    }
}
