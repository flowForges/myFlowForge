/* 假 daemon:说的是**真线协议**(src/shared/remote/protocol.ts 那套帧),
   但数据是编的,而且可以按脚本在指定时刻推门。
   为什么要它:门是手机端存在的唯一理由,而真门需要真代理真跑一轮才升得起来 ——
   既慢又烧配额,还没法复现「两道门」「别人先答了」这些边角。 */
import { createRequire } from 'node:module'
const require_ = createRequire(import.meta.url)
// ws 只在仓库根装着(手机端 bundle 用的是平台自带的 WebSocket),从这里借来跑测试。
const pkg = require_('../../node_modules/ws')
const { WebSocketServer } = pkg

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const IDENTIFY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.out', 'last-identify.txt')
try { fs.mkdirSync(path.dirname(IDENTIFY_FILE), { recursive: true }) } catch { /* 已存在 */ }
try { fs.rmSync(IDENTIFY_FILE, { force: true }) } catch { /* 没有就算了 */ }
/* 手机每报一次「这条会话我看过了」就往这儿追加一行。
   ★为什么要落成文件:上报是**发出去**的东西,浏览器里一点痕迹都不留 ——
   不记下来的话,「一轮在你开着页面时跑完,手机有没有吭声」这件事在 e2e 里根本观测不到。 */
const SEEN_LOG = path.join(path.dirname(IDENTIFY_FILE), 'mark-seen.log')
try { fs.rmSync(SEEN_LOG, { force: true }) } catch { /* 没有就算了 */ }

const PORT = Number(process.argv[2] || 6799)
const SCRIPT = process.argv[3] || 'gate-confirm'

const WS_A = '/Users/zghua/work/mock/alpha'
const WS_B = '/Users/zghua/work/mock/beta'
const workspaces = [
  { name: 'alpha', path: WS_A, projectCount: 3, workflowId: 'standard', status: 'run', pinned: false, archived: false, archivedAt: null, createdAt: 1, description: '' },
  { name: 'beta', path: WS_B, projectCount: 2, workflowId: 'custom', status: 'idle', pinned: false, archived: false, archivedAt: null, createdAt: 1, description: '' },
]
const sessions = {
  [WS_A]: { sessions: [
    { id: 's-a1', title: '修 gate 重复放行', mode: 'chat', createdAt: 1, lastMessageAt: Date.now() - 120000, agentId: 'claude' },
    { id: 's-a2', title: '加 Windows 打包脚本', mode: 'chat', createdAt: 1, lastMessageAt: Date.now() - 372000, agentId: 'codex' },
  ], activeSessionId: 's-a1' },
  [WS_B]: { sessions: [
    { id: 's-b1', title: '迁移评论表到 v2', mode: 'chat', createdAt: 1, lastMessageAt: Date.now() - 420000, agentId: 'codex' },
  ], activeSessionId: 's-b1' },
}
// 工具卡的原料。**形状抄真数据**(本机各工作区 .forge/sessions 下 762 条落档的 ToolActivity):
//  · claude 给 `调用 Read <路径>` + name,输出是 `1\t文本` 的带行号片段
//  · codex 给 `调用 shell: /bin/zsh -lc '<命令>'`,**没有 name**,输出是自由文本
//  · codex 的 `编辑文件: <绝对路径>` **一个字的 output 都没有**
// ★最后这一条尤其要留着:它正是「provider 什么都没给」的那一类,手机端必须如实说没有,不能编个 diff。
const TOOLS_A1 = [
  {
    id: 't1', name: 'Read', status: 'ok',
    title: '调用 Read src/main/ipc/handlers.ts',
    output: [
      '477\t  const drainGates = (ws: string) => {',
      '478\t    emitNote(ws, sid, `已按新权限档放行 ${n} 道门`)',
      '479\t  }',
      '480\t',
      '481\t  const onPermissionChange = (mode: PermissionMode) => {',
    ].join('\n'),
  },
  {
    id: 't2', name: 'Edit', status: 'ok',
    title: '调用 Edit src/main/ipc/handlers.ts',
    output: [
      '--- a/src/main/ipc/handlers.ts',
      '+++ b/src/main/ipc/handlers.ts',
      '@@ -477,4 +477,6 @@',
      '   const drainGates = (ws: string) => {',
      '-    emitNote(ws, sid, `已按新权限档放行 ${n} 道门`)',
      '+    for (const g of pending) {',
      '+      emitNote(ws, sid, `自动放行:${g.where}`)',
      '+    }',
      '   }',
    ].join('\n'),
  },
  {
    id: 't3', status: 'ok',
    title: "调用 shell: /bin/zsh -lc 'npm test -- ipc'",
    // 300 行 —— 故意超过 BODY_LINE_CAP(200),用来验「截断要说出来」。
    output: Array.from({ length: 300 }, (_, i) => `  ok ipc/handlers 第 ${i + 1} 项`).join('\n'),
  },
  // ★codex 的补丁行:没有 output。手机端展开只该说「这个工具没有回传输出」。
  { id: 't4', status: 'ok', title: '编辑文件: /Users/zghua/work/mock/alpha/forge/src/main/ipc/handlers.test.ts' },
  { id: 't5', name: 'Bash', status: 'error', title: '调用 Bash: npm run typecheck', output: 'error TS2345: 类型对不上' },
]

