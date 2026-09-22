<div align="center">

<img src="build/icon.png" alt="myFlowForge" width="128" height="128" />

# myFlowForge

**Una GUI para Claude Code, Codex, Cursor y otros agentes nativos: gestión en un solo lugar y conexión entre dispositivos.**

myFlowForge invoca directamente las CLI oficiales instaladas en el equipo (Claude Code, Codex, Cursor, Gemini, qoder, opencode, DeepSeek, entre otras). No modifica ni sustituye a los agentes; se limita a ofrecer una GUI unificada sobre ellos. Permite cambiar de agente y de modelo dentro de una misma sesión, importar sesiones nativas, ejecutar flujos de trabajo por etapas y usar las mascotas nativas de Codex, y admite el acceso remoto desde otro ordenador, un servidor o un teléfono.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-macOS%20·%20Windows%20·%20Linux-000000)
![Mobile](https://img.shields.io/badge/Mobile-iOS%20·%20Android-3DDC84)

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Español** · [Français](README.fr.md) · [Deutsch](README.de.md)

</div>

---

<div align="center">

<img src="assets/screenshots/home.jpg" alt="Inicio: espacios de trabajo, agentes en ejecución y cambios del día" width="90%" />

<sub><b>Inicio</b>: espacios de trabajo, agentes en ejecución y cambios del día. El fondo de pantalla, la apariencia y el color de acento son personalizables.</sub>

</div>

---

## Descripción

Cada CLI de programación con IA se ejecuta en su propio terminal, y sus sesiones, cuotas y configuraciones no se comparten entre sí. Como resultado, una tarea suele quedar ligada a una sola herramienta.

myFlowForge es una capa de GUI situada sobre estas CLI y sigue tres principios:

- **Integración nativa**: los agentes se invocan a través de sus CLI oficiales, con tu propia cuenta, suscripción y configuración local. No se hace fork ni se modifica ningún agente, no se almacenan API keys y no se hace de proxy de ninguna solicitud. Cuando un agente se actualiza, sus nuevas capacidades están disponibles de inmediato.
- **Gestión unificada**: varios agentes, proyectos y sesiones se gestionan desde una misma interfaz, de modo que las tareas dejan de estar ligadas a una sola herramienta.
- **Conexión entre dispositivos**: la aplicación de escritorio, el daemon Linux sin interfaz y los clientes de iOS / Android comparten los mismos espacios de trabajo y sesiones, con conexión directa en red local, SSH y relay con cifrado de extremo a extremo.

> **Estado del proyecto:** mantenido por una sola persona y en desarrollo activo. Se ofrecen paquetes de instalación para macOS, Windows y Linux, además de un APK para Android y TestFlight para iOS. El paquete de macOS está firmado con Developer ID y notarizado por Apple, el de Android está firmado con una clave de publicación y el de Windows aún no está firmado.

## Funciones principales

### 1. Integración nativa de agentes

Se admiten 14 CLI de programación: **Claude Code · Codex · Cursor · Gemini · qoder · opencode · Qwen · Copilot · Pi · Kimi · Reasonix · Trae · Antigravity · DeepSeek**.

myFlowForge controla las CLI oficiales instaladas y con sesión iniciada en el equipo, sin alterar su comportamiento. La lista de modelos se lee preferentemente de la configuración local de cada CLI y, si no es posible, se usa una lista predefinida; también se pueden añadir modelos manualmente, y estos no se sobrescriben al actualizar la lista. Las CLI no instaladas o sin sesión iniciada se señalan en la configuración, junto con instrucciones de instalación.

### 2. Cambio de agente y modelo dentro de una misma sesión

El agente, el modelo y el nivel de permisos se pueden volver a elegir antes de cada turno, y el contexto se mantiene continuo:

- si un modelo no da buenos resultados, se puede continuar con otro, que verá toda la conversación anterior;
- si se agota la cuota de un proveedor, se puede cambiar a otro sin abrir una sesión nueva;
- los modelos se pueden asignar según la naturaleza de la tarea, por ejemplo, un modelo más capaz para el diseño y uno más económico para la implementación y el cierre.

Los agentes con reanudación nativa (Claude Code, Codex, Cursor, qoder, opencode, Antigravity) conservan su propio historial de sesión; para el resto, myFlowForge reconstruye el contexto.

### 3. Conexión entre dispositivos

- **Hosts remotos**: la aplicación de escritorio puede conectarse a otro ordenador o servidor y controlar los agentes, repositorios y terminal de esa máquina. El host actual se cambia desde la barra de estado, y los espacios de trabajo, las sesiones, los cambios de git y el terminal integrado cambian con él.
- **Tres modos de conexión**: conexión directa en red local, SSH y relay con cifrado de extremo a extremo. El relay solo reenvía texto cifrado y no puede leer el contenido de las sesiones; se puede desplegar por cuenta propia (Node o Cloudflare Worker).
- **Daemon sin interfaz**: en un servidor Linux se ejecuta `myflowforge-daemon`, y el comando `pair` muestra en el terminal un código QR de emparejamiento.
- **Móvil**: los clientes de iOS y Android permiten ver conversaciones en tiempo real, responder a confirmaciones de permisos y aprobaciones de diseño, revisar cambios y diffs, crear espacios de trabajo, editar flujos de trabajo y cambiar de host.
- **Autorización de dispositivos**: cada dispositivo usa su propio código de emparejamiento, se puede eliminar individualmente en cualquier momento y la revocación surte efecto de inmediato.

### 4. Importación de sesiones nativas

Se analizan en modo de solo lectura los historiales locales de sesiones de Claude Code, Codex, Cursor y qoder; una vez importados como espacio de trabajo, se puede continuar la conversación directamente, sin afectar a los datos originales.

### 5. Flujos de trabajo por etapas

Además de la conversación normal, una tarea se puede ejecutar por etapas. Al iniciar un flujo de trabajo, la conversación pasa al modo de etapas:

- en la parte superior se muestra el progreso (paso N de M), la etapa actual y el agente responsable;
- el agente de cada etapa trabaja dentro de la conversación actual, y su salida, las llamadas a herramientas y los cambios en archivos son visibles en todo momento;
- al terminar cada etapa, hay que confirmar "Siguiente" para pasar a la siguiente; las preguntas de seguimiento y las correcciones no provocan una nueva ejecución;
- la etapa de diseño produce un documento markdown completo (`forge-docs/design.md`), que sirve de contrato común para los agentes posteriores;
- en las etapas con aprobación se puede **aprobar**, **devolver** (con comentarios para rehacerla) o **preguntar**, y también se puede volver a una etapa anterior.

Cada etapa puede tener su propio agente, modelo y nivel de permisos. Tanto los flujos de trabajo como las etapas se pueden personalizar, guardar y reutilizar.

### 6. Varios proyectos en paralelo

Un espacio de trabajo puede contener varios repositorios. Una etapa puede **repartirse por proyecto**: frontend, backend y SDK se desarrollan en paralelo, cada uno con su propio agente en un git worktree independiente, y todos los cambios se reúnen en un único panel de cambios para su revisión. El reparto puede limitarse a una parte de los repositorios.

### 7. Hooks de etapa

Un hook es un paso auxiliar insertado entre etapas. Se puede colocar **antes de la ejecución**, **después de una etapa** o **después de la ejecución**, y sirve para obtener código, sincronizar documentación, ejecutar lint, actualizar un tablero, enviar notificaciones, etc.

Cada hook se ejecuta como un subagente restringido en la raíz del espacio de trabajo y solo puede usar las skills y herramientas que se le asignen. Si falla, la ejecución se detiene y se puede elegir entre reintentar, omitir o abortar. Los hooks se guardan en una biblioteca global y se pueden reutilizar en cualquier flujo de trabajo.

### 8. Mascota de escritorio

La mascota de escritorio sigue a la pantalla actual, refleja en tiempo real el estado de ejecución de los agentes y puede mostrar directamente tarjetas de confirmación. **Es compatible con las mascotas nativas de Codex**, que se pueden instalar desde el mercado codex-pets.net, y también admite imágenes personalizadas. Hay además una mascota que crece progresivamente con el tiempo de uso.

---

<div align="center">

<img src="assets/screenshots/workflow.jpg" alt="Composición de etapas: cada etapa elige su agente y modelo, y la etapa de desarrollo se reparte entre dos proyectos" width="90%" />

<sub><b>Composición de etapas</b>: cinco etapas, cada una con su agente y modelo; la etapa de <i>desarrollo</i> se reparte entre dos repositorios.</sub>

</div>

---

## Agentes compatibles

| Agente | Chat | Flujo de trabajo | Reanudación nativa | MCP | Modelos |
|------|:----:|:------:|:--------:|:---:|------|
| **Claude Code** | ✅ | ✅ | ✅ | ✅ | Leídos de la CLI |
| **Codex** | ✅ | ✅ | ✅ | ✅ | Leídos de la CLI |
| **Cursor** | ✅ | ✅ | ✅ | ✅ | Leídos de la CLI |
| **qoder** | ✅ | ✅ | ✅ | ✅ | Leídos + personalizados |
| **opencode** | ✅ | ✅ | ✅ | ✅ | Pasarela multiproveedor |
| **Gemini** | ✅ | ✅ | — | ✅ | Lista predefinida |
| **Qwen** | ✅ | ✅ | — | ✅ | Lista predefinida |
| **Copilot** | ✅ | ✅ | — | ✅ | Lista predefinida |
| **Pi** | ✅ | ✅ | — | — | Predeterminado de la cuenta / personalizado |
| **Kimi** | ✅ | ✅ | — | — | kimi-k2.5 · 256K |
| **Reasonix** | ✅ | ✅ | — | — | deepseek-flash / reasoner |
| **Trae** | ✅ | ✅ | — | — | Predeterminado de la cuenta (`/model` o `trae_cli.yaml`) |
| **Antigravity** | ✅ | ✅ | ✅ | — | Actualizados con `agy models` |
| **DeepSeek** | ✅ | ✅ | — | — | Predeterminado de la cuenta |

> **DeepSeek** se refiere a DeepSeek Harness (`npm install -g @deepseek-ai/dsh`). myFlowForge usa su profile `headless`, y los tres niveles de permisos corresponden a `read-only` / `workspace-write` / `danger-full-access`. La API key se puede configurar mediante `dsh web` (página Models) o la variable de entorno `DEEPSEEK_API_KEY`.
>
> **Trae** (TraeCode CLI de ByteDance) no se publica en npm; debe instalarse con el `install.sh` oficial en `~/.local/bin` y añadirse al PATH. Para que modifique archivos sin supervisión dentro de un flujo de trabajo, ejecuta `traecli config edit` y establece `permission_mode: bypass_permissions`.

## Flujo de ejecución

```
 Describir el objetivo
           │
           ▼
    ┌─ hook ──────┐    ┌─ hook ──────┐                                               ┌─ hook ──────┐
    │  al inicio  │    │ tras diseño │                                               │  al final   │
    └───┬─────────┘    └───┬─────────┘                                               └───┬─────────┘
        ▼                  ▼                                                             ▼
   Requisitos ───────→  Diseño ───→  Aprobación ───→  Desarrollo ───→  Pruebas ───→  Revisión
    (aclarar)         (design.md)     (manual)         (reparto)     (verificar)   (multivista)
                           │                               │
                           │                               └─ un agente por proyecto,
                           │                                  en paralelo, worktree propio
                           └─ documento completo, todos los agentes posteriores lo leen entero

 Entre cada etapa hay que confirmar "Siguiente". Las etapas se pueden añadir,
 quitar, reordenar u omitir; por ejemplo, ejecutar solo "Requisitos → Desarrollo".
```

Un flujo de trabajo se puede iniciar de tres maneras:

1. pulsando **Iniciar** en el panel de flujos de trabajo;
2. escribiendo `/` en el cuadro de entrada y eligiendo un flujo de trabajo;
3. describiendo directamente una tarea de desarrollo en lenguaje natural: el agente principal la reconoce y solicita la aprobación del diseño mediante MCP. Las preguntas generales, las discusiones y los cambios pequeños no lo activan.

## Hosts remotos y móvil

| Modo | Descripción |
|---|---|
| **Directo** | Conexión directa al puerto del daemon dentro de la misma red local, con autenticación por token. |
| **SSH** | Reutiliza un acceso SSH existente, sin necesidad de abrir puertos adicionales. |
| **Relay** | Para los casos en que las dos máquinas no pueden comunicarse directamente. **Cifrado de extremo a extremo**: se negocia una clave nueva en cada sesión, el relay solo reenvía texto cifrado y descarta toda trama que no pueda descifrarse. Se puede desplegar por cuenta propia (`relay/`, compatible con Node y Cloudflare Worker); los pasos están en `relay/README.md`. |

El **daemon Linux** usa el mismo código que la aplicación de escritorio, sin la parte de ventanas. Tras instalar el tar.gz, se ejecuta con systemd y el emparejamiento se completa escaneando el código QR que aparece en el terminal (véase `docs/linux-deploy.md`).

El **cliente móvil** cubre las operaciones habituales cuando no se está frente al ordenador: conversación en tiempo real (incluidos el razonamiento, las llamadas a herramientas y las tarjetas de subagentes), confirmaciones de permisos y aprobaciones de diseño, archivos modificados y diffs, creación de espacios de trabajo, plantillas de flujo de trabajo, cambio de host y emparejamiento por código QR. El markdown, las tablas y las imágenes locales se renderizan de forma nativa; por motivos de privacidad, las direcciones de imágenes remotas se mantienen como enlaces y no se cargan automáticamente.

## Otras funciones

- **Puente MCP**: servidor Forge MCP integrado para que los agentes llamen a la aplicación: `forge_ask`, `forge_propose_plan`, `forge_write_artifact`, `forge_handoff`, `forge_delegate`, `forge_read_context`, `forge_heartbeat`. Se inyecta automáticamente en los agentes compatibles con MCP; en el resto se recurre a instrucciones de texto.
- **Servidores MCP y mercado de skills**: consulta los servidores MCP configurados en cada CLI y autorízalos desde la aplicación; instala skills para la CLI correspondiente desde el mercado de skills.
- **Memoria**: notas guardadas por espacio de trabajo que los agentes pueden leer, para dar continuidad al contexto en tareas largas.
- **Observación de ejecuciones**: muestra en streaming el razonamiento, las llamadas a herramientas, los cambios en archivos y la salida sin procesar, con registros filtrables, historial de ejecuciones y registro de cambios entre proyectos.
- **Cuotas y uso**: cuota restante y hora de reinicio de cada proveedor, además de estadísticas de uso por espacio de trabajo, agente y fecha.
- **Puente de bots**: gestiona aprobaciones, consulta resultados, inicia conversaciones y controla flujos de trabajo desde DingTalk, Telegram o Feishu.
- **Niveles de permisos**: revisión de solo lectura, automático (espacio de trabajo, predeterminado) y acceso completo; se configuran por sesión o por etapa y se corresponden con el alcance real del sandbox de cada CLI.
- **Comandos de barra y skills**: al escribir `/` se listan los comandos que existen realmente en el equipo y las skills instaladas, filtrados por agente.
- **Explorador de archivos y diff**: árbol de archivos a pantalla completa con marcas de cambios, vista previa con resaltado de sintaxis y alternancia entre diff y archivo completo.
- **Terminal integrado**: pty real con la raíz del espacio de trabajo como directorio base; el proxy y la zona horaria se pueden configurar por provider. Al conectarse a un host remoto, el terminal se ejecuta en la máquina remota.
- **Apariencia**: 6 apariencias originales, 12 colores de acento y más de 300 fondos de pantalla, con soporte para imágenes personalizadas; tamaño de fuente independiente para la aplicación y el área de conversación; generación automática de la paleta a partir del fondo de pantalla; y soporte del material translúcido nativo de macOS.
- **Imágenes y visualizaciones en la conversación**: las imágenes locales generadas por los agentes se muestran directamente en la respuesta; los fragmentos HTML de las respuestas pueden renderizarse como tarjetas, tablas y diagramas (desactivado por defecto, reconstruido mediante lista blanca, sin usar `innerHTML`).

## Descarga e instalación

Descarga la última versión desde la página de [**Releases**](https://github.com/flowForges/myFlowForge/releases):

| Plataforma | Archivo |
|------|------|
| macOS · Apple Silicon (M1–M4) | `myFlowForge-<versión>-arm64.dmg` |
| macOS · Intel | `myFlowForge-<versión>.dmg` |
| Windows · x64 | `myFlowForge-<versión>-x64-setup.exe` |
| Windows · ARM | `myFlowForge-<versión>-arm64-setup.exe` |
| Android | `myFlowForge-<versión>.apk` |
| Linux · daemon sin interfaz | `myFlowForge-daemon-<versión>-linux.tar.gz` |
| iOS | TestFlight (por invitación) |

> El instalador de **macOS** está firmado y notarizado, y se puede instalar directamente.
> El instalador de **Windows** aún no está firmado; cuando aparezca el aviso de SmartScreen, elige "Más información → Ejecutar de todas formas".
>
> La aplicación incluye comprobación de actualizaciones y avisa dentro de la propia aplicación cuando se publica una versión nueva.

**iOS** se distribuye actualmente mediante TestFlight (por invitación); también se puede compilar e instalar desde el directorio `mobile/` con un Apple ID propio.

## Inicio rápido

**Requisitos:** macOS 11+ / Windows 10+ / distribuciones Linux habituales, Node.js ≥ 20, git y al menos una CLI de programación instalada y con sesión iniciada.

```bash
git clone https://github.com/flowForges/myFlowForge.git
cd myFlowForge
npm install
npm run dev          # modo de desarrollo, recarga en caliente del renderer
```

| Comando | Descripción |
|------|------|
| `npm run dev` | Inicia en modo de desarrollo (recarga en caliente) |
| `npm test` | Ejecuta el conjunto completo de pruebas (Vitest) |
| `npm run typecheck` | Comprueba los dos tsconfig del proceso principal y del renderer |
| `npm run build` | Compilación de producción |
| `npm run dist:mac-all` | Empaqueta a la vez los `.dmg` para Intel y Apple Silicon |
| `npm run dist:win` | Empaqueta el instalador de Windows x64 |
| `npm run check:daemon` | Verifica de extremo a extremo el daemon sin interfaz |

El cliente móvil está en `mobile/` (Expo / React Native) y el servicio de relay en `relay/`, cada uno con su propio `package.json`.

Los artefactos de compilación se generan en `release/`. Tras modificar `src/main/**` hay que reiniciar Electron por completo, ya que la recarga en caliente solo afecta al renderer.

## Tecnologías

| Categoría | Tecnología |
|------|------|
| Contenedor de escritorio | [Electron](https://www.electronjs.org/) 42 · [electron-vite](https://electron-vite.org/) |
| Interfaz | [React](https://react.dev/) 19 · TypeScript 6 |
| Móvil | [Expo](https://expo.dev/) · [React Native](https://reactnative.dev/) |
| Terminal | [xterm.js](https://xtermjs.org/) · [node-pty](https://github.com/microsoft/node-pty) |
| Puente de agentes | [Model Context Protocol SDK](https://modelcontextprotocol.io/) |
| Control de procesos | [execa](https://github.com/sindresorhus/execa) |
| Validación de datos | [zod](https://zod.dev/) |
| Vigilancia de archivos | [chokidar](https://github.com/paulmillr/chokidar) |
| Pruebas | [Vitest](https://vitest.dev/) · Testing Library |
| Empaquetado | [electron-builder](https://www.electron.build/) |

## Estructura del proyecto

```
src/
├── main/              # Proceso principal de Electron
│   ├── agents/        # Adaptadores de CLI, registro de providers, detección y permisos
│   ├── run/           # Motor de flujos: etapas, aprobaciones, reparto, hooks, traspaso
│   ├── chat/          # Conversación del espacio de trabajo, cola y memoria
│   ├── mcp/           # Servidor Forge MCP (puente agente → aplicación)
│   ├── remote/        # Hosts remotos: directo / SSH / relay, enrutamiento, canal cifrado E2E
│   ├── daemon/        # Daemon sin interfaz y emparejamiento por QR en el terminal
│   ├── bot/           # Puente de bots (DingTalk / Telegram / Feishu)
│   ├── plugins/       # Host de plugins, catálogo, planificación y puntos de extensión
│   ├── sessionImport/ # Análisis e importación de sesiones nativas
│   ├── usage/         # Adaptadores de cuota por proveedor
│   ├── pet/           # Ventana de la mascota de escritorio
│   └── ...            # git, sistema de archivos, terminal, actualizaciones, vigilancia, ventanas, apariencia
├── renderer/          # Interfaz React (vistas, componentes, ajustes, temas, mascota)
├── preload/           # Puente IPC con aislamiento de contexto
└── shared/            # Tipos y lógica pura compartidos entre procesos
mobile/                # Clientes de iOS y Android (Expo / React Native)
relay/                 # Relay con cifrado de extremo a extremo (Node o Cloudflare Worker)
```

## Contribuir

Se aceptan issues y PR. El proyecto sigue el desarrollo guiado por pruebas: al enviar cambios, añade o actualiza las pruebas correspondientes y asegúrate de que `npm test` y `npm run typecheck` pasen.

## Licencia

[MIT License](LICENSE) © 2026 zghua

## Agradecimientos

Gracias a proyectos de código abierto como Electron, React, Vite y Model Context Protocol, así como a los agentes de programación que integra este proyecto.

## Enlaces

- [LINUX DO](https://linux.do/latest): comunidad de desarrolladores
- [V2EX](https://www.v2ex.com/): comunidad de trabajadores creativos
