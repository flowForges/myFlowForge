<div align="center">

<img src="build/icon.png" alt="myFlowForge" width="128" height="128" />

# myFlowForge

**Un poste de pilotage macOS pour vos agents de code IA.**

Un bureau macOS qui rassemble **Claude Code, Codex, Cursor, Gemini, qoder, opencode, Trae** et d'autres au même endroit —— pour **changer d'agent et de modèle en pleine conversation**, **développer plusieurs projets en parallèle**, garder la main à chaque étape grâce à un **workflow léger, en boîte manuelle**, et glisser vos propres **hooks** entre les étapes.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-macOS-000000?logo=apple&logoColor=white)

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · **Français** · [Deutsch](README.de.md)

</div>

---

<div align="center">

<img src="assets/screenshots/home.jpg" alt="Accueil — espaces de travail, agents en cours et diff du jour d'un coup d'œil" width="90%" />

<sub><b>Accueil</b> — reprenez là où vous en étiez. Fond d'écran, thème et couleur d'accent : tout se change.</sub>

</div>

---

## Qu'est-ce que myFlowForge ?

Chaque CLI de code IA vit dans son propre terminal, avec son propre état de session, son propre quota, et sans se douter que les autres existent. Vous en choisissez un, et vous êtes lié à lui jusqu'au bout de la tâche.

**myFlowForge les réunit sous un même toit.** L'agent et le modèle sont des propriétés de *chaque tour de parole*, pas de la session : mûrissez une conception avec Claude Opus, confiez l'implémentation à Codex, redescendez sur un modèle bon marché pour les finitions — le tout dans une seule conversation, contexte intact.

Par-dessus vient un **workflow léger** : pas une chaîne de montage qui vous échappe, mais une fine couche de structure posée sur cette même conversation. Chaque étape attend que vous appuyiez sur *Suivant*.

> ⚠️ **État du projet :** un projet personnel en développement actif. Il vise **macOS** (Apple Silicon et Intel). Reposant sur Electron, il peut être compilé depuis les sources pour d'autres plateformes, mais seul macOS est empaqueté aujourd'hui. **1.1.0** est la version stable actuelle ; les bêtas publiées entre deux versions stables sont là où les nouveautés arrivent en premier.

## ✨ Les cinq choses qui comptent vraiment

### 1. Une collection d'agents, pas un favori

Douze CLI de code cohabitent dans une seule interface : **Claude Code · Codex · Cursor · Gemini · qoder · opencode · Qwen · Copilot · Pi · Kimi · Reasonix · Trae**.

Les listes de modèles sont **lues dans la configuration locale réelle de chaque CLI** : rien n'est codé en dur, donc ce que vous voyez est ce que votre compte peut réellement exécuter. Vous pouvez aussi ajouter des entrées à la main, et elles survivent au prochain rafraîchissement. **opencode** est lui-même une passerelle multi-fournisseurs : branchez-le une fois, vous en atteignez beaucoup.

### 2. Changer d'agent et de modèle au sein d'une même session

Agent, modèle et mode de permission : trois sélecteurs installés en permanence sous la zone de saisie. Changez-en avant votre prochain message :

- Un modèle cale ou part de travers → changez et continuez à demander ; il voit la conversation jusque-là.
- Plus de quota chez un fournisseur → passez à un autre, dans la même session.
- Modèle cher pour réfléchir, modèle bon marché pour la corvée.

Les agents à reprise native (Claude Code, Codex, Cursor, qoder, opencode) poursuivent leur propre historique de session. Pour les autres, myFlowForge reconstitue le contexte. Dans les deux cas, vous continuez simplement à parler.

### 3. Plusieurs projets développés en même temps

Un espace de travail contient **plusieurs dépôts**. Une étape peut *se déployer en éventail par projet* : frontend, backend et SDK avancent simultanément, chacun mené par son propre agent dans son propre **git worktree**, donc sans collision — et tous les diffs atterrissent dans un unique panneau Changements.

L'éventail accepte un sous-ensemble : analyser les cinq dépôts mais n'écrire du code que dans deux est une configuration tout à fait normale.

### 4. Un workflow léger — en boîte manuelle

Démarrer un workflow ne le lance **pas** jusqu'au bout. Il entre en mode conversationnel :

- Un bandeau affiche *étape N sur M · étape en cours · quel agent est aux commandes*.
- L'agent de l'étape travaille **dans la conversation sous vos yeux** : sortie, appels d'outils et écritures de fichiers, tout est visible.
- Pas satisfait ? Continuez simplement à parler. Les relances et les corrections ne relancent pas l'étape.
- Content ? Appuyez sur **Suivant**. C'est seulement là que la note de passation est écrite et que l'agent suivant entre en scène.

