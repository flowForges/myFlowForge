<div align="center">

<img src="build/icon.png" alt="myFlowForge" width="128" height="128" />

# myFlowForge

**A macOS cockpit for your AI coding agents.**

A macOS desktop cockpit that gathers **Claude Code, Codex, Cursor, Gemini, qoder, opencode, Trae** and more into one place — so you can **swap agent and model mid-conversation**, **build across several projects in parallel**, shape the work with a **lightweight, manual-gear workflow**, and weave your own **hooks** between stages.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-macOS-000000?logo=apple&logoColor=white)

**English** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

</div>

---

<div align="center">

<img src="assets/screenshots/home.jpg" alt="Home — workspaces, running agents and today's diff at a glance" width="90%" />

<sub><b>Home</b> — pick up where you left off. Wallpaper, skin and accent are all yours to change.</sub>

</div>

---

## What is myFlowForge?

Every AI coding CLI lives in its own terminal, with its own session state, its own quota, and no idea the others exist. Pick one and you're married to it for the rest of the task.

**myFlowForge puts them all under one roof.** The agent and the model are properties of *each turn*, not of the session — so you can think a design through with Claude Opus, hand the implementation to Codex, and drop to something cheap for the mop-up, all inside one conversation with the context intact.

On top of that sits a **lightweight workflow**: not an assembly line that runs away from you, but a thin layer of structure over the same conversation. Every stage waits for you to press *Next*.

> ⚠️ **Project status:** an actively developed personal project. It targets **macOS** (Apple Silicon & Intel). Being Electron-based it can be built for other platforms from source, but only macOS is packaged today. Most releases are betas — that's where new features land.

## ✨ The five things it's really about

### 1. A collection of agents, not a favourite one

Twelve coding CLIs coexist in one interface: **Claude Code · Codex · Cursor · Gemini · qoder · opencode · Qwen · Copilot · Pi · Kimi · Reasonix · Trae**.

Model lists are **read from each CLI's real local configuration** — nothing hard-coded, so what you see is what your account can actually run. You can also add entries by hand, and they survive the next refresh. **opencode** is itself a multi-vendor gateway: wire it once, reach many.

### 2. Switch agent and model inside one session

Agent, model and permission mode are three pickers sitting under the composer. Change any of them before your next message:

- One model stalls or drifts → switch and keep asking; it sees the conversation so far.
- Out of quota with one provider → switch to another, same session.
- Expensive model for the thinking, cheap model for the grunt work.

Agents with native resume (Claude Code, Codex, Cursor, qoder, opencode) continue their own session history. For the rest, myFlowForge reconstructs the context. Either way you just keep talking.

### 3. Several projects, developed at the same time

A workspace holds **many repos**. A stage can *fan out per project*: frontend, backend and SDK advance simultaneously, each driven by its own agent in its own **git worktree** so they never collide — and every diff lands in one Changes panel for review.

Fan-out takes a subset too: analyse all five repos but write code in only two is a perfectly normal setup.

### 4. A lightweight workflow — in manual gear

Starting a workflow does **not** set it running to the end. It enters a conversational mode:

- A ribbon shows *step N of M · current stage · which agent is driving*.
- The stage's agent works **in the chat in front of you** — output, tool calls and file writes all visible.
- Not satisfied? Just keep talking. Follow-ups and corrections don't re-run the stage.
- Happy? Press **Next**. Only then is the handoff written and the next agent brought in.

The Design stage writes a **real markdown document** (`forge-docs/design.md`), sectioned per project. That document — not a lossy summary — is the single cross-agent contract; downstream agents read the whole thing and focus on their own section.

Gated stages stop and wait for you: **approve**, **send back** (your notes get pinned to the top, the previous output fed back as the baseline), or just **ask a question** without triggering a re-run. Realised late that the design was wrong? Jump back to an earlier stage and redo it.

### 5. Hooks between the stages

A hook is a small step wedged **between** stages — where a stage is an agent doing real engineering, a hook is a chore taken care of along the way.

Attach one **before the run**, **after any given stage**, or **after the whole run**: pull the latest code, sync the design doc to your wiki, run lint, update a board, send a notification.

Each hook runs as a **restricted micro-agent** at the workspace root — only the skills and tools it was given, plus the task and the artifacts produced upstream. It reports back in one line, and asks you directly when it hits something only a human can resolve. A failure **blocks** the pipeline and offers retry / skip / abort. Hooks live in a global library, independent of any slot: write once, attach anywhere.

