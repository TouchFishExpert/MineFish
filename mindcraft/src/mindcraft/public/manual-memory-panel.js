/* A console-owned editor, separate from the agent's rolling-summary editor. */
function createManualMemoryPanel(socket) {
    const make = (tag, className, text) => {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    };
    const element = make('div', 'inspection-section');
    const usages = new Map();
    const snapshots = new Map(), drafts = new Map(), notices = new Map(), readErrors = new Map();
    let name = null, active = false, timer = null, pendingRead = null, viewKey = '', syncEditor = null;
    const errors = {
        forbidden: '此连接没有修改长期记忆的权限。', 'not-found': '机器人不存在。',
        'invalid-request': '保存请求无效。', 'too-long': '内容超过字符上限，请缩短后保存。',
        conflict: '长期记忆已被另一个控制台修改，请核对新内容；草稿已保留。',
        'read-failed': '长期记忆文件读取失败，现有文件不会被覆盖。',
        'save-failed': '文件保存失败，原内容保留，草稿未丢失。'
    };
    function accept(agent, value) {
        if (!value) return;
        const previous = snapshots.get(agent);
        if (previous?.available && value.available && value.version < previous.version) return;
        snapshots.set(agent, value);
    }
    function render() {
        if (!name) return;
        const memory = snapshots.get(name), draft = drafts.get(name);
        const key = JSON.stringify([name, memory?.available, draft ? ['editing', draft.saving] : memory, notices.get(name), readErrors.get(name)]);
        if (viewKey !== key) {
            viewKey = key;
            syncEditor = null;
            element.replaceChildren();
            element.append(make('h3', '', '长期记忆'));
            element.append(make('p', 'inspection-hint', '由你手动维护，供 AI 在对话与规划时读取；与短期记忆独立保存，不参与自动压缩。'));
            if (!memory) { element.append(make('p', 'inspection-empty', readErrors.get(name) || '正在读取长期记忆…')); return; }
            if (!memory.available) { element.append(make('p', 'inspection-hint', errors[memory.error] || '暂时无法读取长期记忆。')); return; }
            if (!draft) {
                element.append(make('div', 'inspection-text', memory.text || '尚未添加长期记忆。'));
                const edit = make('button', 'inspection-edit-btn', memory.text ? '编辑长期记忆' : '添加长期记忆');
                edit.addEventListener('click', () => {
                    drafts.set(name, { text: snapshots.get(name).text, baseRevision: snapshots.get(name).revision, saving: false });
                    notices.delete(name); viewKey = ''; render(); element.querySelector('textarea')?.focus();
                });
                element.append(edit);
            } else {
                const label = make('label', 'inspection-hint', '长期记忆内容');
                label.htmlFor = 'manual-memory-editor';
                const input = make('textarea', 'inspection-memory-editor');
                input.id = label.htmlFor; input.value = draft.text; input.rows = 12; input.spellcheck = false; input.disabled = draft.saving;
                const count = make('p', 'inspection-hint'), actions = make('div', 'inspection-edit-actions');
                const save = make('button', '', draft.saving ? '正在保存…' : '保存长期记忆');
                const cancel = make('button', '', '取消编辑'); cancel.disabled = draft.saving;
                const conflict = make('div', 'inspection-edit-conflict');
                actions.append(save, cancel); element.append(label, input, count, actions, conflict);
                syncEditor = () => {
                    const latest = snapshots.get(name);
                    const changed = latest?.available && latest.revision !== draft.baseRevision;
                    count.textContent = `${draft.text.length} / ${latest?.limit ?? 2000} 字符${draft.text.length > (latest?.limit ?? 2000) ? '，请缩短后保存' : ''}`;
                    save.disabled = draft.saving || !latest?.available || Boolean(changed) || draft.text.length > latest.limit;
                    conflict.hidden = !changed;
                    if (!changed || conflict.dataset.revision === latest.revision) return;
                    conflict.dataset.revision = latest.revision;
                    conflict.replaceChildren(make('p', 'inspection-hint', '其他控制台更新了长期记忆。请先核对新内容，草稿已保留。'), make('div', 'inspection-text', latest.text || '（空内容）'));
                    const review = make('button', '', '核对新内容后继续编辑'); review.disabled = draft.saving;
                    review.addEventListener('click', () => { draft.baseRevision = latest.revision; syncEditor(); }); conflict.append(review);
                };
                input.addEventListener('input', () => { draft.text = input.value; syncEditor(); });
                save.addEventListener('click', () => write(draft));
                cancel.addEventListener('click', () => { drafts.delete(name); notices.delete(name); viewKey = ''; render(); });
                element.append(make('p', 'inspection-hint', '草稿不会被自动刷新覆盖；关闭面板后再次打开仍会保留。'));
            }
            element.append(make('p', 'inspection-hint inspection-save-notice', [notices.get(name), readErrors.get(name)].filter(Boolean).join(' ')), make('p', 'inspection-hint manual-memory-meta'), make('p', 'inspection-hint manual-memory-usage'), make('p', 'inspection-hint manual-memory-backup'));
            element.append(make('p', 'inspection-hint', `独立存档：bots/${name}/manual-memory.json。保存立即生效，重启后保留；修改前自动备份。当前上限 ${memory.limit} 字符。`));
        }
        syncEditor?.();
        const meta = element.querySelector('.manual-memory-meta');
        if (meta && memory?.available) meta.textContent = `已保存 ${memory.text.length} 字符；更新时间：${memory.updatedAt ? new Date(memory.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '尚未保存'}`;
        const usageLabel = element.querySelector('.manual-memory-usage');
        const usage = usages.get(name);
        if (usageLabel && memory?.available) {
            const kind = { conversation: '对话', coding: '动作规划', planning: '目标规划' }[usage?.kind] || '模型';
            usageLabel.textContent = usage?.manualRevision === memory.revision
                ? `最近一次${kind}请求已附带 ${usage.manualChars} 字符，版本 ${usage.manualVersion}；时间：${new Date(usage.appliedAt).toLocaleString('zh-CN', { hour12: false })}。`
                : '当前版本尚无模型请求记录；下一次对话或规划时会读取。';
        }
        const backup = element.querySelector('.manual-memory-backup');
        if (backup && memory?.available) { backup.hidden = !memory.lastBackup; backup.textContent = memory.lastBackup ? `修改前备份：bots/${name}/manual-memory-backups/${memory.lastBackup}` : ''; }
    }
    function read() {
        if (!active || !name || document.hidden || !socket.connected || pendingRead || drafts.get(name)?.saving) return;
        const target = name, token = {}; pendingRead = token;
        socket.timeout(5000).emit('get-manual-memory', target, (error, result) => {
            if (pendingRead === token) pendingRead = null;
            if (error || result?.error) readErrors.set(target, error ? '长期记忆读取超时；保留上次快照。' : errors[result.error] || '读取失败。');
            else { accept(target, result?.manualMemory); readErrors.delete(target); }
            if (target === name) render();
        });
    }
    function write(draft) {
        if (draft.saving || !socket.connected) {
            if (!socket.connected) { notices.set(name, '控制台连接已断开，草稿已保留。'); viewKey = ''; render(); } return;
        }
        const target = name; draft.saving = true; notices.delete(target); viewKey = ''; render();
        socket.timeout(6000).emit('update-manual-memory', target, { text: draft.text, baseRevision: draft.baseRevision }, (error, result) => {
            draft.saving = false; accept(target, result?.manualMemory);
            if (!error && result?.success) {
                if (drafts.get(target) === draft) drafts.delete(target);
                notices.set(target, result.unchanged ? '内容未变化，无需重复保存。' : '长期记忆已保存，AI 后续请求会读取新内容；原内容已备份。');
            } else notices.set(target, error ? '保存结果尚未确认，请刷新核对；草稿已保留。' : errors[result?.error] || '保存失败，草稿已保留。');
            if (target === name) { viewKey = ''; render(); read(); }
        });
    }
    socket.on('connect', read);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) read(); });
    return {
        element,
        setUsage(agent, usage) { if (agent && usage) { usages.set(agent, usage); if (agent === name) render(); } },
        open(agent) { name = agent; viewKey = ''; pendingRead = null; render(); },
        setActive(value) { active = value; clearInterval(timer); timer = null; if (active) { read(); timer = setInterval(read, 5000); } },
        refresh: read
    };
}
