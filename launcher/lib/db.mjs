import fs from 'node:fs';
import path from 'node:path';
import { readEnvValues } from './envfile.mjs';

/**
 * 直接读游戏存档，判断「站长账号建好了没有」。
 * 只在服务器没跑的时候用，而且是只读打开，不会改存档。
 */
export function inspectData(gameDir) {
  const values = readEnvValues(gameDir);
  const dbPath = path.resolve(gameDir, values.DB_PATH || path.join('data', 'game.db'));
  const result = { dbPath, exists: false, hasOwner: false, users: 0, error: null };
  if (!fs.existsSync(dbPath)) return result;
  result.exists = true;

  let db;
  try {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true });
    const owners = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_owner = 1 AND deleted_at IS NULL').get();
    const users = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_guest = 0 AND deleted_at IS NULL').get();
    result.hasOwner = Number(owners?.n ?? 0) > 0;
    result.users = Number(users?.n ?? 0);
  } catch (err) {
    // 服务器正在跑的时候可能锁着，或者表还没建：当作「不知道」
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    try {
      db?.close();
    } catch {
      // 关不掉没关系
    }
  }
  return result;
}

/** 存档文件夹（给「打开存档」按钮用）。 */
export function dataDirOf(gameDir) {
  const values = readEnvValues(gameDir);
  const dbPath = path.resolve(gameDir, values.DB_PATH || path.join('data', 'game.db'));
  return path.dirname(dbPath);
}
