<div align="center">

<img src="build/icon.png" alt="myFlowForge" width="128" height="128" />

# myFlowForge

**Schmiede deinen KI-Coding-Workflow.**

Ein Desktop-Cockpit, das **Claude Code, Codex, Cursor, Gemini, qoder & opencode** zu einer geregelten, mehrstufigen Coding-Pipeline zusammenführt – mit Freigabe-Gates für Pläne, nativem Session-Import, Live-Nutzungsverfolgung, MCP-Integration und einem Desktop-Haustier, das dir Gesellschaft leistet.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-macOS-000000?logo=apple&logoColor=white)

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · **Deutsch**

</div>

---

## Was ist myFlowForge?

Moderne KI-Coding-Tools leben jeweils in ihrem eigenen Terminal, mit ihrem eigenen Session-Zustand, ihrem eigenen Kontingent und ohne gemeinsamen Plan. **myFlowForge** bringt sie alle unter ein Dach und verwandelt „mit einer KI chatten“ in einen **wiederholbaren, überprüfbaren Engineering-Workflow**.

Du beschreibst, was du willst. Forge steuert deine gewählten Agenten durch eine mehrstufige Pipeline – **Anforderung → Design → Entwicklung → Test → Review** – und pausiert an einem **harten Gate**, damit du den technischen Plan freigeben kannst, *bevor* auch nur eine einzige Zeile Code geschrieben wird. Jede Stufe kann einen anderen Agenten und ein anderes Modell nutzen, parallel über mehrere Projekte hinweg, während ein freundliches Desktop-Haustier dir auf einen Blick zeigt, was gerade passiert.

> ⚠️ **Projektstatus:** myFlowForge ist ein aktiv entwickeltes persönliches Projekt. Es richtet sich derzeit an **macOS** (Apple Silicon & Intel). Da es auf Electron basiert, kann es aus dem Quellcode auch für andere Plattformen gebaut werden, doch verpackt wird heute nur macOS.

## ✨ Highlights

- **🎛️ Multi-Agenten-Orchestrierung** – Leite jede Workflow-Stufe an eine andere Coding-CLI (Claude Code, Codex, Cursor, Gemini, qoder, opencode) und ein anderes Modell weiter. **opencode** ist selbst ein Multi-Provider-Gateway – verbinde es einmal, um viele Modellanbieter zu erreichen.
- **📂 Im Editor öffnen** – Eine Schaltfläche „Ort öffnen“ in der Titelleiste erkennt installierte Editoren (VS Code, Cursor, JetBrains, Zed, Finder, Terminals …) und öffnet den aktuellen Workspace – oder die Datei, die du gerade in der Vorschau ansiehst – in deiner Wahl, die als Standard gemerkt wird.
- **⌨️ Chat-Slash-Befehle** – Gib `/` im Chat ein, um ein Menü mit Workflow-Auslösern sowie deinen **echten, auf der Festplatte liegenden Befehlen/Prompts und installierten Skills** zu erhalten, pro Agent gefiltert.
- **🔄 Geregelte mehrstufige Pipeline** – Anforderung → Design → Entwicklung → Test → Review, mit einem **harten Freigabe-Gate für Pläne**: Überprüfe und genehmige (oder verwirf) das technische Design, bevor die Ausführung beginnt.
- **✂️ Selektive, token-effiziente Ausführung** – Ein konfigurierter Workflow zwingt nicht mehr jede Aufgabe durch alle Stufen über alle Projekte hinweg. Beschreibe eine kleine Aufgabe in einfacher Sprache, und der orchestrierende Agent schlägt einen **gekürzten Plan** vor – führe nur die Stufen aus, die du brauchst (z. B. Test/Review überspringen), und begrenze jede Stufe auf eine Teilmenge der Projekte (z. B. alle fünf analysieren, aber nur in zwei Code schreiben). Die Freigabe-Karte zeigt dir genau, was laufen wird, bevor du bestätigst.
- **🧭 Orchestrator, kein Ausführer** – Der Haupt-Chat-Agent schreibt niemals Code und erzeugt keine eigenen internen Sub-Agenten; er zerlegt lediglich Aufgaben und delegiert jeden praktischen Schritt an Forges echte, orchestrierte Sub-Agenten.
- **🧩 Parallele Projekte & Workspaces** – Betreibe mehrere Workspaces gleichzeitig, jeder mit isolierten git-Worktrees; beobachte, wie mehrere Agenten Seite an Seite in parallelen Bahnen arbeiten.
- **📥 Nativer Session-Import** – Scanne und importiere deine bestehenden lokalen Claude- / Codex- / Cursor- / qoder-Sessions schreibgeschützt in einen zentralen Index und nimm sie dann als Workspaces wieder auf.
- **📊 Live-Nutzung & Kontingentverfolgung** – Echte Nutzungsadapter zeigen das verbleibende Kontingent und die Reset-Zeiten jedes Anbieters an.
- **🔌 MCP-Integration** – Ein integrierter Forge-MCP-Server verbindet Agenten wieder mit der App (Fragen stellen, Pläne vorschlagen, Artefakte übergeben) für eine zuverlässige, werkzeuggesteuerte Steuerung.
- **🖥️ Echtzeit-Beobachtbarkeit** – Streaming von Denk- / Ausführungs- / Dateiänderungs- / Ausgabeprotokollen, eine filterbare Log-Konsole und projektübergreifende Änderungsnachweise.
- **🐾 Desktop-Haustier** – Ein ziehbarer, in der Größe veränderbarer Begleiter, der deinem Fokus folgt, die Aktivität der Agenten in der Vorschau zeigt und Bestätigungskarten einblendet – mit konfigurierbaren Effekten und mehreren Haustier-Paketen.
- **🎨 Ausgefeilte, personalisierbare Benutzeroberfläche** – Glasmorphismus, **6 Themes** (hell / dunkel / automatisch + Mitternacht / Sepia / Wald), **12 Akzentfarben**, ein **eigenes Hintergrundbild** (ganze App oder Chat-Bereich, mit einstellbarer Deckkraft), ein neu gestaltetes Home-Dashboard mit einer Begrüßung anhand der lokalen Live-Zeit, in der Größe veränderbare Bereiche und ein Benachrichtigungszentrum.

