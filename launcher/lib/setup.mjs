import path from 'node:path';
import { ensureEnvFile } from './envfile.mjs';

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

export function validateAccount({ username, displayName, password, password2 }) {
  if (!USERNAME_RE.test(username ?? '')) return '用户名要用 3～20 位字母、数字或下划线。';
  const display = (displayName ?? '').trim() || username;
  if (display.length < 1 || display.length > 20) return '显示名要在 1～20 个字之间。';
  if ((password ?? '').length < 8) return '密码至少 8 位。';
  if (password.length > 128) return '密码太长了（最多 128 位）。';
  if (password !== password2) return '两次输入的密码不一样。';
  return null;
}

/**
 * 建站长账号：调用游戏自带的 reset.ts --first-run，把答案按行喂给它。
 * 必须在服务器没跑的时候调用。
 */
export async function createOwner(game, account) {
  ensureEnvFile(game.gameDir);
  // 建账号的脚本会检查端口上有没有别的服务器在跑，这里先自己看一眼，给出人话
  const { portFree } = await import('./util.mjs');
  if (!(await portFree(game.port))) {
    return {
      ok: false,
      message: `端口 ${game.port} 上已经有别的程序在跑（可能是另一个龙娘跑团，或者上次没关干净的服务器）。\n先把它关掉，或者在「设置」里换个端口，再建账号。`,
    };
  }
  const stdin = [account.username, (account.displayName ?? '').trim() || account.username, account.password, account.password].join('\n') + '\n';
  const cli = path.join('node_modules', 'tsx', 'dist', 'cli.mjs');
  const ok = await game.runCommand(process.execPath, [cli, path.join('server', 'reset.ts'), '--first-run'], {
    label: '建站长账号',
    stdin,
  });
  const tail = game.logLines.slice(-12).map((l) => l.text).join('\n');
  if (!ok) {
    if (tail.includes('服务器还开着')) {
      return {
        ok: false,
        message: `端口上已经有别的服务器在跑，账号没建成。\n先关掉那个服务器，或者在「设置」里换个端口再试。`,
      };
    }
    return { ok: false, message: `建站长账号失败。\n${tail}` };
  }
  if (!game.snapshot().owner.exists) return { ok: false, message: `账号好像没建成，看看日志。\n${tail}` };
  return { ok: true, message: '站长账号建好了。' };
}

/**
 * 试一下这个 DeepSeek 密钥能不能用。返回 {ok, message}；ok 为 null 表示没法判断（网络不通）。
 */
export async function checkDeepSeekKey(key) {
  const trimmed = (key ?? '').trim().replace(/\s+/g, '');
  if (!trimmed.startsWith('sk-')) return { ok: false, message: '密钥应该以 sk- 开头，去 https://platform.deepseek.com 的 API keys 页面复制。' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12_000);
  try {
    const res = await fetch('https://api.deepseek.com/models', {
      headers: { Authorization: `Bearer ${trimmed}` },
      signal: ac.signal,
    });
    if (res.status === 200) return { ok: true, message: '密钥可以用。' };
    if (res.status === 401) return { ok: false, message: 'DeepSeek 说这个密钥不对（401）。' };
    if (res.status === 402) return { ok: false, message: '密钥是对的，但账户余额不够（402），去平台充值。' };
    return { ok: false, message: `DeepSeek 返回了 ${res.status}，稍后再试。` };
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: null, message: '连 DeepSeek 超时了，密钥先存下了，能不能用等玩的时候才知道。' };
    return { ok: null, message: '现在连不上 DeepSeek（检查一下网络或代理），密钥先存下了。' };
  } finally {
    clearTimeout(timer);
  }
}
