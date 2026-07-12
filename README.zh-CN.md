<div align="center">

<img src="build/icon.png" alt="myFlowForge" width="128" height="128" />

# myFlowForge

**锻造你的 AI 编码工作流。**

一个桌面「驾驶舱」，把 **Claude Code、Codex、Cursor、Gemini、qoder 和 opencode** 编排成一条受控的多阶段编码流水线——带方案审批门控、原生会话导入、实时额度监控、MCP 集成，还有一只陪你写代码的桌面宠物。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-macOS-000000?logo=apple&logoColor=white)

[English](README.md) · **简体中文** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

</div>

---

## 这是什么？

如今的 AI 编码工具各自为政：各有各的终端、各有各的会话状态、各有各的额度，彼此之间没有共享的计划。**myFlowForge** 把它们收拢到同一个屋檐下，把「和 AI 聊天」变成一套**可复用、可评审的工程化工作流**。

你只需描述想要什么，Forge 就会驱动你选定的代理走完一条分阶段的流水线——**需求 → 设计 → 开发 → 测试 → 评审**——并在**硬门控**处暂停，让你在写下第一行代码*之前*先确认技术方案。每个阶段都可以用不同的代理和模型，可跨多个项目并行运行；与此同时，一只友好的桌面宠物让你一眼看清当前进展。

> ⚠️ **项目状态：** myFlowForge 是一个持续开发中的个人项目，目前面向 **macOS**（Apple Silicon 与 Intel）。由于基于 Electron，可从源码构建到其它平台，但目前仅打包 macOS 版本。

## ✨ 亮点

- **🎛️ 多代理编排** —— 把工作流的每个阶段分派给不同的编码 CLI（Claude Code、Codex、Cursor、Gemini、qoder、opencode）和不同的模型。其中 **opencode** 本身就是多 provider 网关——接入它一次即可用上很多家的模型。
- **📂 用外部软件打开** —— 标题栏「打开位置」按钮识别本机已装的编辑器（VS Code、Cursor、JetBrains、Zed、Finder、终端……），用你选的软件打开当前工作区——或你正在预览的文件——并记住默认选择。
- **⌨️ 会话斜杠命令** —— 在对话里输入 `/` 弹出命令菜单：工作流触发 + 你**本机真实的自定义命令/prompt 和已装 skill**，按当前代理过滤。
- **🔄 受控的多阶段流水线** —— 需求 → 设计 → 开发 → 测试 → 评审，并带**方案审批硬门控**：执行开始前，先审查并批准（或打回）技术设计。
- **✂️ 按需裁剪、省 token 的执行** —— 配置了工作流，也不必每个任务都跑完整阶段、改动所有项目。用自然语言描述一个小需求，编排代理会提出**精简方案**：只跑需要的阶段（如跳过测试/评审），并给每个阶段指定项目子集（如分析全部 5 个项目、只在其中 2 个里写代码）。审批卡片会在你确认前清楚展示实际将执行的范围。
- **🧭 只编排，不执行** —— 主对话代理从不自己写代码、也不用它自带的内置子代理干活；它只负责拆解任务，把每一步实际动手的工作委派给 Forge 编排的真·子代理。
- **🧩 多项目并行工作区** —— 多个工作区并发运行，各自使用隔离的 git worktree；在并行泳道里同时观察多个代理干活。
- **📥 原生会话导入** —— 只读扫描并导入你本机已有的 Claude / Codex / Cursor / qoder 会话到中央索引，再作为工作区续聊。
- **📊 实时额度监控** —— 真实用量适配器展示各家的剩余额度与重置时间。
- **🔌 MCP 集成** —— 内置 Forge MCP 服务把代理接回应用（提问、提方案、交付产物），实现可靠的工具驱动控制。
- **🖥️ 实时可观测** —— 流式的思考 / 执行 / 文件改动 / 输出日志，可筛选的日志台，以及跨项目的变更证据。
- **🐾 桌面宠物** —— 可拖拽、可缩放的伙伴，跟随你的焦点屏、预览代理活动、弹出确认卡片——特效可配置，还有多套宠物皮肤。
- **🎨 精致且可个性化的 UI** —— 毛玻璃、**6 种主题**（明/暗/跟随系统 + 午夜蓝/暖褐/森林绿）、**12 种强调色**、**自定义背景图**（整个应用或仅会话区，可调不透明度）、重新设计的首页仪表盘（含本地时区实时问候），可拖宽面板，以及通知中心。

## 🤖 支持的编码代理

| 代理 | 对话 | 工作流执行 | 原生续聊 | 模型 | MCP |
|------|:----:|:----------:|:--------:|:----:|:---:|
| **Claude Code** | ✅ | ✅ | ✅ | 动态发现 | ✅ |
| **Codex** | ✅ | ✅ | ✅ | 动态发现 | ✅ |
| **Cursor** | ✅ | ✅ | ✅ | 动态发现 | — |
| **Gemini** | ✅ | ✅ | — | 动态发现 | — |
| **qoder** | ✅ | ✅ | ✅ | 动态发现 | ✅ |
| **opencode** | ✅ | ✅ | ✅ | 动态发现（多家） | — |

