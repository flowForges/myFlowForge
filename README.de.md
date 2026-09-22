<div align="center">

<img src="build/icon.png" alt="myFlowForge" width="128" height="128" />

# myFlowForge

**Eine GUI für native Agents wie Claude Code, Codex und Cursor: zentral verwalten, geräteübergreifend verbinden.**

myFlowForge ruft direkt die auf dem Rechner installierten offiziellen CLIs auf (Claude Code, Codex, Cursor, Gemini, qoder, opencode, DeepSeek u. a.). Die Agents selbst werden weder verändert noch ersetzt; myFlowForge stellt lediglich eine einheitliche GUI darüber bereit. Unterstützt werden der Wechsel von Agent und Modell innerhalb einer Sitzung, der Import nativer Sitzungen, die Ausführung stufenbasierter Workflows sowie die nativen Begleiter von Codex. Der Zugriff ist auch aus der Ferne von einem anderen Computer, einem Server oder einem Smartphone möglich.

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

<img src="assets/screenshots/home.jpg" alt="Startseite: Arbeitsbereiche, laufende Agents und Änderungen des Tages" width="90%" />

<sub><b>Startseite</b>: Arbeitsbereiche, laufende Agents und Änderungen des Tages. Hintergrundbild, Design und Akzentfarbe sind frei anpassbar.</sub>

</div>

---

## Überblick

Die verschiedenen KI-Coding-CLIs laufen jeweils in einem eigenen Terminal. Sitzungen, Kontingente und Konfigurationen sind voneinander getrennt, und eine Aufgabe ist oft an ein einzelnes Werkzeug gebunden.

myFlowForge versteht sich als GUI-Schicht über diesen CLIs und folgt drei Grundsätzen:

- **Native Anbindung**: Agents werden über ihre offiziellen CLIs aufgerufen, mit Ihrem eigenen Konto, Abonnement und Ihrer lokalen Konfiguration. Kein Fork und keine Änderung der Agents, keine gespeicherten API-Schlüssel, keine weitergeleiteten Anfragen. Nach einem Update eines Agents stehen neue Funktionen sofort zur Verfügung.
- **Zentrale Verwaltung**: Mehrere Agents, Projekte und Sitzungen werden in einer Oberfläche verwaltet; Aufgaben sind nicht mehr an ein einzelnes Werkzeug gebunden.
- **Geräteübergreifende Verbindung**: Desktop-Anwendung, Headless-Linux-Daemon und die iOS-/Android-Clients teilen sich dieselben Arbeitsbereiche und Sitzungen, per direkter LAN-Verbindung, SSH oder Ende-zu-Ende-verschlüsseltem Relay.

> **Projektstatus:** Von einer Einzelperson gepflegt und aktiv in Entwicklung. Installationspakete stehen für macOS, Windows und Linux bereit, dazu ein Android-APK und iOS über TestFlight. Das macOS-Paket ist mit einer Developer ID signiert und von Apple notariell beglaubigt, das Android-Paket ist mit einem Produktionsschlüssel signiert, das Windows-Paket ist derzeit noch nicht signiert.

## Kernfunktionen

### 1. Native Agent-Anbindung

Unterstützt werden 14 Coding-CLIs: **Claude Code · Codex · Cursor · Gemini · qoder · opencode · Qwen · Copilot · Pi · Kimi · Reasonix · Trae · Antigravity · DeepSeek**.

myFlowForge steuert die auf dem Rechner installierten und angemeldeten offiziellen CLIs, ohne deren Verhalten zu verändern. Die Modellliste wird vorrangig aus der lokalen Konfiguration der jeweiligen CLI gelesen, andernfalls wird eine vordefinierte Liste verwendet; Modelle können auch manuell hinzugefügt werden und werden dann beim Aktualisieren nicht überschrieben. Nicht installierte oder nicht angemeldete CLIs werden in den Einstellungen gekennzeichnet, zusammen mit einer Installationsanleitung.

### 2. Agent und Modell innerhalb einer Sitzung wechseln

Agent, Modell und Berechtigungsstufe lassen sich vor jeder Gesprächsrunde neu wählen, der Kontext bleibt dabei erhalten:

