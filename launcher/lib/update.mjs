import fs from 'node:fs';
import path from 'node:path';
import { LAUNCHER_DIR, STATE_DIR } from './config.mjs';

/**
 * 检查 GitHub 上有没有新版本。
 *
 * 判断依据有两个，谁先命中算谁：
 *   1. 仓库里 package.json 的 version 比本地游戏高（作者发版会改它）
 *   2. 仓库最新提交的 sha 跟打包时记下的 sha 不一样（作者提交了但没改版本号）
 *
 * 结果缓存在 launcher/state/update.json，6 小时内不重复请求（GitHub 未登录是 60 次/小时）。
 */

export const REPO = 'bwxnQAQ/longniang-trpg';
const API = `https://api.github.com/repos/${REPO}`;
const RAW = `https://raw.githubusercontent.com/${REPO}/main/package.json`;
const CACHE_FILE = path.join(STATE_DIR, 'update.json');
const TTL_MS = 6 * 60 * 60 * 1000;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

/** 本地这份是什么版本：优先看打包时记下的 build.json，其次读游戏自己的 package.json。 */
export function localInfo(gameDir) {
  const build = readJson(path.join(LAUNCHER_DIR, 'build.json'), null);
  const pkg = readJson(path.join(gameDir, 'package.json'), null);
  return {
    gameVersion: pkg?.version ?? build?.gameVersion ?? '未知',
    builtAt: build?.builtAt ?? null,
    commit: build?.commit ?? null,
  };
}

async function fetchJson(url, timeoutMs = 12_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'longniang-launcher', Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function versionParts(v) {
  return String(v ?? '')
    .split(/[^\d]+/)
    .filter((s) => s !== '')
    .map((n) => Number(n));
}

function versionGreater(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (p > q) return true;
    if (p < q) return false;
  }
  return false;
}

function readCache() {
  const cached = readJson(CACHE_FILE, null);
  return cached && typeof cached.checkedAt === 'number' ? cached : null;
}

function writeCache(data) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
  } catch {
    // 写不了就算了，下次重新查
  }
}

/**
 * 真正去网上查一次。网络不通就抛错，由调用方决定用旧缓存还是报错。
 *
 * 直连 GitHub 经常连不上：有的网络把 github.com 的证书换掉了（杀毒软件、公司代理），
 * node 会报 UNABLE_TO_VERIFY_LEAF_SIGNATURE。所以这里挨个试镜像，能通一个就行。
 */
async function fetchRemote() {
  const commitUrls = [
    `${API}/commits?per_page=1`,
    `https://gh-proxy.com/https://api.github.com/repos/${REPO}/commits?per_page=1`,
    `https://ghproxy.net/https://api.github.com/repos/${REPO}/commits?per_page=1`,
  ];
  const pkgUrls = [
    RAW,
    `https://cdn.jsdelivr.net/gh/${REPO}@main/package.json`,
    `https://ghproxy.net/https://raw.githubusercontent.com/${REPO}/main/package.json`,
  ];

  let latest = null;
  let lastError = null;
  let commitSource = null;
  for (const url of commitUrls) {
    try {
      const data = await fetchJson(url);
      if (Array.isArray(data) && data[0]) {
        latest = data[0];
        commitSource = url.startsWith('https://api.github.com') ? 'github' : 'mirror';
        break;
      }
    } catch (err) {
      lastError = err;
    }
  }
  if (!latest) {
    const msg = String(lastError?.cause?.code ?? lastError?.message ?? '');
    if (/UNABLE_TO_VERIFY_LEAF_SIGNATURE|self.signed|CERT/i.test(msg)) {
      throw new Error('连 GitHub 失败：证书校验没过（可能有杀毒软件或代理在中间换证书），镜像也没通');
    }
    throw new Error(msg ? `连 GitHub 失败：${msg}` : '连 GitHub 失败');
  }

  let pkg = null;
  for (const url of pkgUrls) {
    try {
      pkg = await fetchJson(url);
      if (pkg?.version) break;
    } catch {
      // 换下一个
    }
  }

  const message = String(latest.commit?.message ?? '');
  return {
    remoteVersion: pkg?.version ?? null,
    commit: latest.sha ?? null,
    commitShort: (latest.sha ?? '').slice(0, 7),
    commitDate: latest.commit?.author?.date ?? null,
    commitTitle: message.split('\n')[0]?.trim() ?? '',
    commitUrl: latest.html_url ?? `https://github.com/${REPO}/commit/${latest.sha}`,
    repoUrl: `https://github.com/${REPO}`,
    source: commitSource,
  };
}

/**
 * 返回给面板用的检查结果。失败时尽量退回缓存，并带上 error，让人知道这不是「已是最新」。
 */
export async function checkForUpdate(gameDir, { force = false } = {}) {
  const local = localInfo(gameDir);
  const cached = readCache();

  if (!force && cached && Date.now() - cached.checkedAt < TTL_MS) {
    return buildResult(local, cached.remote, { cached: true, error: null });
  }

  try {
    const remote = await fetchRemote();
    writeCache({ checkedAt: Date.now(), remote });
    return buildResult(local, remote, { cached: false, error: null });
  } catch (err) {
    const message = err?.name === 'AbortError' ? '连 GitHub 超时了' : String(err?.message ?? err);
    if (cached) return buildResult(local, cached.remote, { cached: true, error: message });
    return {
      ok: false,
      checkedAt: null,
      local,
      remote: null,
      hasUpdate: false,
      error: message,
      repoUrl: `https://github.com/${REPO}`,
    };
  }
}

