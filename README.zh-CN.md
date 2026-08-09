<div align="center">

<img src="build/icon.png" alt="myFlowForge" width="128" height="128" />

# myFlowForge

**多 AI 编码代理的 macOS 驾驶舱。**

一个 macOS 桌面驾驶舱，把 **Claude Code、Codex、Cursor、Gemini、qoder、opencode、Trae** 等 12 个编码 CLI 收进同一个界面 —— 让你**在同一个会话里随时换代理和模型**、**跨多个项目同时开发**、用**轻量工作流（手动挡）**把每一步握在手里，还能在阶段之间挂上自己的 **Hook**。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-macOS-000000?logo=apple&logoColor=white)

[English](README.md) · **简体中文** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

</div>

---

<div align="center">

<img src="assets/screenshots/home.jpg" alt="首页 —— 工作区、进行中的代理、今日改动一眼看完" width="90%" />

<sub><b>首页</b> —— 接着上次的活干。壁纸、皮肤、强调色都能换。</sub>

</div>

---

## 这是什么

每个 AI 编码 CLI 都活在自己的终端里：自己的会话状态、自己的额度，彼此不知道对方存在。选定一个，这个任务就只能陪它走到底。

**myFlowForge 把它们放进同一个屋檐下。** 代理和模型是**每一句**的属性，不是整个会话的属性 —— 所以你可以用 Claude Opus 把方案想清楚，把实现交给 Codex，收尾杂活再换个便宜模型，全程在同一条会话里，上下文不断。

在这之上是一层**轻量工作流**：它不是一条会跑飞的流水线，而是给同一段对话加的一层薄结构 —— **每个阶段都要你按「下一步」才走**。

> ⚠️ **项目状态：** 一个持续开发中的个人项目，目标平台是 **macOS**（Apple Silicon 与 Intel）。基于 Electron，其他平台可从源码构建，但目前只打 macOS 包。**1.1.0** 是当前稳定版;两个稳定版之间的 beta 是新功能先落地的地方。

## ✨ 真正想做好的五件事

### 1. 是一套代理的集合，不是选一个偏爱的

12 个编码 CLI 在同一个界面里共存：**Claude Code · Codex · Cursor · Gemini · qoder · opencode · Qwen · Copilot · Pi · Kimi · Reasonix · Trae**。

模型列表**从各 CLI 自己的本地真实配置里读**，没有一行硬编码 —— 界面上有什么，就是你账号真能跑什么。也可以手动补充条目，不会被下次刷新覆盖掉。**opencode** 本身就是多厂商网关，接一次等于接一片。

### 2. 同一个会话里，随时换代理和模型

输入框下面永远摆着三个选择器：代理、模型、权限档位。发下一句之前随时能换：

- 某个模型卡住了、答歪了 → 换一个接着问，它看得到前面的对话，不用重述背景。
- 某家额度用完了 → 换一家继续，会话不断。
- 贵的模型用来想，便宜的模型用来跑。

支持原生续聊的代理（Claude Code、Codex、Cursor、qoder、opencode）直接接着它自己的会话历史跑；其余的由 myFlowForge 重建上下文。对你来说是一样的：接着说就行。

### 3. 多个项目，同时开发

一个工作区可以装**多个仓库**。阶段可以**按项目扇出**：前端、后端、SDK 三条泳道被三个代理同时推进，各自跑在独立的 **git worktree** 上互不打架，改动汇总在同一个「变更」面板里核对。

扇出也可以只勾一部分：五个仓库都分析一遍，但只在其中两个里写代码，是完全正常的配置。

### 4. 轻量工作流 · 手动挡

启动工作流**不会**让它一口气跑完。它进入的是「对话态」：

- 顶部 ribbon 显示 *第几步 / 共几步 · 当前阶段 · 正在用哪个代理*。
- 当前阶段的代理**就在你眼前的会话里**干活 —— 输出、工具调用、写了哪个文件都直接可见。
- 不满意就接着聊。追问、纠正、补要求，都不会重跑整个阶段。
- 满意了点「下一步」。这时才生成交接稿，交给下一阶段的代理。

