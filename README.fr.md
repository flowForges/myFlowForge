<div align="center">

<img src="build/icon.png" alt="myFlowForge" width="128" height="128" />

# myFlowForge

**Une seule GUI pour les agents natifs Claude Code, Codex, Cursor et d'autres : gestion centralisée, connexion entre appareils.**

myFlowForge appelle directement les CLI officielles installées sur la machine (Claude Code, Codex, Cursor, Gemini, qoder, opencode, DeepSeek, etc.). Il ne modifie ni ne remplace les agents eux-mêmes et se limite à fournir une GUI unifiée par-dessus. Il permet de changer d'agent et de modèle au sein d'une même session, d'importer des sessions natives, d'exécuter des workflows par étapes, prend en charge les compagnons natifs de Codex, et accepte les connexions à distance depuis un autre ordinateur, un serveur ou un téléphone.

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

<img src="assets/screenshots/home.jpg" alt="Accueil : espaces de travail, agents en cours d'exécution et modifications du jour" width="90%" />

<sub><b>Accueil</b> : espaces de travail, agents en cours d'exécution et modifications du jour. Le fond d'écran, le thème et la couleur d'accentuation sont personnalisables.</sub>

</div>

---

## Présentation

Chaque CLI de codage IA s'exécute dans son propre terminal. Les sessions, les quotas et les configurations ne sont pas partagés entre elles, et une tâche se retrouve souvent liée à un seul outil.

myFlowForge se positionne comme une couche GUI au-dessus de ces CLI et suit trois principes :

- **Intégration native** : les agents sont appelés via leurs CLI officielles, avec votre propre compte, votre abonnement et votre configuration locale. Aucun fork ni modification des agents, aucune clé API stockée, aucune requête relayée. Lorsqu'un agent est mis à jour, ses nouvelles fonctionnalités sont utilisables immédiatement.
- **Gestion unifiée** : plusieurs agents, projets et sessions sont gérés dans une même interface, et les tâches ne sont plus liées à un outil unique.
- **Connexion multi-appareils** : l'application de bureau, le daemon Linux sans interface et les clients iOS / Android partagent les mêmes espaces de travail et sessions, via connexion directe en réseau local, SSH ou relais chiffré de bout en bout.

> **État du projet :** maintenu par une seule personne, en développement actif. Des paquets d'installation sont fournis pour macOS, Windows et Linux, ainsi qu'un APK Android et une version iOS via TestFlight. Le paquet macOS est signé avec un Developer ID et notarié par Apple, le paquet Android est signé avec une clé de production, et le paquet Windows n'est pas encore signé.

## Fonctionnalités principales

### 1. Intégration native des agents

14 CLI de codage sont prises en charge : **Claude Code · Codex · Cursor · Gemini · qoder · opencode · Qwen · Copilot · Pi · Kimi · Reasonix · Trae · Antigravity · DeepSeek**.

myFlowForge pilote les CLI officielles installées et connectées sur la machine, sans en modifier le comportement. La liste des modèles est lue en priorité depuis la configuration locale de chaque CLI, avec une liste prédéfinie à défaut ; des modèles peuvent aussi être ajoutés manuellement et ne sont alors pas écrasés lors des actualisations. Les CLI non installées ou non connectées sont signalées dans les paramètres, avec des instructions d'installation.

### 2. Changer d'agent et de modèle dans une même session

L'agent, le modèle et le niveau d'autorisation peuvent être choisis à nouveau avant chaque tour de conversation, sans perte de contexte :

- si un modèle donne de mauvais résultats, il est possible de poursuivre avec un autre, qui voit l'intégralité de la conversation précédente ;
- si le quota d'un fournisseur est épuisé, il est possible de passer à un autre sans ouvrir de nouvelle session ;
- les modèles peuvent être attribués selon la nature de la tâche, par exemple un modèle plus performant pour la conception et un modèle moins coûteux pour l'implémentation et la finalisation.

Les agents qui prennent en charge la reprise native (Claude Code, Codex, Cursor, qoder, opencode, Antigravity) conservent leur propre historique de session ; pour les autres, myFlowForge reconstruit le contexte.

### 3. Connexion multi-appareils

