import { sendOutputToServer } from './mindserver_proxy.js';
import nbt from 'prismarine-nbt';
import { readFileSync, writeFileSync } from 'fs';

const privateValues = ['./keys.json', './login.private.json'].flatMap(file => {
    try {
        const data = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        return [data.DEEPSEEK_API_KEY, data.password].filter(Boolean);
    } catch { return []; }
});
const redact = value => privateValues.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), String(value));

export function normalizeKickReason(reason) {
    let value = reason;
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { return value; }
    }
    if (value instanceof Error) return { name: value.name, message: value.message, code: value.code };
    if (value && typeof value === 'object' && value.type && 'value' in value) {
        try { value = nbt.simplify(value); } catch {}
    }
    return value;
}

function reasonText(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(reasonText).join(' ');
    if (!value || typeof value !== 'object') return String(value ?? '');
    const main = value.text || value.translate || value.message || value.fallback;
    const details = [main, ...(value.with || []), ...(value.extra || [])].filter(Boolean).map(reasonText).join(' ');
    return details || JSON.stringify(value);
}

// Definitions of error types, keywords, and full human-readable messages.
const ERROR_DEFINITIONS = {
    'name_conflict': {
        keywords: ['name_taken', 'duplicate_login', 'already connected', 'already logged in', 'username is already'],
        msg: 'Name Conflict: The name is already in use or you are already logged in.',
        isFatal: true
    },
    'access_denied': {
        keywords: ['whitelist', 'not white-listed', 'banned', 'suspended', 'verify'],
        msg: 'Access Denied: You are not whitelisted or banned.',
        isFatal: true
    },
    'server_full': {
        keywords: ['server is full', 'full server'],
        msg: 'Connection Failed: The server is full.',
        isFatal: false
    },
    'version_mismatch': {
        keywords: ['outdated', 'version', 'client'],
        msg: 'Version Mismatch: Client and server versions do not match.',
        isFatal: true
    },
    'maintenance': {
        keywords: ['maintenance', 'updating', 'server closed', 'restarting'],
        msg: 'Connection Failed: Server is under maintenance or restarting.',
        isFatal: false
    },
    'network_error': {
        keywords: ['timeout', 'timed out', 'connection lost', 'reset', 'refused', 'keepalive', 'socketclosed'],
        msg: 'Network Error: Connection timed out or was lost.',
        isFatal: false
    },
    'behavior': {
        keywords: ['flying', 'spam', 'speed'],
        msg: 'Kicked: Removed from server due to flying, spamming, or invalid movement.',
        isFatal: true
    }
};

// Helper to log messages to console (once) and MindServer.
export const log = (agentName, msg) => {
    // Use console.error for visibility in terminal
    console.error(msg);
    try { sendOutputToServer(agentName || 'system', msg); } catch (_) {}
};

// Analyzes the kick reason and returns a full, human-readable sentence.
export function parseKickReason(reason) {
    if (!reason) return { type: 'unknown', msg: 'Unknown reason (Empty)', isFatal: true };
    
    const normalized = normalizeKickReason(reason);
    const raw = redact(typeof normalized === 'string' ? normalized : JSON.stringify(normalized)).toLowerCase();

    // Search for keywords in definitions
    for (const [type, def] of Object.entries(ERROR_DEFINITIONS)) {
        if (def.keywords.some(k => raw.includes(k))) {
            console.error(`Disconnected: ${raw}`);
            return { type, msg: def.msg, isFatal: def.isFatal };
        }
    }
    
    // Fallback: Extract text from JSON
    const fallback = redact(reasonText(normalized));
    
    return { type: 'other', msg: `Disconnected: ${fallback}`, isFatal: true };
}

// Centralized handler for disconnections.
export function handleDisconnection(agentName, reason, event = 'Disconnected') {
    const { type, msg } = parseKickReason(reason);
    const detail = {
        time: new Date().toISOString(), event, type,
        reason: JSON.parse(redact(JSON.stringify(normalizeKickReason(reason) ?? null)))
    };
    try { writeFileSync(`./bots/${agentName}/last-disconnect.json`, JSON.stringify(detail, null, 2)); } catch {}
    try {
        const file = `./bots/${agentName}/connection-state.json`;
        const state = JSON.parse(readFileSync(file, 'utf8'));
        Object.assign(state, { connected: false, disconnectedAt: detail.time, lastDisconnect: detail });
        writeFileSync(file, JSON.stringify(state, null, 2));
    } catch {}
    log(agentName, `[Connection ${detail.time}] event=${event} reason=${JSON.stringify(detail.reason)}`);
    
    // Format: [LoginGuard] Error Message
    const finalMsg = `[LoginGuard] ${msg}`;
    
    // Only call log once (it handles console printing)
    log(agentName, finalMsg);
    
    return { type, msg: finalMsg };
}

// Validates name format.
export function validateNameFormat(name) {
    if (!name || !/^[a-zA-Z0-9_]{3,16}$/.test(name)) {
        return { 
            success: false, 
            // Added [LoginGuard] prefix here for consistency
            msg: `[LoginGuard] Invalid name '${name}'. Must be 3-16 alphanumeric/underscore characters.` 
        };
    }
    return { success: true };
}
