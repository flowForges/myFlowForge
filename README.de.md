<div align="center">

<img src="build/icon.png" alt="myFlowForge" width="128" height="128" />

# myFlowForge

**Ein Cockpit für deine KI-Coding-Agenten — auf deinem Schreibtisch, auf deinen Servern, in deiner Hosentasche.**

Ein Desktop-Cockpit, das **Claude Code, Codex, Cursor, Gemini, qoder, opencode, DeepSeek** und mehr an einem Ort versammelt — damit du **mitten im Gespräch Agent und Modell wechseln**, **an mehreren Projekten parallel bauen**, die Arbeit mit einem **leichtgewichtigen Workflow mit Handschaltung** formen, eigene **Hooks** zwischen die Stufen weben und das Ganze **von einem anderen Rechner oder deinem Handy aus** erreichen kannst.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-macOS%20·%20Windows%20·%20Linux-000000)
![Mobile](https://img.shields.io/badge/Mobile-iOS%20·%20Android-3DDC84)

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · **Deutsch**

</div>

---

<div align="center">

<img src="assets/screenshots/home.jpg" alt="Startseite — Arbeitsbereiche, laufende Agenten und der heutige Diff auf einen Blick" width="90%" />

<sub><b>Startseite</b> — mach da weiter, wo du aufgehört hast. Hintergrundbild, Skin und Akzentfarbe kannst du frei ändern.</sub>

</div>

---

## Was ist myFlowForge?

Jede KI-Coding-CLI lebt in ihrem eigenen Terminal, mit eigenem Sitzungszustand, eigenem Kontingent und keiner Ahnung, dass es die anderen gibt. Wählst du eine aus, bist du für den Rest der Aufgabe mit ihr verheiratet.

**myFlowForge bringt sie alle unter ein Dach.** Agent und Modell sind Eigenschaften *jedes einzelnen Zugs*, nicht der Sitzung — du kannst also ein Design mit Claude Opus durchdenken, die Umsetzung an Codex übergeben und für die Aufräumarbeiten auf etwas Günstiges umsteigen, alles in einem Gespräch und mit intaktem Kontext.

Darüber liegt ein **leichtgewichtiger Workflow**: kein Fließband, das dir davonläuft, sondern eine dünne Schicht Struktur über demselben Gespräch. Jede Stufe wartet darauf, dass du auf *Weiter* drückst.

Und nichts davon klebt an einem Rechner. Dasselbe Cockpit **verbindet sich mit einem anderen Computer** — deiner Linux-Kiste, dem Desktop im Büro — und steuert *dessen* Agenten in *dessen* Repos. Vom Handy aus kannst du einem Lauf zusehen, ein Gate beantworten und das Gespräch weiterführen.

> **Projektstatus:** ein aktiv entwickeltes persönliches Projekt. Für macOS, Windows und Linux gibt es fertig paketierte Builds, und für den Handy-Client eine Android-APK. Die App ist auf keiner Plattform bislang code-signiert.

## ✨ Die sechs Dinge, um die es wirklich geht

### 1. Eine Sammlung von Agenten, kein Lieblingsagent

Vierzehn Coding-CLIs koexistieren in einer Oberfläche: **Claude Code · Codex · Cursor · Gemini · qoder · opencode · Qwen · Copilot · Pi · Kimi · Reasonix · Trae · Antigravity · DeepSeek**.

Modelllisten werden **aus der echten lokalen Konfiguration jeder CLI gelesen** — nichts ist fest verdrahtet, du siehst also, was dein Konto tatsächlich ausführen kann. Du kannst auch von Hand Einträge hinzufügen, und die überleben die nächste Aktualisierung. **opencode** ist selbst ein Gateway zu vielen Anbietern: einmal verkabelt, viele erreicht.

### 2. Agent und Modell innerhalb einer Sitzung wechseln

Agent, Modell und Berechtigungsmodus sind drei Auswahlfelder unter dem Eingabefeld. Ändere jedes davon vor deiner nächsten Nachricht:

- Ein Modell stockt oder driftet ab → wechseln und weiterfragen; es sieht das bisherige Gespräch.
- Kontingent bei einem Anbieter aufgebraucht → zu einem anderen wechseln, gleiche Sitzung.
- Teures Modell fürs Nachdenken, günstiges Modell für die Fleißarbeit.

Agenten mit nativem Resume (Claude Code, Codex, Cursor, qoder, opencode) setzen ihren eigenen Sitzungsverlauf fort. Für die übrigen rekonstruiert myFlowForge den Kontext. So oder so redest du einfach weiter.

### 3. Mehrere Projekte, gleichzeitig entwickelt

Ein Arbeitsbereich fasst **viele Repos**. Eine Stufe kann *pro Projekt auffächern*: Frontend, Backend und SDK kommen gleichzeitig voran, jedes getrieben von seinem eigenen Agenten in seinem eigenen **git worktree**, sodass sie nie kollidieren — und jeder Diff landet zur Durchsicht in einem Änderungen-Panel.

Das Auffächern nimmt auch eine Teilmenge: alle fünf Repos analysieren, aber nur in zweien Code schreiben, ist ein völlig normales Setup.

### 4. Ein leichtgewichtiger Workflow — mit Handschaltung

Einen Workflow zu starten, lässt ihn **nicht** bis zum Ende durchlaufen. Er geht in einen dialogischen Modus über:

- Eine Leiste zeigt *Schritt N von M · aktuelle Stufe · welcher Agent gerade steuert*.
- Der Agent der Stufe arbeitet **im Chat direkt vor dir** — Ausgabe, Tool-Aufrufe und Dateischreibvorgänge alle sichtbar.
- Nicht zufrieden? Rede einfach weiter. Nachfragen und Korrekturen starten die Stufe nicht neu.
- Zufrieden? Drück **Weiter**. Erst dann wird die Übergabe geschrieben und der nächste Agent geholt.

Die Design-Stufe schreibt ein **echtes Markdown-Dokument** (`forge-docs/design.md`), pro Projekt in Abschnitte gegliedert. Dieses Dokument — keine verlustbehaftete Zusammenfassung — ist der einzige agentenübergreifende Vertrag; nachgelagerte Agenten lesen das Ganze und konzentrieren sich auf ihren eigenen Abschnitt.

Stufen mit Gate halten an und warten auf dich: **freigeben**, **zurückschicken** (deine Anmerkungen werden oben angeheftet, die vorherige Ausgabe als Grundlage zurückgespielt) oder einfach **eine Frage stellen**, ohne einen erneuten Lauf auszulösen. Spät gemerkt, dass das Design falsch war? Spring zu einer früheren Stufe zurück und mach sie neu.

### 5. Hooks zwischen den Stufen

Ein Hook ist ein kleiner Schritt, **zwischen** die Stufen geklemmt — wo eine Stufe ein Agent ist, der echte Entwicklungsarbeit leistet, ist ein Hook eine Pflichtaufgabe, die nebenbei erledigt wird.

Häng einen **vor dem Lauf**, **nach einer bestimmten Stufe** oder **nach dem gesamten Lauf** an: den neuesten Code ziehen, das Design-Dokument ins Wiki synchronisieren, Lint laufen lassen, ein Board aktualisieren, eine Benachrichtigung senden.

Jeder Hook läuft als **eingeschränkter Mikro-Agent** in der Wurzel des Arbeitsbereichs — nur mit den Skills und Tools, die er bekommen hat, plus der Aufgabe und den vorgelagert erzeugten Artefakten. Er meldet sich in einer Zeile zurück und fragt dich direkt, wenn er auf etwas trifft, das nur ein Mensch klären kann. Ein Fehlschlag **blockiert** die Pipeline und bietet Wiederholen / Überspringen / Abbrechen an. Hooks leben in einer globalen Bibliothek, unabhängig von jedem Steckplatz: einmal schreiben, überall anhängen.

### 6. Deine Rechner und dein Handy

Der Host, mit dem du verbunden bist, ist ein **Schalter in der Statusleiste**, neben dem Terminal-Knopf. Kipp ihn um, und die Arbeitsbereichsliste, die Sitzungen, die laufenden Agenten, die git-Änderungen und das eingebaute Terminal werden alle die *jenes Rechners*.

- **Direkt** über dein LAN, oder per **SSH**, oder durch ein **Ende-zu-Ende-verschlüsseltes Relay**, wenn die beiden Rechner einander nicht sehen können. Das Relay bewegt immer nur Geheimtext — es kann eine Sitzung nicht lesen, und der Raum wird aus dem öffentlichen Schlüssel des Daemons abgeleitet.
- Auf einer Linux-Kiste ohne Bildschirm läuft der **Daemon**: `myflowforge-daemon pair` gibt einen QR-Code direkt im Terminal aus. Scannen, und ihr seid gekoppelt.
- Der **Handy-Client** (iOS & Android) ist ein echter Client, kein Betrachter: das Gespräch im Stream mitlesen, Berechtigungs- und Plan-Gates beantworten, geänderte Dateien durchsehen, einen Arbeitsbereich anlegen, einen Workflow bearbeiten, den Host wechseln.

---

<div align="center">

<img src="assets/screenshots/workflow.jpg" alt="Stufen-Zusammenstellung — jede Stufe wählt ihren eigenen Agenten und ihr eigenes Modell; Develop fächert auf zwei Projekte auf" width="90%" />

<sub><b>Stufen-Zusammenstellung</b> — fünf Stufen, jede mit eigenem Agenten und Modell; <i>Develop</i> fächert über zwei Repos auf.</sub>

</div>

---

## 🤖 Unterstützte Coding-Agenten

| Agent | Chat | Workflow | Natives Resume | MCP | Modelle |
|-------|:----:|:--------:|:-------------:|:---:|--------|
| **Claude Code** | ✅ | ✅ | ✅ | ✅ | aus der CLI ermittelt |
| **Codex** | ✅ | ✅ | ✅ | ✅ | aus der CLI ermittelt |
| **Cursor** | ✅ | ✅ | ✅ | ✅ | aus der CLI ermittelt |
| **qoder** | ✅ | ✅ | ✅ | ✅ | ermittelt + eigene Liste |
| **opencode** | ✅ | ✅ | ✅ | ✅ | Gateway zu vielen Anbietern |
| **Gemini** | ✅ | ✅ | — | ✅ | voreingestellte Liste |
| **Qwen** | ✅ | ✅ | — | ✅ | voreingestellte Liste |
| **Copilot** | ✅ | ✅ | — | ✅ | voreingestellte Liste |
| **Pi** | ✅ | ✅ | — | — | Konto-Standard / eigene |
| **Kimi** | ✅ | ✅ | — | — | kimi-k2.5 · 256K |
| **Reasonix** | ✅ | ✅ | — | — | deepseek-flash / reasoner |
| **Trae** | ✅ | ✅ | — | — | Konto-Standard (`/model` oder `trae_cli.yaml`) |
| **Antigravity** | ✅ | ✅ | ✅ | — | aktualisiert über `agy models` |
| **DeepSeek** 🆕 | ✅ | ✅ | — | — | Konto-Standard |

> **DeepSeek** ist DeepSeek Harness — `npm install -g @deepseek-ai/dsh`. Es wählt die Laufzeitform über ein Profil statt über ein Headless-Flag; myFlowForge steuert die `headless`-Variante, und die drei Berechtigungsstufen werden auf seine eigenen `read-only` / `workspace-write` / `danger-full-access` abgebildet. Gib ihm einen Schlüssel über `dsh web` (Seite „Models“) oder `DEEPSEEK_API_KEY`.
>
> **Trae** (ByteDances TraeCode CLI) wird nicht über npm ausgeliefert — sein offizielles `install.sh` legt `traecli` in `~/.local/bin` ab, achte also darauf, dass das in deinem PATH liegt. Für unbeaufsichtigte Änderungen innerhalb eines Workflows führe `traecli config edit` aus und setze `permission_mode: bypass_permissions`.

myFlowForge **speichert keine API-Schlüssel und leitet keine Anfragen weiter** — es steuert die CLIs, die auf deinem Rechner bereits installiert und angemeldet sind. Was fehlt, wird in den Einstellungen samt Installationshinweis markiert, und die Einstellungen sagen dir auch, wenn eine CLI installiert, aber nicht angemeldet ist.

## 🔧 Wie ein Lauf aufgebaut ist

```
   Du beschreibst das Ziel
            │
            ▼
  ┌─ Hook ─┐        ┌─ Hook ─┐                    ┌─ Hook ─┐
  │  vor   │        │  nach  │                    │  nach  │
  │  Lauf  │        │ Design │                    │  Lauf  │
  └───┬────┘        └───┬────┘                    └───┬────┘
      ▼                 ▼                             ▼
 📋 Anforderung → 🎨 Design → ✋ GATE → 💻 Entwickeln → 🧪 Test → 🔍 Review
   (klären)      (design.md)  du wählst  (auffächern) (prüfen) (Multi-Linse)
                      │                       │
                      │                       └─ ein Agent pro Projekt,
                      │                          parallele Spuren, eigener worktree
                      └─ ein echtes Dokument, das jeder nachgelagerte Agent ganz liest

 Jeder Pfeil wartet darauf, dass du „Weiter“ drückst. Stufen lassen sich hinzufügen,
 entfernen, umsortieren oder überspringen — nur Anforderung → Entwickeln zu fahren
 ist völlig in Ordnung.
```

Drei Wege, einen zu starten, alle münden im selben Gate:

1. Drück **Start** im Workflow-Panel.
2. Tipp `/` im Eingabefeld und wähl einen aus.
3. Beschreib eine vollständige Entwicklungsaufgabe in normaler Sprache — der Hauptagent erkennt sie und zieht über MCP ein Plan-Gate hoch. Fragen, Diskussionen und Einzeiler-Fixes lösen es nicht aus.

## 📱 Entfernte Hosts & der Handy-Client

Eine App, mehrere Rechner. Wähl den Host in der Statusleiste, und alles folgt ihm.

| | |
|---|---|
| **Direkt** | Gleiches LAN, direkt auf den Port des Daemons. Token-authentifiziert. |
| **SSH** | Nutzt einen SSH-Zugang, den du ohnehin hast — nichts Neues zu öffnen. |
| **Relay** | Für Rechner, die einander nicht sehen können. **Ende-zu-Ende-verschlüsselt**: frische Schlüssel pro Sitzung, das Relay leitet nur Geheimtext weiter, und ein unlesbarer Frame wird verworfen statt geglaubt. Betreib dein eigenes (`relay/`, Node oder ein Cloudflare Worker) — die Deployment-Schritte stehen in `relay/README.md`. |

**Der Linux-Daemon** ist dieselbe Codebasis ohne Fenster — installier das Tarball, lass es unter systemd laufen und koppel per Scan des QR-Codes, den es im Terminal ausgibt (`docs/linux-deploy.md`).

**Der Handy-Client** deckt die Teile ab, die du fern vom Schreibtisch wirklich brauchst: das laufende Gespräch mit gestreamtem Denken, Tool-Karten und Sub-Agenten-Karten; Berechtigungs- und Plan-Gates, die du beantworten kannst; geänderte Dateien und Diffs; das Anlegen von Arbeitsbereichen; die Workflow-Vorlagenbibliothek; Host-Wechsel und QR-Kopplung. Markdown, Tabellen und lokale Bilder werden nativ gerendert — entfernte Bildadressen bleiben bewusst Links, damit die Ausgabe eines Agenten dein Handy niemals in eine Tracking-Bake verwandeln kann.

## 🧩 Ebenfalls mit dabei

- **Import nativer Sitzungen** — schreibgeschütztes Einlesen deines lokalen Claude- / Codex- / Cursor- / qoder-Verlaufs; als Arbeitsbereich importieren und weitermachen.
- **MCP-Brücke** — ein eingebauter Forge-MCP-Server lässt Agenten in die App zurückrufen: `forge_ask`, `forge_propose_plan`, `forge_write_artifact`, `forge_handoff`, `forge_delegate`, `forge_read_context`, `forge_heartbeat`. Wird in die Agenten eingespeist, die MCP unterstützen; die übrigen fallen auf eine Textanweisung zurück.
- **MCP-Server & Add-ons** — sieh, welche MCP-Server jede CLI konfiguriert hat, autorisiere oder widerrufe sie aus der App heraus und stöbere in einem Skills-Markt, um Skills in die CLIs zu installieren, die sie lesen.
- **Gedächtnis** — Notizen pro Arbeitsbereich, die die Agenten wieder lesen können, damit langlaufende Arbeit ihren eigenen Faden behält.
- **Echtzeit-Beobachtbarkeit** — gestreamtes Denken / Tool-Aufrufe / Dateiänderungen / Rohausgabe, eine filterbare Log-Konsole, Laufhistorie und projektübergreifende Änderungsbelege.
- **Token-Verbrauch & Kontingent** — verbleibendes Kontingent und Zurücksetzzeiten pro Anbieter, dazu Ausgaben nach Arbeitsbereich × Agent × Tag.
- **Bot-Brücke** — Gates beantworten, Ergebnisse prüfen, ein Gespräch beginnen und Workflows steuern, von **DingTalk**, **Telegram** oder **Feishu** auf deinem Handy aus.
- **Berechtigungsmodi** — schreibgeschützt · Arbeitsbereich-automatisch (Standard) · Vollzugriff, pro Sitzung oder pro Stufe. Auf den echten Sandbox-Umfang jeder CLI abgebildet, und die Oberfläche sagt klar, welche Agenten ihn tatsächlich beachten.
- **Slash-Befehle, Skills & Plugins** — `/` bringt deine echten Befehle von der Platte und installierten Skills zum Vorschein, pro Agent gefiltert.
- **Eigene Workflows** — der Ablauf gehört dir zum Zusammensetzen: speichere so viele benannte Workflows, wie du magst, jeden mit eigenem Stufensatz; jede Stufe wählt ihren Agenten, ihr Modell, ihren Berechtigungsmodus, ihre Auffächerungsform, ob sie ein Gate setzt und ob sie ein Dokument erzeugen muss.
- **Eigene Stufen** — eine globale Bibliothek deiner eigenen Stufen, referenzierbar von jedem Workflow.
- **Dateibrowser & Diff** — Vollbild-Baum mit Änderungsmarkierungen, syntaxhervorgehobene Vorschau, Umschalter zwischen Diff und Volltext.
- **Eingebautes Terminal** — ein echtes pty mit Wurzel im Arbeitsbereich, mit Proxy- und Zeitzoneneinstellungen pro Anbieter. Mit einem entfernten Host verbunden, öffnet es eine Shell **auf jenem Rechner**.
- **Desktop-Haustier** — folgt deinem fokussierten Bildschirm, zeigt eine Vorschau der Agentenaktivität, lässt Bestätigungskarten aufpoppen; stöbere im Haustier-Markt oder bring deine eigenen Bilder mit.
- **Wachsendes Haustier** — das Desktop-Haustier wächst beim Arbeiten durch Stufen hindurch, sodass lange Sitzungen etwas Sichtbares hinterlassen.
- **Transparenz & Milchglas** — ein Unschärferegler führt das ganze Fenster von vollständig undurchsichtig durch drei native macOS-Vibrancy-Materialien, sodass dein Desktop durchscheint.
- **Personalisierung** — 6 eigene Skins, 12 Akzentfarben, eine Galerie mit über 300 Hintergrundbildern oder dein eigenes Bild, pixelgenaue Schriftgrößen für App und Chat unabhängig voneinander, hell und dunkel getrennt kontrastabgestimmt.
- **Vom Hintergrundbild getriebene Themen** — schalte es ein, und die gesamte Palette wird aus dem gewählten Hintergrundbild abgeleitet, hell oder dunkel entscheidet das Bild selbst. Das Hintergrundbild steuert immer nur zwei Farbtöne bei; jede Helligkeits- und Chroma-Stufe ist von den handabgestimmten Skins übernommen, damit ein unruhiges Bild keine unlesbare Oberfläche erzeugen kann. Lieber deine eigene Akzentfarbe? Wähl eine, und nur die Akzentfarbe hört auf zu folgen.
- **Bilder und eingebettete Grafiken im Chat** — ein Bild, das ein Agent auf der Platte erzeugt, wird in der Antwort gerendert, Klick für die volle Größe. Mitten in einer Antwort geschriebene HTML-Fragmente können als echte Karten, Tabellen und Diagramme gerendert werden (standardmäßig aus). Niemals `innerHTML` — das Fragment wird geparst und aus einer konstruktiven Positivliste neu aufgebaut, und Farben dürfen nur aus Theme-Tokens stammen, sodass gerenderte Inhalte deinem Skin folgen, statt gegen ihn zu arbeiten.

## 📥 Herunterladen & installieren

Hol dir den neuesten Build von der [**Releases**](https://github.com/flowForges/myFlowForge/releases)-Seite:

| Plattform | Datei |
|----------|------|
| macOS · Apple Silicon (M1–M4) | `myFlowForge-<version>-arm64.dmg` |
| macOS · Intel | `myFlowForge-<version>.dmg` |
| Windows · x64 | `myFlowForge-<version>-x64-setup.exe` |
| Android | `myFlowForge-<version>.apk` |
| Linux · Headless-Daemon | `myFlowForge-daemon-<version>-linux.tar.gz` |

> **Die App ist nicht code-signiert.** Unter macOS meldet der erste Start eventuell, sie *„kann nicht geöffnet werden“* oder *„ist beschädigt“* — so sieht eine unsignierte App aus, die Datei ist in Ordnung. Entweder **Rechtsklick** → **Öffnen** → **Öffnen**, oder einmalig ausführen:
> `xattr -dr com.apple.quarantine /Applications/myFlowForge.app`
> Windows SmartScreen will **Weitere Informationen → Trotzdem ausführen**.
>
> myFlowForge prüft denselben Releases-Feed und bietet neuere Versionen direkt in der App an.

**iOS** wird nicht als Download verteilt — bau es aus `mobile/` mit deiner eigenen Apple ID und installiere es per Kabel auf dein Gerät.

## 🚀 Erste Schritte

**Voraussetzungen:** macOS 11+ / Windows 10+ / ein modernes Linux, Node.js ≥ 20, git und mindestens eine unterstützte Coding-CLI, installiert und angemeldet.

```bash
git clone https://github.com/flowForges/myFlowForge.git
cd myFlowForge
npm install
npm run dev          # Entwicklungsmodus mit Hot Reload des Renderers
```

| Befehl | Was er tut |
|---------|--------------|
| `npm run dev` | Startet mit Hot Reload |
| `npm test` | Führt die komplette Testsuite aus (Vitest) |
| `npm run typecheck` | Typprüfung für beide tsconfigs, main & renderer |
| `npm run build` | Baut das Produktions-Bundle |
| `npm run dist:mac-all` | Baut die `.dmg`s für Intel und Apple Silicon |
| `npm run dist:win` | Baut den Windows-x64-Installer |
| `npm run check:daemon` | Testet den Headless-Daemon von Anfang bis Ende durch |

Der Handy-Client liegt in `mobile/` (Expo / React Native) und das Relay in `relay/`; beide haben ihre eigene `package.json`.

Artefakte landen in `release/`. Änderungen unter `src/main/**` brauchen einen **vollständigen Electron-Neustart** — Hot Reload aktualisiert nur den Renderer.

## 🏗️ Technik-Stack

**Hülle:** [Electron](https://www.electronjs.org/) 42 + [electron-vite](https://electron-vite.org/) · **UI:** [React](https://react.dev/) 19 + TypeScript 6 · **Handy:** [Expo](https://expo.dev/) + [React Native](https://reactnative.dev/) · **Terminal:** [xterm.js](https://xtermjs.org/) + [node-pty](https://github.com/microsoft/node-pty) · **Agenten-Brücke:** [Model Context Protocol SDK](https://modelcontextprotocol.io/) · **Prozesssteuerung:** [execa](https://github.com/sindresorhus/execa) · **Validierung:** [zod](https://zod.dev/) · **Dateiüberwachung:** [chokidar](https://github.com/paulmillr/chokidar) · **Tests:** [Vitest](https://vitest.dev/) + Testing Library · **Paketierung:** [electron-builder](https://www.electron.build/)

## 📁 Projektstruktur

```
src/
├── main/              # Electron-Hauptprozess
│   ├── agents/        # CLI-Adapter + Provider-Registry, Erkennung, Berechtigungen
│   ├── run/           # Workflow-Engine: Stufen, Gates, Auffächern, Hooks, Übergaben
│   ├── chat/          # Chat pro Arbeitsbereich, Warteschlange, Gedächtnis
│   ├── mcp/           # Forge-MCP-Server (Brücke Agent → App)
│   ├── remote/        # Entfernte Hosts: direkt / SSH / Relay, Routing, E2E-Kanal
│   ├── daemon/        # Headless-Daemon + QR-Kopplung im Terminal
│   ├── bot/           # Bot-Brücke (Transporte DingTalk / Telegram / Feishu)
│   ├── plugins/       # Plugin-Host, Katalog, Scheduler, Erweiterungspunkte
│   ├── sessionImport/ # Einlesen & Import nativer Sitzungen
│   ├── usage/         # Kontingent-Adapter der Anbieter
│   ├── pet/           # Fenster des Desktop-Haustiers
│   └── ...            # git, fs, Terminal, Update, Watcher, Fenster, Erscheinungsbild
├── renderer/          # React-UI (Views, Komponenten, Einstellungen, Theme, Haustier)
├── preload/           # Kontextisolierte IPC-Brücke
└── shared/            # Typen & reine Logik, von allen Prozessen geteilt
mobile/                # iOS- & Android-Client (Expo / React Native)
relay/                 # Ende-zu-Ende-verschlüsseltes Relay (Node oder Cloudflare Worker)
```

## 🤝 Mitwirken

Issues und PRs sind willkommen. Das Projekt ist **testgetrieben** — bitte ergänze oder aktualisiere Tests zu deinen Änderungen und stell sicher, dass `npm test` und `npm run typecheck` durchlaufen, bevor du einen PR aufmachst.

## 📄 Lizenz

Veröffentlicht unter der [MIT-Lizenz](LICENSE) © 2026 zghua.

## 🙏 Danksagungen

Gebaut auf dem Open-Source-Ökosystem rund um Electron, React, Vite und das Model Context Protocol — und auf den Coding-Agenten, die es orchestriert.

## 🔗 Links

- [LINUX DO](https://linux.do/latest) — eine Community von Entwicklern, die gern basteln
