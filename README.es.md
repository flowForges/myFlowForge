<div align="center">

<img src="build/icon.png" alt="myFlowForge" width="128" height="128" />

# myFlowForge

**Una cabina de mando para tus agentes de programación con IA — en tu escritorio, en tus servidores, en tu bolsillo.**

Una cabina de mando de escritorio que reúne **Claude Code, Codex, Cursor, Gemini, qoder, opencode, DeepSeek** y más en un solo lugar — para que puedas **cambiar de agente y de modelo a mitad de conversación**, **construir en varios proyectos en paralelo**, dar forma al trabajo con un **flujo de trabajo ligero, en marcha manual**, tejer tus propios **hooks** entre etapas y llegar a todo ello desde **otra máquina o tu teléfono**.

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

<img src="assets/screenshots/home.jpg" alt="Inicio — espacios de trabajo, agentes en marcha y el diff de hoy de un vistazo" width="90%" />

<sub><b>Inicio</b> — retoma justo donde lo dejaste. El fondo de pantalla, la skin y el color de acento son tuyos para cambiarlos.</sub>

</div>

---

## ¿Qué es myFlowForge?

Cada CLI de programación con IA vive en su propio terminal, con su propio estado de sesión, su propia cuota y sin la menor idea de que las demás existen. Eliges una y te casas con ella durante el resto de la tarea.

**myFlowForge las pone a todas bajo un mismo techo.** El agente y el modelo son propiedades de *cada turno*, no de la sesión — así puedes pensar un diseño a fondo con Claude Opus, entregar la implementación a Codex y bajar a algo barato para la limpieza final, todo dentro de una misma conversación y con el contexto intacto.

Encima de eso se asienta un **flujo de trabajo ligero**: no una cadena de montaje que se te escapa de las manos, sino una capa fina de estructura sobre esa misma conversación. Cada etapa espera a que pulses *Siguiente*.

Y nada de esto está atado a una sola máquina. La misma cabina **se conecta a otro ordenador** — tu equipo Linux, el escritorio de la oficina — y gobierna *sus* agentes en *sus* repositorios. Desde el teléfono puedes seguir una ejecución, responder a una puerta de control y mantener viva la conversación.

> **Estado del proyecto:** un proyecto personal en desarrollo activo. macOS, Windows y Linux tienen compilaciones empaquetadas, y hay un APK de Android para el cliente móvil. Las compilaciones de macOS están **firmadas con Developer ID y notarizadas por Apple**, y el paquete de Android va firmado con una clave real; la de Windows **todavía no está firmada**.

## ✨ Las seis cosas de las que realmente va

### 1. Una colección de agentes, no un favorito

Catorce CLIs de programación conviven en una sola interfaz: **Claude Code · Codex · Cursor · Gemini · qoder · opencode · Qwen · Copilot · Pi · Kimi · Reasonix · Trae · Antigravity · DeepSeek**.

Las listas de modelos se **leen de la configuración local real de cada CLI** — nada está codificado a mano, así que lo que ves es lo que tu cuenta puede ejecutar de verdad. También puedes añadir entradas a mano, y sobreviven a la siguiente actualización. **opencode** es en sí mismo una pasarela multiproveedor: conéctalo una vez, alcanza muchos.

### 2. Cambia de agente y de modelo dentro de una misma sesión

El agente, el modelo y el modo de permisos son tres selectores situados bajo el campo de redacción. Cambia cualquiera de ellos antes de tu siguiente mensaje:

- ¿Un modelo se atasca o se desvía? → cambia y sigue preguntando; ve la conversación hasta ese punto.
- ¿Sin cuota en un proveedor? → cambia a otro, en la misma sesión.
- Modelo caro para pensar, modelo barato para el trabajo mecánico.

Los agentes con reanudación nativa (Claude Code, Codex, Cursor, qoder, opencode) continúan su propio historial de sesión. Para el resto, myFlowForge reconstruye el contexto. En cualquier caso, tú simplemente sigues hablando.

