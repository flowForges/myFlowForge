<div align="center">

<img src="build/icon.png" alt="myFlowForge" width="128" height="128" />

# myFlowForge

**Forgez votre workflow de développement assisté par IA.**

Un cockpit de bureau qui orchestre **Claude Code, Codex, Cursor, Gemini, qoder et opencode** dans un pipeline de développement unique, gouverné et multi‑étapes — avec des points de validation de plan, l'import de sessions natives, le suivi en temps réel de la consommation, l'intégration MCP et un animal de compagnie de bureau pour vous tenir compagnie.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-macOS-000000?logo=apple&logoColor=white)

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · **Français** · [Deutsch](README.de.md)

</div>

---

## Qu'est‑ce que myFlowForge ?

Les outils de développement assistés par IA modernes vivent chacun dans leur propre terminal, avec leur propre état de session, leur propre quota, et aucun plan partagé. **myFlowForge** les réunit tous sous un même toit et transforme le fait de « discuter avec une IA » en un **workflow d'ingénierie reproductible et révisable**.

Vous décrivez ce que vous voulez. Forge pilote les agents que vous avez choisis à travers un pipeline par étapes — **Exigence → Conception → Développement → Test → Revue** — en marquant une pause à un **point de validation strict** afin que vous puissiez approuver le plan technique *avant* qu'une seule ligne de code ne soit écrite. Chaque étape peut exécuter un agent et un modèle différents, en parallèle sur plusieurs projets, tandis qu'un sympathique animal de compagnie de bureau vous montre d'un coup d'œil ce qui se passe.

> ⚠️ **Statut du projet :** myFlowForge est un projet personnel en développement actif. Il cible actuellement **macOS** (Apple Silicon et Intel). Étant basé sur Electron, il peut être compilé pour d'autres plateformes à partir des sources, mais seul macOS est empaqueté aujourd'hui.

## ✨ Points forts