// 内置子代理(claude 的 Task)。**落档**在消息上,所以从历史里就能拿到。
// ★留一个 running 的:`finalizeRunning` 只在主轮次结束时收尾,而手机常常是半路加入的,
//  历史里躺着一个还在跑的子代理是真会发生的。
const SUBAGENTS_A1 = [
  { id: 'sa1', state: 'done', subagentType: 'Explore', description: '找出所有权限门的入口', result: '三处:handlers.ts:479、gate.ts:88、run2.ts:210', steps: ['调用 Grep: confirm-request', '调用 Read src/main/ipc/handlers.ts'] },
  { id: 'sa2', state: 'running', subagentType: 'general-purpose', description: '补 handlers 的单测', steps: ['调用 Read src/main/ipc/handlers.test.ts', '调用 Bash: npm test -- ipc'] },
  { id: 'sa3', state: 'error', subagentType: 'Explore', description: '查 codex 那条分支', result: '已取消' },
]

// 分隔线要能被**确定地**断言,所以两条回复的 startedAt 锚在「今天 23:50 / 23:55」。
// 用户那条只有 `23:04` 这种没有日期的时刻(真数据就是这样),手机端靠同一轮回复的日期把它补全。
const todayAt = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime() }

const history = {
  's-a1': [
    { id: 'm1', who: 'user', text: 'handlers.ts 里权限档切到完全访问会把挂起的门全放行,但日志只打了一条。帮我改成逐条打,并补个单测。', ts: '23:04' },
    { id: 'm2', who: 'ai', model: 'Claude Code · Opus', text: '先看现在的放行逻辑。emitNote 只在循环外调了一次,所以 3 个门只会留下 1 行记录 —— 事后查不出哪条命令被自动放行了。', think: { label: '思考 8 秒', steps: ['读取 src/main/ipc/handlers.ts', '编辑 src/main/ipc/handlers.ts'] }, ts: '23:05', startedAt: todayAt(23, 50), tools: TOOLS_A1, subagents: SUBAGENTS_A1 },
    // 第二轮:用来验分隔线**只在轮次之间**来一根,而不是每条消息都来。
    { id: 'm3', who: 'user', text: '顺手把 typecheck 也跑一下。', ts: '23:41' },
    { id: 'm4', who: 'ai', model: 'Claude Code · Opus', text: '跑了,有一处类型对不上。', ts: '23:42', startedAt: todayAt(23, 55) },
  ],
  // 真机上撞见的那一段:代理在回答中间吐了一坨卡片布局的 HTML,把正文推出去四五屏。
  's-a2': [
    { id: 'h1', who: 'user', text: '把刚才那几条约定复述一遍', ts: '17:02' },
    { id: 'h2', who: 'ai', model: 'Codex · GPT-5.6-Sol', ts: '17:03', text: [
      '要点如下:',
      '',
      '<div style="display:flex; gap:8px; margin:8px 0;">',
      '  <div style="flex:1; border:1px solid #999; border-radius:6px; padding:8px;">',
      '    <div style="font-weight:700;">已确认</div>',
      '    <div style="margin-top:4px;">复杂结构用内嵌 HTML 片段;仅内联 style;简单回答保持纯文本。</div>',
      '  </div>',
      '  <div style="flex:1; border:1px solid #999; border-radius:6px; padding:8px;">',
      '    <div style="font-weight:700;">待你提供</div>',
      '    <div style="margin-top:4px;">具体要做的事:看代码、改功能、修 bug、写方案,或别的。</div>',
      '  </div>',
      '</div>',
      '',
      '工作目录是 `/Users/zghua/work/workspace/for-test-0823`。你想让我做什么?',
    ].join('\n') },
  ],
  's-b1': [],
}
const agents = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus', label: 'Opus', description: 'opus → claude-opus-5' }, { id: 'sonnet', label: 'Sonnet' }] },
  { id: 'codex', displayName: 'Codex', installed: true, models: [{ id: 'default', label: '账号默认' }] },
]
const gateState = { [WS_A]: { confirms: [], asks: [] }, [WS_B]: { confirms: [], asks: [] } }
// 哪些会话「正在跑」。手机是半路加入的,它只能靠问 chat:queue-state 才知道停止键该不该亮。
const RUNNING = []

