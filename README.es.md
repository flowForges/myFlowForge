<div align="center">

<img src="build/icon.png" alt="myFlowForge" width="128" height="128" />

# myFlowForge

**Una cabina de mando en macOS para tus agentes de programación con IA.**

Un escritorio macOS que reúne **Claude Code, Codex, Cursor, Gemini, qoder, opencode, Trae** y más en un solo sitio —— para que puedas **cambiar de agente y de modelo en mitad de la conversación**, **desarrollar varios proyectos en paralelo**, llevar el trabajo con un **flujo ligero y en marcha manual**, e intercalar tus propios **hooks** entre etapas.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-macOS-000000?logo=apple&logoColor=white)

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Español** · [Français](README.fr.md) · [Deutsch](README.de.md)

</div>

---

<div align="center">

<img src="assets/screenshots/home.jpg" alt="Inicio — espacios de trabajo, agentes en marcha y los cambios de hoy de un vistazo" width="90%" />

<sub><b>Inicio</b> — retoma donde lo dejaste. El fondo, la piel y el color de acento son tuyos para cambiarlos.</sub>

</div>

---

## ¿Qué es myFlowForge?

Cada CLI de programación con IA vive en su propia terminal, con su propio estado de sesión, su propia cuota y sin la menor idea de que las demás existen. Eliges una y te casas con ella hasta que acabe la tarea.

**myFlowForge las pone a todas bajo el mismo techo.** El agente y el modelo son propiedades de *cada turno*, no de la sesión: puedes madurar un diseño con Claude Opus, pasarle la implementación a Codex y bajar a algo barato para los remates, todo dentro de una misma conversación y sin perder el contexto.

Encima de eso se apoya un **flujo de trabajo ligero**: no una cadena de montaje que se te escapa de las manos, sino una fina capa de estructura sobre esa misma conversación. Cada etapa espera a que pulses *Siguiente*.

> ⚠️ **Estado del proyecto:** un proyecto personal en desarrollo activo. Está pensado para **macOS** (Apple Silicon e Intel). Al estar basado en Electron puede compilarse desde el código para otras plataformas, pero hoy solo se empaqueta para macOS. **1.1.0** es la versión estable actual; las betas entre estables son donde aterrizan primero las novedades.

## ✨ Las cinco cosas que de verdad importan

### 1. Una colección de agentes, no un favorito

Doce CLI de programación conviven en una sola interfaz: **Claude Code · Codex · Cursor · Gemini · qoder · opencode · Qwen · Copilot · Pi · Kimi · Reasonix · Trae**.

Las listas de modelos se **leen de la configuración local real de cada CLI**: nada codificado a mano, así que lo que ves es lo que tu cuenta puede ejecutar de verdad. También puedes añadir entradas a mano y sobreviven a la siguiente actualización. **opencode** es en sí mismo una pasarela multiproveedor: lo conectas una vez y llegas a muchos.

### 2. Cambiar de agente y de modelo dentro de una misma sesión

Agente, modelo y modo de permisos son tres selectores que están siempre bajo el cuadro de escritura. Cambia el que quieras antes de tu siguiente mensaje:

- Un modelo se atasca o se desvía → cambia y sigue preguntando; ve la conversación hasta ese punto.
- Se te acabó la cuota con un proveedor → pásate a otro, en la misma sesión.
- Modelo caro para pensar, modelo barato para el trabajo bruto.

Los agentes con reanudación nativa (Claude Code, Codex, Cursor, qoder, opencode) continúan su propio historial de sesión. Para el resto, myFlowForge reconstruye el contexto. En ambos casos tú simplemente sigues hablando.

### 3. Varios proyectos, desarrollados a la vez

Un espacio de trabajo alberga **varios repositorios**. Una etapa puede *abrirse en abanico por proyecto*: frontend, backend y SDK avanzan a la vez, cada uno movido por su propio agente en su propio **git worktree**, así que nunca chocan, y todos los diffs acaban en un mismo panel de Cambios para revisarlos.

El abanico admite un subconjunto: analizar los cinco repositorios pero escribir código solo en dos es una configuración perfectamente normal.

### 4. Un flujo ligero, en marcha manual

Arrancar un flujo **no** lo lanza hasta el final. Entra en un modo conversacional:

- Una cinta arriba muestra *paso N de M · etapa actual · qué agente está al mando*.
- El agente de esa etapa trabaja **en el chat que tienes delante**: salida, llamadas a herramientas y escrituras de archivos, todo a la vista.
- ¿No te convence? Sigue hablando sin más. Las repreguntas y las correcciones no reejecutan la etapa.
- ¿Contento? Pulsa **Siguiente**. Solo entonces se escribe el traspaso y entra el siguiente agente.

