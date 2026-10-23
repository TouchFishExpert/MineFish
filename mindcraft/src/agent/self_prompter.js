const STOPPED = 0
const ACTIVE = 1
const PAUSED = 2
export class SelfPrompter {
    constructor(agent) {
        this.agent = agent;
        this.state = STOPPED;
        this.loop_active = false;
        this.interrupt = false;
        this.prompt = '';
        this.idle_time = 0;
        this.cooldown = 2000;
    }

    start(prompt) {
        console.log('Self-prompting started.');
        if (!prompt) {
            if (!this.prompt)
                return 'No prompt specified. Ignoring request.';
            prompt = this.prompt;
        }
        this.state = ACTIVE;
        this.agent.idle_wakeup?.resume();
        this.prompt = prompt;
        if (!this.loop_active) this.interrupt = false;
        this.startLoop();
    }

    isActive() {
        return this.state === ACTIVE;
    }

    isStopped() {
        return this.state === STOPPED;
    }

    isPaused() {
        return this.state === PAUSED;
    }

    async handleLoad(prompt, state, activate = true) {
        if (state == undefined)
            state = STOPPED;
        this.state = state;
        this.prompt = prompt;
        if (state !== STOPPED && !prompt)
            throw new Error('No prompt loaded when self-prompting is active');
        if (state === ACTIVE && activate) {
            await this.start(prompt);
        }
    }

    setPromptPaused(prompt) {
        this.prompt = prompt;
        this.state = PAUSED;
    }

    async startLoop() {
        if (this.loop_active) {
            console.warn('Self-prompt loop is already active. Ignoring request.');
            return;
        }
        console.log('starting self-prompt loop')
        this.loop_active = true;
        let no_command_count = 0;
        while (!this.interrupt) {
            const msg = `You are self-prompting with the goal: '${this.prompt}'. Your next response MUST contain a command with this syntax: !commandName. Respond:`;
            
            let used_command = await this.agent.handleMessage('system', msg, -1);
            // An incoming event may supersede this decision. It is not an idle
            // failure and must never switch an otherwise active goal to STOPPED.
            if (this.interrupt || this.state !== ACTIVE) break;
            if (!used_command) {
                no_command_count++;
            }
            else {
                no_command_count = 0;
            }
            // No round cap: an idle model backs off instead of silently losing its goal.
            const delay = used_command ? this.cooldown : Math.min(30000, this.cooldown * 2 ** Math.min(no_command_count - 1, 4));
            const until = Date.now() + delay;
            while (!this.interrupt && Date.now() < until)
                await new Promise(resolve => setTimeout(resolve, Math.min(250, until - Date.now())));
        }
        console.log('self prompt loop stopped')
        this.loop_active = false;
        this.interrupt = false;
    }

    update(delta) {
        // automatically restarts loop
        if (this.state === ACTIVE && !this.loop_active && !this.interrupt) {
            if (this.agent.isIdle())
                this.idle_time += delta;
            else
                this.idle_time = 0;

            if (this.idle_time >= this.cooldown) {
                console.log('Restarting self-prompting...');
                this.startLoop();
                this.idle_time = 0;
            }
        }
        else {
            this.idle_time = 0;
        }
    }

    async stopLoop() {
        // you can call this without await if you don't need to wait for it to finish
        if (this.interrupt)
            return;
        console.log('stopping self-prompt loop')
        this.interrupt = true;
        while (this.loop_active) {
            await new Promise(r => setTimeout(r, 500));
        }
        this.interrupt = false;
    }

    async stop(stop_action=true) {
        this.interrupt = true;
        this.state = STOPPED;
        if (stop_action)
            await this.agent.actions.stop();
        this.stopLoop();
    }

    async pause() {
        this.interrupt = true;
        await this.agent.actions.stop();
        this.stopLoop();
        this.state = PAUSED;
    }

    shouldInterrupt(is_self_prompt) { // to be called from handleMessage
        return is_self_prompt && this.interrupt;
    }

    handleUserPromptedCmd(is_self_prompt, is_action) {
        // if a user messages and the bot responds with an action, stop the self-prompt loop
        if (!is_self_prompt && is_action) {
            this.stopLoop();
            // this stops it from responding from the handlemessage loop and the self-prompt loop at the same time
        }
    }
}