---

<div align="center">

<img src="assets/screenshots/workflow.jpg" alt="Stage composition — each stage picks its own agent and model; Develop fans out to two projects" width="90%" />

<sub><b>Stage composition</b> — five stages, each with its own agent and model; <i>Develop</i> fans out across two repos.</sub>

</div>

---

## 🤖 Supported coding agents

| Agent | Chat | Workflow | Native resume | MCP | Models |
|-------|:----:|:--------:|:-------------:|:---:|--------|
| **Claude Code** | ✅ | ✅ | ✅ | ✅ | discovered from CLI |
| **Codex** | ✅ | ✅ | ✅ | ✅ | discovered from CLI |
| **Cursor** | ✅ | ✅ | ✅ | ✅ | discovered from CLI |
| **qoder** | ✅ | ✅ | ✅ | ✅ | discovered + custom list |
| **opencode** | ✅ | ✅ | ✅ | ✅ | multi-vendor gateway |
| **Gemini** | ✅ | ✅ | — | ✅ | preset list |
| **Qwen** | ✅ | ✅ | — | ✅ | preset list |
| **Copilot** | ✅ | ✅ | — | ✅ | preset list |
| **Pi** | ✅ | ✅ | — | — | account default / custom |
| **Kimi** | ✅ | ✅ | — | — | kimi-k2.5 · 256K |
| **Reasonix** | ✅ | ✅ | — | — | deepseek-flash / reasoner |
| **Trae** 🆕 | ✅ | ✅ | — | — | account default (`/model` or `trae_cli.yaml`) |

