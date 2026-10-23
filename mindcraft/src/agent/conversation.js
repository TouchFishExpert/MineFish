import settings from './settings.js';
import { containsCommand } from './commands/index.js';
import { sendBotChatToServer } from './mindserver_proxy.js';
import {isModelFailureText} from '../utils/model_failure.js';

let agent;
let agent_names = [];
let agents_in_game = [];

class Conversation {
    constructor(name) {
        this.name = name;
        this.active = false;
        this.ignore_until_start = false;
        this.blocked = false;
        this.in_queue = [];
        this.inMessageTimer = null;
    }

    reset() {
        clearTimeout(this.inMessageTimer);
        this.active = false;
        this.ignore_until_start = false;
        this.in_queue = [];
        this.inMessageTimer = null;
        this.end_sent = false;
        this.revision = (this.revision || 0) + 1;
    }

    end() {
        clearTimeout(this.inMessageTimer);
        this.revision = (this.revision || 0) + 1;
        this.active = false;
        this.ignore_until_start = true;
        this.inMessageTimer = null;
        const full_message = _compileInMessages(this);
        if (full_message.message.trim().length > 0)
            agent.history.add(this.name, full_message.message);
        // add the full queued messages to history, but don't respond

        if (agent.last_sender === this.name)
            agent.last_sender = null;
    }

    queue(message) {
        this.in_queue.push(message);
    }
}

const WAIT_TIME_START = 30000;
class ConversationManager {
    constructor() {
        this.convos = {};
        this.activeConversation = null;
        this.awaiting_response = false;
        this.connection_timeout = null;
        this.wait_time_limit = WAIT_TIME_START;
        this.activePeerRequests = 0;
        this.passiveStatuses = new Map();
        this.publicInbox = new Map();
        this.publicFlushTimer = null;
    }

    initAgent(a) {
        this.publicBot?.removeListener?.('action-finished', this.onPublicWaitFinished);
        clearImmediate(this.publicFlushTimer);
        this.publicFlushTimer = null;
        this.publicInbox.clear();
        agent = a;
        this.passiveStatuses.clear();
        this.onPublicWaitFinished = result => {
            if (result.label !== 'action:stay') return;
            clearImmediate(this.publicFlushTimer);
            this.publicFlushTimer = setImmediate(() => {
                this.publicFlushTimer = null;
                if (this.publicChatPaused()) return; // Chained waits share one inbox.
                const queued = [...this.publicInbox.values()];
                this.publicInbox.clear();
                for (const entry of queued) {
                    if (result.interrupted) {
                        agent.history.recordEvent?.('peer-public-deferred-closed', {source: entry.sender, count: entry.count, reason: 'wait-interrupted'});
                        continue; // A manual stop must not wake the model again.
                    }
                    const message = `[等待期间收到的队友公开发言，共 ${entry.count} 条，以下为最新一条；完整记录保留在工作日志]\n${entry.message}`;
                    void this._processMessage(entry.sender, message, 'public').catch(error => console.error('[BotChat] Deferred public message:', error.message));
                }
            });
        };
        this.bindBot(a.bot);
    }

    bindBot(bot) {
        this.publicBot?.removeListener?.('action-finished', this.onPublicWaitFinished);
        this.publicBot = bot;
        bot?.on?.('action-finished', this.onPublicWaitFinished);
    }

    publicChatPaused() {return Boolean(agent.actions?.executing && agent.actions.currentActionLabel === 'action:stay');}

    _deferPublic(sender, message) {
        const previous = this.publicInbox.get(sender);
        // Full messages are durable; only a latest-per-sender snapshot lives in
        // RAM, so an indefinite stay cannot accumulate an unbounded API payload.
        this.publicInbox.set(sender, {sender, message, count: (previous?.count || 0) + 1});
        agent.history.recordEvent?.('peer-public-deferred', {source: sender, channel: 'public', content: message, reason: 'intentional-stay'});
        console.log(`[BotChat] ${agent.name} deferred public message from ${sender} during stay`);
    }