## 🤖 Unterstützte Coding-Agenten

| Agent | Chat | Workflow-Lauf | Native Wiederaufnahme | Modelle | MCP |
|-------|:----:|:------------:|:-------------:|:------:|:---:|
| **Claude Code** | ✅ | ✅ | ✅ | dynamisch | ✅ |
| **Codex** | ✅ | ✅ | ✅ | dynamisch | ✅ |
| **Cursor** | ✅ | ✅ | ✅ | dynamisch | — |
| **Gemini** | ✅ | ✅ | — | dynamisch | — |
| **qoder** | ✅ | ✅ | ✅ | dynamisch | ✅ |
| **opencode** | ✅ | ✅ | ✅ | dynamisch (multi-vendor) | — |

> Modelle werden aus der echten lokalen Konfiguration jeder CLI ermittelt – nichts ist fest codiert, und du kannst die Modellliste pro Anbieter bearbeiten. **opencode** ermittelt seine Modelle über `opencode models`, sodass eine einzige Integration jeden Anbieter mitbringt, den du darin konfiguriert hast.

## 🔧 Wie es funktioniert

```
   You describe the goal
            │
            ▼
   📋 Requirement  ──►  🎨 Design  ──►  ✋ PLAN GATE  ──►  💻 Develop  ──►  🧪 Test  ──►  🔍 Review
     (clarify)         (tech plan)     approve / reject      (code)        (verify)     (audit)
            │                                │
            │                                └─ You confirm the plan is correct *before* any code is written
            ▼
   Each stage → your chosen agent + model, isolated git worktree, live streaming logs
```

Drei Wege, einen Workflow auszulösen, die alle auf demselben einzigen Gate zusammenlaufen:

1. Der Haupt-Chat-Agent erkennt die Absicht und ruft das MCP-Tool **`forge_propose_plan`** auf.
2. Eine skill-gesteuerte, eingezäunte Direktive als Fallback.
3. Die explizite Schaltfläche **„Workflow starten“**.

## 📥 Herunterladen & installieren