- **Hôtes distants** : l'application de bureau peut se connecter à un autre ordinateur ou à un serveur et piloter les agents, dépôts et terminaux de cette machine. L'hôte actif se choisit dans la barre d'état ; les espaces de travail, les sessions, les modifications git et le terminal intégré suivent ce choix.
- **Trois modes de connexion** : connexion directe en réseau local, SSH, relais chiffré de bout en bout. Le relais ne transmet que des données chiffrées et ne peut pas lire le contenu des sessions ; il peut être auto-hébergé (Node ou Cloudflare Worker).
- **Daemon sans interface** : `myflowforge-daemon` s'exécute sur un serveur Linux, et la commande `pair` affiche un QR code d'appairage dans le terminal.
- **Mobile** : les clients iOS et Android permettent de suivre les conversations en temps réel, de traiter les demandes d'autorisation et les validations de conception, de consulter les modifications et les diffs, de créer des espaces de travail, de modifier des workflows et de changer d'hôte.
- **Autorisation des appareils** : chaque appareil utilise son propre code d'appairage et peut être retiré individuellement à tout moment ; la révocation prend effet immédiatement.


<table>
<tr>
<td width="40%"><img src="assets/screenshots/devices-mac.jpg" alt="Une même session synchronisée sur macOS, Windows et iPhone · macOS" /></td>
<td width="40%"><img src="assets/screenshots/devices-win.jpg" alt="Une même session synchronisée sur macOS, Windows et iPhone · Windows" /></td>
<td width="20%"><img src="assets/screenshots/devices-ios.jpg" alt="Une même session synchronisée sur macOS, Windows et iPhone · iPhone" /></td>
</tr>
</table>
<p align="center"><sub>Une même session synchronisée sur macOS, Windows et iPhone</sub></p>

<table>
<tr>
<td width="50%"><img src="assets/screenshots/remote-hosts.jpg" alt="Hôtes distants : connexion directe en LAN, relais et SSH" /></td>
<td width="50%"><img src="assets/screenshots/share-devices.jpg" alt="Partage : chaque appareil est autorisé séparément et peut être retiré à tout moment" /></td>
</tr>
<tr>
<td align="center"><sub>Hôtes distants : connexion directe en LAN, relais et SSH</sub></td>
<td align="center"><sub>Partage : chaque appareil est autorisé séparément et peut être retiré à tout moment</sub></td>
</tr>
</table>

### 4. Import des sessions natives

Les historiques de sessions locaux de Claude Code, Codex, Cursor et qoder sont analysés en lecture seule et importés en tant qu'espaces de travail, dans lesquels la conversation peut reprendre directement, sans affecter les données d'origine.

### 5. Workflows par étapes

En plus de la conversation classique, une tâche peut être exécutée par étapes. Une fois le workflow lancé, la conversation passe en mode étapes :

- la progression (étape N sur M), l'étape en cours et l'agent responsable sont affichés en haut ;
- l'agent de l'étape travaille dans la conversation en cours, et ses sorties, appels d'outils et modifications de fichiers restent visibles en permanence ;
- à la fin de chaque étape, le passage à l'étape suivante n'a lieu qu'après confirmation par « Suivant » ; les questions complémentaires et les corrections ne déclenchent pas de réexécution ;
- l'étape de conception produit un document markdown complet (`forge-docs/design.md`), qui sert de contrat commun à tous les agents en aval ;
- les étapes soumises à validation proposent **Approuver**, **Renvoyer** (à refaire avec des annotations) ou **Poser une question**, et il est possible de revenir à une étape précédente.

L'agent, le modèle et le niveau d'autorisation peuvent être définis séparément pour chaque étape. Les workflows et les étapes sont personnalisables et peuvent être enregistrés pour être réutilisés.

### 6. Plusieurs projets en parallèle

Un espace de travail peut contenir plusieurs dépôts. Une étape peut être **répartie par projet** : le frontend, le backend et le SDK sont développés en parallèle par des agents distincts, chacun dans son propre git worktree, et toutes les modifications sont regroupées dans un même panneau de revue. La répartition peut ne porter que sur une partie des dépôts.

### 7. Hooks d'étape

Un hook est une étape auxiliaire insérée entre les étapes. Il peut être placé **avant l'exécution**, **après une étape donnée** ou **après l'exécution**, et sert par exemple à récupérer du code, synchroniser de la documentation, lancer un lint, mettre à jour un tableau de suivi ou envoyer une notification.

Chaque hook s'exécute comme un sous-agent restreint à la racine de l'espace de travail et ne peut utiliser que les compétences et outils qui lui sont attribués. En cas d'échec, le pipeline se met en pause et propose de réessayer, d'ignorer ou d'abandonner. Les hooks sont enregistrés dans une bibliothèque globale et réutilisables dans n'importe quel workflow.

### 8. Compagnon de bureau

Le compagnon de bureau suit l'écran actif, reflète en temps réel l'état d'exécution des agents et peut afficher directement des cartes de confirmation. **Il est compatible avec les compagnons natifs de Codex**, installables depuis la place de marché codex-pets.net, et accepte également des images personnalisées. Un compagnon évolutif, qui grandit progressivement avec le temps d'utilisation, est également disponible.

