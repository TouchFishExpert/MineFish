/* Core summary is AI-owned. This panel has no editor or mutation request. */
function createCoreSummaryPanel(socket) {
    const element = document.createElement('div');
    const title = document.createElement('h3'); title.textContent = '核心摘要';
    const description = document.createElement('p'); description.className = 'inspection-hint';
    description.textContent = 'AI把自己认为最珍贵的记忆记录在这里';
    const body = document.createElement('div'); body.className = 'inspection-text';
    const meta = document.createElement('p'); meta.className = 'inspection-hint';
    const note = document.createElement('p'); note.className = 'inspection-hint';
    note.textContent = '由AI自行记录、修改和删除，此处仅供查看。';
    element.append(title, description, body, meta, note);
    let name = null, generation = 0, active = false, timer = null;
    function refresh() {
        if (!name) return;
        const ticket = generation, target = name;
        socket.timeout(5000).emit('get-core-summary', target, (error, result) => {
            if (ticket !== generation || target !== name) return;
            const value = result?.coreSummary;
            if (error || !value?.available) {
                body.textContent = '核心摘要暂时无法读取，原内容仍保存在本地。';
                meta.textContent = '可稍后刷新重试。';
                return;
            }
            body.textContent = value.text || 'AI尚未记录核心摘要。';
            const updated = value.updatedAt ? new Date(value.updatedAt).toLocaleString('zh-CN', {hour12: false}) : '尚未记录';
            meta.textContent = `${value.text.length}/${value.limit} 字符 · AI更新版本 ${value.version} · 更新于：${updated}`;
        });
    }
    function setActive(value) {
        active = value;
        clearInterval(timer); timer = null;
        if (active) {refresh(); timer = setInterval(refresh, 5000);}
    }
    socket.on('connect', () => {if (active) refresh();});
    return {element, refresh, setActive, open(next) {
        name = next; generation++; body.textContent = '正在读取核心摘要…'; meta.textContent = ''; refresh();
    }};
}
