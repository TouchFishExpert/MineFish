import OpenAI from 'openai';
import {randomUUID} from 'node:crypto';
import {getKey} from '../utils/keys.js';
import {registerLogSecret, redactLog} from '../utils/log_redaction.js';
import {tracedFetch, withApiTraceContext} from '../utils/api_trace.js';
import {ModelRequestError} from '../utils/model_failure.js';
import {selectWorkingContext} from '../agent/working_context.js';

export const DOUBAO_MODEL = 'doubao-seed-2-1-lite-260915';
export const DOUBAO_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

export class Doubao {
    static prefix = 'doubao';

    constructor(model_name, url, params, diagnostics = {}) {
        this.model_name = model_name || DOUBAO_MODEL;
        this.params = {max_tokens: 2000, thinking: {type: 'disabled'}, ...params};
        const apiKey = getKey('ARK_API_KEY');
        registerLogSecret(apiKey);
        const config = {apiKey, baseURL: url || DOUBAO_BASE_URL, timeout: 30000, maxRetries: 1};
        if (diagnostics.fetch) config.fetch = diagnostics.fetch;
        this.openai = new OpenAI(config);
        this.openai.fetch = tracedFetch(this.openai.fetch.bind(this.openai), diagnostics.publish);
    }

    async sendRequest(turns, systemMessage, stop_seq = '***', traceContext = {}) {
        if (Date.now() < (this.unavailableUntil || 0))
            throw new ModelRequestError('豆包认证、权限或余额暂时不可用，请稍后重试。', this.unavailableStatus, this.unavailableUntil);
        if (!traceContext.purpose || ['conversation', 'coding', 'planning'].includes(traceContext.purpose))
            turns = selectWorkingContext(turns);
        // Keep the system role and strip local journal/round metadata. Ark accepts
        // OpenAI chat messages, including system observations between turns.
        const messages = [{role: 'system', content: systemMessage || ''},
            ...turns.map(({role, content}) => ({role, content}))];
        const request = {...this.params, model: this.model_name, messages, stream: false};
        try {
            console.log('Awaiting doubao api response...');
            const completion = await withApiTraceContext({operationId: traceContext.operationId || randomUUID(),
                purpose: traceContext.purpose || 'conversation'}, () => this.openai.chat.completions.create(request,
                traceContext.signal ? {signal: traceContext.signal} : undefined));
            const choice = completion.choices?.[0], content = choice?.message?.content;
            if (typeof content !== 'string') throw new ModelRequestError('豆包没有返回文本内容。', null);
            if (choice.finish_reason === 'length') console.warn('[Doubao] Output reached its configured limit.');
            console.log('Received doubao response.');
            // The game command protocol uses this delimiter. Apply it locally
            // instead of depending on provider-specific stop parameter support.
            const stop = typeof stop_seq === 'string' && stop_seq ? content.indexOf(stop_seq) : -1;
            return stop < 0 ? content : content.slice(0, stop);
        } catch (error) {
            const status = error.status || null;
            const message = redactLog(String(error.message || error));
            if ([401, 402, 403].includes(status)) {
                this.unavailableStatus = status; this.unavailableUntil = Date.now() + 60000;
            }
            console.error('[Doubao]', status || '', message);
            throw new ModelRequestError(message, status, this.unavailableUntil || null);
        }
    }

    async embed() {
        // Examples and SkillLibrary already fall back to word-overlap when the
        // configured chat provider has no embeddings. No extra service is called.
        throw new Error('豆包聊天模型不提供文本向量，使用词重合度回退。');
    }
}
