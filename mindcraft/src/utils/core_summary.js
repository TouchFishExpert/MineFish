import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const CORE_SUMMARY_LIMIT = 1000;
export function coreSummaryPath(name) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(name)) throw Error('Invalid agent name');
    return path.join('bots', name, 'core-summary.json');
}

function snapshot(text = '', version = 0, updatedAt = null, lastBackup = null) {
    return {available: true, text, version, updatedAt, lastBackup, limit: CORE_SUMMARY_LIMIT,
        revision: createHash('sha256').update(JSON.stringify([version, text])).digest('hex')};
}

// This read module is shared by the console and the agent. No console writer exists.
export function readCoreSummary(name) {
    try {
        const value = JSON.parse(readFileSync(coreSummaryPath(name), 'utf8'));
        if (typeof value.text !== 'string' || value.text.length > CORE_SUMMARY_LIMIT || !Number.isSafeInteger(value.version) || value.version < 0)
            throw Error('Invalid core summary');
        return snapshot(value.text, value.version, value.updatedAt || null, value.lastBackup || null);
    } catch (error) {
        if (error.code === 'ENOENT') return snapshot();
        return {available: false, text: '', limit: CORE_SUMMARY_LIMIT, revision: null, error: 'read-failed'};
    }
}

export function withCoreSummary(prompt, memory) {
    if (!memory.available) return `核心摘要暂时无法读取，请保留原文件，不要覆盖重建。\n\n${prompt}`;
    return `核心摘要（由你自主维护，最多${CORE_SUMMARY_LIMIT}字符）：\n` +
        `你可以把自己认为最珍贵、最重要、最有意义、最有情感、最想记住的真实经历和记忆记录在这里。由你决定什么值得珍惜；可以主动新增、修改或删除，不必等玩家要求，也不必凑满字数。它独立于短期记忆，不会被滚动压缩。不要虚构经历或把日常状态堆成流水账。\n` +
        `需要更新时使用 !setCoreSummary("完整的新正文", "当前修订号")；正文为空字符串可清空，普通修改也使用同一工具。修订号变化时先读取最新内容再合并，避免覆盖另一轮刚保存的记忆。\n` +
        `当前修订号：${memory.revision}\n当前核心摘要：\n${memory.text || '（尚未记录，是否记录以及记录什么，由你决定。）'}\n\n${prompt}`;
}