「技术方案设计」阶段会把方案**落成一份真实的 markdown 文档**（`forge-docs/design.md`），按项目分节。这份文档 —— 而不是一段被压缩过的摘要 —— 就是跨代理的唯一契约：下游代理读**整份文档**，再聚焦到属于自己的那一节。

门控阶段跑完会停下等你：**批准**、**打回**（你的补充置顶，上一轮产物作为基线回灌）、或者只是**问一句**而不触发重跑。走到后面才发现方案错了，可以回退到更早的阶段重做。

### 5. 阶段之间的 Hook

Hook 是插在阶段**之间**的一小步。阶段是「让代理干一件开发上的大事」，Hook 是「顺手把这件小事办了」。

可以挂在**整个工作流开始前**、**某个阶段结束后**、或**整个工作流结束后**：拉最新代码、把方案文档同步到 wiki、跑一遍 lint、更新看板、发通知。

每个 Hook 以**受限微代理**的身份在工作区根目录跑 —— 只带它自己被配的 Skill 和工具，加上当前任务和上游已产出的产物列表；干完用一句话汇报，卡在只有人才知道的硬阻塞上时会直接反过来问你。失败会**阻塞**整条流水线并给出重跑 / 跳过 / 终止三个选择。Hook 存在一个跟槽位无关的全局库里：写一次，挂哪儿都行。

---

<div align="center">

<img src="assets/screenshots/workflow.jpg" alt="阶段编排 —— 每个阶段挑自己的代理和模型，代码开发按项目扇出到两个仓库" width="90%" />

<sub><b>阶段编排</b> —— 五个阶段各挑自己的代理和模型，<i>代码开发</i>按项目扇出到两个仓库。</sub>

</div>

---

## 🤖 支持的编码代理

| 代理 | 对话 | 工作流 | 原生续聊 | MCP | 模型来源 |
|------|:----:|:------:|:--------:|:---:|----------|
| **Claude Code** | ✅ | ✅ | ✅ | ✅ | 本地 CLI 动态发现 |
| **Codex** | ✅ | ✅ | ✅ | ✅ | 本地 CLI 动态发现 |
| **Cursor** | ✅ | ✅ | ✅ | ✅ | 本地 CLI 动态发现 |
| **qoder** | ✅ | ✅ | ✅ | ✅ | 动态发现 + 可自定义 |
| **opencode** | ✅ | ✅ | ✅ | ✅ | 多厂商网关 |
| **Gemini** | ✅ | ✅ | — | ✅ | 预置列表 |
| **Qwen** | ✅ | ✅ | — | ✅ | 预置列表 |
| **Copilot** | ✅ | ✅ | — | ✅ | 预置列表 |
| **Pi** | ✅ | ✅ | — | — | 账号默认 / 自定义 |
| **Kimi** | ✅ | ✅ | — | — | kimi-k2.5 · 256K |
| **Reasonix** | ✅ | ✅ | — | — | deepseek-flash / reasoner |
| **Trae** 🆕 | ✅ | ✅ | — | — | 账号默认（`/model` 或 `trae_cli.yaml`） |

> **Trae**（字节 TraeCode CLI）不走 npm —— 官方 `install.sh` 把 `traecli` 装到 `~/.local/bin`，记得把它加进 PATH。想让它在工作流里无人值守改文件，跑 `traecli config edit` 把 `permission_mode` 设成 `bypass_permissions`。

myFlowForge **不存任何 API Key，也不转发任何请求** —— 它驱动的是你本机已经装好、已经登录的 CLI。没装的会在设置里给出安装引导。

## 🔧 一次运行长什么样

