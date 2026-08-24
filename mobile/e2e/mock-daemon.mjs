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

// 分隔线要能被**确定地**断言,所以两条回复的 startedAt 锚在「今天 23:50 / 23:55」。
// 用户那条只有 `23:04` 这种没有日期的时刻(真数据就是这样),手机端靠同一轮回复的日期把它补全。
const todayAt = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime() }

const history = {
  's-a1': [
    { id: 'm1', who: 'user', text: 'handlers.ts 里权限档切到完全访问会把挂起的门全放行,但日志只打了一条。帮我改成逐条打,并补个单测。', ts: '23:04' },
    { id: 'm2', who: 'ai', model: 'Claude Code · Opus', text: '先看现在的放行逻辑。emitNote 只在循环外调了一次,所以 3 个门只会留下 1 行记录 —— 事后查不出哪条命令被自动放行了。', think: { label: '思考 8 秒', steps: ['读取 src/main/ipc/handlers.ts', '编辑 src/main/ipc/handlers.ts'] }, ts: '23:05', startedAt: todayAt(23, 50), tools: TOOLS_A1 },
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