La etapa de diseño escribe un **documento markdown de verdad** (`forge-docs/design.md`), con una sección por proyecto. Ese documento —y no un resumen que pierde matices— es el único contrato entre agentes; los agentes posteriores lo leen entero y luego se centran en su propia sección.

Las etapas con compuerta se detienen y te esperan: **aprobar**, **devolver** (tus notas quedan fijadas arriba y la salida anterior vuelve como línea base) o simplemente **preguntar** sin provocar una reejecución. ¿Te das cuenta tarde de que el diseño estaba mal? Salta a una etapa anterior y rehazla.

### 5. Hooks entre las etapas

Un hook es un pequeño paso encajado **entre** etapas. Si una etapa es un agente haciendo ingeniería de verdad, un hook es un recado que se despacha por el camino.

Engánchalo **antes de la ejecución**, **después de cualquier etapa** o **al terminar todo**: traer el último código, sincronizar el documento de diseño con tu wiki, pasar el lint, actualizar un tablero, mandar un aviso.

Cada hook se ejecuta como un **microagente restringido** en la raíz del espacio de trabajo: solo las skills y herramientas que le diste, más la tarea y los artefactos producidos aguas arriba. Informa en una línea y te pregunta directamente cuando topa con algo que solo un humano puede resolver. Un fallo **bloquea** la tubería y ofrece reintentar / omitir / abortar. Los hooks viven en una biblioteca global, independiente de cualquier ranura: se escriben una vez y se enganchan donde haga falta.

---

<div align="center">

<img src="assets/screenshots/workflow.jpg" alt="Composición de etapas — cada etapa elige su agente y su modelo; Desarrollo se abre en abanico a dos proyectos" width="90%" />

<sub><b>Composición de etapas</b> — cinco etapas, cada una con su agente y su modelo; <i>Desarrollo</i> se abre en abanico sobre dos repositorios.</sub>

</div>

---

## 🤖 Agentes de programación soportados

| Agente | Chat | Flujo | Reanudación nativa | MCP | Modelos |
|--------|:----:|:-----:|:------------------:|:---:|---------|
| **Claude Code** | ✅ | ✅ | ✅ | ✅ | detectados desde el CLI |
| **Codex** | ✅ | ✅ | ✅ | ✅ | detectados desde el CLI |
| **Cursor** | ✅ | ✅ | ✅ | ✅ | detectados desde el CLI |
| **qoder** | ✅ | ✅ | ✅ | ✅ | detectados + lista propia |
| **opencode** | ✅ | ✅ | ✅ | ✅ | pasarela multiproveedor |
| **Gemini** | ✅ | ✅ | — | ✅ | lista predefinida |
| **Qwen** | ✅ | ✅ | — | ✅ | lista predefinida |
| **Copilot** | ✅ | ✅ | — | ✅ | lista predefinida |
| **Pi** | ✅ | ✅ | — | — | predeterminado de la cuenta / propio |
| **Kimi** | ✅ | ✅ | — | — | kimi-k2.5 · 256K |
| **Reasonix** | ✅ | ✅ | — | — | deepseek-flash / reasoner |
| **Trae** 🆕 | ✅ | ✅ | — | — | predeterminado de la cuenta (`/model` o `trae_cli.yaml`) |

> **Trae** (el TraeCode CLI de ByteDance) no se distribuye por npm: su `install.sh` oficial deja `traecli` en `~/.local/bin`, así que asegúrate de tenerlo en el PATH. Para que edite archivos sin supervisión dentro de un flujo, ejecuta `traecli config edit` y pon `permission_mode: bypass_permissions`.

myFlowForge **no guarda claves de API ni retransmite peticiones**: mueve los CLI que ya tienes instalados y autenticados en tu máquina. Lo que falte aparece señalado en Ajustes con instrucciones de instalación.

## 🔧 Cómo es una ejecución

```
   Describes el objetivo
            │
            ▼
  ┌─ hook ─┐        ┌─ hook ─┐                    ┌─ hook ─┐
  │  antes │        │ tras el│                    │ tras la│
  │   de   │        │ diseño │                    │ tanda  │
  └───┬────┘        └───┬────┘                    └───┬────┘
      ▼                 ▼                             ▼
 📋 Requisitos → 🎨 Diseño → ✋ COMPUERTA → 💻 Desarrollo → 🧪 Pruebas → 🔍 Revisión
   (aclarar)    (design.md)   tú decides     (en abanico)   (verificar)  (multienfoque)
                     │                            │
                     │                            └─ un agente por proyecto,
                     │                               carriles paralelos, worktree propio
                     └─ un documento real, leído entero por cada agente posterior

 Cada flecha espera a que pulses «Siguiente». Las etapas se añaden, se quitan,
 se reordenan o se saltan — ejecutar solo Requisitos → Desarrollo es perfectamente válido.
```

