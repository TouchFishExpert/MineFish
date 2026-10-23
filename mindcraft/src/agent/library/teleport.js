import settings from '../settings.js';

const namePattern = /^[A-Za-z0-9_]{1,16}$/;
const log = (bot, text) => { bot.output += text + '\n'; };
const positionOf = (bot, name) => name === bot.username ? bot.entity?.position : bot.players[name]?.entity?.position;
const near = (left, right) => left && right && Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z) <= 2;

function allowedPlayer(bot, name) {
    if (settings.allow_player_teleport !== true) {
        log(bot, 'Player teleport commands are disabled.');
        return false;
    }
    if (!namePattern.test(name) || (name !== bot.username && !Object.hasOwn(bot.players, name))) {
        log(bot, `Player name is invalid or not online: ${name}. Use one exact player name.`);
        return false;
    }
    return true;
}

async function issueTeleport(bot, name, command, destination, description) {
    if (bot.interrupt_code) return false;
    let confirmed = false;
    let failure = '';
    const onMessage = (text, position, json, sender) => {
        // Player chat is not authoritative command feedback.
        if (sender && sender !== '00000000-0000-0000-0000-000000000000') return;
        const message = String(text).replace(/§./g, '');
        if (/unknown.*command|incorrect.*argument|permission|not allowed|no player|not found|无权|权限|未知.*命令|不允许|找不到|玩家不存在/i.test(message)) failure = message;
        if (message.includes(name) && /^(Teleported\s|已将|已传送)/i.test(message)) confirmed = true;
    };
    bot.on('messagestr', onMessage);
    try {
        bot.chat(command);
        const start = Date.now();
        while (Date.now() - start < 5000 && !bot.interrupt_code) {
            if (failure) {
                log(bot, `Player teleport failed: ${failure}`);
                return false;
            }
            if (confirmed) {
                log(bot, `Server confirmed teleport of ${name} ${description}.`);
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        // Some servers disable command feedback; use the observed final position as a fallback.
        if (!bot.interrupt_code && near(positionOf(bot, name), destination())) {
            log(bot, `Verified ${name} is at the requested destination ${description}; no server command feedback was received.`);
            return true;
        }
        log(bot, `Teleport command for ${name} was sent but could not be confirmed. Do not claim completion.`);
        return false;
    } finally {
        bot.removeListener('messagestr', onMessage);
    }
}

export async function teleportPlayerToCoordinates(bot, playerName, x, y, z) {
    if (!allowedPlayer(bot, playerName)) return false;
    if (![x, y, z].every(Number.isFinite) || Math.abs(x) > 29999984 || Math.abs(z) > 29999984 || y < -64 || y > 320) {
        log(bot, 'Invalid teleport coordinates. Use finite numbers inside Minecraft world limits.');
        return false;
    }
    const target = { x, y, z };
    return issueTeleport(bot, playerName, `/tp ${playerName} ${x} ${y} ${z}`, () => target, `to (${x}, ${y}, ${z})`);
}

export async function teleportPlayerToPlayer(bot, playerName, destinationName) {
    if (!allowedPlayer(bot, playerName) || !allowedPlayer(bot, destinationName)) return false;
    return issueTeleport(bot, playerName, `/tp ${playerName} ${destinationName}`, () => positionOf(bot, destinationName), `to player ${destinationName}`);
}
