<div align="center">

<img src="build/icon.png" alt="myFlowForge" width="128" height="128" />

# myFlowForge

**一个 GUI，接入原生 Claude Code、Codex、Cursor 等 agent：一处管理，多端互联。**

myFlowForge 直接调用本机已安装的官方 CLI（Claude Code、Codex、Cursor、Gemini、qoder、opencode、DeepSeek 等），不修改、不替换 agent 本身，只在其上提供一套统一的 GUI。支持同一会话内切换 agent 与模型、导入原生会话、阶段式工作流执行、兼容 Codex 原生宠物，并可从另一台电脑、服务器或手机远程接入。

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

<img src="assets/screenshots/home.jpg" alt="首页：工作区、运行中的 agent 与当日改动" width="90%" />

<sub><b>首页</b>：工作区、运行中的 agent 与当日改动。壁纸、皮肤与强调色均可自定义。</sub>

</div>

---

## 项目简介

各家 AI 编码 CLI 分别运行在独立的终端中，会话、额度与配置互不相通，一项任务往往被绑定在某一个工具上。

myFlowForge 定位为这些 CLI 之上的 GUI 层，遵循三条原则：

- **原生接入**：通过官方 CLI 调用 agent，使用你自己的账号、订阅与本地配置。不 fork、不修改 agent，不保存 API key，也不代理任何请求。agent 升级后，新能力可直接使用。
- **统一管理**：多个 agent、多个项目、多个会话在同一界面中管理，任务不再与单一工具绑定。
- **多端互联**：桌面端、无头 Linux daemon 与 iOS / Android 客户端共用同一套工作区与会话，支持局域网直连、SSH 与端到端加密中转。

> **项目状态：** 个人维护，持续开发中。提供 macOS、Windows、Linux 安装包，以及安卓 APK 与 iOS TestFlight。macOS 包已通过 Developer ID 签名与苹果公证，安卓包使用正式密钥签名，Windows 包暂未签名。

## 核心功能

### 1. 原生 agent 接入

支持 14 个编码 CLI：**Claude Code · Codex · Cursor · Gemini · qoder · opencode · Qwen · Copilot · Pi · Kimi · Reasonix · Trae · Antigravity · DeepSeek**。

myFlowForge 驱动的是本机已安装、已登录的官方 CLI，不改动其行为。模型列表优先从各 CLI 的本地配置中读取，无法读取的使用预置列表；也可手动添加，手动添加的模型不会被刷新覆盖。未安装或未登录的 CLI 会在设置中标出，并给出安装指引。

### 2. 同一会话内切换 agent 与模型

agent、模型与权限档在每一轮对话前均可重新选择，上下文保持连续：

- 某个模型效果不佳时，可换用其他模型继续，新模型能看到此前的全部对话；
- 某一家额度耗尽时，可切换到另一家，无需新开会话；
- 可按任务性质分配模型，例如方案设计使用能力更强的模型，实现与收尾使用成本更低的模型。

支持原生续聊的 agent（Claude Code、Codex、Cursor、qoder、opencode、Antigravity）沿用其自身的会话历史；其余 agent 由 myFlowForge 重建上下文。

### 3. 多端互联

- **远程主机**：桌面端可连接另一台电脑或服务器，驱动该机器上的 agent、仓库与终端。当前主机在状态栏中切换，工作区、会话、git 改动与内置终端随之切换。
- **三种连接方式**：局域网直连、SSH、端到端加密中转。中转只转发密文，无法读取会话内容，可自行部署（Node 或 Cloudflare Worker）。
- **无头 daemon**：Linux 服务器上运行 `myflowforge-daemon`，`pair` 命令在终端中输出配对二维码。
- **移动端**：iOS 与安卓客户端支持实时查看对话、处理权限确认与方案审批、查看改动与 diff、新建工作区、编辑工作流、切换主机。
- **设备授权**：每台设备使用独立的配对码，可随时单独移除，撤销即时生效。

### 4. 原生会话导入

只读扫描本地的 Claude Code、Codex、Cursor、qoder 会话历史，导入为工作区后可直接继续对话，不影响原有数据。

