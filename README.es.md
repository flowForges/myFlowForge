<div align="center">

<img src="build/icon.png" alt="myFlowForge" width="128" height="128" />

# myFlowForge

**Forja tu flujo de trabajo de programación con IA.**

Una cabina de mando de escritorio que orquesta **Claude Code, Codex, Cursor, Gemini, qoder y opencode** en una única canalización de programación gobernada y multietapa — con puertas de aprobación de plan, importación de sesiones nativas, seguimiento de uso en vivo, integración con MCP y una mascota de escritorio que te acompaña.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-macOS-000000?logo=apple&logoColor=white)

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Español** · [Français](README.fr.md) · [Deutsch](README.de.md)

</div>

---

## ¿Qué es myFlowForge?

Las herramientas modernas de programación con IA viven cada una en su propia terminal, con su propio estado de sesión, su propia cuota y sin un plan compartido. **myFlowForge** las reúne todas bajo un mismo techo y convierte el "conversar con una IA" en un **flujo de trabajo de ingeniería repetible y revisable**.

Tú describes lo que quieres. Forge conduce a los agentes que elijas a través de una canalización por etapas — **Requisito → Diseño → Desarrollo → Prueba → Revisión** — deteniéndose en una **puerta estricta** para que puedas aprobar el plan técnico *antes* de que se escriba una sola línea de código. Cada etapa puede ejecutar un agente y un modelo distintos, en paralelo entre varios proyectos, mientras una amable mascota de escritorio te muestra de un vistazo lo que está ocurriendo.

> ⚠️ **Estado del proyecto:** myFlowForge es un proyecto personal en desarrollo activo. Actualmente está orientado a **macOS** (Apple Silicon e Intel). Al estar basado en Electron, puede compilarse para otras plataformas desde el código fuente, pero hoy solo se empaqueta para macOS.

## ✨ Aspectos destacados

- **🎛️ Orquestación multiagente** — Dirige cada etapa del flujo de trabajo a una CLI de programación distinta (Claude Code, Codex, Cursor, Gemini, qoder, opencode) y a un modelo distinto. **opencode** es en sí mismo una pasarela multiproveedor — conéctalo una vez para alcanzar a muchos proveedores de modelos.
- **📂 Abrir en tu editor** — Un botón "Abrir ubicación" en la barra de título detecta los editores instalados (VS Code, Cursor, JetBrains, Zed, Finder, terminales…) y abre el espacio de trabajo actual — o el archivo que estás previsualizando — en el que elijas, recordado como predeterminado.
- **⌨️ Comandos slash en el chat** — Escribe `/` en el chat para ver un menú de disparadores de flujo de trabajo, además de tus **comandos/prompts reales en disco y las skills instaladas**, filtrados por agente.
- **🔄 Canalización multietapa gobernada** — Requisito → Diseño → Desarrollo → Prueba → Revisión, con una **puerta estricta de aprobación de plan**: revisa y aprueba (o rechaza) el diseño técnico antes de que comience la ejecución.
- **✂️ Ejecución selectiva y eficiente en tokens** — Un flujo de trabajo configurado ya no obliga a que cada tarea pase por todas las etapas y todos los proyectos. Describe una tarea pequeña en lenguaje sencillo y el agente orquestador propone un **plan recortado** — ejecuta solo las etapas que necesitas (p. ej. omitir Prueba/Revisión) y acota cada etapa a un subconjunto de proyectos (p. ej. analizar los cinco, escribir código solo en dos). La tarjeta de aprobación muestra exactamente qué se ejecutará antes de que confirmes.
- **🧭 Orquestador, no ejecutor** — El agente de chat principal nunca escribe código ni genera sus propios subagentes internos; solo descompone tareas y delega cada paso práctico a los subagentes reales y orquestados de Forge.
- **🧩 Proyectos y espacios de trabajo en paralelo** — Ejecuta varios espacios de trabajo de forma concurrente, cada uno con worktrees de git aislados; observa a varios agentes trabajar codo con codo en carriles paralelos.
- **📥 Importación de sesiones nativas** — Escanea en modo solo lectura e importa tus sesiones locales existentes de Claude / Codex / Cursor / qoder a un índice central, y luego reanúdalas como espacios de trabajo.
- **📊 Seguimiento de uso y cuota en vivo** — Adaptadores de uso reales exponen la cuota restante y los tiempos de reinicio de cada proveedor.
- **🔌 Integración con MCP** — Un servidor Forge MCP integrado conecta a los agentes de vuelta a la aplicación (hacer preguntas, proponer planes, entregar artefactos) para un control fiable y basado en herramientas.
- **🖥️ Observabilidad en tiempo real** — Registros en streaming de pensamiento / ejecución / cambios de archivos / salida, una consola de registros filtrable y evidencia de cambios entre proyectos.
- **🐾 Mascota de escritorio** — Un compañero arrastrable y redimensionable que sigue tu foco, previsualiza la actividad de los agentes y muestra tarjetas de confirmación emergentes — con efectos configurables y múltiples packs de mascotas.
- **🎨 Interfaz pulida y personalizable** — Glassmorphism, **6 temas** (claro / oscuro / automático + medianoche / sepia / bosque), **12 colores de acento**, una **imagen de fondo personalizada** (para toda la app o el área de chat, con opacidad ajustable), un panel de inicio rediseñado con un saludo según la hora local en vivo, paneles redimensionables y un centro de notificaciones.