    async _rememberPeerWait(sender, message, channel) {
        // A peer's stay is its own action status, not a question or a command
        // for this bot. Record it before any scheduling/pause/conversation setup.
        if (this.activeConversation?.name === sender) this._clearMonitorTimeouts();
        // System observations join the latest working round, so the status is
        // still visible when the next real input starts a new response round.
        await agent.history.add('system', `[队友等待状态，${channel === 'public' ? '公屏' : '定向通信'}] ${sender}: ${message}\n这是该队友自己的动作状态，不是给你的行动指令。`, {maintainSummary: false});
        console.log(`[BotChat] ${agent.name} recorded ${channel} wait status from ${sender}; no model dispatch`);
        return false;
    }

    async observePublicChat(sender, message) {
        if (!this.isOtherAgent(sender) || typeof message !== 'string' || !message.trim()) return;
        if (isModelFailureText(message)) {
            agent.history.recordEvent?.('peer-message-ignored', {source: sender, channel: 'public', content: message, reason: 'model-error-not-dialogue'});
            return;
        }
        // Directed messages arrive over IPC in full. Their Minecraft echoes must not be
        // mistaken for a second incoming request (or a conversation with someone else).
        if (/^\(To [^)]+\)/.test(message) || containsCommand(message) === '!startConversation' || containsCommand(message) === '!endConversation') return;
        const command = containsCommand(message);
        if (command === '!stay') return this._rememberPeerWait(sender, message, 'public');
        const queryOnly = /^!(?:stats|inventory|nearbyBlocks|craftable|modes|savedPlaces|coreSummary)(?:\([^)]*\))?\s*$/.test(message.trim());
        const passive = ['!stats', '!inventory', '!nearbyBlocks', '!modes', '!savedPlaces', '!coreSummary'].includes(command);
        const key = `${sender}:${command}`, signature = message.trim();
        if (queryOnly || (passive && this.passiveStatuses.get(key) === signature)) {
            agent.history.recordEvent?.('peer-message-ignored', {source: sender, channel: 'public', content: message, reason: queryOnly ? 'query-status-only' : 'duplicate-status'});
            return;
        }
        if (passive) this.passiveStatuses.set(key, signature);
        console.log(`[BotChat] ${agent.name} observed public chat from ${sender}: ${message}`);
        return this._processMessage(sender, `[队友公开发言] ${message}\n这是公开旁听事件，对方的动作记录不是给你的新指令。可以自由闲聊、提问或协作，不限制交流轮数，也不必有任务才聊天；想说就说，不想说也可静默。`, 'public');
    }

    async _processMessage(sender, message, channel) {
        if (channel === 'public' && this.publicChatPaused()) {
            this._deferPublic(sender, message);
            return false;
        }
        this.activePeerRequests++;
        if (agent.self_prompter.isActive()) _pauseSelfPrompterForConversation();
        console.log(`[BotChat] ${agent.name} dispatching ${channel} to model from ${sender}: ${message}`);
        try {
            const options = channel === 'public' ? {deferResponse: () => {
                if (!this.publicChatPaused()) return false;
                this._deferPublic(sender, message);
                return true;
            }} : {};
            return await agent.handleMessage(sender, _tagMessage(message), null, options);
        } finally {
            this.activePeerRequests--;
            if (!this.activePeerRequests) _resumeSelfPrompter();
        }
    }

    _getConvo(name) {
        if (!this.convos[name])
            this.convos[name] = new Conversation(name);
        return this.convos[name];
    }

    _startMonitor() {
        clearInterval(this.connection_monitor);
        let wait_time = 0;
        let last_time = Date.now();
        this.connection_monitor = setInterval(() => {
            if (!this.activeConversation) {
                this._stopMonitor();
                return; // will clean itself up
            }

            let delta = Date.now() - last_time;
            last_time = Date.now();
            let convo_partner = this.activeConversation.name;

            if (this.awaiting_response && agent.isIdle()) {
                wait_time += delta;
                if (wait_time > this.wait_time_limit) {
                    this._processMessage(convo_partner, `[会话等待提示] ${convo_partner} hasn't responded in ${this.wait_time_limit/1000} seconds. Decide whether more coordination is needed or end the conversation.`, 'wait-notice').catch(error => console.error('[BotChat]', error.message));
                    wait_time = 0;
                    this.wait_time_limit*=2;
                }
            }
            else if (!this.awaiting_response){
                this.wait_time_limit = WAIT_TIME_START;
                wait_time = 0;
            }

            if (!this.otherAgentInGame(convo_partner) && !this.connection_timeout) {
                this.connection_timeout = setTimeout(() => {
                    if (this.otherAgentInGame(convo_partner)){
                        this._clearMonitorTimeouts();
                        return;
                    }
                    if (!agent.self_prompter.isPaused()) {
                        this.endConversation(convo_partner);
                        agent.handleMessage('system', `${convo_partner} disconnected, conversation has ended.`);
                    }
                    else {
                        this.endConversation(convo_partner);
                    }
                }, 10000);
            }
        }, 1000);
    }

    _stopMonitor() {
        clearInterval(this.connection_monitor);
        this.connection_monitor = null;
        this._clearMonitorTimeouts();
    }

    _clearMonitorTimeouts() {
        this.awaiting_response = false;
        clearTimeout(this.connection_timeout);
        this.connection_timeout = null;
    }

    async startConversation(send_to, message) {
        if (!this.isOtherAgent(send_to) || !this.otherAgentInGame(send_to))
            return {error: `${send_to} 不是另一在线机器人，消息未发送。`};
        const convo = this._getConvo(send_to);
        convo.reset();
        
        if (convo.active)
            return;
        convo.active = true;
        this.activeConversation = convo;
        this._startMonitor();
        // Console-forced commands do not pass through the model's outgoing history.
        // Keep the actual question so its reply is interpreted in the right context.
        const pending = agent.history.add(agent.name, `[向 ${send_to} 发起会话] ${message}`);
        await agent.history.save();
        void pending.catch(error => console.error('[BotChat] Context summary failed:', error.message));
        return this.sendToBot(send_to, message, true, false);
    }

    startConversationFromOtherBot(name) {
        const convo = this._getConvo(name);
        convo.active = true;
        this.activeConversation = convo;
        this._startMonitor();
    }

    async sendToBot(send_to, message, start=false, open_chat=true) {
        if (!this.isOtherAgent(send_to)) {
            console.warn(`${agent.name} tried to send bot message to non-bot ${send_to}`);
            return {error: `${send_to} 不是另一机器人，消息未发送。`};
        }
        const convo = this._getConvo(send_to);
        
        if (convo.ignore_until_start)
            return {error: '会话已结束，请重新开始。'};
        convo.active = true;
        
        const end = message.includes('!endConversation');
        if (end && convo.end_sent) return {success: true, duplicate: true};
        if (end) convo.end_sent = true;
        const json = {
            'message': message,
            start,
            end,
        };

        // Wait-status notifications intentionally do not ask the peer to reply.
        // Do not turn their silence into a later wait-notice model request.
        this.awaiting_response = !end && containsCommand(message) !== '!stay';
        const result = await sendBotChatToServer(send_to, json);
        if (result?.error) {
            console.warn(`[BotChat] ${agent.name} -> ${send_to} failed: ${result.error}`);
            this.endConversation(send_to);
            await agent.history.add('system', `给 ${send_to} 的消息未投递：${result.error}`);
            await agent.history.save();
        } else {
            console.log(`[BotChat] ${agent.name} -> ${send_to} delivered: ${message}`);
            if (settings.chat_bot_messages && open_chat) await agent.openChat(`(To ${send_to}) ${message}`);
        }
        return result;
    }

    async receiveFromBot(sender, received) {
        if (!this.isOtherAgent(sender) || !received || typeof received.message !== 'string' || !received.message.trim()) return;
        if (isModelFailureText(received.message)) {
            agent.history.recordEvent?.('peer-message-ignored', {source: sender, channel: 'direct', content: received.message, reason: 'model-error-not-dialogue'});
            return;
        }
        if (containsCommand(received.message) === '!stay') return this._rememberPeerWait(sender, received.message, 'direct');
        const convo = this._getConvo(sender);

        if (convo.ignore_until_start && !received.start)
            return;

        // check if any convo is active besides the sender
        if (this.inConversation() && !this.inConversation(sender)) {
            this.sendToBot(sender, `I'm talking to someone else, try again later. !endConversation("${sender}")`, false, false);
            this.endConversation(sender);
            return;
        }

        if (received.start) {
            convo.reset();
            this.startConversationFromOtherBot(sender);
        }

        this._clearMonitorTimeouts();
        convo.queue(received);
        if (received.end) {
            const message = _compileInMessages(convo).message;
            console.log(`[BotChat] ${agent.name} conversation ended by ${sender}: ${received.message}`);
            this.endConversation(sender);
            await agent.history.save();
            const meaningful = message.replace(/!endConversation\s*\([^)]*\)/g, '').trim();
            if (meaningful) return this._processMessage(sender, `[会话已结束] ${message}\n这是最终消息，会话已关闭；知晓结果即可，不必回复确认。需要继续协调时可发起新会话。`, 'conversation-ended');
            return;
        }
        if (!convo.active) return;
        _scheduleProcessInMessage(sender, received, convo);
    }

    responseScheduledFor(sender) {
        if (!this.isOtherAgent(sender) || !this.inConversation(sender))
            return false;
        const convo = this._getConvo(sender);
        return !!convo.inMessageTimer;
    }

    isOtherAgent(name) {
        return name !== agent?.name && agent_names.some((n) => n === name);
    }

    otherAgentInGame(name) {
        return agents_in_game.some((n) => n === name);
    }
    
    updateAgents(agents) {
        agent_names = agents.map(a => a.name);
        agents_in_game = agents.filter(a => a.in_game).map(a => a.name);
    }

    getInGameAgents() {
        return agents_in_game;
    }
    
    inConversation(other_agent=null) {
        if (other_agent)
            return this.convos[other_agent]?.active;
        return Object.values(this.convos).some(c => c.active);
    }
    
    endConversation(sender) {
        if (this.convos[sender]) {
            this.convos[sender].end();
            if (this.activeConversation?.name === sender) {
                this._stopMonitor();
                this.activeConversation = null;
                if (!this.activePeerRequests && agent.self_prompter.isPaused()) {
                    _resumeSelfPrompter();
                }
            }
        }
    }
    
    endAllConversations() {
        for (const sender in this.convos) {
            this.endConversation(sender);
        }
        if (!this.activePeerRequests && agent.self_prompter.isPaused()) {
            _resumeSelfPrompter();
        }
    }

    forceEndCurrentConversation() {
        if (this.activeConversation) {
            let sender = this.activeConversation.name;
            this.sendToBot(sender, '!endConversation("' + sender + '")', false, false);
            this.endConversation(sender);
        }
    }
}

