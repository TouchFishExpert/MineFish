const fieldsByPacket = {
    position: ['x', 'y', 'z'],
    look: ['yaw', 'pitch'],
    position_look: ['x', 'y', 'z', 'yaw', 'pitch']
};

export function prepareMovementPacket(name, data) {
    const fields = fieldsByPacket[name];
    if (!fields) return { valid: true, data };
    const invalid = fields.filter(field => !Number.isFinite(data?.[field]) ||
        (['yaw', 'pitch'].includes(field) && !Number.isFinite(Math.fround(data[field]))));
    // Mineflayer reuses its lastSent object; a delayed write must own a snapshot.
    return { valid: invalid.length === 0, invalid, data: { ...data, flags: data?.flags ? { ...data.flags } : data?.flags } };
}

export function installLookGuard(bot) {
    const install = () => {
        if (!bot.look || bot.look.movementGuard) return;
        const original = bot.look.bind(bot);
        const guarded = async (yaw, pitch, force) => {
            if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
                console.warn('[MovementGuard] Rejected invalid look input:', { yaw: String(yaw), pitch: String(pitch) });
                return;
            }
            return original(yaw, pitch, force);
        };
        guarded.movementGuard = true;
        bot.look = guarded;
    };
    bot.once('login', install);
    bot.once('spawn', install);
}
import { writeFileSync } from 'fs';


export function installPhysicsGuard(bot) {
    bot.once('spawn', () => {
        const simulate = bot.physics.simulatePlayer;
        let reported = false;
        bot.physics.simulatePlayer = (state, world) => {
            const pos = state.pos.clone();
            const vel = state.vel.clone();
            const input = { yaw: state.yaw, pitch: state.pitch, onGround: state.onGround, control: { ...state.control } };
            const result = simulate(state, world);
            if (![state.pos.x, state.pos.y, state.pos.z, state.vel.x, state.vel.y, state.vel.z].every(Number.isFinite)) {
                if (!reported) {
                    reported = true;
                    const detail = { time: new Date().toISOString(), input: { ...input, pos, vel, attributes: state.attributes }, output: { pos: state.pos, vel: state.vel }, physics: { movementSpeedAttribute: bot.physics.movementSpeedAttribute, yawSpeed: bot.physics.yawSpeed, pitchSpeed: bot.physics.pitchSpeed } };
                    const json = JSON.stringify(detail, (_, value) => typeof value === 'number' && !Number.isFinite(value) ? String(value) : value, 2);
                    console.error('[PhysicsGuard] Rejected non-finite simulation; details saved to physics-invalid.json');
                    try { writeFileSync(`./bots/${bot.username}/physics-invalid.json`, json); } catch {}
                }
                state.pos = pos;
                state.vel = vel;
            }
            return result;
        };
    });
}