// 变更:假的但结构是真的(ChangeItem / MultiChanges / DiffLine 三个 shared 类型)
const projects = { [WS_A]: ['forge', 'site'], [WS_B]: ['api'] }
// 工作流:阶段形状照 WorkflowStageView(key/name/provider/model/scope)。
// per-project = 扇出阶段,推进到它就是真开跑 —— 手机上要先弹一句确认。
const WORKFLOWS = [
  { id: 'standard', name: '标准流' },
  { id: 'quick', name: '快速修复' },
]
const STAGES = {
  standard: [
    { key: 'require', name: '需求评估', provider: 'claude', model: 'opus', scope: 'root' },
    { key: 'design', name: '技术方案设计', provider: 'claude', model: 'opus', scope: 'root' },
    { key: 'develop', name: '代码开发', provider: 'codex', model: 'default', scope: 'per-project' },
    { key: 'test', name: '写单测', provider: 'codex', model: 'default', scope: 'per-project' },
  ],
  quick: [
    { key: 'develop', name: '代码开发', provider: 'codex', model: 'default', scope: 'per-project' },
  ],
}
const FEEDBACK_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.out', 'last-feedback.txt')
try { fs.rmSync(FEEDBACK_FILE, { force: true }) } catch { /* 没有就算了 */ }

function findSession(wsPath, sessionId) {
  return (sessions[wsPath]?.sessions ?? []).find((x) => x.id === sessionId)
}
const changes = {
  [WS_A + '/forge']: [
    { path: 'src/main/ipc/handlers.ts', type: 'M', add: 12, del: 4 },
    { path: 'src/main/ipc/handlers.test.ts', type: 'A', add: 46, del: 0 },
  ],
  [WS_A + '/site']: [{ path: 'index.html', type: 'M', add: 2, del: 2 }],
  [WS_B + '/api']: [],
}
const diffs = {
  'src/main/ipc/handlers.ts': [
    { kind: 'ctx', ln: 477, text: '  const drainGates = (ws: string) => {' },
    { kind: 'del', ln: 478, text: '    emitNote(ws, sid, `已按新权限档放行 ${n} 道门`)' },
    { kind: 'add', ln: 478, text: '    for (const g of pending) {' },
    { kind: 'add', ln: 479, text: '      emitNote(ws, sid, `🛡 自动放行:${g.where}`)' },
    { kind: 'add', ln: 480, text: '    }' },
    { kind: 'ctx', ln: 481, text: '  }' },
  ],
}

