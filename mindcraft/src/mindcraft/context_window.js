import {readLatestConversationCall} from './log_store.js';
import {redactLog} from '../utils/log_redaction.js';

const roles = {system: '系统', user: '用户 / 工作输入', assistant: 'AI', tool: '工具结果', developer: '开发者'};
const contentText = message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
export function readContextWindow(agent, {ifCallId} = {}) {
    const call = readLatestConversationCall(agent);
    if (!call || !Array.isArray(call.request?.messages)) return {context: null};
    const messages = call.request.messages;
    const metadata = {id: call.id, agent, startedAt: call.startedAt, status: call.status,
        model: call.request.model, chars: messages.reduce((sum, message) => sum + contentText(message).length, 0),
        systemChars: messages.filter(message => message.role === 'system').reduce((sum, message) => sum + contentText(message).length, 0),
        workChars: messages.filter(message => message.role !== 'system').reduce((sum, message) => sum + contentText(message).length, 0)};
    if (ifCallId === call.id) return {unchanged: true, context: metadata};
    // Exact wire messages are the source of truth; no prompt rebuilding, model
    // request, history mutation, or extra memory compression happens on reads.
    const text = messages.map(message => {
        const extra = Object.fromEntries(Object.entries(message).filter(([key]) => !['role', 'content'].includes(key)));
        return `【${roles[message.role] || message.role}】\n${contentText(message)}${Object.keys(extra).length ? `\n${JSON.stringify(extra, null, 2)}` : ''}`;
    }).join('\n\n');
    return redactLog({context: {...metadata, text, messages}});
}
