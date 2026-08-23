/* 假 daemon:说的是**真线协议**(src/shared/remote/protocol.ts 那套帧),
   但数据是编的,而且可以按脚本在指定时刻推门。
   为什么要它:门是手机端存在的唯一理由,而真门需要真代理真跑一轮才升得起来 ——
   既慢又烧配额,还没法复现「两道门」「别人先答了」这些边角。 */
import { createRequire } from 'node:module'
const require_ = createRequire(import.meta.url)
// ws 只在仓库根装着(手机端 bundle 用的是平台自带的 WebSocket),从这里借来跑测试。
const pkg = require_('../../node_modules/ws')
const { WebSocketServer } = pkg

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
const history = {
  's-a1': [
    { id: 'm1', who: 'user', text: 'handlers.ts 里权限档切到完全访问会把挂起的门全放行,但日志只打了一条。帮我改成逐条打,并补个单测。', ts: '23:04' },
    { id: 'm2', who: 'ai', model: 'Claude Code · Opus', text: '先看现在的放行逻辑。emitNote 只在循环外调了一次,所以 3 个门只会留下 1 行记录 —— 事后查不出哪条命令被自动放行了。', think: { label: '思考 8 秒', steps: ['读取 src/main/ipc/handlers.ts', '编辑 src/main/ipc/handlers.ts'] }, ts: '23:05' },
  ],
  's-a2': [], 's-b1': [],
}
const agents = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus', label: 'Opus', description: 'opus → claude-opus-5' }, { id: 'sonnet', label: 'Sonnet' }] },
  { id: 'codex', displayName: 'Codex', installed: true, models: [{ id: 'default', label: '账号默认' }] },
]
const gateState = { [WS_A]: { confirms: [], asks: [] }, [WS_B]: { confirms: [], asks: [] } }

// 变更:假的但结构是真的(ChangeItem / MultiChanges / DiffLine 三个 shared 类型)
const projects = { [WS_A]: ['forge', 'site'], [WS_B]: ['api'] }
const changes = {
  [WS_A + '/forge']: [
    { path: 'src/main/ipc/handlers.ts', type: 'edit', add: 12, del: 4 },
    { path: 'src/main/ipc/handlers.test.ts', type: 'add', add: 46, del: 0 },
  ],
  [WS_A + '/site']: [{ path: 'index.html', type: 'edit', add: 2, del: 2 }],
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

const table = {
  'workspaces:list': () => workspaces,
  'session:list': (p) => sessions[p] ?? { sessions: [], activeSessionId: '' },
  'chat:history': (a) => history[a.sessionId] ?? [],
  'chat:gate-state': (a) => gateState[a.workspacePath] ?? { confirms: [], asks: [] },
  'agents:detect': () => agents,
  'workspaces:get': (p) => ({ path: p, projects: (projects[p] ?? []).map((name) => ({ name })) }),
  'changes:multi': (cwds) => {
    const byProject = cwds.map((cwd) => ({ cwd, changes: changes[cwd] ?? [] }))
    const all = byProject.flatMap((b) => b.changes)
    return { total: all.length, add: all.reduce((n, c) => n + c.add, 0), del: all.reduce((n, c) => n + c.del, 0), byProject }
  },
  'git:diff': (a) => diffs[a.file] ?? [],
  'chat:send': () => undefined,
  'chat:stop': () => undefined,
  'chat:resolve': (a) => { resolveGate(a.id); return undefined },
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
wss.on('connection', (ws) => {
  clients.add(ws)
  send(ws, { t: 'hello', protocol: 1, version: '1.2.0', authRequired: false })
  send(ws, { t: 'ready', methods: Object.keys(table) })
  ws.on('message', (raw) => {
    const f = JSON.parse(String(raw))
    if (f.t !== 'req') return
    try {
      const fn = table[f.ch]
      if (!fn) return send(ws, { t: 'res', id: f.id, ok: false, error: `这台主机不提供 ${f.ch}` })
      send(ws, { t: 'res', id: f.id, ok: true, value: fn(...f.args) ?? null })
    } catch (e) { send(ws, { t: 'res', id: f.id, ok: false, error: String(e && e.message || e) }) }
  })
  ws.on('close', () => clients.delete(ws))
})

// 脚本:按名字预置门。连上之前就放好,这样快照那条路也被覆盖到。
if (SCRIPT === 'gate-confirm' || SCRIPT === 'both') {
  gateState[WS_A].confirms.push({ id: 'g-confirm-1', sessionId: 's-a1', title: 'Bash 请求执行', where: 'npm run build && npm run test -- ipc', ts: new Date().toISOString() })
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