// 文件树。形状照 `TreeNode`(src/shared/types.ts):嵌套 dir/file,path 相对 cwd,
// 改动过的文件带 chg(**git 的 A/M/D,不是自造的字符串**),git 仓库目录带 branch。
// ★故意让服务端给的顺序是**乱的**:真实的 `git ls-files` 就不按「目录在前、文件在后」排,
//  排序是手机端自己该做的事。这里排好了,那条断言就等于没验。
const TREES = {
  [WS_A + '/forge']: [
    { type: 'file', name: 'README.md', path: 'README.md' },
    {
      type: 'dir', name: 'src', path: 'src', children: [
        {
          type: 'dir', name: 'main', path: 'src/main', children: [
            { type: 'file', name: 'index.ts', path: 'src/main/index.ts' },
            { type: 'file', name: 'handlers.ts', path: 'src/main/handlers.ts', chg: 'M' },
            { type: 'file', name: 'handlers.test.ts', path: 'src/main/handlers.test.ts', chg: 'A' },
            { type: 'dir', name: 'ipc', path: 'src/main/ipc', children: [
              { type: 'file', name: 'channels.ts', path: 'src/main/ipc/channels.ts' },
            ] },
          ],
        },
        { type: 'file', name: 'app.ts', path: 'src/app.ts' },
      ],
    },
    { type: 'dir', name: 'assets', path: 'assets', children: [], branch: 'feat/x' },
  ],
  [WS_A + '/site']: [{ type: 'file', name: 'index.html', path: 'index.html', chg: 'M' }],
  [WS_B + '/api']: [],
}
// 文件正文。`git:file` 返回的是 `FilePreview { text, lang }`。
// ★那个 1000 行的:用来验「超过 800 行要截断,并且如实说截了多少」。
const FILES = {
  'README.md': { text: '# forge\n\n一个本地跑的多代理工作台。\n', lang: 'markdown' },
  // 变更列表里那个文件走的是这个路径 —— 「点变更里的文件再切全文」那条入口靠它。
  'src/main/ipc/handlers.ts': {
    text: [
      "import { CH } from './channels'",
      '',
      'export function registerIpc() {',
      '  // 权限档切到完全访问时逐条放行',
      '  for (const g of pending) emitNote(g.where)',
      '}',
    ].join('\n'),
    lang: 'typescript',
  },
  'src/main/handlers.ts': {
    text: [
      "import { CH } from './channels'",
      '',
      'export function registerIpc() {',
      '  // 权限档切到完全访问时逐条放行',
      '  for (const g of pending) emitNote(g.where)',
      '}',
    ].join('\n'),
    lang: 'typescript',
  },
  'src/app.ts': { text: Array.from({ length: 1000 }, (_, i) => `const l${i} = ${i}`).join('\n'), lang: 'typescript' },
  'src/main/index.ts': { text: '', lang: 'typescript' },
}