```
        你描述目标
            │
            ▼
  ┌─ hook ─┐        ┌─ hook ─┐                    ┌─ hook ─┐
  │ 运行前 │        │ 方案后 │                    │ 运行后 │
  └───┬────┘        └───┬────┘                    └───┬────┘
      ▼                 ▼                             ▼
  📋 需求评估 → 🎨 技术方案设计 → ✋ 门 → 💻 代码开发 → 🧪 写单测 → 🔍 代码 CR
    (澄清)        (产 design.md)  你拍板   (按项目扇出)  (验证)   (多镜头)
                       │                      │
                       │                      └─ 每个项目一个代理，并行泳道，
                       │                         各自独立 worktree
                       └─ 一份真实文档，下游代理读整份

  每一个箭头都要你按「下一步」才走。阶段可增可删可换序可跳过 ——
  只跑「需求 → 开发」两步也完全合法。
```

三种启动方式，最后都汇到同一道门：

1. 右侧工作流面板点「启动」。
2. 输入框里打 `/` 选一条工作流。
3. 直接用自然语言描述一个成套的开发需求，主代理识别出来后通过 MCP 提一个方案门给你确认。纯提问、纯讨论、只改一处的小活不会误触发。

## 🧩 还有这些

- **原生会话导入** —— 只读扫描本机 Claude / Codex / Cursor / qoder 的历史会话，导入成工作区接着聊。
- **MCP 反向桥** —— 内置 Forge MCP 服务器让代理反过来调用应用：`forge_ask`、`forge_propose_plan`、`forge_write_artifact`、`forge_handoff`、`forge_delegate`、`forge_read_context`、`forge_heartbeat`。注入给支持 MCP 的 8 个代理，其余走文字指令兜底。
- **实时可观测** —— 思考 / 工具调用 / 文件改动 / 原始输出全程流式，可筛选的日志控制台、运行历史、跨项目改动证据。
- **额度与 token 用量** —— 各家剩余额度和重置时间，以及按工作区 × 代理 × 天汇总的消耗。
- **机器人桥** —— 在手机上用**钉钉**答确认门、看结果、发起对话、控工作流（飞书 / Telegram 接口已预留）。
- **权限档位** —— 只读审阅 · 自动（工作区，默认）· 完全访问，可按会话设也可按阶段设。映射到各 CLI 真实的沙箱范围，界面会直说哪些代理其实不吃这一套。
- **斜杠命令 / Skill / 插件** —— 打 `/` 唤出本机真实存在的命令和已装 Skill，按代理自动过滤。
- **自定义工作流** —— 流程本身就是你自己拼的：可以存多条命名工作流，各有各的阶段组合；每个阶段单独决定用哪个代理、哪个模型、哪档权限、是否按项目扇出、是否门控、是否必须产文档。
- **自定义阶段** —— 一个属于你自己的全局阶段库，任何工作流都能引用。
- **文件浏览与 Diff** —— 全屏文件树带改动标记，语法高亮预览，Diff / 全文随时切。
- **内置终端** —— 真 pty，直接在工作区目录里敲命令，可配每个 provider 的代理与时区。
- **桌面宠物** —— 跟随焦点屏幕、预览代理动态、弹确认卡；有宠物市场可逛，也能上传自己的图。
- **窗口透明与磨砂** —— 一根磨砂度滑杆把整窗从完全不透明推到 macOS 原生毛玻璃（三档系统材质），桌面若隐若现。
- **个性化** —— 6 套原创皮肤、12 种强调色、270 张内置壁纸画廊或自己的图，应用与对话区可分别设精确 px 字号，深浅两套配色分别调过对比度。
- **壁纸自动配色** —— 打开后整套配色从你选的那张壁纸推导出来，深浅由图片自己决定。壁纸只被允许贡献两个色相，明度与彩度阶梯一律抄自手工调过的皮肤 —— 所以再花的图也生不出读不清的界面。想自己定强调色？选一个，就只有强调色不再跟随。
- **成长宠物** —— 桌面宠物随着你的工作分阶段长大，长会话之后能留下点看得见的东西。
- **对话内嵌可视化** —— 默认关闭；打开后代理写在回答中间的 HTML 片段会渲染成真正的卡片、表格与图示。绝不走 `innerHTML` —— 片段先解析再按构造性白名单重建，颜色只允许取主题变量，所以渲染出来的东西跟着你的皮肤走而不是跟它打架。

