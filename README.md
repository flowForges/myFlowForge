<div align="center">

<img src="build/icon.png" alt="myFlowForge" width="128" height="128" />

# myFlowForge

**AI 编码代理的驾驶舱 —— 在你的桌面、你的服务器、你的口袋里。**

把 **Claude Code、Codex、Cursor、Gemini、qoder、opencode、DeepSeek** 等等收进同一个界面：**一轮对话里随时换代理换模型**、**多个项目并行开发**、用**手动挡的轻量工作流**把活儿理顺、在阶段之间织进你自己的 **hook**，还能**从另一台电脑或手机**接管全部。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-macOS%20·%20Windows%20·%20Linux-000000)
![Mobile](https://img.shields.io/badge/Mobile-iOS%20·%20Android-3DDC84)

**简体中文** · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

</div>

---

<div align="center">

<img src="assets/screenshots/home.jpg" alt="首页 —— 工作区、正在跑的代理、今天的改动一眼看全" width="90%" />

<sub><b>首页</b> —— 从上次停下的地方接着做。壁纸、皮肤、强调色都可以换。</sub>

</div>

---

## 这是什么

每个 AI 编码 CLI 都活在自己的终端里，各有各的会话状态、各有各的额度，彼此当对方不存在。选定一个，这个活儿就跟它绑死了。

**myFlowForge 把它们收进同一个屋檐下。** 代理和模型是**每一轮**的属性，不是整个会话的 —— 所以你可以用 Claude Opus 把方案想透，把实现交给 Codex，收尾换个便宜的，全程在同一个对话里，上下文不断。

上面再搭一层**轻量工作流**：不是那种一按就跑到底的流水线，而是同一个对话上薄薄一层结构。每个阶段都停下来等你按「下一步」。

而且这些都不锁在一台机器上。同一个驾驶舱能**连到另一台电脑** —— 你的 Linux 机器、公司那台台式机 —— 驱动**那台**的代理、跑**那台**的仓库。手机上可以看着它跑、答门、接着聊。

> **项目状态：** 个人项目，在持续开发。macOS、Windows、Linux 都有打好的包，手机端有安卓 APK。所有平台目前都**没有代码签名**。

## ✨ 真正想做好的六件事

### 1. 一整套代理，而不是一个心头好

十四个编码 CLI 共存于同一个界面：**Claude Code · Codex · Cursor · Gemini · qoder · opencode · Qwen · Copilot · Pi · Kimi · Reasonix · Trae · Antigravity · DeepSeek**。

模型列表**从每个 CLI 自己的本地配置里读**，没有一条是写死的 —— 你看到的就是你账号真能跑的。也可以手动加，加完不会被下次刷新冲掉。**opencode** 本身就是个多厂商网关：接一次，通一片。

### 2. 一个会话里换代理、换模型

代理、模型、权限档是输入框下面的三个选择器，发下一条消息前随时改：

- 某个模型卡住或者跑偏了 → 换一个接着问，它看得到前面的对话。
- 一家的额度用完了 → 换一家，还是这个会话。
- 想事情用贵的，搬砖用便宜的。

有原生续聊的（Claude Code、Codex、Cursor、qoder、opencode、Antigravity）会接着它自己的会话历史走；其余的由 myFlowForge 重建上下文。两种情况下你都只管接着说。

### 3. 多个项目同时开发

一个工作区可以装**多个仓库**。一个阶段可以**按项目扇出**：前端、后端、SDK 同时推进，各由自己的代理在自己的 **git worktree** 里干活，互不踩脚 —— 所有 diff 汇进同一个「变更」面板里审。

扇出也可以只挑一部分：五个仓库全分析、只在其中两个写代码，是很正常的配置。

### 4. 轻量工作流 —— 手动挡

启动工作流**不会**让它一路跑到底，而是进入一种对话模式：

- 顶上有条带子写着*第 N 步 / 共 M 步 · 当前阶段 · 谁在干*。
- 这个阶段的代理**就在你眼前的对话里干活** —— 输出、工具调用、写文件全看得见。
- 不满意？接着说就行。追问和纠正不会重跑这个阶段。
- 满意了？按**下一步**。这时候才会写交接、把下一个代理叫进来。

方案阶段会写出一份**真的 markdown 文档**（`forge-docs/design.md`），按项目分节。这份文档 —— 而不是一段有损的摘要 —— 是跨代理的唯一契约；下游代理读整份，只专注自己那一节。

带门的阶段会停下来等你：**通过**、**打回**（你的批注会置顶，上一轮产物作为基线回灌），或者只是**问一句**而不触发重跑。做到后面才发现方案错了？跳回前面的阶段重做。

### 5. 阶段之间的 hook

hook 是塞在阶段**之间**的小步骤 —— 阶段是代理在做真正的工程，hook 是顺路捎带的杂活。

可以挂在**整个运行之前**、**某个阶段之后**、或者**整个运行之后**：拉最新代码、把方案文档同步到 wiki、跑 lint、更新看板、发个通知。

每个 hook 以**受限微代理**的身份在工作区根目录运行 —— 只有给它的技能和工具，加上任务和上游产出的产物。它用一行汇报结果，碰到只有人能定的事会直接问你。失败会**卡住**流水线，并给出重试 / 跳过 / 中止。hook 存在一个全局库里，跟具体位置无关：写一次，到处挂。

### 6. 你的几台机器，和你的手机

当前连的是哪台主机，是状态栏上的一个**开关**，就在终端按钮旁边。一拨，工作区列表、会话、正在跑的代理、git 改动、内置终端，全都变成**那台机器的**。

- 局域网**直连**，或者走 **SSH**，或者在两台机器互相看不见时走**端到端加密的中转**。中转上跑的只有密文 —— 它读不到任何会话内容，房间号是从 daemon 的公钥推出来的。
- 无头的 Linux 机器上跑 **daemon**：`myflowforge-daemon pair` 会直接在终端里打出一个二维码，扫一下就配对完成。
- **手机端**（iOS + 安卓）是个真客户端，不是只读视图：边流边看对话、答权限门和方案门、翻改动的文件、建工作区、编工作流、切主机。

---

<div align="center">

<img src="assets/screenshots/workflow.jpg" alt="阶段编排 —— 每个阶段自选代理和模型，开发阶段扇出到两个项目" width="90%" />

<sub><b>阶段编排</b> —— 五个阶段各选各的代理和模型，<i>开发</i>阶段扇出到两个仓库。</sub>

</div>

---

## 🤖 支持的编码代理

| 代理 | 对话 | 工作流 | 原生续聊 | MCP | 模型 |
|------|:----:|:------:|:--------:|:---:|------|
| **Claude Code** | ✅ | ✅ | ✅ | ✅ | 从 CLI 读取 |
| **Codex** | ✅ | ✅ | ✅ | ✅ | 从 CLI 读取 |
| **Cursor** | ✅ | ✅ | ✅ | ✅ | 从 CLI 读取 |
| **qoder** | ✅ | ✅ | ✅ | ✅ | 读取 + 自定义 |
| **opencode** | ✅ | ✅ | ✅ | ✅ | 多厂商网关 |
| **Gemini** | ✅ | ✅ | — | ✅ | 预置列表 |
| **Qwen** | ✅ | ✅ | — | ✅ | 预置列表 |
| **Copilot** | ✅ | ✅ | — | ✅ | 预置列表 |
| **Pi** | ✅ | ✅ | — | — | 账号默认 / 自定义 |
| **Kimi** | ✅ | ✅ | — | — | kimi-k2.5 · 256K |
| **Reasonix** | ✅ | ✅ | — | — | deepseek-flash / reasoner |
| **Trae** | ✅ | ✅ | — | — | 账号默认（`/model` 或 `trae_cli.yaml`） |
| **Antigravity** | ✅ | ✅ | ✅ | — | 用 `agy models` 刷新 |
| **DeepSeek** 🆕 | ✅ | ✅ | — | — | 账号默认 |

> **DeepSeek** 即 DeepSeek Harness —— `npm install -g @deepseek-ai/dsh`。它不是靠一个 headless 开关，而是**按 profile 选运行形态**；myFlowForge 接的是 `headless` 那个，三档权限对应它自己的 `read-only` / `workspace-write` / `danger-full-access`。给 key 用 `dsh web`（Models 页）或者 `DEEPSEEK_API_KEY`。
>
> **Trae**（字节的 TraeCode CLI）不在 npm 上 —— 官方 `install.sh` 把 `traecli` 装到 `~/.local/bin`，记得把它加进 PATH。想让它在工作流里无人值守地改文件，跑 `traecli config edit` 设 `permission_mode: bypass_permissions`。

myFlowForge **不保存任何 API key，也不代理任何请求** —— 它驱动的是你机器上已经装好、已经登录的那些 CLI。缺哪个，设置里会标出来并给安装指引；装了但没登录，设置里也会告诉你。

## 🔧 一次运行长什么样

```
      你描述目标
          │
          ▼
  ┌─ hook ─┐        ┌─ hook ─┐                    ┌─ hook ─┐
  │ 运行前 │        │ 方案后 │                    │ 运行后 │
  └───┬────┘        └───┬────┘                    └───┬────┘
      ▼                 ▼                             ▼
 📋 需求 ────→ 🎨 方案 ──→ ✋ 门 ──→ 💻 开发 ──→ 🧪 测试 ──→ 🔍 评审
  (澄清)      (design.md)  你来定   (扇出)      (验证)     (多镜头)
                    │                  │
                    │                  └─ 每个项目一个代理，
                    │                     并行泳道，各自的 worktree
                    └─ 一份真文档，每个下游代理都读整份

 每一个箭头都等你按「下一步」。阶段可以增删、重排、跳过 ——
 只跑「需求 → 开发」也完全成立。
```

三种启动方式，最后都落到同一个门上：

1. 在工作流面板按**开始**。
2. 在输入框打 `/` 挑一个。
3. 用大白话描述一整个开发任务 —— 主代理会认出来，通过 MCP 升起一个方案门。提问、讨论、一行的小修不会误触发。

## 📱 远程主机与手机端

一个 app，好几台机器。在状态栏挑主机，其余全都跟着走。

| | |
|---|---|
| **直连** | 同一个局域网，直接连 daemon 的端口，带令牌鉴权。 |
| **SSH** | 复用你本来就有的 SSH 登录 —— 不用新开任何口子。 |
| **中转** | 给互相看不见的两台机器用。**端到端加密**：每次会话新密钥，中转只转发密文，解不开的帧一律丢弃而不是将就。可以自建（`relay/`，Node 或 Cloudflare Worker），部署步骤在 `relay/README.md` 里。 |

**Linux daemon** 就是同一份代码去掉窗口 —— 装上 tar.gz，用 systemd 跑起来，扫它在终端里打出的二维码就配对好了（`docs/linux-deploy.md`）。

**手机端**覆盖了离开电脑时真正需要的那些：边流边看的对话，带思考过程、工具卡和子代理卡；能答的权限门和方案门；改动的文件和 diff；建工作区；工作流模板库；切主机和扫码配对。markdown、表格和本地图片都原生渲染 —— **远程图片地址故意保持为链接**，这样代理的输出永远没法把你的手机变成一个追踪信标。

## 🧩 还有这些

- **原生会话导入** —— 只读扫描你本地的 Claude / Codex / Cursor / qoder 历史，导入成工作区接着聊。
- **MCP 桥** —— 内置的 Forge MCP 服务器让代理能回调这个 app：`forge_ask`、`forge_propose_plan`、`forge_write_artifact`、`forge_handoff`、`forge_delegate`、`forge_read_context`、`forge_heartbeat`。注入给支持 MCP 的那几个，其余回落到文本指令。
- **MCP 服务器与加载项** —— 看每个 CLI 配了哪些 MCP 服务器，在 app 里授权或取消授权；技能市场可以把技能装进读它们的那些 CLI。
- **记忆** —— 按工作区存的笔记，代理能读回去，长线的活儿有自己的线索。
- **实时可观测** —— 流式的思考 / 工具调用 / 文件改动 / 原始输出，可过滤的日志台，运行历史，跨项目的改动证据。
- **额度与用量** —— 每家的剩余额度和重置时间，外加按「工作区 × 代理 × 天」的消耗。
- **机器人桥** —— 在**钉钉**、**Telegram** 或**飞书**里答门、看结果、发起对话、驱动工作流。
- **权限档** —— 只读审阅 · 自动（工作区，默认）· 完全访问，按会话或按阶段设。映射到每个 CLI 真实的沙箱范围，界面会直说哪些代理真的认这个档。
- **斜杠命令、技能与插件** —— `/` 列出你磁盘上真实的命令和已装技能，按代理过滤。
- **自定义工作流** —— 流程由你拼：存任意多个命名工作流，各有各的阶段集；每个阶段自选代理、模型、权限档、扇出形态、要不要门、要不要产出文档。
- **自定义阶段** —— 你自己的阶段全局库，任何工作流都能引用。
- **文件浏览与 diff** —— 全屏文件树带改动标记，语法高亮预览，diff / 全文切换。
- **内置终端** —— 真 pty，根在工作区，可按 provider 配代理和时区。连着远程主机时，它开的是**那台机器上**的 shell。
- **桌面宠物** —— 跟着你当前那块屏走，预览代理动态，弹确认卡；可以逛宠物市场，也可以用自己的图。
- **成长宠物** —— 桌面宠物随着你干活分阶段成长，长会话之后留下点看得见的东西。
- **透明与磨砂** —— 一个模糊滑块把整窗从完全不透明一路带到三种 macOS 原生材质，桌面能透上来。
- **个性化** —— 6 套原创皮肤、12 种强调色、300+ 张壁纸的图库（也可以用自己的图）、app 和对话区各自独立的像素级字号、深浅两个主题分别调过对比度。
- **壁纸自动配色** —— 打开之后整套配色从你选的那张壁纸推出来，明暗由图片自己决定。壁纸只提供两个色相，每一级明度和彩度都抄自手调好的皮肤 —— 所以再花的图也生不出一个读不了的界面。想自己定强调色？定了之后只有强调色不再跟随。
- **对话里的图片与内嵌可视化** —— 代理在磁盘上生成的图会直接显示在回复里，点开看原尺寸。回答中间写的 HTML 片段可以渲染成真的卡片、表格和图示（默认关）。**绝不用 `innerHTML`** —— 片段是解析之后按构造性白名单重建的，颜色只能来自主题令牌，所以渲染出来的东西是跟着你的皮肤走而不是跟它打架。

## 📥 下载与安装

到 [**Releases**](https://github.com/flowForges/myFlowForge/releases) 页拿最新的包：

| 平台 | 文件 |
|------|------|
| macOS · Apple 芯片（M1–M4） | `myFlowForge-<版本>-arm64.dmg` |
| macOS · Intel | `myFlowForge-<版本>.dmg` |
| Windows · x64 | `myFlowForge-<版本>-x64-setup.exe` |
| 安卓 | `myFlowForge-<版本>.apk` |
| Linux · 无头 daemon | `myFlowForge-daemon-<版本>-linux.tar.gz` |

> **这个 app 没有代码签名。** macOS 上第一次打开可能说「无法打开」或者「已损坏」—— 那就是未签名 app 的样子，文件本身没问题。要么**右键** → **打开** → **打开**，要么跑一次：
> `xattr -dr com.apple.quarantine /Applications/myFlowForge.app`
> Windows 上 SmartScreen 会拦一下，选**更多信息 → 仍要运行**。
>
> myFlowForge 会查同一个 Releases 源，有新版会在 app 里提示。

**iOS** 没有可下载的包 —— 从 `mobile/` 用你自己的 Apple ID 编译，插线装到设备上。

## 🚀 上手

**前置：** macOS 11+ / Windows 10+ / 一个现代 Linux，Node.js ≥ 20，git，以及至少一个装好并登录了的编码 CLI。

```bash
git clone https://github.com/flowForges/myFlowForge.git
cd myFlowForge
npm install
npm run dev          # 开发模式，渲染层热更新
```

| 命令 | 做什么 |
|------|--------|
| `npm run dev` | 带热更新启动 |
| `npm test` | 跑完整测试套件（Vitest） |
| `npm run typecheck` | 主进程和渲染层两个 tsconfig 都查 |
| `npm run build` | 打生产包 |
| `npm run dist:mac-all` | 同时打 Intel 和 Apple 芯片两个 `.dmg` |
| `npm run dist:win` | 打 Windows x64 安装器 |
| `npm run check:daemon` | 端到端跑一遍无头 daemon |

手机端在 `mobile/`（Expo / React Native），中转在 `relay/`，各自有自己的 `package.json`。

产物落在 `release/`。改了 `src/main/**` 需要**完全重启 Electron** —— 热更新只刷渲染层。

## 🏗️ 技术栈

**外壳：** [Electron](https://www.electronjs.org/) 42 + [electron-vite](https://electron-vite.org/) · **界面：** [React](https://react.dev/) 19 + TypeScript 6 · **手机：** [Expo](https://expo.dev/) + [React Native](https://reactnative.dev/) · **终端：** [xterm.js](https://xtermjs.org/) + [node-pty](https://github.com/microsoft/node-pty) · **代理桥：** [Model Context Protocol SDK](https://modelcontextprotocol.io/) · **进程控制：** [execa](https://github.com/sindresorhus/execa) · **校验：** [zod](https://zod.dev/) · **文件监听：** [chokidar](https://github.com/paulmillr/chokidar) · **测试：** [Vitest](https://vitest.dev/) + Testing Library · **打包：** [electron-builder](https://www.electron.build/)

## 📁 项目结构

```
src/
├── main/              # Electron 主进程
│   ├── agents/        # CLI 适配器 + provider 注册表、探测、权限
│   ├── run/           # 工作流引擎：阶段、门、扇出、hook、交接
│   ├── chat/          # 按工作区的对话、队列、记忆
│   ├── mcp/           # Forge MCP 服务器（代理 → app 的桥）
│   ├── remote/        # 远程主机：直连 / SSH / 中转、路由、端到端信道
│   ├── daemon/        # 无头 daemon + 终端二维码配对
│   ├── bot/           # 机器人桥（钉钉 / Telegram / 飞书）
│   ├── plugins/       # 插件宿主、目录、调度、扩展点
│   ├── sessionImport/ # 原生会话扫描与导入
│   ├── usage/         # 各家额度适配器
│   ├── pet/           # 桌面宠物窗口
│   └── ...            # git、fs、终端、更新、监听、窗口、外观
├── renderer/          # React 界面（视图、组件、设置、主题、宠物）
├── preload/           # 上下文隔离的 IPC 桥
└── shared/            # 跨进程共享的类型与纯逻辑
mobile/                # iOS 与安卓客户端（Expo / React Native）
relay/                 # 端到端加密中转（Node 或 Cloudflare Worker）
```

## 🤝 参与

欢迎 issue 和 PR。这个项目是**测试驱动**的 —— 改动请连测试一起加或改，开 PR 前确认 `npm test` 和 `npm run typecheck` 都过。

## 📄 许可

[MIT License](LICENSE) © 2026 zghua。

## 🙏 致谢

建立在 Electron、React、Vite 和 Model Context Protocol 周边的开源生态之上 —— 以及它所编排的那些编码代理之上。

## 🔗 链接

- [LINUX DO](https://linux.do/latest) —— 一个爱折腾的开发者社区