const table = {
  'workspaces:list': () => workspaces,
  'session:list': (p) => sessions[p] ?? { sessions: [], activeSessionId: '' },
  'chat:history': (a) => history[a.sessionId] ?? [],
  'chat:gate-state': (a) => gateState[a.workspacePath] ?? { confirms: [], asks: [] },
  'agents:detect': () => agents,
  'workspaces:get': (p) => ({
    path: p,
    workflows: WORKFLOWS,
    projects: (projects[p] ?? []).map((name) => ({ name, provider: 'codex', model: 'default' })),
  }),
  'changes:multi': (cwds) => {
    const byProject = cwds.map((cwd) => ({ cwd, changes: changes[cwd] ?? [] }))
    const all = byProject.flatMap((b) => b.changes)
    return { total: all.length, add: all.reduce((n, c) => n + c.add, 0), del: all.reduce((n, c) => n + c.del, 0), byProject }
  },
  'git:diff': (a) => diffs[a.file] ?? [],
  // ★这两条真网关本来就提供(既不在 CLIENT_ONLY 也不在 DAEMON_UNSUPPORTED),所以假的这里也要有。
  'fs:tree': (cwd) => TREES[cwd] ?? [],
  'git:file': (a) => FILES[a.file] ?? { text: '', lang: '' },
  'workflow:enter': (p) => {
    // 服务端那道硬门槛照抄过来,否则手机端的必填校验等于没验过。
    if (!p.sessionId) throw new Error('workflow:enter 缺少 sessionId')
    if (!(p.seed || '').trim() && !(p.supplement || '').trim())
      throw new Error('还不知道这次要做什么:先说一句需求(或在启动卡的补充说明里写一句)再启动工作流。')
    if (!(p.projects || []).length) throw new Error('至少要选一个项目')
    const stages = STAGES[p.workflowId]
    if (!stages) throw new Error(`不认识的工作流: ${p.workflowId}`)
    const session = {
      flowId: p.workflowId,
      flowName: WORKFLOWS.find((w) => w.id === p.workflowId)?.name ?? p.workflowId,
      stages, currentIndex: 0, phase: 'chatting',
      projects: p.projects, supplement: p.supplement, seed: p.seed,
    }
    const s = findSession(p.workspacePath, p.sessionId)
    if (s) { s.workflowSession = session; s.mode = 'workflow' }
    broadcast('sessions:changed', { workspacePath: p.workspacePath, file: sessions[p.workspacePath] })
    return session
  },
  'workflow:advance': (a) => {
    const s = findSession(a.workspacePath, a.sessionId)
    if (!s?.workflowSession) throw new Error('该会话不在工作流中')
    const wf = s.workflowSession
    const i = wf.currentIndex + 1
    if (i >= wf.stages.length) { wf.phase = 'done'; wf.currentIndex = wf.stages.length }
    else { wf.currentIndex = i; wf.phase = wf.stages[i].scope === 'per-project' ? 'executing' : 'chatting' }
    broadcast('sessions:changed', { workspacePath: a.workspacePath, file: sessions[a.workspacePath] })
    return wf
  },
  'workflow:exit': (a) => {
    const s = findSession(a.workspacePath, a.sessionId)
    if (s) { delete s.workflowSession; s.mode = 'chat' }
    broadcast('sessions:changed', { workspacePath: a.workspacePath, file: sessions[a.workspacePath] })
    return sessions[a.workspacePath]
  },
  'run2:add-feedback': (p) => {
    try { fs.writeFileSync(FEEDBACK_FILE, String(p.text ?? '')) } catch { /* 测试辅助 */ }
    return undefined
  },
  'chat:send': () => undefined,
  'chat:stop': () => undefined,
  // 跨设备未读:原样广播回去。真实主进程就是这么做的(handlers.ts 的 chat:mark-seen)。
  'chat:mark-seen': (a) => {
    if (!a?.workspacePath || !a?.sessionId) return
    // 落一行档,`e2e/unread.mjs` 靠它验「手机到底吭没吭声」。
    try { fs.appendFileSync(SEEN_LOG, `${a.workspacePath} ${a.sessionId}\n`) } catch { /* 测试辅助 */ }
    broadcast('chat:seen', { workspacePath: a.workspacePath, sessionId: a.sessionId })
  },
  'chat:resolve': (a) => {
    // 脚本 `resolve-fails`:模拟「答门这一刀没送到」。手机上乐观摘掉的卡片必须自己回来。
    if (SCRIPT === 'resolve-fails') throw new Error('这台主机拒绝了这次答门(测试用)')
    resolveGate(a.id)
    return undefined
  },
  'chat:queue-state': (a) => ({
    workspacePath: a.workspacePath,
    busy: RUNNING.length > 0,
    queue: [], running: null, runningTurns: [],
    runningSessionId: RUNNING[0] ?? null,
    runningSessionIds: RUNNING.slice(),
  }),
  'session:new': (p) => {
    const id = 's-new-' + Date.now()
    sessions[p].sessions.unshift({ id, title: '新会话', mode: 'chat', createdAt: Date.now(), lastMessageAt: Date.now() })
    sessions[p].activeSessionId = id
    history[id] = []
    broadcast('sessions:changed', { workspacePath: p, file: sessions[p] })
    return sessions[p]
  },
}

const clients = new Set()
const send = (ws, f) => ws.send(JSON.stringify(f))
const broadcast = (ch, payload) => { for (const ws of clients) send(ws, { t: 'evt', ch, payload }) }

