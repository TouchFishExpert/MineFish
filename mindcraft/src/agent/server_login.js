import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'node:path';

// The server's existing password login is separate from Minecraft offline auth.
export function installServerLogin(bot, options = {}) {
    const config = options.config || JSON.parse(readFileSync('./login.private.json', 'utf8').replace(/^\uFEFF/, ''));
    const accountName = options.username ?? bot.username;
    if (typeof accountName !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(accountName)) throw Error('Invalid Minecraft account name');
    const accountDirectory = path.join('bots', accountName);
    mkdirSync(accountDirectory, {recursive: true});
    let authenticated = false;
    let authMethod = null;
    let connected = true;
    let attempts = 0;
    let notices = 0;
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const redact = value => String(value).replaceAll(config.password, '[REDACTED]').replace(/sk-[a-zA-Z0-9]+/g, '[REDACTED]');
    const timer = setTimeout(() => {
        if (!authenticated) {
            console.error('[ServerLogin] Login not confirmed in 45 seconds; stopping.');
            resolveReady(false);
            bot.quit('Login not confirmed');
        }
    }, 45000);
    bot.on('messagestr', (text, position, json, sender) => {
        if (sender && sender !== '00000000-0000-0000-0000-000000000000') return;
        const clean = String(text).replace(/§./g, '');
        if (!authenticated && notices++ < 12) console.log('[ServerLogin notice] ' + redact(clean));
        if (/登[录陆]成功|登录完成|成功登录|已经登[录陆]|已登[录陆]|有效的会话|无需登录|认证成功|already logged in|already authenticated|valid session|no need to log in|successfully logged|login successful/i.test(clean)) {
            if (!authenticated) {
                authenticated = true;
                authMethod = /valid session|no need to log in|有效的会话|无需登录/i.test(clean) ? 'existing-session' : 'password-command';
                clearTimeout(timer);
                console.log('[ServerLogin] Server authentication confirmed: ' + authMethod);
                resolveReady(true);
            }
        } else if (!authenticated && /需要登录|请.*(?:\/login|\/l\b)|please.*(?:\/login|\/l\b)/i.test(clean) && attempts < 2) {
            attempts++;
            console.log('[ServerLogin] Server requested login; sending private command, attempt', attempts);
            bot.chat(config.loginCommand + ' ' + config.password);
        } else if (!authenticated && /密码错误|wrong password|incorrect password|请.*注册|\/register/i.test(clean)) {
            console.error('[ServerLogin] ' + redact(clean));
            clearTimeout(timer);
            resolveReady(false);
            bot.quit('Existing account authentication needs attention');
        }
    });
    bot.once('end', () => { clearTimeout(timer); resolveReady(false); });
    bot._client.on('declare_commands', packet => {
        const root = packet.nodes?.[packet.rootIndex ?? packet.root_index ?? 0];
        const commands = (root?.children || []).map(i => packet.nodes[i]?.extraNodeData?.name).filter(Boolean);
        writeFileSync(path.join(accountDirectory, 'server-commands.json'), JSON.stringify({time:new Date().toISOString(),commands,privilegedCommands:commands.filter(c=>['op','deop','gamemode','give','stop','ban'].includes(c))},null,2));
    });
    bot.once('login', () => {
        console.log('[Connection] username=' + bot.username);
        // Some server login prompts arrive before Mineflayer's chat plugin is injected.
        setTimeout(() => {
            if (!authenticated && attempts === 0) {
                attempts++;
                console.log('[ServerLogin] Sending existing account login command; content redacted.');
                bot.chat(config.loginCommand + ' ' + config.password);
            }
        }, 2000);
    });
    const capture = () => {
        if (!bot.entity) return;
        const p = bot.entity.position;
        const data = {
            time: new Date().toISOString(), connected, authenticated, authMethod, username: bot.username,
            uuid: bot.player?.uuid, version: bot.version, gamemode: bot.game?.gameMode,
            position: { x: p.x, y: p.y, z: p.z }, health: bot.health, food: bot.food,
            players: Object.keys(bot.players),
            ownerPosition: bot.players[config.owner]?.entity?.position,
            ownerGameMode: bot.players[config.owner]?.gamemode,
            inventory: bot.inventory?.items().map(i => ({ name: i.name, count: i.count })),
            nearbyBlocks: bot.findBlocks({matching: b => b && /_log$|_leaves$|grass_block|planks$|chest$|crafting_table/.test(b.name), maxDistance: 12, count: 30}).map(pos => ({name:bot.blockAt(pos)?.name,x:pos.x,y:pos.y,z:pos.z}))
        };
        writeFileSync(path.join(accountDirectory, 'connection-state.json'), JSON.stringify(data, null, 2));
    };
    const captureTimer = (options.scheduleCapture || setInterval)(() => { try { capture(); } catch {} }, 10000);
    bot.once('end', () => { connected = false; try { capture(); } catch {} (options.cancelCapture || clearInterval)(captureTimer); });
    return ready;
}