### 5. 阶段式工作流

除普通对话外，任务也可以按阶段执行。启动工作流后，对话进入阶段模式：

- 顶部显示当前进度（第 N 步 / 共 M 步）、当前阶段与负责的 agent；
- 阶段内的 agent 在当前对话中工作，输出、工具调用与文件改动全程可见；
- 每个阶段完成后需确认「下一步」才会交接给下一阶段，追问与纠正不会触发重跑；
- 方案阶段产出一份完整的 markdown 文档（`forge-docs/design.md`），作为下游 agent 共同遵循的契约；
- 设有审批的阶段支持**通过**、**打回**（附批注重做）或**提问**，也可以回退到之前的阶段。

每个阶段可单独指定 agent、模型与权限档。工作流、阶段均可自定义并保存复用。

### 6. 多项目并行

一个工作区可包含多个仓库。阶段可以**按项目扇出**：前端、后端、SDK 由各自的 agent 在独立的 git worktree 中并行开发，所有改动汇总到同一个变更面板中审阅。扇出范围可以只选其中一部分仓库。

### 7. 阶段 Hook

Hook 是插入在阶段之间的辅助步骤，可挂在**运行前**、**某阶段之后**或**运行后**，用于拉取代码、同步文档、执行 lint、更新看板、发送通知等。

每个 Hook 以受限的子 agent 在工作区根目录运行，只能使用分配给它的技能与工具。执行失败时流水线暂停，可选择重试、跳过或中止。Hook 保存在全局库中，可在任意工作流中复用。

### 8. 桌面宠物

桌面宠物跟随当前屏幕，实时反映 agent 的运行状态，并可直接弹出确认卡片。**兼容 Codex 原生宠物**，可从 codex-pets.net 宠物市场安装，也支持使用自定义图片。另有随使用时长逐步成长的成长宠物。

---

<div align="center">

<img src="assets/screenshots/workflow.jpg" alt="阶段编排：每个阶段单独选择 agent 与模型，开发阶段扇出到两个项目" width="90%" />

<sub><b>阶段编排</b>：五个阶段分别指定 agent 与模型，<i>开发</i>阶段扇出到两个仓库。</sub>

</div>

---

## 支持的 agent

| Agent | 对话 | 工作流 | 原生续聊 | MCP | 模型 |
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
| **Antigravity** | ✅ | ✅ | ✅ | — | 通过 `agy models` 刷新 |
| **DeepSeek** | ✅ | ✅ | — | — | 账号默认 |

> **DeepSeek** 指 DeepSeek Harness（`npm install -g @deepseek-ai/dsh`）。myFlowForge 使用其 `headless` profile，三档权限分别对应 `read-only` / `workspace-write` / `danger-full-access`。API key 可通过 `dsh web`（Models 页）或环境变量 `DEEPSEEK_API_KEY` 配置。
>
> **Trae**（字节跳动 TraeCode CLI）不在 npm 上发布，需通过官方 `install.sh` 安装到 `~/.local/bin` 并加入 PATH。若需在工作流中无人值守地修改文件，请运行 `traecli config edit` 设置 `permission_mode: bypass_permissions`。

## 工作流执行流程

```
    描述目标
       │
       ▼
  ┌─ hook ─┐   ┌─ hook ─┐                                          ┌─ hook ─┐
  │ 运行前 │   │ 方案后 │                                          │ 运行后 │
  └────┬───┘   └────┬───┘                                          └────┬───┘
       ▼            ▼                                                   ▼
      需求 ──────→ 方案 ──────→ 审批 ──────→ 开发 ──────→ 测试 ──────→ 评审
    (澄清)     (design.md)    (人工)       (扇出)       (验证)      (多视角)
                    │                         │
                    │                         └─ 每个项目一个 agent，
                    │                            并行执行，独立 worktree
                    └─ 完整文档，所有下游 agent 读取全文

 每个阶段之间都需确认「下一步」。阶段可增删、重排或跳过，
 例如只执行「需求 → 开发」。
```

工作流有三种启动方式：

