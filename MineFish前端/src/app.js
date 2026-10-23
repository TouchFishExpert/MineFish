/* MineFish UI demo. All application data and interactions stay in this renderer. */
'use strict';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => `<i data-lucide="${name === 'file-copy' ? 'copy' : name}"></i>`;
const arrow = () => icon('chevron-right');
const link = (label, action, data = '') => `<button class="link" data-action="${action}" ${data}>${label}${arrow()}</button>`;
const btn = (label, action, name = '', cls = '', extra = '') => `<button class="btn ${cls}" data-action="${action}" ${extra}>${name ? icon(name) : ''}${label}</button>`;
const soft = (name, color = '', size = '') => `<span class="soft-icon ${color} ${size}">${icon(name)}</span>`;
const status = (text = '运行中', cls = '') => `<span class="status ${cls}"><em class="dot"></em>${text}</span>`;
const badge = (text, cls = '', dot = false) => `<span class="badge ${cls}">${dot ? '<em class="dot"></em>' : ''}${text}</span>`;
const tags = (items, cls = '') => `<div class="tags">${items.map(t => `<span class="tag ${cls}">${esc(t)}</span>`).join('')}</div>`;
const cardHead = (title, right = '') => `<div class="card-head"><h2>${title}</h2>${right}</div>`;
const dots = (type, id = '') => `<button class="dots" aria-label="更多操作" data-action="more" data-kind="${type}" data-id="${id}">···</button>`;
const sprite = (page, x, y, w, h, size = w, cls = '') => {
  const scale = size / w;
  return `<span class="avatar ${cls}" style="width:${size}px;height:${h * scale}px"><img aria-hidden="true" alt="" src="../assets/reference/${page}.png" style="width:${1586 * scale}px;height:${992 * scale}px;left:${-x * scale}px;top:${-y * scale}px"></span>`;
};
const avatars = {
  bot: size => sprite('robots', 233, 245, 49, 49, size),
  DeepSeek: size => sprite('robots', 233, 368, 49, 49, size),
  Builder: size => sprite('robots', 233, 493, 49, 49, size),
  Scout: size => sprite('robots', 233, 619, 49, 49, size),
  player: size => soft('user-round', '', 'small-icon'),
  log: size => sprite('robots', 1128, 349, 41, 41, size),
  grass: size => sprite('system', 1050, 214, 44, 43, size)
};
const avatar = (name, size = 48) => (avatars[name] || avatars.DeepSeek)(size);
const providerIcon = (id, cls = '') => `<span class="provider-icon ${id} ${cls}"><img src="../assets/${({deepseek:'deepseek-color',doubao:'doubao-reference',openai:'openai',glm:'zhipu-color',ollama:'ollama'})[id]}.svg" alt="${id}"></span>`;
const pImage = (id = 'deepseek') => `<img src="../assets/${({deepseek:'deepseek-color',doubao:'doubao-reference',openai:'openai',glm:'zhipu-color',ollama:'ollama'})[id]}.svg" alt="">`;
const search = (placeholder, id, value = '') => `<label class="search">${icon('search')}<input type="search" id="${id}" placeholder="${placeholder}" value="${esc(value)}" aria-label="${placeholder}"></label>`;
const select = (id, options) => `<select id="${id}" aria-label="${id}">${options.map(o => `<option>${esc(o)}</option>`).join('')}</select>`;
const heading = (title, sub, right = '', inline = false, cls = '') => `<div class="page-heading ${inline ? 'heading-inline' : ''} ${cls}">${inline ? `<h1>${title}</h1><p>${sub}</p>` : `<div><h1>${title}</h1><p>${sub}</p></div>`}${right}</div>`;

const state = {
  page: 'overview', selectedRobot: 'DeepSeek', selectedProvider: 'deepseek', memoryTab: 0,
  selectedMemory: 0, selectedRequest: 1242, systemTab: 0, usagePeriod: '30 天',
  modelSearch: '', memorySearch: '', logSearch: '', modelAbility: '全部能力',
  memoryType: '全部类型', memoryTime: '全部时间', memorySort: '最新优先',
  robots: [
    { name:'bot', model:'DeepSeek-R1', latency:320, task:'正在建造房屋', running:true },
    { name:'DeepSeek', model:'DeepSeek-V3', latency:280, task:'收集橡木原木', running:true },
    { name:'Builder', model:'Qwen2.5-72B', latency:190, task:'待命中', running:false },
    { name:'Scout', model:'Llama3.1-8B', latency:240, task:'探索周边地形', running:true }
  ],
  customMessages: {},
  plugins: [
    {name:'寻路插件',version:'v1.0.3',description:'让机器人能够智能寻路、<br>跟随和返回营地',icon:'map-pin',color:'',enabled:true},
    {name:'方块采集插件',version:'v1.2.1',description:'挖矿、采收农作物与合成工具',icon:'box',color:'',enabled:true},
    {name:'自动进食插件',version:'v1.0.0',description:'监控饥饿值并自动进食',icon:'utensils',color:'purple',enabled:true},
    {name:'装备管理插件',version:'v0.9.5',description:'自动更换和修复装备',icon:'shirt',color:'purple',enabled:false},
    {name:'联网搜索插件',version:'v1.1.0',description:'查询资料、阅读网页<br>并整理信息',icon:'globe',color:'',enabled:true}
  ],
  memories: [
    {title:'摔死了还嘴硬',type:'近期上下文',category:0,time:'14:36',icon:'message-square-more',color:'',description:'DeepSeek 在农场收土豆时突然摔落死亡。玩家问“谁摔死了”，DeepSeek 回复：摔了，还嘴硬。',tags:['游戏日常','AI 队友','状态事件']},
    {title:'农场任务进度',type:'短期记忆',category:1,time:'14:28',icon:'pickaxe',color:'',description:'已完成一轮胡萝卜和土豆采集，准备补种。',tags:['生存建设','农作物','任务进度']},
    {title:'基地和农场位置',type:'长期记忆',category:2,time:'13:50',icon:'house',color:'red',description:'农场位于 -53,63,56；主基地可以休息和存放物品。',tags:['地理位置','基地建设','重要地点']},
    {title:'机器人行为偏好',type:'核心摘要',category:3,time:'12:16',icon:'file-text',color:'',description:'优先完成资源采集与基础建设任务；遇到危险时优先保证自身安全。',tags:['行为策略','偏好设置','长期有效']},
    {title:'工具使用记录',type:'近期上下文',category:0,time:'11:42',icon:'code',color:'',description:'使用了 dig、place_block、get_position 等工具进行资源采集。',tags:['工具调用','技能使用','操作记录']}
  ]
};

const providers = [
  {id:'deepseek',name:'DeepSeek',url:'https://api.deepseek.com',count:4},
  {id:'doubao',name:'豆包 Doubao',url:'https://ark.cn-beijing.volces.com',count:3},
  {id:'openai',name:'OpenAI',url:'https://api.openai.com',count:2},
  {id:'glm',name:'智谱 GLM',url:'https://open.bigmodel.cn',count:2},
  {id:'ollama',name:'Ollama（本地）',url:'http://127.0.0.1:11434',count:1}
];
const modelData = {
  deepseek:[['DeepSeek-R1',320,'128K','中等',['推理','代码','数学']],['DeepSeek-V3',280,'128K','中等',['通用','对话','代码']],['DeepSeek-Coder',240,'128K','中等',['代码','工具','调用']],['DeepSeek-Chat',260,'64K','低',['对话','通用','中文']]],
  doubao:[['Doubao-Pro-32K',210,'32K','低',['通用','对话','中文']],['Doubao-Pro-128K',250,'128K','中等',['推理','代码']],['Doubao-Lite',160,'32K','低',['通用','对话']]],
  openai:[['GPT-4o',380,'128K','中等',['通用','代码','推理']],['GPT-4o-mini',220,'128K','低',['通用','对话']]],
  glm:[['GLM-4-Plus',290,'128K','中等',['推理','中文']],['GLM-4-Flash',180,'128K','低',['通用','对话']]],
  ollama:[['Llama3.1-8B',240,'128K','低',['通用','对话']]]
};

