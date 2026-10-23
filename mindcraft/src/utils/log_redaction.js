import {readFileSync} from 'node:fs';

const registered = new Set();
let cached = [], checkedAt = 0;
const secretField = /^(authorization|proxy.authorization|api[-_]?key|.*[-_]api[-_]?key|password|passwd|access[-_]?token|refresh[-_]?token|client[-_]?secret|cookie|set-cookie)$/i;
export function registerLogSecret(value) {if (typeof value === 'string' && value) registered.add(value);}
function secrets() {
    if (Date.now() - checkedAt > 1000) {
        checkedAt = Date.now();
        const values = [];
        for (const file of ['keys.json', 'login.private.json']) {
            try {for (const [key, value] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) if ((secretField.test(key) || /key|password|token|secret/i.test(key)) && typeof value === 'string' && value) values.push(value);} catch {}
        }
        for (const [key, value] of Object.entries(process.env)) if (/API_KEY|TOKEN|PASSWORD|SECRET/.test(key) && value) values.push(value);
        cached = values;
    }
    return [...new Set([...registered, ...cached])].sort((a, b) => b.length - a.length);
}
export function redactLog(value) {
    const privateValues = secrets();
    const text = input => {
        let output = input;
        for (const secret of privateValues) output = output.replaceAll(secret, '[REDACTED]');
        return output.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
            .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
            .replace(/(\/(?:login|register)\s+)\S+(?:\s+\S+)?/gi, '$1[REDACTED]')
            .replace(/([?&](?:api_key|key|token|password)=)[^&#\s]*/gi, '$1[REDACTED]');
    };
    const seen = new WeakSet();
    const visit = input => {
        if (typeof input === 'string') return text(input);
        if (input === null || typeof input !== 'object') return input;
        if (seen.has(input)) return '[Circular]';
        seen.add(input);
        const result = Array.isArray(input) ? input.map(visit) : Object.fromEntries(Object.entries(input).map(([key, item]) => [key, secretField.test(key) ? '[REDACTED]' : visit(item)]));
        seen.delete(input); return result;
    };
    return visit(value);
}
