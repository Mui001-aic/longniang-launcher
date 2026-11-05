const $ = (id) => document.getElementById(id);

let lastLogSeq = 0;
let updateInfo = null; // 检查更新的结果
let currentState = null;
let wizardDone = false;
let polling = false;

/**
 * 用户正在改的输入框。页面每秒都会重新渲染一次，
 * 如果每次都用服务器上的值去覆盖，用户填了一半的框会「点一下就没了」。
 * 所以只要用户动过这个框，就不再覆盖，保存以后才清掉。
 */
const drafts = new Set();

function bindDraft(id) {
  const el = $(id);
  if (!el) return;
  el.addEventListener('input', () => {
    drafts.add(id);
  });
}

/** 只在用户没改过、也没聚焦的时候写值 */
function setIfClean(id, value) {
  const el = $(id);
  if (!el) return;
  if (drafts.has(id)) return;
  if (document.activeElement === el) return;
  el.value = value;
}

function clearDrafts() {
  drafts.clear();
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

/* ---------------- 渲染 ---------------- */

const STATE_TEXT = {
  stopped: '未启动',
  preparing: '准备中',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  error: '出错',
};

function render(state) {
  currentState = state;
  if (state.update) {
    updateInfo = state.update;
    renderUpdate();
  }
  const game = state.game;

  $('statusPill').textContent = STATE_TEXT[game.state] ?? game.state;
  $('statusPill').className =
    'pill ' + (game.state === 'running' ? 'ok' : game.state === 'error' ? 'bad' : game.state === 'stopped' ? '' : 'busy');

  const ai = game.ai ?? {};
  if (ai.fake) {
    $('aiPill').textContent = 'AI：假主持人';
    $('aiPill').className = 'pill warn';
  } else if (ai.keySet) {
    $('aiPill').textContent = 'AI：DeepSeek';
    $('aiPill').className = 'pill ok';
  } else {
    $('aiPill').textContent = 'AI：没填密钥';
    $('aiPill').className = 'pill bad';
  }

  const gd = $('gameDir');
  if (gd) gd.textContent = game.gameDir ?? '';

  const banner = $('pathBanner');
  if (state.pathWarning) {
    banner.hidden = false;
    banner.textContent = '⚠ ' + state.pathWarning;
  } else {
    banner.hidden = true;
  }

  const running = game.state === 'running';
  const busy = !!game.busy;

  const startBtn = $('startBtn');
  $('startBtn').disabled = busy || running || game.state === 'starting' || game.state === 'preparing' || game.state === 'stopping';
  startBtn.textContent = busy ? `正在${busy}…` : running ? '游戏已就绪 · 运行中' : '启动游戏';
  startBtn.classList.toggle('done', running);

  $('openBtn').disabled = !running;
  $('openBtn').textContent = '打开游戏窗口';
  $('restartBtn').disabled = busy || game.state === 'stopped';
  $('stopBtn').disabled = busy || game.state === 'stopped';

  $('uptime').textContent = running && game.uptimeMs ? `已运行 ${formatDuration(game.uptimeMs)}` : '';

  $('localUrlBox').hidden = !running;
  if (running) $('localUrl').textContent = state.net.localUrl;

  const errorNote = $('errorNote');
  if (game.error) {
    errorNote.hidden = false;
    errorNote.className = 'note bad';
    errorNote.textContent = game.error;
  } else {
    errorNote.hidden = true;
  }

  // 局域网地址
  const lanList = $('lanList');
  if (!running) {
    lanList.innerHTML = '<li class="empty">游戏启动后这里会列出地址</li>';
  } else if (!state.net.lan.length) {
    lanList.innerHTML = '<li class="empty">没找到局域网地址（可能没连 WiFi）</li>';
  } else {
    lanList.innerHTML = state.net.lan
      .map(
        (l) => `<li><span class="iface" title="${escapeHtml(l.iface)}">${escapeHtml(l.iface)}</span>
          <code>${escapeHtml(l.url)}</code>
          <button class="mini" data-copy-text="${escapeHtml(l.url)}">复制</button></li>`,
      )
      .join('');
  }

  // 内网穿透地址
  const tunnel = state.tunnel;
  const addrList = $('tunnelAddrList');
  if (tunnel.state === 'on' && tunnel.url) {
    // 手动填的地址也要能直接点开，朋友拿到的就是这个链接
    addrList.innerHTML = `<li><span class="iface">公网地址</span>
      <a class="tunnel-link" href="${escapeHtml(tunnel.url)}" target="_blank" rel="noreferrer">${escapeHtml(tunnel.url)}</a>
      <button class="mini" data-copy-text="${escapeHtml(tunnel.url)}">复制</button></li>`;
  } else if (tunnel.state === 'starting') {
    addrList.innerHTML = '<li class="empty">正在连接穿透……</li>';
  } else {
    addrList.innerHTML = '<li class="empty">未开启内网穿透</li>';
  }

  const tp = $('tunnelPill');
  tp.textContent =
    tunnel.state === 'on' ? '已开启' : tunnel.state === 'starting' ? '连接中' : tunnel.state === 'error' ? '失败' : '未开启';
  tp.className = 'pill tiny ' + (tunnel.state === 'on' ? 'ok' : tunnel.state === 'error' ? 'bad' : tunnel.state === 'starting' ? 'busy' : '');
  if ($('tunnelStartBtn')) $('tunnelStartBtn').disabled = !running || tunnel.state === 'on' || tunnel.state === 'starting';
  if ($('tunnelStopBtn')) $('tunnelStopBtn').disabled = tunnel.state === 'off';
  if (tunnel.error) {
    $('tunnelNote').className = 'note bad';
    const hint = '\n樱花穿透的隧道要在樱花启动器里开，然后把远程地址填到下面。';
    $('tunnelNote').textContent = tunnel.error + hint;
  } else {
    $('tunnelNote').className = 'note';
    $('tunnelNote').textContent =
      '朋友不在同一个网络时用这个：樱花穿透给你一个固定的公网地址，注册个邀请码就能进来。';
  }

  // 左下角的账号信息
  const whoName = $('whoName');
  if (whoName) {
    const owner = game.owner ?? {};
    whoName.textContent = owner.displayName || owner.username || '本机服务器';
    const sub = $('whoSub');
    if (sub) sub.textContent = running ? `运行中 · 端口 ${game.port}` : '未启动';
  }

  // 设置
  setIfClean('portInput', String(game.port ?? 3000));
  $('keyInput').placeholder = ai.keySet ? `已填：${ai.keyMask}（留空表示不改）` : 'sk-…（还没填）';

  // 首次运行：只有确实读到「一个账号都没有」才弹，读不到（服务器锁着存档）就不乱猜
  const owner = game.owner ?? {};
  if (!wizardDone && !owner.error && !owner.exists && ['stopped', 'error'].includes(game.state)) {
    $('wizard').hidden = false;
  }
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 时 ${m % 60} 分`;
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* ---------------- 轮询 ---------------- */

async function pollState() {
  if (polling) return;
  polling = true;
  try {
    const state = await api('/api/state');
    render(state);
  } catch {
    $('statusPill').textContent = '启动器断开了';
    $('statusPill').className = 'pill bad';
  } finally {
    polling = false;
  }
}

async function pollLogs() {
  try {
    const data = await api(`/api/logs?since=${lastLogSeq}`);
    if (data.lines?.length) {
      lastLogSeq = data.seq;
      const box = $('logBox');
      box.textContent += data.lines.map((l) => l.text).join('\n') + '\n';
      if (box.textContent.length > 200_000) box.textContent = box.textContent.slice(-150_000);
      if ($('autoScroll').checked) box.scrollTop = box.scrollHeight;
    }
  } catch {
    // 忽略：断线时下一轮会补上
  }
}

/* ---------------- 操作 ---------------- */

async function toast(targetId, ok, message) {
  const el = $(targetId);
  el.className = 'note ' + (ok ? '' : 'bad');
  el.textContent = message ?? '';
  el.hidden = !message;
}

async function withButton(button, label, fn) {
  const old = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    await fn();
  } finally {
    button.disabled = false;
    button.textContent = old;
    await pollState();
  }
}

$('startBtn').addEventListener('click', () =>
  withButton($('startBtn'), '启动中…', async () => {
    const r = await api('/api/start', {});
    if (!r.ok) await toast('errorNote', false, r.message);
  }),
);

$('stopBtn').addEventListener('click', () =>
  withButton($('stopBtn'), '停止中…', async () => {
    await api('/api/stop', {});
  }),
);

$('restartBtn').addEventListener('click', () =>
  withButton($('restartBtn'), '重启中…', async () => {
    const r = await api('/api/restart', {});
    if (!r.ok) await toast('errorNote', false, r.message);
  }),
);

// 跑在 Electron 外壳里时，窗口归外壳管；在浏览器里打开时还是走服务器开 Edge
const bridge = window.longniang && window.longniang.shell === 'electron' ? window.longniang : null;

const openGame = () => (bridge ? bridge.openGame() : api('/api/open', { target: 'game' }));
const openFolder = (target) => (bridge ? bridge.openPath(target) : api('/api/open', { target }));

$('openBtn').addEventListener('click', openGame);
$('dataBtn').addEventListener('click', () => openFolder('data'));
$('dirBtn').addEventListener('click', () => openFolder('dir'));

$('saveKeyBtn').addEventListener('click', () =>
  withButton($('saveKeyBtn'), '验证中…', async () => {
    const key = $('keyInput').value.trim();
    const r = await api('/api/ai-key', { key });
    await toast('restartHint', r.ok, r.message + (r.restartNeeded ? '（重启后生效）' : ''));
    if (r.ok) $('keyInput').value = '';
    refreshLogsSoon();
  }),
);

$('fakeBtn').addEventListener('click', () =>
  withButton($('fakeBtn'), '切换中…', async () => {
    const r = await api('/api/use-fake', {});
    await toast('restartHint', r.ok, r.message + (r.restartNeeded ? '（重启后生效）' : ''));
  }),
);

$('savePortBtn').addEventListener('click', () =>
  withButton($('savePortBtn'), '保存中…', async () => {
    const r = await api('/api/port', { port: Number($('portInput').value) });
    await toast('restartHint', r.ok, r.message);
  }),
);

$('tunnelStartBtn')?.addEventListener('click', () =>
  withButton($('tunnelStartBtn'), '连接中…', async () => {
    const kind = ['sakura', 'frp', 'cloudflared'].includes(currentState?.settings?.tunnelKind)
      ? currentState.settings.tunnelKind
      : 'sakura';
    const r = await api('/api/tunnel/start', { kind });
    if (!r.ok) await toast('tunnelNote', false, r.message);
  }),
);

$('tunnelStopBtn')?.addEventListener('click', () =>
  withButton($('tunnelStopBtn'), '关闭中…', async () => {
    await api('/api/tunnel/stop', {});
  }),
);

$('downloadCfBtn')?.addEventListener('click', () =>
  withButton($('downloadCfBtn'), '下载中…', async () => {
    const r = await api('/api/tunnel/download', {});
    await toast('tunnelNote', r.ok, r.ok ? 'cloudflared 下载好了，可以开启隧道了。' : r.message);
  }),
);

let pendingKind = null;
for (const btn of document.querySelectorAll('#kindSeg .seg-btn')) {
  btn.addEventListener('click', () => {
    pendingKind = btn.dataset.kind;
    for (const other of document.querySelectorAll('#kindSeg .seg-btn')) other.classList.toggle('on', other === btn);
    if ($('sakuraBox')) $('sakuraBox').hidden = pendingKind !== 'sakura';
    if ($('frpBox')) $('frpBox').hidden = pendingKind !== 'frp';
  });
}

$('saveTunnelBtn')?.addEventListener('click', () =>
  withButton($('saveTunnelBtn'), '保存中…', async () => {
    const r = await api('/api/tunnel/config', {
      kind: pendingKind ?? currentState?.settings?.tunnelKind ?? 'sakura',
      sakuraToken: $('sakuraToken').value.trim(),
      sakuraTunnel: $('sakuraTunnel').value.trim().replace(/^#+/, ''),
      frpcExe: $('frpcExe').value.trim(),
      frpExe: $('frpExe').value.trim(),
      frpArgs: $('frpArgs').value.trim(),
    });
    pendingKind = null;
    if (r.ok) clearDrafts();
    await toast('tunnelNote', r.ok, r.message);
  }),
);



// 自动检测 frpc / 樱花启动器
$('frpcDetectBtn')?.addEventListener('click', () =>
  withButton($('frpcDetectBtn'), '查找中…', async () => {
    const r = await api('/api/tunnel/detect', {});
    if (r.path) {
      $('frpcExe').value = r.path;
      drafts.add('frpcExe');
    }
    const hint = $('frpcHint');
    hint.textContent = r.message;
    hint.className = r.ok ? 'hint' : 'hint bad';
  }),
);

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy-text], [data-copy]');
  if (!btn) return;
  const text = btn.dataset.copyText ?? $(btn.dataset.copy)?.textContent ?? '';
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(() => (btn.textContent = old), 1200);
  } catch {
    btn.textContent = '复制失败';
  }
});

/* ---------------- 首次设置 ---------------- */

$('wGo').addEventListener('click', () =>
  withButton($('wGo'), '处理中…', async () => {
    const r = await api('/api/setup', {
      username: $('wUser').value.trim(),
      displayName: $('wName').value.trim(),
      password: $('wPass').value,
      password2: $('wPass2').value,
      key: $('wKey').value.trim(),
    });
    if (r.ok) {
      wizardDone = true;
      $('wizard').hidden = true;
    } else {
      $('wMsg').textContent = r.message ?? '没成功。';
      $('wMsg').className = 'note bad';
    }
    refreshLogsSoon();
  }),
);

function refreshLogsSoon() {
  setTimeout(pollLogs, 300);
}

/* ---------------- 启动 ---------------- */

pollState();
pollLogs();
setInterval(pollState, 1000);
setInterval(pollLogs, 1200);

/* ---------------- 检查更新 ---------------- */

function getJson(path) {
  return fetch(path).then((r) => r.json());
}

function renderUpdate() {
  const pill = $('versionPill');
  const note = $('updateNote');
  const link = $('updateLink');
  if (!pill) return;

  if (!updateInfo) {
    pill.textContent = '版本未知';
    pill.className = 'pill tiny';
    note.className = 'note small';
    note.textContent = '还没查到版本信息';
    link.hidden = true;
    return;
  }

  const localVersion = updateInfo.local?.gameVersion ?? '未知';
  const remote = updateInfo.remote;

  if (updateInfo.error) {
    pill.textContent = 'v' + localVersion;
    pill.className = 'pill tiny';
    note.className = 'note small bad';
    note.textContent = '检查失败：' + updateInfo.error;
    link.hidden = true;
    return;
  }

  if (updateInfo.hasUpdate) {
    pill.textContent = 'v' + localVersion + ' → ' + (remote?.remoteVersion ?? '新提交');
    pill.className = 'pill tiny warn';
    note.className = 'note small';
    const when = remote?.commitDate ? remote.commitDate.slice(0, 10) : '';
    note.textContent = (updateInfo.reason || '仓库有新版本') + (when ? '（' + when + '）' : '') + '。要更新得换新的安装包。';
    if (remote?.commitUrl) {
      link.href = remote.commitUrl;
      link.hidden = false;
    }
  } else {
    pill.textContent = 'v' + localVersion + ' 已是最新';
    pill.className = 'pill tiny ok';
    note.className = 'note small';
    const when = remote?.commitDate ? remote.commitDate.slice(0, 10) : '';
    note.textContent = '仓库最后提交：' + (when || '—') + '　《' + (remote?.commitTitle ?? '—') + '》';
    link.hidden = true;
  }
}

async function loadUpdate(force) {
  const btn = $('checkUpdateBtn');
  if (btn) btn.disabled = true;
  try {
    updateInfo = await getJson('/api/update' + (force ? '?force=1' : ''));
  } catch {
    updateInfo = { error: '启动器没有响应' };
  } finally {
    if (btn) btn.disabled = false;
    renderUpdate();
  }
}

if ($('checkUpdateBtn')) {
  $('checkUpdateBtn').addEventListener('click', () => loadUpdate(true));
  loadUpdate(false);
  setInterval(() => {
    if (updateInfo && updateInfo.hasUpdate) return;
    loadUpdate(false);
  }, 10 * 60 * 1000);
}

// 这些框用户改过就别被每秒的刷新覆盖
for (const id of ['sakuraToken', 'sakuraTunnel', 'frpcExe', 'frpExe', 'frpArgs', 'portInput']) bindDraft(id);


/* ---------------- 即时提示（带圈问号） ---------------- */

let tipEl = null;

function ensureTip() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.id = 'tip';
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

function placeTip(e) {
  if (!tipEl) return;
  const pad = 14;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  const r = tipEl.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 8) x = window.innerWidth - r.width - 8;
  if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
  tipEl.style.left = x + 'px';
  tipEl.style.top = y + 'px';
}

document.addEventListener('mouseover', (e) => {
  const host = e.target.closest('[data-tip]');
  if (!host) return;
  const el = ensureTip();
  el.textContent = host.dataset.tip;
  el.classList.add('show');
  placeTip(e);
});

document.addEventListener('mousemove', (e) => {
  if (tipEl && tipEl.classList.contains('show')) placeTip(e);
});

document.addEventListener('mouseout', (e) => {
  if (e.target.closest('[data-tip]') && tipEl) tipEl.classList.remove('show');
});

/* ---------------- 标签页 ---------------- */

const TAB_KEY = 'longniang.tab';

function showTab(name) {
  for (const btn of document.querySelectorAll('#tabs .tab')) {
    btn.classList.toggle('on', btn.dataset.tab === name);
  }
  for (const pane of document.querySelectorAll('.pane')) {
    pane.classList.toggle('on', pane.dataset.pane === name);
  }
  try {
    localStorage.setItem(TAB_KEY, name);
  } catch {
    /* 存不了就算了 */
  }
}

for (const btn of document.querySelectorAll('#tabs .tab')) {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
}

let savedTab = 'game';
try {
  savedTab = localStorage.getItem(TAB_KEY) || 'game';
} catch {
  savedTab = 'game';
}
showTab(['game', 'net', 'settings', 'logs'].includes(savedTab) ? savedTab : 'game');

/* ---------------- 自绘标题栏的按钮 ---------------- */

const CLOSE_KEY = 'longniang.close';

function savedCloseChoice() {
  try {
    const v = JSON.parse(localStorage.getItem(CLOSE_KEY) || 'null');
    return v && v.action ? v : null;
  } catch {
    return null;
  }
}

function doClose(action) {
  if (action === 'quit') {
    window.longniang?.quitApp ? window.longniang.quitApp() : window.longniang?.close();
  } else {
    window.longniang?.close();
  }
}

function askClose() {
  const saved = savedCloseChoice();
  if (saved) {
    doClose(saved.action);
    return;
  }
  const dlg = $('closeDialog');
  if (!dlg) {
    window.longniang?.close();
    return;
  }
  dlg.hidden = false;
}

if (window.longniang?.minimize) {
  $('winMin').addEventListener('click', () => window.longniang.minimize());
  $('winClose')?.addEventListener('click', () => askClose());
  const maxBtn = $('winMax');
  if (maxBtn) maxBtn.style.display = 'none';
} else {
  for (const id of ['winMin', 'winMax', 'winClose']) {
    const el = $(id);
    if (el) el.style.display = 'none';
  }
}

$('closeOkBtn')?.addEventListener('click', () => {
  const picked = document.querySelector('input[name="closeAction"]:checked');
  const action = picked ? picked.value : 'hide';
  const forget = $('closeForget');
  if (forget && forget.checked) {
    try {
      localStorage.setItem(CLOSE_KEY, JSON.stringify({ action }));
    } catch {
      /* 存不了就算了 */
    }
  }
  $('closeDialog').hidden = true;
  doClose(action);
});


/* ---------------- 设置页：子导航 ---------------- */

function showSub(name) {
  for (const btn of document.querySelectorAll('.sub-item')) {
    btn.classList.toggle('on', btn.dataset.sub === name);
  }
  for (const pane of document.querySelectorAll('.sub-pane')) {
    pane.classList.toggle('on', pane.dataset.sub === name);
  }
}

for (const btn of document.querySelectorAll('.sub-item')) {
  btn.addEventListener('click', () => showSub(btn.dataset.sub));
}

/* ---------------- 外观设置（只存本机浏览器） ---------------- */

const LOOK_KEY = 'longniang.look';

const THEMES = {
  blue: {
    accent: '#4d8bff',
    accent2: '#2f6be0',
    bg: '#0b1020',
    bg2: '#0f1730',
    card: '#141d33',
    card2: '#18223c',
    line: '#24304f',
  },
  green: {
    accent: '#3fbf9c',
    accent2: '#2a9179',
    bg: '#07171a',
    bg2: '#0b2126',
    card: '#102a2f',
    card2: '#143238',
    line: '#1e4249',
  },
  mint: {
    accent: '#7bc862',
    accent2: '#579a44',
    bg: '#0c1710',
    bg2: '#122318',
    card: '#18291c',
    card2: '#1d3322',
    line: '#2a4630',
  },
  amber: {
    accent: '#e8b93c',
    accent2: '#b98f20',
    bg: '#181208',
    bg2: '#221a0c',
    card: '#2a2110',
    card2: '#332816',
    line: '#453720',
  },
  brown: {
    accent: '#c08a58',
    accent2: '#96683c',
    bg: '#15100c',
    bg2: '#1e1712',
    card: '#261c15',
    card2: '#2f231a',
    line: '#40301f',
  },
  pink: {
    accent: '#e87ba8',
    accent2: '#b95580',
    bg: '#1a0e14',
    bg2: '#24131b',
    card: '#2c1822',
    card2: '#361e29',
    line: '#4a2a38',
  },
  purple: {
    accent: '#9b7bff',
    accent2: '#7455d6',
    bg: '#110e1e',
    bg2: '#181329',
    card: '#1f1936',
    card2: '#271f42',
    line: '#372c5c',
  },
};

const look = {
  theme: 'blue',
  title: '',
  bg: '',
};

function loadLook() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOOK_KEY) || '{}');
    Object.assign(look, saved);
  } catch {
    /* 读不出来就用默认 */
  }
}

function applyLook() {
  const root = document.documentElement;
  const theme = THEMES[look.theme] ?? THEMES.blue;

  // 整套配色都换掉，不只是按钮
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--accent2', theme.accent2);
  root.style.setProperty('--bg', theme.bg);
  root.style.setProperty('--bg2', theme.bg2);
  root.style.setProperty('--card', theme.card);
  root.style.setProperty('--card2', theme.card2);
  root.style.setProperty('--line', theme.line);
  // 顶栏用卡片色，和背景拉开一档，换主题时也跟着变
  root.style.setProperty('--bar', theme.card);
  root.style.setProperty('--bar-alt', theme.card);

  const title = $('appTitle');
  if (title) title.textContent = look.title || '龙娘跑团 · 启动器';
  document.title = look.title || '龙娘跑团 · 启动器';

  if (look.bg) {
    document.body.style.backgroundImage = `url("${look.bg}")`;
    document.body.classList.add('has-bg');
  } else {
    document.body.style.backgroundImage = '';
    document.body.classList.remove('has-bg');
  }

  for (const dot of document.querySelectorAll('.theme-dot')) {
    dot.classList.toggle('on', dot.dataset.theme === look.theme);
  }
  const titleInput = $('titleInput');
  if (titleInput && document.activeElement !== titleInput) titleInput.value = look.title || '';
}

function saveLook() {
  try {
    localStorage.setItem(LOOK_KEY, JSON.stringify(look));
  } catch {
    /* 存不下就算了 */
  }
  applyLook();
}

loadLook();
applyLook();

for (const dot of document.querySelectorAll('.theme-dot')) {
  dot.addEventListener('click', () => {
    look.theme = dot.dataset.theme;
    saveLook();
  });
}

$('titleInput')?.addEventListener('input', (e) => {
  look.title = e.target.value;
  applyLook();
});
$('titleInput')?.addEventListener('change', saveLook);

$('pickBgBtn')?.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      alert('图片太大了（超过 4MB），换一张小一点的。');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      look.bg = String(reader.result);
      saveLook();
    };
    reader.readAsDataURL(file);
  });
  input.click();
});

$('clearBgBtn')?.addEventListener('click', () => {
  look.bg = '';
  saveLook();
});

$('resetLookBtn')?.addEventListener('click', () => {
  look.theme = 'blue';
  look.title = '';
  look.bg = '';
  saveLook();
});


/* 启动器自己的版本（跟着安装包走，方便确认装的是哪一版） */
const APP_VERSION = '1.5.2';
const versionEl = $('appVersion');
if (versionEl) versionEl.textContent = `启动器 v${APP_VERSION}`;


/* ---------------- 内网穿透：手动地址 ---------------- */


/* ---------------- 内网穿透：手动地址 ---------------- */

/** 用户可能填 frp-off.com:19191，也可能带协议头；统一成 https://host:port/ */
function normalizeTunnelUrl(raw) {
  let v = String(raw ?? '').trim();
  if (!v) return '';
  v = v.replace(/\s+/g, '');
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  if (!v.endsWith('/')) v += '/';
  return v;
}

const manualInput = $('manualUrl');
if (manualInput) {
  const saved = currentState?.settings?.manualUrl ?? '';
  if (saved && !manualInput.value) manualInput.value = saved.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

$('manualUrlBtn')?.addEventListener('click', () =>
  withButton($('manualUrlBtn'), '…', async () => {
    const raw = ($('manualUrl')?.value ?? '').trim();
    if (!raw) {
      await toast('tunnelNote', false, '先填一个地址');
      return;
    }
    const url = normalizeTunnelUrl(raw);
    const r = await api('/api/tunnel/manual', { url });
    await toast('tunnelNote', r.ok, r.ok ? '好了，上面那个链接发给朋友就能进' : r.message);
  }),
);
