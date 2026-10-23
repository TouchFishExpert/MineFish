import { readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {withSharedSystemProfile} from '../utils/system_profile.js';

const spec = JSON.parse(readFileSync(new URL('./public/settings_spec.json', import.meta.url), 'utf8'));
function settingsPath(name) {
    if (!/^[a-zA-Z0-9_]{1,16}$/.test(name)) throw new Error('机器人名称无效');
    return path.resolve('bots', name, 'console-settings.json');
}

export function mergeAgentSettings(current, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('配置必须为 JSON 对象');
    const next = structuredClone(current);
    for (const [key, value] of Object.entries(patch)) {
        if (!Object.hasOwn(spec, key)) continue;
        const rule = spec[key];
        if (key === 'task' && (value === '' || value === null)) { next.task = null; continue; }
        const valid = rule.type === 'array' ? Array.isArray(value) : rule.type === 'object'
            ? value !== null && typeof value === 'object' && !Array.isArray(value)
            : typeof value === rule.type && (rule.type !== 'number' || Number.isFinite(value));
        if (!valid || (rule.options && !rule.options.includes(value))) throw new Error(`${rule.label || key}的格式或取值无效`);
        next[key] = structuredClone(value);
    }
    if (next.profile?.name !== current.profile?.name) throw new Error('请使用新建机器人功能更改账号名称');
    for (const key of ['port', 'spawn_timeout', 'max_messages', 'num_examples', 'max_commands', 'relevant_docs_count', 'code_timeout_mins']) {
        const value = next[key];
        if (value === undefined) continue;
        const minimum = ['port', 'max_commands', 'relevant_docs_count', 'code_timeout_mins'].includes(key) ? -1 : key === 'num_examples' ? 0 : 1;
        if (!Number.isInteger(value) || value < minimum || (key === 'port' && (value > 65535 || value === 0)) || (key === 'max_messages' && value < 6))
            throw new Error(`${spec[key].label}超出有效范围`);
    }
    if (!next.host?.trim()) throw new Error('服务器地址不能为空');
    if (!next.only_chat_with?.every(name => typeof name === 'string') || !next.blocked_actions?.every(action => typeof action === 'string'))
        throw new Error('玩家名单和禁用动作必须是字符串数组');
    next.profile = withSharedSystemProfile(next.profile);
    return next;
}

export function saveAgentSettings(settings) {
    settings = {...settings, profile: withSharedSystemProfile(settings.profile)};
    const file = settingsPath(settings.profile.name);
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    const overrides = Object.fromEntries(Object.keys(spec).filter(key => Object.hasOwn(settings, key)).map(key => [key, settings[key]]));
    writeFileSync(temporary, JSON.stringify(overrides, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (existsSync(file)) {
        const backups = path.join(path.dirname(file), 'settings-backups');
        mkdirSync(backups, { recursive: true });
        copyFileSync(file, path.join(backups, `${Date.now()}-${randomUUID()}.json`));
    }
    renameSync(temporary, file);
}

export function loadAgentSettings(settings) {
    const file = settingsPath(settings.profile.name);
    if (!existsSync(file)) return {...structuredClone(settings), profile: withSharedSystemProfile(settings.profile)};
    return mergeAgentSettings(settings, JSON.parse(readFileSync(file, 'utf8')));
}