---

<div align="center">

<img src="assets/screenshots/workflow.jpg" alt="Orchestration des étapes : agent et modèle choisis séparément pour chaque étape, étape de développement répartie sur deux projets" width="90%" />

<sub><b>Orchestration des étapes</b> : un agent et un modèle définis pour chacune des cinq étapes, l'étape de <i>développement</i> étant répartie sur deux dépôts.</sub>

</div>

---

## Agents pris en charge

| Agent | Conversation | Workflow | Reprise native | MCP | Modèles |
|------|:----:|:------:|:--------:|:---:|------|
| **Claude Code** | ✅ | ✅ | ✅ | ✅ | Lus depuis la CLI |
| **Codex** | ✅ | ✅ | ✅ | ✅ | Lus depuis la CLI |
| **Cursor** | ✅ | ✅ | ✅ | ✅ | Lus depuis la CLI |
| **qoder** | ✅ | ✅ | ✅ | ✅ | Lus + personnalisés |
| **opencode** | ✅ | ✅ | ✅ | ✅ | Passerelle multi-fournisseurs |
| **Gemini** | ✅ | ✅ | — | ✅ | Liste prédéfinie |
| **Qwen** | ✅ | ✅ | — | ✅ | Liste prédéfinie |
| **Copilot** | ✅ | ✅ | — | ✅ | Liste prédéfinie |
| **Pi** | ✅ | ✅ | — | — | Défaut du compte / personnalisés |
| **Kimi** | ✅ | ✅ | — | — | kimi-k2.5 · 256K |
| **Reasonix** | ✅ | ✅ | — | — | deepseek-flash / reasoner |
| **Trae** | ✅ | ✅ | — | — | Défaut du compte (`/model` ou `trae_cli.yaml`) |
| **Antigravity** | ✅ | ✅ | ✅ | — | Actualisés via `agy models` |
| **DeepSeek** | ✅ | ✅ | — | — | Défaut du compte |

> **DeepSeek** désigne DeepSeek Harness (`npm install -g @deepseek-ai/dsh`). myFlowForge utilise son profil `headless`, et les trois niveaux d'autorisation correspondent respectivement à `read-only` / `workspace-write` / `danger-full-access`. La clé API se configure via `dsh web` (page Models) ou la variable d'environnement `DEEPSEEK_API_KEY`.
>
> **Trae** (TraeCode CLI de ByteDance) n'est pas publié sur npm. Il doit être installé dans `~/.local/bin` via le script officiel `install.sh`, puis ajouté au PATH. Pour qu'il modifie des fichiers sans supervision dans un workflow, exécutez `traecli config edit` et définissez `permission_mode: bypass_permissions`.

## Déroulement d'un workflow

```
  Décrire l'objectif
         │
         ▼
┌─── hook ───┐ ┌─── hook ───┐                                      ┌─── hook ───┐
│ avant le   │ │ après la   │                                      │ après le   │
│ lancement  │ │ conception │                                      │ lancement  │
└─────┬──────┘ └─────┬──────┘                                      └─────┬──────┘
      ▼              ▼                                                   ▼
   Besoin ──→ Conception ──→ Validation ──→ Développement ──→ Test ──→ Revue
 (clarifier)  (design.md)    (manuelle)     (par projet)   (vérifier) (multi-angle)
                   │                              │
                   │                              └─ un agent par projet,
                   │                                 en parallèle, worktree dédié
                   └─ document complet, lu en entier par tous les agents en aval

 Le passage d'une étape à l'autre requiert chaque fois une confirmation « Suivant ».
 Les étapes peuvent être ajoutées, supprimées, réordonnées ou ignorées,
 par exemple pour n'exécuter que « Besoin → Développement ».
```

Un workflow peut être lancé de trois façons :

1. cliquer sur **Démarrer** dans le panneau des workflows ;
2. saisir `/` dans la zone de saisie et choisir un workflow ;
3. décrire directement la tâche de développement en langage naturel : l'agent principal la reconnaît et soumet une validation de conception via MCP. Les questions générales, les discussions et les petites modifications ne déclenchent pas de workflow.

## Hôtes distants et mobile

| Mode | Description |
|---|---|
| **Direct** | Connexion directe au port du daemon au sein du même réseau local, avec authentification par jeton. |
| **SSH** | Réutilise une connexion SSH existante, sans ouvrir de port supplémentaire. |
| **Relais** | Pour les cas où les deux machines ne peuvent pas communiquer directement. **Chiffrement de bout en bout** : une nouvelle clé est négociée à chaque session, le relais ne transmet que des données chiffrées, et toute trame impossible à déchiffrer est rejetée. Il peut être auto-hébergé (`relay/`, Node et Cloudflare Worker pris en charge) ; la procédure est décrite dans `relay/README.md`. |

