<div align="center">

<img src="build/icon.png" alt="myFlowForge" width="128" height="128" />

# myFlowForge

**ひとつの GUI で、ネイティブの Claude Code、Codex、Cursor などの agent を一元管理し、デバイス間で連携します。**

myFlowForge は、ローカルにインストールされた公式 CLI（Claude Code、Codex、Cursor、Gemini、qoder、opencode、DeepSeek など）を直接呼び出します。agent 自体を改変・置換することはなく、その上に統一された GUI を提供するだけです。同一セッション内での agent とモデルの切り替え、ネイティブセッションのインポート、ステージ型ワークフローの実行、Codex ネイティブペットとの互換に対応し、別のコンピューター、サーバー、スマートフォンからリモート接続することもできます。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-macOS%20·%20Windows%20·%20Linux-000000)
![Mobile](https://img.shields.io/badge/Mobile-iOS%20·%20Android-3DDC84)

[简体中文](README.md) · [English](README.en.md) · **日本語** · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

</div>

---

<div align="center">

<img src="assets/screenshots/home.jpg" alt="ホーム：ワークスペース、実行中の agent、当日の変更" width="90%" />

<sub><b>ホーム</b>：ワークスペース、実行中の agent、当日の変更。壁紙、スキン、アクセントカラーはいずれもカスタマイズできます。</sub>

</div>

---

## プロジェクト概要

各社の AI コーディング CLI はそれぞれ独立したターミナルで動作し、セッション、利用枠、設定は互いに共有されません。そのため、ひとつのタスクが特定のツールに縛られがちです。

myFlowForge はこれらの CLI の上に位置する GUI レイヤーであり、次の 3 つの原則に従います。

- **ネイティブ接続**：公式 CLI を通じて agent を呼び出し、ユーザー自身のアカウント、サブスクリプション、ローカル設定を使用します。agent を fork・改変せず、API key を保存せず、いかなるリクエストもプロキシしません。agent がアップグレードされれば、新しい機能をそのまま利用できます。
- **一元管理**：複数の agent、複数のプロジェクト、複数のセッションを同じ画面で管理でき、タスクが単一のツールに縛られなくなります。
- **マルチデバイス連携**：デスクトップ版、ヘッドレス Linux daemon、iOS / Android クライアントが同じワークスペースとセッションを共有します。LAN 直接接続、SSH、エンドツーエンド暗号化リレーに対応します。

> **プロジェクトの状況：** 個人で保守しており、継続的に開発中です。macOS、Windows、Linux 向けのインストーラーのほか、Android APK と iOS TestFlight を提供しています。macOS 版は Developer ID で署名され Apple の公証を受けており、Android 版は正式な鍵で署名されています。Windows 版は現時点では未署名です。

## 主な機能

### 1. ネイティブ agent 接続

14 のコーディング CLI に対応しています：**Claude Code · Codex · Cursor · Gemini · qoder · opencode · Qwen · Copilot · Pi · Kimi · Reasonix · Trae · Antigravity · DeepSeek**。

myFlowForge が操作するのは、ローカルにインストール済みかつログイン済みの公式 CLI であり、その動作は変更しません。モデル一覧は各 CLI のローカル設定から優先的に読み取り、読み取れない場合はプリセット一覧を使用します。手動で追加することもでき、手動で追加したモデルは更新時に上書きされません。未インストールまたは未ログインの CLI は設定画面に表示され、インストール手順が案内されます。

### 2. 同一セッション内での agent とモデルの切り替え

agent、モデル、権限レベルは各ターンの前に選び直すことができ、コンテキストは途切れません。

- あるモデルの結果が思わしくない場合、別のモデルに切り替えて続行でき、新しいモデルはそれまでの会話をすべて参照できます。
- ある事業者の利用枠を使い切った場合、新しいセッションを開かずに別の事業者に切り替えられます。
- タスクの性質に応じてモデルを割り当てられます。たとえば設計には高性能なモデルを、実装と仕上げには低コストなモデルを使うといった使い分けです。

ネイティブの会話再開に対応する agent（Claude Code、Codex、Cursor、qoder、opencode、Antigravity）は自身のセッション履歴をそのまま使用し、それ以外の agent については myFlowForge がコンテキストを再構築します。

### 3. マルチデバイス連携

- **リモートホスト**：デスクトップ版から別のコンピューターやサーバーに接続し、そのマシン上の agent、リポジトリ、ターミナルを操作できます。現在のホストはステータスバーで切り替え、ワークスペース、セッション、git の変更、内蔵ターミナルもそれに合わせて切り替わります。
- **3 つの接続方式**：LAN 直接接続、SSH、エンドツーエンド暗号化リレー。リレーは暗号文を転送するだけで、セッションの内容を読むことはできません。セルフホストも可能です（Node または Cloudflare Worker）。
- **ヘッドレス daemon**：Linux サーバー上で `myflowforge-daemon` を実行し、`pair` コマンドでターミナルにペアリング用 QR コードを表示します。
- **モバイル**：iOS と Android のクライアントで、会話のリアルタイム表示、権限確認と設計承認の処理、変更と diff の確認、ワークスペースの新規作成、ワークフローの編集、ホストの切り替えができます。
- **デバイス認可**：デバイスごとに個別のペアリングコードを使用し、いつでも個別に削除できます。取り消しは即座に反映されます。

### 4. ネイティブセッションのインポート

ローカルの Claude Code、Codex、Cursor、qoder のセッション履歴を読み取り専用でスキャンし、ワークスペースとしてインポートした後、そのまま会話を続けられます。元のデータには影響しません。

### 5. ステージ型ワークフロー

通常の会話に加えて、タスクをステージごとに実行することもできます。ワークフローを開始すると、会話はステージモードに入ります。

- 上部に現在の進捗（ステップ N / 全 M ステップ）、現在のステージ、担当 agent が表示されます。
- 各ステージの agent は現在の会話の中で作業し、出力、ツール呼び出し、ファイルの変更は常に確認できます。
- 各ステージの完了後、「次へ」を確認するまで次のステージには引き継がれません。追加の質問や修正によって再実行されることはありません。
- 設計ステージでは完全な markdown ドキュメント（`forge-docs/design.md`）が作成され、下流のすべての agent が従う契約となります。
- 承認付きのステージでは **承認**、**差し戻し**（コメントを付けてやり直し）、**質問** が可能で、以前のステージに戻ることもできます。

ステージごとに agent、モデル、権限レベルを個別に指定できます。ワークフローとステージはいずれもカスタマイズでき、保存して再利用できます。

### 6. 複数プロジェクトの並行開発

ひとつのワークスペースに複数のリポジトリを含めることができます。ステージは **プロジェクトごとにファンアウト** でき、フロントエンド、バックエンド、SDK をそれぞれの agent が独立した git worktree で並行して開発し、すべての変更はひとつの変更パネルに集約されてレビューできます。ファンアウトの対象は一部のリポジトリに限定することもできます。

### 7. ステージ Hook

Hook はステージの間に挿入される補助ステップで、**実行前**、**特定のステージの後**、**実行後** に設定できます。コードの取得、ドキュメントの同期、lint の実行、ボードの更新、通知の送信などに使用します。

各 Hook は制限付きのサブ agent としてワークスペースのルートディレクトリで実行され、割り当てられたスキルとツールのみを使用できます。実行に失敗するとパイプラインが一時停止し、再試行、スキップ、中止を選択できます。Hook はグローバルライブラリに保存され、任意のワークフローで再利用できます。

### 8. デスクトップペット

デスクトップペットは現在の画面に追従し、agent の実行状態をリアルタイムに反映し、確認カードを直接表示することもできます。**Codex ネイティブペットに対応** しており、codex-pets.net のペットマーケットからインストールできるほか、カスタム画像も使用できます。また、使用時間に応じて少しずつ成長する育成ペットもあります。

---

<div align="center">

<img src="assets/screenshots/workflow.jpg" alt="ステージ構成：ステージごとに agent とモデルを個別に選択し、開発ステージは 2 つのプロジェクトにファンアウト" width="90%" />

<sub><b>ステージ構成</b>：5 つのステージにそれぞれ agent とモデルを指定し、<i>開発</i>ステージは 2 つのリポジトリにファンアウトします。</sub>

</div>

---

## 対応 agent

| Agent | 会話 | ワークフロー | ネイティブ再開 | MCP | モデル |
|------|:----:|:------:|:--------:|:---:|------|
| **Claude Code** | ✅ | ✅ | ✅ | ✅ | CLI から読み取り |
| **Codex** | ✅ | ✅ | ✅ | ✅ | CLI から読み取り |
| **Cursor** | ✅ | ✅ | ✅ | ✅ | CLI から読み取り |
| **qoder** | ✅ | ✅ | ✅ | ✅ | 読み取り + カスタム |
| **opencode** | ✅ | ✅ | ✅ | ✅ | マルチベンダーゲートウェイ |
| **Gemini** | ✅ | ✅ | — | ✅ | プリセット一覧 |
| **Qwen** | ✅ | ✅ | — | ✅ | プリセット一覧 |
| **Copilot** | ✅ | ✅ | — | ✅ | プリセット一覧 |
| **Pi** | ✅ | ✅ | — | — | アカウントのデフォルト / カスタム |
| **Kimi** | ✅ | ✅ | — | — | kimi-k2.5 · 256K |
| **Reasonix** | ✅ | ✅ | — | — | deepseek-flash / reasoner |
| **Trae** | ✅ | ✅ | — | — | アカウントのデフォルト（`/model` または `trae_cli.yaml`） |
| **Antigravity** | ✅ | ✅ | ✅ | — | `agy models` で更新 |
| **DeepSeek** | ✅ | ✅ | — | — | アカウントのデフォルト |

> **DeepSeek** は DeepSeek Harness（`npm install -g @deepseek-ai/dsh`）を指します。myFlowForge はその `headless` profile を使用し、3 段階の権限はそれぞれ `read-only` / `workspace-write` / `danger-full-access` に対応します。API key は `dsh web`（Models ページ）または環境変数 `DEEPSEEK_API_KEY` で設定できます。
>
> **Trae**（ByteDance の TraeCode CLI）は npm では公開されていないため、公式の `install.sh` で `~/.local/bin` にインストールし、PATH に追加する必要があります。ワークフローで無人のままファイルを変更させる場合は、`traecli config edit` を実行して `permission_mode: bypass_permissions` を設定してください。

## ワークフローの実行フロー

```
   目標を記述
     │
     ▼
 ┌─ hook ─┐   ┌─ hook ─┐                                           ┌─ hook ─┐
 │ 実行前 │   │ 設計後 │                                           │ 実行後 │
 └───┬────┘   └───┬────┘                                           └───┬────┘
     ▼            ▼                                                    ▼
   要件 ──────→ 設計 ──────→ 承認 ───────→ 開発 ───────→ テスト ──→ レビュー
 (明確化)    (design.md)    (人間)     (ファンアウト)     (検証)     (多観点)
                  │                         │
                  │                         └─ プロジェクトごとに 1 つの agent、
                  │                            独立した worktree で並行実行
                  └─ 完全なドキュメント。下流のすべての agent が全文を読む

 各ステージの間では「次へ」の確認が必要です。ステージは追加・削除・並べ替え・
 スキップが可能で、たとえば「要件 → 開発」だけを実行することもできます。
```

ワークフローを開始する方法は 3 つあります。

1. ワークフローパネルで **開始** をクリックする。
2. 入力欄に `/` を入力してワークフローを選択する。
3. 開発タスクを自然言語でそのまま記述する。メイン agent がそれを認識し、MCP を通じて設計承認を開始します。一般的な質問、議論、小さな変更ではトリガーされません。

## リモートホストとモバイル

| 方式 | 説明 |
|---|---|
| **直接接続** | 同一 LAN 内で daemon のポートに直接接続し、トークンで認証します。 |
| **SSH** | 既存の SSH ログインを再利用し、追加のポートを開放する必要はありません。 |
| **リレー** | 2 台のマシンが直接通信できない場合に使用します。**エンドツーエンド暗号化**：セッションごとに新しい鍵をネゴシエートし、リレーは暗号文を転送するだけで、復号できないフレームはすべて破棄されます。セルフホストも可能です（`relay/`、Node と Cloudflare Worker に対応）。手順は `relay/README.md` を参照してください。 |

**Linux daemon** はデスクトップ版と同じコードベースで、ウィンドウ部分を取り除いたものです。tar.gz をインストールして systemd で実行し、ターミナルに表示される QR コードをスキャンすればペアリングが完了します（`docs/linux-deploy.md` を参照）。

**モバイル版** は、コンピューターから離れているときによく使う操作をカバーします。リアルタイムの会話（思考過程、ツール呼び出し、サブ agent カードを含む）、権限確認と設計承認、変更ファイルと diff、ワークスペースの新規作成、ワークフローテンプレート、ホストの切り替えと QR コードによるペアリングです。markdown、表、ローカル画像はネイティブに描画されます。プライバシーへの配慮から、リモート画像の URL はリンクのまま残し、自動では読み込みません。

## その他の機能

- **MCP ブリッジ**：agent からアプリを呼び出すための Forge MCP サーバーを内蔵しています：`forge_ask`、`forge_propose_plan`、`forge_write_artifact`、`forge_handoff`、`forge_delegate`、`forge_read_context`、`forge_heartbeat`。MCP に対応する agent には自動で注入され、それ以外はテキスト指示にフォールバックします。
- **MCP サーバーとスキルマーケット**：各 CLI に設定済みの MCP サーバーを確認し、アプリ内で認可できます。スキルマーケットから対応する CLI にスキルをインストールできます。
- **メモリ**：ワークスペースごとにメモを保存し、agent がそれを読み取れるため、長期的なタスクでもコンテキストを引き継げます。
- **実行の可観測性**：思考、ツール呼び出し、ファイルの変更、生の出力をストリーミング表示し、絞り込み可能なログ、実行履歴、プロジェクト横断の変更記録を提供します。
- **利用枠と使用量**：各事業者の残り利用枠とリセット時刻、およびワークスペース、agent、日付別の使用量を表示します。
- **ボットブリッジ**：DingTalk、Telegram、Feishu 上で承認の処理、結果の確認、会話の開始、ワークフローの実行ができます。
- **権限レベル**：読み取り専用レビュー、自動（ワークスペース、デフォルト）、フルアクセス。セッション単位またはステージ単位で設定でき、各 CLI の実際のサンドボックス範囲に対応付けられます。
- **スラッシュコマンドとスキル**：`/` を入力すると、ローカルに実在するコマンドとインストール済みのスキルが一覧表示され、agent ごとに絞り込まれます。
- **ファイルブラウザと diff**：全画面のファイルツリーと変更マーク、シンタックスハイライト付きプレビュー、diff と全文表示の切り替え。
- **内蔵ターミナル**：ワークスペースをルートとする本物の pty で、provider ごとにプロキシとタイムゾーンを設定できます。リモートホストに接続している場合、ターミナルはリモートマシン上で動作します。
- **外観**：オリジナルスキン 6 種、アクセントカラー 12 色、300 枚以上の壁紙を備え、カスタム画像にも対応します。アプリと会話エリアのフォントサイズは個別に設定できます。壁紙から配色を自動生成でき、macOS ネイティブのすりガラス素材にも対応します。
- **会話内の画像と可視化**：agent が生成したローカル画像は返信内にそのまま表示されます。返信内の HTML 断片はカード、表、図として描画できます（デフォルトはオフ。許可リストに基づいて再構築し、`innerHTML` は使用しません）。

## ダウンロードとインストール

[**Releases**](https://github.com/flowForges/myFlowForge/releases) ページから最新版をダウンロードしてください。

| プラットフォーム | ファイル |
|------|------|
| macOS · Apple シリコン（M1–M4） | `myFlowForge-<バージョン>-arm64.dmg` |
| macOS · Intel | `myFlowForge-<バージョン>.dmg` |
| Windows · x64 | `myFlowForge-<バージョン>-x64-setup.exe` |
| Windows · ARM | `myFlowForge-<バージョン>-arm64-setup.exe` |
| Android | `myFlowForge-<バージョン>.apk` |
| Linux · ヘッドレス daemon | `myFlowForge-daemon-<バージョン>-linux.tar.gz` |
| iOS | TestFlight（招待制） |

> **macOS** 版のインストーラーは署名・公証済みで、そのままインストールできます。
> **Windows** 版のインストーラーは現時点では未署名です。SmartScreen の警告が表示された場合は「詳細情報 → 実行」を選択してください。
>
> アプリには更新チェック機能が組み込まれており、新しいバージョンが公開されるとアプリ内で通知されます。

**iOS** は現在 TestFlight（招待制）で配布しています。`mobile/` ディレクトリで自分の Apple ID を使ってビルドし、インストールすることもできます。

## クイックスタート

**動作要件：** macOS 11+ / Windows 10+ / 主要な Linux ディストリビューション、Node.js ≥ 20、git、およびインストール済みかつログイン済みのコーディング CLI が少なくとも 1 つ。

```bash
git clone https://github.com/flowForges/myFlowForge.git
cd myFlowForge
npm install
npm run dev          # 開発モード、レンダラーのホットリロード
```

| コマンド | 説明 |
|------|------|
| `npm run dev` | 開発モードで起動（ホットリロード） |
| `npm test` | テストスイート全体を実行（Vitest） |
| `npm run typecheck` | メインプロセスとレンダラーの 2 つの tsconfig をチェック |
| `npm run build` | 本番ビルド |
| `npm run dist:mac-all` | Intel と Apple シリコンの `.dmg` を同時にパッケージ |
| `npm run dist:win` | Windows x64 インストーラーをパッケージ |
| `npm run check:daemon` | ヘッドレス daemon をエンドツーエンドで検証 |

モバイル版は `mobile/`（Expo / React Native）、リレーサービスは `relay/` にあり、それぞれ独立した `package.json` を持ちます。

ビルド成果物は `release/` に出力されます。`src/main/**` を変更した後は Electron を完全に再起動する必要があります。ホットリロードはレンダラーにのみ適用されます。

## 技術スタック

| 分類 | 技術 |
|------|------|
| デスクトップシェル | [Electron](https://www.electronjs.org/) 42 · [electron-vite](https://electron-vite.org/) |
| UI | [React](https://react.dev/) 19 · TypeScript 6 |
| モバイル | [Expo](https://expo.dev/) · [React Native](https://reactnative.dev/) |
| ターミナル | [xterm.js](https://xtermjs.org/) · [node-pty](https://github.com/microsoft/node-pty) |
| Agent ブリッジ | [Model Context Protocol SDK](https://modelcontextprotocol.io/) |
| プロセス制御 | [execa](https://github.com/sindresorhus/execa) |
| データ検証 | [zod](https://zod.dev/) |
| ファイル監視 | [chokidar](https://github.com/paulmillr/chokidar) |
| テスト | [Vitest](https://vitest.dev/) · Testing Library |
| パッケージング | [electron-builder](https://www.electron.build/) |

## プロジェクト構成

```
src/
├── main/              # Electron メインプロセス
│   ├── agents/        # CLI アダプター、provider レジストリ、検出と権限
│   ├── run/           # ワークフローエンジン：ステージ、承認、ファンアウト、hook、引き継ぎ
│   ├── chat/          # ワークスペースの会話、キュー、メモリ
│   ├── mcp/           # Forge MCP サーバー（agent → アプリのブリッジ）
│   ├── remote/        # リモートホスト：直接接続 / SSH / リレー、ルーティング、E2E 暗号化チャネル
│   ├── daemon/        # ヘッドレス daemon とターミナル QR コードによるペアリング
│   ├── bot/           # ボットブリッジ（DingTalk / Telegram / Feishu）
│   ├── plugins/       # プラグインホスト、カタログ、スケジューリング、拡張ポイント
│   ├── sessionImport/ # ネイティブセッションのスキャンとインポート
│   ├── usage/         # 各事業者の利用枠アダプター
│   ├── pet/           # デスクトップペットのウィンドウ
│   └── ...            # git、ファイルシステム、ターミナル、更新、監視、ウィンドウ、外観
├── renderer/          # React UI（ビュー、コンポーネント、設定、テーマ、ペット）
├── preload/           # コンテキスト分離された IPC ブリッジ
└── shared/            # プロセス間で共有する型と純粋なロジック
mobile/                # iOS と Android のクライアント（Expo / React Native）
relay/                 # エンドツーエンド暗号化リレー（Node または Cloudflare Worker）
```

## コントリビューション

issue と PR を歓迎します。本プロジェクトはテスト駆動開発を採用しています。変更を提出する際は、対応するテストを追加または更新し、`npm test` と `npm run typecheck` が通ることを確認してください。

## ライセンス

[MIT License](LICENSE) © 2026 zghua

## 謝辞

Electron、React、Vite、Model Context Protocol などのオープンソースプロジェクト、ならびに本プロジェクトが接続する各社のコーディング agent に感謝します。

## 関連リンク

- [LINUX DO](https://linux.do/latest)：開発者コミュニティ
- [V2EX](https://www.v2ex.com/)：クリエイティブワーカーのコミュニティ
