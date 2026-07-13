<div align="center">

<img src="build/icon.png" alt="myFlowForge" width="128" height="128" />

# myFlowForge

**AIコーディングのワークフローを鍛え上げよう。**

**Claude Code、Codex、Cursor、Gemini、qoder、opencode** を、統制の取れたマルチステージのコーディングパイプラインへとオーケストレーションするデスクトップ・コックピット。プラン承認ゲート、ネイティブセッションのインポート、リアルタイムの使用量トラッキング、MCP連携、そしてあなたに寄り添うデスクトップペットを備えています。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-macOS-000000?logo=apple&logoColor=white)

[English](README.md) · [简体中文](README.zh-CN.md) · **日本語** · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

</div>

---

## 📸 スクリーンショット

<div align="center">

<img src="assets/screenshots/home.jpg" alt="ホーム画面 — ワークスペース、本日の変更、ローカル時刻の挨拶" width="90%" />

<sub><b>ホーム</b> — 続きから始める:ワークスペース、稼働中のエージェント、本日の変更がひと目で。</sub>

<br /><br />

<img src="assets/screenshots/workspace.jpg" alt="ワークスペース — 多段階ワークフローパネル、チャット、変更/ファイル検査" width="90%" />

<sub><b>ワークスペース</b> — 多段階ワークフローパネル、エージェント別チャット、リアルタイムの変更/ファイル検査 — デスクトップペット付き。</sub>

</div>

---

## myFlowForge とは？

現代のAIコーディングツールは、それぞれが独自のターミナル、独自のセッション状態、独自のクォータを持ち、共有された計画を持たずに個別に存在しています。**myFlowForge** はそれらすべてを一つ屋根の下にまとめ、「AIとチャットする」ことを **再現可能でレビュー可能なエンジニアリングワークフロー** へと変えます。

あなたが望むものを説明すれば、Forge が選択したエージェントを、段階的なパイプライン **要件定義 → 設計 → 開発 → テスト → レビュー** に沿って進めます。**ハードゲート** で一時停止し、コードが一行でも書かれる *前に* 技術プランを承認できます。各ステージは異なるエージェントとモデルで、複数のプロジェクトにまたがって並行して実行でき、その間フレンドリーなデスクトップペットが今何が起きているかを一目で見せてくれます。

> ⚠️ **プロジェクトのステータス:** myFlowForge は活発に開発中の個人プロジェクトです。現在は **macOS**（Apple Silicon および Intel）を対象としています。Electron ベースであるため、ソースから他のプラットフォーム向けにビルドすることもできますが、現時点でパッケージ化されているのは macOS のみです。

## ✨ ハイライト