function buildResult(local, remote, { cached, error }) {
  const newer = remote?.remoteVersion ? versionGreater(remote.remoteVersion, local.gameVersion) : false;
  const differentCommit = !!(remote?.commit && local.commit && remote.commit !== local.commit);
  const sameVersionNewCommit = differentCommit && !newer;
  return {
    ok: !error,
    checkedAt: Date.now(),
    cached,
    error,
    local,
    remote,
    hasUpdate: newer || sameVersionNewCommit,
    reason: newer
      ? `仓库已经到 ${remote.remoteVersion}，你现在是 ${local.gameVersion}`
      : sameVersionNewCommit
        ? '版本号没变，但仓库有新提交'
        : '',
    repoUrl: remote?.repoUrl ?? `https://github.com/${REPO}`,
  };
}


/* ================= 启动器自己的更新检查 ================= */

/**
 * 启动器版本的发布源：自己的 GitHub 仓库。
 * 优先读 Releases（tag 就是版本号），没有 Releases 再读仓库里的 launcher/version.json。
 * 两种都拿不到时，明确说「还没发布过」，不能报成「已是最新」。
 */
export const LAUNCHER_REPO = 'Mui001-aic/longniang-launcher';
const LAUNCHER_CACHE = path.join(STATE_DIR, 'launcher-update.json');

function localLauncherVersion() {
  const b = readJson(path.join(LAUNCHER_DIR, 'build.json'), null);
  return b?.launcherVersion ?? null;
}

/** 版本号比较：a 比 b 新就 true */
function versionNewer(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (p > q) return true;
    if (p < q) return false;
  }
  return false;
}

/** 依次试：GitHub API → 镜像；再试仓库里的 version.json */
async function fetchLauncherRemote() {
  const apiUrls = [
    `https://api.github.com/repos/${LAUNCHER_REPO}/releases/latest`,
    `https://gh-proxy.com/https://api.github.com/repos/${LAUNCHER_REPO}/releases/latest`,
    `https://ghproxy.net/https://api.github.com/repos/${LAUNCHER_REPO}/releases/latest`,
  ];
  const jsonUrls = [
    `https://raw.githubusercontent.com/${LAUNCHER_REPO}/main/launcher/version.json`,
    `https://cdn.jsdelivr.net/gh/${LAUNCHER_REPO}@main/launcher/version.json`,
    `https://gh-proxy.com/https://raw.githubusercontent.com/${LAUNCHER_REPO}/main/launcher/version.json`,
  ];

  for (const url of apiUrls) {
    try {
      const data = await fetchJson(url);
      const tag = String(data?.tag_name ?? '').replace(/^v/i, '');
      if (!tag) continue;
      const asset = (data.assets ?? []).find((a) => /\.(exe|zip)$/i.test(a.name ?? ''));
      return {
        version: tag,
        notes: String(data.body ?? '').slice(0, 800),
        url: data.html_url ?? `https://github.com/${LAUNCHER_REPO}/releases`,
        download: asset?.browser_download_url ?? null,
        source: 'releases',
      };
    } catch {
      // 换下一个
    }
  }

  for (const url of jsonUrls) {
    try {
      const data = await fetchJson(url);
      const v = String(data?.version ?? '').replace(/^v/i, '');
      if (!v) continue;
      return {
        version: v,
        notes: String(data.notes ?? '').slice(0, 800),
        url: data.url ?? `https://github.com/${LAUNCHER_REPO}/releases`,
        download: data.download ?? null,
        source: 'version.json',
      };
    } catch {
      // 换下一个
    }
  }

  const err = new Error(
    '没找到启动器的发布版本。仓库 ' + LAUNCHER_REPO + ' 里既没有 Release，也没有 launcher/version.json。',
  );
  err.code = 'NO_RELEASES';
  throw err;
}

/**
 * 返回给面板用：本地版本、远端版本、要不要更新。
 * 和游戏那个一样缓存 6 小时，force 可以强制刷新。
 */
export async function checkLauncherUpdate({ force = false } = {}) {
  const local = localLauncherVersion();
  const cached = readJson(LAUNCHER_CACHE, null);
  const ttl = TTL_MS;

  if (!force && cached && typeof cached.checkedAt === 'number' && Date.now() - cached.checkedAt < ttl) {
    return { ...cached, cached: true, error: cached.error ?? null };
  }

  try {
    const remote = await fetchLauncherRemote();
    const hasUpdate = local ? versionNewer(remote.version, local) : false;
    const result = {
      checkedAt: Date.now(),
      local,
      remote,
      hasUpdate,
      error: null,
      repoUrl: `https://github.com/${LAUNCHER_REPO}`,
    };
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(LAUNCHER_CACHE, JSON.stringify(result, null, 2));
    } catch {
      // 写不了就算了，下次重新查
    }
    return { ...result, cached: false };
  } catch (err) {
    const message = err?.name === 'AbortError' ? '连 GitHub 超时了' : String(err?.message ?? err);
    const result = {
      checkedAt: cached?.checkedAt ?? null,
      local,
      remote: cached?.remote ?? null,
      hasUpdate: false,
      error: message,
      repoUrl: `https://github.com/${LAUNCHER_REPO}`,
    };
    if (cached?.remote) return { ...result, cached: true };
    return { ...result, cached: false };
  }
}
