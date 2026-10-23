import { Server } from 'socket.io';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import * as mindcraft from './mindcraft.js';
import { readFileSync } from 'fs';
import { requestAgentInspection, requestAgentMemoryUpdate } from './inspection.js';
import { readManualMemory } from '../utils/manual_memory.js';
import {readCoreSummary} from '../utils/core_summary.js';
import { updateManualMemoryFromConsole } from './manual_memory.js';
import { mergeAgentSettings, saveAgentSettings } from './agent_settings.js';
import {logEvents, SYSTEM_SCOPE, readSystemLogs, readApiCalls, readApiCall, recoverInterruptedApiCalls} from './log_store.js';
import {readContextWindow} from './context_window.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mindserver is:
// - central hub for communication between all agent processes
// - api to control from other languages and remote users 
// - host for webapp

let io;
let server;
const agent_connections = {};
const agent_listeners = [];

const settings_spec = JSON.parse(readFileSync(path.join(__dirname, 'public/settings_spec.json'), 'utf8'));

class AgentConnection {
    constructor(settings, viewer_port) {
        this.socket = null;
        this.settings = settings;
        this.in_game = false;
        this.full_state = null;
        this.viewer_port = viewer_port;
        this.lifecycle = { stage: 'stopped', retryAt: null, error: null };
    }
    setSettings(settings) {
        this.settings = settings;
    }
}

export function registerAgent(settings, viewer_port) {
    let agentConnection = new AgentConnection(settings, viewer_port);
    agent_connections[settings.profile.name] = agentConnection;
    recoverInterruptedApiCalls(settings.profile.name);
}

export function logoutAgent(agentName) {
    if (agent_connections[agentName]) {
        agent_connections[agentName].in_game = false;
        agent_connections[agentName].socket = null;
        agent_connections[agentName].full_state = null;
        agentsStatusUpdate();
    }
}

export function updateAgentLifecycle(agentName, lifecycle) {
    const connection = agent_connections[agentName];
    if (!connection) return;
    connection.lifecycle = { ...connection.lifecycle, ...lifecycle };
    if (lifecycle.stage !== 'online') {
        connection.in_game = false;
        connection.full_state = null;
    }
    agentsStatusUpdate();
}

