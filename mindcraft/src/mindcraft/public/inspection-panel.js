/* All model and player supplied text is rendered as text nodes, including editable memory. */
function initAgentInspection(socket) {
    const make = (tag, className, text) => {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    };
    const backdrop = make('div', 'inspection-backdrop');
    backdrop.hidden = true;
    const dialog = make('section', 'inspection-panel');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'inspection-title');
    const header = make('div', 'inspection-header');
    const title = make('h2', '', '记忆与位置');
    title.id = 'inspection-title';
    const close = make('button', '', '关闭');
    header.append(title, close);
    const toolbar = make('div', 'inspection-toolbar');
    const status = make('span', 'inspection-status', '尚未读取');
    status.setAttribute('role', 'status');
    const refresh = make('button', '', '刷新');
    toolbar.append(status, refresh);
    const tabs = make('div', 'inspection-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '查看内容');
    const body = make('div', 'inspection-body');
    const sections = {};
    const memoryContent = make('div');
    const goalContent = make('div');
    const manualPanel = createManualMemoryPanel(socket);
    const corePanel = createCoreSummaryPanel(socket);
    let activeTab = 'memory';
    let agentName = null;
    let generation = 0;
    let pending = null;
    let snapshot = null;
    let timer = null;
    let previousFocus = null;
    let lastReadLabel = '';
    let rendered = {};
    const drafts = new Map();
    let saveNotice = '';
    let contextSnapshot = null;
    let contextPending = null;
    let contextAuto = true;
    let contextView = null;

    const tabDefs = [['memory', '短期记忆'], ['fixed', '长期记忆'], ['core', '核心摘要'], ['context', '上下文窗口'], ['locations', '地点与位置']];
    for (const [id, label] of tabDefs) {
        const button = make('button', '', label);
        button.id = `inspection-tab-${id}`;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-controls', `inspection-${id}`);
        button.addEventListener('click', () => selectTab(id));
        const section = make('div', 'inspection-section');
        section.id = `inspection-${id}`;
        section.setAttribute('role', 'tabpanel');
        section.setAttribute('aria-labelledby', button.id);
        sections[id] = { button, section };
        tabs.append(button);
        body.append(section);
    }
    function selectTab(id) {
        activeTab = id;
        for (const [key, { button, section }] of Object.entries(sections)) {
            button.setAttribute('aria-selected', String(key === id));
            button.tabIndex = key === id ? 0 : -1;
            section.hidden = key !== id;
        }
        body.scrollTop = 0;
        manualPanel.setActive(id === 'fixed' && !backdrop.hidden);
        corePanel.setActive(id === 'core' && !backdrop.hidden);
        dialog.classList.toggle('inspection-panel-context', id === 'context');
        if (id === 'context') {renderContext(); requestContext(true);}
    }
    tabs.addEventListener('keydown', event => {
        const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!offset) return;
        event.preventDefault();
        const index = tabDefs.findIndex(([id]) => id === activeTab);
        const id = tabDefs[(index + offset + tabDefs.length) % tabDefs.length][0];
        selectTab(id);
        sections[id].button.focus();
    });
    dialog.append(header, toolbar, tabs, body);
    backdrop.append(dialog);
    document.body.append(backdrop);

    const heading = (parent, text) => parent.append(make('h3', '', text));
    const hint = (parent, text, extra = '') => parent.append(make('p', `inspection-hint ${extra}`, text));
    const block = (parent, text) => parent.append(make('div', 'inspection-text', text));
    const coords = pos => pos ? `X ${pos.x}　Y ${pos.y}　Z ${pos.z}` : '位置未加载';
    const dateLabel = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未记录';

    function renderContext() {
        const section = sections.context.section;
        if (!contextView || !section.contains(contextView.text)) {
            section.replaceChildren();
            heading(section, '最近一次发送给 DeepSeek 的上下文');
            hint(section, '直接读取实际请求中的完整 messages，包含系统提示、记忆、环境、工具说明和工作上下文，已脱敏。这里是最近一次发送的快照；读取不会调用模型，也不会压缩或修改记忆。');
            const actions = make('div', 'inspection-context-actions');
            const label = make('label'), auto = make('input');
            auto.type = 'checkbox'; auto.checked = contextAuto;
            label.append(auto, document.createTextNode(' 自动更新'));
            auto.addEventListener('change', () => {
                contextAuto = auto.checked;
                if (contextAuto) requestContext(true);
                else status.textContent = '已暂停自动更新；当前上下文快照保留，点击“刷新”可手动更新。';
            });
            const download = make('button', '', '下载全文');
            const counts = make('p', 'inspection-context-counts');
            const metadata = make('p', 'inspection-hint inspection-context-meta');
            const text = make('textarea', 'inspection-context-text');
            text.id = 'inspection-context-text'; text.readOnly = true; text.spellcheck = false;
            text.setAttribute('aria-label', '最近一次发送给 DeepSeek 的完整上下文');
            download.addEventListener('click', () => {
                if (!contextSnapshot?.text) return;
                const url = URL.createObjectURL(new Blob([contextSnapshot.text], {type: 'text/plain;charset=utf-8'}));
                const link = make('a'); link.href = url; link.download = `${agentName}-上下文-${contextSnapshot.id}.txt`; link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            });
            actions.append(label, download); section.append(actions, counts, metadata, text);
            contextView = {counts, metadata, text, download, id: null};
        }
        const current = contextSnapshot;
        contextView.download.disabled = !current;
        if (!current) {
            contextView.counts.textContent = '尚无实际对话请求';
            contextView.metadata.textContent = '机器人产生下一次对话请求后，这里会显示真实上下文。';
            contextView.text.value = ''; contextView.id = null;
            return;
        }
        const number = value => Number(value || 0).toLocaleString('zh-CN');
        contextView.counts.textContent = `全文 ${number(current.chars)} 字符`;
        const statuses = {pending: '等待模型返回', completed: '已完成', failed: '请求失败', interrupted: '请求已中断'};
        contextView.metadata.textContent = `${dateLabel(current.startedAt)} · ${current.model || 'DeepSeek'} · ${statuses[current.status] || current.status}\n调用编号：${current.id}`;
        if (contextView.id !== current.id) {
            const top = contextView.text.scrollTop, start = contextView.text.selectionStart, end = contextView.text.selectionEnd;
            contextView.text.value = current.text;
            contextView.text.scrollTop = top; contextView.text.setSelectionRange(start, end);
            contextView.id = current.id;
        }
    }

    function requestContext(force = false) {
        if (backdrop.hidden || document.hidden || activeTab !== 'context' || contextPending !== null || (!contextAuto && !force)) return;
        if (!socket.connected) {reportError('控制台连接已断开'); return;}
        const ticket = generation, name = agentName;
        contextPending = ticket; refresh.disabled = true;
        socket.timeout(6000).emit('get-context-window', name, {ifCallId: contextSnapshot?.id}, (error, result) => {
            if (ticket !== generation || name !== agentName) return;
            contextPending = null; refresh.disabled = false;
            if (activeTab !== 'context' || backdrop.hidden) return;
            if (error || result?.error) {reportError(error ? '上下文读取超时' : '上下文暂时无法读取'); return;}
            contextSnapshot = result?.unchanged ? {...contextSnapshot, ...result.context} : result?.context || null;
            renderContext();
            lastReadLabel = new Date().toLocaleTimeString('zh-CN', {hour12: false});
            status.dataset.error = 'false';
            status.textContent = `读取于 ${lastReadLabel} · ${contextAuto ? '每 5 秒更新实际请求' : '已暂停自动更新'}`;
        });
    }

    function renderMemory(memory, summary) {
        const draft = drafts.get(agentName);
        heading(summary, '短期记忆');
        if (!draft) {
            block(summary, memory.summary || '当前还没有短期记忆。');
            const edit = make('button', 'inspection-edit-btn', '编辑短期记忆');
            edit.addEventListener('click', () => {
                if (!snapshot?.memory?.revision) return;
                drafts.set(agentName, { summary: snapshot.memory.summary, baseRevision: snapshot.memory.revision, saving: false });
                saveNotice = '';
                rendered.memory = '';
                render(snapshot);
                summary.querySelector('textarea')?.focus();
            });
            summary.append(edit);
            if (saveNotice) hint(summary, saveNotice, 'inspection-save-notice');
        } else {
            const label = make('label', 'inspection-hint', '编辑短期记忆');
            label.htmlFor = 'inspection-memory-editor';
            const input = make('textarea', 'inspection-memory-editor');
            input.id = label.htmlFor;
            input.value = draft.summary;
            input.rows = 10;
            input.spellcheck = false;
            input.disabled = draft.saving;
            const counter = make('p', 'inspection-hint');
            const actions = make('div', 'inspection-edit-actions');
            const save = make('button', '', draft.saving ? '正在保存…' : '保存短期记忆');
            const cancel = make('button', '', '取消编辑');
            cancel.disabled = draft.saving;
            const feedback = make('p', 'inspection-hint inspection-edit-feedback', draft.error || '草稿不会被自动刷新覆盖；关闭面板后再次打开仍会保留。');
            const conflict = make('div', 'inspection-edit-conflict');
            conflict.id = 'inspection-memory-conflict';
            const sync = () => {
                const latest = snapshot?.memory;
                const changed = latest && latest.revision !== draft.baseRevision;
                const limit = latest?.summaryLimit ?? 2500;
                counter.textContent = `${draft.summary.length} / ${limit} 字符${draft.summary.length > limit ? '，请缩短后保存；不会自动截断' : ''}`;
                save.disabled = draft.saving || draft.summary.length > limit || Boolean(changed);
                conflict.hidden = !changed;
                const key = changed ? latest.revision : '';
                if (conflict.dataset.revision === key) return;
                conflict.dataset.revision = key;
                conflict.replaceChildren();
                if (!changed) return;
                hint(conflict, '编辑期间摘要已更新。你的草稿已保留，请先核对下面的新摘要。');
                block(conflict, latest.summary || '（空摘要）');
                const review = make('button', '', '核对新摘要后继续编辑');
                review.disabled = draft.saving;
                review.addEventListener('click', () => {
                    draft.baseRevision = latest.revision;
                    draft.error = '';
                    feedback.textContent = '草稿已保留。请合并需要的新信息，再点“保存短期记忆”。';
                    sync();
                });
                conflict.append(review);
            };
            // Refresh only the conflict notice while typing, keeping selection and cursor intact.
            draft.sync = sync;
            input.addEventListener('input', () => { draft.summary = input.value; draft.error = ''; sync(); });
            save.addEventListener('click', () => saveMemory(draft));
            cancel.addEventListener('click', () => {
                drafts.delete(agentName);
                rendered.memory = '';
                render(snapshot);
            });
            actions.append(save, cancel);
            summary.append(label, input, counter, actions, feedback, conflict);
            sync();
        }
        summary.append(make('p', 'inspection-hint inspection-current-memory'), make('p', 'inspection-hint inspection-memory-source'), make('p', 'inspection-hint inspection-memory-backup'));
        hint(summary, '保存立即更新运行记忆与本地存档，并备份修改前的内容。后续模型请求会使用新记忆；当前动作继续执行。日常启动会恢复已保存的记忆。');
    }

    function saveMemory(draft) {
        if (draft.saving || !socket.connected) { if (!socket.connected) reportError('控制台连接已断开，草稿已保留'); return; }
        const name = agentName;
        const ticket = ++generation; // Ignore reads started before this write.
        pending = null;
        draft.saving = true;
        draft.error = '';
        rendered.memory = '';
        render(snapshot);
        socket.timeout(6000).emit('update-agent-memory', name, { summary: draft.summary, baseRevision: draft.baseRevision }, (error, result) => {
            draft.saving = false;
            const errors = { conflict: '摘要已变化，草稿已保留，请核对新摘要后再保存。', 'too-long': '摘要超过长度上限，请缩短后保存。', 'invalid-request': '保存请求无效，请重新打开编辑。', 'save-failed': '文件保存失败，运行记忆保持原样，草稿已保留。', offline: '机器人未进服，草稿已保留。', timeout: '保存结果暂未确认，请刷新核对；草稿已保留。', unavailable: '暂时无法保存，草稿已保留。', 'not-found': '机器人不存在，草稿已保留。' };
            if (!error && result?.success) {
                if (drafts.get(name) === draft) drafts.delete(name);
                if (ticket === generation) saveNotice = result.unchanged ? '内容未变化，无需重复保存。' : '已保存，运行记忆已更新；修改前内容已备份。';
            } else {
                draft.error = error ? '保存结果暂未确认，请刷新核对；草稿已保留。' : errors[result?.error] || '保存失败，草稿已保留。';
            }
            if (ticket !== generation) return;
            if (result?.snapshot) snapshot = result.snapshot;
            rendered.memory = '';
            render(snapshot);
            request();
        });
    }
    function addVehicle(parent, vehicle) {
        if (!vehicle) {
            parent.append(make('p', '', '载具记录：无'));
            return;
        }
        parent.append(make('p', '', `客户端载具记录：${vehicle.name}（实体 ${vehicle.id ?? '?'}）`));
        parent.append(make('p', '', `载具坐标：${coords(vehicle.position)}`));
        const listed = vehicle.passengerListed === null ? '未知' : vehicle.passengerListed ? '包含该玩家' : '未包含该玩家';
        parent.append(make('p', '', `乘客列表：${vehicle.passengers?.join('、') || '无记录'}；${listed}`));
    }
    function locationCard(parent, name, pos, vehicle, loaded = true) {
        const card = make('div', 'inspection-location');
        card.append(make('strong', '', name));
        card.append(make('p', '', loaded ? `客户端坐标：${coords(pos)}` : '在线，实体未加载，无法读取位置'));
        if (loaded) addVehicle(card, vehicle);
        parent.append(card);
    }
    function render(value) {
        const memory = value.memory || {};
        manualPanel.setUsage(value.name, value.memoryUsage);
        const goal = value.goal || {};
        const summary = sections.memory.section;
        if (!summary.contains(memoryContent)) summary.replaceChildren(memoryContent, goalContent);
        const draft = drafts.get(agentName);
        const summaryKey = JSON.stringify(draft ? ['editing', draft.saving] : [memory.summary, memory.summaryLimit]);
        if (rendered.memory !== summaryKey) {
        memoryContent.replaceChildren();
        renderMemory(memory, memoryContent);
        rendered.memory = summaryKey;
        }
        const sources = { manual: '手动修改', automatic: 'AI 自动摘要', unknown: '历史摘要' };
        const compact = memory.summaryCompression;
        const compactState = compact?.state === 'running' ? '正在压缩。' : compact?.state === 'failed' ? '上次压缩未成功，原内容已保留。' : '';
        memoryContent.querySelector('.inspection-current-memory').textContent = `当前已保存 ${(memory.summary || '').length} 字符；摘要正文上限 ${memory.summaryLimit} 字符。达到 ${memory.summaryCompactTrigger ?? 2400} 字符自动压缩，目标约 ${memory.summaryCompactTarget ?? 2000} 字符。${compactState}自动更新和手动修改前均会备份。`;
        memoryContent.querySelector('.inspection-memory-source').textContent = `来源：${sources[memory.source] || '历史摘要'}；更新于：${dateLabel(memory.updatedAt)}`;
        const backup = memoryContent.querySelector('.inspection-memory-backup');
        backup.hidden = !memory.lastBackup;
        backup.textContent = memory.lastBackup ? `最近更新前的备份：bots/${agentName}/memory-backups/${memory.lastBackup}` : '';
        if (rendered.goal !== JSON.stringify(goal)) {
        goalContent.replaceChildren();
        heading(goalContent, '当前自主目标');
        const goalStates = { active: '自主循环运行中', paused: '自主循环暂停中', stopped: '自主循环已停止' };
        hint(goalContent, goalStates[goal.state] || '状态未知');
        block(goalContent, goal.prompt || '当前没有自主目标。');
        if (goal.state === 'stopped' && goal.prompt) hint(goalContent, '上面是保留的目标文本；停止状态下不会据此继续执行。');
        hint(goalContent, '记忆保存至 bots/<机器人名>/memory.json。查看和手动保存都不调用模型；自主目标与位置在此仅供查看。');
        rendered.goal = JSON.stringify(goal);
        }
        drafts.get(agentName)?.sync?.();

        const locations = sections.locations.section;
        locations.replaceChildren();
        const places = memory.namedPlaces || [];
        heading(locations, `命名地点 · ${places.length} 处`);
        hint(locations, '由 !rememberHere 记录。当前上游只在本次进程中保留，重启不恢复；在摘要或聊天中提到的坐标不会自动出现在这里。地点没有单独记录维度。');
        for (const place of places) {
            const card = make('div', 'inspection-location');
            card.append(make('strong', '', place.name), make('p', '', coords(place.position)));
            locations.append(card);
        }
        if (!places.length) locations.append(make('div', 'inspection-empty', '当前进程没有结构化的命名地点。'));
        heading(locations, '机器人与在线玩家');
        const current = value.locations || {};
        hint(locations, `机器人当前维度：${current.dimension || '未知'}；玩家维度未知时不作推断。`);
        hint(locations, '坐标和载具来自客户端缓存。下方读取时间不是网络实体更新时间；未加载玩家无法定位。乘船时玩家坐标、载具记录和乘客列表可能滞后，仅供排查。', 'inspection-disclaimer');
        locationCard(locations, `${value.name} · 机器人`, current.bot?.position, current.bot?.vehicle);
        for (const player of current.players || []) locationCard(locations, player.name, player.position, player.vehicle, player.entityLoaded);
        if (!current.players?.length) hint(locations, '当前在线列表没有其他玩家。');
    }
    function reportError(message) {
        status.dataset.error = 'true';
        status.textContent = message + (lastReadLabel ? `；保留上次快照（${lastReadLabel}）` : '；尚无快照');
    }
    function request(force = false) {
        if (activeTab === 'context') {requestContext(force === true); return;}
        if (backdrop.hidden || document.hidden || pending !== null || drafts.get(agentName)?.saving) return;
        if (!socket.connected) { reportError('控制台连接已断开'); return; }
        const ticket = generation;
        pending = ticket;
        refresh.disabled = true;
        socket.timeout(5000).emit('get-agent-inspection', agentName, (error, result) => {
            if (ticket !== generation) return;
            pending = null;
            refresh.disabled = false;
            if (activeTab === 'context') {if (result?.snapshot) snapshot = result.snapshot; return;}
            const errors = { 'not-found': '机器人不存在', offline: '机器人未进服', timeout: '机器人读取超时', unavailable: '暂时无法读取' };
            if (error || result?.error || !result?.snapshot) {
                reportError(error ? '控制台读取超时' : errors[result?.error] || '读取失败');
                return;
            }
            snapshot = result.snapshot;
            const scrollTop = body.scrollTop;
            render(snapshot);
            body.scrollTop = scrollTop;
            const time = new Date(snapshot.sampledAt);
            lastReadLabel = Number.isNaN(time.getTime()) ? '时间未知' : time.toLocaleTimeString('zh-CN', { hour12: false });
            status.dataset.error = 'false';
            status.textContent = `读取于 ${lastReadLabel} · 每 5 秒刷新`;
        });
    }
    function hide() {
        generation++;
        pending = null;
        contextPending = null;
        clearInterval(timer);
        timer = null;
        backdrop.hidden = true;
        manualPanel.setActive(false);
        corePanel.setActive(false);
        previousFocus?.focus();
    }
    close.addEventListener('click', hide);
    refresh.addEventListener('click', () => request(true));
    refresh.addEventListener('click', () => { if (activeTab === 'fixed') manualPanel.refresh(); if (activeTab === 'core') corePanel.refresh(); });
    backdrop.addEventListener('click', event => { if (event.target === backdrop) hide(); });
    dialog.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); hide(); }
        if (event.key !== 'Tab') return;
        const focusable = [...dialog.querySelectorAll('button:not(:disabled), textarea:not(:disabled), summary')].filter(el => el.getClientRects().length && el.tabIndex !== -1);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    socket.on('disconnect', () => { if (!backdrop.hidden) reportError('控制台连接已断开'); });
    socket.on('connect', () => { if (!backdrop.hidden) request(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) request(); });
    window.openAgentInspection = name => {
        generation++;
        pending = null;
        agentName = name;
        snapshot = null;
        contextSnapshot = null;
        contextPending = null;
        contextView = null;
        saveNotice = '';
        lastReadLabel = '';
        rendered = {};
        previousFocus = document.activeElement;
        title.textContent = `${name} · 记忆与位置`;
        status.textContent = '正在读取…';
        status.dataset.error = 'false';
        refresh.disabled = false;
        for (const [id, { section }] of Object.entries(sections)) {
            section.replaceChildren(id === 'fixed' ? manualPanel.element : id === 'core' ? corePanel.element : make('p', 'inspection-empty', '正在读取当前进程…'));
        }
        manualPanel.open(name);
        corePanel.open(name);
        backdrop.hidden = false;
        selectTab('memory');
        close.focus();
        clearInterval(timer);
        timer = setInterval(request, 5000);
        request();
    };
    selectTab('memory');
}
