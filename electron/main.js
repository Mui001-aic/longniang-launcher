// 龙娘跑团 · Electron 外壳的主进程
//
// 它只干四件事：
//   1. 把启动器（node.exe launcher\server.mjs）拉起来
//   2. 等控制面板的网页起来，用它当窗口内容
//   3. 托盘常驻：关窗口不关游戏，从托盘再打开
//   4. 把「打开游戏窗口」从浏览器外链改成真的应用窗口
//
// 游戏服务器仍然跑在自带的 node.exe 上（Electron 自带的 Node 版本不一定有 node:sqlite），
// Electron 在这里纯粹是个窗口和托盘。

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, nativeImage, screen } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const LAUNCHER_DIR = path.join(ROOT, 'launcher');
const PANEL_URL = 'http://127.0.0.1:3210/';

const LOG_FILE = path.join(require('node:os').tmpdir(), 'longniang-shell.log');
function log(msg) {
  try {
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + '  ' + msg + '\r\n');
  } catch {
    // 写不了就算了
  }
}

let panelWin = null;
let gameWin = null;
let tray = null;
let launcherProc = null;
let quitting = false;

app.setAppUserModelId('LongNiang.TRPG');

/* ---------------- 小工具 ---------------- */

function iconPath() {
  const candidates = [
    path.join(__dirname, 'icon.png'),
    path.join(ROOT, 'ai-trpg-V1.0.2', 'web', 'public', 'icon-192.png'),
    path.join(ROOT, 'ai-trpg-V1.0.2', 'web', 'public', 'favicon-32.png'),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

/** 托盘图标单独用「龙」字标：16px 下插画会糊成一个点。 */
function trayIconPath() {
  const p = path.join(__dirname, 'tray.png');
  return fs.existsSync(p) ? p : iconPath();
}

function probe(url, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(0);
    });
    req.on('error', () => resolve(0));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiState() {
  try {
    const res = await fetch('http://127.0.0.1:3210/api/state');
    return await res.json();
  } catch {
    return null;
  }
}

/* ---------------- 启动器进程 ---------------- */

async function ensureLauncher() {
  if (await probe(PANEL_URL)) {
    log('launcher already running');
    return true;
  }
  const serverPath = path.join(LAUNCHER_DIR, 'server.mjs');
  if (!fs.existsSync(serverPath)) throw new Error('找不到 launcher\\server.mjs。');

  // 用 Electron 自带的 Node 跑启动器：ELECTRON_RUN_AS_NODE=1 让这个 exe 以 node 模式启动
  launcherProc = spawn(process.execPath, [serverPath], {
    cwd: LAUNCHER_DIR,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LONGNIANG_SHELL: 'electron' },
  });
  log('launcher spawned pid=' + (launcherProc.pid || '?') + ' exe=' + process.execPath);
  launcherProc.on('exit', (code) => {
    log('launcher exited code=' + code);
    launcherProc = null;
  });

  for (let i = 0; i < 120; i++) {
    if (await probe(PANEL_URL)) return true;
    await sleep(300);
  }
  return false;
}

