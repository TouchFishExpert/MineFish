import * as skills from '../library/skills.js';
import settings from '../settings.js';
import convoManager from '../conversation.js';
import { teleportPlayerToCoordinates, teleportPlayerToPlayer } from '../library/teleport.js';
import {setCoreSummary} from '../core_summary.js';
import {leaveBedOrVehicle} from '../library/riding.js';


function runAsAction (actionFn, resume = false, timeout = -1, skipIf = null) {
    let actionLabel = null;  // Will be set on first use
    const pending = new WeakSet();
    
    const wrappedAction = async function (agent, ...args) {
        // Set actionLabel only once, when the action is first created
        if (!actionLabel) {
            const actionObj = actionsList.find(a => a.perform === wrappedAction);
            actionLabel = actionObj.name.substring(1); // Remove the ! prefix
        }

        // Preflight runs before the action manager can cancel the old action.
        // Reserve synchronously, including the interval before its slot is acquired.
        const ignored = skipIf?.(agent, pending.has(agent));
        if (ignored) {
            console.log(`[Action] ignored duplicate ${actionLabel}: ${ignored}`);
            return ignored;
        }
        if (skipIf) pending.add(agent);
        try {
            const actionFnWithAgent = async () => {
                // Diagnostic parameters only; the action manager still owns execution.
                if (agent.actions.current) agent.actions.current.arguments = args.slice(0, 8).map(value =>
                    typeof value === 'string' ? value.slice(0, 160) : ['number', 'boolean'].includes(typeof value) ? value : null);
                await actionFn(agent, ...args);
            };
            const code_return = await agent.actions.runAction(`action:${actionLabel}`, actionFnWithAgent, { timeout, resume });
            if (code_return.interrupted && !code_return.timedout)
                return;
            return code_return.message;
        } finally {if (skipIf) pending.delete(agent);}
    }

    return wrappedAction;
}