1. 在工作流面板中点击**开始**；
2. 在输入框中输入 `/` 选择工作流；
3. 直接用自然语言描述开发任务，主 agent 识别后通过 MCP 发起方案审批。一般提问、讨论与小改动不会触发。

## 远程主机与移动端

| 方式 | 说明 |
|---|---|
| **直连** | 同一局域网内直接连接 daemon 端口，令牌鉴权。 |
| **SSH** | 复用已有的 SSH 登录，无需额外开放端口。 |
| **中转** | 用于两台机器无法直接互通的场景。**端到端加密**：每次会话协商新密钥，中转只转发密文，无法解密的帧一律丢弃。可自行部署（`relay/`，支持 Node 与 Cloudflare Worker），步骤见 `relay/README.md`。 |

**Linux daemon** 与桌面端为同一套代码，去掉了窗口部分。安装 tar.gz 后以 systemd 运行，扫描终端中输出的二维码即可完成配对（见 `docs/linux-deploy.md`）。

**移动端**覆盖离开电脑时的常用操作：实时对话（含思考过程、工具调用与子 agent 卡片）、权限确认与方案审批、改动文件与 diff、新建工作区、工作流模板、切换主机与扫码配对。markdown、表格与本地图片原生渲染；出于隐私考虑，远程图片地址保留为链接，不自动加载。

## 更多功能

- **MCP 桥**：内置 Forge MCP 服务器，供 agent 回调应用：`forge_ask`、`forge_propose_plan`、`forge_write_artifact`、`forge_handoff`、`forge_delegate`、`forge_read_context`、`forge_heartbeat`。对支持 MCP 的 agent 自动注入，其余回退为文本指令。
- **MCP 服务器与技能市场**：查看各 CLI 已配置的 MCP 服务器并在应用内授权；从技能市场为对应 CLI 安装技能。
- **记忆**：按工作区保存笔记，agent 可读取，便于长期任务延续上下文。
- **运行观测**：流式展示思考、工具调用、文件改动与原始输出，提供可筛选的日志、运行历史与跨项目改动记录。
- **额度与用量**：各家剩余额度与重置时间，以及按工作区、agent、日期统计的用量。
- **机器人桥**：在钉钉、Telegram 或飞书中处理审批、查看结果、发起对话与驱动工作流。
- **权限档**：只读审阅、自动（工作区，默认）、完全访问，可按会话或按阶段设置，并映射到各 CLI 实际的沙箱范围。
- **斜杠命令与技能**：输入 `/` 列出本机实际存在的命令与已安装技能，按 agent 过滤。
- **文件浏览与 diff**：全屏文件树与改动标记，语法高亮预览，diff 与全文切换。
- **内置终端**：真实 pty，以工作区为根目录，可按 provider 配置代理与时区；连接远程主机时，终端运行在远程机器上。
- **外观**：6 套原创皮肤、12 种强调色、300 余张壁纸，支持自定义图片；应用与对话区字号独立设置；可根据壁纸自动生成配色；支持 macOS 原生磨砂材质。
- **对话内图片与可视化**：agent 生成的本地图片直接显示在回复中；回复中的 HTML 片段可渲染为卡片、表格与图示（默认关闭，经白名单重建，不使用 `innerHTML`）。

## 下载与安装

