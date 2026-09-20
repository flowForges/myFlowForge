<div align="center">

<img src="build/icon.png" alt="myFlowForge" width="128" height="128" />

# myFlowForge

**Un poste de pilotage pour vos agents de code IA — sur votre bureau, sur vos serveurs, dans votre poche.**

Un poste de pilotage de bureau qui réunit **Claude Code, Codex, Cursor, Gemini, qoder, opencode, DeepSeek** et bien d'autres en un seul endroit — pour **changer d'agent et de modèle en pleine conversation**, **développer plusieurs projets en parallèle**, cadrer le travail avec un **workflow léger, en boîte manuelle**, tisser vos propres **hooks** entre les étapes, et rejoindre le tout depuis **une autre machine ou votre téléphone**.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-macOS%20·%20Windows%20·%20Linux-000000)
![Mobile](https://img.shields.io/badge/Mobile-iOS%20·%20Android-3DDC84)

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · **Français** · [Deutsch](README.de.md)

</div>

---

<div align="center">

<img src="assets/screenshots/home.jpg" alt="Accueil — espaces de travail, agents en cours et diff du jour en un coup d'œil" width="90%" />

<sub><b>Accueil</b> — reprenez là où vous vous étiez arrêté. Fond d'écran, habillage et couleur d'accent sont à vous de régler.</sub>

</div>

---

## Qu'est-ce que myFlowForge ?

Chaque CLI de code IA vit dans son propre terminal, avec son propre état de session, son propre quota, et sans savoir que les autres existent. Choisissez-en un et vous lui êtes marié pour tout le reste de la tâche.

**myFlowForge les réunit tous sous un même toit.** L'agent et le modèle sont des propriétés de *chaque tour de parole*, pas de la session — vous pouvez donc mûrir une conception avec Claude Opus, confier l'implémentation à Codex, et passer à quelque chose de bon marché pour les finitions, le tout dans une seule conversation, contexte intact.

Par-dessus vient un **workflow léger** : pas une chaîne de montage qui vous échappe, mais une fine couche de structure posée sur la même conversation. Chaque étape attend que vous appuyiez sur *Suivant*.

Et rien de tout cela n'est cloué à une seule machine. Le même poste de pilotage **se connecte à un autre ordinateur** — votre machine Linux, le poste du bureau — et pilote *ses* agents dans *ses* dépôts. Depuis votre téléphone, vous pouvez suivre une exécution, répondre à une porte et poursuivre la conversation.

> **État du projet :** un projet personnel activement développé. macOS, Windows et Linux disposent tous de builds packagés, et il existe un APK Android pour le client mobile. Les builds macOS sont **signés avec un Developer ID et notarisés par Apple**, le paquet Android est signé avec une vraie clé ; celui de Windows **n'est pas encore signé**.

## ✨ Les six choses qui comptent vraiment

### 1. Une collection d'agents, pas un favori

Quatorze CLI de code cohabitent dans une seule interface : **Claude Code · Codex · Cursor · Gemini · qoder · opencode · Qwen · Copilot · Pi · Kimi · Reasonix · Trae · Antigravity · DeepSeek**.

Les listes de modèles sont **lues dans la configuration locale réelle de chaque CLI** — rien n'est codé en dur, donc ce que vous voyez est ce que votre compte peut réellement exécuter. Vous pouvez aussi ajouter des entrées à la main, et elles survivent au rafraîchissement suivant. **opencode** est lui-même une passerelle multi-fournisseurs : câblez-le une fois, atteignez-en beaucoup.

### 2. Changer d'agent et de modèle au sein d'une même session

L'agent, le modèle et le mode de permission sont trois sélecteurs placés sous le champ de saisie. Changez-en un avant votre prochain message :

- Un modèle cale ou dérive → changez et continuez à demander ; il voit la conversation jusqu'ici.
- Plus de quota chez un fournisseur → passez à un autre, même session.
- Modèle coûteux pour la réflexion, modèle bon marché pour la corvée.

Les agents dotés d'une reprise native (Claude Code, Codex, Cursor, qoder, opencode) poursuivent leur propre historique de session. Pour les autres, myFlowForge reconstruit le contexte. Dans les deux cas, vous continuez simplement à parler.

### 3. Plusieurs projets développés en même temps

Un espace de travail contient **plusieurs dépôts**. Une étape peut *se déployer en éventail par projet* : frontend, backend et SDK avancent simultanément, chacun piloté par son propre agent dans son propre **git worktree**, si bien qu'ils n'entrent jamais en collision — et chaque diff atterrit dans un unique panneau Changements pour la relecture.

Le déploiement en éventail accepte aussi un sous-ensemble : analyser les cinq dépôts mais n'écrire du code que dans deux est une configuration parfaitement normale.

### 4. Un workflow léger — en boîte manuelle

Démarrer un workflow ne le lance **pas** jusqu'au bout. Cela entre dans un mode conversationnel :

- Un bandeau affiche *étape N sur M · étape en cours · quel agent pilote*.
- L'agent de l'étape travaille **dans le chat, devant vous** — sortie, appels d'outils et écritures de fichiers, tout est visible.
- Pas satisfait ? Continuez simplement à parler. Les relances et les corrections ne relancent pas l'étape.
- Content ? Appuyez sur **Suivant**. Ce n'est qu'alors que la passation est écrite et que l'agent suivant entre en scène.

L'étape Conception écrit un **vrai document markdown** (`forge-docs/design.md`), découpé en sections par projet. Ce document — et non un résumé qui perd de l'information — est le contrat unique entre agents ; les agents en aval le lisent en entier et se concentrent sur leur propre section.

Les étapes à porte s'arrêtent et vous attendent : **approuver**, **renvoyer** (vos remarques sont épinglées en haut, la sortie précédente réinjectée comme référence), ou simplement **poser une question** sans déclencher de relance. Vous réalisez tard que la conception était mauvaise ? Revenez à une étape antérieure et refaites-la.

### 5. Des hooks entre les étapes

Un hook est un petit pas glissé **entre** les étapes — là où une étape est un agent qui fait de la vraie ingénierie, un hook est une corvée réglée au passage.

Attachez-en un **avant l'exécution**, **après une étape donnée**, ou **après toute l'exécution** : récupérer le dernier code, synchroniser le document de conception vers votre wiki, lancer le lint, mettre à jour un tableau, envoyer une notification.

Chaque hook s'exécute comme un **micro-agent restreint** à la racine de l'espace de travail — uniquement les compétences et les outils qui lui ont été donnés, plus la tâche et les artefacts produits en amont. Il rend compte en une ligne, et vous interroge directement lorsqu'il tombe sur quelque chose que seul un humain peut résoudre. Un échec **bloque** le pipeline et propose réessayer / passer / abandonner. Les hooks vivent dans une bibliothèque globale, indépendante de tout emplacement : écrivez une fois, attachez partout.

### 6. Vos machines, et votre téléphone

L'hôte auquel vous êtes connecté est un **commutateur dans la barre d'état**, à côté du bouton du terminal. Basculez-le et la liste des espaces de travail, les sessions, les agents en cours, les changements git et le terminal intégré deviennent tous ceux *de cette machine*.

- **Direct** sur votre réseau local, ou **SSH**, ou via un **relais chiffré de bout en bout** quand les deux machines ne se voient pas. Le relais ne déplace jamais que du chiffré — il ne peut pas lire une session, et la salle est dérivée de la clé publique du daemon.
- Sur une machine Linux sans interface, lancez le **daemon** : `myflowforge-daemon pair` affiche un QR code directement dans le terminal. Scannez-le et vous êtes appairé.
- Le **client mobile** (iOS et Android) est un vrai client, pas une visionneuse : lisez la conversation pendant qu'elle défile, répondez aux portes de permission et de plan, parcourez les fichiers modifiés, créez un espace de travail, éditez un workflow, changez d'hôte.

---

<div align="center">

<img src="assets/screenshots/workflow.jpg" alt="Composition des étapes — chaque étape choisit son propre agent et son propre modèle ; Développement se déploie en éventail sur deux projets" width="90%" />

<sub><b>Composition des étapes</b> — cinq étapes, chacune avec son propre agent et son propre modèle ; <i>Développement</i> se déploie en éventail sur deux dépôts.</sub>

</div>

---

## 🤖 Agents de code pris en charge

| Agent | Chat | Workflow | Reprise native | MCP | Modèles |
|-------|:----:|:--------:|:-------------:|:---:|--------|
| **Claude Code** | ✅ | ✅ | ✅ | ✅ | détectés depuis la CLI |
| **Codex** | ✅ | ✅ | ✅ | ✅ | détectés depuis la CLI |
| **Cursor** | ✅ | ✅ | ✅ | ✅ | détectés depuis la CLI |
| **qoder** | ✅ | ✅ | ✅ | ✅ | détectés + liste personnalisée |
| **opencode** | ✅ | ✅ | ✅ | ✅ | passerelle multi-fournisseurs |
| **Gemini** | ✅ | ✅ | — | ✅ | liste prédéfinie |
| **Qwen** | ✅ | ✅ | — | ✅ | liste prédéfinie |
| **Copilot** | ✅ | ✅ | — | ✅ | liste prédéfinie |
| **Pi** | ✅ | ✅ | — | — | défaut du compte / personnalisé |
| **Kimi** | ✅ | ✅ | — | — | kimi-k2.5 · 256K |
| **Reasonix** | ✅ | ✅ | — | — | deepseek-flash / reasoner |
| **Trae** | ✅ | ✅ | — | — | défaut du compte (`/model` ou `trae_cli.yaml`) |
| **Antigravity** | ✅ | ✅ | ✅ | — | actualisés via `agy models` |
| **DeepSeek** 🆕 | ✅ | ✅ | — | — | défaut du compte |

> **DeepSeek**, c'est DeepSeek Harness — `npm install -g @deepseek-ai/dsh`. Il choisit une forme d'exécution par profil plutôt que par un drapeau headless ; myFlowForge pilote le profil `headless`, et les trois niveaux de permission correspondent à ses propres `read-only` / `workspace-write` / `danger-full-access`. Donnez-lui une clé avec `dsh web` (page Models) ou `DEEPSEEK_API_KEY`.
>
> **Trae** (la CLI TraeCode de ByteDance) n'est pas distribuée sur npm — son `install.sh` officiel place `traecli` dans `~/.local/bin`, alors assurez-vous que ce répertoire est dans votre PATH. Pour des modifications sans surveillance à l'intérieur d'un workflow, lancez `traecli config edit` et réglez `permission_mode: bypass_permissions`.

myFlowForge **ne stocke aucune clé d'API et ne relaie aucune requête** — il pilote les CLI déjà installées et authentifiées sur votre machine. Tout ce qui manque est signalé dans les Réglages avec les instructions d'installation, et les Réglages vous indiquent aussi quand une CLI est installée mais non connectée.

## 🔧 Comment se façonne une exécution

```
   Vous décrivez l'objectif
            │
            ▼
  ┌─ hook ─┐        ┌─ hook ─┐                    ┌─ hook ─┐
  │ avant  │        │ après  │                    │ après  │
  │ exéc.  │        │concept.│                    │ exéc.  │
  └───┬────┘        └───┬────┘                    └───┬────┘
      ▼                 ▼                             ▼
 📋 Besoin → 🎨 Conception → ✋ PORTE → 💻 Développ. → 🧪 Test → 🔍 Revue
  (clarifier)  (design.md)  vous décidez  (éventail)  (vérifier)  (multi-angle)
                    │                         │
                    │                         └─ un agent par projet,
                    │                            voies parallèles, worktree dédié
                    └─ un vrai document, lu intégralement par chaque agent en aval

 Chaque flèche attend votre « Suivant ». Les étapes peuvent être ajoutées, retirées,
 réordonnées ou sautées — n'exécuter que Besoin → Développement est tout à fait valide.
```

Trois façons d'en démarrer une, qui aboutissent toutes à la même porte :

1. Appuyez sur **Démarrer** dans le panneau Workflow.
2. Tapez `/` dans le champ de saisie et choisissez-en un.
3. Décrivez une tâche de développement complète en langage courant — l'agent principal la reconnaît et ouvre une porte de plan via MCP. Les questions, les discussions et les corrections d'une ligne ne la déclenchent pas.

## 📱 Hôtes distants et client mobile

Une seule application, plusieurs machines. Choisissez l'hôte dans la barre d'état et tout le reste suit.

| | |
|---|---|
| **Direct** | Même réseau local, droit vers le port du daemon. Authentifié par jeton. |
| **SSH** | Réutilise une connexion SSH que vous avez déjà — rien de nouveau à ouvrir. |
| **Relais** | Pour les machines qui ne se voient pas. **Chiffré de bout en bout** : clés fraîches à chaque session, le relais ne fait que transmettre du chiffré, et une trame illisible est jetée plutôt que crue. Hébergez le vôtre (`relay/`, Node ou un Cloudflare Worker) — les étapes de déploiement sont dans `relay/README.md`. |

**Le daemon Linux** est la même base de code sans la fenêtre — installez le tarball, lancez-le sous systemd, et appairez en scannant le QR code qu'il affiche dans le terminal (`docs/linux-deploy.md`).

**Le client mobile** couvre les parties dont vous avez réellement besoin loin du bureau : la conversation en direct avec la réflexion qui défile, les cartes d'outils et les cartes de sous-agents ; les portes de permission et de plan auxquelles vous pouvez répondre ; les fichiers modifiés et les diffs ; la création d'espace de travail ; la bibliothèque de modèles de workflow ; le changement d'hôte et l'appairage par QR code. Le markdown, les tableaux et les images locales s'affichent nativement — les adresses d'images distantes restent des liens, volontairement, pour que la sortie d'un agent ne puisse jamais transformer votre téléphone en balise de pistage.

## 🧩 Également inclus

- **Import de sessions natives** — analyse en lecture seule de votre historique local Claude / Codex / Cursor / qoder ; importez-le comme espace de travail et continuez.
- **Pont MCP** — un serveur Forge MCP intégré permet aux agents de rappeler l'application : `forge_ask`, `forge_propose_plan`, `forge_write_artifact`, `forge_handoff`, `forge_delegate`, `forge_read_context`, `forge_heartbeat`. Injecté dans les agents qui prennent en charge MCP ; les autres se rabattent sur une directive textuelle.
- **Serveurs MCP et modules** — voyez quels serveurs MCP chaque CLI a configurés, autorisez-les ou révoquez-les depuis l'application, et parcourez un marché de compétences pour en installer dans les CLI qui les lisent.
- **Mémoire** — des notes par espace de travail que les agents peuvent relire, pour qu'un travail de longue haleine garde son propre fil.
- **Observabilité en temps réel** — réflexion / appels d'outils / changements de fichiers / sortie brute en direct, une console de journaux filtrable, l'historique des exécutions, et les preuves de changement inter-projets.
- **Consommation de tokens et quotas** — quota restant et heures de réinitialisation par fournisseur, plus la dépense par espace de travail × agent × jour.
- **Pont pour bots** — répondez aux portes, consultez les résultats, démarrez une conversation et pilotez des workflows depuis **DingTalk**, **Telegram** ou **Feishu** sur votre téléphone.
- **Modes de permission** — lecture seule · auto sur l'espace de travail (par défaut) · accès complet, par session ou par étape. Rattachés à la portée réelle du bac à sable de chaque CLI, et l'interface dit clairement quels agents la respectent vraiment.
- **Commandes slash, compétences et plugins** — `/` fait remonter vos vraies commandes présentes sur le disque et les compétences installées, filtrées par agent.
- **Workflows personnalisés** — le processus vous appartient : enregistrez autant de workflows nommés que vous voulez, chacun avec son propre jeu d'étapes ; chaque étape choisit son agent, son modèle, son mode de permission, sa forme de déploiement en éventail, si elle comporte une porte et si elle doit produire un document.
- **Étapes personnalisées** — une bibliothèque globale de vos propres étapes, référencée par n'importe quel workflow.
- **Navigateur de fichiers et diff** — arborescence en plein écran avec marqueurs de changement, aperçu avec coloration syntaxique, bascule diff ou fichier complet.
- **Terminal intégré** — un vrai pty enraciné dans l'espace de travail, avec des réglages de proxy et de fuseau horaire par fournisseur. Connecté à un hôte distant, il ouvre un shell **sur cette machine**.
- **Mascotte de bureau** — elle suit l'écran où vous travaillez, prévisualise l'activité des agents, fait surgir des cartes de confirmation ; parcourez le marché des mascottes ou apportez vos propres images.
- **Mascotte évolutive** — la mascotte de bureau grandit par paliers au fil de votre travail, pour que les longues sessions laissent une trace visible.
- **Transparence et verre dépoli** — un seul curseur de flou fait passer toute la fenêtre de l'opacité totale à trois matériaux de vibrance natifs de macOS, pour laisser transparaître votre bureau.
- **Personnalisation** — 6 habillages originaux, 12 couleurs d'accent, une galerie de plus de 300 fonds d'écran ou votre propre image, des tailles de police au pixel près pour l'application et le chat indépendamment, contraste réglé séparément en clair et en sombre.
- **Thème dérivé du fond d'écran** — activez-le et toute la palette est dérivée du fond d'écran que vous avez choisi, le clair ou le sombre étant décidé par l'image elle-même. Le fond d'écran ne fournit jamais que deux teintes ; chaque palier de luminosité et de chroma est copié des habillages réglés à la main, si bien qu'une image chargée ne peut pas produire une interface illisible. Vous préférez votre propre accent ? Choisissez-en un et seul l'accent cesse de suivre.
- **Images et visuels en ligne dans le chat** — une image produite sur le disque par un agent s'affiche dans la réponse, cliquez pour la voir en grand. Les fragments HTML écrits au milieu d'une réponse peuvent devenir de vraies cartes, de vrais tableaux et de vrais diagrammes (désactivé par défaut). Jamais d'`innerHTML` — le fragment est analysé puis reconstruit à partir d'une liste blanche constructive, et les couleurs ne peuvent venir que des jetons du thème, si bien que le contenu rendu suit votre habillage au lieu de le contredire.

## 📥 Téléchargement et installation

Récupérez le dernier build sur la page [**Releases**](https://github.com/flowForges/myFlowForge/releases) :

| Plateforme | Fichier |
|----------|------|
| macOS · Apple Silicon (M1–M4) | `myFlowForge-<version>-arm64.dmg` |
| macOS · Intel | `myFlowForge-<version>.dmg` |
| Windows · x64 | `myFlowForge-<version>-x64-setup.exe` |
| Android | `myFlowForge-<version>.apk` |
| Linux · daemon sans interface | `myFlowForge-daemon-<version>-linux.tar.gz` |

> Les builds **macOS** sont signés et notarisés par Apple — téléchargez, double-cliquez, c'est tout. Fini le « endommagée ».
> Les builds **Windows** ne sont pas encore signés : SmartScreen vous arrêtera une fois — **Informations complémentaires → Exécuter quand même**.
>
> myFlowForge consulte les mêmes Releases et vous signale les nouvelles versions dans l'app.

**iOS** passe par TestFlight (sur invitation pour l'instant — votre identifiant Apple doit être ajouté à la liste des testeurs). Vous pouvez aussi le compiler depuis `mobile/` avec votre propre identifiant Apple et l'installer par câble.

## 🚀 Démarrage

**Prérequis :** macOS 11+ / Windows 10+ / un Linux récent, Node.js ≥ 20, git, et au moins une CLI de code prise en charge, installée et authentifiée.

```bash
git clone https://github.com/flowForges/myFlowForge.git
cd myFlowForge
npm install
npm run dev          # mode dev avec rechargement à chaud du renderer
```

| Commande | Ce qu'elle fait |
|---------|--------------|
| `npm run dev` | Démarrer avec rechargement à chaud |
| `npm test` | Lancer toute la suite de tests (Vitest) |
| `npm run typecheck` | Vérifier les types des deux tsconfig, main et renderer |
| `npm run build` | Compiler le bundle de production |
| `npm run dist:mac-all` | Compiler les `.dmg` Intel et Apple Silicon |
| `npm run dist:win` | Compiler l'installeur Windows x64 |
| `npm run check:daemon` | Éprouver le daemon sans interface de bout en bout |

Le client mobile vit dans `mobile/` (Expo / React Native) et le relais dans `relay/` ; les deux ont leur propre `package.json`.

Les artefacts atterrissent dans `release/`. Les modifications sous `src/main/**` exigent un **redémarrage complet d'Electron** — le rechargement à chaud ne rafraîchit que le renderer.

## 🏗️ Stack technique

**Coque :** [Electron](https://www.electronjs.org/) 42 + [electron-vite](https://electron-vite.org/) · **Interface :** [React](https://react.dev/) 19 + TypeScript 6 · **Mobile :** [Expo](https://expo.dev/) + [React Native](https://reactnative.dev/) · **Terminal :** [xterm.js](https://xtermjs.org/) + [node-pty](https://github.com/microsoft/node-pty) · **Pont d'agents :** [Model Context Protocol SDK](https://modelcontextprotocol.io/) · **Contrôle de processus :** [execa](https://github.com/sindresorhus/execa) · **Validation :** [zod](https://zod.dev/) · **Surveillance de fichiers :** [chokidar](https://github.com/paulmillr/chokidar) · **Tests :** [Vitest](https://vitest.dev/) + Testing Library · **Packaging :** [electron-builder](https://www.electron.build/)

## 📁 Structure du projet

```
src/
├── main/              # Processus principal Electron
│   ├── agents/        # Adaptateurs CLI + registre de fournisseurs, détection, permissions
│   ├── run/           # Moteur de workflow : étapes, portes, éventail, hooks, passations
│   ├── chat/          # Chat par espace de travail, file d'attente, mémoire
│   ├── mcp/           # Serveur Forge MCP (pont agent → application)
│   ├── remote/        # Hôtes distants : direct / SSH / relais, routage, canal E2E
│   ├── daemon/        # Daemon sans interface + appairage par QR code au terminal
│   ├── bot/           # Pont pour bots (transports DingTalk / Telegram / Feishu)
│   ├── plugins/       # Hôte de plugins, catalogue, planificateur, points d'extension
│   ├── sessionImport/ # Analyse et import de sessions natives
│   ├── usage/         # Adaptateurs de quota par fournisseur
│   ├── pet/           # Fenêtre de la mascotte de bureau
│   └── ...            # git, fs, terminal, mise à jour, watcher, fenêtres, apparence
├── renderer/          # Interface React (vues, composants, réglages, thème, mascotte)
├── preload/           # Pont IPC isolé par contexte
└── shared/            # Types et logique pure partagés entre les processus
mobile/                # Client iOS et Android (Expo / React Native)
relay/                 # Relais chiffré de bout en bout (Node ou Cloudflare Worker)
```

## 🤝 Contribuer

Les issues et les PR sont les bienvenues. Le projet est **piloté par les tests** — merci d'ajouter ou de mettre à jour les tests avec vos modifications et de vérifier que `npm test` et `npm run typecheck` passent avant d'ouvrir une PR.

## 📄 Licence

Publié sous [licence MIT](LICENSE) © 2026 zghua.

## 🙏 Remerciements

Construit sur l'écosystème open source autour d'Electron, React, Vite et du Model Context Protocol — et sur les agents de code qu'il orchestre.

## 🔗 Liens

- [LINUX DO](https://linux.do/latest) — une communauté de développeurs qui aiment bricoler