- Liefert ein Modell schlechte Ergebnisse, kann mit einem anderen Modell weitergearbeitet werden, das den gesamten bisherigen Verlauf sieht;
- ist das Kontingent eines Anbieters erschöpft, kann zu einem anderen gewechselt werden, ohne eine neue Sitzung zu öffnen;
- Modelle können nach Art der Aufgabe zugeteilt werden, etwa ein leistungsfähigeres Modell für den Entwurf und ein günstigeres für Umsetzung und Abschluss.

Agents mit nativer Fortsetzung (Claude Code, Codex, Cursor, qoder, opencode, Antigravity) nutzen ihren eigenen Sitzungsverlauf; für die übrigen rekonstruiert myFlowForge den Kontext.

### 3. Geräteübergreifende Verbindung

- **Entfernte Hosts**: Die Desktop-Anwendung kann sich mit einem anderen Computer oder Server verbinden und dort Agents, Repositories und Terminals steuern. Der aktive Host wird in der Statusleiste gewählt; Arbeitsbereiche, Sitzungen, git-Änderungen und das integrierte Terminal wechseln entsprechend mit.
- **Drei Verbindungsarten**: direkte LAN-Verbindung, SSH, Ende-zu-Ende-verschlüsseltes Relay. Das Relay leitet nur verschlüsselte Daten weiter und kann Sitzungsinhalte nicht lesen; es lässt sich selbst betreiben (Node oder Cloudflare Worker).
- **Headless-Daemon**: Auf einem Linux-Server läuft `myflowforge-daemon`; der Befehl `pair` gibt im Terminal einen QR-Code zur Kopplung aus.
- **Mobil**: Die iOS- und Android-Clients ermöglichen es, Gespräche in Echtzeit zu verfolgen, Berechtigungsanfragen und Entwurfsfreigaben zu bearbeiten, Änderungen und Diffs einzusehen, Arbeitsbereiche anzulegen, Workflows zu bearbeiten und den Host zu wechseln.
- **Geräteautorisierung**: Jedes Gerät verwendet einen eigenen Kopplungscode und kann jederzeit einzeln entfernt werden; der Widerruf wirkt sofort.

### 4. Import nativer Sitzungen

Die lokalen Sitzungsverläufe von Claude Code, Codex, Cursor und qoder werden schreibgeschützt eingelesen und als Arbeitsbereiche importiert, in denen das Gespräch direkt fortgesetzt werden kann. Die ursprünglichen Daten bleiben unberührt.

### 5. Stufenbasierte Workflows

Neben dem normalen Gespräch lässt sich eine Aufgabe auch in Stufen ausführen. Nach dem Start eines Workflows wechselt das Gespräch in den Stufenmodus:

- Oben werden der Fortschritt (Schritt N von M), die aktuelle Stufe und der zuständige Agent angezeigt;
- der Agent der Stufe arbeitet im aktuellen Gespräch, Ausgaben, Werkzeugaufrufe und Dateiänderungen sind durchgehend sichtbar;
- nach Abschluss jeder Stufe wird erst nach Bestätigung mit „Weiter“ an die nächste Stufe übergeben; Rückfragen und Korrekturen lösen keinen erneuten Durchlauf aus;
- die Entwurfsstufe erzeugt ein vollständiges Markdown-Dokument (`forge-docs/design.md`), das allen nachgelagerten Agents als gemeinsamer Vertrag dient;
- Stufen mit Freigabe bieten **Genehmigen**, **Zurückweisen** (Überarbeitung mit Anmerkungen) oder **Nachfragen**; außerdem kann zu einer früheren Stufe zurückgekehrt werden.

Agent, Modell und Berechtigungsstufe lassen sich für jede Stufe einzeln festlegen. Workflows und Stufen sind anpassbar und können zur Wiederverwendung gespeichert werden.

### 6. Mehrere Projekte parallel

Ein Arbeitsbereich kann mehrere Repositories enthalten. Eine Stufe kann **pro Projekt aufgefächert** werden: Frontend, Backend und SDK werden von jeweils eigenen Agents in separaten git worktrees parallel entwickelt, und alle Änderungen laufen in einem gemeinsamen Änderungsbereich zur Prüfung zusammen. Die Auffächerung kann auf einen Teil der Repositories beschränkt werden.

### 7. Stufen-Hooks