## 🤖 Agentes de programación compatibles

| Agente | Chat | Ejecución de flujo | Reanudación nativa | Modelos | MCP |
|-------|:----:|:------------:|:-------------:|:------:|:---:|
| **Claude Code** | ✅ | ✅ | ✅ | dinámico | ✅ |
| **Codex** | ✅ | ✅ | ✅ | dinámico | ✅ |
| **Cursor** | ✅ | ✅ | ✅ | dinámico | — |
| **Gemini** | ✅ | ✅ | — | dinámico | — |
| **qoder** | ✅ | ✅ | ✅ | dinámico | ✅ |
| **opencode** | ✅ | ✅ | ✅ | dinámico (multiproveedor) | — |

> Los modelos se descubren a partir de la configuración local real de cada CLI — nada está codificado de forma fija, y puedes editar la lista de modelos por proveedor. **opencode** descubre sus modelos con `opencode models`, de modo que una sola integración incorpora todos los proveedores que hayas configurado en él.

## 🔧 Cómo funciona

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

Tres formas de disparar un flujo de trabajo, todas convergiendo en la misma puerta única:

1. El agente de chat principal detecta la intención y llama a la herramienta MCP **`forge_propose_plan`**.
2. Una directiva delimitada por skills como alternativa.
3. El botón explícito **"Iniciar flujo de trabajo"**.

## 📥 Descarga e instalación

Consigue el `.dmg` más reciente en la página de [**Releases**](https://github.com/flowForges/myFlowForge/releases):

| Tu Mac | Descarga recomendada |
|----------|----------------------|
| Apple Silicon (M1/M2/M3/M4) | `myFlowForge-<version>-arm64.dmg` o la compilación universal |
| Intel | `myFlowForge-<version>.dmg` (x64) o la compilación universal |
| No estás seguro | `myFlowForge-<version>-universal.dmg` — funciona en ambos |

> **⚠️ La aplicación aún no está firmada con código.** En el primer lanzamiento, macOS puede advertir que la app *"no se puede abrir"* o *"está dañada"*. Esto es normal en una app sin firmar. Para abrirla:
> - **Haz clic derecho** en la app dentro de `/Applications` → **Abrir** → **Abrir** en el diálogo, **o**
> - ejecuta una vez en la Terminal: `xattr -dr com.apple.quarantine /Applications/myFlowForge.app`
>
> myFlowForge consulta este feed de Releases en busca de actualizaciones y ofrece versiones más nuevas dentro de la app.

## 🚀 Primeros pasos

### Requisitos previos

- **macOS** (Apple Silicon o Intel)
- **Node.js** ≥ 20 y **npm**
- Una o más de las CLIs de programación compatibles instaladas y autenticadas (Claude Code, Codex, Cursor, Gemini, qoder). Forge detecta lo que tienes y te guía en la instalación del resto.

### Instalar y ejecutar en desarrollo

```bash
# 1. Clone
git clone https://github.com/flowForges/myFlowForge.git
cd myFlowForge

# 2. Install dependencies
npm install

# 3. Launch in dev mode (hot reload)
npm run dev
```

### Scripts útiles

| Comando | Qué hace |
|---------|--------------|
| `npm run dev` | Inicia la app con recarga en caliente |
| `npm test` | Ejecuta la suite de pruebas completa (Vitest) |
| `npm run typecheck` | Verifica los tipos de ambos tsconfig (main y renderer) |
| `npm run build` | Compila el bundle de producción |
| `npm run dist` | Compila un distribuible de macOS (`.dmg`) |

### Compilar un distribuible

```bash
npm run dist            # macOS x64
npm run dist:arm64      # Apple Silicon
npm run dist:universal  # Universal binary
```

Los artefactos se escriben en `release/`.

## 🏗️ Pila tecnológica

- **Shell:** [Electron](https://www.electronjs.org/) 42 + [electron‑vite](https://electron-vite.org/)
- **UI:** [React](https://react.dev/) 19 + TypeScript 6
- **Terminal:** [xterm.js](https://xtermjs.org/) + [node‑pty](https://github.com/microsoft/node-pty)
- **Puente de agentes:** [Model Context Protocol SDK](https://modelcontextprotocol.io/)
- **Control de procesos:** [execa](https://github.com/sindresorhus/execa) · **Validación:** [zod](https://zod.dev/) · **Vigilancia de archivos:** [chokidar](https://github.com/paulmillr/chokidar)
- **Pruebas:** [Vitest](https://vitest.dev/) + Testing Library (Desarrollo Guiado por Pruebas en todo el proyecto)
- **Empaquetado:** [electron‑builder](https://www.electron.build/)

## 📁 Estructura del proyecto

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

## 🤝 Contribuir

¡Las contribuciones, incidencias y solicitudes de funcionalidades son bienvenidas! Este proyecto sigue un flujo de trabajo **guiado por pruebas** — por favor, añade o actualiza pruebas con tus cambios y asegúrate de que `npm test` y `npm run typecheck` pasen antes de abrir un PR.

## 📄 Licencia

Publicado bajo la [Licencia MIT](LICENSE) © 2026 zghua.

## 🙏 Agradecimientos

Construido sobre el excelente ecosistema de código abierto en torno a Electron, React, Vite y el Model Context Protocol — y los agentes de programación que orquesta: Claude Code, Codex, Cursor, Gemini y qoder.