Le **daemon Linux** partage le même code que l'application de bureau, sans la partie fenêtrée. Après installation de l'archive tar.gz, il s'exécute sous systemd ; l'appairage se fait en scannant le QR code affiché dans le terminal (voir `docs/linux-deploy.md`).

Le **client mobile** couvre les opérations courantes lorsque vous êtes loin de votre ordinateur : conversation en temps réel (y compris le raisonnement, les appels d'outils et les cartes de sous-agents), demandes d'autorisation et validations de conception, fichiers modifiés et diffs, création d'espaces de travail, modèles de workflow, changement d'hôte et appairage par QR code. Le markdown, les tableaux et les images locales sont rendus nativement ; pour des raisons de confidentialité, les adresses d'images distantes restent affichées sous forme de liens et ne sont pas chargées automatiquement.

## Autres fonctionnalités

- **Passerelle MCP** : un serveur Forge MCP intégré permet aux agents de rappeler l'application : `forge_ask`, `forge_propose_plan`, `forge_write_artifact`, `forge_handoff`, `forge_delegate`, `forge_read_context`, `forge_heartbeat`. Il est injecté automatiquement pour les agents compatibles MCP ; pour les autres, il est remplacé par des instructions textuelles.
- **Serveurs MCP et place de marché de compétences** : consultation des serveurs MCP configurés dans chaque CLI et autorisation depuis l'application ; installation de compétences pour la CLI correspondante depuis la place de marché.
- **Mémoire** : notes enregistrées par espace de travail et lisibles par les agents, pour assurer la continuité du contexte sur les tâches de longue durée.
- **Suivi d'exécution** : affichage en continu du raisonnement, des appels d'outils, des modifications de fichiers et de la sortie brute, avec journaux filtrables, historique des exécutions et historique des modifications tous projets confondus.
- **Quotas et consommation** : quota restant et date de réinitialisation de chaque fournisseur, ainsi que statistiques d'utilisation par espace de travail, agent et date.
- **Passerelle de bots** : traitement des validations, consultation des résultats, lancement de conversations et pilotage des workflows depuis DingTalk, Telegram ou Feishu.
- **Niveaux d'autorisation** : revue en lecture seule, automatique (espace de travail, par défaut) et accès complet, configurables par session ou par étape et convertis dans le périmètre de sandbox effectif de chaque CLI.
- **Commandes slash et compétences** : saisir `/` liste les commandes réellement présentes sur la machine et les compétences installées, filtrées par agent.
- **Navigation dans les fichiers et diffs** : arborescence plein écran avec marqueurs de modification, aperçu avec coloration syntaxique, bascule entre diff et texte intégral.
- **Terminal intégré** : véritable pty, ayant pour racine l'espace de travail, avec proxy et fuseau horaire configurables par provider ; lorsqu'un hôte distant est connecté, le terminal s'exécute sur la machine distante.
- **Apparence** : 6 thèmes originaux, 12 couleurs d'accentuation et plus de 300 fonds d'écran, avec prise en charge d'images personnalisées ; tailles de police réglables séparément pour l'application et la zone de conversation ; génération automatique d'une palette à partir du fond d'écran ; prise en charge du matériau translucide natif de macOS.
- **Images et visualisations dans la conversation** : les images locales générées par les agents s'affichent directement dans les réponses ; les fragments HTML des réponses peuvent être rendus sous forme de cartes, tableaux et diagrammes (désactivé par défaut, reconstruit par liste blanche, sans recours à `innerHTML`).

## Téléchargement et installation

Téléchargez la dernière version depuis la page [**Releases**](https://github.com/flowForges/myFlowForge/releases) :

| Plateforme | Fichier |
|------|------|
| macOS · puce Apple (M1–M4) | `myFlowForge-<version>-arm64.dmg` |
| macOS · Intel | `myFlowForge-<version>.dmg` |
| Windows · x64 | `myFlowForge-<version>-x64-setup.exe` |
| Windows · ARM | `myFlowForge-<version>-arm64-setup.exe` |
| Android | `myFlowForge-<version>.apk` |
| Linux · daemon sans interface | `myFlowForge-daemon-<version>-linux.tar.gz` |
| iOS | TestFlight (sur invitation) |

> Le paquet **macOS** est signé et notarié, et peut être installé directement.
> Le paquet **Windows** n'est pas encore signé ; lorsque SmartScreen affiche un avertissement, choisissez « Informations complémentaires → Exécuter quand même ».
>
> L'application vérifie elle-même les mises à jour et signale les nouvelles versions dès leur publication.

**iOS** est actuellement distribué via TestFlight (sur invitation) ; il est également possible de le compiler et de l'installer avec votre propre identifiant Apple depuis le répertoire `mobile/`.

## Démarrage rapide

**Prérequis :** macOS 11+ / Windows 10+ / une distribution Linux courante, Node.js ≥ 20, git, et au moins une CLI de codage installée et connectée.

```bash
git clone https://github.com/flowForges/myFlowForge.git
cd myFlowForge
npm install
npm run dev          # mode développement, rechargement à chaud du rendu
```

| Commande | Description |
|------|------|
| `npm run dev` | Démarre en mode développement (rechargement à chaud) |
| `npm test` | Exécute la suite de tests complète (Vitest) |
| `npm run typecheck` | Vérifie les deux tsconfig, processus principal et rendu |
| `npm run build` | Build de production |
| `npm run dist:mac-all` | Génère les `.dmg` Intel et puce Apple |
| `npm run dist:win` | Génère l'installateur Windows x64 |
| `npm run check:daemon` | Vérifie le daemon sans interface de bout en bout |

Le client mobile se trouve dans `mobile/` (Expo / React Native) et le service de relais dans `relay/`, chacun avec son propre `package.json`.

Les artefacts de build sont générés dans `release/`. Après une modification de `src/main/**`, Electron doit être entièrement redémarré ; le rechargement à chaud ne s'applique qu'au rendu.

## Pile technique

| Catégorie | Technologie |
|------|------|
| Enveloppe de bureau | [Electron](https://www.electronjs.org/) 42 · [electron-vite](https://electron-vite.org/) |
| Interface | [React](https://react.dev/) 19 · TypeScript 6 |
| Mobile | [Expo](https://expo.dev/) · [React Native](https://reactnative.dev/) |
| Terminal | [xterm.js](https://xtermjs.org/) · [node-pty](https://github.com/microsoft/node-pty) |
| Passerelle agents | [Model Context Protocol SDK](https://modelcontextprotocol.io/) |
| Contrôle des processus | [execa](https://github.com/sindresorhus/execa) |
| Validation des données | [zod](https://zod.dev/) |
| Surveillance des fichiers | [chokidar](https://github.com/paulmillr/chokidar) |
| Tests | [Vitest](https://vitest.dev/) · Testing Library |
| Empaquetage | [electron-builder](https://www.electron.build/) |

## Structure du projet

```
src/
├── main/              # Processus principal Electron
│   ├── agents/        # Adaptateurs CLI, registre des providers, détection et autorisations
│   ├── run/           # Moteur de workflow : étapes, validations, répartition, hooks, passation
│   ├── chat/          # Conversations d'espace de travail, file d'attente et mémoire
│   ├── mcp/           # Serveur Forge MCP (passerelle agent → application)
│   ├── remote/        # Hôtes distants : direct / SSH / relais, routage, canal chiffré de bout en bout
│   ├── daemon/        # Daemon sans interface et appairage par QR code dans le terminal
│   ├── bot/           # Passerelle de bots (DingTalk / Telegram / Feishu)
│   ├── plugins/       # Hôte de plugins, catalogue, planification et points d'extension
│   ├── sessionImport/ # Analyse et import des sessions natives
│   ├── usage/         # Adaptateurs de quotas par fournisseur
│   ├── pet/           # Fenêtre du compagnon de bureau
│   └── ...            # git, système de fichiers, terminal, mises à jour, surveillance, fenêtres, apparence
├── renderer/          # Interface React (vues, composants, paramètres, thèmes, compagnon)
├── preload/           # Passerelle IPC à contexte isolé
└── shared/            # Types et logique pure partagés entre processus
mobile/                # Clients iOS et Android (Expo / React Native)
relay/                 # Relais chiffré de bout en bout (Node ou Cloudflare Worker)
```

## Contribuer

Les issues et les PR sont les bienvenues. Le projet suit le développement piloté par les tests : lorsque vous soumettez une modification, ajoutez ou mettez à jour les tests correspondants et assurez-vous que `npm test` et `npm run typecheck` passent.

## Licence

[MIT License](LICENSE) © 2026 zghua

## Remerciements

Merci aux projets open source Electron, React, Vite et Model Context Protocol, entre autres, ainsi qu'aux différents agents de codage intégrés dans ce projet.

## Liens

- [LINUX DO](https://linux.do/latest) : communauté de développeurs
- [V2EX](https://www.v2ex.com/) : communauté de créatifs
