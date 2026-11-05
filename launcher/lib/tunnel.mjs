import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { LAUNCHER_DIR } from './config.mjs';
import { sleep } from './util.mjs';

const isWindows = process.platform === 'win32';
const BIN_DIR = path.join(LAUNCHER_DIR, 'bin');
const CLOUDFLARED_EXE = path.join(BIN_DIR, isWindows ? 'cloudflared.exe' : 'cloudflared');
const FRPC_EXE = path.join(BIN_DIR, isWindows ? 'frpc.exe' : 'frpc');

/**
 * 内网穿透，三种：
 *   sakura（默认）  樱花穿透：填 natfrp 的访问密钥 + 隧道编号，走 frpc
 *   cloudflared     Cloudflare 临时隧道：不注册也能出一个 trycloudflare.com 的地址
 *   frp             用户自己的 frpc + 任意参数
 * 状态：off / starting / on / error
 */
export class Tunnel extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.state = 'off';
    this.url = '';
    this.error = null;
    this.kind = 'sakura';
    this.refused = false;
    this.manualUrl = '';
    this.logs = [];
  }

  setState(state, error = null) {
    this.state = state;
    this.error = error;
    this.emit('state');
  }

  log(line) {
    this.logs.push({ at: Date.now(), text: String(line).trim() });
    if (this.logs.length > 200) this.logs.splice(0, this.logs.length - 200);
    this.emit('log');
  }

  locate() {
    if (isWindows) {
      if (fs.existsSync(CLOUDFLARED_EXE)) return CLOUDFLARED_EXE;
      const which = spawnSync('where', ['cloudflared'], { encoding: 'utf8', windowsHide: true });
      const first = (which.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first) return first;
      const pkg = path.join(LAUNCHER_DIR, 'bin', 'cloudflared.msix');
      if (fs.existsSync(pkg)) return pkg;
      return null;
    }
    const which = spawnSync('which', ['cloudflared'], { encoding: 'utf8' });
    return (which.stdout ?? '').trim() || null;
  }

  /** 找 frpc：配置里填的路径 → launcher/bin/frpc.exe → PATH 里的 frpc。 */
  locateFrpc(configured) {
    const custom = (configured ?? '').trim();
    if (custom && fs.existsSync(custom)) return custom;
    if (fs.existsSync(FRPC_EXE)) return FRPC_EXE;
    const which = spawnSync(isWindows ? 'where' : 'which', ['frpc'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const first = (which.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first || null;
  }

  /**
   * 自动检测：先找樱花启动器（SakuraLauncher.exe），它旁边一般就有 frpc.exe；
   * 再找几个常见安装位置和 PATH。找不到就把看过的地方报给用户。
   */
  detectFrpc() {
    const probes = [];
    const push = (dir) => {
      if (dir) probes.push(path.join(dir, 'frpc.exe'), path.join(dir, 'SakuraLauncher.exe'));
    };

    push(path.join(LAUNCHER_DIR, 'bin'));

    const localApp = process.env.LOCALAPPDATA ?? '';
    const appData = process.env.APPDATA ?? '';
    const programFiles = process.env.ProgramFiles ?? '';
    const programFiles86 = process.env['ProgramFiles(x86)'] ?? '';
    const userHome = process.env.USERPROFILE ?? '';

    const sakuraDirs = [];
    for (const root of [programFiles, programFiles86, localApp, appData, userHome]) {
      if (!root) continue;
      sakuraDirs.push(path.join(root, 'SakuraFrpLauncher'));
      sakuraDirs.push(path.join(root, 'SakuraFrp'));
      sakuraDirs.push(path.join(root, 'Programs', 'SakuraFrpLauncher'));
      sakuraDirs.push(path.join(root, 'Programs', 'SakuraFrp'));
    }
    for (const drive of ['C:', 'D:', 'E:']) {
      sakuraDirs.push(drive + '\\SakuraFrp');
      sakuraDirs.push(drive + '\\SakuraFrpLauncher');
      sakuraDirs.push(drive + '\\Program Files\\SakuraFrpLauncher');
      sakuraDirs.push(drive + '\\Program Files\\SakuraFrp');
    }
    sakuraDirs.push(path.join(userHome || 'C:', 'Desktop', 'SakuraFrpLauncher'));
    sakuraDirs.push(path.join(userHome || 'C:', 'Downloads', 'SakuraFrpLauncher'));
    sakuraDirs.push(path.join(userHome || 'C:', 'Downloads', 'SakuraFrp'));

    for (const base of [localApp, appData, programFiles, programFiles86, ...sakuraDirs]) {
      push(base);
      // 有的版本把 frpc 放在子目录里
      if (base) probes.push(path.join(base, 'frpc', 'frpc.exe'));
    }

    // 樱花启动器如果装在别处，从开始菜单和常见目录里再捞一下
    for (const base of [appData, userHome]) {
      if (!base) continue;
      for (const sub of ['Microsoft\\Windows\\Start Menu\\Programs']) {
        push(path.join(base, sub, 'SakuraFrpLauncher'));
      }
    }

    let launcher = null;
    for (const p of probes) {
      if (!p) continue;
      if (p.endsWith('SakuraLauncher.exe') && !launcher && fs.existsSync(p)) launcher = p;
    }
    if (launcher) {
      // 樱花启动器下载的 frpc 就在它自己目录里，先在原地找
      const dir = path.dirname(launcher);
      const near = path.join(dir, 'frpc.exe');
      const sub = path.join(dir, 'frpc', 'frpc.exe');
      if (fs.existsSync(near)) return { ok: true, path: near, launcher, message: '找到了：' + near + '（在樱花启动器旁边）' };
      if (fs.existsSync(sub)) return { ok: true, path: sub, launcher, message: '找到了：' + sub + '（在樱花启动器子目录里）' };
    }

    for (const p of probes) {
      if (!p || !p.endsWith('frpc.exe')) continue;
      if (fs.existsSync(p)) {
        return {
          ok: true,
          path: p,
          launcher,
          message: launcher
            ? `找到了：${p}（樱花启动器在 ${launcher}）`
            : `找到了：${p}`,
        };
      }
    }

    // 樱花启动器在，但它旁边没有 frpc.exe
    if (launcher) {
      return {
        ok: false,
        path: null,
        launcher,
        message: `找到樱花启动器（${launcher}），但旁边没有 frpc.exe。先打开一次樱花启动器，它会自己下载 frpc，然后再点自动检测。`,
      };
    }

    const where = spawnSync('where', ['frpc'], { encoding: 'utf8', windowsHide: true });
    const first = (where.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first) return { ok: true, path: first, launcher: null, message: `PATH 里找到了：${first}` };

    return {
      ok: false,
      path: null,
      launcher: null,
      message: '没找到 frpc.exe。去 natfrp.com「软件下载」下它，放进 <安装目录>\\launcher\\bin\\ 里，或者点右边的文件夹按钮自己选。',
    };
  }

  /** 下载 cloudflared（只有 Windows 的 x64 版本，够用了）。 */
  async download() {
    if (!isWindows) throw new Error('自动下载只做了 Windows 版，Mac/Linux 请自己装 cloudflared。');
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
    this.log('正在下载 cloudflared（约 40MB）……');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 120_000);
    try {
      const res = await fetch(url, { redirect: 'follow', signal: ac.signal });
      if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1_000_000) throw new Error('下载下来的文件不像 cloudflared（太小了）。');
      fs.writeFileSync(CLOUDFLARED_EXE, buf);
      this.log(`下载好了：${CLOUDFLARED_EXE}`);
      return CLOUDFLARED_EXE;
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error('下载超时（2 分钟）。GitHub 在国内经常连不上，建议直接用 frp，或者手动装 cloudflared。');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async start(port, kind = 'cloudflared', frp = {}) {
    if (this.state === 'on' || this.state === 'starting') return this.snapshot();
    this.kind = kind;
    this.url = '';
    this.error = null;
    this.setState('starting');

    let command;
    let args;
    if (kind === 'sakura') {
      const token = String(frp.sakuraToken ?? '').trim();
      const tunnelId = String(frp.sakuraTunnel ?? '').trim();
      if (!token) {
        this.setState('error', '没填樱花穿透的访问密钥。去 natfrp.com「用户信息」里复制，形如 AbCdEf…');
        return this.snapshot();
      }
      if (!tunnelId) {
        this.setState('error', '没填隧道编号。natfrp.com「隧道」列表里那条隧道前面的数字就是。');
        return this.snapshot();
      }
      command = this.locateFrpc(frp.frpcExe);
      if (!command) {
        this.setState(
          'error',
          '没找到 frpc。樱花穿透的客户端要去 natfrp.com「软件下载」下 frpc.exe，放进 <安装目录>\\launcher\\bin\\ 里，或者在上面填它的完整路径。',
        );
        return this.snapshot();
      }
      // 樱花穿透的启动方式：frpc -f <访问密钥>:<隧道编号>
      args = ['-f', `${token}:${tunnelId}`];
    } else if (kind === 'frp') {
      const exe = (frp.frpExe ?? '').trim();
      if (!exe) {
        this.setState('error', '没填 frp 的程序路径。');
        return this.snapshot();
      }
      command = exe;
      args = (frp.frpArgs ?? '').split(/\s+/).filter(Boolean).map((a) => a.replace('{port}', String(port)));
    } else {
      command = this.locate();
      if (!command) {
        this.setState('error', '没找到 cloudflared。点「下载 cloudflared」装一个，或者换成樱花穿透。');
        return this.snapshot();
      }
      args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];
    }

    this.log(`启动穿透：${command} ${args.join(' ')}`);
    this.child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const child = this.child;
    const onData = (buf) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.log(line);
        if (this.url) continue;

        if (kind === 'sakura') {
          // 樱花启动器自带的 frpc 是改过的，会直接拒绝被外部程序调用
          if (/not intended to be run directly|SakuraFrp Service/i.test(line)) {
            this.refused = true;
            return;
          }
          // 樱花 frpc 会打印「远程地址: xxxx.natfrp.cloud:12345」这类东西
          const m = line.match(/([a-z0-9][a-z0-9-]*\.natfrp\.(?:cloud|com))(?::(\d+))?/i);
          if (m) {
            const port2 = m[2] ? `:${m[2]}` : '';
            this.url = /:443$/.test(port2) ? `https://${m[1]}` : `http://${m[1]}${port2}`;
            this.setState('on');
          }
          continue;
        }

        const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) {
          this.url = m[0];
          this.setState('on');
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      this.child = null;
      this.setState('error', `穿透程序起不来：${err.message}`);
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.state === 'starting' || this.state === 'on') {
        if (this.refused) {
          this.refused = false;
          this.setState(
            'error',
            '樱花启动器自带的 frpc 不允许被别的程序调用（它打印说只给 SakuraFrp Service 用）。\n' +
              '改用手动模式：打开樱花启动器 → 启动你的隧道 → 把「远程地址」复制下来，填到上面的输入框里，点「用这个地址」。',
          );
          return;
        }
        // 把穿透程序自己吐的最后几行带出来，不然只看到「退出了」没法查
        const tail = this.logs
          .slice(-6)
          .map((l) => l.text)
          .filter((t) => t && !t.startsWith('启动穿透：'))
          .join('\n');
        this.setState('error', `穿透程序退出了（退出码 ${code}）。` + (tail ? '\n' + tail : ''));
      } else {
        this.setState('off');
      }
    });

    // 最多等 30 秒出地址
    for (let i = 0; i < 60; i++) {
      if (this.url || this.state === 'error') break;
      await sleep(500);
    }
    if (!this.url && this.state !== 'error') this.setState('error', '等了 30 秒还没拿到穿透地址，看看日志里写了什么。');
    return this.snapshot();
  }

  /** 手动模式：用户自己在樱花启动器里开好隧道，把公网地址填进来 */
  useManual(url) {
    const v = String(url ?? '').trim();
    if (!v) {
      this.manualUrl = '';
      this.url = '';
      this.setState('off');
      return this.snapshot();
    }
    if (!/^https?:\/\//i.test(v)) {
      this.setState('error', '地址要以 http:// 或 https:// 开头');
      return this.snapshot();
    }
    this.kind = 'manual';
    this.manualUrl = v;
    this.url = v;
    this.error = null;
    this.setState('on');
    return this.snapshot();
  }

  async stop() {
    if (!this.child) {
      this.setState('off');
      return this.snapshot();
    }
    const pid = this.child.pid;
    this.setState('off');
    if (isWindows && pid) {
      await new Promise((resolve) => {
        const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        k.on('exit', resolve);
        k.on('error', resolve);
      });
    } else if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // ignore
      }
    }
    this.child = null;
    this.url = '';
    this.manualUrl = '';
    return this.snapshot();
  }

  snapshot() {
    return {
      state: this.state,
      url: this.url,
      error: this.error,
      kind: this.kind,
      installed: this.kind === 'sakura' ? !!this.locateFrpc(null) : !!this.locate(),
      logs: this.logs.slice(-20),
    };
  }
}
