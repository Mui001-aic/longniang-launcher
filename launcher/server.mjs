import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { LAUNCHER_DIR, loadConfig, saveConfig } from './lib/config.mjs';
import { GameServer } from './lib/game.mjs';
import { Tunnel } from './lib/tunnel.mjs';
import { createOwner, checkDeepSeekKey, validateAccount } from './lib/setup.mjs';
import { aiSummary, gamePort, readEnvValues, setEnvValue, setEnvValues } from './lib/envfile.mjs';
import { dataDirOf } from './lib/db.mjs';
import { findFreePort, lanAddresses, portFree } from './lib/util.mjs';
import { checkForUpdate, checkLauncherUpdate } from './lib/update.mjs';

const VERSION = '0.2.0';
/** 跑在 Electron 外壳里：窗口由外壳负责，这边不要再去开 Edge。 */
const SHELL_IS_ELECTRON = process.env.LONGNIANG_SHELL === 'electron';
let config = loadConfig();
if (!config.gameDir) {
  console.error('\n没找到游戏本体（ai-trpg 文件夹）。把启动器放在游戏文件夹旁边再启动。\n');
  process.exit(1);
}

const game = new GameServer(config.gameDir);
const tunnel = new Tunnel();
let busy = null; // 正在做的事情（启动、建账号……），防止连点
let updateState = null; // 最近一次「检查更新」的结果（游戏）
let launcherUpdateState = null; // 启动器自己的更新

/** 查一次更新，结果留在 updateState 里给面板读。失败不抛错。 */
async function refreshUpdate(force = false) {
  updateState = await checkForUpdate(config.gameDir, { force });
  return updateState;
}

/* ---------------- 浏览器窗口 ---------------- */

