import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 端口有没有程序在监听。 */
export function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/** 从 start 开始找一个空端口。 */
export async function findFreePort(start, tries = 20) {
  for (let port = start; port < start + tries; port++) {
    if (await portFree(port)) return port;
  }
  return null;
}

/** 本机的局域网地址（给同 WiFi 下的朋友用）。 */
export function lanAddresses() {
  const result = [];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      // 虚拟网卡（VMware、WSL、VPN）一般也在这里，但不影响连；名字一起带上方便用户自己判断
      result.push({ iface: name, address: info.address });
    }
  }
  return result;
}

/** 判断某个地址上的网站是不是已经起来了。 */
export async function probeHttp(url, timeoutMs = 1500) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'manual' });
    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

/** 需要用户在资源管理器里打开某个文件夹时用。 */
export function isAsciiPath(p) {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(p);
}

export function dirSize(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += dirSize(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
    }
  } catch {
    // 算不准就算了
  }
  return total;
}
