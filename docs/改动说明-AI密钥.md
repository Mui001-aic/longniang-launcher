# 改动说明：把 DeepSeek 密钥入口放进「管理 → AI」

基线：longniang-trpg V1.1.0（commit 022445a）
许可：AGPL-3.0（按其要求，改动也一并公开）

改了两个文件，都是**只加不改**：原有行为不动，只是多了密钥这一项。

---

## 1. `server/routes/admin/ai.ts`

文件头加了：

```ts
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config';
```

在 `registerAiRoutes` 末尾（`openrouter-models` 那个路由之后）加了三个函数和两个路由：

```ts
// ---------- DeepSeek 密钥 ----------
// 站长在网页「管理 → AI」里直接填密钥：写进 .env，再留一个重启标记。
// 密钥本身藏在服务端，页面上只看得到打码后的样子。

function envValue(key: string): string { /* 从 .env 里读一个值 */ }
function writeEnv(key: string, value: string) { /* 改 .env 里的一行，没有就追加 */ }

/** 现在的密钥填了没有（给页面显示） */
router.get('/api/admin/ai/deepseek-key', (ctx) => {
  requireAdmin(ctx, 'ai');
  const value = envValue('DEEPSEEK_API_KEY');
  return {
    set: value.length > 0,
    masked: value.length > 10 ? `${value.slice(0, 6)}…${value.slice(-4)}` : '',
    fake: envValue('AI_PROVIDER').toLowerCase() === 'fake',
  };
});

/** 填 / 换密钥：先拿去 DeepSeek 验一次，验过（或连不上）就写进 .env，并请求重启 */
router.put('/api/admin/ai/deepseek-key', async (ctx) => {
  const owner = requireOwner(ctx);
  const raw = asObject(ctx.body).key;
  const key = typeof raw === 'string' ? raw.trim().replace(/\s+/g, '') : '';
  if (!key.startsWith('sk-') || key.length < 20) {
    throw new HttpError(400, '密钥要以 sk- 开头，去 platform.deepseek.com 的 API keys 页面复制');
  }

  let message = '密钥存好了，重启以后生效';
  try {
    const res = await fetch('https://api.deepseek.com/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 401) throw new HttpError(400, 'DeepSeek 说这个密钥不对（401）');
    if (res.status === 402) throw new HttpError(400, '密钥是对的，但余额不够（402），去平台充值');
    if (!res.ok) message = `DeepSeek 返回了 ${res.status}，密钥先存下了，重启以后试试`;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    message = '现在连不上 DeepSeek，密钥先存下了，重启以后试试';
  }

  writeEnv('DEEPSEEK_API_KEY', key);
  writeEnv('AI_PROVIDER', '');
  // 告诉外面（安卓版 / 启动器）：该重启服务了
  try {
    fs.writeFileSync(path.join(path.dirname(config.dbPath), '.restart-requested'), String(now()));
  } catch {
    // 写不了也不影响密钥已经存下
  }
  log(owner, '设置 DeepSeek 密钥', '写进 .env，等待重启');
  return { ok: true, message, needsRestart: true, masked: `${key.slice(0, 6)}…${key.slice(-4)}` };
});
```

要点：
- 只有**站长**能改（`requireOwner`），普通管理员只能看不能改。
- 验证在服务端做，密钥不经过浏览器存储。
- 服务端自己不重启（它没法重启自己），只写一个标记；外面谁托管它谁负责重启。

---

## 2. `web/src/pages/admin/AiTab.tsx`

在 `<ErrorLine error={error} />` 之后、「用哪个模型」之前插一行：

```tsx
<DeepSeekKey />
```

文件末尾加了组件 `DeepSeekKey`（约 70 行）：

```tsx
/** DeepSeek 的密钥：站长在这里填，存进 .env；服务端会留一个重启标记，App/启动器看到就重启 */
function DeepSeekKey() {
  const [state, setState] = useState<{ set: boolean; masked: string; fake: boolean } | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const load = useCallback(async () => {
    try {
      setState(await api<{ set: boolean; masked: string; fake: boolean }>('GET', '/api/admin/ai/deepseek-key'));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    const k = key.trim();
    if (!k.startsWith('sk-')) { setError('密钥要以 sk- 开头'); return; }
    setBusy(true); setError(''); setSaved('');
    try {
      const r = await api<{ message?: string }>('PUT', '/api/admin/ai/deepseek-key', { key: k });
      setSaved(r.message ?? '存好了');
      setKey('');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="openrouter-models">
      <h2 className="section-title">DeepSeek 密钥</h2>
      <p className="muted">
        {state?.set ? `已填：${state.masked}` : '还没填。没填的时候用的是假主持人（固定套话，不调用 AI、不花钱）。'}
      </p>
      <Field label="在 platform.deepseek.com 的 API keys 页面创建，要先充值" htmlFor="deepseek-key">
        <input id="deepseek-key" type="password" autoComplete="off" spellCheck={false}
               placeholder="sk-…" value={key} onChange={(e) => setKey(e.target.value)} />
      </Field>
      <div className="actions">
        <button type="button" className="btn btn-small" disabled={busy || !key.trim()} onClick={() => void save()}>
          {busy ? '正在验证……' : '保存密钥'}
        </button>
        {saved && <span className="muted" role="status">{saved}</span>}
      </div>
      <ErrorLine error={error} />
    </div>
  );
}
```

---

## 3. 安卓外壳那边（不在本仓库）

`MainActivity.java` 里加了一个线程，每 2 秒看一次 `app/data/.restart-requested`：

```java
private void watchRestart() {
    File flag = new File(gameDir, "data/.restart-requested");
    while (true) {
        try { Thread.sleep(2000); } catch (InterruptedException e) { return; }
        if (!flag.exists()) continue;
        flag.delete();
        appendText("检测到密钥/设置已修改，正在重启服务端……");
        restartServer();
    }
}
```

这样「在网页里存密钥 → 自动重启 → 生效」这条链就闭合了。