Ein Hook ist ein Hilfsschritt zwischen den Stufen. Er kann **vor dem Lauf**, **nach einer bestimmten Stufe** oder **nach dem Lauf** eingehängt werden und dient etwa dazu, Code abzurufen, Dokumentation zu synchronisieren, Lint auszuführen, ein Board zu aktualisieren oder Benachrichtigungen zu senden.

Jeder Hook läuft als eingeschränkter Sub-Agent im Stammverzeichnis des Arbeitsbereichs und kann nur die ihm zugewiesenen Skills und Werkzeuge verwenden. Schlägt die Ausführung fehl, wird die Pipeline angehalten, und es kann zwischen Wiederholen, Überspringen und Abbrechen gewählt werden. Hooks werden in einer globalen Bibliothek gespeichert und lassen sich in jedem Workflow wiederverwenden.

### 8. Desktop-Begleiter

Der Desktop-Begleiter folgt dem aktiven Bildschirm, zeigt den Laufzustand der Agents in Echtzeit an und kann Bestätigungskarten direkt einblenden. **Er ist mit den nativen Begleitern von Codex kompatibel**, die sich über den Marktplatz codex-pets.net installieren lassen; eigene Bilder werden ebenfalls unterstützt. Zusätzlich gibt es einen wachsenden Begleiter, der sich mit zunehmender Nutzungsdauer schrittweise weiterentwickelt.

---

<div align="center">

<img src="assets/screenshots/workflow.jpg" alt="Stufenplanung: Agent und Modell für jede Stufe einzeln gewählt, Entwicklungsstufe auf zwei Projekte aufgefächert" width="90%" />

<sub><b>Stufenplanung</b>: Für jede der fünf Stufen sind Agent und Modell festgelegt, die <i>Entwicklungsstufe</i> ist auf zwei Repositories aufgefächert.</sub>

</div>

---

## Unterstützte Agents

| Agent | Gespräch | Workflow | Native Fortsetzung | MCP | Modelle |
|------|:----:|:------:|:--------:|:---:|------|
| **Claude Code** | ✅ | ✅ | ✅ | ✅ | Aus der CLI gelesen |
| **Codex** | ✅ | ✅ | ✅ | ✅ | Aus der CLI gelesen |
| **Cursor** | ✅ | ✅ | ✅ | ✅ | Aus der CLI gelesen |
| **qoder** | ✅ | ✅ | ✅ | ✅ | Gelesen + benutzerdefiniert |
| **opencode** | ✅ | ✅ | ✅ | ✅ | Gateway für mehrere Anbieter |
| **Gemini** | ✅ | ✅ | — | ✅ | Vorgegebene Liste |
| **Qwen** | ✅ | ✅ | — | ✅ | Vorgegebene Liste |
| **Copilot** | ✅ | ✅ | — | ✅ | Vorgegebene Liste |
| **Pi** | ✅ | ✅ | — | — | Kontostandard / benutzerdefiniert |
| **Kimi** | ✅ | ✅ | — | — | kimi-k2.5 · 256K |
| **Reasonix** | ✅ | ✅ | — | — | deepseek-flash / reasoner |
| **Trae** | ✅ | ✅ | — | — | Kontostandard (`/model` oder `trae_cli.yaml`) |
| **Antigravity** | ✅ | ✅ | ✅ | — | Aktualisiert über `agy models` |
| **DeepSeek** | ✅ | ✅ | — | — | Kontostandard |

> **DeepSeek** bezeichnet DeepSeek Harness (`npm install -g @deepseek-ai/dsh`). myFlowForge verwendet dessen Profil `headless`; die drei Berechtigungsstufen entsprechen `read-only` / `workspace-write` / `danger-full-access`. Der API-Schlüssel lässt sich über `dsh web` (Seite Models) oder die Umgebungsvariable `DEEPSEEK_API_KEY` konfigurieren.
>
> **Trae** (TraeCode CLI von ByteDance) wird nicht über npm veröffentlicht. Es muss über das offizielle `install.sh` nach `~/.local/bin` installiert und dem PATH hinzugefügt werden. Sollen in einem Workflow Dateien unbeaufsichtigt geändert werden, führen Sie `traecli config edit` aus und setzen Sie `permission_mode: bypass_permissions`.

## Ablauf eines Workflows

