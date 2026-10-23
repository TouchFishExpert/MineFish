export const LEGACY_MODEL_FAILURE = '模型服务暂时没有响应，请稍后再试。';
export const isModelFailureText = value => typeof value === 'string' && value.trim() === LEGACY_MODEL_FAILURE;

export class ModelRequestError extends Error {
    constructor(message, status = null, retryAt = null) {
        super(message); this.name = 'ModelRequestError'; this.status = status; this.retryAt = retryAt;
    }
}
