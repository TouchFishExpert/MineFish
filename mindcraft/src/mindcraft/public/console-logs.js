/* Log bodies are untrusted text: never insert them as HTML. */
function initConsoleLogs(socket, getAgents = () => []) {
    const make = (tag, className, text) => {const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;};
    const backdrop = make('div', 'console-log-backdrop'); backdrop.hidden = true;
    const panel = make('section', 'console-log-panel'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', 'console-log-title');
    const header = make('header', 'console-log-header'), title = make('h2', '', '系统日志'); title.id = 'console-log-title';
    const close = make('button', '', '关闭'); header.append(title, close);
    const toolbar = make('div', 'console-log-toolbar');
    const systemTab = make('button', '', '系统日志'), apiTab = make('button', '', 'API 调用日志');
    const agentSelect = make('select'); agentSelect.setAttribute('aria-label', '选择 API 日志的机器人');
    const realtimeLabel = make('label'), realtime = make('input'); realtime.type = 'checkbox'; realtime.checked = true; realtimeLabel.append(realtime, document.createTextNode(' 实时更新'));
    const refresh = make('button', '', '刷新'), download = make('button', '', '下载本次调用 JSON'); download.disabled = true;
    const status = make('span', 'console-log-status', '尚未读取'); status.setAttribute('role', 'status');
    toolbar.append(systemTab, apiTab, agentSelect, realtimeLabel, refresh, download, status);
    const note = make('p', 'console-log-note');
    const systemGrid = make('div', 'console-system-grid');
    const apiView = make('div', 'console-api-view'), apiList = make('nav', 'console-api-list'), detail = make('div', 'console-api-detail');
    apiList.setAttribute('aria-label', '模型 API 调用列表');
    const metadata = make('p', 'console-api-meta', '选择一次调用，查看对应的完整请求和响应。');
    const payloads = make('div', 'console-api-payloads');
    const requestSection = make('section', 'console-api-payload'), responseSection = make('section', 'console-api-payload');
    const requestText = make('pre', '', '尚未选择调用'), responseText = make('pre', '', '尚未选择调用');
    requestSection.append(make('h3', '', '发送给模型的完整请求'), requestText);
    responseSection.append(make('h3', '', '模型返回的完整响应'), responseText);
    payloads.append(requestSection, responseSection); detail.append(metadata, payloads); apiView.append(apiList, detail);
    panel.append(header, toolbar, note, systemGrid, apiView); backdrop.append(panel); document.body.append(backdrop);
    const purposes = {conversation: '对话与动作', memory: '短期记忆摘要', 'memory-compaction': '短期记忆压缩', coding: '代码生成', planning: '目标规划', 'bot-response-check': '机器人对话判断', 'web-search-search': '联网搜索·查找网址', 'web-search-fetch': '联网搜索·读取网页', 'web-search-summary': '联网搜索·整理结果'};
    const statuses = {pending: '等待返回', completed: '已完成', failed: '失败', interrupted: '已中断'};
    const cards = new Map(), calls = new Map();
    let agents = [], kind = 'system', selectedAgent = null, selectedId = null, selectedCall = null, apiCursor = null, apiMore = false, generation = 0, detailTicket = 0, previousFocus;
    const time = value => new Date(value).toLocaleTimeString('zh-CN', {hour12: false});
    const stamp = value => new Date(value).toLocaleString('zh-CN', {hour12: false});
    const active = () => !backdrop.hidden && !document.hidden;
    const report = (text, error = false) => {status.textContent = text; status.dataset.error = String(error);};
    const rpc = (event, ...args) => new Promise((resolve, reject) => socket.timeout(6000).emit(event, ...args, (error, result) => {
        if (error) return reject(Error('读取超时，请重试'));
        if (result?.error) return reject(Error(({forbidden: '机器人进程不能读取控制台日志', unavailable: '日志文件暂时不可读', 'not-found': '机器人或日志不存在'})[result.error] || result.error));
        resolve(result);
    }));
    async function subscribe(agent, channel) {if (active() && realtime.checked) await rpc('subscribe-console-logs', {agent, kind: channel});}
    function stopSubscriptions() {socket.emit('unsubscribe-console-logs');}
    function buildCards() {
        cards.clear(); systemGrid.replaceChildren();
        for (const name of ['$system', ...agents.map(agent => agent.name)]) {
            const card = make('section', 'console-system-card'), bar = make('header'), heading = make('h3', '', name === '$system' ? '控制台服务' : `机器人 · ${name}`);
            const older = make('button', '', '加载更早日志'), output = make('div', 'console-system-output');
            output.setAttribute('aria-label', name === '$system' ? '控制台服务日志' : `${name} 系统日志`);
            bar.append(heading, older); card.append(bar, output); systemGrid.append(card);
            const state = {card, output, older, rows: new Map(), before: null, hasMore: false}; cards.set(name, state);
            older.addEventListener('click', () => loadSystem(name, true));
        }
    }
    function systemLine(row) {
        const line = make('div', 'console-system-line'); line.dataset.level = row.level;
        const date = make('time', '', time(row.time)); date.title = stamp(row.time);
        const message = make('span', '', row.message); line.append(date, message); return line;
    }
    function renderSystem(state, preserve = false) {
        const nearBottom = state.output.scrollHeight - state.output.scrollTop - state.output.clientHeight < 50;
        const oldHeight = state.output.scrollHeight, oldTop = state.output.scrollTop;
        const rows = [...state.rows.values()].sort((a, b) => a.time.localeCompare(b.time) || (a.sequence || 0) - (b.sequence || 0));
        if (!state.historyLoaded && rows.length > 1000) {
            rows.splice(0, rows.length - 1000).forEach(row => state.rows.delete(row.id));
            state.before = rows[0].id; state.hasMore = true;
        }
        state.output.replaceChildren(...rows.map(systemLine));
        if (!rows.length) state.output.append(make('div', 'console-log-empty', '尚无日志。机器人启动、动作执行和异常会记录在这里。'));
        state.older.disabled = !state.hasMore;
        if (preserve) state.output.scrollTop = state.output.scrollHeight - oldHeight + oldTop;
        else if (nearBottom) state.output.scrollTop = state.output.scrollHeight;
    }
    async function loadSystem(name, older = false) {
        const ticket = generation, state = cards.get(name); if (!state) return;
        state.older.disabled = true;
        try {
            const result = await rpc('get-system-logs', name, {limit: 150, before: older ? state.before : undefined});
            if (ticket !== generation || !active()) return;
            if (!older) state.rows.clear();
            state.historyLoaded = older;
            result.items.forEach(row => state.rows.set(row.id, row));
            state.before = result.before; state.hasMore = result.hasMore; renderSystem(state, older);
            if (!older) state.output.scrollTop = state.output.scrollHeight;
            if (result.storageError) report('日志写入异常，请检查磁盘与权限', true);
        } catch (error) {if (ticket === generation) {state.output.replaceChildren(make('div', 'console-log-empty', error.message)); report(error.message, true);}}
    }
    function renderCalls() {
        const scroll = apiList.scrollTop; apiList.replaceChildren();
        const values = [...calls.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        if (!values.length) apiList.append(make('p', 'console-log-empty', '还没有模型 API 调用记录。'));
        for (const call of values) {
            const button = make('button'); button.setAttribute('aria-current', String(call.callId === selectedId));
            button.append(make('strong', '', `${time(call.startedAt)} · ${purposes[call.purpose] || call.purpose}`),
                make('span', '', `${statuses[call.status] || call.status}${typeof call.durationMs === 'number' ? ` · ${(call.durationMs / 1000).toFixed(2)} 秒` : ''}`),
                make('small', '', `${call.model || '模型'} · ${call.callId.slice(0, 8)}`));
            button.addEventListener('click', () => chooseCall(call.callId)); apiList.append(button);
        }
        if (apiMore) {const older = make('button', 'console-api-older', '加载更早调用'); older.addEventListener('click', () => loadCalls(true)); apiList.append(older);}
        apiList.scrollTop = scroll;
    }
    async function chooseCall(id) {
        selectedId = id; selectedCall = null; download.disabled = true; renderCalls();
        metadata.textContent = '正在读取完整调用…';
        const ticket = generation, read = ++detailTicket, agent = selectedAgent;
        try {
            const {call} = await rpc('get-api-call', agent, id);
            if (ticket !== generation || read !== detailTicket || selectedId !== id || !active()) return;
            selectedCall = call; download.disabled = false;
            const usage = call.response?.usage;
            metadata.textContent = `${agent} · ${purposes[call.purpose] || call.purpose} · ${statuses[call.status] || call.status}\n${stamp(call.startedAt)}${call.durationMs !== undefined ? ` · 耗时 ${(call.durationMs / 1000).toFixed(2)} 秒` : ''}${call.httpStatus ? ` · HTTP ${call.httpStatus}` : ''}\n调用编号：${call.id}${call.operationId ? `\n关联操作：${call.operationId}` : ''}\n${call.method} ${call.endpoint}${usage ? `\nToken：输入 ${usage.prompt_tokens ?? '未知'} · 输出 ${usage.completion_tokens ?? '未知'} · 合计 ${usage.total_tokens ?? '未知'}` : ''}`;
            requestText.textContent = typeof call.request === 'string' ? call.request : JSON.stringify(call.request, null, 2);
            responseText.textContent = call.response !== undefined ? (typeof call.response === 'string' ? call.response : JSON.stringify(call.response, null, 2))
                : call.error ? JSON.stringify(call.error, null, 2) : '请求已发送，正在等待模型返回。';
        } catch (error) {if (ticket === generation) {report(error.message, true); responseText.textContent = error.message;}}
    }
    async function loadCalls(older = false) {
        if (!selectedAgent) {report('暂无机器人'); return;}
        const ticket = generation;
        try {
            const result = await rpc('get-api-calls', selectedAgent, {limit: 30, before: older ? apiCursor : undefined});
            if (ticket !== generation || !active()) return;
            if (!older) calls.clear();
            result.items.forEach(call => calls.set(call.callId, call)); apiCursor = result.before; apiMore = result.hasMore; renderCalls();
            if (!selectedId && result.items[0]) await chooseCall(result.items[0].callId);
            else if (selectedId && !older) await chooseCall(selectedId);
            if (result.storageError) report('日志写入异常，请检查磁盘与权限', true);
        } catch (error) {if (ticket === generation) report(error.message, true);}
    }
    function updateAgents() {
        const value = selectedAgent; agentSelect.replaceChildren(...agents.map(agent => {const option = make('option', '', agent.name); option.value = agent.name; return option;}));
        selectedAgent = agents.some(agent => agent.name === value) ? value : agents[0]?.name || null; agentSelect.value = selectedAgent || '';
    }
    async function refreshView() {
        if (!active()) return;
        const ticket = ++generation; stopSubscriptions();
        report(socket.connected ? '正在读取…' : '控制台连接已断开', !socket.connected);
        if (!socket.connected) return;
        try {
            if (kind === 'system') {
                if (!cards.size) buildCards();
                await Promise.all([...cards.keys()].map(async name => {await subscribe(name, 'system'); await loadSystem(name);}));
            } else {await subscribe(selectedAgent, 'api'); await loadCalls();}
            if (ticket === generation && active() && status.dataset.error !== 'true') report(`${realtime.checked ? '实时更新已开启' : '已暂停实时更新'} · ${time(new Date())}`);
        } catch (error) {if (ticket === generation) report(error.message, true);}
    }
    function selectKind(value) {
        kind = value; title.textContent = value === 'system' ? '系统日志' : 'API 调用日志';
        systemTab.setAttribute('aria-pressed', String(value === 'system')); apiTab.setAttribute('aria-pressed', String(value === 'api'));
        systemGrid.hidden = value !== 'system'; apiView.hidden = value !== 'api'; agentSelect.hidden = value !== 'api'; download.hidden = value !== 'api';
        note.textContent = value === 'system' ? '控制台服务与每个机器人分别记录。默认读取最近 150 条，实时保留最近 1000 条；可加载更早日志，磁盘记录不截断。本功能启用前的日志仍保存在原文件中。'
            : '按调用编号配对实际发送的 HTTP 请求体与完整响应。保留系统提示、记忆、上下文、工具结果、reasoning_content、usage 和错误；凭据已脱敏。此前未记录的调用无法补回。';
        refreshView();
    }
    function open(value, agent) {
        previousFocus = document.activeElement; backdrop.hidden = false;
        agents = getAgents();
        if (agent) selectedAgent = agent; updateAgents();
        cards.clear(); selectedId = null; selectedCall = null; calls.clear();
        download.disabled = true; metadata.textContent = '选择一次调用，查看对应的完整请求和响应。';
        requestText.textContent = '尚未选择调用'; responseText.textContent = '尚未选择调用';
        selectKind(value); close.focus();
    }
    function hide() {generation++; stopSubscriptions(); backdrop.hidden = true; previousFocus?.focus();}
    close.addEventListener('click', hide); backdrop.addEventListener('click', event => {if (event.target === backdrop) hide();});
    document.addEventListener('keydown', event => {
        if (!active()) return;
        if (event.key === 'Escape') {event.stopPropagation(); hide();}
        if (event.key === 'Tab') {const elements = [...panel.querySelectorAll('button, select, input')].filter(node => !node.disabled && node.getClientRects().length); const first = elements[0], last = elements.at(-1);
            if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last.focus();} else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first.focus();}}
    });
    systemTab.addEventListener('click', () => selectKind('system')); apiTab.addEventListener('click', () => selectKind('api'));
    refresh.addEventListener('click', refreshView); realtime.addEventListener('change', () => {if (realtime.checked) refreshView(); else {stopSubscriptions(); report('已暂停实时更新；可手动刷新');}});
    agentSelect.addEventListener('change', () => {selectedAgent = agentSelect.value; selectedId = null; selectedCall = null; download.disabled = true;
        metadata.textContent = '选择一次调用，查看对应的完整请求和响应。'; requestText.textContent = '尚未选择调用'; responseText.textContent = '尚未选择调用'; refreshView();});
    download.addEventListener('click', () => {if (!selectedCall) return; const url = URL.createObjectURL(new Blob([JSON.stringify(selectedCall, null, 2)], {type: 'application/json;charset=utf-8'}));
        const link = make('a'); link.href = url; link.download = `${selectedAgent}-api-${selectedCall.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);});
    document.addEventListener('visibilitychange', () => {if (document.hidden) {generation++; stopSubscriptions();} else if (!backdrop.hidden) refreshView();});
    socket.on('disconnect', () => {if (active()) report('控制台连接已断开，重连后自动恢复读取', true);});
    socket.on('connect', () => {if (active()) refreshView();});
    socket.on('agents-status', list => {const changed = list.map(a => a.name).join('|') !== agents.map(a => a.name).join('|'); agents = list; updateAgents(); if (changed && active()) {cards.clear(); selectedId = null; refreshView();}});
    socket.on('system-log', event => {if (!active() || kind !== 'system' || !realtime.checked) return; const state = cards.get(event.agent); if (!state) return;
        state.rows.set(event.id, event); renderSystem(state);});
    socket.on('api-log', event => {if (!active() || kind !== 'api' || !realtime.checked || event.agent !== selectedAgent) return;
        calls.set(event.callId, event); renderCalls(); if (!selectedId || selectedId === event.callId) chooseCall(event.callId);});
    window.openAgentSystemLogs = agent => open('system', agent);
    window.openAgentApiLogs = agent => open('api', agent);
}