function lineChart(values, {width = 420, height = 135, max = 2000, labels = ['00:00','04:00','08:00','12:00','16:00','20:00'], yLabels = null, id = 'chart', color = '#138aff'} = {}) {
  const l = 39, r = 8, t = 9, b = 24, w = width-l-r, h = height-t-b;
  const points = values.map((v,i) => [l+i/(values.length-1)*w,t+h-v/max*h]);
  const curve = points.map((p,i) => {
    if (!i) return `M${p[0]},${p[1]}`;
    const prev = points[i-1], mid = (prev[0]+p[0])/2;
    return `C${mid},${prev[1]} ${mid},${p[1]} ${p[0]},${p[1]}`;
  }).join(' ');
  return `<svg class="line-chart" viewBox="0 0 ${width} ${height}" aria-label="使用量趋势图" role="img"><defs><linearGradient id="fill-${id}" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${color}" stop-opacity=".4"/><stop offset="1" stop-color="${color}" stop-opacity=".025"/></linearGradient></defs>${Array.from({length:5},(_,i) => `<line x1="${l}" x2="${width-r}" y1="${t+i*h/4}" y2="${t+i*h/4}" stroke="#e6eef8" stroke-width=".7"/><text class="chart-label" x="${l-14}" y="${t+i*h/4+4}" text-anchor="end">${yLabels ? yLabels[i] : Math.round(max*(1-i/4)).toLocaleString()}</text>`).join('')}${labels.map((label,i) => `<line x1="${l+i*w/labels.length}" x2="${l+i*w/labels.length}" y1="${t}" y2="${t+h}" stroke="#e6eef8" stroke-width=".7"/><text class="chart-label" x="${l+i*w/labels.length}" y="${height-4}" text-anchor="middle">${label}</text>`).join('')}<path d="${curve} L${l+w},${t+h} L${l},${t+h} Z" fill="url(#fill-${id})"/><path d="${curve}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/></svg>`;
}
function donut(parts, label, sub = '', size = 124) {
  let offset = 0;
  return `<div class="donut" style="width:${size}px;height:${size}px"><svg viewBox="0 0 120 120" aria-label="${esc(label)} ${esc(sub)}" role="img"><circle cx="60" cy="60" r="49" fill="none" stroke="#d8edff" stroke-width="11"/>${parts.map(([percent,color]) => {const circle = `<circle cx="60" cy="60" r="49" fill="none" stroke="${color}" stroke-width="11" stroke-linecap="${parts.length > 1 ? 'butt' : 'round'}" stroke-dasharray="${percent*3.078-1.5} 307.8" stroke-dashoffset="${-offset*3.078}"/>`; offset += percent; return circle;}).join('')}</svg><div class="donut-center">${label}<span>${sub}</span></div></div>`;
}
function barChart() {
  const values = [32,42,35,39,30,27,22,39,44,47,42,60,48,31,42,53,44,38,65,45,60];
  return `<svg class="bar-chart" viewBox="0 0 235 100" role="img" aria-label="费用柱状图">${[0,1,2,3].map((n,i) => `<text class="chart-label" x="0" y="${11+i*19}" style="font-size:10px">${(3-i).toFixed(1)}</text><line x1="25" x2="231" y1="${8+i*19}" y2="${8+i*19}" stroke="#eff3f8"/>`).join('')}${values.map((v,i) => `<rect x="${27+i*9.5}" y="${70-v*.75}" width="6.5" height="${v*.75}" fill="#a5d4ff"/><rect x="${27+i*9.5}" y="${70-v*.55}" width="6.5" height="${v*.55}" fill="#54afff"/><rect x="${27+i*9.5}" y="${70-v*.3}" width="6.5" height="${v*.3}" fill="#0787ff"/>`).join('')}${['05-10','05-15','05-20','05-25','05-30','06-08'].map((s,i) => `<text class="chart-label" x="${29+i*39}" y="91" text-anchor="middle" style="font-size:10px">${s}</text>`).join('')}</svg>`;
}

function renderOverview() {
  const stats = [
    ['users-round','green','在线机器人','<div class="value">2 <small>/ 2</small></div>','全部在线'],
    ['server','green','Minecraft 服务器',status('运行中'),'1.20.4&nbsp; | &nbsp;在线 3 人'],
    ['box','','模型 / API',status('正常'),'DeepSeek-R1&nbsp; | &nbsp;响应正常'],
    ['database','green','记忆系统',status('健康'),'12,450 条记忆&nbsp; | &nbsp;2.3 GB'],
    ['bell','red','近期告警','<div class="value" style="color:#e43c22">1</div>','过去 24 小时']
  ];
  return `<section class="hero"><div class="hero-art"></div><div class="hero-mask"></div><div class="hero-copy"><h1>让 AI 成为你的 Minecraft 世界中的真实队友</h1><p>基于 Mindcraft 的 Minecraft AI 队友平台，支持多智能体、长期记忆与工具调用，<br>一起探索、更高效地建造，创造属于你们的世界。</p><div class="hero-actions"><button class="hero-action primary" data-action="start-teammates">${icon('play')}<div><b>启动队友</b><span>开启 AI 队友，进入游戏世界</span></div></button><button class="hero-action" data-action="connect-server">${icon('link')}<div><b>连接服务器</b><span>配置并连接 Minecraft 服务器</span></div></button><button class="hero-action" data-action="console">${icon('terminal')}<div><b>打开控制台</b><span>查看实时运行日志</span></div></button></div></div></section>
  <section class="overview-stats">${stats.map(([i,c,t,v,d],idx) => `<article class="card overview-stat" data-action="stat" data-index="${idx}" tabindex="0" role="button">${soft(i,c)}<div><h3>${t}</h3>${v}<div class="muted">${d}</div></div><span class="icon chev">${arrow()}</span></article>`).join('')}</section>
  <section class="overview-mid"><article class="card">${cardHead('机器人概览',link('管理机器人','nav-robots'))}<table><thead><tr><th style="width:22%">名称</th><th style="width:18%">模型</th><th style="width:13%">状态</th><th style="width:27%">当前任务</th><th style="width:11%">延迟</th><th></th></tr></thead><tbody>${[['bot','DeepSeek-R1','64K','在主世界建造房屋','进行中 · 3 分钟','320 ms'],['DeepSeek','DeepSeek-V3','128K','收集橡木原木','进行中 · 12 分钟','280 ms']].map(([n,m,k,t,d,l]) => `<tr><td><div class="name-cell">${n === 'bot' ? avatar('bot',34) : sprite('overview',259,685,33,33,34)}<div><strong>${n}</strong><span class="muted">${n === 'bot' ? '通用助手' : '建筑专家'}</span></div></div></td><td><strong style="font-weight:400">${m}</strong><br><span class="muted">${k}</span></td><td>${status('在线')}</td><td><strong style="font-weight:400">${t}</strong><br><span class="muted">${d}</span></td><td><strong style="font-weight:400">${l}</strong></td><td>${dots('robot',n)}</td></tr>`).join('')}</tbody></table></article>
  <article class="card">${cardHead('工作流程',link('了解更多','workflow'))}<div class="workflow">${[['user-round','玩家消息','游戏内聊天<br>或指令'],['brain','AI 推理','理解意图<br>规划行动'],['wrench','工具执行','使用工具<br>执行任务'],['server','Minecraft 服务器','在游戏世界中<br>完成操作']].map(([i,t,d],idx) => `${idx ? `<span class="icon flow-arrow">${icon('arrow-right')}</span>` : ''}<button class="flow-step" data-action="workflow"><span class="icon">${icon(i)}</span><b>${t}</b><span>${d}</span></button>`).join('')}</div></article></section>
  <section class="overview-bottom"><article class="card">${cardHead('近期活动',link('查看全部','nav-logs'))}<div class="activity-list">${[['14:36','DeepSeek','完成了 橡木原木 ×64 的收集任务'],['14:33','bot','在主世界放置了 玻璃 ×128'],['14:29','系统','已连接到 Minecraft 服务器（1.20.4）'],['14:28','bot','开始建造 房屋（计划 8×6）'],['14:25','DeepSeek','记忆已更新：基地位置（主世界 -1024, 64, -320）']].map(([t,n,d],i) => `<div class="activity-row"><em class="dot" style="background:${i===1?'#17b56a':i===2?'#70b9ff':'#168aff'}"></em><time>${t}</time><strong>${n}</strong><span>${d}</span></div>`).join('')}</div></article>
  <article class="card api-card">${cardHead('API 使用情况',select('overview-period',['过去 24 小时','过去 7 天','过去 30 天']))}<div class="api-summary"><div><span class="small">今日总请求</span><b>18,342 <span class="tiny">↑ 12%</span></b></div></div>${lineChart([400,570,480,620,900,470,360,600,720,950,610,760,650,1150,1500,1320,1630,1410,1140,1740,1950,1480,1280],{width:424,height:134,id:'overview'})}</article>
  <article class="card">${cardHead('记忆存储',link('','nav-memory'))}<div class="storage-main">${donut([[37,'#0798ff']],'37%','已使用',121)}<div class="storage-data"><span>已使用</span><span>2.3 GB</span><span>总容量</span><span>6.0 GB</span><span>记忆条目</span><span>12,450</span><span>最后更新</span><span style="color:#8a9ebb">2024-06-18 14:36</span></div></div><div class="storage-legend"><span><em class="dot" style="background:#159bff"></em>对话记忆 62%</span><span><em class="dot" style="background:#05ad6a"></em>世界知识 24%</span><span><em class="dot" style="background:#ff7e13"></em>玩家偏好 14%</span></div></article></section>`;
}