L'étape de conception rédige un **vrai document markdown** (`forge-docs/design.md`), avec une section par projet. Ce document — et non un résumé qui perd les détails — est le contrat unique entre agents ; les agents en aval le lisent en entier puis se concentrent sur leur propre section.

Les étapes à barrière s'arrêtent et vous attendent : **approuver**, **renvoyer** (vos remarques sont épinglées en tête et la sortie précédente revient comme référence), ou simplement **poser une question** sans déclencher de relance. Vous réalisez tard que la conception était fausse ? Revenez à une étape antérieure et refaites-la.

### 5. Des hooks entre les étapes

Un hook est un petit pas glissé **entre** deux étapes. Là où une étape est un agent qui fait de l'ingénierie pour de vrai, un hook est une corvée expédiée en chemin.

Accrochez-en un **avant l'exécution**, **après n'importe quelle étape**, ou **après l'ensemble** : récupérer le dernier code, synchroniser le document de conception vers votre wiki, passer le lint, mettre à jour un tableau, envoyer une notification.

Chaque hook s'exécute comme un **micro-agent restreint** à la racine de l'espace de travail : uniquement les skills et outils qu'on lui a donnés, plus la tâche et les artefacts produits en amont. Il rend compte en une ligne et vous interroge directement lorsqu'il bute sur ce que seul un humain peut trancher. Un échec **bloque** le pipeline et propose relancer / passer / abandonner. Les hooks vivent dans une bibliothèque globale, indépendante de tout emplacement : écrits une fois, accrochés partout.

---

<div align="center">

<img src="assets/screenshots/workflow.jpg" alt="Composition des étapes — chaque étape choisit son agent et son modèle ; Développement se déploie sur deux projets" width="90%" />

<sub><b>Composition des étapes</b> — cinq étapes, chacune avec son agent et son modèle ; <i>Développement</i> se déploie sur deux dépôts.</sub>

</div>

---

## 🤖 Agents de code pris en charge

| Agent | Chat | Workflow | Reprise native | MCP | Modèles |
|-------|:----:|:--------:|:--------------:|:---:|---------|
| **Claude Code** | ✅ | ✅ | ✅ | ✅ | découverts depuis le CLI |
| **Codex** | ✅ | ✅ | ✅ | ✅ | découverts depuis le CLI |
| **Cursor** | ✅ | ✅ | ✅ | ✅ | découverts depuis le CLI |
| **qoder** | ✅ | ✅ | ✅ | ✅ | découverts + liste perso |
| **opencode** | ✅ | ✅ | ✅ | ✅ | passerelle multi-fournisseurs |
| **Gemini** | ✅ | ✅ | — | ✅ | liste prédéfinie |
| **Qwen** | ✅ | ✅ | — | ✅ | liste prédéfinie |
| **Copilot** | ✅ | ✅ | — | ✅ | liste prédéfinie |
| **Pi** | ✅ | ✅ | — | — | défaut du compte / perso |
| **Kimi** | ✅ | ✅ | — | — | kimi-k2.5 · 256K |
| **Reasonix** | ✅ | ✅ | — | — | deepseek-flash / reasoner |
| **Trae** 🆕 | ✅ | ✅ | — | — | défaut du compte (`/model` ou `trae_cli.yaml`) |

> **Trae** (le TraeCode CLI de ByteDance) n'est pas distribué sur npm : son `install.sh` officiel place `traecli` dans `~/.local/bin`, pensez donc à l'ajouter au PATH. Pour qu'il modifie des fichiers sans surveillance au sein d'un workflow, lancez `traecli config edit` et réglez `permission_mode: bypass_permissions`.

myFlowForge **ne stocke aucune clé d'API et ne relaie aucune requête** : il pilote les CLI déjà installés et authentifiés sur votre machine. Ce qui manque est signalé dans les Réglages avec les instructions d'installation.

## 🔧 À quoi ressemble une exécution

```
   Vous décrivez l'objectif
            │
            ▼
  ┌─ hook ─┐        ┌─ hook ─┐                    ┌─ hook ─┐
  │  avant │        │ après  │                    │ après  │
  │  la    │        │   la   │                    │  tout  │
  │ course │        │ concep.│                    │        │
  └───┬────┘        └───┬────┘                    └───┬────┘
      ▼                 ▼                             ▼
 📋 Besoin → 🎨 Conception → ✋ BARRIÈRE → 💻 Développement → 🧪 Tests → 🔍 Revue
 (clarifier)  (design.md)   vous tranchez   (en éventail)   (vérifier) (multi-angles)
                    │                            │
                    │                            └─ un agent par projet,
                    │                               couloirs parallèles, worktree dédié
                    └─ un vrai document, lu intégralement par chaque agent en aval

 Chaque flèche attend que vous appuyiez sur « Suivant ». Les étapes s'ajoutent,
 se retirent, se réordonnent ou se sautent — ne faire que Besoin → Développement
 est parfaitement valable.
```

