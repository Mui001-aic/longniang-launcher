# 龙娘跑团 · 启动器

给 [龙娘跑团](https://github.com/bwxnQAQ/longniang-trpg) 写的桌面启动器：
点开就能起一份本地游戏服务端，用你自己的 DeepSeek 密钥跑 AI 主持人。

**游戏本体不是我写的**，这个仓库只包含启动器（外壳 + 控制面板 + 安装器）。

---

## 它长什么样

```
启动器.vbs
  └─ electron\LongNiang.exe         Electron 外壳：窗口 + 托盘 + 无边框标题栏
       └─ node launcher\server.mjs  控制面板，监听 127.0.0.1:3210
            └─ node ai-trpg-…/server/index.ts   游戏服务端，监听 127.0.0.1:3000
```

外壳不碰游戏逻辑，只通过 `http://127.0.0.1:3210/` 跟面板通信；面板再通过进程管理起停游戏。

## 功能

- 一键起停游戏服务端，显示运行时长和本机地址
- 第一次运行建站长账号、填 DeepSeek 密钥（也可以先用假主持人试流程）
- 检查上游仓库有没有新版本（GitHub API 连不上时自动走镜像）
- 内网穿透：局域网地址列表 + 手动填隧道地址（樱花穿透的 frpc 不允许被外部程序调用，只能手动）
- 托盘常驻：关窗口不关游戏
- 自定义外观：7 套配色、标题栏文字、背景图（存在本机浏览器里）
- 卸载器：备份存档 → 删目录 → 清理安装记录

## 目录

```
launcher/            启动器本体（纯 Node，零依赖）
  server.mjs         面板的 HTTP 服务
  lib/game.mjs       起停游戏、读状态
  lib/tunnel.mjs     局域网地址、手动隧道地址、cloudflared
  lib/update.mjs     检查更新（含镜像回退）
  lib/setup.mjs      第一次运行建站长号
  lib/envfile.mjs    改 .env
  lib/config.mjs     launcher.json 读写
  ui/                面板页面（原生 HTML/CSS/JS，没有框架）
electron/            Electron 外壳
  main.js            窗口、托盘、无边框标题栏、IPC
  preload.js         给页面的桥（开窗口 / 选文件 / 最小化 / 关闭）
installer/           安装器和卸载器（C# WinForms，用 csc 编译）
  Sfx.cs             自解压安装器：免责声明 → 选目录 → 解压 → 快捷方式 → 启动
  Uninstall.cs       卸载器
  AssemblyInfo.cs    版本信息
build/               构建脚本
docs/                给上游游戏的改动说明
```

## 怎么构建

**前置**：Windows、.NET Framework 4.x（自带 `csc.exe`）、Node 20+。

### 1. 控制面板

不用构建，`launcher/` 里就是最终代码，直接 `node launcher/server.mjs` 能跑。

### 2. Electron 外壳

`electron/` 是完整的 Electron app 源码，需要打成 exe：

```
npm i -g electron-packager
electron-packager electron LongNiang --platform=win32 --arch=x64 --out=dist --overwrite
```

把产物放到 `electron/` 里（和 `resources/app` 同级），面板的「打开游戏窗口」和托盘才会工作。

### 3. 安装器

安装器 = 一个 C# 壳子 + 内嵌的 `payload.zip`。payload 里是**游戏本体 + Electron 运行时 + 启动器**，
约 150MB，因为含别人的 AGPL 代码和二进制，本仓库不提供。

自己打一个：

```powershell
# 1. 准备 payload 目录（和安装后的目录结构一致）
#    安装目录\
#      ai-trpg-V1.0.2\   游戏本体
#      electron\         Electron 运行时（含 resources/app）
#      launcher\         本仓库的 launcher/
#    然后压缩成 payload.zip

# 2. 编译
.\build\build-installer.ps1 -Payload payload.zip -Icon build\icon.ico -Version 1.6.4
```

编译出来的就是发布用的 `LongNiang.exe`（免安装，双击自解压）。

### 4. 卸载器

```powershell
.\build\build-uninstaller.ps1 -Icon build\icon.ico
```

## 发新版（自动更新怎么生效）

启动器的「设置 → 启动项」里有一行**启动器更新**，它去自己的仓库查版本。
两种发布方式，二选一：

**方式 A：改 `launcher/version.json`（最省事）**

```json
{
  "version": "1.6.4",
  "url": "https://github.com/Mui001/longniang-launcher/releases",
  "download": "",
  "notes": "这次改了什么"
}
```

把 `version` 改成新版本号，提交到 main 分支。启动器下次检查（缓存 6 小时）就会提示有新版本。

**方式 B：建 GitHub Release**

1. Releases → Create a new release
2. Tag 写成版本号，比如 `v1.6.4`（前面的 v 会被自动去掉）
3. 把新的 `LongNiang.exe` 作为附件传上去
4. Publish

启动器优先读 Release（tag 当版本号，附件当下载链接），没有 Release 才去读 `version.json`。

**版本号从哪来**：`launcher/build.json` 里的 `launcherVersion`。
改版本时**两个地方都要改**：`build.json`（启动器自报的版本）和发布源（`version.json` 或 Release tag）。

## 许可证

- **本仓库（启动器）**：MIT，见 [LICENSE](LICENSE)
- **游戏本体**：AGPL-3.0，作者 花崎诗奏，[bwxnQAQ/longniang-trpg](https://github.com/bwxnQAQ/longniang-trpg)。
  分发包含游戏本体的安装包时必须遵守 AGPL-3.0：保留署名、提供源码。

## 致谢

- 游戏本体：[花崎诗奏](https://space.bilibili.com/397694843)
- 内网穿透：[樱花穿透](https://www.natfrp.com/)

## 免责

个人作品，非官方。只在作者本人的 B站 账号（Mui001_aic）发布。
从其他渠道拿到的安装包无法确认真伪，不为其安全性负责。

本软件按你拿到的样子提供，不做任何保证：不保证一定能用、不保证不出错、不保证不丢存档。
AI 生成的内容不保证正确，费用由使用者自己承担。