const convoManager = new ConversationManager();
export default convoManager;

// Coalesce messages already in this event-loop turn; never wait for a game action.
function _scheduleProcessInMessage(sender, received, convo) {
    clearTimeout(convo.inMessageTimer);
    const revision = convo.revision;
    const processWhenReady = () => {
        if (!convo.active || convo.revision !== revision || !convo.in_queue.length) {
            convo.inMessageTimer = null;
            return;
        }
        convo.inMessageTimer = null;
        const message = _compileInMessages(convo);
        console.log(`[BotChat] ${agent.name} responding to ${sender}: ${message.message}`);
        convoManager._processMessage(sender, message.message, 'direct').catch(error => {
            console.error('[BotChat] Response failed:', error.message);
        });
    };
    convo.inMessageTimer = setTimeout(processWhenReady, 0);
}

function _compileInMessages(convo) {
    let pack = {};
    let full_message = '';
    while (convo.in_queue.length > 0) {
        pack = convo.in_queue.shift();
        full_message += (full_message ? '\n' : '') + pack.message;
    }
    pack.message = full_message;
    return pack;
}

function _tagMessage(message) {
    return "(FROM OTHER BOT)" + message;
}

function _pauseSelfPrompterForConversation() {
    // Communication pauses new autonomous decisions, not the running game action.
    // SelfPrompter.pause() calls actions.stop(), which can kill/reconnect a bot if
    // a plugin cannot stop promptly. Plain dialogue can safely happen alongside it.
    agent._conversationGoalState = agent.self_prompter.state;
    agent.self_prompter.setPromptPaused(agent.self_prompter.prompt);
    void agent.self_prompter.stopLoop();
}

function _resumeSelfPrompter() {
    if (!agent._shuttingDown && agent._conversationGoalState === 1 && agent.self_prompter.isPaused()) {
        agent._conversationGoalState = null;
        agent.self_prompter.start();
    }
}