function resolveGate(id) {
  for (const [wsPath, g] of Object.entries(gateState)) {
    const ci = g.confirms.findIndex(x => x.id === id)
    if (ci >= 0) { const c = g.confirms.splice(ci, 1)[0]; broadcast('chat:event', { workspacePath: wsPath, sessionId: c.sessionId, type: 'confirm-resolved', id }); return }
    const ai = g.asks.findIndex(x => x.id === id)
    if (ai >= 0) { const a = g.asks.splice(ai, 1)[0]; broadcast('chat:event', { workspacePath: wsPath, sessionId: a.sessionId, type: 'ask-resolved', id }); return }
  }
}

function raiseConfirm({ wsPath, sessionId, id, title, where }) {
  gateState[wsPath].confirms.push({ id, sessionId, title, where, ts: new Date().toISOString() })
  broadcast('chat:event', { workspacePath: wsPath, sessionId, type: 'confirm-request', id, title, where })
}
function raiseQuestions({ wsPath, sessionId, id, questions }) {
  const title = questions[0].question
  gateState[wsPath].confirms.push({ id, sessionId, title, questions, ts: new Date().toISOString() })
  broadcast('chat:event', { workspacePath: wsPath, sessionId, type: 'confirm-request', id, title, questions })
}

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT })
// ★端口被占就**大声死**。以前这里什么都不做,于是撞 EADDRINUSE 时进程静静退出,
//  而测试脚本(stderr 是 ignore 的)照样往下跑,连上的是上一轮残留的那个 daemon。
wss.on('error', (e) => {
  console.error(`假 daemon 起不来(端口 ${PORT}):${e && e.message ? e.message : e}`)
  console.error('多半是上一次跑挂在半路没收拾。先 `pkill -f mock-daemon.mjs` 再来。')
  process.exit(1)
})
wss.on('connection', (ws) => {
  clients.add(ws)
  send(ws, { t: 'hello', protocol: 1, version: '1.2.0', authRequired: false })
  send(ws, { t: 'ready', methods: Object.keys(table) })
  ws.on('message', (raw) => {
    const f = JSON.parse(String(raw))
    if (f.t === 'identify') {
      // 「是谁答的门」靠的就是这一帧。落到文件里,让测试能断言它真的发了、内容对不对 ——
      // 少了它,电脑那边的系统提示会写成「本机」,而实际是手机答的。
      try { fs.writeFileSync(IDENTIFY_FILE, String(f.label ?? '')) } catch { /* 测试辅助,失败无所谓 */ }
      return
    }
    if (f.t !== 'req') return
    try {
      const fn = table[f.ch]
      if (!fn) return send(ws, { t: 'res', id: f.id, ok: false, error: `这台主机不提供 ${f.ch}` })
      // ★这里**绝不能**写 `?? null`。真网关发的就是 `value: await fn(...)`,void handler 那就是
      //  undefined,而 JSON.stringify 会把这个键整个删掉。加个 `?? null` 就等于假 daemon 比真
      //  daemon 更「规矩」,于是「void handler 的响应被当坏帧丢掉」这一整类 bug 在这里永远照不出来
      //  —— 真机上第一次发消息就撞上了(发送键点了没反应、输入框不清空)。假的要在**这一点上**跟真的一样。
      send(ws, { t: 'res', id: f.id, ok: true, value: fn(...f.args) })
    } catch (e) { send(ws, { t: 'res', id: f.id, ok: false, error: String(e && e.message || e) }) }
  })
  ws.on('close', () => clients.delete(ws))
})