## 📥 下载与安装

到 [**Releases**](https://github.com/flowForges/myFlowForge/releases) 页拿最新的 `.dmg`：

| 你的 Mac | 下载 |
|----------|------|
| Apple Silicon（M1/M2/M3/M4） | `myFlowForge-<版本>-arm64.dmg` |
| Intel | `myFlowForge-<版本>.dmg` |

> **⚠️ 应用尚未做代码签名。** 所以首次打开时 macOS 可能提示*「打不开」*或*「已损坏」* —— 这是未签名应用的正常表现，不是文件坏了。任选一种方式：
> - 在 `/应用程序` 里**右键**点击 → **打开** → 在弹窗里再点**打开**；或
> - 终端跑一次：`xattr -dr com.apple.quarantine /Applications/myFlowForge.app`
>
> myFlowForge 会读取同一份 Releases 源，在应用内提示新版本。

## 🚀 从源码跑起来

**前置条件：** macOS 11+、Node.js ≥ 20、git，以及至少一个装好并登录过的编码 CLI。

```bash
git clone https://github.com/flowForges/myFlowForge.git
cd myFlowForge
npm install
npm run dev          # 开发模式，渲染层热更新
```

| 命令 | 做什么 |
|------|--------|
| `npm run dev` | 开发模式启动 |
| `npm test` | 跑全套测试（Vitest） |
| `npm run typecheck` | 主进程与渲染层两套 tsconfig 一起类型检查 |
| `npm run build` | 构建生产包 |
| `npm run dist:mac-all` | 打 Intel + Apple Silicon 两个 `.dmg` |

产物写在 `release/`。改了 `src/main/**` 必须**完全重启 Electron**才生效，热更新只刷渲染层。

## 🏗️ 技术栈

**外壳：** [Electron](https://www.electronjs.org/) 42 + [electron-vite](https://electron-vite.org/) · **界面：** [React](https://react.dev/) 19 + TypeScript 6 · **终端：** [xterm.js](https://xtermjs.org/) + [node-pty](https://github.com/microsoft/node-pty) · **代理桥：** [Model Context Protocol SDK](https://modelcontextprotocol.io/) · **进程控制：** [execa](https://github.com/sindresorhus/execa) · **校验：** [zod](https://zod.dev/) · **文件监听：** [chokidar](https://github.com/paulmillr/chokidar) · **测试：** [Vitest](https://vitest.dev/) + Testing Library · **打包：** [electron-builder](https://www.electron.build/)

## 📁 目录结构

```
src/
├── main/              # Electron 主进程
│   ├── agents/        # 各 CLI 适配器 + provider 注册表、探测、权限
│   ├── run/           # 工作流引擎：阶段、门、扇出、hook、交接
│   ├── chat/          # 每工作区的对话、队列、记忆
│   ├── mcp/           # Forge MCP 服务器（代理 → 应用 反向桥）
│   ├── bot/           # 机器人桥（钉钉 / Telegram / 飞书 传输层）
│   ├── plugins/       # 插件宿主、目录、调度、扩展点
│   ├── sessionImport/ # 原生会话扫描与导入
│   ├── usage/         # 各家额度适配器
│   ├── pet/           # 桌面宠物窗口
│   └── ...            # git、fs、终端、更新、监听、窗口、外观
├── renderer/          # React 界面（视图、组件、设置、主题、宠物）
├── preload/           # 上下文隔离的 IPC 桥
└── shared/            # 跨进程共享的类型与纯逻辑
```

## 🤝 参与贡献

欢迎提 issue 和 PR。项目走 **TDD** —— 改动请连测试一起，并确保 `npm test` 与 `npm run typecheck` 通过再开 PR。

## 📄 许可

采用 [MIT License](LICENSE) 发布 © 2026 zghua。

## 🙏 致谢

建立在 Electron、React、Vite 与 Model Context Protocol 周边优秀的开源生态之上 —— 以及它所编排的那些编码代理。
