<div align="center">

<img src="build/icon.png" alt="myFlowForge" width="128" height="128" />

# myFlowForge

**AI コーディングのワークフローを鍛え上げる。**

**Claude Code・Codex・Cursor・Gemini・qoder** を、統制された多段階コーディングパイプラインへとまとめ上げるデスクトップコックピット。計画承認ゲート、ネイティブセッションのインポート、リアルタイムの使用量トラッキング、MCP 連携、そして作業に寄り添うデスクトップペット付き。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-macOS-000000?logo=apple&logoColor=white)

[English](README.md) · [简体中文](README.zh-CN.md) · **日本語**

</div>

---

## myFlowForge とは？

現代の AI コーディングツールは、それぞれが独自のターミナル・独自のセッション状態・独自のクォータを持ち、共有された計画がありません。**myFlowForge** はそれらを一つ屋根の下にまとめ、「AI とのチャット」を**再現可能でレビュー可能なエンジニアリングワークフロー**へと変えます。

やりたいことを説明するだけで、Forge は選んだエージェントを段階的なパイプライン——**要件 → 設計 → 開発 → テスト → レビュー**——に沿って駆動し、**ハードゲート**で一時停止します。コードが一行でも書かれる*前に*、技術計画を承認できるのです。各段階で異なるエージェントとモデルを使え、複数プロジェクトにまたがって並列実行できます。その間、親しみやすいデスクトップペットが進捗を一目で伝えてくれます。

> ⚠️ **プロジェクトの状態：** myFlowForge は活発に開発中の個人プロジェクトで、現在は **macOS**（Apple Silicon および Intel）を対象としています。Electron ベースのためソースから他プラットフォーム向けにビルド可能ですが、現時点でパッケージ化しているのは macOS のみです。

## ✨ ハイライト

- **🎛️ マルチエージェント編成** —— 各ワークフロー段階を、異なるコーディング CLI（Claude Code・Codex・Cursor・Gemini・qoder）と異なるモデルに振り分け。
- **🔄 統制された多段階パイプライン** —— 要件 → 設計 → 開発 → テスト → レビュー。**計画承認のハードゲート**付きで、実行開始前に技術設計をレビューし承認（または差し戻し）。
- **🧩 並列プロジェクト & ワークスペース** —— 複数ワークスペースを同時実行、それぞれ隔離された git worktree を使用。並列レーンで複数エージェントの作業を同時に観察。
- **📥 ネイティブセッションのインポート** —— ローカルの既存 Claude / Codex / Cursor / qoder セッションを読み取り専用でスキャンし、中央インデックスへ取り込んでワークスペースとして再開。
- **📊 リアルタイム使用量トラッキング** —— 実使用量アダプターが各プロバイダーの残りクォータとリセット時刻を表示。
- **🔌 MCP 連携** —— 内蔵の Forge MCP サーバーがエージェントをアプリへ橋渡し（質問・計画提案・成果物の受け渡し）し、ツール駆動の確実な制御を実現。
- **🖥️ リアルタイム可観測性** —— 思考 / 実行 / ファイル変更 / 出力のストリーミングログ、絞り込み可能なログコンソール、プロジェクト横断の変更エビデンス。
- **🐾 デスクトップペット** —— ドラッグ・リサイズ可能な相棒。フォーカス画面に追従し、エージェントの活動をプレビューし、確認カードをポップアップ。エフェクト設定可・複数のペットパック付き。
- **🎨 洗練された UI** —— グラスモーフィズム、ライト/ダークテーマ、7 色のアクセントカラー、リサイズ可能なペイン、通知センター。

## 🤖 対応コーディングエージェント

| エージェント | チャット | ワークフロー実行 | ネイティブ再開 | モデル | MCP |
|--------------|:--------:|:----------------:|:--------------:|:------:|:---:|
| **Claude Code** | ✅ | ✅ | ✅ | 動的検出 | ✅ |
| **Codex** | ✅ | ✅ | ✅ | 動的検出 | ✅ |
| **Cursor** | ✅ | ✅ | ✅ | 動的検出 | — |
| **Gemini** | ✅ | ✅ | — | 動的検出 | — |
| **qoder** | ✅ | ✅ | ✅ | 動的検出 | ✅ |

> モデルは各 CLI の**実際のローカル設定**から動的に検出されます。ハードコードは一切なく、プロバイダーごとにモデル一覧を編集できます。

## 🔧 仕組み

```
      目標を説明
          │
          ▼
   📋 要件  ──►  🎨 設計  ──►  ✋ 計画ゲート  ──►  💻 開発  ──►  🧪 テスト  ──►  🔍 レビュー
   (明確化)     (技術計画)     承認 / 差し戻し       (コード)       (検証)        (監査)
          │                        │
          │                        └─ コードが書かれる*前に*、計画が正しいかを確認
          ▼
   各段階 → 選んだエージェント + モデル、隔離された git worktree、リアルタイムのストリーミングログ
```