// 脚本:按名字预置门。连上之前就放好,这样快照那条路也被覆盖到。
if (SCRIPT === 'gate-confirm' || SCRIPT === 'both') {
  gateState[WS_A].confirms.push({ id: 'g-confirm-1', sessionId: 's-a1', title: 'Bash 请求执行', where: 'npm run build && npm run test -- ipc', ts: new Date().toISOString() })
}
if (SCRIPT === 'running' || SCRIPT === 'resolve-fails') {
  RUNNING.push('s-a1')
}
if (SCRIPT === 'resolve-fails') {
  gateState[WS_A].confirms.push({ id: 'g-confirm-1', sessionId: 's-a1', title: 'Bash 请求执行', where: 'rm -rf build/', ts: new Date().toISOString() })
}
if (SCRIPT === 'gate-questions' || SCRIPT === 'both') {
  gateState[WS_B].confirms.push({
    id: 'g-ask-1', sessionId: 's-b1', title: '评论表迁移走哪条路?',
    questions: [{
      question: '评论表迁移走哪条路?', multiSelect: false,
      options: [
        { label: '双写 + 影子读', description: '最稳,但要多维护两周,期间写入延迟 +8ms' },
        { label: '停机迁移', description: '一次做完,需要 15 分钟停机窗口' },
        { label: '按分区滚动', description: '不停机,但回滚复杂度最高' },
      ],
    }],
    ts: new Date().toISOString(),
  })
}
console.log(`假 daemon 在 ws://127.0.0.1:${PORT} · 脚本 ${SCRIPT}`)