function renderRobots() {
  const robot = state.robots.find(r => r.name === state.selectedRobot) || state.robots[0];
  const messages = [
    ['14:25','我已到达森林区域，开始寻找橡木树。当前坐标：-52，63，58。'],
    ['14:27','找到橡木树，开始砍伐。预计需要收集 32 个橡木原木。',true],
    ['14:29','已收集 18 / 32 个橡木原木，继续砍伐中。'],
    ['14:30','顺便收集一些树苗，种回去，保持可持续发展。',false,true],
    ['14:30','好的，我会在砍伐的同时收集树苗并重新种植。']
  ];
  return `${heading('机器人','管理你的 AI 队友，让它们在 Minecraft 世界中协同工作。',btn('新建机器人','new-robot','plus','primary'),false,'robot-heading')}<div class="robots-layout"><aside class="card robot-list">${cardHead(`全部机器人（${state.robots.length}）`,`<button data-action="search-robots" aria-label="查找机器人">${icon('search')}</button>`)}${state.robots.map(r => `<button class="robot-item ${r.name === robot.name ? 'active' : ''}" data-action="select-robot" data-id="${esc(r.name)}">${avatar(r.name,50)}<div><h3>${esc(r.name)}</h3>${badge(r.running?'运行中':'空闲',r.running?'':'blue',true)}<div class="muted">${esc(r.model)}<br>${esc(r.task)}</div></div><span class="latency">${r.latency} ms</span></button>`).join('')}</aside>
  <div class="robot-workspace"><section class="card robot-summary">${avatar(robot.name,64)}<div class="robot-summary-body"><div class="robot-summary-top"><div class="robot-name"><h2>${esc(robot.name)}</h2>${badge(robot.running?'运行中':'已暂停',robot.running?'':'orange',true)}</div><div class="robot-actions">${btn('启动','robot-start','play','primary')}${btn('暂停','robot-pause','pause')}${btn('召回','robot-recall','map-pin')}${btn('停止任务','robot-stop','square','danger')}</div></div><div class="robot-meta"><span>${esc(robot.model)}</span><span>Minecraft 服务器: MineServer</span><span>${icon('map-pin')} -53, 63, 56</span><span>生命&nbsp; 20/20</span><span>饱食&nbsp; 18/20</span><span style="color:#8096b8">${icon('signal')} &nbsp;${robot.latency} ms</span></div></div></section>
  <div class="robot-columns"><section class="card chat-card">${cardHead('对话与任务日志',link('查看完整日志','nav-logs'))}<div class="chat-messages" id="chat-messages">${messages.map(([time,text,photo,user]) => `<article class="message ${user?'user':''}">${user ? soft('user-round','','small-icon') : avatar(robot.name,40)}<div class="message-body"><div class="message-author">${user?'玩家 · 浩老板':esc(robot.name)}<time>${time}</time></div><div class="bubble">${text}${photo?'<div class="tree-photo" role="img" aria-label="Minecraft 森林中的橡木树"></div>':''}</div></div></article>`).join('')}${(state.customMessages[robot.name] || []).map(m => `<article class="message user">${soft('user-round','','small-icon')}<div class="message-body"><div class="message-author">玩家 · 浩老板<time>刚刚</time></div><div class="bubble">${esc(m)}</div></div></article>`).join('')}</div><form class="composer" id="message-form"><input id="message-input" type="text" placeholder="发送消息给 ${esc(robot.name)} ······" aria-label="发送消息给机器人" autocomplete="off"><button class="btn primary" type="submit">发送 ${icon('arrow-right')}</button></form></section>
  <aside class="robot-right"><section class="card task-card">${cardHead('当前任务',badge(robot.running?'进行中':'已暂停',robot.running?'blue':'orange'))}<div class="task-title">${avatar('log',40)}<div><b>${robot.name === 'DeepSeek' ? '收集橡木原木' : esc(robot.task)}</b><p>在附近森林收集 32 个橡木原木，用于建造生存小屋。</p></div></div><div class="progress-line"><i></i><span>56%</span></div><span class="muted small">进度: 18 / 32</span><div class="task-steps">${[['前往森林区域','14:25','done'],['寻找橡木树','14:26','done'],['砍伐并收集橡木原木 (18 / 32)',robot.running?'进行中':'已暂停','current'],['收集树苗并重新种植','待开始',''],['返回基地并交付物资','待开始','']].map(([s,t,c])=>`<div class="task-step ${c}"><span class="step-circle ${c}">${c==='done'?icon('check'):''}</span><span>${s}</span><span>${t}</span></div>`).join('')}</div><div class="task-time">${icon('clock-3')}预计完成时间&nbsp;&nbsp; 约 8 分钟 （14:38）</div></section>
  <section class="card inventory-card">${cardHead('背包与装备',link('查看详情','inventory'))}<div class="inventory">${[1131,1184,1237,1290,1343,1396,1449,1502].map(x=>`<button class="inventory-slot" aria-label="背包物品" data-action="inventory"><img alt="" src="../assets/reference/robots.png" style="left:${-x}px;top:-744px"></button>`).join('')}</div></section>
  <section class="card world-card">${cardHead('世界状态',`<span class="muted small">${icon('rotate-cw')} 14:30 更新</span>`)}<div class="world-data">${[['map-pin','位置','-52, 63, 58'],['sun','时间','白天 (6000)'],['sprout','生物群系','森林 (Forest)'],['cloud','天气','晴朗'],['circle-dot','维度','主世界 (Overworld)'],['triangle','难度','普通']].map(([i,l,v])=>`<div>${icon(i)}<label>${l}</label><span>${v}</span></div>`).join('')}</div></section></aside></div></div></div>`;
}