ワークフローのトリガーは 3 通り。すべて同じ一つのゲートに集約されます：

1. メインのチャットエージェントが意図を検出し、**`forge_propose_plan`** MCP ツールを呼び出す。
2. スキル駆動のフェンス指示（フォールバック）。
3. 明示的な**「ワークフロー開始」**ボタン。

## 📥 ダウンロードとインストール

最新の `.dmg` は [**Releases**](https://github.com/xzghua/myFLowForge/releases) ページから入手できます：

| お使いの Mac | 推奨ダウンロード |
|--------------|------------------|
| Apple Silicon（M1/M2/M3/M4） | `myFlowForge-<version>-arm64.dmg` またはユニバーサル版 |
| Intel | `myFlowForge-<version>.dmg`（x64）またはユニバーサル版 |
| 不明な場合 | `myFlowForge-<version>-universal.dmg`（両対応） |

> **⚠️ 本アプリはまだコード署名されていません。** 初回起動時、macOS が*「開けません」*または*「壊れています」*と警告する場合がありますが、未署名アプリでは想定内です。開く方法：
> - `/Applications` 内のアプリを**右クリック** → **開く** → ダイアログで**開く**、または
> - ターミナルで一度実行：`xattr -dr com.apple.quarantine /Applications/myFlowForge.app`
>
> myFlowForge はこの Releases フィードで更新を確認し、新バージョンをアプリ内で案内します。

## 🚀 はじめに

### 前提条件

- **macOS**（Apple Silicon または Intel）
- **Node.js** ≥ 20 と **npm**
- 対応コーディング CLI（Claude Code・Codex・Cursor・Gemini・qoder）を 1 つ以上インストール・認証済み。Forge が導入済みのものを検出し、残りのインストールを案内します。

### 開発環境でのインストールと実行

```bash
# 1. クローン
git clone https://github.com/xzghua/myFLowForge.git
cd myFLowForge

# 2. 依存関係のインストール
npm install

# 3. 開発モードで起動（ホットリロード）
npm run dev
```

### よく使うスクリプト

| コマンド | 内容 |
|----------|------|
| `npm run dev` | ホットリロードでアプリ起動 |
| `npm test` | 全テスト実行（Vitest） |
| `npm run typecheck` | メイン + レンダラーの両 tsconfig を型チェック |
| `npm run build` | 本番ビルド |
| `npm run dist` | macOS 配布物（`.dmg`）をビルド |

### 配布物のビルド

```bash
npm run dist            # macOS x64
npm run dist:arm64      # Apple Silicon
npm run dist:universal  # ユニバーサルバイナリ
```

成果物は `release/` に出力されます。

## 🏗️ 技術スタック

- **シェル：** [Electron](https://www.electronjs.org/) 42 + [electron‑vite](https://electron-vite.org/)
- **UI：** [React](https://react.dev/) 19 + TypeScript 6
- **ターミナル：** [xterm.js](https://xtermjs.org/) + [node‑pty](https://github.com/microsoft/node-pty)
- **エージェント橋渡し：** [Model Context Protocol SDK](https://modelcontextprotocol.io/)
- **プロセス制御：** [execa](https://github.com/sindresorhus/execa) · **検証：** [zod](https://zod.dev/) · **ファイル監視：** [chokidar](https://github.com/paulmillr/chokidar)
- **テスト：** [Vitest](https://vitest.dev/) + Testing Library（全面的にテスト駆動開発）
- **パッケージング：** [electron‑builder](https://www.electron.build/)

## 📁 プロジェクト構成

```
src/
├── main/          # Electron メインプロセス
│   ├── agents/    # CLI アダプター（claude・codex・cursor・gemini・qoder）+ providers
│   ├── orchestrator/  # ワークフローエンジンと段階ゲート
│   ├── chat/      # ワークスペースごとのチャット・キュー・メモリ
│   ├── mcp/       # Forge MCP サーバー（エージェント → アプリ の橋）
│   ├── pet/       # デスクトップペットウィンドウ
│   ├── sessionImport/  # ネイティブセッションのスキャンとインポート
│   ├── usage/     # プロバイダーのクォータアダプター
│   └── ...        # git・fs・terminal・update・watcher・windows
├── renderer/      # React UI（views・components・pet・settings・theme）
├── preload/       # コンテキスト分離された IPC ブリッジ
└── shared/        # プロセス間で共有する型
```

## 🤝 コントリビュート

コントリビュート・Issue・機能提案を歓迎します！本プロジェクトは**テスト駆動**のワークフローに従います。変更にはテストの追加・更新をお願いし、PR を出す前に `npm test` と `npm run typecheck` が通ることを確認してください。

## 📄 ライセンス

[MIT ライセンス](LICENSE) のもとで公開 © 2026 zghua。

## 🙏 謝辞

Electron・React・Vite・Model Context Protocol といった優れたオープンソースエコシステム、そして編成対象のコーディングエージェント（Claude Code・Codex・Cursor・Gemini・qoder）の上に構築されています。