### 3. Varios proyectos, desarrollados a la vez

Un espacio de trabajo contiene **muchos repositorios**. Una etapa puede *desplegarse en paralelo por proyecto*: frontend, backend y SDK avanzan simultáneamente, cada uno guiado por su propio agente en su propio **git worktree**, de modo que nunca chocan — y cada diff aterriza en un único panel de Cambios para revisarlo.

El despliegue en paralelo admite también un subconjunto: analizar los cinco repositorios pero escribir código solo en dos es una configuración perfectamente normal.

### 4. Un flujo de trabajo ligero — en marcha manual

Iniciar un flujo de trabajo **no** lo pone a correr hasta el final. Entra en un modo conversacional:

- Una cinta muestra *paso N de M · etapa actual · qué agente lleva el timón*.
- El agente de la etapa trabaja **en el chat, delante de ti** — salida, llamadas a herramientas y escrituras de archivos, todo visible.
- ¿No te convence? Sigue hablando sin más. Las preguntas de seguimiento y las correcciones no vuelven a ejecutar la etapa.
- ¿Contento? Pulsa **Siguiente**. Solo entonces se escribe el traspaso y entra el siguiente agente.

La etapa de Diseño escribe un **documento markdown real** (`forge-docs/design.md`), dividido en secciones por proyecto. Ese documento — y no un resumen con pérdidas — es el contrato único entre agentes; los agentes posteriores lo leen entero y se centran en su propia sección.

Las etapas con puerta de control se detienen y te esperan: **aprobar**, **devolver** (tus notas se fijan arriba del todo y la salida anterior se reinyecta como base) o simplemente **hacer una pregunta** sin provocar una nueva ejecución. ¿Te das cuenta tarde de que el diseño estaba mal? Salta a una etapa anterior y rehazla.

### 5. Hooks entre las etapas

Un hook es un pequeño paso encajado **entre** etapas — donde una etapa es un agente haciendo ingeniería de verdad, un hook es una tarea rutinaria que se resuelve de paso.

Engancha uno **antes de la ejecución**, **después de una etapa concreta** o **después de toda la ejecución**: traer el último código, sincronizar el documento de diseño con tu wiki, pasar el lint, actualizar un tablero, enviar una notificación.

Cada hook se ejecuta como un **micro-agente restringido** en la raíz del espacio de trabajo — solo con las skills y herramientas que se le dieron, más la tarea y los artefactos producidos aguas arriba. Informa de vuelta en una línea y te pregunta directamente cuando topa con algo que solo una persona puede resolver. Un fallo **bloquea** la tubería y ofrece reintentar / omitir / abortar. Los hooks viven en una biblioteca global, independiente de cualquier ranura: escríbelo una vez, engánchalo donde sea.

### 6. Tus máquinas, y tu teléfono

El host al que estás conectado es un **conmutador en la barra de estado**, junto al botón del terminal. Acciónalo y la lista de espacios de trabajo, las sesiones, los agentes en marcha, los cambios de git y el terminal integrado pasan a ser los *de esa máquina*.

- **Directo** por tu red local, o por **SSH**, o a través de un **relay cifrado de extremo a extremo** cuando las dos máquinas no se ven entre sí. El relay solo mueve texto cifrado — no puede leer una sesión, y la sala se deriva de la clave pública del daemon.
- En un equipo Linux sin interfaz, ejecuta el **daemon**: `myflowforge-daemon pair` imprime un código QR en el propio terminal. Escanéalo y ya estáis emparejados.
- El **cliente móvil** (iOS y Android) es un cliente de verdad, no un visor: lee la conversación mientras fluye, responde a puertas de permisos y de plan, explora archivos modificados, crea un espacio de trabajo, edita un flujo de trabajo, cambia de host.

---

<div align="center">

<img src="assets/screenshots/workflow.jpg" alt="Composición de etapas — cada etapa elige su propio agente y modelo; Desarrollo se despliega en paralelo a dos proyectos" width="90%" />