> **Trae** (ByteDance's TraeCode CLI) doesn't ship on npm — its official `install.sh` puts `traecli` in `~/.local/bin`, so make sure that's on your PATH. For unattended edits inside a workflow, run `traecli config edit` and set `permission_mode: bypass_permissions`.

myFlowForge **stores no API keys and proxies no requests** — it drives the CLIs already installed and authenticated on your machine. Anything missing is flagged in Settings with install guidance.

## 🔧 How a run is shaped

```
   You describe the goal
            │
            ▼
  ┌─ hook ─┐        ┌─ hook ─┐                    ┌─ hook ─┐
  │ before │        │  after │                    │  after │
  │  run   │        │ design │                    │  run   │
  └───┬────┘        └───┬────┘                    └───┬────┘
      ▼                 ▼                             ▼
 📋 Requirement → 🎨 Design → ✋ GATE → 💻 Develop → 🧪 Test → 🔍 Review
   (clarify)     (design.md)  you decide  (fan out)  (verify)  (multi-lens)
                      │                       │
                      │                       └─ one agent per project,
                      │                          parallel lanes, own worktree
                      └─ a real document, read in full by every downstream agent

 Every arrow waits for you to press "Next". Stages can be added, removed,
 reordered or skipped — running just Requirement → Develop is perfectly valid.
```

Three ways to start one, all landing on the same gate:

1. Press **Start** in the Workflow panel.
2. Type `/` in the composer and pick one.
3. Describe a full development task in plain language — the main agent recognises it and raises a plan gate through MCP. Questions, discussion and one-line fixes don't trip it.

## 🧩 Also in the box

- **Native session import** — read-only scan of your local Claude / Codex / Cursor / qoder history; import as a workspace and continue.
- **MCP bridge** — a built-in Forge MCP server lets agents call back into the app: `forge_ask`, `forge_propose_plan`, `forge_write_artifact`, `forge_handoff`, `forge_delegate`. Injected into the eight agents that support MCP; the rest fall back to a text directive.
- **Real-time observability** — streaming thinking / tool calls / file changes / raw output, a filterable log console, run history, and cross-project change evidence.
- **Token usage & quota** — remaining quota and reset times per provider, plus spend by workspace × agent × day.
- **Bot bridge** — answer gates, check results, start a conversation and drive workflows from **DingTalk** on your phone (Telegram / Feishu wired for later).
- **Permission modes** — read-only · workspace-auto (default) · full access, per session or per stage. Mapped onto each CLI's real sandbox scope, and the UI says plainly which agents actually honour it.
- **Slash commands, skills & plugins** — `/` surfaces your real on-disk commands and installed skills, filtered per agent.
- **Custom workflows** — the process is yours to assemble: save as many named workflows as you like, each with its own stage set; every stage picks its agent, model, permission mode, fan-out shape, whether it gates and whether it must produce a document.
- **Custom stages** — a global library of your own stages, referenced by any workflow.
- **File browser & diff** — full-screen tree with change markers, syntax-highlighted preview, diff-or-full toggle.
- **Built-in terminal** — a real pty rooted in the workspace, with per-provider proxy and timezone settings.
- **Desktop pet** — follows your focused screen, previews agent activity, pops confirmation cards; browse the pet market or bring your own images.
- **Transparency & frosted glass** — one blur slider takes the whole window from fully opaque through three native macOS vibrancy materials, so your desktop shows through.
- **Personalisation** — 6 original skins, 12 accent colours, a wallpaper gallery or your own image, exact-pixel font sizes for app and chat independently, light and dark contrast-tuned separately.

## 📥 Download & install

Grab the latest `.dmg` from the [**Releases**](https://github.com/flowForges/myFlowForge/releases) page:

| Your Mac | Download |
|----------|----------|
| Apple Silicon (M1/M2/M3/M4) | `myFlowForge-<version>-arm64.dmg` |
| Intel | `myFlowForge-<version>.dmg` |

> **⚠️ The app is not code-signed yet.** On first launch macOS may say it *"can't be opened"* or *"is damaged"* — that's what an unsigned app looks like, the file is fine. Either:
> - **Right-click** the app in `/Applications` → **Open** → **Open** in the dialog, or
> - run once: `xattr -dr com.apple.quarantine /Applications/myFlowForge.app`
>
> myFlowForge checks this same Releases feed and offers newer versions in-app.

## 🚀 Getting started

**Prerequisites:** macOS 11+, Node.js ≥ 20, git, and at least one supported coding CLI installed and authenticated.

```bash
git clone https://github.com/flowForges/myFlowForge.git
cd myFlowForge
npm install
npm run dev          # dev mode with renderer hot reload
```

| Command | What it does |
|---------|--------------|
| `npm run dev` | Start with hot reload |
| `npm test` | Run the full test suite (Vitest) |
| `npm run typecheck` | Type-check both main & renderer tsconfigs |
| `npm run build` | Build the production bundle |
| `npm run dist:mac-all` | Build both Intel and Apple Silicon `.dmg`s |

Artifacts land in `release/`. Changes under `src/main/**` need a **full Electron restart** — hot reload only refreshes the renderer.

## 🏗️ Tech stack

**Shell:** [Electron](https://www.electronjs.org/) 42 + [electron-vite](https://electron-vite.org/) · **UI:** [React](https://react.dev/) 19 + TypeScript 6 · **Terminal:** [xterm.js](https://xtermjs.org/) + [node-pty](https://github.com/microsoft/node-pty) · **Agent bridge:** [Model Context Protocol SDK](https://modelcontextprotocol.io/) · **Process control:** [execa](https://github.com/sindresorhus/execa) · **Validation:** [zod](https://zod.dev/) · **File watching:** [chokidar](https://github.com/paulmillr/chokidar) · **Testing:** [Vitest](https://vitest.dev/) + Testing Library · **Packaging:** [electron-builder](https://www.electron.build/)

## 📁 Project structure

```
src/
├── main/              # Electron main process
│   ├── agents/        # CLI adapters + provider registry, detection, permissions
│   ├── run/           # Workflow engine: stages, gates, fan-out, hooks, handoffs
│   ├── chat/          # Per-workspace chat, queue, memory
│   ├── mcp/           # Forge MCP server (agent → app bridge)
│   ├── bot/           # Bot bridge (DingTalk / Telegram / Feishu transports)
│   ├── plugins/       # Plugin host, catalog, scheduler, extension points
│   ├── sessionImport/ # Native session scanning & import
│   ├── usage/         # Provider quota adapters
│   ├── pet/           # Desktop pet window
│   └── ...            # git, fs, terminal, update, watcher, windows, appearance
├── renderer/          # React UI (views, components, settings, theme, pet)
├── preload/           # Context-isolated IPC bridge
└── shared/            # Types & pure logic shared across processes
```

## 🤝 Contributing

Issues and PRs are welcome. The project is **test-driven** — please add or update tests with your changes and make sure `npm test` and `npm run typecheck` pass before opening a PR.

## 📄 License

Released under the [MIT License](LICENSE) © 2026 zghua.

## 🙏 Acknowledgements

Built on the open-source ecosystem around Electron, React, Vite and the Model Context Protocol — and on the coding agents it orchestrates.