请从 [**Releases**](https://github.com/flowForges/myFlowForge/releases) 页面下载最新版本：

| 平台 | 文件 |
|------|------|
| macOS · Apple 芯片（M1–M4） | `myFlowForge-<版本>-arm64.dmg` |
| macOS · Intel | `myFlowForge-<版本>.dmg` |
| Windows · x64 | `myFlowForge-<版本>-x64-setup.exe` |
| Windows · ARM | `myFlowForge-<版本>-arm64-setup.exe` |
| 安卓 | `myFlowForge-<版本>.apk` |
| Linux · 无头 daemon | `myFlowForge-daemon-<版本>-linux.tar.gz` |
| iOS | TestFlight（邀请制） |

> **macOS** 安装包已签名并公证，可直接安装。
> **Windows** 安装包暂未签名，SmartScreen 提示时请选择「更多信息 → 仍要运行」。
>
> 应用内置更新检查，新版本发布后会在应用内提示。

**iOS** 目前通过 TestFlight 分发（邀请制），也可以在 `mobile/` 目录下使用自己的 Apple ID 编译安装。

## 快速开始

**环境要求：** macOS 11+ / Windows 10+ / 主流 Linux 发行版，Node.js ≥ 20，git，以及至少一个已安装并登录的编码 CLI。

```bash
git clone https://github.com/flowForges/myFlowForge.git
cd myFlowForge
npm install
npm run dev          # 开发模式，渲染层热更新
```

| 命令 | 说明 |
|------|------|
| `npm run dev` | 以开发模式启动（热更新） |
| `npm test` | 运行完整测试套件（Vitest） |
| `npm run typecheck` | 检查主进程与渲染层两套 tsconfig |
| `npm run build` | 生产构建 |
| `npm run dist:mac-all` | 同时打包 Intel 与 Apple 芯片 `.dmg` |
| `npm run dist:win` | 打包 Windows x64 安装程序 |
| `npm run check:daemon` | 端到端验证无头 daemon |

移动端位于 `mobile/`（Expo / React Native），中转服务位于 `relay/`，各自有独立的 `package.json`。

构建产物输出到 `release/`。修改 `src/main/**` 后需要完全重启 Electron，热更新只作用于渲染层。

## 技术栈

| 类别 | 技术 |
|------|------|
| 桌面外壳 | [Electron](https://www.electronjs.org/) 42 · [electron-vite](https://electron-vite.org/) |
| 界面 | [React](https://react.dev/) 19 · TypeScript 6 |
| 移动端 | [Expo](https://expo.dev/) · [React Native](https://reactnative.dev/) |
| 终端 | [xterm.js](https://xtermjs.org/) · [node-pty](https://github.com/microsoft/node-pty) |
| Agent 桥接 | [Model Context Protocol SDK](https://modelcontextprotocol.io/) |
| 进程控制 | [execa](https://github.com/sindresorhus/execa) |
| 数据校验 | [zod](https://zod.dev/) |
| 文件监听 | [chokidar](https://github.com/paulmillr/chokidar) |
| 测试 | [Vitest](https://vitest.dev/) · Testing Library |
| 打包 | [electron-builder](https://www.electron.build/) |

## 项目结构

```
src/
├── main/              # Electron 主进程
│   ├── agents/        # CLI 适配器、provider 注册表、探测与权限
│   ├── run/           # 工作流引擎：阶段、审批、扇出、hook、交接
│   ├── chat/          # 工作区对话、队列与记忆
│   ├── mcp/           # Forge MCP 服务器（agent → 应用的桥接）
│   ├── remote/        # 远程主机：直连 / SSH / 中转、路由、端到端加密信道
│   ├── daemon/        # 无头 daemon 与终端二维码配对
│   ├── bot/           # 机器人桥（钉钉 / Telegram / 飞书）
│   ├── plugins/       # 插件宿主、目录、调度与扩展点
│   ├── sessionImport/ # 原生会话扫描与导入
│   ├── usage/         # 各家额度适配
│   ├── pet/           # 桌面宠物窗口
│   └── ...            # git、文件系统、终端、更新、监听、窗口、外观
├── renderer/          # React 界面（视图、组件、设置、主题、宠物）
├── preload/           # 上下文隔离的 IPC 桥
└── shared/            # 跨进程共享的类型与纯逻辑
mobile/                # iOS 与安卓客户端（Expo / React Native）
relay/                 # 端到端加密中转（Node 或 Cloudflare Worker）
```

## 参与贡献

欢迎提交 issue 与 PR。项目采用测试驱动开发，提交改动时请同时添加或更新相应测试，并确保 `npm test` 与 `npm run typecheck` 通过。

## 许可证

[MIT License](LICENSE) © 2026 zghua

## 致谢

感谢 Electron、React、Vite 与 Model Context Protocol 等开源项目，以及本项目所接入的各家编码 agent。

## 相关链接

- [LINUX DO](https://linux.do/latest)：开发者社区
- [V2EX](https://www.v2ex.com/)：创意工作者社区