<sub><b>Composición de etapas</b> — cinco etapas, cada una con su propio agente y modelo; <i>Desarrollo</i> se despliega en paralelo por dos repositorios.</sub>

</div>

---

## 🤖 Agentes de programación compatibles

| Agente | Chat | Flujo de trabajo | Reanudación nativa | MCP | Modelos |
|-------|:----:|:--------:|:-------------:|:---:|--------|
| **Claude Code** | ✅ | ✅ | ✅ | ✅ | detectados desde la CLI |
| **Codex** | ✅ | ✅ | ✅ | ✅ | detectados desde la CLI |
| **Cursor** | ✅ | ✅ | ✅ | ✅ | detectados desde la CLI |
| **qoder** | ✅ | ✅ | ✅ | ✅ | detectados + lista propia |
| **opencode** | ✅ | ✅ | ✅ | ✅ | pasarela multiproveedor |
| **Gemini** | ✅ | ✅ | — | ✅ | lista predefinida |
| **Qwen** | ✅ | ✅ | — | ✅ | lista predefinida |
| **Copilot** | ✅ | ✅ | — | ✅ | lista predefinida |
| **Pi** | ✅ | ✅ | — | — | predet. de la cuenta / personalizado |
| **Kimi** | ✅ | ✅ | — | — | kimi-k2.5 · 256K |
| **Reasonix** | ✅ | ✅ | — | — | deepseek-flash / reasoner |
| **Trae** | ✅ | ✅ | — | — | predet. de la cuenta (`/model` o `trae_cli.yaml`) |
| **Antigravity** | ✅ | ✅ | ✅ | — | actualizados con `agy models` |
| **DeepSeek** 🆕 | ✅ | ✅ | — | — | predet. de la cuenta |

> **DeepSeek** es DeepSeek Harness — `npm install -g @deepseek-ai/dsh`. Elige la forma de ejecución mediante un perfil en lugar de un indicador headless; myFlowForge gobierna el perfil `headless`, y los tres niveles de permisos se corresponden con sus propios `read-only` / `workspace-write` / `danger-full-access`. Dale una clave con `dsh web` (página de Modelos) o con `DEEPSEEK_API_KEY`.
>
> **Trae** (la CLI TraeCode de ByteDance) no se distribuye por npm — su `install.sh` oficial coloca `traecli` en `~/.local/bin`, así que asegúrate de que esa ruta esté en tu PATH. Para ediciones desatendidas dentro de un flujo de trabajo, ejecuta `traecli config edit` y define `permission_mode: bypass_permissions`.

myFlowForge **no almacena claves de API ni actúa de proxy de ninguna petición** — gobierna las CLIs que ya tienes instaladas y autenticadas en tu máquina. Lo que falte se señala en Ajustes con indicaciones de instalación, y Ajustes también te avisa cuando una CLI está instalada pero sin sesión iniciada.

## 🔧 Cómo se moldea una ejecución

```
   Tú describes el objetivo
            │
            ▼
  ┌─ hook ─┐        ┌─ hook ─┐                    ┌─ hook ─┐
  │ antes  │        │  tras  │                    │  tras  │
  │  ejec. │        │ diseño │                    │  ejec. │
  └───┬────┘        └───┬────┘                    └───┬────┘
      ▼                 ▼                             ▼
 📋 Requisitos → 🎨 Diseño → ✋ PUERTA → 💻 Desarrollo → 🧪 Prueba → 🔍 Revisión
   (aclarar)     (design.md)  tú decides  (paralelo)  (verificar)  (multi-lente)
                      │                       │
                      │                       └─ un agente por proyecto,
                      │                          carriles paralelos, worktree propio
                      └─ un documento real, leído entero por cada agente posterior

 Cada flecha espera a que pulses "Siguiente". Las etapas se pueden añadir,
 quitar, reordenar u omitir — ejecutar solo Requisitos → Desarrollo es válido.
```

Tres formas de iniciar una, todas desembocando en la misma puerta:

