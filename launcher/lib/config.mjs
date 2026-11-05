import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LAUNCHER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_FILE = path.join(LAUNCHER_DIR, 'launcher.json');
export const STATE_DIR = path.join(LAUNCHER_DIR, 'state');

const DEFAULTS = {
  /** 游戏本体所在的文件夹（相对本文件或绝对路径） */
  gameDir: '',
  /** 控制面板的端口，只在 127.0.0.1 上开 */
  controlPort: 3210,
  /** 启动器打开时自动启动游戏 */
  autoStart: true,
  /** 联机用的穿透工具：sakura（樱花穿透，默认）/ cloudflared / frp */
  tunnel: {
    kind: 'sakura',
    /** 樱花穿透：访问密钥和隧道编号（natfrp.com） */
    sakuraToken: '',
    sakuraTunnel: '',
    /** 樱花穿透用的 frpc.exe 路径，留空就用 launcher\\bin\\frpc.exe 或 PATH 里的 */
    frpcExe: '',
    /** 自定义 frp */
    frpExe: '',
    frpArgs: '',
  },
};

function isGameDir(dir) {
  return !!dir && fs.existsSync(path.join(dir, 'server', 'index.ts'));
}

/**
 * 找游戏本体：先看配置，再看启动器旁边的 ai-trpg* 文件夹，最后看 launcher/game。
 */
export function detectGameDir(configured) {
  if (configured) {
    const dir = path.resolve(LAUNCHER_DIR, configured);
    if (isGameDir(dir)) return dir;
  }
  const parent = path.dirname(LAUNCHER_DIR);
  let best = null;
  try {
    for (const name of fs.readdirSync(parent)) {
      const dir = path.join(parent, name);
      if (!isGameDir(dir)) continue;
      // 多个版本时取名字最大的那个（ai-trpg-V1.0.3 > ai-trpg-V1.0.2）
      if (!best || name > path.basename(best)) best = dir;
    }
  } catch {
    // 读不了就当没找到
  }
  if (best) return best;
  const self = path.join(LAUNCHER_DIR, 'game');
  return isGameDir(self) ? self : null;
}

export function loadConfig() {
  let saved = {};
  try {
    // 记事本存出来的 JSON 开头可能带 BOM，不处理的话整个文件会被当成坏的
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    saved = {};
  }
  const config = { ...DEFAULTS, ...saved, tunnel: { ...DEFAULTS.tunnel, ...(saved.tunnel ?? {}) } };
  config.gameDir = detectGameDir(config.gameDir);
  return config;
}

export function saveConfig(patch) {
  const current = loadConfig();
  const next = { ...current, ...patch };
  if (patch.tunnel) next.tunnel = { ...current.tunnel, ...patch.tunnel };
  // gameDir 存相对路径，整个文件夹搬走也能用
  if (next.gameDir) next.gameDir = path.relative(LAUNCHER_DIR, next.gameDir) || '.';
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}