> 模型均从各 CLI 的**真实本地配置**中动态读取——不硬编码，且每家的模型列表都可编辑。

## 🔧 工作原理

```
      你描述目标
          │
          ▼
   📋 需求  ──►  🎨 设计  ──►  ✋ 方案门控  ──►  💻 开发  ──►  🧪 测试  ──►  🔍 评审
   (澄清)      (技术方案)     批准 / 打回        (写码)       (验证)      (审计)
          │                        │
          │                        └─ 在写下任何代码*之前*，由你确认方案正确
          ▼
   每个阶段 → 你选定的代理 + 模型、隔离的 git worktree、实时流式日志
```

三种触发方式，最终都汇聚到同一个门控：

1. 主对话代理识别意图，调用 **`forge_propose_plan`** MCP 工具。
2. 技能驱动的围栏指令作为兜底。
3. 显式的**「发起工作流」**按钮。

## 📥 下载安装

从 [**Releases**](https://github.com/flowForges/myFlowForge/releases) 页面下载最新的 `.dmg`：

| 你的 Mac | 推荐下载 |
|----------|----------|
| Apple Silicon（M1/M2/M3/M4） | `myFlowForge-<版本>-arm64.dmg` 或通用版 |
| Intel | `myFlowForge-<版本>.dmg`（x64）或通用版 |
| 不确定 | `myFlowForge-<版本>-universal.dmg`——两种芯片通吃 |

> **⚠️ 应用暂未做代码签名。** 首次打开时 macOS 可能提示*「无法打开」*或*「已损坏」*，这对未签名应用是正常现象。打开方式：
> - 在 `/Applications` 里**右键**该应用 → **打开** → 弹窗里再点**打开**，或
> - 在终端执行一次：`xattr -dr com.apple.quarantine /Applications/myFlowForge.app`
>
> myFlowForge 会检查此 Releases 源的更新，并在应用内提示下载新版本。

## 🚀 快速上手

### 前置条件

- **macOS**（Apple Silicon 或 Intel）
- **Node.js** ≥ 20 与 **npm**
- 至少安装并登录一个受支持的编码 CLI（Claude Code、Codex、Cursor、Gemini、qoder）。Forge 会检测你已装的，并引导你安装其余的。

### 开发环境安装与运行

```bash
# 1. 克隆
git clone https://github.com/flowForges/myFlowForge.git
cd myFlowForge

# 2. 安装依赖
npm install

# 3. 开发模式启动（热更新）
npm run dev
```

### 常用脚本

| 命令 | 作用 |
|------|------|
| `npm run dev` | 热更新启动应用 |
| `npm test` | 运行完整测试（Vitest） |
| `npm run typecheck` | 类型检查主进程 + 渲染进程双 tsconfig |
| `npm run build` | 构建生产包 |
| `npm run dist` | 构建 macOS 安装包（`.dmg`） |

### 构建安装包

```bash
npm run dist            # macOS x64
npm run dist:arm64      # Apple Silicon
npm run dist:universal  # 通用二进制
```

产物输出到 `release/` 目录。

## 🏗️ 技术栈

- **外壳：** [Electron](https://www.electronjs.org/) 42 + [electron‑vite](https://electron-vite.org/)
- **UI：** [React](https://react.dev/) 19 + TypeScript 6
- **终端：** [xterm.js](https://xtermjs.org/) + [node‑pty](https://github.com/microsoft/node-pty)
- **代理桥接：** [Model Context Protocol SDK](https://modelcontextprotocol.io/)
- **进程控制：** [execa](https://github.com/sindresorhus/execa) · **校验：** [zod](https://zod.dev/) · **文件监听：** [chokidar](https://github.com/paulmillr/chokidar)
- **测试：** [Vitest](https://vitest.dev/) + Testing Library（全程测试驱动开发）
- **打包：** [electron‑builder](https://www.electron.build/)

## 📁 项目结构

```
src/
├── main/          # Electron 主进程
│   ├── agents/    # CLI 适配器（claude、codex、cursor、gemini、qoder、opencode）+ providers
│   ├── orchestrator/  # 工作流引擎与阶段门控
│   ├── chat/      # 各工作区对话、队列、记忆
│   ├── mcp/       # Forge MCP 服务（代理 → 应用 的桥）
│   ├── pet/       # 桌面宠物窗口
│   ├── sessionImport/  # 原生会话扫描与导入
│   ├── usage/     # 各家额度适配器
│   └── ...        # git、fs、terminal、update、watcher、windows
├── renderer/      # React UI（views、components、pet、settings、theme）
├── preload/       # 上下文隔离的 IPC 桥
└── shared/        # 跨进程共享类型
```

## 🤝 参与贡献

欢迎提交贡献、Issue 与功能建议！本项目采用**测试驱动**流程——请随改动补充或更新测试，并确保 `npm test` 与 `npm run typecheck` 通过后再提 PR。

## 📄 许可协议

基于 [MIT 许可协议](LICENSE) 发布 © 2026 zghua。

## 🙏 致谢

构建于 Electron、React、Vite 与 Model Context Protocol 等优秀开源生态之上——以及它所编排的编码代理：Claude Code、Codex、Cursor、Gemini 和 qoder。