1. Pulsa **Iniciar** en el panel de Flujo de trabajo.
2. Escribe `/` en el campo de redacción y elige uno.
3. Describe una tarea de desarrollo completa en lenguaje llano — el agente principal la reconoce y levanta una puerta de plan a través de MCP. Las preguntas, las discusiones y los arreglos de una línea no la activan.

## 📱 Hosts remotos y el cliente móvil

Una sola aplicación, varias máquinas. Elige el host en la barra de estado y todo lo demás lo sigue.

| | |
|---|---|
| **Directo** | Misma red local, directo al puerto del daemon. Autenticado por token. |
| **SSH** | Reutiliza un acceso SSH que ya tienes — nada nuevo que abrir. |
| **Relay** | Para máquinas que no se ven entre sí. **Cifrado de extremo a extremo**: claves nuevas por sesión, el relay solo reenvía texto cifrado, y una trama ilegible se descarta en lugar de darse por buena. Monta el tuyo (`relay/`, Node o un Cloudflare Worker) — los pasos de despliegue están en `relay/README.md`. |

**El daemon de Linux** es la misma base de código sin la ventana — instala el tarball, ejecútalo bajo systemd y emparéjalo escaneando el código QR que imprime en el terminal (`docs/linux-deploy.md`).

**El cliente móvil** cubre las partes que de verdad necesitas lejos del escritorio: la conversación en vivo con el razonamiento en streaming, tarjetas de herramientas y tarjetas de sub-agentes; puertas de permisos y de plan que puedes responder; archivos modificados y diffs; creación de espacios de trabajo; la biblioteca de plantillas de flujos de trabajo; cambio de host y emparejamiento por QR. Markdown, tablas e imágenes locales se renderizan de forma nativa — las direcciones de imágenes remotas se quedan como enlaces a propósito, para que la salida de un agente nunca pueda convertir tu teléfono en una baliza de rastreo.

## 🧩 También viene en la caja