- **🎛️ マルチエージェント・オーケストレーション** — 各ワークフローステージを、異なるコーディングCLI（Claude Code、Codex、Cursor、Gemini、qoder、opencode）と異なるモデルへルーティングします。**opencode** はそれ自体がマルチプロバイダのゲートウェイであり、一度接続すれば多数のモデルベンダーにアクセスできます。
- **📂 エディタで開く** — タイトルバーの「場所を開く」ボタンがインストール済みのエディタ（VS Code、Cursor、JetBrains、Zed、Finder、ターミナルなど）を検出し、現在のワークスペース、またはプレビュー中のファイルを、選んだアプリで開きます。選択はデフォルトとして記憶されます。
- **⌨️ チャットのスラッシュコマンド** — チャットで `/` を入力すると、ワークフローのトリガーに加え、**ディスク上の実際のコマンド／プロンプトやインストール済みのスキル** のメニューが表示され、エージェントごとにフィルタリングされます。
- **🔄 統制されたマルチステージ・パイプライン** — 要件定義 → 設計 → 開発 → テスト → レビュー。**ハードなプラン承認ゲート** を備え、実行が始まる前に技術設計をレビューして承認（または却下）します。
- **✂️ 選択的でトークン効率の良い実行** — 設定済みのワークフローは、もはやすべてのタスクをすべてのプロジェクトの全ステージに強制的に通すことはありません。小さなタスクを平易な言葉で説明すると、オーケストレーションを担うエージェントが **絞り込まれたプラン** を提案します。必要なステージだけを実行し（例: テスト／レビューをスキップ）、各ステージの対象をプロジェクトの一部に絞れます（例: 5つすべてを分析し、コードを書くのは2つだけ）。承認カードには、確定する前に実際に何が実行されるかが正確に表示されます。
- **🧭 オーケストレーターであり、実行者ではない** — メインのチャットエージェントはコードを書いたり、独自の内部サブエージェントを生成したりすることは決してありません。タスクを分解し、実際に手を動かすステップはすべて Forge の本物のオーケストレーション済みサブエージェントに委任するだけです。
- **🧩 並行するプロジェクトとワークスペース** — 複数のワークスペースを同時に実行し、それぞれが独立した git worktree を持ちます。複数のエージェントが並列レーンで並んで作業する様子を見られます。
- **📥 ネイティブセッションのインポート** — 既存のローカルの Claude / Codex / Cursor / qoder セッションを読み取り専用でスキャン・インポートして中央インデックスに取り込み、ワークスペースとして再開できます。
- **📊 リアルタイムの使用量・クォータトラッキング** — 実際の使用量アダプタが、各プロバイダの残りクォータとリセット時刻を表示します。
- **🔌 MCP連携** — 組み込みの Forge MCP サーバがエージェントをアプリへ橋渡しし（質問する、プランを提案する、成果物を引き渡す）、信頼性の高いツール駆動の制御を実現します。
- **🖥️ リアルタイムの可観測性** — 思考／実行／ファイル変更／出力ログのストリーミング、フィルタ可能なログコンソール、そしてプロジェクト横断の変更エビデンス。
- **🐾 デスクトップペット** — ドラッグ＆リサイズ可能なコンパニオンが、あなたのフォーカスを追い、エージェントの活動をプレビューし、確認カードをポップアップします。エフェクトは設定可能で、複数のペットパックが用意されています。
- **🎨 洗練され、パーソナライズ可能なUI** — グラスモーフィズム、**6つのテーマ**（ライト／ダーク／自動 ＋ ミッドナイト／セピア／フォレスト）、**12のアクセントカラー**、**カスタム背景画像**（アプリ全体またはチャットエリア、不透明度を調整可能）、ローカル時刻に応じたリアルタイムの挨拶を備えた再設計されたホームダッシュボード、リサイズ可能なペイン、そして通知センター。

## 🤖 サポートされるコーディングエージェント

| エージェント | チャット | ワークフロー実行 | ネイティブ再開 | モデル | MCP |
|-------|:----:|:------------:|:-------------:|:------:|:---:|
| **Claude Code** | ✅ | ✅ | ✅ | 動的 | ✅ |
| **Codex** | ✅ | ✅ | ✅ | 動的 | ✅ |
| **Cursor** | ✅ | ✅ | ✅ | 動的 | — |
| **Gemini** | ✅ | ✅ | — | 動的 | — |
| **qoder** | ✅ | ✅ | ✅ | 動的 | ✅ |
| **opencode** | ✅ | ✅ | ✅ | 動的（マルチベンダー） | — |

> モデルは各CLIの実際のローカル設定から検出されます。ハードコードされたものは何もなく、プロバイダごとにモデルリストを編集できます。**opencode** は `opencode models` からモデルを検出するため、単一の連携で、そこに設定したすべてのプロバイダを取り込めます。

## 🔧 動作の仕組み

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

ワークフローを起動する方法は3つあり、いずれも同じ単一のゲートに収束します。

1. メインのチャットエージェントが意図を検出し、**`forge_propose_plan`** MCPツールを呼び出す。
2. フォールバックとしての、スキル駆動のフェンス付きディレクティブ。
3. 明示的な **「ワークフローを開始」** ボタン。