function stopLauncher() {
  if (!launcherProc) return;
  try {
    spawn('taskkill', ['/PID', String(launcherProc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch {
    // 已经没了
  }
  launcherProc = null;
}

/* ---------------- 窗口 ---------------- */

function createPanelWindow() {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.show();
    panelWin.focus();
    return panelWin;
  }
  // 系统缩放 125% 的时候，1024 DIP 实际会画成 1280 像素。
  // 这里按缩放系数反算，保证屏幕上量出来就是 1082×702（PCL2 那个大小）。
  const scale = (screen.getPrimaryDisplay().scaleFactor || 1);
  const WIN_W = Math.round(1082 / scale);
  const WIN_H = Math.round(702 / scale);

  panelWin = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    minWidth: Math.round(860 / scale),
    minHeight: Math.round(540 / scale),
    // 圆角要靠透明窗口，不然系统会画一块直角底色
    transparent: true,
    backgroundColor: '#00000000',
    title: '龙娘跑团',
    icon: iconPath(),
    autoHideMenuBar: true,
    // 不要系统的标题栏，顶栏自己画（右上角三个按钮由页面调 IPC）
    frame: false,
    titleBarStyle: 'hidden',
    // 圆角 + 阴影，靠近 Win11 的感觉
    roundedCorners: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  panelWin.setMenuBarVisibility(false);
  panelWin.loadURL(PANEL_URL);

  // 面板里的外链（比如「去 GitHub 看更新」）交给系统浏览器，别在应用里开新窗口
  panelWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  panelWin.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(PANEL_URL)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  panelWin.webContents.on('did-finish-load', async () => {
    try {
      const shell = await panelWin.webContents.executeJavaScript('window.longniang ? window.longniang.shell : "none"');
      log('panel loaded, bridge=' + shell);
    } catch (err) {
      log('panel loaded, bridge check failed: ' + err.message);
    }

    // 3210 是固定端口：如果上面跑着的是别的目录的启动器，页面显示的就不是这一份，
    // 很容易看半天以为是自己的安装坏了。发现不是同一个目录就明说。
    try {
      const info = await panelWin.webContents.executeJavaScript(
        "fetch('/api/state').then(function(r){return r.json()}).then(function(s){return (s && s.settings && s.settings.gameDir) || ''}).catch(function(){return ''})",
      );
      // gameDir 是安装目录里的 ai-trpg-xxx 子目录，不能直接和 ROOT 比。
      // 只有游戏目录不在这个安装目录下面，才说明面板连的是别人的安装。
      const mine = path.resolve(ROOT) + path.sep;
      const theirs = info ? path.resolve(info) : '';
      if (theirs && !theirs.startsWith(mine)) {
        log('WARN: 3210 上的启动器管的是 ' + info + '，本机是 ' + mine);
        dialog.showMessageBox(panelWin, {
          type: 'warning',
          title: '龙娘跑团',
          message: '端口 3210 被另一个启动器占着',
          detail:
            '正在显示的那个启动器管的是：\n' +
            info +
            '\n\n这个窗口对应的安装目录是：\n' +
            mine +
            '\n\n先把它关掉（或重启电脑），再打开这个启动器。',
          buttons: ['知道了'],
        });
      }
    } catch (err) {
      log('dir check failed: ' + err.message);
    }
  });
  panelWin.webContents.on('did-fail-load', (_e, code, desc) => {
    log('panel load failed ' + code + ' ' + desc);
  });

  // 关窗口 = 收进托盘，游戏继续跑
  panelWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    panelWin.hide();
  });

  panelWin.on('closed', () => {
    panelWin = null;
  });

  return panelWin;
}

async function openGameWindow() {
  const state = await apiState();
  const port = state?.game?.port ?? 3000;
  const url = `http://127.0.0.1:${port}/`;
  log('open game window -> ' + url);

  if (gameWin && !gameWin.isDestroyed()) {
    gameWin.loadURL(url);
    gameWin.show();
    gameWin.focus();
    return { ok: true };
  }

  gameWin = new BrowserWindow({
    width: 1280,
    height: 880,
    backgroundColor: '#f4efe6',
    title: '龙娘跑团',
    icon: iconPath(),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  gameWin.setMenuBarVisibility(false);
  gameWin.loadURL(url);
  gameWin.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  gameWin.on('closed', () => {
    gameWin = null;
  });
  return { ok: true };
}

function openPath(target) {
  const map = {
    data: path.join(ROOT, 'ai-trpg-V1.0.2', 'data'),
    dir: ROOT,
  };
  const p = map[target];
  if (p && fs.existsSync(p)) shell.openPath(p);
  return { ok: true };
}

/* ---------------- 托盘 ---------------- */

function buildTray() {
  const icon = trayIconPath();
  try {
    tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }));
  } catch {
    return;
  }
  const menu = Menu.buildFromTemplate([
    { label: '打开控制面板', click: () => createPanelWindow() },
    { label: '打开游戏窗口', click: () => openGameWindow() },
    { type: 'separator' },
    { label: '打开存档文件夹', click: () => openPath('data') },
    { label: '打开安装目录', click: () => openPath('dir') },
    { type: 'separator' },
    {
      label: '退出（会停掉游戏服务器）',
      click: () => {
        quitting = true;
        stopLauncher();
        app.quit();
      },
    },
  ]);
  tray.setToolTip('龙娘跑团');
  tray.setContextMenu(menu);
  tray.on('double-click', () => createPanelWindow());
}

/* ---------------- IPC ---------------- */

ipcMain.handle('open-game', () => openGameWindow());
ipcMain.handle('open-path', (_e, target) => openPath(target));
ipcMain.handle('shell-info', () => ({ shell: 'electron', root: ROOT }));

// 自绘标题栏用的窗口按钮
ipcMain.handle('win-minimize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.minimize();
});
ipcMain.handle('win-maximize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.handle('quit-app', () => {
  quitting = true;
  app.quit();
});
ipcMain.handle('win-close', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  // 和点 × 一样：收进托盘，游戏服务继续跑
  if (win) win.hide();
});

// 选文件：控制面板里的「📁」走这里，由外壳弹系统的选择框（比在页面上绕一圈稳）
ipcMain.handle('pick-file', async (e, options = {}) => {
  const owner = BrowserWindow.fromWebContents(e.sender) ?? panelWin ?? undefined;
  const filters = Array.isArray(options.filters) && options.filters.length
    ? options.filters
    : [{ name: '程序', extensions: ['exe'] }, { name: '所有文件', extensions: ['*'] }];
  const result = await dialog.showOpenDialog(owner, {
    title: options.title || '选择文件',
    properties: ['openFile'],
    filters,
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

/* ---------------- 启动 ---------------- */

// 只允许开一个
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

app.on('second-instance', () => {
  createPanelWindow();
});

app.whenReady().then(async () => {
  log('ready ROOT=' + ROOT);
  let ok = false;
  try {
    ok = await ensureLauncher();
  } catch (err) {
    dialog.showErrorBox('龙娘跑团', '启动器没能起来：\n\n' + err.message + '\n\n安装位置：' + ROOT);
    app.quit();
    return;
  }

  if (!ok) {
    dialog.showErrorBox(
      '龙娘跑团',
      '启动器等了 36 秒还没起来。\n\n可能是端口 3210 被别的程序占了，或者安装文件不完整。\n安装位置：' + ROOT,
    );
    app.quit();
    return;
  }

  createPanelWindow();
  buildTray();

  app.on('activate', () => createPanelWindow());
});

app.on('window-all-closed', () => {
  // 有托盘，不要跟着窗口一起退出
});

app.on('before-quit', () => {
  quitting = true;
  if (launcherProc) {
    try {
      spawn('taskkill', ['/PID', String(launcherProc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      // 已经没了
    }
  }
});
