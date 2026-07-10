<div align="center">

<img src="build/icon.png" alt="myFlowForge" width="128" height="128" />

# myFlowForge

**당신의 AI 코딩 워크플로우를 벼려내세요.**

**Claude Code, Codex, Cursor, Gemini, qoder & opencode** 를 하나의 통제된 다단계 코딩 파이프라인으로 오케스트레이션하는 데스크톱 콕핏 — 계획 승인 게이트, 네이티브 세션 가져오기, 실시간 사용량 추적, MCP 통합, 그리고 곁을 지켜주는 데스크톱 펫까지 갖췄습니다.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-macOS-000000?logo=apple&logoColor=white)

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **한국어** · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

</div>

---

## myFlowForge란 무엇인가요?

최신 AI 코딩 도구들은 저마다 자기 터미널, 자기 세션 상태, 자기 할당량 속에서 따로 살아가며 공유된 계획이 없습니다. **myFlowForge** 는 이 모두를 한 지붕 아래로 모아 "AI와 대화하기"를 **반복 가능하고 검토 가능한 엔지니어링 워크플로우**로 바꿔줍니다.

당신이 원하는 바를 설명하면, Forge가 선택한 에이전트들을 단계별 파이프라인 — **요구사항 → 설계 → 개발 → 테스트 → 리뷰** — 을 통해 이끌어 갑니다. 그리고 **하드 게이트**에서 멈춰, 단 한 줄의 코드가 작성되기 *전에* 기술 계획을 당신이 승인할 수 있게 합니다. 각 단계는 서로 다른 에이전트와 모델을 사용해, 여러 프로젝트에 걸쳐 병렬로 실행할 수 있으며, 다정한 데스크톱 펫이 지금 무슨 일이 일어나는지 한눈에 보여줍니다.

> ⚠️ **프로젝트 상태:** myFlowForge는 활발히 개발 중인 개인 프로젝트입니다. 현재 **macOS** (Apple Silicon & Intel) 를 대상으로 합니다. Electron 기반이므로 소스로부터 다른 플랫폼용으로도 빌드할 수 있지만, 오늘 기준 패키징되는 것은 macOS뿐입니다.

## ✨ 주요 특징