Tres formas de arrancarlo, todas desembocando en la misma compuerta:

1. Pulsa **Iniciar** en el panel de flujo.
2. Escribe `/` en el cuadro de escritura y elige uno.
3. Describe una tarea de desarrollo completa en lenguaje llano: el agente principal la reconoce y levanta una compuerta de plan a través de MCP. Las preguntas sueltas, las discusiones y los arreglos de una línea no la disparan.

## 🧩 Y además

- **Importación de sesiones nativas** — escaneo de solo lectura de tu historial local de Claude / Codex / Cursor / qoder; impórtalo como espacio de trabajo y sigue.
- **Puente MCP** — un servidor Forge MCP integrado deja que los agentes llamen de vuelta a la app: `forge_ask`, `forge_propose_plan`, `forge_write_artifact`, `forge_handoff`, `forge_delegate`, `forge_read_context`, `forge_heartbeat`. Se inyecta en los ocho agentes que soportan MCP; el resto recurre a una directiva de texto.
- **Observabilidad en tiempo real** — pensamiento, llamadas a herramientas, cambios de archivos y salida en bruto en streaming; consola de registro filtrable, historial de ejecuciones y evidencia de cambios entre proyectos.
- **Uso de tokens y cuota** — cuota restante y hora de reinicio por proveedor, más el gasto por espacio de trabajo × agente × día.
- **Puente de bots** — responde compuertas, consulta resultados, inicia una conversación y gobierna flujos desde **DingTalk** en el móvil (Telegram / Feishu ya cableados para más adelante).
- **Modos de permiso** — solo lectura · automático en el espacio de trabajo (por defecto) · acceso total, por sesión o por etapa. Se mapean sobre el sandbox real de cada CLI, y la interfaz dice sin rodeos qué agentes lo respetan de verdad.
- **Comandos con barra, skills y plugins** — `/` muestra tus comandos reales en disco y las skills instaladas, filtrados por agente.
- **Flujos de trabajo propios** — el proceso lo montas tú: guarda tantos flujos con nombre como quieras, cada uno con su conjunto de etapas; cada etapa elige su agente, modelo, modo de permisos, forma de abanico, si lleva compuerta y si debe producir un documento.
- **Etapas propias** — una biblioteca global de etapas escritas por ti, referenciable desde cualquier flujo.
- **Explorador de archivos y diff** — árbol a pantalla completa con marcas de cambio, vista previa con resaltado de sintaxis y conmutador diff / texto completo.
- **Terminal integrada** — un pty de verdad enraizado en el espacio de trabajo, con proxy y zona horaria por proveedor.
- **Mascota de escritorio** — sigue la pantalla enfocada, previsualiza la actividad de los agentes y saca tarjetas de confirmación; curiosea el mercado de mascotas o trae tus propias imágenes.
- **Transparencia y cristal esmerilado** — un único deslizador lleva toda la ventana desde totalmente opaca hasta los tres materiales de *vibrancy* nativos de macOS, dejando ver el escritorio.
- **Personalización** — 6 pieles originales, 12 colores de acento, una galería de 270 fondos o tu propia imagen, tamaños de fuente en píxeles exactos e independientes para la app y para el chat, con contraste ajustado por separado en claro y oscuro.
- **Tema derivado del fondo** — actívalo y toda la paleta se deriva del fondo que hayas elegido; claro u oscuro lo decide la propia imagen. El fondo solo aporta dos tonos: cada paso de luminosidad y croma se copia de las pieles ajustadas a mano, así que una imagen recargada no puede producir una interfaz ilegible. ¿Prefieres tu propio acento? Elígelo y solo el acento deja de seguir al fondo.
- **Mascota que crece** — la mascota de escritorio crece por etapas conforme trabajas, así una sesión larga deja algo visible detrás.
- **Visuales en línea en el chat** — desactivado por defecto: al activarlo, los fragmentos HTML que un agente escribe a mitad de respuesta se renderizan como tarjetas, tablas y diagramas reales. Nunca `innerHTML`: el fragmento se analiza y se reconstruye desde una lista de permitidos constructiva, y los colores solo pueden venir de los tokens del tema, así que lo renderizado sigue tu piel en lugar de pelearse con ella.