Hol dir die neueste `.dmg` von der Seite [**Releases**](https://github.com/flowForges/myFlowForge/releases):

| Dein Mac | Empfohlener Download |
|----------|----------------------|
| Apple Silicon (M1/M2/M3/M4) | `myFlowForge-<version>-arm64.dmg` oder der universelle Build |
| Intel | `myFlowForge-<version>.dmg` (x64) oder der universelle Build |
| Nicht sicher | `myFlowForge-<version>-universal.dmg` – funktioniert auf beiden |

> **⚠️ Die App ist noch nicht code-signiert.** Beim ersten Start warnt macOS möglicherweise, dass die App *„nicht geöffnet werden kann“* oder *„beschädigt ist“*. Das ist bei einer nicht signierten App zu erwarten. So öffnest du sie:
> - **Rechtsklick** auf die App in `/Applications` → **Öffnen** → **Öffnen** im Dialog, **oder**
> - führe einmal im Terminal aus: `xattr -dr com.apple.quarantine /Applications/myFlowForge.app`
>
> myFlowForge prüft diesen Releases-Feed auf Updates und bietet neuere Versionen direkt in der App an.

## 🚀 Erste Schritte

### Voraussetzungen

- **macOS** (Apple Silicon oder Intel)
- **Node.js** ≥ 20 und **npm**
- Eine oder mehrere der unterstützten Coding-CLIs installiert und authentifiziert (Claude Code, Codex, Cursor, Gemini, qoder). Forge erkennt, was du hast, und führt dich durch die Installation der übrigen.

### Installieren & im Entwicklungsmodus ausführen

```bash
# 1. Clone
git clone https://github.com/flowForges/myFlowForge.git
cd myFlowForge

# 2. Install dependencies
npm install

# 3. Launch in dev mode (hot reload)
npm run dev
```

### Nützliche Skripte

| Befehl | Was er macht |
|---------|--------------|
| `npm run dev` | Startet die App mit Hot Reload |
| `npm test` | Führt die vollständige Testsuite aus (Vitest) |
| `npm run typecheck` | Typprüfung für die tsconfigs von Main & Renderer |
| `npm run build` | Baut das Produktions-Bundle |
| `npm run dist` | Baut ein macOS-Distributionspaket (`.dmg`) |

### Ein Distributionspaket bauen

```bash
npm run dist            # macOS x64
npm run dist:arm64      # Apple Silicon
npm run dist:universal  # Universal binary
```

Artefakte werden nach `release/` geschrieben.

## 🏗️ Tech-Stack

- **Shell:** [Electron](https://www.electronjs.org/) 42 + [electron‑vite](https://electron-vite.org/)
- **UI:** [React](https://react.dev/) 19 + TypeScript 6
- **Terminal:** [xterm.js](https://xtermjs.org/) + [node‑pty](https://github.com/microsoft/node-pty)
- **Agent-Bridge:** [Model Context Protocol SDK](https://modelcontextprotocol.io/)
- **Prozesssteuerung:** [execa](https://github.com/sindresorhus/execa) · **Validierung:** [zod](https://zod.dev/) · **Dateiüberwachung:** [chokidar](https://github.com/paulmillr/chokidar)
- **Testing:** [Vitest](https://vitest.dev/) + Testing Library (durchgängig Test‑Driven Development)
- **Paketierung:** [electron‑builder](https://www.electron.build/)

## 📁 Projektstruktur

```
src/
├── main/          # Electron main process
│   ├── agents/    # CLI adapters (claude, codex, cursor, gemini, qoder, opencode) + providers
│   ├── orchestrator/  # Workflow engine & stage gating
│   ├── chat/      # Per-workspace chat, queue, memory
│   ├── mcp/       # Forge MCP server (agent → app bridge)
│   ├── pet/       # Desktop pet window
│   ├── sessionImport/  # Native session scanning & import
│   ├── usage/     # Provider quota adapters
│   └── ...        # git, fs, terminal, update, watcher, windows
├── renderer/      # React UI (views, components, pet, settings, theme)
├── preload/       # Context‑isolated IPC bridge
└── shared/        # Types shared across processes
```

## 🤝 Mitwirken

Beiträge, Issues und Feature-Wünsche sind willkommen! Dieses Projekt folgt einem **testgetriebenen** Workflow – bitte füge mit deinen Änderungen Tests hinzu oder aktualisiere sie und stelle sicher, dass `npm test` und `npm run typecheck` erfolgreich durchlaufen, bevor du einen PR eröffnest.

## 📄 Lizenz

Veröffentlicht unter der [MIT-Lizenz](LICENSE) © 2026 zghua.

## 🙏 Danksagungen

Aufgebaut auf dem hervorragenden Open-Source-Ökosystem rund um Electron, React, Vite und das Model Context Protocol – sowie den Coding-Agenten, die es orchestriert: Claude Code, Codex, Cursor, Gemini und qoder.