// 让它可被外部驱动:stdin 一行一条命令
process.stdin.on('data', (b) => {
  for (const line of String(b).trim().split('\n')) {
    const [cmd, ...rest] = line.trim().split(' ')
    if (cmd === 'confirm') raiseConfirm({ wsPath: WS_A, sessionId: 's-a1', id: 'g-' + Date.now(), title: 'Bash 请求执行', where: rest.join(' ') || 'rm -rf build/' })
    if (cmd === 'resolve') resolveGate(rest[0])
    // 一轮跑完(`finish <sessionId>`)。未读**只在终态那一刻**产生,所以要能按需造一个终态。
    if (cmd === 'finish') {
      const sid = rest[0] || 's-a2'
      broadcast('chat:event', {
        workspacePath: WS_A, sessionId: sid, type: 'done',
        message: { id: 'fin-' + Date.now(), who: 'ai', text: '跑完了。', ts: '00:00' },
      })
    }
    // ★**别的设备**说「这条看过了」(`seen <sessionId>`)。
    //  这条是手动播的、不经过 `chat:mark-seen` —— 必须如此:走那条路的话广播是手机自己
    //  触发的回声,验不出「收到别人的通知会不会清」这件事,而那正是跨设备未读的另一半。
    if (cmd === 'seen') broadcast('chat:seen', { workspacePath: WS_A, sessionId: rest[0] || 's-a2' })
    // 工具卡的**实时**那一路:先 start(只有标题,status 'run'),再 done(带 output 和结果)。
    // 两帧的 tool.id 相同 —— 手机端必须原地替换,不能追加成两张卡。
    if (cmd === 'tools') {
      const id = 'r-tools'
      broadcast('chat:event', { workspacePath: WS_A, sessionId: 's-a1', type: 'assistant-start', id, model: 'Claude Code · Opus' })
      broadcast('chat:event', {
        workspacePath: WS_A, sessionId: 's-a1', type: 'tool-activity', id,
        tool: { id: 'live-1', name: 'Bash', title: '调用 Bash: npm run build', status: 'run' },
      })
      setTimeout(() => {
        broadcast('chat:event', {
          workspacePath: WS_A, sessionId: 's-a1', type: 'tool-activity', id,
          tool: { id: 'live-1', name: 'Bash', title: '调用 Bash: npm run build', status: 'ok', output: 'built in 4.2s' },
        })
      }, 1500)
      return
    }
    // 委派批次:**服务端根本不落档**(主轮次结束后它们还在跑)。所以只能从实时流里造。
    // ★时序照真的来:主轮次**先 done**,子代理**之后**才陆续回报 —— fire-and-forget 就是这样。
    //  这个顺序是关键:done 那一刀如果把实时攒的委派卡冲掉,后面所有进度就都无处可去了。
    if (cmd === 'delegate') {
      const id = 'r-deleg'
      const ev = (o) => broadcast('chat:event', { workspacePath: WS_A, sessionId: 's-a1', ...o })
      ev({ type: 'assistant-start', id, model: 'Claude Code · Opus' })
      ev({ type: 'assistant-delta', id, text: '我把这三个项目分给三个子代理了,跑完汇总给你。' })
      ev({
        type: 'delegate-start', id,
        batch: {
          runId: 'run-1', done: false, task: '把三个项目的登录都换成新的 token 校验',
          agents: [
            { agentId: 'd1', name: 'go-blog', provider: 'codex', status: 'run' },
            { agentId: 'd2', name: 'zgh', provider: 'codex', status: 'run' },
            { agentId: 'd3', name: 'website', provider: 'claude', status: 'run' },
          ],
        },
      })
      // 主轮次到此为止。子代理还在后台跑。
      ev({ type: 'done', message: { id, who: 'ai', model: 'Claude Code · Opus', text: '我把这三个项目分给三个子代理了,跑完汇总给你。', ts: '23:58', startedAt: todayAt(23, 58) } })
      // 一条 progress 只翻一个子代理。分几拍发,整批替换的写法会在后一拍把前一拍盖回去。
      ev({ type: 'delegate-progress', id, agentId: 'd1', status: 'ok', output: 'go-blog 改完,3 个文件' })
      // ★★同一个子代理的**第二条** progress,**只带 activity 不带 output**。
      //  真的 delegate-progress 大多长这样。照单全收(把 undefined 也写进去)就会
      //  把上一条刚送到的 output 抹掉 —— 而只发一条的话,这个 bug 永远照不出来。
      ev({ type: 'delegate-progress', id, agentId: 'd1', activity: '在收尾' })
      ev({ type: 'delegate-progress', id, agentId: 'd2', activity: '正在改 service/auth.go' })
      // ★收尾**另起一条命令**,不用 setTimeout。用定时器的话,断言就是在和它赛跑:
      //  中间截个图、多跑两个 eval,批次已经结束了,于是「还在跑的那个显示什么」永远看不到。
      //  红了却不代表实现坏了 —— 那种断言比没有还糟。
      return
    }
    if (cmd === 'delegate-finish') {
      const id = 'r-deleg'
      const ev = (o) => broadcast('chat:event', { workspacePath: WS_A, sessionId: 's-a1', ...o })
      ev({ type: 'delegate-progress', id, agentId: 'd2', status: 'ok', output: 'zgh 改完,1 个文件' })
      ev({ type: 'delegate-progress', id, agentId: 'd3', status: 'idle' })
      ev({ type: 'delegate-done', id })
      return
    }
    // 内置子代理的**实时**那一路(历史里那三张走的是落档那一路,两条路要分开验)。
    if (cmd === 'subagent') {
      const id = 'r-sub'
      const ev = (o) => broadcast('chat:event', { workspacePath: WS_A, sessionId: 's-a1', ...o })
      ev({ type: 'assistant-start', id, model: 'Claude Code · Opus' })
      ev({ type: 'subagent', id, sub: { id: 'live-sa', state: 'running', subagentType: 'Explore', description: '实时起的子代理' } })
      setTimeout(() => ev({ type: 'subagent', id, sub: { id: 'live-sa', state: 'running', subagentType: 'Explore', description: '实时起的子代理', steps: ['调用 Grep: registerIpc'] } }), 700)
      setTimeout(() => ev({ type: 'subagent', id, sub: { id: 'live-sa', state: 'done', subagentType: 'Explore', description: '实时起的子代理', steps: ['调用 Grep: registerIpc'], result: '只有一处' } }), 1400)
      return
    }
    if (cmd === 'stream') {
      const id = 'r-' + Date.now()
      broadcast('chat:event', { workspacePath: WS_A, sessionId: 's-a1', type: 'assistant-start', id, model: 'Claude Code · Opus' })
      let i = 0
      const parts = ['正在改 ', 'handlers.ts', ' 的放行分支…']
      const t = setInterval(() => {
        if (i >= parts.length) { clearInterval(t); return }
        broadcast('chat:event', { workspacePath: WS_A, sessionId: 's-a1', type: 'assistant-delta', id, text: parts[i++] })
      }, 300)
    }
  }
})