- **🎛️ 멀티 에이전트 오케스트레이션** — 각 워크플로우 단계를 서로 다른 코딩 CLI (Claude Code, Codex, Cursor, Gemini, qoder, opencode) 와 서로 다른 모델로 라우팅합니다. **opencode** 자체가 멀티 프로바이더 게이트웨이여서 — 한 번만 연결하면 다양한 모델 벤더에 닿을 수 있습니다.
- **📂 에디터에서 열기** — 타이틀바의 "위치 열기" 버튼이 설치된 에디터 (VS Code, Cursor, JetBrains, Zed, Finder, 터미널…) 를 감지해 현재 워크스페이스 — 또는 미리 보고 있는 파일 — 를 원하는 것으로 열고, 그 선택을 기본값으로 기억합니다.
- **⌨️ 채팅 슬래시 명령** — 채팅에서 `/` 를 입력하면 워크플로우 트리거 메뉴와 함께 **실제 디스크에 있는 명령/프롬프트 및 설치된 스킬**이 에이전트별로 필터링되어 나타납니다.
- **🔄 통제된 다단계 파이프라인** — 요구사항 → 설계 → 개발 → 테스트 → 리뷰, 그리고 **하드 계획 승인 게이트**: 실행이 시작되기 전에 기술 설계를 검토하고 승인 (또는 거부) 합니다.
- **✂️ 선택적이고 토큰 효율적인 실행** — 구성된 워크플로우가 더 이상 모든 작업을 모든 프로젝트의 모든 단계로 억지로 통과시키지 않습니다. 작은 작업을 평이한 언어로 설명하면 오케스트레이션 에이전트가 **간소화된 계획**을 제안합니다 — 필요한 단계만 실행하고 (예: 테스트/리뷰 건너뛰기), 각 단계의 범위를 일부 프로젝트로 한정합니다 (예: 다섯 개 모두 분석하되 두 개에서만 코드 작성). 승인 카드는 당신이 확정하기 전에 무엇이 실행될지를 정확히 보여줍니다.
- **🧭 실행자가 아닌 오케스트레이터** — 메인 채팅 에이전트는 절대 코드를 작성하거나 자체 내부 서브 에이전트를 만들지 않습니다. 오직 작업을 분해하고, 손을 쓰는 모든 단계를 Forge의 실제 오케스트레이션된 서브 에이전트에 위임할 뿐입니다.
- **🧩 병렬 프로젝트 & 워크스페이스** — 여러 워크스페이스를 각각 격리된 git worktree로 동시에 실행하고, 여러 에이전트가 병렬 레인에서 나란히 작업하는 모습을 지켜보세요.
- **📥 네이티브 세션 가져오기** — 기존 로컬 Claude / Codex / Cursor / qoder 세션을 읽기 전용으로 스캔하여 중앙 인덱스로 가져온 뒤, 워크스페이스로 이어서 진행합니다.
- **📊 실시간 사용량 & 할당량 추적** — 실제 사용량 어댑터가 각 프로바이더의 남은 할당량과 리셋 시각을 드러냅니다.
- **🔌 MCP 통합** — 내장된 Forge MCP 서버가 에이전트를 앱으로 다시 이어주어 (질문하기, 계획 제안하기, 산출물 넘기기) 도구 기반의 신뢰할 수 있는 제어를 제공합니다.
- **🖥️ 실시간 관측 가능성** — 스트리밍되는 사고 / 실행 / 파일 변경 / 출력 로그, 필터링 가능한 로그 콘솔, 그리고 프로젝트 간 변경 증거.
- **🐾 데스크톱 펫** — 당신의 포커스를 따라다니고, 에이전트 활동을 미리 보여주며, 확인 카드를 팝업으로 띄우는, 드래그 및 크기 조절이 가능한 동반자 — 설정 가능한 이펙트와 여러 펫 팩을 갖췄습니다.
- **🎨 세련되고 개인화 가능한 UI** — 글래스모피즘, **6가지 테마** (light / dark / auto + midnight / sepia / forest), **12가지 강조 색상**, **커스텀 배경 이미지** (앱 전체 또는 채팅 영역, 투명도 조절 가능), 실시간 현지 시각 인사말이 있는 재설계된 홈 대시보드, 크기 조절 가능한 패널, 그리고 알림 센터.

## 🤖 지원 코딩 에이전트

| 에이전트 | 채팅 | 워크플로우 실행 | 네이티브 이어가기 | 모델 | MCP |
|-------|:----:|:------------:|:-------------:|:------:|:---:|
| **Claude Code** | ✅ | ✅ | ✅ | 동적 | ✅ |
| **Codex** | ✅ | ✅ | ✅ | 동적 | ✅ |
| **Cursor** | ✅ | ✅ | ✅ | 동적 | — |
| **Gemini** | ✅ | ✅ | — | 동적 | — |
| **qoder** | ✅ | ✅ | ✅ | 동적 | ✅ |
| **opencode** | ✅ | ✅ | ✅ | 동적 (멀티 벤더) | — |

> 모델은 각 CLI의 실제 로컬 구성에서 발견됩니다 — 하드코딩된 것은 전혀 없으며, 프로바이더별로 모델 목록을 편집할 수 있습니다. **opencode** 는 `opencode models` 에서 모델을 발견하므로, 단 하나의 통합으로 그 안에 구성해 둔 모든 프로바이더를 끌어옵니다.

## 🔧 작동 방식

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

워크플로우를 트리거하는 세 가지 방법, 모두 동일한 단일 게이트로 수렴합니다:

1. 메인 채팅 에이전트가 의도를 감지하고 **`forge_propose_plan`** MCP 도구를 호출합니다.
2. 폴백으로서의 스킬 기반 펜스드 지시문(directive).
3. 명시적인 **"워크플로우 시작"** 버튼.

## 📥 다운로드 & 설치