- **Importación de sesiones nativas** — análisis de solo lectura de tu historial local de Claude / Codex / Cursor / qoder; impórtalo como espacio de trabajo y continúa.
- **Puente MCP** — un servidor Forge MCP integrado permite a los agentes llamar de vuelta a la aplicación: `forge_ask`, `forge_propose_plan`, `forge_write_artifact`, `forge_handoff`, `forge_delegate`, `forge_read_context`, `forge_heartbeat`. Se inyecta en los agentes compatibles con MCP; el resto recurre a una directiva de texto.
- **Servidores MCP y complementos** — mira qué servidores MCP tiene configurados cada CLI, autorízalos o revócalos desde la aplicación, y explora un mercado de skills para instalarlas en las CLIs que las leen.
- **Memoria** — notas por espacio de trabajo que los agentes pueden releer, de modo que el trabajo de larga duración mantiene su propio hilo.
- **Observabilidad en tiempo real** — razonamiento en streaming / llamadas a herramientas / cambios de archivos / salida en bruto, una consola de registro filtrable, historial de ejecuciones y evidencias de cambios entre proyectos.
- **Uso de tokens y cuota** — cuota restante y horas de reinicio por proveedor, además del gasto por espacio de trabajo × agente × día.
- **Puente de bots** — responde a puertas, consulta resultados, inicia una conversación y gobierna flujos de trabajo desde **DingTalk**, **Telegram** o **Feishu** en tu teléfono.
- **Modos de permisos** — solo lectura · automático en el espacio de trabajo (predeterminado) · acceso completo, por sesión o por etapa. Se corresponden con el alcance real de la sandbox de cada CLI, y la interfaz dice claramente qué agentes lo respetan de verdad.
- **Comandos de barra, skills y plugins** — `/` muestra tus comandos reales en disco y las skills instaladas, filtrados por agente.
- **Flujos de trabajo personalizados** — el proceso es tuyo para montarlo: guarda tantos flujos con nombre como quieras, cada uno con su propio conjunto de etapas; cada etapa elige su agente, su modelo, su modo de permisos, su forma de despliegue en paralelo, si tiene puerta y si debe producir un documento.
- **Etapas personalizadas** — una biblioteca global de etapas propias, referenciable desde cualquier flujo de trabajo.
- **Explorador de archivos y diff** — árbol a pantalla completa con marcas de cambio, vista previa con resaltado de sintaxis, conmutador entre diff y archivo completo.
- **Terminal integrado** — un pty real enraizado en el espacio de trabajo, con ajustes de proxy y zona horaria por proveedor. Conectado a un host remoto, abre un shell **en esa máquina**.
- **Mascota de escritorio** — sigue la pantalla que tienes en foco, previsualiza la actividad del agente, saca tarjetas de confirmación; explora el mercado de mascotas o trae tus propias imágenes.
- **Mascota que crece** — la mascota de escritorio crece por etapas a medida que trabajas, de modo que las sesiones largas dejan algo visible detrás.
- **Transparencia y cristal esmerilado** — un único deslizador de desenfoque lleva toda la ventana desde totalmente opaca hasta tres materiales de vibrancy nativos de macOS, para que se vea tu escritorio a través.
- **Personalización** — 6 skins originales, 12 colores de acento, una galería de más de 300 fondos de pantalla o tu propia imagen, tamaños de fuente al píxel exacto para la aplicación y el chat por separado, con el contraste claro y oscuro ajustados de forma independiente.
- **Tematización guiada por el fondo de pantalla** — actívala y toda la paleta se deriva del fondo que hayas elegido, y es la propia imagen la que decide si es clara u oscura. El fondo de pantalla solo aporta dos tonos; cada paso de luminosidad y croma se copia de las skins ajustadas a mano, así que una imagen recargada no puede producir una interfaz ilegible. ¿Prefieres tu propio acento? Elige uno y solo el acento deja de seguir al fondo.
- **Imágenes y elementos visuales incrustados en el chat** — una imagen que un agente produce en disco se renderiza en la respuesta, y basta un clic para verla a tamaño completo. Los fragmentos HTML escritos a mitad de una respuesta pueden renderizarse como tarjetas, tablas y diagramas reales (desactivado por defecto). Nunca `innerHTML` — el fragmento se analiza y se reconstruye a partir de una lista de permitidos constructiva, y los colores solo pueden venir de tokens del tema, de modo que el contenido renderizado sigue a tu skin en vez de pelearse con ella.

## 📥 Descarga e instalación

