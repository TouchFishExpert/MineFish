import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { logoutAgent, updateAgentLifecycle } from '../mindcraft/mindserver.js';
import {appendSystemLog, appendApiEvent, captureAgentOutput, interruptApiCalls} from '../mindcraft/log_store.js';

const init_agent_path = fileURLToPath(new URL('./init_agent.js', import.meta.url));

export class AgentProcess {
    constructor(name, port, dependencies = {}) {
        this.name = name;
        this.port = port;
        this.spawn = dependencies.spawn || spawn;
        this.setTimer = dependencies.setTimeout || setTimeout;
        this.clearTimer = dependencies.clearTimeout || clearTimeout;
        this.restartAttempts = 0;
        this.running = false;
        this.stopping = false;
    }

    status(stage, extra = {}) {
        updateAgentLifecycle(this.name, { stage, retryAt: null, error: null, ...extra });
        appendSystemLog(this.name, `进程状态：${stage}${extra.error ? ` · ${extra.error}` : ''}`, extra.error ? 'warn' : 'info', 'supervisor');
    }
    cancelRetry() {
        this.clearTimer(this.restartTimer);
        this.restartTimer = null;
    }

    start(load_memory = false, init_message = null, count_id = 0) {
        this.cancelRetry();
        if (this.running && this.process) {
            console.warn(`Agent ${this.name} is already running; ignoring duplicate start.`);
            return;
        }
        this.stopping = false;
        this.count_id = count_id;
        this.running = true;
        this.restartRequested = false;
        this.status('starting');
        const args = [init_agent_path, this.name, '-n', this.name, '-c', String(count_id), '-p', String(this.port)];
        if (load_memory) args.push('-l');
        if (init_message) args.push('-m', init_message);
        const child = this.spawn(process.execPath, args, { stdio: ['inherit', 'pipe', 'pipe', 'ipc'], windowsHide: true });
        this.process = child;
        const flushOutput = captureAgentOutput(child, this.name);
        const startedAt = Date.now();
        let completed = false;
        const finish = (code, signal) => {
            if (completed || this.process !== child) return;
            completed = true;
            flushOutput();
            interruptApiCalls(this.name, child.pid);
            this.clearTimer(this.killTimer);
            this.clearTimer(this.startupTimer);
            this.killTimer = this.startupTimer = null;
            this.running = false;
            this.process = null;
            logoutAgent(this.name);
            console.log(`Agent ${this.name} process exited with code ${code} and signal ${signal}`);
            if (this.restartRequested) {
                this.restartRequested = false;
                this.status('restarting');
                this.restartTimer = this.setTimer(() => this.start(true, null, this.count_id), 750);
            } else if (this.stopping || code === 0 || signal === 'SIGINT') {
                this.status('stopped');
            } else if (code > 1) {
                this.status('error', { error: '登录被拒绝，请检查账号、白名单及日志后重试。' });
            } else {
                if (Date.now() - startedAt > 300000) this.restartAttempts = 0;
                if (++this.restartAttempts > 5) {
                    this.status('error', { error: '重连已达 5 次上限，请查看日志后重试。' });
                    return;
                }
                const delay = Math.min(30000 * this.restartAttempts, 120000);
                this.status('retrying', { retryAt: Date.now() + delay, error: '连接中断，等待自动重连。' });
                console.log(`Reconnecting in ${delay / 1000}s, attempt ${this.restartAttempts}/5...`);
                this.restartTimer = this.setTimer(() => this.start(true, null, this.count_id), delay);
            }
        };
        child.once('exit', finish);
        child.once('error', () => finish(1, null));
        child.on('message', message => {
            if (this.process !== child) return;
            if (message?.type === 'agent-api-log') {appendApiEvent(this.name, message.event, child.pid); return;}
            if (this.stopping || this.restartRequested) return;
            if (message?.type === 'agent-stage' && ['connecting', 'authenticating', 'online'].includes(message.stage)) {
                this.status(message.stage);
                if (message.stage === 'online') {
                    this.clearTimer(this.startupTimer);
                    this.startupTimer = null;
                }
            }
        });
        // Covers initialization before Mineflayer exists as well as login and spawn.
        this.startupTimer = this.setTimer(() => {
            if (this.process !== child || this.stopping) return;
            console.error(`Agent ${this.name} startup timed out.`);
            this.status('error', { error: '进服初始化超时，将重新连接；也可手动重试。' });
            child.kill('SIGKILL');
        }, 120000);
    }

    terminate() {
        const child = this.process;
        if (!this.running || !child || this.killTimer) return;
        this.killTimer = this.setTimer(() => {
            if (this.process === child) child.kill('SIGKILL');
        }, 5000);
        if (child.connected) child.send({ type: 'shutdown-agent' }, error => { if (error && this.process === child) child.kill('SIGINT'); });
        else child.kill('SIGINT');
    }

    stop() {
        this.stopping = true;
        this.restartRequested = false;
        this.cancelRetry();
        this.status(this.running ? 'stopping' : 'stopped');
        this.terminate();
    }

    forceRestart() {
        this.cancelRetry();
        this.restartAttempts = 0;
        this.restartRequested = true;
        this.stopping = false;
        this.status('restarting');
        if (this.running && this.process) this.terminate();
        else this.start(true, null, this.count_id);
    }
}