function modelRows() {
  const p = providers.find(p=>p.id === state.selectedProvider);
  const models = modelData[p.id].filter(m => m[0].toLowerCase().includes(state.modelSearch.toLowerCase()) && (state.modelAbility === '全部能力' || m[4].includes(state.modelAbility)));
  return models.map(([name,delay,context,price,abilities])=>`<tr><td><strong>${name}</strong></td><td><div class="model-provider">${pImage(p.id === 'deepseek' ? 'deepseek' : p.id)}${p.name.split(' ')[0]}</div></td><td>${delay} ms</td><td>${context}</td><td><span class="tag ${price==='低'?'green':'orange'}" style="min-width:47px;text-align:center">${price}</span></td><td>${tags(abilities)}</td><td>${status('可用')}</td><td>${btn('分配','assign-model','','primary sm',`data-id="${name}"`)} ${dots('model',name)}</td></tr>`).join('') || '<tr><td colspan="8" class="empty-state">没有找到匹配的模型</td></tr>';
}
function renderModels() {
  const p = providers.find(p => p.id === state.selectedProvider);
  const metrics = [['server','','已配置提供商','5','↑ +0','DeepSeek / 豆包 / OpenAI / 智谱 / Ollama'],['box','','可用模型总数','12','↑ +2','覆盖多种能力与尺寸'],['file-text','','本月 Token 使用','18.34 M','↑ +12%','上月 16.32 M'],['coins','orange','预估本月费用','¥ 24.60','↓ -18%','上月 ¥ 30.12']];
  return `${heading('模型中心','管理 AI 模型提供商与模型配置，为你的机器人选择最合适的模型。',btn('添加模型提供商','new-provider','plus','primary'))}<section class="metric-grid">${metrics.map(([i,c,t,v,trend,sub])=>`<article class="card metric-card">${soft(i,c)}<div><h3>${t}</h3><div class="metric-value"><b>${v}</b><span>${trend}</span></div><p>${sub}</p></div></article>`).join('')}</section><div class="models-layout"><aside class="card providers">${cardHead('模型提供商',btn('添加','new-provider','plus','sm'))}${providers.map(p=>`<button class="provider-row ${p.id===state.selectedProvider?'active':''}" data-action="provider" data-id="${p.id}">${providerIcon(p.id)}<div class="provider-name"><h3>${p.name}</h3><p>${p.url}</p></div><div class="provider-health">${status('在线')}<span>${p.count} 个模型</span></div><span class="icon">${arrow()}</span></button>`).join('')}</aside>
  <div class="models-right"><section class="card model-list">${cardHead(`模型列表（${p.name.split(' ')[0]}）`,`<div class="tools">${select('model-ability',['全部能力','推理','代码','数学','通用','对话','工具','中文'])}${search('搜索模型名称...','model-search',state.modelSearch)}</div>`)}<table><thead><tr><th style="width:15%">模型名称</th><th style="width:14%">提供商</th><th style="width:12%">响应延迟</th><th style="width:12%">上下文长度</th><th style="width:12%">价格档位</th><th style="width:17%">能力标签</th><th style="width:9%">状态</th><th style="width:12%">操作</th></tr></thead><tbody id="model-rows">${modelRows()}</tbody></table></section>
  <div class="model-bottom"><section class="card routing">${cardHead('机器人模型路由规则',link('管理规则','routing'))}${[['box','默认对话','日常聊天与一般任务','DeepSeek-V3'],['brain','复杂推理','需要深度思考的任务','DeepSeek-R1'],['braces','代码生成','编程与脚本生成','DeepSeek-Coder'],['wrench','工具调用','插件与 API 调用','DeepSeek-Chat']].map(([i,t,s,m])=>`<div class="route-row">${soft(i)}<div class="route-text"><b>${t}</b><span>${s}</span></div><span class="icon route-arrow">${icon('arrow-right')}</span><button class="route-model" data-action="routing">${pImage()}${m}</button></div>`).join('')}</section>
  <section class="card parameters">${cardHead('模型参数配置')}<label class="parameter">预设模板 ${select('parameter-template',['平衡（推荐）','创造力优先','精确执行'])}</label><div style="height:12px"></div>${[['温度 (Temperature)','temperature',0,2,.1,.7],['最大输出长度','max-output',256,8192,256,4096],['Top P','top-p',0,1,.1,.9]].map(([name,id,min,max,step,value])=>`<label class="parameter">${name}<input type="number" id="${id}-number" value="${value}" min="${min}" max="${max}" step="${step}" aria-label="${name}"></label><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}" style="--fill:${(value-min)/(max-min)*100}%" aria-label="${name}滑块">`).join('')}<button class="link" data-action="advanced">高级参数 ${icon('chevron-down')}</button></section>
  <section class="card usage">${cardHead('使用情况与费用',`<div class="segment">${['7 天','30 天','90 天'].map(t=>`<button data-action="usage-period" data-id="${t}" class="${state.usagePeriod===t?'active':''}">${t}</button>`).join('')}</div>`)}<div class="usage-summary"><span>Token 使用量</span><span><b>${state.usagePeriod==='7 天'?'4.28 M':state.usagePeriod==='90 天'?'52.16 M':'18.34 M'}</b><span class="green">↑ 12%</span></span></div>${lineChart([230,370,320,500,390,330,580,370,360,520,480,620,710,680,650,710,870,680,850,770,690,820,970,900,810,750],{width:340,height:106,max:1000,yLabels:['1.0M','800K','600K','400K','0'],labels:['05-10','05-15','05-20','05-25','05-30','06-08'],id:'token'})}<div class="usage-summary"><span>费用估算（元）</span><span><b>24.60</b><span class="green">↓ 18%</span></span></div><div class="bar-layout">${barChart()}<div class="chart-key">${[['DeepSeek','52%','#118dff'],['豆包','24%','#52a9ff'],['OpenAI','16%','#79b9ff'],['智谱 GLM','6%','#a2cdff'],['Ollama','2%','#bddcff']].map(([t,v,c])=>`<span><em class="dot" style="background:${c}"></em>${t}&nbsp;&nbsp; ${v}</span>`).join('')}</div></div></section></div></div></div>`;
}

const requests = [
  [1242,'14:36:12','成功','对话','玩家: 谁摔死了？\\n...','320 ms','1.2K'],
  [1241,'14:34:08','成功','工具调用','调用: get_position()','280 ms','0.6K'],
  [1240,'14:33:15','成功','对话','继续收集附近的土豆...','450 ms','1.8K'],
  [1239,'14:31:22','部分成功','工具调用','调用: dig (x=-53, y=63...)','620 ms','1.1K'],
  [1238,'14:28:47','成功','对话','已完成一轮采集，准...','390 ms','1.5K']
];
function memoryRows() {
  let items = state.memories.map((m,i)=>({...m,index:i}));
  if (state.memoryTab > 0 && state.memoryTab < 4) items = items.filter(m=>m.category===state.memoryTab);
  if (state.memorySearch) items = items.filter(m=>(m.title+m.description+m.tags.join('')).includes(state.memorySearch));
  if (state.memoryType !== '全部类型') items = items.filter(m=>m.type===state.memoryType);
  if (state.memorySort === '最早优先') items.reverse();
  return items.map(m=>`<article class="memory-row ${state.selectedMemory===m.index?'active':''}" data-action="select-memory" data-id="${m.index}" role="button" tabindex="0">${soft(m.icon,m.color)}<div class="memory-row-body"><div class="memory-row-title"><b>${esc(m.title)}</b>${badge(m.type,m.category===1?'':m.category===2?'purple':m.category===3?'orange':'blue')}</div><p>${esc(m.description)}</p>${tags(m.tags,'gray')}</div><time>今天 ${m.time}</time>${dots('memory',m.index)}</article>`).join('') || '<div class="empty-state">没有找到匹配的记忆</div>';
}
function requestRows() {
  return requests.map(([id,time,s,t,preview,latency,tokens])=>`<tr class="${id===state.selectedRequest?'selected':''}" data-action="request" data-id="${id}"><td><strong style="font-weight:400">${id}</strong></td><td>${time}</td><td>${status(s,s==='成功'?'':'warn')}</td><td><strong style="font-weight:400">${t}</strong></td><td>${preview}</td><td>${latency}</td><td>${tokens}</td></tr>`).join('');
}
function renderMemory() {
  const request = requests.find(r=>r[0]===state.selectedRequest) || requests[0];
  const detailRows = [
    ['settings','系统提示词','你是一个在 Minecraft 世界中生存的 AI 队友。你的目标是与玩家合作完成生存、建造和探索任务。…'],
    ['user-round','用户消息',request[0]===1242?'玩家: 谁摔死了？':request[4]],
    ['wrench','工具调用结果',request[3]==='工具调用'?'示例结果：{ x: -53, y: 63, z: 56 }':'（未调用工具）'],
    ['message-square-more','助手回复',request[0]===1242?'DeepSeek 摔死了，还嘴硬。':'已记录任务结果，继续完成当前工作。']
  ];
  return `${heading('记忆','查看和管理 AI 的记忆内容，包括工作上下文、短期记忆、长期记忆和核心摘要。',`<div class="tools"><button class="btn" data-action="memory-robot" style="height:42px;width:223px;justify-content:flex-start">${avatar('DeepSeek',34)}<span style="color:#173564">DeepSeek / bot</span><span style="margin-left:auto">${icon('chevron-down')}</span></button>${search('搜索记忆内容、关键词或标签...','memory-search',state.memorySearch)}</div>`,true)}
  <div class="memory-tools"><div class="tabs">${['近期工作上下文','短期记忆','长期记忆','核心摘要','API 请求日志'].map((t,i)=>`<button class="tab ${state.memoryTab===i?'active':''}" data-action="memory-tab" data-id="${i}">${t}</button>`).join('')}</div><div class="tools">${select('memory-type',['全部类型','近期上下文','短期记忆','长期记忆','核心摘要'])}${select('memory-time',['全部时间','今天','最近 7 天','最近 30 天'])}${btn('刷新','refresh-memory','refresh-cw')}</div></div>
  <div class="memory-top"><section class="card memory-list">${cardHead('记忆列表（12）',`<div class="tools">${select('memory-sort',['最新优先','最早优先'])}${btn('添加记忆','new-memory','plus','primary sm')}</div>`)}<div id="memory-rows" style="display:flex;flex:1;min-height:0;flex-direction:column">${memoryRows()}</div></section>
  <div class="memory-api"><section class="card api-log">${cardHead('API 请求日志',link('查看全部','all-requests'))}<table><thead><tr><th style="width:9%">#</th><th style="width:12%">时间</th><th style="width:13%">状态</th><th style="width:13%">类型</th><th>请求预览</th><th style="width:15%">耗时</th><th style="width:11%">Tokens</th></tr></thead><tbody>${requestRows()}</tbody></table></section>
  <section class="card api-detail">${cardHead(`请求详情&nbsp;&nbsp; #${request[0]} ${badge(request[2],request[2]==='成功'?'':'orange',true)}`,`<span class="muted">请求时间: 2024-06-18 ${request[1]} &nbsp; | &nbsp; 耗时: ${request[5]} &nbsp; | &nbsp; Tokens: 1,248</span>`)}<div class="prompt-box">${detailRows.map(([i,t,c])=>`<div class="prompt-row"><span class="prompt-label">${icon(i)}${t}</span><div class="prompt-content"><span>${esc(c)}</span><button data-action="copy" data-text="${esc(c)}" aria-label="复制${t}">${icon('file-copy')}</button></div></div>`).join('')}</div></section></div></div>
  <div class="memory-bottom"><section class="card">${cardHead('记忆存储分布')}<div class="memory-storage">${donut([[37,'#1197ff'],[26,'#21c4a3'],[18,'#9870ef'],[12,'#ffb13c'],[7,'#b0bfd1']],'2.3 GB','总计',135)}<div class="memory-storage-key">${[['近期工作上下文','37%','0.85 GB','#168aff'],['短期记忆','26%','0.60 GB','#0dbc8f'],['长期记忆','18%','0.42 GB','#9567f2'],['核心摘要','12%','0.28 GB','#ffab34'],['其他','7%','0.15 GB','#95aaca']].map(([t,p,v,c])=>`<span><em class="dot" style="background:${c}"></em>${t}</span><b>${p}</b><span>${v}</span>`).join('')}</div></div></section>
  <section class="card memory-frequency">${cardHead('记忆更新频率','<span class="muted">最近 24 小时</span>')}<div class="chart-tooltip"><small>14:00 - 15:00</small><br><b>156 次更新</b></div>${lineChart([25,55,72,68,92,110,81,58,71,48,83,104,95,114,103,118,136,141,134,156,151,141,139,149,170,177,155,124,101,94,112,129,119,101],{width:640,height:133,max:200,id:'memory'})}</section></div>`;
}

const events = [
  ['14:36','机器人','DeepSeek 完成了 橡木原木 ×64 的收集任务',''],
  ['14:33','系统','MineServer 连接已恢复，耗时 12.4 秒',''],
  ['14:29','插件','寻路插件 已更新到 v1.0.3',''],
  ['14:28','机器人','发现钻石矿脉，已标记位置 (-1024, 64, -320)',''],
  ['14:25','系统','模型服务响应时间升高（320 ms）',''],
  ['14:18','警告','机器人 bot-2 饥饿值过低，已触发自动进食','warn'],
  ['14:12','系统','已自动重启机器人 bot-2（退出码 0）','']
];
const recoveries = [['06-18 14:12','机器人重启','bot-2 自动重启'],['06-18 02:36','服务重启','MindServer 计划重启'],['06-17 18:20','机器人恢复','bot-1 崩溃后自动恢复'],['06-17 09:14','服务重启','应用更新后重启'],['06-16 22:11','机器人重启','内存占用过高']];
const updates = [['06-17 09:14','应用更新','v0.1.0 Beta'],['06-16 20:33','插件更新','寻路插件 v1.0.3'],['06-15 11:26','模型更新','DeepSeek-R1'],['06-15 08:44','插件安装','联网搜索插件 v1.1.0'],['06-14 19:20','配置更新','系统配置']];
function systemTabs() {
  return `<div class="tabs system-tabs">${[['plug','运行概览'],['box','插件管理'],['file-text','事件日志'],['refresh-cw','更新与诊断']].map(([i,t],n)=>`<button class="tab ${state.systemTab===n?'active':''}" data-action="system-tab" data-id="${n}">${icon(i)}${t}</button>`).join('')}</div>`;
}
function pluginRows() {
  return state.plugins.map((p,i)=>`<tr><td><div class="plugin-name">${soft(p.icon,p.color)}<strong>${p.name}</strong></div></td><td>${p.version}</td><td>${p.description}</td><td>${status(p.enabled?'运行中':'已暂停',p.enabled?'':'warn')}</td><td><button class="switch ${p.enabled?'on':''}" data-action="toggle-plugin" data-id="${i}" role="switch" aria-label="${p.name}" aria-checked="${p.enabled}"></button></td><td>${btn('配置','configure-plugin','','ghost sm',`data-id="${i}"`)}</td><td>${dots('plugin',i)}</td></tr>`).join('');
}
function pluginTable(full = false) {
  return `<section class="card ${full?'plugin-full':'plugin-card'}">${cardHead('插件管理',`<div class="tools">${link('查看插件市场','plugin-market')}${btn('安装插件','install-plugin','plus','primary')}</div>`)}<table><thead><tr><th style="width:20%">插件名称</th><th style="width:11%">版本</th><th>功能描述</th><th style="width:14%">状态</th><th style="width:12%">启用</th><th style="width:11%">操作</th><th style="width:5%"></th></tr></thead><tbody>${pluginRows()}</tbody></table></section>`;
}
function smallHistory(title, rows) {
  return `<section class="card">${cardHead(title,link('查看全部','history',`data-id="${title}"`))}<table><thead><tr><th style="width:22%">时间</th><th style="width:22%">类型</th><th style="width:42%">${title==='更新操作记录'?'版本 / 详情':'详情'}</th><th style="width:14%">状态</th></tr></thead><tbody>${rows.map(([t,k,d])=>`<tr><td>${t}</td><td>${k}</td><td>${d}</td><td>${status('成功')}</td></tr>`).join('')}</tbody></table></section>`;
}
function renderSystem() {
  if (state.systemTab === 1) return `${systemHeading()}${systemTabs()}${pluginTable(true)}`;
  if (state.systemTab === 2) return `${systemHeading()}${systemTabs()}${renderLogTable()}`;
  if (state.systemTab === 3) return `${systemHeading()}${systemTabs()}${renderDiagnostics()}`;
  const stats = [
    ['monitor','','桌面应用',status('运行中'),'v0.1.0 Beta&nbsp; | &nbsp;运行 2 天 6 小时'],
    ['server','green','MindServer',status('运行中'),'v1.2.1&nbsp; | &nbsp;端口 8080'],
    ['bot','','机器人进程','<div class="large-value">2 <small>/ 2</small></div>','2 个运行中&nbsp; | &nbsp;0 个异常'],
    ['grass','','Minecraft 连接',status('已连接'),'Fabric 1.21.6&nbsp; | &nbsp;延迟 28 ms'],
    ['brain','purple','模型服务',status('正常'),'DeepSeek-R1&nbsp; | &nbsp;响应 320 ms']
  ];
  return `${systemHeading()}${systemTabs()}<section class="system-stats">${stats.map(([i,c,t,s,d])=>`<article class="card system-stat">${i==='grass'?avatar('grass',50):soft(i,c)}<div><h3>${t}</h3>${s}<p>${d}</p></div></article>`).join('')}</section><div class="system-mid">${pluginTable()}<section class="card architecture">${cardHead('系统架构与连接',link('查看详情','architecture'))}<div class="architecture-diagram"><div class="arch-node"><div class="brand-fish"></div><b>MineFish<br>桌面应用</b><span>v0.1.0 Beta<br>Windows 11</span></div><span class="icon arch-arrow">${icon('arrow-right')}</span><div class="arch-node">${icon('server')}<b>MindServer<br>本地服务</b><span>v1.2.1<br>端口 8080</span></div><div class="arch-branches"><svg class="branch-lines" viewBox="0 0 40 224"><path d="M-18 112H8V34Q8 20 20 20H36 M8 112H36 M8 112V186Q8 204 20 204H36" fill="none" stroke="#4981c7" stroke-width="1.5" stroke-dasharray="6 4"/><path d="M31 16L36 20L31 24 M31 108L36 112L31 116 M31 200L36 204L31 208" fill="none" stroke="#4981c7" stroke-width="1.5"/></svg><div class="branch-nodes"><div class="branch-node">${soft('users-round')}<div><b><em class="dot"></em>机器人进程</b><p>2 / 2 运行中</p></div></div><div class="branch-node">${avatar('grass',38)}<div><b><em class="dot"></em>Minecraft 服务器</b><p>已连接 (Fabric 1.21.6)</p></div></div><div class="branch-node">${soft('brain','purple')}<div><b><em class="dot"></em>模型服务</b><p>DeepSeek-R1<br>响应 320 ms</p></div></div></div></div></div><div class="environment-head">运行环境信息<button class="link" data-action="copy-environment">${icon('copy')}复制信息</button></div><div class="environment-data">${[['操作系统','Windows 11 23H2','安装目录','D:\\MineFish'],['Java','21.0.2 (Temurin)','数据目录','D:\\MineFish\\data'],['Minecraft','Fabric 1.21.6','日志目录','D:\\MineFish\\logs'],['内存使用','6.2 GB / 16 GB (38%)','配置文件','D:\\MineFish\\config']].map(row=>row.map((v,i)=>i%2?`<span>${v}</span>`:`<label>${v}</label>`).join('')).join('')}</div></section></div><div class="system-bottom"><section class="card">${cardHead('最近事件与告警',link('查看全部','nav-logs'))}<div class="event-list">${events.map(([t,k,d,c])=>`<div class="event-row ${c}"><em class="dot"></em><time>${t}</time><span class="kind" style="color:${k==='插件'||k==='机器人'||t==='14:12'?'#168aff':''}">${k}</span><span>${d}</span></div>`).join('')}</div></section>${smallHistory('重启与恢复记录',recoveries)}${smallHistory('更新操作记录',updates)}</div>`;
}
function systemHeading() {return heading('系统管理','管理 MineFish 的运行状态、插件、日志和系统设置，确保 AI 队友稳定高效地运行。','',true);}
function renderLogTable() {
  const rows = [...events,...events.map(e=>['13:'+e[0].split(':')[1],...e.slice(1)])].filter(r=>(r.join('')).toLowerCase().includes(state.logSearch.toLowerCase()));
  return `<section class="card logs-full">${cardHead('事件日志',`<div class="log-filters">${select('log-kind',['全部级别','信息','警告'])}${search('搜索日志内容...','log-search',state.logSearch)}${btn('导出演示日志','export-logs','download','sm')}</div>`)}<table><thead><tr><th style="width:12%">时间</th><th style="width:12%">来源</th><th style="width:12%">级别</th><th>事件内容</th></tr></thead><tbody id="log-rows">${rows.map(([t,k,d,c])=>`<tr data-level="${c?'警告':'信息'}"><td>2024-06-18 ${t}</td><td>${k}</td><td>${badge(c?'警告':'信息',c?'orange':'blue')}</td><td>${d}</td></tr>`).join('')}</tbody></table></section>`;
}
function renderDiagnostics() {
  return `<section class="card diagnostics">${cardHead('更新与诊断',btn('运行本地检查','run-diagnostics','stethoscope','primary'))}<div class="diagnostic-grid">${[['monitor','桌面前端','v0.1.0 Beta · 界面资源已就绪'],['package-check','本地资源','图标、场景和示例数据已内置'],['bot','演示机器人','4 个示例机器人可供切换'],['database','记忆演示','记忆与 API 请求样例已加载']].map(([i,t,d])=>`<article class="diagnostic-box">${soft(i)}<div><h3>${t}</h3><p>${d}</p></div><span style="margin-left:auto">${status('正常')}</span></article>`).join('')}</div><div class="diagnostic-note">当前为纯前端演示版本。这里的服务状态、模型用量、游戏连接和日志均为参考图对应的示例数据；应用未连接后端或外部服务。</div></section>`;
}

const navigation = [['overview','house','总览'],['robots','bot','机器人'],['models','box','模型'],['memory','database','记忆'],['logs','file-text','日志'],['plugins','puzzle','插件'],['system','settings','系统']];
function refreshIcons() { if (window.lucide) lucide.createIcons({ attrs:{'stroke-width':2} }); }
function render() {
  $('#app').className = 'page-'+state.page;
  $('#navigation').innerHTML = navigation.map(([p,i,t])=>`<button class="nav-item ${state.page===p?'active':''}" data-page="${p}" ${state.page===p?'aria-current="page"':''}>${icon(i)}<span>${t}</span></button>`).join('');
  const renderers = {overview:renderOverview,robots:renderRobots,models:renderModels,memory:renderMemory,system:renderSystem,plugins:()=>`${heading('插件管理','管理机器人的技能与扩展，让 AI 队友在 Minecraft 世界中完成更多任务。')}${pluginTable(true)}`,logs:()=>`${heading('事件日志','查看机器人、模型与系统的运行日志和最近活动。')}${renderLogTable()}`};
  $('#content').innerHTML = renderers[state.page]();
  if (state.page==='models') $('#model-ability').value=state.modelAbility;
  if (state.page==='memory') {$('#memory-type').value=state.memoryType;$('#memory-time').value=state.memoryTime;$('#memory-sort').value=state.memorySort;}
  refreshIcons();
}
function navigate(page) {
  if (!navigation.some(n=>n[0]===page)) return;
  state.page=page;
  if (page==='system') state.systemTab=0;
  $('#modal-layer').innerHTML='';
  $$('.menu-pop').forEach(el=>el.remove());
  render();
}
function resize() {
  const s=Math.min(window.innerWidth/1586,window.innerHeight/992);
  $('#app').style.transform=`scale(${s})`;
  $('#app').style.width=`${window.innerWidth/s}px`;
  $('#app').style.height=`${window.innerHeight/s}px`;
}
let toastTimer;
function toast(text) {$('#toast').textContent=text;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3000);}
function modal(title,body,submitLabel='保存',submitAction='save-demo') {
  $('#modal-layer').innerHTML=`<div class="modal-overlay"><form class="modal" id="modal-form" data-submit="${submitAction}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><h2 id="modal-title">${title}</h2><button type="button" class="modal-close" data-action="close-modal" aria-label="关闭弹窗">${icon('x')}</button></div><div class="modal-body">${body}</div><div class="modal-footer">${btn('取消','close-modal')}<button class="btn primary" type="submit">${submitLabel}</button></div></form></div>`;
  $$('.modal .btn[data-action]').forEach(b=>b.type='button');refreshIcons();setTimeout(()=>$('.modal input, .modal select, .modal textarea, .modal-close')?.focus(),30);
}
const field=(name,label,value='',type='text',placeholder='')=>`<label class="field">${label}<input name="${name}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${name==='name'?'required maxlength="40"':''}></label>`;
const localNote='<div class="local-note">纯前端演示：仅更新本次界面中的示例状态，不连接任何后端服务。</div>';

