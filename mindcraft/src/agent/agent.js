import { History } from './history.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands, getCommand } from './commands/index.js';
import { ActionManager } from './action_manager.js';
import {stopNavigation} from './action_context.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import { SelfPrompter } from './self_prompter.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import { addBrowserViewer } from './vision/browser_viewer.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import settings from './settings.js';
import { Task } from './tasks/tasks.js';
import { speak } from './speak.js';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';
import { installServerLogin } from './server_login.js';
import { IdleWakeup } from './idle_wakeup.js';
import { ensureCoreSummary } from './core_summary.js';
import {isModelFailureText} from '../utils/model_failure.js';
import {installRuntimeObservation} from './runtime_observation.js';

export class Agent {
    async start(load_mem=false, init_message=null, count_id=0) {
        this.last_sender = null;
        this.responseEpoch = 0;
        this.count_id = count_id;
        this._disconnectHandled = false;

        // Initialize components
        this.actions = new ActionManager(this);
        this.prompter = new Prompter(this, settings.profile);
        this.name = (this.prompter.getName() || '').trim();
        console.log(`Initializing agent ${this.name}...`);
        
        // Validate Name Format
        // connection_handler now ensures the message has [LoginGuard] prefix
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
            return;
        }
        
        ensureCoreSummary(this.name);
        this.history = new History(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();
        this.self_prompter = new SelfPrompter(this);
        this.idle_wakeup = new IdleWakeup(this);
        convoManager.initAgent(this);
        await this.prompter.initExamples();

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
            this.idle_wakeup.restore(save_data?.idle_wakeup, save_data?.self_prompting_state);
            if (save_data?.places) this.memory_bank.loadJson(structuredClone(save_data.places));
            // Restore intent before authentication: a restart during login must
            // not save the constructor's STOPPED state over the loaded goal.
            if (save_data?.self_prompt && settings.enable_self_prompt !== false)
                await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state, false);
        }
        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this._memoryReady = true;
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        blacklistCommands(this.blocked_actions);

        console.log(this.name, 'logging into minecraft...');
        this.reportStage('connecting');
        this.bot = initBot(this.name);
        installRuntimeObservation(this);
        convoManager.bindBot(this.bot);
        this.serverLoginReady = installServerLogin(this.bot, {username: this.name});
        
        // Connection Handler
        const onDisconnect = async (event, reason) => {
            if (this._disconnectHandled || this._shuttingDown) return;
            this._disconnectHandled = true;

            // Log and Analyze
            // handleDisconnection handles logging to console and server
            const { type } = handleDisconnection(this.name, reason, event);
            try { await this.history.save(); } catch { /* the existing memory remains available */ }
     
            process.exit(['name_conflict', 'access_denied', 'version_mismatch', 'behavior'].includes(type) ? 2 : 1);
        };
        
        // Bind events
        this.bot.once('kicked', (reason) => onDisconnect('Kicked', reason));
        this.bot.once('end', (reason) => onDisconnect('Disconnected', reason));
        this.bot.on('error', (err) => {
            if (String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED')) {
                 onDisconnect('Error', err);
            } else {
                 log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
            }
        });

        initModes(this);

        this.bot.on('login', () => {
            console.log(this.name, 'logged in!');
            this.reportStage('authenticating');
            
            // Set skin for profile, requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
            if (this.prompter.profile.skin)
                this.bot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
        });
		const spawnTimeoutDuration = settings.spawn_timeout;
        const spawnTimeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);
            process.exit(1);
        }, spawnTimeoutDuration * 1000);
        this.bot.once('spawn', async () => {
            try {
                clearTimeout(spawnTimeout);
                if (!await this.serverLoginReady) return;
                addBrowserViewer(this.bot, count_id);
                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 1000));
                
                console.log(`${this.name} spawned.`);
                this.clearBotLogs();
              
                this._setupEventHandlers(save_data, init_message);
                this.startEvents();
                serverProxy.login();
                this.reportStage('online');
                this.idle_wakeup.start();
              
                if (!load_mem) {
                    if (settings.task) {
                        this.task.initBotTask();
                        this.task.setAgentGoal();
                    }
                } else {
                    // set the goal without initializing the rest of the task
                    if (settings.task) {
                        this.task.setAgentGoal();
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);
                process.exit(1);
            }
        });
    }

    async _setupEventHandlers(save_data, init_message) {
        const ignore_messages = [
            "Set bot's game mode to",
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];
        
        const respondFunc = async (username, message, channel = 'chat') => {
            if (message === "") return;
            if (username === this.name) return;
            const fromBot = convoManager.isOtherAgent(username);
            if (!fromBot && settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;
                console.log(this.name, 'received message from', username, ':', message);
                if (fromBot) {
                    if (channel === 'whisper') {
                        await convoManager.receiveFromBot(username, {message, start: !convoManager.inConversation(username), end: false});
                    } else {
                        await convoManager.observePublicChat(username, message);
                    }
                }
                else {
                    this.shut_up = false;
                    let translation = await handleEnglishTranslation(message);
                    await this.handleMessage(username, translation);
                }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        }

		this.respondFunc = respondFunc;

        this.bot.on('whisper', (username, message) => respondFunc(username, message, 'whisper'));
        
        this.bot.on('chat', (username, message) => {
            if (!convoManager.isOtherAgent(username) && serverProxy.getNumOtherAgents() > 0 && !settings.reply_publicly) return;
            // Public AI observations are deferred during stay; direct IPC is handled separately.
            respondFunc(username, message);
        });

        // Automatic/manual eating is configured together when the plugins are loaded.

        // Restarts omit the CLI message; use the current console setting in that case.
        init_message = init_message ?? settings.init_message ?? null;
        if (save_data?.last_sender && !convoManager.isOtherAgent(save_data.last_sender)) this.last_sender = save_data.last_sender;
        if (save_data?.self_prompt && settings.enable_self_prompt !== false) {
            if (init_message && save_data.self_prompting_state === 1) {
                // Stage context without compressing before the saved goal state is restored.
                this.history.turns.push({ role: 'system', content: init_message });
            }
            await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
        }
        // Restoring the saved goal must precede any maintenance save of the loaded summary.
        void this.history.compactSummaryIfNeeded('startup');
        // Previous peer dialogue remains in history. A new process has no active
        // IPC conversation, so don't fabricate a fresh incoming request on restart.
        if (init_message && !this.self_prompter.isActive()) {
            await this.handleMessage('system', init_message, 2);
        }
    }

    checkAllPlayersPresent() {
        if (!this.task || !this.task.agent_names) {
          return;
        }

        const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        this.actions?.interruptCurrent();
        this.bot.interrupt_code = true;
        this.bot.stopDigging();
        const collection = this.bot.collectBlock.cancelTask();
        collection?.catch(error => console.warn('Collection cancellation:', error.message));
        stopNavigation(this.bot);
        this.bot.pvp.stop();
        this.bot.deactivateItem?.();
        if (this.bot.currentWindow) this.bot.closeWindow(this.bot.currentWindow);
        return collection;
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.shut_up = true;
        this.idle_wakeup?.suspend('explicit-silence');
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    async handleMessage(source, message, max_responses=null, options={}) {
        const endDecision = this.idle_wakeup?.beginDecision();
        try {
            return await Agent.prototype._handleMessage.call(this, source, message, max_responses, options);
        } finally {
            endDecision?.();
        }
    }

    async _handleMessage(source, message, max_responses=null, options={}) {
        const responseEpoch = this.responseEpoch;
        await this.checkTaskDone();
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
        }
        if (max_responses === -1) {
            max_responses = Infinity;
        }

        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = convoManager.isOtherAgent(source);

        if (!self_prompt && !from_other_bot) { // from user, check for forced commands
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                this.history.recordEvent?.('forced-command', {source, content: message, command: user_command_name});
                if (!commandExists(user_command_name)) {
                    this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
                    return false;
                }
                this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                if (user_command_name === '!newAction') {
                    // all user-initiated commands are ignored by the bot except for this one
                    // add the preceding message to the history to give context for newAction
                    this.history.add(source, message);
                }
                let execute_res = await executeCommand(this, message);
                this.history.recordEvent?.('forced-command-result', {source, command: user_command_name, content: execute_res || ''});
                if (execute_res) 
                    this.routeResponse(source, execute_res);
                return true;
            }
        }

        if (from_other_bot)
            this.last_sender = source;

        // Now translate the message
        message = await handleEnglishTranslation(message);
        console.log('received message from', source, ':', message);

        const checkInterrupt = () => responseEpoch !== this.responseEpoch || options.deferResponse?.() || (!options.idleWakeup && this.self_prompter.shouldInterrupt(self_prompt)) || this.shut_up || (options.idleWakeup && this.idle_wakeup?.suspended) || convoManager.responseScheduledFor(source);
        
        let roundId = this.history.beginRound?.({source, content: message});
        try {
        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            const MAX_LOG = 500;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = 'Recent behaviors log: \n' + behavior_log;
            const pending = this.history.add('system', behavior_log, {roundId});
            if (from_other_bot) void pending.catch(error => console.error('Peer context summary failed:', error.message));
            else await pending;
        }

        // Handle other user messages
        const contextAdded = this.history.add(source, message, {roundId});
        if (from_other_bot) void contextAdded.catch(error => console.error('Peer context summary failed:', error.message));
        else await contextAdded;
        this.history.save();

        for (let i=0; i<max_responses; i++) {
            if (i > 0) {
                this.history.endRound?.(roundId);
                roundId = this.history.beginRound?.({source, content: message});
            }
            if (checkInterrupt()) break;
            let history = this.history.getHistory({roundId});
            let res = await this.prompter.promptConvo(history, {priority: from_other_bot, canRequest: () => !checkInterrupt()});
            if (checkInterrupt()) break;

            console.log(`${this.name} full response to ${source}: ""${res}""`);

            if (isModelFailureText(res)) {
                this.history.recordEvent?.('model-error-text-suppressed', {content: res});
                break;
            }

            if (res.trim().length === 0) {
                console.warn('no response')
                break; // empty response ends loop
            }

            let command_name = containsCommand(res);

            if (command_name) { // contains query or command
                res = truncCommandMessage(res); // everything after the command is ignored
                this.history.add(this.name, res, {roundId});
                
                if (!commandExists(command_name)) {
                    this.history.add('system', `Command ${command_name} does not exist.`, {roundId});
                    console.warn('Agent hallucinated command:', command_name)
                    continue;
                }

                if (checkInterrupt()) break;
                this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                if (getCommand(command_name).modelOnly) {
                    // Personal memory tools never broadcast their arguments to game chat or peers.
                    const pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    if (pre_message) this.routeResponse(source, pre_message);
                }
                else if (settings.show_command_syntax === "full") {
                    this.routeResponse(source, res);
                }
                else if (settings.show_command_syntax === "shortened") {
                    // show only "used !commandname"
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    let chat_message = `*used ${command_name.substring(1)}*`;
                    if (pre_message.length > 0)
                        chat_message = `${pre_message}  ${chat_message}`;
                    this.routeResponse(source, chat_message);
                }
                else {
                    // no command at all
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    if (pre_message.trim().length > 0)
                        this.routeResponse(source, pre_message);
                }

                let execute_res = await executeCommand(this, res, {origin: 'model'});

                console.log('Agent executed:', command_name, 'and got:', execute_res);
                used_command = true;

                if (execute_res)
                    this.history.add('system', execute_res, {roundId});
                else
                    break;
            }
            else { // conversation response
                this.history.add(this.name, res, {roundId});
                this.routeResponse(source, res);
                break;
            }
            
            this.history.save();
        }

        return used_command;
        } finally {this.history.endRound?.(roundId);}
    }

    async routeResponse(to_player, message) {
        if (this.shut_up) return;
        // Autonomous output stays public. Only a reply whose source is a peer
        // belongs to that peer's conversation; old last_sender cannot hijack it.

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            // if we're in an ongoing conversation with the other bot, send the response to it
            // startConversation delivers its own message argument; sending the whole
            // tool call too would duplicate the request and expose a command for self.
            if (containsCommand(message) === '!startConversation') return;
            convoManager.sendToBot(to_player, message);
        }
        else {
            // otherwise, use open chat
            this.openChat(message);
            // note that to_player could be another bot, but if we get here the conversation has ended
        }
    }

    async openChat(message) {
        let to_translate = message;
        let remaining = '';
        let command_name = containsCommand(message);
        let translate_up_to = command_name ? message.indexOf(command_name) : -1;
        if (translate_up_to != -1) { // don't translate the command
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        message = (await handleTranslation(to_translate)).trim() + " " + remaining;
        // Minecraft rejects control characters (including the model's "nothing to say"
        // tab) and section signs; a visible IPC echo must never kick the game client.
        message = message.replace(/[\u0000-\u001f\u007f\u00a7]/g, ' ').trim();
        if (!message) return;

        if (settings.only_chat_with.length > 0 && !settings.reply_publicly) {
            for (let username of settings.only_chat_with) {
                this.bot.whisper(username, message);
            }
        }
        else {
            if (settings.speak) {
                speak(to_translate, this.prompter.profile.speak_model);
            }
            if (settings.chat_ingame) {this.bot.chat(message);}
            sendOutputToServer(this.name, message);
        }
    }

    startEvents() {
        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0)
            this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000)
            this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
            this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000)
            this.bot.emit('midnight');
        });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
            }
            prev_health = this.bot.health;
        });
        // Logging callbacks
        this.bot.on('error' , (err) => {
            console.error('Error event!', err);
        });
        // Use connection handler for runtime disconnects
        this.bot.on('end', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('death', () => {
            this.actions.cancelResume();
            this.actions.stop();
        });
        this.bot.on('kicked', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                let death_pos = this.bot.entity.position;
                this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                let death_pos_text = null;
                if (death_pos) {
                    death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.z.toFixed(2)}`;
                }
                let dimention = this.bot.game.dimension;
                this.handleMessage('system', `You died at position ${death_pos_text || "unknown"} in the ${dimention} dimension with the final message: '${message}'. Your place of death is saved as 'last_death_position' if you want to return. Previous actions were stopped and you have respawned.`);
            }
        });
        this.bot.on('idle', () => {
            this.bot.clearControlStates();
            this.bot.pathfinder.stop(); // clear any lingering pathfinder
            this.bot.modes.unPauseAll();
            setTimeout(() => {
                if (this.isIdle()) {
                    this.actions.resumeAction();
                }
            }, 1000);
        });

        // Init NPC controller
        this.npc.init();

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        setTimeout(async () => {
            while (true) {
                let start = Date.now();
                await this.update(start - last);
                let remaining = INTERVAL - (Date.now() - start);
                if (remaining > 0) {
                    await new Promise((resolve) => setTimeout(resolve, remaining));
                }
                last = start;
            }
        }, INTERVAL);

        this.bot.emit('idle');
    }

    async update(delta) {
        await this.bot.modes.update();
        this.self_prompter.update(delta);
        await this.checkTaskDone();
    }

    isIdle() {
        return !this.actions.executing;
    }
    

    reportStage(stage) {
        if (process.connected) process.send({ type: 'agent-stage', stage });
    }

    async shutdownForRestart() {
        this._shuttingDown = true;
        this.idle_wakeup?.stop();
        this._disconnectHandled = true;
        this.shut_up = true;
        this.responseEpoch++;
        // Save the desired loop state before stopping execution, so restart can resume it.
        if (this._memoryReady) await this.history.save();
        if (this.self_prompter) this.self_prompter.interrupt = true;
        try { this.requestInterrupt(); } catch { /* plugins may not be ready during startup */ }
        try { this.bot?.quit('Restarting agent'); } catch { /* already disconnected */ }
        await new Promise(resolve => setTimeout(resolve, 350));
    }

    cleanKill(msg='Killing agent process...', code=1) {
        this.history.add('system', msg);
        this.bot.chat(code > 1 ? 'Restarting.': 'Exiting.');
        this.history.save();
        process.exit(code);
    }
    async checkTaskDone() {
        if (this.task.data) {
            let res = this.task.isDone();
            if (res) {
                await this.history.add('system', `Task ended with score : ${res.score}`);
                await this.history.save();
                // await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 second for save to complete
                console.log('Task finished:', res.message);
                this.killAll();
            }
        }
    }

    killAll() {
        serverProxy.shutdown();
    }
}