export const actionsList = [
    {
        name: '!setCoreSummary',
        modelOnly: true,
        nonWorldAction: true,
        description: '自主记录你认为最珍贵、最重要、最有意义、最有情感、最想记住的真实记忆。替换核心摘要全文，最多1000字符；可修改、删减，空字符串表示清空。使用系统提示中的当前修订号；冲突时先读取最新内容再合并。此操作不停止游戏动作。',
        params: {
            text: {type: 'string', description: '完整的新核心摘要，最多1000字符；空字符串可删除全部。'},
            base_revision: {type: 'string', description: '当前核心摘要修订号，可从系统提示或 coreSummary 查询中获得。'}
        },
        perform(agent, text, revision) {
            const result = setCoreSummary(agent, text, revision);
            if (result.error) return `核心摘要保存失败：${result.error}；原内容保留。${result.current ? `最新核心摘要：${result.current.text}；修订号：${result.current.revision}` : ''}`;
            return `核心摘要${result.unchanged ? '内容未变化' : text ? '已保存' : '已清空'}，${result.current.text.length}/${result.current.limit}字符；当前修订号：${result.current.revision}`;
        }
    },
    {
        name: '!newAction',
        description: 'Perform new and unknown custom behaviors that are not available as a command.', 
        params: {
            'prompt': { type: 'string', description: 'A natural language prompt to guide code generation. Make a detailed step-by-step plan.' }
        },
        perform: async function(agent, prompt) {
            // just ignore prompt - it is now in context in chat history
            if (!settings.allow_insecure_coding) { 
                agent.openChat('newAction is disabled. Enable with allow_insecure_coding=true in settings.js');
                return "newAction not allowed! Code writing is disabled in settings. Notify the user.";
            }
            let result = "";
            const actionFn = async () => {
                try {
                    result = await agent.coder.generateCode(agent.history);
                } catch (e) {
                    result = 'Error generating code: ' + e.toString();
                }
            };
            await agent.actions.runAction('action:newAction', actionFn, {timeout: settings.code_timeout_mins});
            return result;
        }
    },
    {
        name: '!stop',
        description: 'Force stop all actions and commands that are currently executing.',
        perform: async function (agent) {
            // Invalidate replies already being generated, then stop both goal and action.
            agent.responseEpoch = (agent.responseEpoch || 0) + 1;
            agent.idle_wakeup?.suspend('explicit-stop');
            await agent.self_prompter.stop();
            convoManager.forceEndCurrentConversation();
            agent.clearBotLogs();
            agent.actions.cancelResume();
            agent.bot.emit('idle');
            await agent.history.save();
            return '自主循环和当前动作已停止。';
        }
    },
    {
        name: '!stfu',
        description: 'Stop all chatting and self prompting, but continue current action.',
        perform: async function (agent) {
            agent.openChat('Shutting up.');
            agent.shutUp();
            return;
        }
    },
    {
        name: '!restart',
        description: 'Restart the agent process.',
        perform: async function (agent) {
            agent.cleanKill();
        }
    },
    {
        name: '!clearChat',
        description: 'Clear the chat history.',
        perform: async function (agent) {
            agent.history.clear();
            return agent.name + "'s chat history was cleared, starting new conversation from scratch.";
        }
    },
    {
        name: '!goToPlayer',
        description: 'Go to the given player.',
        params: {
            'player_name': {type: 'string', description: 'The name of the player to go to.'},
            'closeness': {type: 'float', description: 'How close to get to the player.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, closeness) => {
            await skills.goToPlayer(agent.bot, player_name, closeness);
        })
    },
    {
        name: '!teleportToPlayer',
        description: 'Teleport to a verified safe surface near a player using server-granted permission. Fails honestly if the player position, landing surface or permission is unavailable.',
        params: { 'player_name': { type: 'string', description: 'The exact Minecraft name of the player to meet.' } },
        perform: runAsAction(async (agent, player_name) => {
            await skills.teleportToPlayer(agent.bot, player_name);
        })
    },
    {
        name: '!teleportPlayerToCoordinates',
        description: 'Teleport one named online player to the given coordinates using server-granted permission. Reports server confirmation or failure.',
        params: {
            'player_name': { type: 'string', description: 'Exact Minecraft name of the player to move.' },
            'x': { type: 'float', description: 'Destination X coordinate.', domain: [-29999984, 29999984] },
            'y': { type: 'float', description: 'Destination Y coordinate.', domain: [-64, 320] },
            'z': { type: 'float', description: 'Destination Z coordinate.', domain: [-29999984, 29999984] },
        },
        perform: runAsAction(async (agent, player_name, x, y, z) => {
            await teleportPlayerToCoordinates(agent.bot, player_name, x, y, z);
        })
    },
    {
        name: '!teleportPlayerToPlayer',
        description: 'Teleport one named online player to another named online player using server-granted permission.',
        params: {
            'player_name': { type: 'string', description: 'Exact Minecraft name of the player to move.' },
            'destination_player': { type: 'string', description: 'Exact Minecraft name of the destination player.' },
        },
        perform: runAsAction(async (agent, player_name, destination_player) => {
            await teleportPlayerToPlayer(agent.bot, player_name, destination_player);
        })
    },
    {
        name: '!followPlayer',
        description: 'Endlessly follow the given player.',
        params: {
            'player_name': {type: 'string', description: 'name of the player to follow.'},
            'follow_dist': {type: 'float', description: 'The distance to follow from.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, follow_dist) => {
            await skills.followPlayer(agent.bot, player_name, follow_dist);
        }, true)
    },
    {
        name: '!goToCoordinates',
        description: 'Go to the given x, y, z location.',
        params: {
            'x': {type: 'float', description: 'The x coordinate.', domain: [-Infinity, Infinity]},
            'y': {type: 'float', description: 'The y coordinate.', domain: [-64, 320]},
            'z': {type: 'float', description: 'The z coordinate.', domain: [-Infinity, Infinity]},
            'closeness': {type: 'float', description: 'How close to get to the location.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, x, y, z, closeness) => {
            await skills.goToPosition(agent.bot, x, y, z, closeness);
        })
    },
    {
        name: '!searchForBlock',
        description: 'Find and go to the nearest block of a given type in a given range.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the block. Minimum 32.', domain: [10, 512] }
        },
        perform: runAsAction(async (agent, block_type, range) => {
            if (range < 32) {
                skills.log(agent.bot, `Minimum search range is 32.`);
                range = 32;
            }
            await skills.goToNearestBlock(agent.bot, block_type, 4, range);
        })
    },
    {
        name: '!searchForEntity',
        description: 'Find and go to the nearest entity of a given type in a given range.',
        params: {
            'type': { type: 'string', description: 'The type of entity to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the entity.', domain: [32, 512] }
        },
        perform: runAsAction(async (agent, entity_type, range) => {
            await skills.goToNearestEntity(agent.bot, entity_type, 4, range);
        })
    },
    {
        name: '!moveAway',
        description: 'Move away from the current location in any direction by a given distance.',
        params: {'distance': { type: 'float', description: 'The distance to move away.', domain: [0, Infinity] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.moveAway(agent.bot, distance);
        })
    },
    {
        name: '!rememberHere',
        description: 'Save the current location with a given name.',
        params: {'name': { type: 'string', description: 'The name to remember the location as.' }},
        perform: async function (agent, name) {
            const pos = agent.bot.entity.position;
            agent.memory_bank.rememberPlace(name, pos.x, pos.y, pos.z);
            return `Location saved as "${name}".`;
        }
    },
    {
        name: '!goToRememberedPlace',
        description: 'Go to a saved location.',
        params: {'name': { type: 'string', description: 'The name of the location to go to.' }},
        perform: runAsAction(async (agent, name) => {
            const pos = agent.memory_bank.recallPlace(name);
            if (!pos) {
            skills.log(agent.bot, `No location named "${name}" saved.`);
            return;
            }
            await skills.goToPosition(agent.bot, pos[0], pos[1], pos[2], 1);
        })
    },
    {
        name: '!givePlayer',
        description: 'Give the specified item to the given player.',
        params: { 
            'player_name': { type: 'string', description: 'The name of the player to give the item to.' }, 
            'item_name': { type: 'ItemName', description: 'The name of the item to give.' },
            'num': { type: 'int', description: 'The number of items to give.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, player_name, item_name, num) => {
            await skills.giveToPlayer(agent.bot, item_name, player_name, num);
        })
    },
    {
        name: '!consume',
        description: 'Eat/drink the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to consume.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.consume(agent.bot, item_name);
        })
    },
    {
        name: '!equip',
        description: 'Equip the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to equip.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.equip(agent.bot, item_name);
        })
    },
    {
        name: '!putInChest',
        description: 'Put the given item in the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to put in the chest.' },
            'num': { type: 'int', description: 'The number of items to put in the chest.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.putInChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!takeFromChest',
        description: 'Take the given items from the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to take.' },
            'num': { type: 'int', description: 'The number of items to take.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.takeFromChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!viewChest',
        description: 'View the items/counts of the nearest chest.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.viewChest(agent.bot);
        })
    },
    {
        name: '!discard',
        description: 'Discard the given item from the inventory.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to discard.' },
            'num': { type: 'int', description: 'The number of items to discard.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            const start_loc = agent.bot.entity.position;
            await skills.moveAway(agent.bot, 5);
            await skills.discard(agent.bot, item_name, num);
            await skills.goToPosition(agent.bot, start_loc.x, start_loc.y, start_loc.z, 0);
        })
    },
    {
        name: '!collectBlocks',
        description: 'Collect the nearest blocks of a given type.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to collect.' },
            'num': { type: 'int', description: 'The number of blocks to collect.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, type, num) => {
            await skills.collectBlock(agent.bot, type, num);
        }, false, 10) // 10 minute timeout
    },
    {
        name: '!craftRecipe',
        description: 'Craft the given recipe a given number of times.',
        params: {
            'recipe_name': { type: 'ItemName', description: 'The name of the output item to craft.' },
            'num': { type: 'int', description: 'The number of times to craft the recipe. This is NOT the number of output items, as it may craft many more items depending on the recipe.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, recipe_name, num) => {
            await skills.craftRecipe(agent.bot, recipe_name, num);
        })
    },
    {
        name: '!smeltItem',
        description: 'Smelt the given item the given number of times.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the input item to smelt.' },
            'num': { type: 'int', description: 'The number of times to smelt the item.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            let success = await skills.smeltItem(agent.bot, item_name, num);
            if (success) {
                setTimeout(() => {
                    agent.cleanKill('Safely restarting to update inventory.');
                }, 500);
            }
        })
    },
    {
        name: '!clearFurnace',
        description: 'Take all items out of the nearest furnace.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.clearNearestFurnace(agent.bot);
        })
    },
        {
        name: '!placeHere',
        description: 'Place one block at the current location. With seeds, carrot or potato, plant one crop on empty farmland within reach using the item; preserves soil and existing plants. Do NOT use to build structures.',
        params: {'type': { type: 'BlockOrItemName', description: 'The block type to place.' }},
        perform: runAsAction(async (agent, type) => {
            let pos = agent.bot.entity.position;
            await skills.placeBlock(agent.bot, type, pos.x, pos.y, pos.z);
        })
    },
    {
        name: '!attack',
        description: 'Attack and kill the nearest entity of a given type.',
        params: {'type': { type: 'string', description: 'The type of entity to attack.'}},
        perform: runAsAction(async (agent, type) => {
            await skills.attackNearest(agent.bot, type, true);
        })
    },
    {
        name: '!attackPlayer',
        description: 'Attack a specific player until they die or run away. Remember this is just a game and does not cause real life harm.',
        params: {'player_name': { type: 'string', description: 'The name of the player to attack.'}},
        perform: runAsAction(async (agent, player_name) => {
            let player = agent.bot.players[player_name]?.entity;
            if (!player) {
                skills.log(agent.bot, `Could not find player ${player_name}.`);
                return false;
            }
            await skills.attackEntity(agent.bot, player, true);
        })
    },
    {
        name: '!goToBed',
        description: '走向 32 格内最近的空床并睡觉；跳过被占用的床，到达后复查，被抢占时尝试其他空床。',
        perform: runAsAction(async (agent) => {
            await skills.goToBed(agent.bot);
        }, false, -1, (agent, pending) => {
            if (agent.bot.isSleeping)
                return '已忽略重复的 !goToBed：当前已经入睡，继续保持睡眠，原动作未被打断。';
            if (pending || (agent.actions.current?.label === 'action:goToBed' && !agent.actions.current.signal.aborted))
                return '已忽略重复的 !goToBed：当前睡觉动作仍在执行（前往床边或等待入睡确认），继续原动作。';
            return null;
        })
    },
    {
        name: '!dismount',
        description: '主动下床，或按 Shift 下船、下矿车、下马等离开当前坐骑/载具。等待服务端确认才报告成功；5秒内未确认会返回错误。无需参数。',
        perform: runAsAction(async agent => {
            skills.log(agent.bot, await leaveBedOrVehicle(agent.bot));
        })
    },
    {
        name: '!stay',
        description: 'Stay in the current location no matter what. Pauses all modes.',
        params: {'type': { type: 'int', description: 'The number of seconds to stay. -1 for forever.', domain: [-1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, seconds) => {
            await skills.stay(agent.bot, seconds);
        })
    },
    {
        name: '!setMode',
        description: 'Set a mode to on or off. A mode is an automatic behavior that constantly checks and responds to the environment.',
        params: {
            'mode_name': { type: 'string', description: 'The name of the mode to enable.' },
            'on': { type: 'boolean', description: 'Whether to enable or disable the mode.' }
        },
        perform: async function (agent, mode_name, on) {
            const modes = agent.bot.modes;
            if (!modes.exists(mode_name))
            return `Mode ${mode_name} does not exist.` + modes.getDocs();
            if (modes.isOn(mode_name) === on)
            return `Mode ${mode_name} is already ${on ? 'on' : 'off'}.`;
            modes.setOn(mode_name, on);
            return `Mode ${mode_name} is now ${on ? 'on' : 'off'}.`;
        }
    },
    {
        name: '!goal',
        description: 'Set a goal prompt to endlessly work towards with continuous self-prompting.',
        params: {
            'selfPrompt': { type: 'string', description: 'The goal prompt.' },
        },
        perform: async function (agent, prompt) {
            if (settings.enable_self_prompt === false) return '首版已关闭无限自主目标，请逐条下达具体指令。';
            agent.idle_wakeup?.resume();
            if (convoManager.activePeerRequests > 0) {
                agent._conversationGoalState = 1;
                agent.self_prompter.setPromptPaused(prompt);
            }
            else {
                agent.self_prompter.start(prompt);
            }
        }
    },
    {
        name: '!endGoal',
        description: 'Call when you have accomplished your goal. It will stop self-prompting and the current action. ',
        perform: async function (agent) {
            agent.self_prompter.stop();
            return 'Self-prompting stopped.';
        }
    },
    {
        name: '!showVillagerTrades',
        description: 'Show trades of a specified villager.',
        params: {'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' }},
        perform: runAsAction(async (agent, id) => {
            await skills.showVillagerTrades(agent.bot, id);
        })
    },
    {
        name: '!tradeWithVillager',
        description: 'Trade with a specified villager.',
        params: {
            'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' },
            'index': { type: 'int', description: 'The index of the trade you want executed (1-indexed).', domain: [1, Number.MAX_SAFE_INTEGER] },
            'count': { type: 'int', description: 'How many times that trade should be executed.', domain: [1, Number.MAX_SAFE_INTEGER] },
        },
        perform: runAsAction(async (agent, id, index, count) => {
            await skills.tradeWithVillager(agent.bot, id, index, count);
        })
    },
    {
        name: '!startConversation',
        description: '向另一在线机器人发送消息并开始协作会话；目标使用游戏账号ID。普通公开发言也能被队友看见，但需要对方回复或协作时用此工具。',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to send the message to.' },
            'message': { type: 'string', description: 'The message to send.' },
        },
        perform: async function (agent, player_name, message) {
            if (!convoManager.isOtherAgent(player_name))
                return player_name + ' is not a bot, cannot start conversation.';
            if (convoManager.inConversation() && !convoManager.inConversation(player_name)) 
                convoManager.forceEndCurrentConversation();
            else if (convoManager.inConversation(player_name)) {
                const delivered = await convoManager.sendToBot(player_name, message);
                return delivered?.error;
            }
            const delivered = await convoManager.startConversation(player_name, message);
            return delivered?.error;
        }
    },
    {
        name: '!endConversation',
        description: 'End the conversation with the given bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to end the conversation with.' }
        },
        perform: async function (agent, player_name) {
            if (!convoManager.inConversation(player_name))
                return `Not in conversation with ${player_name}.`;
            // The normal response route already sends this command; forced human commands do not.
            await convoManager.sendToBot(player_name, `!endConversation("${player_name}")`, false, false);
            convoManager.endConversation(player_name);
        }
    },
    {
        name: '!lookAtPlayer',
        description: 'Look at a player or look in the same direction as the player.',
        params: {
            'player_name': { type: 'string', description: 'Name of the target player' },
            'direction': {
                type: 'string',
                description: 'How to look ("at": look at the player, "with": look in the same direction as the player)',
            }
        },
        perform: async function(agent, player_name, direction) {
            if (direction !== 'at' && direction !== 'with') {
                return "Invalid direction. Use 'at' or 'with'.";
            }
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPlayer(player_name, direction);
            };
            await agent.actions.runAction('action:lookAtPlayer', actionFn);
            return result;
        }
    },
    {
        name: '!lookAtPosition',
        description: 'Look at specified coordinates.',
        params: {
            'x': { type: 'int', description: 'x coordinate' },
            'y': { type: 'int', description: 'y coordinate' },
            'z': { type: 'int', description: 'z coordinate' }
        },
        perform: async function(agent, x, y, z) {
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPosition(x, y, z);
            };
            await agent.actions.runAction('action:lookAtPosition', actionFn);
            return result;
        }
    },
    {
        name: '!digDown',
        description: '向脚下挖掘指定层数，不是查看脚下或走下楼。遇落差先返回高度、预计掉血/剩余血量和确认编号，由你决定是否继续；确认后用 !confirmDigDown。',
        params: {'distance': { type: 'int', description: 'Distance to dig down', domain: [1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.digDown(agent.bot, distance)
        })
    },
    {
        name: '!confirmDigDown',
        description: '根据刚收到的落差评估，明确选择挖开该脚下支撑并落下。使用评估给出的编号；即使预计会掉血或致死仍允许你的决定。执行前重新核对位置、血量与落点，落地即返回实际观察结果。只处理该处，不代表沿途继续挖掘。',
        params: {assessment_id: {type: 'string', description: '最近 !inspectDrop 或 !digDown 返回的 assessment UUID；不能编造。'}},
        perform: runAsAction(async (agent, assessment_id) => {
            await skills.confirmDigDown(agent.bot, assessment_id);
        })
    },
    {
        name: '!goToSurface',
        description: 'Moves the bot to the highest block above it (usually the surface).',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.goToSurface(agent.bot);
        })
    },
    {
        name: '!useOn',
        description: '右键交互。省略 entity_id 时寻找最近的指定类型；提供 entity_id 时只交互该实体，并核对类型和当前位置，失效时不会换目标。空手交互船、马或普通矿车可上乘，并等待服务端确认；先用 !entities 查询 ID。',
        params: {
            'tool_name': { type: 'string', description: 'Name of the tool to use, or "hand" for no tool.' },
            'target': { type: 'string', description: '实体类型、方块类型或 "nothing"。如 horse、minecart、spruce_boat、bamboo_raft；指定 ID 时必须与实体实际类型一致。' },
            'entity_id': { type: 'int', optional: true, default: null, domain: [0, 2147483647, '[]'],
                description: '可选，当前连接内已加载实体的精确数字 ID，来自 !entities；省略则按类型找最近实例。离开视野、重连或实体消失后应重新查询，不能编造 ID。' }
        },
        perform: runAsAction(async (agent, tool_name, target, entity_id) => {
            await skills.useToolOn(agent.bot, tool_name, target, entity_id);
        })
    },
];