function action(name, element) {
  const id=element?.dataset.id;
  if(name.startsWith('nav-')) return navigate(name.slice(4));
  switch(name) {
    case 'start-teammates': state.robots[0].running=true;state.robots[1].running=true;navigate('robots');toast('AI 队友已启动（本地演示）');break;
    case 'connect-server':modal('连接 Minecraft 服务器',field('host','服务器地址','localhost')+field('port','端口','25565','number')+`<label class="field">游戏版本${select('game-version',['Fabric 1.21.6','1.20.4','1.21.1'])}</label>`+localNote,'连接','connect-demo');break;
    case 'console':navigate('logs');break;
    case 'stat':navigate(['robots','system','models','memory','logs'][Number(element.dataset.index)]);break;
    case 'workflow':modal('工作流程','<p>玩家在游戏中发出消息，AI 理解任务、规划步骤，再通过工具执行采集、建造和探索。任务结果会记录在对话与记忆中。</p>'+localNote,'知道了','dismiss');break;
    case 'new-robot':modal('新建机器人',field('name','机器人名称','','text','为你的 AI 队友起个名字')+`<label class="field">使用模型<select name="model">${Object.values(modelData).flat().map(m=>`<option>${m[0]}</option>`).join('')}</select></label>`+localNote,'创建机器人','create-robot');break;
    case 'search-robots':modal('查找机器人',`<label class="field">选择机器人<select name="robot">${state.robots.map(r=>`<option>${esc(r.name)}</option>`).join('')}</select></label>`,'查看','find-robot');break;
    case 'select-robot':state.selectedRobot=id;render();break;
    case 'robot-start':case 'robot-pause':case 'robot-stop':case 'robot-recall':{
      const r=state.robots.find(r=>r.name===state.selectedRobot);r.running=name==='robot-start'||name==='robot-recall';if(name==='robot-stop')r.task='待命中';if(name==='robot-recall')r.task='正在返回基地';render();toast(({ 'robot-start':'机器人已启动','robot-pause':'当前任务已暂停','robot-stop':'当前任务已停止','robot-recall':'机器人正在返回基地' })[name]+'（本地演示）');break;}
    case 'inventory':modal('背包与装备',`<p>橡木原木 ×18、橡树树苗 ×4、圆石 ×64、泥土 ×32、石斧、石镐、石铲、火把 ×12。</p>`+localNote,'关闭','dismiss');break;
    case 'provider':state.selectedProvider=id;state.modelSearch='';state.modelAbility='全部能力';render();break;
    case 'new-provider':modal('添加模型提供商',`<label class="field">提供商<select name="provider">${providers.map(p=>`<option>${p.name}</option>`).join('')}</select></label>`+field('endpoint','API 地址','','text','https://api.example.com')+field('key','API Key（演示输入，不会保存）','','password','输入演示密钥')+localNote,'添加','save-demo');break;
    case 'assign-model':modal(`分配模型 · ${esc(id)}`,`<label class="field">选择机器人<select name="robot">${state.robots.map(r=>`<option>${esc(r.name)}</option>`).join('')}</select></label><input type="hidden" name="model" value="${esc(id)}">`+localNote,'确认分配','assign-demo');break;
    case 'routing':modal('机器人模型路由规则',`<label class="field">任务类型<select name="task"><option>默认对话</option><option>复杂推理</option><option>代码生成</option><option>工具调用</option></select></label><label class="field">路由模型<select name="route">${modelData.deepseek.map(m=>`<option>${m[0]}</option>`).join('')}</select></label>`+localNote,'保存规则','save-demo');break;
    case 'advanced':modal('高级模型参数',field('penalty','频率惩罚','0','number')+field('presence','存在惩罚','0','number')+localNote);break;
    case 'usage-period':state.usagePeriod=id;render();break;
    case 'memory-tab':state.memoryTab=Number(id);render();if(state.memoryTab===4)toast('API 请求日志已显示在右侧');break;
    case 'select-memory':state.selectedMemory=Number(id);render();break;
    case 'memory-robot':modal('选择记忆所属机器人',`<label class="field">机器人<select name="robot"><option>DeepSeek / bot</option>${state.robots.map(r=>`<option>${esc(r.name)}</option>`).join('')}</select></label>`,'选择','save-demo');break;
    case 'new-memory':modal('添加记忆',field('name','记忆标题')+`<label class="field">记忆类型<select name="type"><option>近期上下文</option><option>短期记忆</option><option>长期记忆</option><option>核心摘要</option></select></label><label class="field">内容<textarea name="content" required placeholder="输入需要记住的内容"></textarea></label>`+localNote,'添加记忆','create-memory');break;
    case 'refresh-memory':render();toast('记忆列表已刷新');break;
    case 'request':state.selectedRequest=Number(id);render();break;
    case 'all-requests':state.memoryTab=4;render();toast('当前显示 5 条示例 API 请求');break;
    case 'system-tab':state.systemTab=Number(id);state.logSearch='';render();break;
    case 'toggle-plugin':state.plugins[Number(id)].enabled=!state.plugins[Number(id)].enabled;render();break;
    case 'configure-plugin':modal(`配置 · ${state.plugins[Number(id)].name}`,`<label class="field">执行模式<select><option>自动（推荐）</option><option>手动触发</option></select></label>`+field('interval','执行间隔（秒）','5','number')+localNote);break;
    case 'plugin-market':case 'install-plugin':modal('安装插件',`<label class="field">可用演示插件<select name="plugin"><option>自动种植插件</option><option>建筑蓝图插件</option><option>物品整理插件</option></select></label>`+localNote,'安装演示插件','install-demo');break;
    case 'architecture':modal('系统架构与连接','<p>MineFish 桌面应用 → MindServer 本地服务 → 机器人进程、Minecraft 服务器与模型服务。</p>'+localNote,'关闭','dismiss');break;
    case 'copy-environment':copyText('MineFish v0.1.0 Beta | Windows 11 23H2 | Java 21.0.2 | Minecraft Fabric 1.21.6 | 纯前端示例数据');break;
    case 'copy':copyText(element.dataset.text);break;
    case 'history':modal(id,`<p>${(id==='更新操作记录'?updates:recoveries).map(r=>r.join(' · ')).join('<br>')}</p>`,'关闭','dismiss');break;
    case 'run-diagnostics':toast('本地界面检查完成：资源与演示数据均已就绪');break;
    case 'export-logs':{
      const blob=new Blob(['时间,来源,内容\n'+events.map(r=>r.slice(0,3).join(',')).join('\n')],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='MineFish-演示日志.csv';a.click();URL.revokeObjectURL(url);toast('演示日志已导出');break;}
    case 'more':openMenu(element);break;
    case 'view-memory':{
      const m=state.memories[Number(id)];modal(esc(m.title),`<p>${esc(m.description)}</p>${tags(m.tags)}`,'关闭','dismiss');break;}
    case 'close-modal':$('#modal-layer').innerHTML='';break;
    default:toast('设置已更新（本地演示）');
  }
}
function copyText(text) {navigator.clipboard?.writeText(text).then(()=>toast('已复制到剪贴板')).catch(()=>toast('当前环境无法写入剪贴板'));}
function openMenu(element) {
  $$('.menu-pop').forEach(el=>el.remove());
  const kind=element.dataset.kind,id=element.dataset.id;
  if(kind==='robot') {state.selectedRobot=id;navigate('robots');return;}
  if(kind==='model') {action('assign-model',element);return;}
  if(kind==='plugin') {action('configure-plugin',element);return;}
  if(kind==='memory') {action('view-memory',element);}
}

document.addEventListener('click',event=>{
  const control=event.target.closest('[data-window]');if(control){window.desktop?.windowControl(control.dataset.window);return;}
  const nav=event.target.closest('[data-page]');if(nav){navigate(nav.dataset.page);return;}
  const el=event.target.closest('[data-action]');if(el){action(el.dataset.action,el);return;}
  if(event.target.classList.contains('modal-overlay'))$('#modal-layer').innerHTML='';
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){$('#modal-layer').innerHTML='';$$('.menu-pop').forEach(el=>el.remove());}
  if((e.key==='Enter'||e.key===' ')&&e.target.matches('article[data-action]')){e.preventDefault();action(e.target.dataset.action,e.target);}
  if(e.key==='Tab'&&$('.modal')){
    const focusable=$$('button,input,select,textarea',$('.modal')).filter(el=>!el.disabled&&el.type!=='hidden');const first=focusable[0],last=focusable.at(-1);
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
  }
});
document.addEventListener('input',e=>{
  const el=e.target;
  if(el.id==='model-search'){state.modelSearch=el.value;$('#model-rows').innerHTML=modelRows();refreshIcons();}
  if(el.id==='memory-search'){state.memorySearch=el.value;$('#memory-rows').innerHTML=memoryRows();refreshIcons();}
  if(el.id==='log-search'){state.logSearch=el.value;const rows=$$('.logs-full tbody tr');rows.forEach(row=>row.hidden=!row.textContent.toLowerCase().includes(el.value.toLowerCase()));}
  if(el.type==='range') {const number=$('#'+el.id+'-number');if(number)number.value=el.value;el.style.setProperty('--fill',(el.value-el.min)/(el.max-el.min)*100+'%');}
  if(el.type==='number'&&el.id.endsWith('-number')) {const range=$('#'+el.id.replace('-number',''));if(range){range.value=el.value;range.style.setProperty('--fill',(range.value-range.min)/(range.max-range.min)*100+'%');}}
});
document.addEventListener('change',e=>{
  const {id,value}=e.target;
  if(id==='model-ability'){state.modelAbility=value;$('#model-rows').innerHTML=modelRows();refreshIcons();}
  if(['memory-type','memory-sort','memory-time'].includes(id)){state[({'memory-type':'memoryType','memory-sort':'memorySort','memory-time':'memoryTime'})[id]]=value;$('#memory-rows').innerHTML=memoryRows();refreshIcons();}
  if(id==='parameter-template') {const v=value==='创造力优先'?1.2:value==='精确执行'?.2:.7;$('#temperature').value=v;$('#temperature-number').value=v;$('#temperature').dispatchEvent(new Event('input',{bubbles:true}));toast('模型参数预设已切换');}
  if(id==='log-kind')$$('.logs-full tbody tr').forEach(row=>row.hidden=value!=='全部级别'&&row.dataset.level!==value);
  if(id==='overview-period')toast('使用情况时间范围已切换（示例数据）');
});
document.addEventListener('submit',e=>{
  e.preventDefault();
  if(e.target.id==='message-form') {
    const input=$('#message-input'),text=input.value.trim();if(!text)return;
    (state.customMessages[state.selectedRobot] ||= []).push(text);render();$('#chat-messages').scrollTop=$('#chat-messages').scrollHeight;$('#message-input').focus();toast('消息已加入本地演示对话');return;
  }
  if(e.target.id!=='modal-form')return;
  const data=Object.fromEntries(new FormData(e.target)),kind=e.target.dataset.submit;
  if(kind==='create-robot') {
    if(state.robots.some(r=>r.name===data.name)){toast('该机器人名称已存在');return;}
    state.robots.push({name:data.name,model:data.model,latency:0,task:'待命中',running:false});state.selectedRobot=data.name;state.page='robots';
  }
  if(kind==='find-robot'){state.selectedRobot=data.robot;state.page='robots';}
  if(kind==='assign-demo'){state.robots.find(r=>r.name===data.robot).model=data.model;}
  if(kind==='create-memory') {const cat=['近期上下文','短期记忆','长期记忆','核心摘要'].indexOf(data.type);state.memories.unshift({title:data.name,description:data.content,type:data.type,category:cat,time:'刚刚',icon:'file-text',color:'',tags:['手动添加']});state.memoryTab=0;state.memorySearch='';state.selectedMemory=0;}
  if(kind==='install-demo'&&!state.plugins.some(p=>p.name===data.plugin))state.plugins.push({name:data.plugin,version:'v1.0.0',description:'本地演示扩展插件',icon:'puzzle',color:'',enabled:true});
  $('#modal-layer').innerHTML='';render();
  if(kind!=='dismiss')toast(kind==='connect-demo'?'服务器配置已保存（本地演示）':'已保存到本次演示');
});

