import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { aiSummary, gamePort } from './envfile.mjs';
import { inspectData } from './db.mjs';
import { portFree, probeHttp, sleep } from './util.mjs';
import { LAUNCHER_DIR } from './config.mjs';

const isWindows = process.platform === 'win32';
const TSX_CLI = path.join('node_modules', 'tsx', 'dist', 'cli.mjs');
const MAX_LOG_LINES = 800;

/**
 * 游戏服务器（ai-trpg 本体）的进程管家。
 * 状态：stopped / preparing / starting / running / stopping / error
 */
export class GameServer extends EventEmitter {
  constructor(gameDir) {
    super();
    this.gameDir = gameDir;
    this.child = null;
    this.state = 'stopped';
    this.error = null;
    this.startedAt = 0;
    this.logLines = [];
    this.logSeq = 0;
    this.port = gamePort(gameDir);
    this.installChild = null;
  }

  get url() {
    return `http://127.0.0.1:${this.port}/`;
  }

  log(line) {
    for (const raw of String(line).split(/\r?\n/)) {
      if (!raw.trim()) continue;
      this.logSeq += 1;
      this.logLines.push({ seq: this.logSeq, at: Date.now(), text: stripAnsi(raw) });
    }
    if (this.logLines.length > MAX_LOG_LINES) this.logLines.splice(0, this.logLines.length - MAX_LOG_LINES);
    this.emit('log');
  }

  setState(state, error = null) {
    this.state = state;
    this.error = error;
    this.emit('state');
  }

  logsSince(seq = 0) {
    return this.logLines.filter((l) => l.seq > seq);
  }

  hasDeps() {
    return fs.existsSync(path.join(this.gameDir, TSX_CLI));
  }

  /** 没装过依赖就现装（第一次运行会走这里）。 */
  async prepare() {
    if (this.hasDeps()) return true;
    this.setState('preparing');
    this.log('第一次运行：正在安装依赖（要联网，几十秒）……');
    const ok = await this.runCommand(
      isWindows ? process.env.ComSpec || 'cmd.exe' : 'sh',
      isWindows ? ['/d', '/s', '/c', 'npm install --no-audit --no-fund'] : ['-c', 'npm install --no-audit --no-fund'],
      { label: '安装依赖' },
    );
    if (!ok || !this.hasDeps()) {
      this.setState('error', '依赖没装好。检查一下有没有装 Node.js（22.13 以上），或者手动在游戏文件夹里运行 npm install。');
      return false;
    }
    this.log('依赖装好了。');
    // 装完了要回到「没在跑」，否则后面的启动会以为还在准备中
    if (this.state === 'preparing') this.setState('stopped');
    return true;
  }

  runCommand(command, args, { label, stdin } = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, args, { cwd: this.gameDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        this.log(`${label ?? '命令'}启动失败：${err.message}`);
        resolve(false);
        return;
      }
      if (stdin) child.stdin.end(stdin);
      else child.stdin.end();
      this.installChild = child;
      child.stdout.on('data', (d) => this.log(d.toString('utf8')));
      child.stderr.on('data', (d) => this.log(d.toString('utf8')));
      child.on('error', (err) => {
        this.installChild = null;
        this.log(`${label ?? '命令'}出错：${err.message}`);
        resolve(false);
      });
      child.on('exit', (code) => {
        this.installChild = null;
        resolve(code === 0);
      });
    });
  }

  async start() {
    if (this.state === 'running' || this.state === 'starting' || this.state === 'preparing') return this.snapshot();
    this.error = null;
    this.port = gamePort(this.gameDir);
    const prepared = await this.prepare();
    if (!prepared) return this.snapshot();

    const free = await portFree(this.port);
    if (!free) {
      // 端口上可能已经有一个我们自己的游戏在跑（比如上次没关干净）
      const status = await probeHttp(this.url, 1200);
      if (status > 0) {
        this.setState('running');
        this.startedAt = this.startedAt || Date.now();
        this.log(`端口 ${this.port} 上已经有游戏在跑，直接用它。`);
        return this.snapshot();
      }
      this.setState('error', `端口 ${this.port} 被别的程序占用了。到「设置」里换一个端口，或者先关掉占用它的程序。`);
      return this.snapshot();
    }

    this.setState('starting');
    this.startedAt = Date.now();
    this.log(`正在启动游戏服务器（端口 ${this.port}）……`);
    const nodeArgs = [path.join(this.gameDir, TSX_CLI), path.join('server', 'index.ts')];
    this.child = spawn(process.execPath, nodeArgs, {
      cwd: this.gameDir,
      windowsHide: true,
      env: { ...process.env, PORT: String(this.port), HOST: '0.0.0.0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const child = this.child;
    child.stdout.on('data', (d) => this.log(d.toString('utf8')));
    child.stderr.on('data', (d) => this.log(d.toString('utf8')));
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.state === 'stopping' || this.state === 'stopped') {
        this.setState('stopped');
        return;
      }
      const tail = this.logLines.slice(-6).map((l) => l.text).join('\n');
      this.setState('error', `游戏服务器退出了（退出码 ${code ?? signal}）。\n${tail}`);
    });

    // 第一次启动要构建网页 + 跑数据库升级，慢一点，最多等 3 分钟
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (!this.child) return this.snapshot(); // 已经退出了
      const status = await probeHttp(this.url, 1500);
      if (status >= 200 && status < 500) {
        this.setState('running');
        this.log(`游戏已经可以打开了：${this.url}`);
        return this.snapshot();
      }
      await sleep(500);
    }
    this.setState('error', '启动超时（3 分钟没起来）。看下面的日志，最后几行通常写着原因。');
    return this.snapshot();
  }

  async stop() {
    if (!this.child) {
      this.setState('stopped');
      return this.snapshot();
    }
    this.setState('stopping');
    const pid = this.child.pid;
    this.log('正在停止游戏服务器……');
    if (isWindows && pid) {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('exit', resolve);
        killer.on('error', resolve);
      });
    } else if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // 已经没了
      }
    }
    for (let i = 0; i < 40 && this.child; i++) await sleep(200);
    if (this.child) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        // 已经没了
      }
      this.child = null;
    }
    this.setState('stopped');
    return this.snapshot();
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  snapshot() {
    const data = inspectData(this.gameDir);
    return {
      state: this.state,
      error: this.error,
      port: this.port,
      url: this.url,
      pid: this.child?.pid ?? null,
      uptimeMs: this.state === 'running' && this.startedAt ? Date.now() - this.startedAt : 0,
      depsReady: this.hasDeps(),
      logSeq: this.logSeq,
      ai: aiSummary(this.gameDir),
      owner: { exists: data.hasOwner, users: data.users, dbReady: data.exists, error: data.error },
      gameDir: this.gameDir,
      launcherDir: LAUNCHER_DIR,
    };
  }
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}