function findEdge() {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** 用 Edge 的 app 模式开一个没有地址栏的窗口，看起来就像个桌面程序。 */
function openWindow(url, size = '1280,860') {
  const edge = findEdge();
  if (edge) {
    spawn(edge, [`--app=${url}`, `--window-size=${size}`], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return true;
  }
  if (process.platform === 'win32') {
    spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  return false;
}

/* ---------------- HTTP ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('请求太大了');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求格式不对');
  }
}

function statePayload() {
  const snapshot = game.snapshot();
  const lan = lanAddresses();
  const port = snapshot.port;
  return {
    version: VERSION,
    game: {
      ...snapshot,
      // 只有启动器自己知道的状态
      busy,
    },
    tunnel: tunnel.snapshot(),
    launcherUpdate: launcherUpdateState,
    net: {
      lan: lan.map((l) => ({ ...l, url: `http://${l.address}:${port}/` })),
      localUrl: `http://127.0.0.1:${port}/`,
      shareUrls: [`http://127.0.0.1:${port}/`, ...lan.map((l) => `http://${l.address}:${port}/`)],
    },
    settings: {
      gameDir: config.gameDir,
      controlPort: config.controlPort,
      autoStart: config.autoStart,
      tunnelKind: config.tunnel?.kind ?? 'sakura',
      sakuraToken: config.tunnel?.sakuraToken ?? '',
      sakuraTunnel: config.tunnel?.sakuraTunnel ?? '',
      frpcExe: config.tunnel?.frpcExe ?? '',
      manualUrl: config.tunnel?.manualUrl ?? '',
      frpExe: config.tunnel?.frpExe ?? '',
      frpArgs: config.tunnel?.frpArgs ?? '',
    },
    // 游戏目录里有中文/日文之类的字符：Node 那份 fs.cp 会直接崩，必须提醒
    pathWarning: /[^\x00-\x7F]/.test(config.gameDir)
      ? `游戏目录路径里有中文或特殊字符，会导致启动时崩掉。请把整个文件夹搬到纯英文路径，比如 D:\\LongNiang，再启动一次。`
      : null,
    update: updateState,
  };
}

async function handleApi(req, res, url) {
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/api/state') return sendJson(res, 200, statePayload());

  // 检查更新：第一次请求会算一次，之后走 6 小时缓存
  if (pathname === '/api/launcher-update') {
    const force = url.searchParams.get('force') === '1';
    try {
      launcherUpdateState = await checkLauncherUpdate({ force });
    } catch (err) {
      launcherUpdateState = { error: String(err.message ?? err), hasUpdate: false };
    }
    return sendJson(res, 200, launcherUpdateState);
  }

  if (req.method === 'GET' && pathname === '/api/update') {
    const force = url.searchParams.get('force') === '1';
    return sendJson(res, 200, await refreshUpdate(force));
  }

  if (req.method === 'GET' && pathname === '/api/logs') {
    const since = Number(url.searchParams.get('since') ?? 0) || 0;
    return sendJson(res, 200, { lines: game.logsSince(since), seq: game.logSeq, tunnel: tunnel.snapshot().logs.slice(-20) });
  }

  if (req.method === 'POST' && pathname === '/api/start') {
    if (busy) return sendJson(res, 409, { ok: false, message: `正在${busy}，稍等一下。` });
    busy = '启动';
    try {
      const snap = await game.start();
      return sendJson(res, 200, { ok: snap.state === 'running', message: snap.error ?? '', game: game.snapshot() });
    } finally {
      busy = null;
    }
  }

  if (req.method === 'POST' && pathname === '/api/stop') {
    if (busy) return sendJson(res, 409, { ok: false, message: `正在${busy}，稍等一下。` });
    busy = '停止';
    try {
      await tunnel.stop();
      await game.stop();
      return sendJson(res, 200, { ok: true, game: game.snapshot() });
    } finally {
      busy = null;
    }
  }

  if (req.method === 'POST' && pathname === '/api/restart') {
    if (busy) return sendJson(res, 409, { ok: false, message: `正在${busy}，稍等一下。` });
    busy = '重启';
    try {
      await game.stop();
      const snap = await game.start();
      return sendJson(res, 200, { ok: snap.state === 'running', message: snap.error ?? '', game: game.snapshot() });
    } finally {
      busy = null;
    }
  }

  if (req.method === 'POST' && pathname === '/api/ai-key') {
    const body = await readBody(req);
    const key = String(body.key ?? '').trim();
    if (!key) return sendJson(res, 400, { ok: false, message: '没填密钥。' });
    const check = await checkDeepSeekKey(key);
    if (check.ok === false) return sendJson(res, 200, { ok: false, message: check.message });
    setEnvValue(config.gameDir, 'DEEPSEEK_API_KEY', key);
    // 填了真密钥就把假主持人关掉
    setEnvValue(config.gameDir, 'AI_PROVIDER', '');
    return sendJson(res, 200, { ok: true, message: check.message || '密钥存下了。', restartNeeded: game.state === 'running' });
  }

  if (req.method === 'POST' && pathname === '/api/use-fake') {
    setEnvValues(config.gameDir, { AI_PROVIDER: 'fake' });
    return sendJson(res, 200, { ok: true, message: '切到假主持人（不调用 AI、不花钱）。', restartNeeded: game.state === 'running' });
  }

  if (req.method === 'POST' && pathname === '/api/port') {
    const body = await readBody(req);
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return sendJson(res, 400, { ok: false, message: '端口要填 1～65535 之间的整数。' });
    if (game.state === 'running') return sendJson(res, 409, { ok: false, message: '先把游戏停下来再改端口。' });
    if (!(await portFree(port))) return sendJson(res, 409, { ok: false, message: `端口 ${port} 被别的程序占着，换一个。` });
    setEnvValue(config.gameDir, 'PORT', String(port));
    game.port = port;
    return sendJson(res, 200, { ok: true, message: `端口改成 ${port}。` });
  }

  if (req.method === 'POST' && pathname === '/api/setup') {
    if (busy) return sendJson(res, 409, { ok: false, message: `正在${busy}，稍等一下。` });
    const body = await readBody(req);
    const bad = validateAccount(body);
    if (bad) return sendJson(res, 400, { ok: false, message: bad });
    busy = '建账号';
    try {
      if (game.state !== 'stopped') await game.stop();
      // 第一次运行还没装依赖：先装好，不然 reset.ts 跑不起来
      if (!(await game.prepare())) {
        return sendJson(res, 200, { ok: false, message: game.error ?? '依赖没装好。' });
      }
      const key = String(body.key ?? '').trim();
      if (key) {
        const check = await checkDeepSeekKey(key);
        if (check.ok === false) return sendJson(res, 200, { ok: false, message: check.message });
        setEnvValues(config.gameDir, { DEEPSEEK_API_KEY: key, AI_PROVIDER: '' });
      } else {
        setEnvValues(config.gameDir, { AI_PROVIDER: 'fake' });
      }
      const created = await createOwner(game, body);
      if (!created.ok) return sendJson(res, 200, { ok: false, message: created.message });
      const snap = await game.start();
      return sendJson(res, 200, {
        ok: snap.state === 'running',
        message: snap.state === 'running' ? '都好了，游戏已经启动。' : (snap.error ?? ''),
        game: game.snapshot(),
      });
    } finally {
      busy = null;
    }
  }

  if (req.method === 'POST' && pathname === '/api/tunnel/config') {
    const body = await readBody(req);
    const kind = ['sakura', 'frp', 'cloudflared'].includes(body.kind) ? body.kind : 'sakura';
    config = saveConfig({
      tunnel: {
        ...(config.tunnel ?? {}),
        kind,
        sakuraToken: String(body.sakuraToken ?? '').trim(),
        sakuraTunnel: String(body.sakuraTunnel ?? '').trim(),
        frpcExe: String(body.frpcExe ?? '').trim(),
        frpExe: String(body.frpExe ?? '').trim(),
        frpArgs: String(body.frpArgs ?? '').trim(),
      },
    });
    return sendJson(res, 200, { ok: true, message: '穿透设置存好了。' });
  }

  if (req.method === 'POST' && pathname === '/api/tunnel/start') {
    const body = await readBody(req);
    const kind = ['sakura', 'frp', 'cloudflared'].includes(body.kind)
      ? body.kind
      : config.tunnel?.kind ?? 'sakura';
    if (game.state !== 'running') return sendJson(res, 409, { ok: false, message: '先把游戏启动起来再开联机。' });
    const snap = await tunnel.start(game.port, kind, config.tunnel ?? {});
    return sendJson(res, 200, { ok: snap.state === 'on', message: snap.error ?? '', tunnel: snap });
  }

  // 手动模式：用户自己在樱花启动器里开好隧道，把地址填进来
  if (req.method === 'POST' && pathname === '/api/tunnel/manual') {
    const body = await readBody(req);
    const url = String(body.url ?? '').trim();
    const snap = tunnel.useManual(url);
    config = saveConfig({ tunnel: { ...(config.tunnel ?? {}), manualUrl: url } });
    return sendJson(res, 200, { ok: snap.state === 'on', message: snap.error ?? '', tunnel: snap });
  }

  if (req.method === 'POST' && pathname === '/api/tunnel/stop') {
    const snap = await tunnel.stop();
    return sendJson(res, 200, { ok: true, tunnel: snap });
  }

  if (req.method === 'POST' && pathname === '/api/tunnel/download') {
    try {
      await tunnel.download();
      return sendJson(res, 200, { ok: true, message: 'cloudflared 下载好了。' });
    } catch (err) {
      return sendJson(res, 200, { ok: false, message: `下载失败：${err.message}` });
    }
  }

  // 弹一个 Windows 的文件选择框，把选中的路径还给页面
  if (req.method === 'POST' && pathname === '/api/pick-file') {
    const body = await readBody(req);
    const filter = String(body.filter ?? '程序 (*.exe)|*.exe|所有文件 (*.*)|*.*').replace(/'/g, "''");
    const title = String(body.title ?? '选择文件').replace(/'/g, "''");
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.OpenFileDialog',
      `$d.Filter = '${filter}'`,
      `$d.Title = '${title}'`,
      "$d.RestoreDirectory = $true",
      "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.FileName }",
    ].join('; ');
    try {
      const result = await new Promise((resolve, reject) => {
        const ps = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
          windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        ps.stdout.on('data', (b) => (stdout += b.toString('utf8')));
        ps.stderr.on('data', (b) => (stderr += b.toString('utf8')));
        ps.on('error', reject);
        ps.on('exit', () => resolve({ stdout: stdout.trim(), stderr: stderr.trim() }));
      });
      if (result.stdout) return sendJson(res, 200, { ok: true, path: result.stdout });
      if (result.stderr) {
        return sendJson(res, 200, { ok: false, message: `选择框没弹出来：${result.stderr.slice(0, 200)}` });
      }
      // 用户点了取消
      return sendJson(res, 200, { ok: false, message: '' });
    } catch (err) {
      return sendJson(res, 200, { ok: false, message: `打不开选择框：${err.message}` });
    }
  }

  // 自动找 frpc.exe：樱花启动器旁边、常见安装位置、PATH
  if (req.method === 'POST' && pathname === '/api/tunnel/detect') {
    const found = tunnel.detectFrpc();
    return sendJson(res, 200, found);
  }

  if (req.method === 'POST' && pathname === '/api/open') {
    const body = await readBody(req);
    const target = body.target ?? 'game';
    if (target === 'game') {
      const url = `http://127.0.0.1:${game.port}/`;
      // 在 Electron 里：窗口由外壳开（页面那边走 IPC），这里只报个成功
      if (!SHELL_IS_ELECTRON) openWindow(url);
      return sendJson(res, 200, { ok: true, message: '游戏窗口打开了。', url });
    }
    if (target === 'data') {
      const dir = dataDirOf(config.gameDir);
      spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'explorer', dir], { windowsHide: true, stdio: 'ignore' });
      return sendJson(res, 200, { ok: true, message: '存档文件夹打开了。' });
    }
    if (target === 'dir') {
      spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'explorer', config.gameDir], { windowsHide: true, stdio: 'ignore' });
      return sendJson(res, 200, { ok: true, message: '游戏文件夹打开了。' });
    }
    return sendJson(res, 400, { ok: false, message: '不知道要打开什么。' });
  }

  if (req.method === 'POST' && pathname === '/api/quit') {
    sendJson(res, 200, { ok: true });
    setTimeout(async () => {
      await tunnel.stop();
      await game.stop();
      process.exit(0);
    }, 200);
    return;
  }

  return sendJson(res, 404, { ok: false, message: '没有这个接口。' });
}

function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  if (!rel.startsWith('/ui/')) rel = '/ui' + rel;
  const base = path.join(LAUNCHER_DIR, 'ui');
  const file = path.join(base, rel.replace(/^\/ui\//, '').replace(/\//g, path.sep));
  if (!file.startsWith(base)) {
    res.writeHead(403);
    res.end('nope');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${config.controlPort}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    console.error('[launcher]', err);
    sendJson(res, 500, { ok: false, message: err instanceof Error ? err.message : String(err) });
  }
});

async function main() {
  // 单实例：控制端口被占用，说明已经有一个启动器在跑，直接把窗口打开就退出
  if (!(await portFree(config.controlPort))) {
    if (!SHELL_IS_ELECTRON) openWindow(`http://127.0.0.1:${config.controlPort}/`);
    console.log('启动器已经在运行。');
    process.exit(0);
  }

  server.listen(config.controlPort, '127.0.0.1', async () => {
    console.log(`启动器控制面板：http://127.0.0.1:${config.controlPort}/`);
    console.log(`游戏文件夹：${config.gameDir}`);
    if (!SHELL_IS_ELECTRON) openWindow(`http://127.0.0.1:${config.controlPort}/`, '1180,820');
    // 后台查一次更新（有缓存就走缓存，不耽误启动）
    void refreshUpdate().catch((err) => console.log('检查更新失败：', err?.message ?? err));
    if (config.autoStart && game.snapshot().owner.exists) {
      console.log('自动启动游戏……');
      await game.start();
    }
  });
}

process.on('SIGINT', async () => {
  await tunnel.stop();
  await game.stop();
  process.exit(0);
});

main();