// Initialize the server
export function createMindServer(host_public = false, port = 8080) {
    const app = express();
    server = http.createServer(app);
    io = new Server(server);
    const systemListener = event => io.to(`logs:system:${event.agent}`).emit('system-log', event);
    const apiListener = event => io.to(`logs:api:${event.agent}`).emit('api-log', event);
    logEvents.on('system', systemListener);
    logEvents.on('api', apiListener);
    server.on('close', () => {logEvents.off('system', systemListener); logEvents.off('api', apiListener);});

    // Serve static files
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    app.use(express.static(path.join(__dirname, 'public')));

    // Texture proxy: resolve item/block textures using minecraft-assets with version fallback
    app.get('/assets/item/:agent/:name.png', async (req, res) => {
        try {
            const agentName = req.params.agent;
            const rawName = req.params.name;
            const itemName = String(rawName).toLowerCase();
            const conn = agent_connections[agentName];
            const preferred = conn?.settings?.minecraft_version;
            const candidates = [];
            if (preferred && preferred !== 'auto') candidates.push(preferred);
            candidates.push('1.21.8');

            // Lazy import to avoid ESM/CJS conflicts
            const mod = await import('minecraft-assets');
            const mcAssetsFactory = mod.default || mod;

            for (const ver of candidates) {
                try {
                    const assets = mcAssetsFactory(ver);
                    // Prefer items path first, then blocks
                    const item = assets.items[itemName];
                    const block = assets.blocks[itemName];
                    const tex = assets.textureContent?.[itemName]?.texture
                        || (item ? assets.textureContent?.[itemName]?.texture : null)
                        || (block ? assets.textureContent?.[itemName]?.texture : null);
                    if (tex) {
                        // textureContent already provides a data URL in many versions
                        if (tex.startsWith('data:image')) {
                            const base64 = tex.split(',')[1];
                            const img = globalThis.Buffer.from(base64, 'base64');
                            res.setHeader('Content-Type', 'image/png');
                            return res.end(img);
                        }
                    }
                    // If textureContent missing, try static path resolution inside package
                    // Helps with some strange blocks like Leaf Litter
                    const guessPaths = [];
                    const base = assets.directory;
                    guessPaths.push(path.join(base, 'items', `${itemName}.png`));
                    guessPaths.push(path.join(base, 'blocks', `${itemName}.png`));
                    for (const p of guessPaths) {
                        try {
                            const fsMod = await import('fs');
                            const buf = fsMod.readFileSync(p);
                            res.setHeader('Content-Type', 'image/png');
                            return res.end(buf);
                        } catch { /* ignore */ }
                    }
                } catch { /* ignore */ }
            }
            // Not found, fallback svg
            res.setHeader('Content-Type', 'image/svg+xml');
            res.status(404).send('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="100%" height="100%" fill="#444"/><text x="50%" y="55%" font-size="12" fill="#bbb" text-anchor="middle">?</text></svg>');
        } catch (e) {
            res.setHeader('Content-Type', 'image/svg+xml');
            res.status(500).send('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="100%" height="100%" fill="#444"/><text x="50%" y="55%" font-size="12" fill="#bbb" text-anchor="middle">!</text></svg>');
        }
    });

    // Socket.io connection handling
    io.on('connection', (socket) => {
        let curAgentName = null;
        console.log('Client connected');

        agentsStatusUpdate(socket);

        const logScopeAllowed = agent => agent === SYSTEM_SCOPE || (typeof agent === 'string' && Object.hasOwn(agent_connections, agent));
        const logRequest = (agent, callback, work) => {
            if (typeof callback !== 'function') return;
            if (socket.data.agentProcess) return callback({error: 'forbidden'});
            if (!logScopeAllowed(agent)) return callback({error: 'not-found'});
            try {callback(work());} catch {callback({error: 'unavailable'});}
        };
        socket.on('get-system-logs', (agent, options, callback) => logRequest(agent, callback, () => readSystemLogs(agent, options)));
        socket.on('get-api-calls', (agent, options, callback) => logRequest(agent, callback, () => readApiCalls(agent, options)));
        socket.on('get-api-call', (agent, id, callback) => logRequest(agent, callback, () => ({call: readApiCall(agent, id)})));
        socket.on('get-context-window', (agent, options, callback) => logRequest(agent, callback, () => readContextWindow(agent, options || {})));
        socket.on('subscribe-console-logs', (request, callback) => logRequest(request?.agent, callback, () => {
            if (!['system', 'api'].includes(request.kind)) return {error: 'invalid-request'};
            socket.join(`logs:${request.kind}:${request.agent}`); return {success: true};
        }));
        socket.on('unsubscribe-console-logs', () => {for (const room of socket.rooms) if (room.startsWith('logs:')) socket.leave(room);});

        socket.on('create-agent', async (settings, callback) => {
            console.log('API create agent...');
            for (let key in settings_spec) {
                if (!(key in settings)) {
                    if (settings_spec[key].required) {
                        callback({ success: false, error: `Setting ${key} is required` });
                        return;
                    }
                    else {
                        settings[key] = settings_spec[key].default;
                    }
                }
            }
            for (let key in settings) {
                if (!(key in settings_spec)) {
                    delete settings[key];
                }
            }
            if (settings.profile?.name) {
                if (settings.profile.name in agent_connections) {
                    callback({ success: false, error: 'Agent already exists' });
                    return;
                }
                let returned = await mindcraft.createAgent(settings);
                callback({ success: returned.success, error: returned.error });
                let name = settings.profile.name;
                if (!returned.success && agent_connections[name]) {
                    mindcraft.destroyAgent(name);
                    delete agent_connections[name];
                }
                agentsStatusUpdate();
            }
            else {
                console.error('Agent name is required in profile');
                callback({ success: false, error: 'Agent name is required in profile' });
            }
        });

        socket.on('get-settings', (agentName, callback) => {
            if (agent_connections[agentName]) {
                callback({ settings: agent_connections[agentName].settings });
            } else {
                callback({ error: `Agent '${agentName}' not found.` });
            }
        });

        socket.on('get-agent-inspection', async (agentName, callback) => {
            if (typeof callback !== 'function') return;
            const connection = typeof agentName === 'string' && Object.hasOwn(agent_connections, agentName)
                ? agent_connections[agentName] : null;
            callback(await requestAgentInspection(connection));
        });

        socket.on('update-agent-memory', async (agentName, request, callback) => {
            if (typeof callback !== 'function') return;
            const connection = typeof agentName === 'string' && Object.hasOwn(agent_connections, agentName)
                ? agent_connections[agentName] : null;
            callback(await requestAgentMemoryUpdate(connection, request));
        });

        socket.on('get-manual-memory', (agentName, callback) => {
            if (typeof callback !== 'function') return;
            if (typeof agentName !== 'string' || !Object.hasOwn(agent_connections, agentName)) return callback({ error: 'not-found' });
            callback({ manualMemory: readManualMemory(agentName) });
        });

        socket.on('get-core-summary', (agentName, callback) => {
            if (typeof callback !== 'function') return;
            if (typeof agentName !== 'string' || !Object.hasOwn(agent_connections, agentName)) return callback({error: 'not-found'});
            callback({coreSummary: readCoreSummary(agentName)});
        });

        socket.on('update-agent-core-summary', (_agentName, _request, callback) => {
            if (typeof callback === 'function') callback({error: 'read-only'});
        });

        socket.on('update-manual-memory', (agentName, request, callback) => {
            if (typeof callback !== 'function') return;
            const result = updateManualMemoryFromConsole(socket, agent_connections, agentName, request);
            if (result.success && !result.unchanged) agent_connections[agentName].socket?.emit('manual-memory-updated');
            callback(result);
        });

        socket.on('connect-agent-process', (agentName) => {
            if (agent_connections[agentName]) {
                socket.data.agentProcess = true;
                for (const room of socket.rooms) if (room.startsWith('logs:')) socket.leave(room);
                curAgentName = agentName;
                agent_connections[agentName].socket = socket;
                agent_connections[agentName].in_game = false;
                agentsStatusUpdate();
            }
        });

        socket.on('login-agent', (agentName) => {
            const process = mindcraft.getAgentProcess(agentName);
            if (process?.stopping || process?.restartRequested) return;
            if (agent_connections[agentName]?.socket === socket) {
                socket.data.agentProcess = true;
                for (const room of socket.rooms) if (room.startsWith('logs:')) socket.leave(room);
                agent_connections[agentName].socket = socket;
                agent_connections[agentName].in_game = true;
                agent_connections[agentName].lifecycle = { stage: 'online', retryAt: null, error: null };
                curAgentName = agentName;
                agentsStatusUpdate();
            }
            else {
                console.warn(`Unregistered agent ${agentName} tried to login`);
            }
        });

        socket.on('disconnect', () => {
            if (agent_connections[curAgentName]?.socket === socket) {
                console.log(`Agent ${curAgentName} disconnected`);
                agent_connections[curAgentName].in_game = false;
                agent_connections[curAgentName].socket = null;
                agent_connections[curAgentName].full_state = null;
                agentsStatusUpdate();
            }
            if (agent_listeners.includes(socket)) {
                removeListener(socket);
            }
        });

        socket.on('chat-message', (agentName, json, callback) => {
            const reply = typeof callback === 'function' ? callback : () => {};
            if (!curAgentName || agent_connections[curAgentName]?.socket !== socket || !socket.data.agentProcess)
                return reply({error: '消息必须来自已连接的机器人进程'});
            if (agentName === curAgentName) return reply({error: '不能向自己发起机器人会话'});
            const target = typeof agentName === 'string' && Object.hasOwn(agent_connections, agentName) ? agent_connections[agentName] : null;
            if (!target?.in_game || !target.socket?.connected) return reply({error: '目标机器人当前不在线'});
            if (!json || typeof json.message !== 'string' || !json.message.trim() || json.message.length > 16000 ||
                typeof json.start !== 'boolean' || typeof json.end !== 'boolean') return reply({error: '机器人消息格式无效'});
            console.log(`${curAgentName} sending message to ${agentName}: ${json.message}`);
            target.socket.emit('chat-message', curAgentName, {message: json.message, start: json.start, end: json.end});
            reply({success: true, from: curAgentName, to: agentName});
        });

        socket.on('set-agent-settings', (agentName, settings, callback) => {
            const reply = typeof callback === 'function' ? callback : () => {};
            const agent = agent_connections[agentName];
            if (!agent) return reply({ error: '机器人不存在' });
            if (socket.data.agentProcess) return reply({ error: '仅控制台可以保存配置' });
            try {
                const merged = mergeAgentSettings(agent.settings, settings);
                saveAgentSettings(merged);
                agent.setSettings(merged);
                mindcraft.startAgent(agentName);
                reply({ success: true, settings: merged });
            } catch (error) {
                reply({ error: error.code ? '保存配置失败，请检查本地文件权限和日志。' : error.message });
            }
        });

        socket.on('restart-agent', (agentName) => {
            console.log(`Restarting agent: ${agentName}`);
            mindcraft.startAgent(agentName);
        });

        socket.on('stop-agent', (agentName) => {
            mindcraft.stopAgent(agentName);
        });

        socket.on('start-agent', (agentName) => {
            mindcraft.startAgent(agentName);
        });

        socket.on('destroy-agent', (agentName) => {
            if (agent_connections[agentName]) {
                mindcraft.destroyAgent(agentName);
                delete agent_connections[agentName];
            }
            agentsStatusUpdate();
        });

        socket.on('stop-all-agents', () => {
            console.log('Killing all agents');
            for (let agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
        });

        socket.on('shutdown', () => {
            console.log('Shutting down');
            for (let agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
            // wait 2 seconds
            setTimeout(() => {
                console.log('Exiting MindServer');
                globalThis.process.exit(0);
            }, 2000);
            
        });

		socket.on('send-message', (agentName, data) => {
			if (!agent_connections[agentName]) {
				console.warn(`Agent ${agentName} not in game, cannot send message via MindServer.`);
                return;
			}
			try {
                agent_connections[agentName].socket.emit('send-message', data);
			} catch (error) {
				console.error('Error: ', error);
			}
		});

        socket.on('bot-output', (agentName, message) => {
            io.emit('bot-output', agentName, message);
        });

        socket.on('listen-to-agents', () => {
            addListener(socket);
        });
    });

    if (host_public) {
        console.log('Public hosting not supported yet. Using localhost.');
    }
    const host = 'localhost';
    server.listen(port, host, () => {
        console.log(`MindServer running on port ${port} on host ${host}`);
    });

    return server;
}

function agentsStatusUpdate(socket) {
    if (!socket) {
        socket = io;
    }
    if (!socket) return;
    let agents = [];
    for (let agentName in agent_connections) {
        const conn = agent_connections[agentName];
        agents.push({
            name: agentName, 
            in_game: conn.in_game,
            viewerPort: conn.viewer_port,
            socket_connected: !!conn.socket?.connected,
            ...conn.lifecycle,
            processId: mindcraft.getAgentProcess(agentName)?.process?.pid ?? null
        });
    };
    socket.emit('agents-status', agents);
}


let listenerInterval = null;
function addListener(listener_socket) {
    agent_listeners.push(listener_socket);
    if (agent_listeners.length === 1) {
        listenerInterval = setInterval(async () => {
            const states = {};
            for (let agentName in agent_connections) {
                let agent = agent_connections[agentName];
                if (agent.in_game && agent.socket?.connected) {
                    try {
                        const state = await new Promise((resolve) => {
                            agent.socket.timeout(2000).emit('get-full-state', (error, s) => resolve(error ? null : s));
                        });
                        states[agentName] = state;
                    } catch (e) {
                        states[agentName] = { error: String(e) };
                    }
                }
            }
            for (let listener of agent_listeners) {
                listener.emit('state-update', states);
            }
        }, 1000);
    }
}

function removeListener(listener_socket) {
    agent_listeners.splice(agent_listeners.indexOf(listener_socket), 1);
    if (agent_listeners.length === 0) {
        clearInterval(listenerInterval);
        listenerInterval = null;
    }
}

// Optional: export these if you need access to them from other files
export const getIO = () => io;
export const getServer = () => server;
export const numStateListeners = () => agent_listeners.length;