Coge la última compilación de la página de [**Releases**](https://github.com/flowForges/myFlowForge/releases):

| Plataforma | Archivo |
|----------|------|
| macOS · Apple Silicon (M1–M4) | `myFlowForge-<version>-arm64.dmg` |
| macOS · Intel | `myFlowForge-<version>.dmg` |
| Windows · x64 | `myFlowForge-<version>-x64-setup.exe` |
| Android | `myFlowForge-<version>.apk` |
| Linux · daemon sin interfaz | `myFlowForge-daemon-<version>-linux.tar.gz` |

> Las compilaciones de **macOS** están firmadas y notarizadas: descargar, doble clic y listo. Ya no aparece lo de *"está dañada"*.
> Las de **Windows** aún no están firmadas, así que SmartScreen te detendrá una vez: **Más información → Ejecutar de todas formas**.
>
> myFlowForge consulta esos mismos Releases y te avisa dentro de la app cuando hay versión nueva.

**iOS** se distribuye por TestFlight (por ahora solo por invitación: hay que añadir tu Apple ID a la lista de probadores). También puedes compilarlo desde `mobile/` con tu propio Apple ID e instalarlo por cable.

## 🚀 Primeros pasos

**Requisitos previos:** macOS 11+ / Windows 10+ / un Linux moderno, Node.js ≥ 20, git, y al menos una CLI de programación compatible instalada y autenticada.

```bash
git clone https://github.com/flowForges/myFlowForge.git
cd myFlowForge
npm install
npm run dev          # modo de desarrollo con recarga en caliente del renderer
```

| Comando | Qué hace |
|---------|--------------|
| `npm run dev` | Arranca con recarga en caliente |
| `npm test` | Ejecuta la suite de pruebas completa (Vitest) |
| `npm run typecheck` | Comprueba los tipos de ambos tsconfig, main y renderer |
| `npm run build` | Compila el paquete de producción |
| `npm run dist:mac-all` | Compila los `.dmg` de Intel y de Apple Silicon |
| `npm run dist:win` | Compila el instalador de Windows x64 |
| `npm run check:daemon` | Ejercita el daemon sin interfaz de principio a fin |

El cliente móvil vive en `mobile/` (Expo / React Native) y el relay en `relay/`; ambos tienen su propio `package.json`.

Los artefactos aterrizan en `release/`. Los cambios bajo `src/main/**` requieren un **reinicio completo de Electron** — la recarga en caliente solo refresca el renderer.

## 🏗️ Pila tecnológica

**Carcasa:** [Electron](https://www.electronjs.org/) 42 + [electron-vite](https://electron-vite.org/) · **UI:** [React](https://react.dev/) 19 + TypeScript 6 · **Móvil:** [Expo](https://expo.dev/) + [React Native](https://reactnative.dev/) · **Terminal:** [xterm.js](https://xtermjs.org/) + [node-pty](https://github.com/microsoft/node-pty) · **Puente de agentes:** [Model Context Protocol SDK](https://modelcontextprotocol.io/) · **Control de procesos:** [execa](https://github.com/sindresorhus/execa) · **Validación:** [zod](https://zod.dev/) · **Vigilancia de archivos:** [chokidar](https://github.com/paulmillr/chokidar) · **Pruebas:** [Vitest](https://vitest.dev/) + Testing Library · **Empaquetado:** [electron-builder](https://www.electron.build/)

## 📁 Estructura del proyecto

```
src/
├── main/              # Proceso principal de Electron
│   ├── agents/        # Adaptadores de CLI + registro de proveedores, detección, permisos
│   ├── run/           # Motor de flujos: etapas, puertas, paralelismo, hooks, traspasos
│   ├── chat/          # Chat por espacio de trabajo, cola, memoria
│   ├── mcp/           # Servidor Forge MCP (puente agente → aplicación)
│   ├── remote/        # Hosts remotos: directo / SSH / relay, enrutado, canal E2E
│   ├── daemon/        # Daemon sin interfaz + emparejamiento por QR en el terminal
│   ├── bot/           # Puente de bots (transportes DingTalk / Telegram / Feishu)
│   ├── plugins/       # Anfitrión de plugins, catálogo, planificador, puntos de extensión
│   ├── sessionImport/ # Análisis e importación de sesiones nativas
│   ├── usage/         # Adaptadores de cuota por proveedor
│   ├── pet/           # Ventana de la mascota de escritorio
│   └── ...            # git, fs, terminal, actualización, watcher, ventanas, apariencia
├── renderer/          # UI de React (vistas, componentes, ajustes, tema, mascota)
├── preload/           # Puente IPC con aislamiento de contexto
└── shared/            # Tipos y lógica pura compartidos entre procesos
mobile/                # Cliente de iOS y Android (Expo / React Native)
relay/                 # Relay cifrado de extremo a extremo (Node o Cloudflare Worker)
```

## 🤝 Contribuir

Los issues y las PR son bienvenidos. El proyecto está **guiado por pruebas** — añade o actualiza pruebas con tus cambios y asegúrate de que `npm test` y `npm run typecheck` pasan antes de abrir una PR.

## 📄 Licencia

Publicado bajo la [Licencia MIT](LICENSE) © 2026 zghua.

## 🙏 Agradecimientos

Construido sobre el ecosistema de código abierto alrededor de Electron, React, Vite y el Model Context Protocol — y sobre los agentes de programación que orquesta.

## 🔗 Enlaces

- [LINUX DO](https://linux.do/latest) — una comunidad de desarrolladores a los que les gusta trastear