```
  Ziel beschreiben
        │
        ▼
  ┌─── hook ───┐ ┌─── hook ───┐                                   ┌─── hook ───┐
  │ vor dem    │ │ nach dem   │                                   │ nach dem   │
  │ Lauf       │ │ Entwurf    │                                   │ Lauf       │
  └─────┬──────┘ └─────┬──────┘                                   └─────┬──────┘
        ▼              ▼                                                ▼
   Anforderung ──→ Entwurf ──→ Freigabe ──→ Entwicklung ──→ Test ──→ Review
    (klären)     (design.md)   (manuell)   (pro Projekt)  (prüfen) (mehrere Sichten)
                      │                          │
                      │                          └─ ein Agent pro Projekt,
                      │                             parallel, eigener Worktree
                      └─ vollständiges Dokument, alle nachgelagerten Agents lesen es ganz

 Zwischen allen Stufen ist jeweils eine Bestätigung mit „Weiter“ erforderlich.
 Stufen können hinzugefügt, entfernt, umgeordnet oder übersprungen werden,
 etwa um nur „Anforderung → Entwicklung“ auszuführen.
```

Ein Workflow lässt sich auf drei Arten starten:

1. im Workflow-Bereich auf **Starten** klicken;
2. im Eingabefeld `/` eingeben und einen Workflow auswählen;
3. die Entwicklungsaufgabe direkt in natürlicher Sprache beschreiben: Der Haupt-Agent erkennt sie und stößt über MCP eine Entwurfsfreigabe an. Allgemeine Fragen, Diskussionen und kleine Änderungen lösen keinen Workflow aus.

## Entfernte Hosts und Mobilgeräte

| Art | Beschreibung |
|---|---|
| **Direkt** | Direkte Verbindung zum Daemon-Port im selben LAN, Authentifizierung per Token. |
| **SSH** | Nutzt eine vorhandene SSH-Anmeldung, ohne zusätzliche Ports zu öffnen. |
| **Relay** | Für Fälle, in denen zwei Rechner nicht direkt miteinander kommunizieren können. **Ende-zu-Ende-verschlüsselt**: Für jede Sitzung wird ein neuer Schlüssel ausgehandelt, das Relay leitet nur verschlüsselte Daten weiter, und nicht entschlüsselbare Frames werden grundsätzlich verworfen. Es lässt sich selbst betreiben (`relay/`, unterstützt Node und Cloudflare Worker); die Schritte beschreibt `relay/README.md`. |

Der **Linux-Daemon** basiert auf demselben Code wie die Desktop-Anwendung, jedoch ohne den Fensterteil. Nach der Installation des tar.gz-Archivs läuft er unter systemd; die Kopplung erfolgt durch Scannen des im Terminal ausgegebenen QR-Codes (siehe `docs/linux-deploy.md`).

Der **mobile Client** deckt die üblichen Aufgaben ab, wenn Sie nicht am Rechner sind: Echtzeit-Gespräch (einschließlich Denkprozess, Werkzeugaufrufen und Sub-Agent-Karten), Berechtigungsanfragen und Entwurfsfreigaben, geänderte Dateien und Diffs, Anlegen von Arbeitsbereichen, Workflow-Vorlagen, Hostwechsel und Kopplung per QR-Code. Markdown, Tabellen und lokale Bilder werden nativ dargestellt; aus Datenschutzgründen bleiben entfernte Bildadressen als Links erhalten und werden nicht automatisch geladen.

## Weitere Funktionen