Trois façons d'en démarrer un, toutes menant à la même barrière :

1. Appuyez sur **Démarrer** dans le panneau Workflow.
2. Tapez `/` dans la zone de saisie et choisissez-en un.
3. Décrivez une tâche de développement complète en langage courant : l'agent principal la reconnaît et lève une barrière de plan via MCP. Les simples questions, les discussions et les corrections d'une ligne ne la déclenchent pas.

## 🧩 Également fourni

- **Import de sessions natives** — analyse en lecture seule de votre historique local Claude / Codex / Cursor / qoder ; importez-le comme espace de travail et poursuivez.
- **Pont MCP** — un serveur Forge MCP intégré permet aux agents de rappeler l'application : `forge_ask`, `forge_propose_plan`, `forge_write_artifact`, `forge_handoff`, `forge_delegate`, `forge_read_context`, `forge_heartbeat`. Injecté dans les huit agents compatibles MCP ; les autres se rabattent sur une directive textuelle.
- **Observabilité en temps réel** — réflexion, appels d'outils, modifications de fichiers et sortie brute en flux continu ; console de logs filtrable, historique des exécutions et preuves de changement inter-projets.
- **Consommation de tokens et quotas** — quota restant et heure de réinitialisation par fournisseur, plus la dépense par espace de travail × agent × jour.
- **Pont de bots** — répondez aux barrières, consultez les résultats, lancez une conversation et pilotez les workflows depuis **DingTalk** sur votre téléphone (Telegram / Feishu déjà câblés pour plus tard).
- **Modes de permission** — lecture seule · automatique dans l'espace de travail (par défaut) · accès complet, par session ou par étape. Ils correspondent au bac à sable réel de chaque CLI, et l'interface dit franchement quels agents les respectent vraiment.
- **Commandes slash, skills et plugins** — `/` fait apparaître vos commandes réellement présentes sur le disque et les skills installées, filtrées par agent.
- **Workflows personnalisés** — le processus, c'est vous qui l'assemblez : enregistrez autant de workflows nommés que vous voulez, chacun avec son jeu d'étapes ; chaque étape choisit son agent, son modèle, son mode de permission, sa forme d'éventail, si elle pose une barrière et si elle doit produire un document.
- **Étapes personnalisées** — une bibliothèque globale d'étapes écrites par vous, référençable depuis n'importe quel workflow.
- **Explorateur de fichiers et diff** — arborescence plein écran avec marqueurs de modification, aperçu avec coloration syntaxique, bascule diff / texte intégral.
- **Terminal intégré** — un vrai pty enraciné dans l'espace de travail, avec proxy et fuseau horaire par fournisseur.
- **Mascotte de bureau** — elle suit l'écran actif, prévisualise l'activité des agents et fait apparaître des cartes de confirmation ; parcourez le marché aux mascottes ou apportez vos propres images.
- **Transparence et verre dépoli** — un unique curseur fait passer toute la fenêtre de totalement opaque aux trois matériaux de *vibrancy* natifs de macOS, laissant transparaître le bureau.
- **Personnalisation** — 6 thèmes originaux, 12 couleurs d'accent, une galerie de 270 fonds d'écran ou votre propre image, des tailles de police au pixel près et indépendantes pour l'application et pour la conversation, avec un contraste réglé séparément en clair et en sombre.
- **Thème dérivé du fond d'écran** — activez-le et toute la palette découle du fond d'écran choisi ; clair ou sombre, c'est l'image qui décide. Le fond d'écran ne fournit que deux teintes : chaque palier de luminosité et de chroma est repris des thèmes réglés à la main, si bien qu'une image chargée ne peut pas produire une interface illisible. Vous préférez votre propre accent ? Choisissez-le et seul l'accent cesse de suivre.
- **Compagnon évolutif** — le compagnon de bureau grandit par étapes au fil du travail : une longue session laisse quelque chose de visible derrière elle.
- **Visuels intégrés à la conversation** — désactivé par défaut : une fois activé, les fragments HTML qu'un agent écrit au milieu d'une réponse s'affichent en véritables cartes, tableaux et schémas. Jamais d'`innerHTML` : le fragment est analysé puis reconstruit à partir d'une liste blanche constructive, et les couleurs ne peuvent venir que des jetons du thème — le rendu suit donc votre thème au lieu de le contrarier.

