// One queue per Prompter/bot, shared by chat, memory, coding, vision and
// embeddings. The running request owns the slot through all SDK retries.
export class ModelRequestQueue {
    constructor(owner) {
        this.owner = owner; this.pending = []; this.draining = false;
        owner.activeModelRequests = 0; owner.queuedModelRequests = 0;
        owner.maxObservedModelRequests = 0;
    }
    run(work, {isCurrent} = {}) {
        return new Promise((resolve, reject) => {
            this.pending.push({work, isCurrent, resolve, reject});
            this.owner.queuedModelRequests = this.pending.length;
            void this.drain();
        });
    }
    async drain() {
        if (this.draining) return;
        this.draining = true;
        try {
            while (this.pending.length) {
                const job = this.pending.shift();
                this.owner.queuedModelRequests = this.pending.length;
                try {
                    // Check at dispatch, not enqueue: newer input or a stop can
                    // invalidate a queued reply while another HTTP call runs.
                    if (job.isCurrent && !job.isCurrent()) {job.resolve(''); continue;}
                    this.owner.activeModelRequests = 1;
                    this.owner.maxObservedModelRequests = Math.max(this.owner.maxObservedModelRequests, 1);
                    job.resolve(await job.work());
                } catch (error) {job.reject(error);}
                finally {this.owner.activeModelRequests = 0;}
            }
        } finally {this.draining = false;}
    }
}

export function enqueueModelRequest(owner, work, options) {
    owner.modelRequestQueue ||= new ModelRequestQueue(owner);
    return owner.modelRequestQueue.run(work, options);
}