- **MCP-Brücke**: Ein integrierter Forge-MCP-Server ermöglicht Agents Rückrufe an die Anwendung: `forge_ask`, `forge_propose_plan`, `forge_write_artifact`, `forge_handoff`, `forge_delegate`, `forge_read_context`, `forge_heartbeat`. Bei MCP-fähigen Agents wird er automatisch eingebunden, bei den übrigen wird auf Textanweisungen zurückgegriffen.
- **MCP-Server und Skill-Marktplatz**: Anzeige der in den einzelnen CLIs konfigurierten MCP-Server und Autorisierung direkt in der Anwendung; Installation von Skills für die jeweilige CLI aus dem Skill-Marktplatz.
- **Gedächtnis**: Notizen pro Arbeitsbereich, die von Agents gelesen werden können, damit bei langfristigen Aufgaben der Kontext erhalten bleibt.
- **Laufbeobachtung**: Fortlaufende Anzeige von Denkprozess, Werkzeugaufrufen, Dateiänderungen und Rohausgabe, mit filterbaren Protokollen, Laufverlauf und projektübergreifendem Änderungsverlauf.
- **Kontingente und Nutzung**: Verbleibendes Kontingent und Rücksetzzeitpunkt je Anbieter sowie Nutzungsstatistiken nach Arbeitsbereich, Agent und Datum.
- **Bot-Brücke**: Freigaben bearbeiten, Ergebnisse einsehen, Gespräche beginnen und Workflows steuern aus DingTalk, Telegram oder Feishu.
- **Berechtigungsstufen**: Schreibgeschützte Prüfung, automatisch (Arbeitsbereich, Standard) und Vollzugriff, einstellbar pro Sitzung oder pro Stufe und abgebildet auf den tatsächlichen Sandbox-Umfang der jeweiligen CLI.
- **Slash-Befehle und Skills**: Die Eingabe von `/` listet die tatsächlich auf dem Rechner vorhandenen Befehle und installierten Skills auf, gefiltert nach Agent.
- **Dateibrowser und Diffs**: Vollbild-Dateibaum mit Änderungsmarkierungen, Vorschau mit Syntaxhervorhebung, Umschalten zwischen Diff und Volltext.
- **Integriertes Terminal**: Echtes pty mit dem Arbeitsbereich als Stammverzeichnis, Proxy und Zeitzone pro Provider konfigurierbar; bei Verbindung mit einem entfernten Host läuft das Terminal auf dem entfernten Rechner.
- **Erscheinungsbild**: 6 eigene Designs, 12 Akzentfarben und über 300 Hintergrundbilder, eigene Bilder werden unterstützt; Schriftgrößen für Anwendung und Gesprächsbereich getrennt einstellbar; automatische Farbschemata auf Basis des Hintergrundbilds; Unterstützung des nativen macOS-Milchglasmaterials.
- **Bilder und Visualisierungen im Gespräch**: Von Agents erzeugte lokale Bilder werden direkt in der Antwort angezeigt; HTML-Fragmente in Antworten können als Karten, Tabellen und Diagramme dargestellt werden (standardmäßig deaktiviert, per Whitelist neu aufgebaut, ohne `innerHTML`).

## Download und Installation

