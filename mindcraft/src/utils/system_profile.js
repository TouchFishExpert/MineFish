import {readFileSync} from 'node:fs';

// One application-owned system prompt and set of command examples for every
// current/future bot. Account identity, model settings and memories stay local.
export const SHARED_SYSTEM_PROFILE_URL = new URL('../../profiles/defaults/_default.json', import.meta.url);

export function readSharedSystemProfile() {
    const defaults = JSON.parse(readFileSync(SHARED_SYSTEM_PROFILE_URL, 'utf8'));
    if (typeof defaults.conversing !== 'string' || !defaults.conversing.trim() || !defaults.conversing.includes('$NAME'))
        throw new Error('共享系统提示词无效，必须包含游戏账号占位符 $NAME');
    if (!Array.isArray(defaults.conversation_examples)) throw new Error('共享系统对话示例无效');
    return {conversing: defaults.conversing, conversation_examples: defaults.conversation_examples};
}

export function withSharedSystemProfile(profile) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('机器人配置必须为 JSON 对象');
    // Explicitly override old/imported persona prompts rather than filling only
    // missing fields. A single profile cannot shadow the shared system layer.
    return {...structuredClone(profile), ...readSharedSystemProfile()};
}
