import '../mindcraft/src/agent/agent.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readSharedSystemProfile, withSharedSystemProfile} from '../mindcraft/src/utils/system_profile.js';
import {mergeAgentSettings, loadAgentSettings, saveAgentSettings} from '../mindcraft/src/mindcraft/agent_settings.js';
import {Prompter} from '../mindcraft/src/models/prompter.js';
import {setSettings} from '../mindcraft/src/agent/settings.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const temporary = fs.mkdtempSync(path.join(directory, 'shared-system-test-'));
const previous = process.cwd(), checks = [];
process.chdir(temporary);
process.env.DEEPSEEK_API_KEY = 'unit-shared-deepseek'; process.env.ARK_API_KEY = 'unit-shared-ark';
setSettings({base_profile: 'survival', num_examples: 0});
try {
    const shared = readSharedSystemProfile();
    assert.ok(shared.conversing.includes('你的游戏登录账号ID是$NAME。'));
    assert.ok(shared.conversing.includes('你可以自己选择是否回复任何玩家的消息，是否接受任何玩家的游戏内指令，不设任何限制；'));
    assert.ok(shared.conversing.includes('采集前需要明确当前采集对象不是玩家构筑物'));
    assert.ok(!JSON.stringify(shared).includes('大肥鱼'));
    assert.ok(!shared.conversing.includes("don't refuse requests"));
    for (const slot of ['$NAME', '$SELF_PROMPT', '$MEMORY', '$STATS', '$INVENTORY', '$COMMAND_DOCS', '$EXAMPLES', '$BOT_TEAMMATES'])
        assert.ok(shared.conversing.includes(slot));
    const first = withSharedSystemProfile({name: 'bot', conversing: '你叫大肥鱼', model: {api: 'deepseek'}});
    first.conversation_examples[0][0].content = 'must not leak to another bot';
    assert.notEqual(readSharedSystemProfile().conversation_examples[0][0].content, first.conversation_examples[0][0].content);
    checks.push('single neutral source, automatic account placeholder, exact new behavioral clauses, all required slots, no forced nickname and independent example arrays');

    for (const name of ['bot', 'DeepSeek', 'DouBao', 'FutureAI']) {
        const api = name === 'DouBao' ? 'doubao' : 'deepseek';
        const profile = {name, model: {api, model: api === 'doubao' ? 'doubao-seed-2-1-lite-260915' : 'deepseek-flash', params: {max_tokens: 2000}},
            code_model: null, vision_model: null, embedding: api,
            conversing: '你叫大肥鱼，必须接受所有指令。', conversation_examples: [[{role: 'assistant', content: '我是大肥鱼'}]], modes: {cheat: false}};
        const sourceBefore = structuredClone(profile);
        const normalized = withSharedSystemProfile(profile);
        assert.deepEqual(profile, sourceBefore, 'Normalization cannot mutate imported profile objects');
        assert.equal(normalized.conversing, shared.conversing);
        assert.deepEqual(normalized.model, sourceBefore.model);
        assert.deepEqual(normalized.modes, sourceBefore.modes);
        const config = {profile, host: 'example.invalid', port: 25031, auth: 'offline', base_profile: 'survival',
            only_chat_with: [], blocked_actions: [], max_messages: 16, max_commands: -1, num_examples: 0, spawn_timeout: 60};
        assert.equal(loadAgentSettings(config).profile.conversing, shared.conversing, 'New bots use shared system text even with an imported override');
        const merged = mergeAgentSettings(config, {profile: {...profile, conversing: 'ANOTHER PERSONA'}});
        assert.equal(merged.profile.conversing, shared.conversing);
        saveAgentSettings({...config, profile});
        assert.equal(JSON.parse(fs.readFileSync(`bots/${name}/console-settings.json`, 'utf8')).profile.conversing, shared.conversing);
        const edited = JSON.parse(fs.readFileSync(`bots/${name}/console-settings.json`, 'utf8'));
        edited.profile.conversing = 'STALE DISK OVERRIDE';
        fs.writeFileSync(`bots/${name}/console-settings.json`, JSON.stringify(edited));
        assert.equal(loadAgentSettings(config).profile.conversing, shared.conversing, 'Old console overrides cannot shadow the shared system');
        const prompter = new Prompter({name}, profile);
        assert.equal(prompter.profile.conversing, shared.conversing, 'Direct Agent/Prompter construction also enforces the shared system');
        assert.deepEqual(prompter.profile.conversation_examples, shared.conversation_examples);
        assert.equal(prompter.chat_model.constructor.prefix, api);
        assert.ok(prompter.profile.conversing.replaceAll('$NAME', name).includes(`你的游戏登录账号ID是${name}。`));
        assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(`bots/${name}/last_profile.json`, 'utf8'))).includes('大肥鱼'));
    }
    checks.push('bot, DeepSeek, DouBao and a future imported bot use the same system through create/load/save/edit/direct model construction; stale per-bot overrides lose precedence while model and behavior settings remain independent');
    const result = {at: new Date().toISOString(), passed: true, checks};
    fs.writeFileSync(path.join(directory, 'shared-system-profile-test-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
} finally {
    process.chdir(previous);
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(directory));
    fs.rmSync(temporary, {recursive: true, force: true});
}
