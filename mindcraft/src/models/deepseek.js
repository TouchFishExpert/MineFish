import OpenAIApi from 'openai';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';
import {randomUUID} from 'node:crypto';
import {tracedFetch, withApiTraceContext} from '../utils/api_trace.js';
import {registerLogSecret} from '../utils/log_redaction.js';
import {ModelRequestError} from '../utils/model_failure.js';
import {selectWorkingContext} from '../agent/working_context.js';

export class DeepSeek {
    static prefix = 'deepseek';
    constructor(model_name, url, params, diagnostics = {}) {
        this.model_name = model_name;
        this.params = params;

        let config = {};

        config.baseURL = url || 'https://api.deepseek.com';
        config.apiKey = getKey('DEEPSEEK_API_KEY');
        registerLogSecret(config.apiKey);
        config.timeout = 30000;
        config.maxRetries = 1;
        if (diagnostics.fetch) config.fetch = diagnostics.fetch;

        this.openai = new OpenAIApi(config);
        this.openai.fetch = tracedFetch(this.openai.fetch.bind(this.openai), diagnostics.publish);
    }

    async sendRequest(turns, systemMessage, stop_seq='***', traceContext = {}) {
        if (Date.now() < (this.unavailableUntil || 0)) throw new ModelRequestError('DeepSeek 认证或余额错误，稍后重试。', this.unavailableStatus, this.unavailableUntil);
        if (!traceContext.purpose || ['conversation', 'coding', 'planning'].includes(traceContext.purpose)) turns = selectWorkingContext(turns);
        let messages = [{'role': 'system', 'content': systemMessage}].concat(turns.map(({role, content}) => ({role, content})));

        // Maintenance prompts must retain their system role so quoted memory is
        // data rather than an instruction competing in one merged user message.
        if (traceContext.purpose !== 'memory-compaction') messages = strictFormat(messages);

        const pack = {
            model: this.model_name || "deepseek-chat",
            messages,
            stop: stop_seq,
            ...(this.params || {}),
            ...(traceContext.purpose === 'memory-compaction' ? {response_format: {type: 'json_object'}} : {})
        };

        let res = null;
        try {
            console.log('Awaiting deepseek api response...')
            // console.log('Messages:', messages);
            let completion = await withApiTraceContext({operationId: traceContext.operationId || randomUUID(), purpose: traceContext.purpose || 'conversation'},
                () => this.openai.chat.completions.create(pack, traceContext.signal ? {signal: traceContext.signal} : undefined));
            if (completion.choices[0].finish_reason == 'length') console.warn('[DeepSeek] Output reached its configured limit.');
            console.log('Received.')
            res = completion.choices[0].message.content;
        }
        catch (err) {
            if ((err.message == 'Context length exceeded' || err.code == 'context_length_exceeded') && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq, traceContext);
            } else {
                console.error('[DeepSeek]', err.status || '', String(err.message).replaceAll(getKey('DEEPSEEK_API_KEY'), '[REDACTED]'));
                if ([401, 402].includes(err.status)) {this.unavailableStatus = err.status; this.unavailableUntil = Date.now() + 60000;}
                throw new ModelRequestError(String(err.message).replaceAll(getKey('DEEPSEEK_API_KEY'), '[REDACTED]'), err.status || null, this.unavailableUntil || null);
            }
        }
        return res;
    }

    async embed(text) {
        throw new Error('Embeddings are not supported by Deepseek.');
    }
}