## 📥 Téléchargement et installation

Récupérez le dernier `.dmg` depuis la page [**Releases**](https://github.com/flowForges/myFlowForge/releases) :

| Votre Mac | Téléchargement |
|-----------|----------------|
| Apple Silicon (M1/M2/M3/M4) | `myFlowForge-<version>-arm64.dmg` |
| Intel | `myFlowForge-<version>.dmg` |

> **⚠️ L'application n'est pas encore signée.** Au premier lancement, macOS peut annoncer qu'elle *« ne peut pas être ouverte »* ou qu'elle *« est endommagée »* : c'est le comportement normal pour une application non signée, le fichier est intact. Au choix :
> - **Clic droit** sur l'application dans `/Applications` → **Ouvrir** → **Ouvrir** dans la boîte de dialogue, ou
> - exécuter une fois : `xattr -dr com.apple.quarantine /Applications/myFlowForge.app`
>
> myFlowForge consulte ce même flux Releases et vous propose les nouvelles versions depuis l'application.

## 🚀 Démarrer depuis les sources

**Prérequis :** macOS 11+, Node.js ≥ 20, git, et au moins un CLI de code pris en charge, installé et authentifié.

```bash
git clone https://github.com/flowForges/myFlowForge.git
cd myFlowForge
npm install
npm run dev          # mode développement avec rechargement à chaud du renderer
```

| Commande | Ce qu'elle fait |
|----------|-----------------|
| `npm run dev` | Démarre avec rechargement à chaud |
| `npm test` | Lance toute la suite de tests (Vitest) |
| `npm run typecheck` | Vérifie les types des tsconfig main et renderer |
| `npm run build` | Compile le bundle de production |
| `npm run dist:mac-all` | Compile les `.dmg` Intel et Apple Silicon |

Les artefacts arrivent dans `release/`. Les modifications sous `src/main/**` nécessitent un **redémarrage complet d'Electron** ; le rechargement à chaud ne rafraîchit que le renderer.

## 🏗️ Pile technique

**Coque :** [Electron](https://www.electronjs.org/) 42 + [electron-vite](https://electron-vite.org/) · **UI :** [React](https://react.dev/) 19 + TypeScript 6 · **Terminal :** [xterm.js](https://xtermjs.org/) + [node-pty](https://github.com/microsoft/node-pty) · **Pont d'agents :** [Model Context Protocol SDK](https://modelcontextprotocol.io/) · **Contrôle des processus :** [execa](https://github.com/sindresorhus/execa) · **Validation :** [zod](https://zod.dev/) · **Surveillance de fichiers :** [chokidar](https://github.com/paulmillr/chokidar) · **Tests :** [Vitest](https://vitest.dev/) + Testing Library · **Empaquetage :** [electron-builder](https://www.electron.build/)

## 📁 Structure du projet

```
src/
├── main/              # Processus principal Electron
│   ├── agents/        # Adaptateurs CLI + registre des fournisseurs, détection, permissions
│   ├── run/           # Moteur de workflow : étapes, barrières, éventail, hooks, passations
│   ├── chat/          # Conversation, file d'attente et mémoire par espace de travail
│   ├── mcp/           # Serveur Forge MCP (pont agent → app)
│   ├── bot/           # Pont de bots (transports DingTalk / Telegram / Feishu)
│   ├── plugins/       # Hôte de plugins, catalogue, ordonnanceur, points d'extension
│   ├── sessionImport/ # Analyse et import des sessions natives
│   ├── usage/         # Adaptateurs de quota par fournisseur
│   ├── pet/           # Fenêtre de la mascotte de bureau
│   └── ...            # git, fs, terminal, mises à jour, surveillance, fenêtres, apparence
├── renderer/          # Interface React (vues, composants, réglages, thème, mascotte)
├── preload/           # Pont IPC isolé du contexte
└── shared/            # Types et logique pure partagés entre processus
```

## 🤝 Contribuer

Les tickets et les PR sont les bienvenus. Le projet est **piloté par les tests** : ajoutez ou mettez à jour les tests avec vos modifications et assurez-vous que `npm test` et `npm run typecheck` passent avant d'ouvrir une PR.

## 📄 Licence

Publié sous [licence MIT](LICENSE) © 2026 zghua.

## 🙏 Remerciements

Bâti sur l'écosystème open source qui entoure Electron, React, Vite et le Model Context Protocol —— et sur les agents de code qu'il orchestre.

## 🔗 Liens

- [LINUX DO](https://linux.do/latest) — une communauté de développeurs qui aiment bidouiller