[**Releases**](https://github.com/xzghua/myFlowForge/releases) 페이지에서 최신 `.dmg` 를 받으세요:

| 당신의 Mac | 권장 다운로드 |
|----------|----------------------|
| Apple Silicon (M1/M2/M3/M4) | `myFlowForge-<version>-arm64.dmg` 또는 유니버설 빌드 |
| Intel | `myFlowForge-<version>.dmg` (x64) 또는 유니버설 빌드 |
| 잘 모르겠다면 | `myFlowForge-<version>-universal.dmg` — 둘 다에서 동작 |

> **⚠️ 이 앱은 아직 코드 서명이 되어 있지 않습니다.** 첫 실행 시 macOS가 앱을 *"열 수 없습니다"* 또는 *"손상되었습니다"* 라고 경고할 수 있습니다. 서명되지 않은 앱에서는 예상되는 동작입니다. 열려면:
> - `/Applications` 에서 앱을 **우클릭** → **열기** → 대화상자에서 **열기**, **또는**
> - 터미널에서 한 번 실행: `xattr -dr com.apple.quarantine /Applications/myFlowForge.app`
>
> myFlowForge는 이 Releases 피드에서 업데이트를 확인하고 앱 내에서 더 새로운 버전을 제안합니다.

## 🚀 시작하기

### 사전 준비물

- **macOS** (Apple Silicon 또는 Intel)
- **Node.js** ≥ 20 및 **npm**
- 지원되는 코딩 CLI 중 하나 이상이 설치되고 인증되어 있어야 합니다 (Claude Code, Codex, Cursor, Gemini, qoder). Forge는 당신이 가진 것을 감지하고 나머지를 설치하도록 안내합니다.

### 개발 모드로 설치 & 실행

```bash
# 1. Clone
git clone https://github.com/xzghua/myFlowForge.git
cd myFlowForge

# 2. Install dependencies
npm install

# 3. Launch in dev mode (hot reload)
npm run dev
```

### 유용한 스크립트

| 명령 | 하는 일 |
|---------|--------------|
| `npm run dev` | 핫 리로드로 앱 시작 |
| `npm test` | 전체 테스트 스위트 실행 (Vitest) |
| `npm run typecheck` | 메인 & 렌더러 tsconfig 모두 타입 체크 |
| `npm run build` | 프로덕션 번들 빌드 |
| `npm run dist` | macOS 배포본 (`.dmg`) 빌드 |

### 배포본 빌드하기

```bash
npm run dist            # macOS x64
npm run dist:arm64      # Apple Silicon
npm run dist:universal  # Universal binary
```

산출물은 `release/` 에 기록됩니다.

## 🏗️ 기술 스택

- **셸:** [Electron](https://www.electronjs.org/) 42 + [electron‑vite](https://electron-vite.org/)
- **UI:** [React](https://react.dev/) 19 + TypeScript 6
- **터미널:** [xterm.js](https://xtermjs.org/) + [node‑pty](https://github.com/microsoft/node-pty)
- **에이전트 브리지:** [Model Context Protocol SDK](https://modelcontextprotocol.io/)
- **프로세스 제어:** [execa](https://github.com/sindresorhus/execa) · **검증:** [zod](https://zod.dev/) · **파일 감시:** [chokidar](https://github.com/paulmillr/chokidar)
- **테스트:** [Vitest](https://vitest.dev/) + Testing Library (전반에 걸쳐 테스트 주도 개발)
- **패키징:** [electron‑builder](https://www.electron.build/)

## 📁 프로젝트 구조

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

## 🤝 기여하기

기여, 이슈, 기능 요청을 환영합니다! 이 프로젝트는 **테스트 주도** 워크플로우를 따릅니다 — 변경 사항과 함께 테스트를 추가하거나 업데이트하고, PR을 열기 전에 `npm test` 와 `npm run typecheck` 가 통과하는지 확인해 주세요.

## 📄 라이선스

[MIT License](LICENSE) 하에 배포됩니다 © 2026 zghua.

## 🙏 감사의 말

Electron, React, Vite, 그리고 Model Context Protocol을 둘러싼 훌륭한 오픈소스 생태계 — 그리고 이 앱이 오케스트레이션하는 코딩 에이전트들: Claude Code, Codex, Cursor, Gemini, qoder — 위에 만들어졌습니다.