## 📥 Descarga e instalación

Coge el último `.dmg` desde la página de [**Releases**](https://github.com/flowForges/myFlowForge/releases):

| Tu Mac | Descarga |
|--------|----------|
| Apple Silicon (M1/M2/M3/M4) | `myFlowForge-<versión>-arm64.dmg` |
| Intel | `myFlowForge-<versión>.dmg` |

> **⚠️ La app aún no está firmada.** Al abrirla por primera vez macOS puede decir que *«no se puede abrir»* o que *«está dañada»*: es lo que ocurre con una app sin firmar, el archivo está bien. Puedes:
> - **Clic derecho** sobre la app en `/Aplicaciones` → **Abrir** → **Abrir** en el diálogo, o
> - ejecutar una vez: `xattr -dr com.apple.quarantine /Applications/myFlowForge.app`
>
> myFlowForge consulta este mismo canal de Releases y te ofrece las versiones nuevas desde dentro de la app.

## 🚀 Primeros pasos desde el código

**Requisitos previos:** macOS 11+, Node.js ≥ 20, git y al menos un CLI de programación soportado, instalado y autenticado.

```bash
git clone https://github.com/flowForges/myFlowForge.git
cd myFlowForge
npm install
npm run dev          # modo desarrollo con recarga en caliente del renderer
```

| Comando | Qué hace |
|---------|----------|
| `npm run dev` | Arranca con recarga en caliente |
| `npm test` | Ejecuta toda la batería de pruebas (Vitest) |
| `npm run typecheck` | Comprueba tipos en los tsconfig de main y renderer |
| `npm run build` | Compila el paquete de producción |
| `npm run dist:mac-all` | Compila los `.dmg` de Intel y Apple Silicon |

Los artefactos van a `release/`. Los cambios bajo `src/main/**` requieren **reiniciar Electron por completo**; la recarga en caliente solo refresca el renderer.

## 🏗️ Pila técnica

**Contenedor:** [Electron](https://www.electronjs.org/) 42 + [electron-vite](https://electron-vite.org/) · **UI:** [React](https://react.dev/) 19 + TypeScript 6 · **Terminal:** [xterm.js](https://xtermjs.org/) + [node-pty](https://github.com/microsoft/node-pty) · **Puente de agentes:** [Model Context Protocol SDK](https://modelcontextprotocol.io/) · **Control de procesos:** [execa](https://github.com/sindresorhus/execa) · **Validación:** [zod](https://zod.dev/) · **Vigilancia de archivos:** [chokidar](https://github.com/paulmillr/chokidar) · **Pruebas:** [Vitest](https://vitest.dev/) + Testing Library · **Empaquetado:** [electron-builder](https://www.electron.build/)

## 📁 Estructura del proyecto

```
src/
├── main/              # Proceso principal de Electron
│   ├── agents/        # Adaptadores de CLI + registro de proveedores, detección, permisos
│   ├── run/           # Motor de flujo: etapas, compuertas, abanico, hooks, traspasos
│   ├── chat/          # Chat, cola y memoria por espacio de trabajo
│   ├── mcp/           # Servidor Forge MCP (puente agente → app)
│   ├── bot/           # Puente de bots (transportes DingTalk / Telegram / Feishu)
│   ├── plugins/       # Anfitrión de plugins, catálogo, planificador, puntos de extensión
│   ├── sessionImport/ # Escaneo e importación de sesiones nativas
│   ├── usage/         # Adaptadores de cuota por proveedor
│   ├── pet/           # Ventana de la mascota de escritorio
│   └── ...            # git, fs, terminal, actualizaciones, vigilancia, ventanas, apariencia
├── renderer/          # Interfaz React (vistas, componentes, ajustes, tema, mascota)
├── preload/           # Puente IPC con aislamiento de contexto
└── shared/            # Tipos y lógica pura compartidos entre procesos
```

## 🤝 Contribuir

Las incidencias y los PR son bienvenidos. El proyecto es **dirigido por pruebas**: añade o actualiza pruebas junto con tus cambios y comprueba que `npm test` y `npm run typecheck` pasan antes de abrir un PR.

## 📄 Licencia

Publicado bajo la [Licencia MIT](LICENSE) © 2026 zghua.

## 🙏 Agradecimientos

Construido sobre el ecosistema de código abierto que rodea a Electron, React, Vite y el Model Context Protocol —— y sobre los agentes de programación que orquesta.
