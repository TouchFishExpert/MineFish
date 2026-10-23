const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { createRequire } = require('module');
const root = path.resolve(__dirname, '..');
const app = path.join(root, 'mindcraft');
const requireApp = createRequire(path.join(app, 'package.json'));
const { io } = requireApp('socket.io-client');
const secrets = ['keys.json', 'login.private.json'].flatMap(file => {
    try { return Object.entries(JSON.parse(fs.readFileSync(path.join(app, file), 'utf8').replace(/^\uFEFF/, '')))
        .filter(([key, value]) => /key|password|token|secret/i.test(key) && typeof value === 'string' && value)
        .map(([, value]) => value); } catch { return []; }
});
const logPath = path.join(root, 'logs', 'mindcraft.log');
fs.mkdirSync(path.dirname(logPath), {recursive: true});
const log = fs.createWriteStream(logPath, { flags: 'a' });
function record(s) {
    for (const secret of secrets) if (secret) s = s.replaceAll(secret, '[REDACTED]');
    log.write(s);
}
let child;
let stopping = false;
const control = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.url === '/status') {
        let state = null;
        try { state = JSON.parse(fs.readFileSync(path.join(app, 'bots/bot/connection-state.json'))); } catch {}
        const fresh = state && Date.now() - Date.parse(state.time) < 25000;
        res.end(JSON.stringify({ supervisorPid: process.pid, mainPid: child?.pid, running: child?.exitCode === null, botOnline: Boolean(fresh && state.connected && state.authenticated), state }));
    } else if (req.url === '/stop' && req.method === 'POST') {
        res.end(JSON.stringify({ stopping: true }));
        stop();
    } else { res.statusCode = 404; res.end('{}'); }
});
function stop() {
    if (stopping) return;
    stopping = true;
    record('\n[' + new Date().toISOString() + '] Graceful shutdown requested.\n');
    const socket = io('http://localhost:18080', { reconnection: false });
    socket.on('connect', () => { socket.emit('shutdown'); setTimeout(() => socket.disconnect(), 500); });
    setTimeout(() => {
        socket.disconnect();
        if (child?.exitCode === null) child.kill();
        control.close();
        log.end(() => process.exit(0));
    }, 5000);
}
control.on('error', error => { record('Control port unavailable: ' + error.code + '\n'); log.end(() => process.exit(1)); });
control.listen(18081, '127.0.0.1', () => {
    fs.writeFileSync(path.join(root, 'deployment', 'supervisor.pid'), String(process.pid));
    record('\n[' + new Date().toISOString() + '] Starting Mindcraft normal main.js entry.\n');
    const env = { ...process.env };
    for (const key of ['INSECURE_CODING', 'SETTINGS_JSON', 'PROFILES', 'MINECRAFT_PORT', 'MINDSERVER_PORT', 'LOG_ALL']) delete env[key];
    if (env.MINDCRAFT_RESUME_MEMORY === '1') env.SETTINGS_JSON = JSON.stringify({ load_memory: true });
    delete env.MINDCRAFT_RESUME_MEMORY;
    child = spawn(process.execPath, ['main.js'], { cwd: app, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) { stream.setEncoding('utf8'); stream.on('data', record); }
    child.on('error', error => record('Mindcraft process error: ' + error.message + '\n'));
    child.on('exit', (code, signal) => {
        record('Mindcraft main exited: ' + code + ', ' + signal + '\n');
        if (!stopping) { control.close(); log.end(() => process.exit(code || 0)); }
    });
});
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