Laden Sie die neueste Version von der Seite [**Releases**](https://github.com/flowForges/myFlowForge/releases) herunter:

| Plattform | Datei |
|------|------|
| macOS · Apple Silicon (M1–M4) | `myFlowForge-<Version>-arm64.dmg` |
| macOS · Intel | `myFlowForge-<Version>.dmg` |
| Windows · x64 | `myFlowForge-<Version>-x64-setup.exe` |
| Windows · ARM | `myFlowForge-<Version>-arm64-setup.exe` |
| Android | `myFlowForge-<Version>.apk` |
| Linux · Headless-Daemon | `myFlowForge-daemon-<Version>-linux.tar.gz` |
| iOS | TestFlight (nur auf Einladung) |

> Das **macOS**-Installationspaket ist signiert und notariell beglaubigt und kann direkt installiert werden.
> Das **Windows**-Installationspaket ist derzeit nicht signiert; wählen Sie bei der SmartScreen-Warnung „Weitere Informationen → Trotzdem ausführen“.
>
> Die Anwendung prüft selbst auf Updates und weist in der Anwendung auf neue Versionen hin, sobald diese veröffentlicht sind.

**iOS** wird derzeit über TestFlight verteilt (nur auf Einladung); alternativ kann die App im Verzeichnis `mobile/` mit Ihrer eigenen Apple-ID gebaut und installiert werden.

## Schnellstart

**Voraussetzungen:** macOS 11+ / Windows 10+ / eine gängige Linux-Distribution, Node.js ≥ 20, git sowie mindestens eine installierte und angemeldete Coding-CLI.

```bash
git clone https://github.com/flowForges/myFlowForge.git
cd myFlowForge
npm install
npm run dev          # Entwicklungsmodus, Hot Reload für die Renderer-Schicht
```

| Befehl | Beschreibung |
|------|------|
| `npm run dev` | Startet im Entwicklungsmodus (Hot Reload) |
| `npm test` | Führt die vollständige Testsuite aus (Vitest) |
| `npm run typecheck` | Prüft beide tsconfigs für Hauptprozess und Renderer |
| `npm run build` | Produktions-Build |
| `npm run dist:mac-all` | Erstellt `.dmg` für Intel und Apple Silicon |
| `npm run dist:win` | Erstellt das Windows-x64-Installationsprogramm |
| `npm run check:daemon` | Prüft den Headless-Daemon Ende-zu-Ende |

Der mobile Client liegt in `mobile/` (Expo / React Native), der Relay-Dienst in `relay/`, jeweils mit eigenem `package.json`.

Build-Artefakte werden nach `release/` ausgegeben. Nach Änderungen an `src/main/**` muss Electron vollständig neu gestartet werden; Hot Reload wirkt nur auf die Renderer-Schicht.

## Technologie-Stack

| Kategorie | Technologie |
|------|------|
| Desktop-Hülle | [Electron](https://www.electronjs.org/) 42 · [electron-vite](https://electron-vite.org/) |
| Oberfläche | [React](https://react.dev/) 19 · TypeScript 6 |
| Mobil | [Expo](https://expo.dev/) · [React Native](https://reactnative.dev/) |
| Terminal | [xterm.js](https://xtermjs.org/) · [node-pty](https://github.com/microsoft/node-pty) |
| Agent-Brücke | [Model Context Protocol SDK](https://modelcontextprotocol.io/) |
| Prozesssteuerung | [execa](https://github.com/sindresorhus/execa) |
| Datenvalidierung | [zod](https://zod.dev/) |
| Dateiüberwachung | [chokidar](https://github.com/paulmillr/chokidar) |
| Tests | [Vitest](https://vitest.dev/) · Testing Library |
| Paketierung | [electron-builder](https://www.electron.build/) |

## Projektstruktur

```
src/
├── main/              # Electron-Hauptprozess
│   ├── agents/        # CLI-Adapter, Provider-Registry, Erkennung und Berechtigungen
│   ├── run/           # Workflow-Engine: Stufen, Freigaben, Auffächerung, Hooks, Übergabe
│   ├── chat/          # Arbeitsbereichsgespräche, Warteschlange und Gedächtnis
│   ├── mcp/           # Forge-MCP-Server (Brücke Agent → Anwendung)
│   ├── remote/        # Entfernte Hosts: direkt / SSH / Relay, Routing, Ende-zu-Ende-verschlüsselter Kanal
│   ├── daemon/        # Headless-Daemon und Kopplung per QR-Code im Terminal
│   ├── bot/           # Bot-Brücke (DingTalk / Telegram / Feishu)
│   ├── plugins/       # Plugin-Host, Katalog, Planung und Erweiterungspunkte
│   ├── sessionImport/ # Einlesen und Import nativer Sitzungen
│   ├── usage/         # Kontingent-Adapter je Anbieter
│   ├── pet/           # Fenster des Desktop-Begleiters
│   └── ...            # git, Dateisystem, Terminal, Updates, Überwachung, Fenster, Erscheinungsbild
├── renderer/          # React-Oberfläche (Ansichten, Komponenten, Einstellungen, Designs, Begleiter)
├── preload/           # IPC-Brücke mit Kontextisolation
└── shared/            # Prozessübergreifend geteilte Typen und reine Logik
mobile/                # iOS- und Android-Clients (Expo / React Native)
relay/                 # Ende-zu-Ende-verschlüsseltes Relay (Node oder Cloudflare Worker)
```

## Mitwirken

Issues und PRs sind willkommen. Das Projekt folgt testgetriebener Entwicklung: Bitte fügen Sie mit jeder Änderung passende Tests hinzu oder aktualisieren Sie diese, und stellen Sie sicher, dass `npm test` und `npm run typecheck` erfolgreich durchlaufen.

## Lizenz

[MIT License](LICENSE) © 2026 zghua

## Danksagung

Dank an Open-Source-Projekte wie Electron, React, Vite und Model Context Protocol sowie an die verschiedenen Coding-Agents, die in dieses Projekt eingebunden sind.

## Links

- [LINUX DO](https://linux.do/latest): Entwickler-Community
- [V2EX](https://www.v2ex.com/): Community für Kreativschaffende