## 📥 ダウンロードとインストール

最新の `.dmg` を [**Releases**](https://github.com/flowForges/myFlowForge/releases) ページから入手してください。

| あなたのMac | 推奨ダウンロード |
|----------|----------------------|
| Apple Silicon (M1/M2/M3/M4) | `myFlowForge-<version>-arm64.dmg` またはユニバーサルビルド |
| Intel | `myFlowForge-<version>.dmg`（x64）またはユニバーサルビルド |
| 分からない場合 | `myFlowForge-<version>-universal.dmg` — 両方で動作します |

> **⚠️ このアプリはまだコード署名されていません。** 初回起動時、macOS がアプリを *「開けません」* または *「壊れています」* と警告することがあります。これは未署名アプリでは想定される動作です。開くには次のいずれかを行ってください。
> - `/Applications` にあるアプリを **右クリック** → **開く** → ダイアログで **開く**、または
> - ターミナルで一度だけ実行: `xattr -dr com.apple.quarantine /Applications/myFlowForge.app`
>
> myFlowForge はこの Releases フィードで更新をチェックし、より新しいバージョンをアプリ内で提供します。

## 🚀 はじめかた

### 前提条件

- **macOS**（Apple Silicon または Intel）
- **Node.js** ≥ 20 と **npm**
- サポートされるコーディングCLI（Claude Code、Codex、Cursor、Gemini、qoder）のいずれか1つ以上がインストールされ、認証済みであること。Forge はあなたが持っているものを検出し、残りのインストールをガイドします。

### 開発環境でのインストールと実行

```bash
# 1. Clone
git clone https://github.com/flowForges/myFlowForge.git
cd myFlowForge

# 2. Install dependencies
npm install

# 3. Launch in dev mode (hot reload)
npm run dev
```

### 便利なスクリプト

| コマンド | 内容 |
|---------|--------------|
| `npm run dev` | ホットリロード付きでアプリを起動 |
| `npm test` | フルテストスイートを実行（Vitest） |
| `npm run typecheck` | main と renderer 両方の tsconfig を型チェック |
| `npm run build` | 本番バンドルをビルド |
| `npm run dist` | macOS 配布物（`.dmg`）をビルド |

### 配布物のビルド

```bash
npm run dist            # macOS x64
npm run dist:arm64      # Apple Silicon
npm run dist:universal  # Universal binary
```

成果物は `release/` に出力されます。

## 🏗️ 技術スタック

- **シェル:** [Electron](https://www.electronjs.org/) 42 + [electron‑vite](https://electron-vite.org/)
- **UI:** [React](https://react.dev/) 19 + TypeScript 6
- **ターミナル:** [xterm.js](https://xtermjs.org/) + [node‑pty](https://github.com/microsoft/node-pty)
- **エージェントブリッジ:** [Model Context Protocol SDK](https://modelcontextprotocol.io/)
- **プロセス制御:** [execa](https://github.com/sindresorhus/execa) · **バリデーション:** [zod](https://zod.dev/) · **ファイル監視:** [chokidar](https://github.com/paulmillr/chokidar)
- **テスト:** [Vitest](https://vitest.dev/) + Testing Library（全体を通してテスト駆動開発）
- **パッケージング:** [electron‑builder](https://www.electron.build/)

## 📁 プロジェクト構成

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

## 🤝 コントリビュート

コントリビューション、Issue、機能リクエストを歓迎します！ このプロジェクトは **テスト駆動** のワークフローに従っています。変更にはテストを追加または更新し、PRを開く前に `npm test` と `npm run typecheck` が通ることを確認してください。

## 📄 ライセンス

[MIT License](LICENSE) の下で公開 © 2026 zghua。

## 🙏 謝辞

Electron、React、Vite、そして Model Context Protocol を取り巻く優れたオープンソースエコシステム、そしてオーケストレーション対象のコーディングエージェント（Claude Code、Codex、Cursor、Gemini、qoder）の上に構築されています。
