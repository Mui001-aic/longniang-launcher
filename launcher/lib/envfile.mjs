import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

export function envPath(gameDir) {
  return path.join(gameDir, '.env');
}

/** 没有设置文件就从模板复制一份（保留模板里的中文注释，用户以后自己看得懂）。 */
export function ensureEnvFile(gameDir) {
  const file = envPath(gameDir);
  if (fs.existsSync(file)) return file;
  const example = path.join(gameDir, '.env.example');
  if (fs.existsSync(example)) fs.copyFileSync(example, file);
  else fs.writeFileSync(file, '');
  return file;
}

export function readEnvText(gameDir) {
  const file = envPath(gameDir);
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

export function readEnvValues(gameDir) {
  try {
    return parseEnv(readEnvText(gameDir));
  } catch {
    return {};
  }
}

/** 改一项：有这一行（包括被 # 注释掉的）就改掉，没有就加在最后。 */
export function setEnvValue(gameDir, key, value) {
  ensureEnvFile(gameDir);
  const file = envPath(gameDir);
  let text = readEnvText(gameDir);
  const pattern = new RegExp(`^\\s*#?\\s*${key}\\s*=.*$`, 'm');
  const line = `${key}=${value}`;
  text = pattern.test(text) ? text.replace(pattern, line) : `${text.replace(/\s*$/, '')}\n${line}\n`;
  fs.writeFileSync(file, text, 'utf8');
}

export function setEnvValues(gameDir, pairs) {
  for (const [key, value] of Object.entries(pairs)) {
    if (value === undefined || value === null) continue;
    setEnvValue(gameDir, key, value);
  }
}

/** 现在用的是什么 AI：站长的密钥填了没有、是不是在用假主持人。 */
export function aiSummary(gameDir) {
  const values = readEnvValues(gameDir);
  const key = (values.DEEPSEEK_API_KEY ?? '').trim();
  const fake = (values.AI_PROVIDER ?? '').trim().toLowerCase() === 'fake';
  return {
    keySet: key.length > 0,
    keyMask: key.length > 8 ? `${key.slice(0, 6)}…${key.slice(-4)}` : key ? '已填（较短）' : '',
    fake,
    provider: fake ? 'fake' : 'deepseek',
    model: (values.CLAUDE_DM_MODEL ?? '').trim() || 'deepseek-flash',
  };
}

export function gamePort(gameDir) {
  const values = readEnvValues(gameDir);
  const port = Number(values.PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 3000;
}