- **🎛️ Orchestration multi‑agents** — Routez chaque étape du workflow vers un CLI de développement différent (Claude Code, Codex, Cursor, Gemini, qoder, opencode) et un modèle différent. **opencode** est lui‑même une passerelle multi‑fournisseurs — connectez‑le une seule fois pour atteindre de nombreux éditeurs de modèles.
- **📂 Ouvrir dans votre éditeur** — Un bouton « Ouvrir l'emplacement » dans la barre de titre détecte les éditeurs installés (VS Code, Cursor, JetBrains, Zed, Finder, terminaux…) et ouvre l'espace de travail actuel — ou le fichier que vous prévisualisez — dans celui de votre choix, mémorisé comme valeur par défaut.
- **⌨️ Commandes slash dans le chat** — Tapez `/` dans le chat pour afficher un menu de déclencheurs de workflow ainsi que vos **véritables commandes/prompts présents sur le disque et vos skills installées**, filtrés par agent.
- **🔄 Pipeline multi‑étapes gouverné** — Exigence → Conception → Développement → Test → Revue, avec un **point de validation strict du plan** : révisez et approuvez (ou rejetez) la conception technique avant que l'exécution ne commence.
- **✂️ Exécution sélective et économe en tokens** — Un workflow configuré ne force plus chaque tâche à passer par toutes les étapes de tous les projets. Décrivez une petite tâche en langage naturel et l'agent orchestrateur propose un **plan allégé** — n'exécutez que les étapes dont vous avez besoin (par exemple, sautez Test/Revue) et limitez la portée de chaque étape à un sous‑ensemble de projets (par exemple, analysez les cinq, mais n'écrivez du code que dans deux). La carte d'approbation montre exactement ce qui sera exécuté avant que vous ne confirmiez.
- **🧭 Orchestrateur, pas exécutant** — L'agent de chat principal n'écrit jamais de code et ne crée jamais ses propres sous‑agents internes ; il se contente de décomposer les tâches et de déléguer chaque étape concrète aux véritables sous‑agents orchestrés de Forge.
- **🧩 Projets et espaces de travail parallèles** — Exécutez plusieurs espaces de travail simultanément, chacun avec des worktrees git isolés ; observez plusieurs agents travailler côte à côte dans des couloirs parallèles.
- **📥 Import de sessions natives** — Analysez en lecture seule et importez vos sessions locales existantes Claude / Codex / Cursor / qoder dans un index central, puis reprenez‑les sous forme d'espaces de travail.
- **📊 Suivi en temps réel de la consommation et des quotas** — De véritables adaptateurs de consommation font apparaître le quota restant et les horaires de réinitialisation de chaque fournisseur.
- **🔌 Intégration MCP** — Un serveur Forge MCP intégré relie les agents à l'application (poser des questions, proposer des plans, transmettre des artefacts) pour un contrôle fiable, piloté par des outils.
- **🖥️ Observabilité en temps réel** — Journaux en streaming de réflexion / exécution / modifications de fichiers / sortie, une console de logs filtrable et des preuves de changements inter‑projets.
- **🐾 Animal de compagnie de bureau** — Un compagnon déplaçable et redimensionnable qui suit votre focus, prévisualise l'activité des agents et affiche des cartes de confirmation — avec des effets configurables et plusieurs packs d'animaux.
- **🎨 Interface soignée et personnalisable** — Glassmorphisme, **6 thèmes** (clair / sombre / auto + midnight / sepia / forest), **12 couleurs d'accentuation**, une **image de fond personnalisée** (application entière ou zone de chat, avec opacité ajustable), un tableau de bord d'accueil repensé avec un message de bienvenue affichant l'heure locale en direct, des panneaux redimensionnables et un centre de notifications.

## 🤖 Agents de développement pris en charge

| Agent | Chat | Exécution de workflow | Reprise native | Modèles | MCP |
|-------|:----:|:------------:|:-------------:|:------:|:---:|
| **Claude Code** | ✅ | ✅ | ✅ | dynamique | ✅ |
| **Codex** | ✅ | ✅ | ✅ | dynamique | ✅ |
| **Cursor** | ✅ | ✅ | ✅ | dynamique | — |
| **Gemini** | ✅ | ✅ | — | dynamique | — |
| **qoder** | ✅ | ✅ | ✅ | dynamique | ✅ |
| **opencode** | ✅ | ✅ | ✅ | dynamique (multi‑fournisseurs) | — |

> Les modèles sont découverts à partir de la configuration locale réelle de chaque CLI — rien n'est codé en dur, et vous pouvez modifier la liste des modèles par fournisseur. **opencode** découvre ses modèles via `opencode models`, de sorte qu'une seule intégration intègre tous les fournisseurs que vous y avez configurés.

## 🔧 Comment ça marche

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

Trois façons de déclencher un workflow, convergeant toutes vers le même point de validation unique :

1. L'agent de chat principal détecte l'intention et appelle l'outil MCP **`forge_propose_plan`**.
2. Une directive délimitée pilotée par une skill, comme solution de repli.
3. Le bouton explicite **« Démarrer le workflow »**.

## 📥 Téléchargement et installation

Récupérez le dernier `.dmg` depuis la page [**Releases**](https://github.com/flowForges/myFlowForge/releases) :

| Votre Mac | Téléchargement recommandé |
|----------|----------------------|
| Apple Silicon (M1/M2/M3/M4) | `myFlowForge-<version>-arm64.dmg` ou la version universelle |
| Intel | `myFlowForge-<version>.dmg` (x64) ou la version universelle |
| Pas sûr | `myFlowForge-<version>-universal.dmg` — fonctionne sur les deux |

> **⚠️ L'application n'est pas encore signée.** Au premier lancement, macOS peut avertir que l'application *« ne peut pas être ouverte »* ou *« est endommagée »*. Ceci est normal pour une application non signée. Pour l'ouvrir :
> - **Clic droit** sur l'application dans `/Applications` → **Ouvrir** → **Ouvrir** dans la boîte de dialogue, **ou**
> - exécutez une fois dans le Terminal : `xattr -dr com.apple.quarantine /Applications/myFlowForge.app`
>
> myFlowForge vérifie ce flux Releases pour les mises à jour et propose les versions plus récentes directement dans l'application.

## 🚀 Pour commencer

### Prérequis

- **macOS** (Apple Silicon ou Intel)
- **Node.js** ≥ 20 et **npm**
- Un ou plusieurs des CLI de développement pris en charge, installés et authentifiés (Claude Code, Codex, Cursor, Gemini, qoder). Forge détecte ce que vous avez et vous guide dans l'installation des autres.

### Installer et exécuter en développement

```bash
# 1. Clone
git clone https://github.com/flowForges/myFlowForge.git
cd myFlowForge

# 2. Install dependencies
npm install

# 3. Launch in dev mode (hot reload)
npm run dev
```

### Scripts utiles

| Commande | Ce qu'elle fait |
|---------|--------------|
| `npm run dev` | Démarre l'application avec le rechargement à chaud |
| `npm test` | Exécute la suite de tests complète (Vitest) |
| `npm run typecheck` | Vérifie les types des deux tsconfigs (main et renderer) |
| `npm run build` | Compile le bundle de production |
| `npm run dist` | Compile un distribuable macOS (`.dmg`) |

### Compiler un distribuable

```bash
npm run dist            # macOS x64
npm run dist:arm64      # Apple Silicon
npm run dist:universal  # Universal binary
```

Les artefacts sont écrits dans `release/`.

## 🏗️ Pile technique

- **Shell :** [Electron](https://www.electronjs.org/) 42 + [electron‑vite](https://electron-vite.org/)
- **Interface :** [React](https://react.dev/) 19 + TypeScript 6
- **Terminal :** [xterm.js](https://xtermjs.org/) + [node‑pty](https://github.com/microsoft/node-pty)
- **Passerelle d'agents :** [Model Context Protocol SDK](https://modelcontextprotocol.io/)
- **Contrôle des processus :** [execa](https://github.com/sindresorhus/execa) · **Validation :** [zod](https://zod.dev/) · **Surveillance des fichiers :** [chokidar](https://github.com/paulmillr/chokidar)
- **Tests :** [Vitest](https://vitest.dev/) + Testing Library (développement piloté par les tests de bout en bout)
- **Empaquetage :** [electron‑builder](https://www.electron.build/)

## 📁 Structure du projet

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

## 🤝 Contribuer

Les contributions, signalements de problèmes et demandes de fonctionnalités sont les bienvenus ! Ce projet suit un workflow **piloté par les tests** — veuillez ajouter ou mettre à jour des tests avec vos modifications et vous assurer que `npm test` et `npm run typecheck` passent avant d'ouvrir une PR.

## 📄 Licence

Distribué sous [licence MIT](LICENSE) © 2026 zghua.

## 🙏 Remerciements

Construit sur l'excellent écosystème open source autour d'Electron, React, Vite et du Model Context Protocol — ainsi que sur les agents de développement qu'il orchestre : Claude Code, Codex, Cursor, Gemini et qoder.