window.addEventListener('resize',resize);
window.demo={
  navigate,
  inspect(page){
    const content=$('#content'),r=content.getBoundingClientRect();
    const overflow=$$('.card').filter(el=>el.scrollWidth>el.clientWidth+3).map(el=>({title:el.querySelector('h2,h3')?.textContent,width:el.clientWidth,scroll:el.scrollWidth}));
    return {page,title:content.querySelector('h1')?.textContent || '总览',cards:$$('.card').length,contentHeight:content.clientHeight,scrollHeight:content.scrollHeight,overflow,missingImages:$$('img').filter(i=>!i.complete||!i.naturalWidth).map(i=>i.src),viewport:{width:innerWidth,height:innerHeight},rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
  },
  selfTest(){
    const checks=[];const check=(name,pass)=>checks.push({name,pass:!!pass});
    for(const [page]of navigation){navigate(page);check('导航 '+page,$('.nav-item.active')?.dataset.page===page&&$('#content').children.length>0);}
    navigate('models');state.modelSearch='Coder';$('#model-rows').innerHTML=modelRows();check('模型名称筛选',$$('#model-rows tr').length===1&&$('#model-rows').textContent.includes('DeepSeek-Coder'));state.modelSearch='';
    action('provider',{dataset:{id:'doubao'}});check('提供商切换',$$('#model-rows tr').length===3);state.selectedProvider='deepseek';
    navigate('robots');action('robot-pause');check('机器人暂停',!state.robots.find(r=>r.name===state.selectedRobot).running);action('robot-start');check('机器人启动',state.robots.find(r=>r.name===state.selectedRobot).running);
    $('#message-input').value='这是一条本地测试消息';$('#message-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));check('本地对话发送',state.customMessages[state.selectedRobot].includes('这是一条本地测试消息'));state.customMessages={};
    navigate('plugins');const original=state.plugins[0].enabled;action('toggle-plugin',{dataset:{id:'0'}});check('插件开关',state.plugins[0].enabled!==original);state.plugins[0].enabled=original;
    navigate('memory');state.memorySearch='农场';$('#memory-rows').innerHTML=memoryRows();check('记忆搜索',$$('.memory-row').length===3);state.memorySearch='';
    action('new-memory');check('新增记忆弹窗',!!$('.modal input[name="name"]')&&!!$('.modal textarea'));$('#modal-layer').innerHTML='';
    check('无后端连接策略',$('meta[http-equiv="Content-Security-Policy"]').content.includes("connect-src 'none'"));
    navigate('overview');return {type:'interaction-tests',passed:checks.every(c=>c.pass),checks};
  }
};
render();resize();
