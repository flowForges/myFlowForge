import { describe, expect, it } from 'vitest'
import {
  AccountUpdatedPayloadSchema, ChatgptEndedPayloadSchema, ControlMethods, EVENT_TYPES, FrameDecoder, MAX_FRAME_BYTES, PROTOCOL_VERSION, QuotaSchema,
  TurnUsagePayloadSchema, WorkerMethods, encodeFrame,
  ApprovalRequestedPayloadSchema, ApprovalResolvedPayloadSchema, AssistantPartSchema, FileChangeSchema, ToolEndedPayloadSchema,
  ToolStartedPayloadSchema, TurnRolledBackPayloadSchema, TurnSnapshotPayloadSchema,
  PermissionsUpdatedPayloadSchema, SandboxNetDeniedPayloadSchema, SandboxStatusSchema,
  ExecutorNoticePayloadSchema, ExecutorRunEndedPayloadSchema, ExecutorRunProgressPayloadSchema, ExecutorRunQueuedPayloadSchema,
  ExecutorRunStartedPayloadSchema, SessionOriginSchema, TurnParkedPayloadSchema, TurnResumedPayloadSchema,
} from './index'

describe('framing', () => {
  it('round-trips', () => {
    const m = { jsonrpc: '2.0', id: 1, method: 'status' }
    expect(new FrameDecoder().push(encodeFrame(m))).toEqual([m])
  })
  it('U+2028/2029 in payload stays one message', () => {
    const m = { text: 'a\u2028b\u2029c' }
    const frame = encodeFrame(m)
    expect(frame.endsWith('\n')).toBe(true)
    expect(frame.indexOf('\n')).toBe(frame.length - 1)
    expect(new FrameDecoder().push(frame)).toEqual([m])
    // 原始 U+2028 出现在流里也不分帧
    expect(new FrameDecoder().push('{"t":"a\u2028b"}\n')).toEqual([{ t: 'a\u2028b' }])
  })
  it('handles chunk split mid-line', () => {
    const d = new FrameDecoder()
    const f = encodeFrame({ a: 1 })
    expect(d.push(f.slice(0, 4))).toEqual([])
    expect(d.push(f.slice(4))).toEqual([{ a: 1 }])
  })
  it('skips malformed line and reports it', () => {
    const errs: string[] = []
    const d = new FrameDecoder((line) => errs.push(line))
    expect(d.push('{bad\n' + encodeFrame({ ok: 1 }))).toEqual([{ ok: 1 }])
    expect(errs).toEqual(['{bad'])
  })
  it('multiple messages in one chunk', () => {
    expect(new FrameDecoder().push(encodeFrame({ a: 1 }) + encodeFrame({ b: 2 }))).toEqual([{ a: 1 }, { b: 2 }])
  })
})

describe('schemas', () => {
  it('version', () => expect(PROTOCOL_VERSION).toBe(3))
  it('plaintext auth is gone; challenge/verify exist on both ports', () => {
    for (const table of [WorkerMethods, ControlMethods]) {
      expect(Object.hasOwn(table, 'auth')).toBe(false)
      expect(Object.hasOwn(table, 'auth.challenge')).toBe(true)
      expect(Object.hasOwn(table, 'auth.verify')).toBe(true)
    }
  })
  const required: [typeof WorkerMethods | typeof ControlMethods, string, object][] = [
    [WorkerMethods, 'auth.challenge', {}],
    [WorkerMethods, 'auth.verify', {}],
    [WorkerMethods, 'hello', { clientVersion: '1' }],
    [WorkerMethods, 'events.subscribe', {}],
    [WorkerMethods, 'events.tail', {}],
    [WorkerMethods, 'session.create', {}],
    [WorkerMethods, 'session.prompt', { sessionId: 's', text: 't' }],
    [WorkerMethods, 'session.cancel', { sessionId: 's' }],
    [WorkerMethods, 'models.addAccount', { commandId: 'c' }],
    [WorkerMethods, 'models.removeAccount', {}],
    [WorkerMethods, 'models.testAccount', {}],
    [WorkerMethods, 'models.setDefault', { accountId: 'a' }],
    [WorkerMethods, 'models.quota', {}],
    [WorkerMethods, 'auth.chatgpt.cancel', {}],
    [WorkerMethods, 'permissions.set', { config: {} }],
    [ControlMethods, 'auth.challenge', {}],
    [ControlMethods, 'auth.verify', {}],
    [ControlMethods, 'autostart', { on: true }],
  ]
  it.each(required)('rejects missing required field: %#', (table, name, bad) => {
    const schema = (table as Record<string, { params: { safeParse(v: unknown): { success: boolean } } }>)[name].params
    expect(schema.safeParse(bad).success).toBe(false)
  })
  it('events.tail limit is an integer 1..1000; subscribe after is a non-negative integer', () => {
    const tail = WorkerMethods['events.tail'].params
    for (const limit of [1, 50, 1000]) expect(tail.safeParse({ limit }).success).toBe(true)
    for (const limit of [0, -1, 1001, 1.5, Number.NaN, Infinity]) expect(tail.safeParse({ limit }).success).toBe(false)
    const sub = WorkerMethods['events.subscribe'].params
    expect(sub.safeParse({ after: 0 }).success).toBe(true)
    for (const after of [-1, 0.5]) expect(sub.safeParse({ after }).success).toBe(false)
  })
  it('events.subscribe result accepts both shapes', () => {
    const r = WorkerMethods['events.subscribe'].result
    expect(r.safeParse({ ok: true }).success).toBe(true)
    expect(r.safeParse({ reset: true, lastSeq: 3 }).success).toBe(true)
    expect(r.safeParse({}).success).toBe(false)
  })
})

describe('v2 schemas', () => {
  const ok = (m: keyof typeof WorkerMethods, v: unknown) => WorkerMethods[m].params.safeParse(v).success
  it('models.addAccount: presetId required, restrictionAck boolean, protocol enum', () => {
    expect(ok('models.addAccount', { commandId: 'c', presetId: 'zhipu-cn', apiKey: 'k', restrictionAck: true })).toBe(true)
    expect(ok('models.addAccount', { commandId: 'c', presetId: 'custom', baseUrl: 'http://x', protocol: 'anthropic', label: 'L' })).toBe(true)
    expect(ok('models.addAccount', { commandId: 'c' })).toBe(false)
    expect(ok('models.addAccount', { presetId: 'p' })).toBe(false)
    expect(ok('models.addAccount', { commandId: 'c', presetId: 'p', restrictionAck: 'yes' })).toBe(false)
    expect(ok('models.addAccount', { commandId: 'c', presetId: 'p', protocol: 'chatgpt' })).toBe(false)
  })
  it('session.create accepts an optional model ref', () => {
    expect(ok('session.create', { commandId: 'c', model: { accountId: 'a', modelId: 'm' } })).toBe(true)
    expect(ok('session.create', { commandId: 'c', model: { accountId: 'a' } })).toBe(false)
  })
  it('other new methods', () => {
    expect(ok('models.catalog', {})).toBe(true)
    expect(ok('models.accounts', {})).toBe(true)
    expect(ok('models.removeAccount', { commandId: 'c', accountId: 'a' })).toBe(true)
    expect(ok('models.testAccount', { accountId: 'a' })).toBe(true)
    expect(ok('models.setDefault', { accountId: 'a', modelId: 'm' })).toBe(true)
    expect(ok('models.quota', { accountId: 'a' })).toBe(true)
    expect(ok('auth.chatgpt.begin', {})).toBe(true)
    expect(ok('auth.chatgpt.cancel', { flowId: 'f' })).toBe(true)
  })
  it('result schemas', () => {
    const account = { id: 'a', presetId: 'p', label: 'L', state: 'needs_login' }
    expect(WorkerMethods['models.addAccount'].result.safeParse(account).success).toBe(true)
    expect(WorkerMethods['models.addAccount'].result.safeParse({ ...account, state: 'weird' }).success).toBe(false)
    expect(WorkerMethods['models.accounts'].result.safeParse({ accounts: [account], secretsBackend: 'keychain' }).success).toBe(true)
    expect(WorkerMethods['models.accounts'].result.safeParse({ accounts: [], secretsBackend: 'nope' }).success).toBe(false)
    expect(WorkerMethods['models.testAccount'].result.safeParse({ ok: false, error: { kind: 'auth', message: 'm' } }).success).toBe(true)
    expect(WorkerMethods['models.testAccount'].result.safeParse({ ok: false, error: { kind: 'weird', message: 'm' } }).success).toBe(false)
    expect(WorkerMethods['models.quota'].result.safeParse(null).success).toBe(true)
    expect(WorkerMethods['auth.chatgpt.begin'].result.safeParse({ flowId: 'f', authUrl: 'https://x' }).success).toBe(true)
    const model = { id: 'm', name: 'M', context: 128000, output: 8000, image: false, reasoning: 'effort', toolCall: true, cost: { input: 1, output: 2 } }
    const preset = {
      id: 'p', label: 'P', billing: 'subscription', restriction: 'coding-tools-only', auth: 'api-key',
      protocols: ['anthropic'], docsUrl: 'https://d',
    }
    const catalog = WorkerMethods['models.catalog'].result
    expect(catalog.safeParse({ presets: [preset], models: { p: [model] }, default: { accountId: 'a', modelId: 'm' } }).success).toBe(true)
    expect(catalog.safeParse({ presets: [{ ...preset, restriction: 'x' }], models: {} }).success).toBe(false)
    const { toolCall: _t, ...noTool } = model
    expect(catalog.safeParse({ presets: [preset], models: { p: [noTool] } }).success).toBe(false)
    expect(catalog.safeParse({ presets: [preset], models: { p: [{ ...model, cost: { input: 1 } }] } }).success).toBe(false)
  })
  it('Quota is windows or link', () => {
    expect(QuotaSchema.safeParse({ windows: [{ label: '5h', usedPercent: 40, resetsAt: 1 }] }).success).toBe(true)
    expect(QuotaSchema.safeParse({ link: 'https://chatgpt.com/settings/usage' }).success).toBe(true)
    expect(QuotaSchema.safeParse({}).success).toBe(false)
  })
  it('new event types and payloads', () => {
    for (const t of ['account.updated', 'message.reasoning.delta', 'turn.usage', 'auth.chatgpt.ended']) expect(EVENT_TYPES).toContain(t)
    expect(ChatgptEndedPayloadSchema.safeParse({ flowId: 'f', ok: true, accountId: 'a' }).success).toBe(true)
    expect(ChatgptEndedPayloadSchema.safeParse({ flowId: 'f' }).success).toBe(false)
    expect(TurnUsagePayloadSchema.safeParse({ turnId: 't', input: 1, output: 2, cacheRead: 3 }).success).toBe(true)
    expect(TurnUsagePayloadSchema.safeParse({ turnId: 't', input: 1 }).success).toBe(false)
    expect(AccountUpdatedPayloadSchema.safeParse({ account: { id: 'a', presetId: 'p', label: 'L', state: 'ok' } }).success).toBe(true)
  })
})

describe('v3 schemas', () => {
  const ok = (m: keyof typeof WorkerMethods, v: unknown) => WorkerMethods[m].params.safeParse(v).success
  it('new event types', () => {
    for (const t of ['tool.started', 'tool.ended', 'approval.requested', 'approval.resolved', 'turn.snapshot', 'turn.rolledBack'])
      expect(EVENT_TYPES).toContain(t)
  })
  it('new event payloads', () => {
    expect(ToolStartedPayloadSchema.safeParse({ turnId: 't', callId: 'c', name: 'read', argsPreview: '{}' }).success).toBe(true)
    expect(ToolStartedPayloadSchema.safeParse({ turnId: 't', callId: 'c', name: 'read' }).success).toBe(false)
    expect(ToolEndedPayloadSchema.safeParse({ turnId: 't', callId: 'c', name: 'read', ok: true, ms: 3, content: 'x' }).success).toBe(true)
    expect(ToolEndedPayloadSchema.safeParse({ turnId: 't', callId: 'c', name: 'read', ok: false, ms: 3, content: 'x', isError: true, truncated: true }).success).toBe(true)
    expect(ToolEndedPayloadSchema.safeParse({ turnId: 't', callId: 'c', name: 'read', ok: true, content: 'x' }).success).toBe(false)
    expect(ApprovalRequestedPayloadSchema.safeParse({ approvalId: 'a', turnId: 't', callId: 'c', tool: 'shell', summary: 'ls' }).success).toBe(true)
    expect(ApprovalRequestedPayloadSchema.parse({ approvalId: 'a', turnId: 't', callId: 'c', tool: 'shell', summary: 'ls', unsandboxed: true }).unsandboxed).toBe(true)
    expect(ApprovalRequestedPayloadSchema.safeParse({ approvalId: 'a', turnId: 't', callId: 'c', tool: 'shell', summary: 'ls', unsandboxed: 'yes' }).success).toBe(false)
    expect(ApprovalResolvedPayloadSchema.safeParse({ approvalId: 'a', decision: 'deny', by: 'cancel' }).success).toBe(true)
    expect(ApprovalResolvedPayloadSchema.safeParse({ approvalId: 'a', decision: 'allow_session', by: 'user' }).success).toBe(false)
    expect(ApprovalResolvedPayloadSchema.safeParse({ approvalId: 'a', decision: 'allow', by: 'someone' }).success).toBe(false)
    expect(TurnSnapshotPayloadSchema.safeParse({ turnId: 't', phase: 'start', ref: 'refs/x' }).success).toBe(true)
    expect(TurnSnapshotPayloadSchema.safeParse({ turnId: 't', phase: 'end', changed: 2 }).success).toBe(true)
    expect(TurnSnapshotPayloadSchema.safeParse({ turnId: 't', phase: 'end', reason: 'not_git' }).success).toBe(true)
    expect(TurnSnapshotPayloadSchema.safeParse({ turnId: 't', phase: 'middle' }).success).toBe(false)
    expect(TurnRolledBackPayloadSchema.safeParse({ turnId: 't', files: 3 }).success).toBe(true)
    expect(FileChangeSchema.safeParse({ path: 'a', status: 'T' }).success).toBe(true)
    expect(FileChangeSchema.safeParse({ path: 'a', status: 'R' }).success).toBe(false)
  })
  it('AssistantPart is the Part union without image', () => {
    expect(AssistantPartSchema.safeParse({ type: 'text', text: 'x' }).success).toBe(true)
    expect(AssistantPartSchema.safeParse({ type: 'tool_call', id: 'i', name: 'n', args: '{}' }).success).toBe(true)
    expect(AssistantPartSchema.safeParse({ type: 'tool_result', callId: 'i', content: 'c', isError: true }).success).toBe(true)
    expect(AssistantPartSchema.safeParse({ type: 'reasoning', text: 'r', replay: { any: 1 } }).success).toBe(true)
    expect(AssistantPartSchema.safeParse({ type: 'image', mime: 'image/png', data: 'x' }).success).toBe(false)
  })
  it('session.create: cwd, approvalMode and toolset are optional and enumerated', () => {
    expect(ok('session.create', { commandId: 'c', cwd: '/x', approvalMode: 'auto', toolset: 'edit' })).toBe(true)
    expect(ok('session.create', { commandId: 'c', approvalMode: 'ask', toolset: 'patch' })).toBe(true)
    expect(ok('session.create', { commandId: 'c', approvalMode: 'yolo' })).toBe(false)
    expect(ok('session.create', { commandId: 'c', toolset: 'bash' })).toBe(false)
    expect(ok('session.create', { commandId: 'c', cwd: 3 })).toBe(false)
  })
  it('approval.respond, turn.rollback, turn.changes', () => {
    for (const decision of ['allow', 'allow_session', 'deny']) expect(ok('approval.respond', { approvalId: 'a', decision })).toBe(true)
    expect(ok('approval.respond', { approvalId: 'a', decision: 'maybe' })).toBe(false)
    expect(ok('approval.respond', { decision: 'allow' })).toBe(false)
    expect(ok('turn.rollback', { commandId: 'c', sessionId: 's', turnId: 't' })).toBe(true)
    expect(ok('turn.rollback', { sessionId: 's', turnId: 't' })).toBe(false)
    expect(ok('turn.changes', { sessionId: 's', turnId: 't' })).toBe(true)
    expect(ok('turn.changes', { sessionId: 's' })).toBe(false)
    expect(WorkerMethods['approval.respond'].result.safeParse({ ok: false }).success).toBe(true)
    expect(WorkerMethods['turn.rollback'].result.safeParse({ ok: true, files: 2 }).success).toBe(true)
    expect(WorkerMethods['turn.rollback'].result.safeParse({ ok: false, files: 2 }).success).toBe(false)
    expect(WorkerMethods['turn.changes'].result.safeParse({ files: [{ path: 'a', status: 'A' }] }).success).toBe(true)
  })
})

describe('05 schemas', () => {
  const ok = (m: keyof typeof WorkerMethods, v: unknown) => WorkerMethods[m].params.safeParse(v).success
  it('permissions.get takes an optional sessionId; permissions.set needs a commandId', () => {
    expect(ok('permissions.get', {})).toBe(true)
    expect(ok('permissions.get', { sessionId: 's' })).toBe(true)
    expect(ok('permissions.get', { sessionId: 3 })).toBe(false)
    expect(ok('permissions.set', { commandId: 'c', config: { rules: 'anything' } })).toBe(true)
  })
  it('permissions.get result carries config, defaults, errors and sandbox', () => {
    const r = WorkerMethods['permissions.get'].result
    const config = { rules: [{ effect: 'deny', rule: 'shell(x)' }], network: { allow: [] }, sandbox: { enabled: true, allowLoopback: false }, allowUnsandboxedAuto: false }
    const sandbox = { level: 'none', missing: ['platform'], autoDegraded: false }
    expect(r.safeParse({ config, defaults: ['ask shell(*)'], errors: [{ index: 0, rule: 'x', reason: 'network' }], sandbox }).success).toBe(true)
    expect(r.safeParse({ config, defaults: [], errors: [{ index: 0, rule: 'x', reason: 'weird' }], sandbox }).success).toBe(false)
    expect(r.safeParse({ config: { ...config, rules: [{ effect: 'maybe', rule: 'x' }] }, defaults: [], errors: [], sandbox }).success).toBe(false)
  })
  it('SandboxStatus levels and missing codes are closed', () => {
    for (const m of ['platform', 'sandbox-exec', 'bwrap', 'userns', 'netns', 'proxy', 'loopback', 'disabled'])
      expect(SandboxStatusSchema.safeParse({ level: 'partial', missing: [m], autoDegraded: false }).success).toBe(true)
    expect(SandboxStatusSchema.safeParse({ level: 'half', missing: [], autoDegraded: false }).success).toBe(false)
    expect(SandboxStatusSchema.safeParse({ level: 'none', missing: ['other'], autoDegraded: false }).success).toBe(false)
  })
  it('new event types and payloads', () => {
    for (const t of ['permissions.updated', 'sandbox.netDenied']) expect(EVENT_TYPES).toContain(t)
    expect(PermissionsUpdatedPayloadSchema.safeParse({ rules: 2, network: 9 }).success).toBe(true)
    expect(PermissionsUpdatedPayloadSchema.safeParse({ rules: 'read(x)', network: 9 }).success).toBe(false)
    expect(SandboxNetDeniedPayloadSchema.safeParse({ host: 'evil.example', port: 443, reason: 'not_allowed' }).success).toBe(true)
    expect(SandboxNetDeniedPayloadSchema.safeParse({ host: 'evil.example' }).success).toBe(false)
  })
})

describe('04 schemas', () => {
  const ok = (m: keyof typeof WorkerMethods, v: unknown) => WorkerMethods[m].params.safeParse(v).success
  const result = (m: keyof typeof WorkerMethods, v: unknown) => WorkerMethods[m].result.safeParse(v).success
  const ended = { runId: 'run_a', turnId: 't', executor: 'codex', status: 'ok', ms: 5, changed: { files: [], source: 'none' } }

  it('new event types are in EVENT_TYPES', () => {
    for (const t of ['executor.run.queued', 'executor.run.started', 'executor.run.progress', 'executor.run.ended', 'executor.notice', 'turn.parked', 'turn.resumed'])
      expect(EVENT_TYPES).toContain(t)
  })
  it('executor.run.queued', () => {
    const q = { runId: 'run_a', turnId: 't', callId: 'c', executor: 'codex', summary: 'codex: x', readOnly: false, isolation: 'own', position: 0 }
    expect(ExecutorRunQueuedPayloadSchema.safeParse(q).success).toBe(true)
    expect(ExecutorRunQueuedPayloadSchema.safeParse({ ...q, isolation: 'half' }).success).toBe(false)
    const { position: _p, ...noPosition } = q
    expect(ExecutorRunQueuedPayloadSchema.safeParse(noPosition).success).toBe(false)
  })
  it('executor.run.started', () => {
    const s = { runId: 'run_a', turnId: 't', executor: 'qoder', cwd: '/w', isolation: 'wrapped' }
    expect(ExecutorRunStartedPayloadSchema.safeParse(s).success).toBe(true)
    expect(ExecutorRunStartedPayloadSchema.safeParse({ ...s, worktree: '/wt', untranslatedRules: 2 }).success).toBe(true)
    const { cwd: _c, ...noCwd } = s
    expect(ExecutorRunStartedPayloadSchema.safeParse(noCwd).success).toBe(false)
  })
  it('executor.run.progress kind is closed', () => {
    for (const kind of ['tool', 'file', 'text', 'think'])
      expect(ExecutorRunProgressPayloadSchema.safeParse({ runId: 'run_a', turnId: 't', kind, text: 'x' }).success).toBe(true)
    expect(ExecutorRunProgressPayloadSchema.safeParse({ runId: 'run_a', turnId: 't', kind: 'delta', text: 'x' }).success).toBe(false)
  })
  it('executor.run.ended needs status, and status and reason are closed', () => {
    for (const status of ['ok', 'failed', 'cancelled', 'timeout', 'stalled', 'interrupted'])
      expect(ExecutorRunEndedPayloadSchema.safeParse({ ...ended, status }).success).toBe(true)
    const { status: _s, ...noStatus } = ended
    expect(ExecutorRunEndedPayloadSchema.safeParse(noStatus).success).toBe(false)
    expect(ExecutorRunEndedPayloadSchema.safeParse({ ...ended, status: 'done' }).success).toBe(false)
    for (const reason of [
      'not_installed', 'auth_missing', 'quota', 'spawn_failed', 'exit_nonzero', 'cli_error', 'no_result', 'timeout', 'stalled', 'cancelled',
      'kernel_stopping', 'daemon_restart', 'sandbox_unavailable', 'worktree_unavailable', 'worktree_limit', 'queue_full', 'too_many_runs', 'denied', 'untrusted_binary',
    ]) expect(ExecutorRunEndedPayloadSchema.safeParse({ ...ended, status: 'failed', reason }).success).toBe(true)
    expect(ExecutorRunEndedPayloadSchema.safeParse({ ...ended, status: 'failed', reason: 'because' }).success).toBe(false)
  })
  it('executor.run.ended carries every optional field; changed is required', () => {
    const full = {
      ...ended, reason: 'exit_nonzero', exit: 1, signal: 'SIGINT', usage: { input: 22, output: 10, cached: 6 },
      changed: { files: ['a.txt'], source: 'git', concurrent: true }, violations: ['a.env'], worktree: '/wt', rawLog: '/s/run_a.jsonl', nativeId: 'th', droppedProgress: 3,
    }
    expect(ExecutorRunEndedPayloadSchema.parse(full)).toEqual(full)
    const { changed: _c, ...noChanged } = ended
    expect(ExecutorRunEndedPayloadSchema.safeParse(noChanged).success).toBe(false)
    expect(ExecutorRunEndedPayloadSchema.safeParse({ ...ended, changed: { files: [], source: 'guess' } }).success).toBe(false)
    expect(ExecutorRunEndedPayloadSchema.safeParse({ ...ended, usage: { input: 1 } }).success).toBe(false)
  })
  it('executor.notice: step is optional, because recovery writes it outside any step', () => {
    expect(ExecutorNoticePayloadSchema.safeParse({ turnId: 't', step: 3, runId: 'run_a', text: 'n' }).success).toBe(true)
    expect(ExecutorNoticePayloadSchema.safeParse({ turnId: 't', runId: 'run_a', text: 'n' }).success).toBe(true)
    expect(ExecutorNoticePayloadSchema.safeParse({ turnId: 't', step: 3, runId: 'run_a' }).success).toBe(false)
  })
  it('turn.parked and turn.resumed; turn.resumed needs cause', () => {
    expect(TurnParkedPayloadSchema.safeParse({ turnId: 't', step: 1, active: 2, pending: 0 }).success).toBe(true)
    expect(TurnParkedPayloadSchema.safeParse({ turnId: 't', step: 1, active: 2 }).success).toBe(false)
    for (const cause of ['notice', 'message', 'abort']) expect(TurnResumedPayloadSchema.safeParse({ turnId: 't', step: 1, cause }).success).toBe(true)
    expect(TurnResumedPayloadSchema.safeParse({ turnId: 't', step: 1 }).success).toBe(false)
    expect(TurnResumedPayloadSchema.safeParse({ turnId: 't', step: 1, cause: 'timer' }).success).toBe(false)
  })
  it('session.create origin is optional and enumerated', () => {
    for (const origin of ['app', 'im', 'schedule']) expect(ok('session.create', { commandId: 'c', origin })).toBe(true)
    expect(ok('session.create', { commandId: 'c' })).toBe(true)
    expect(ok('session.create', { commandId: 'c', origin: 'cron' })).toBe(false)
    expect(SessionOriginSchema.options).toEqual(['app', 'im', 'schedule'])
  })
  it('session.prompt result: followUp is optional', () => {
    expect(result('session.prompt', { accepted: true, turnId: 't' })).toBe(true)
    expect(result('session.prompt', { accepted: true, turnId: 't', followUp: true })).toBe(true)
    expect(result('session.prompt', { accepted: true, turnId: 't', followUp: 'yes' })).toBe(false)
  })
  it('executor.list and executor.refresh', () => {
    expect(ok('executor.list', {})).toBe(true)
    expect(ok('executor.refresh', {})).toBe(true)
    expect(ok('executor.refresh', { commandId: 'c' })).toBe(true)
    const row = { id: 'codex', installed: true, version: '0.154.0', auth: 'ok', isolation: 'own', missing: [] }
    for (const m of ['executor.list', 'executor.refresh'] as const) {
      expect(result(m, { executors: [row] })).toBe(true)
      expect(result(m, { executors: [{ id: 'qoder', installed: false, auth: 'unknown', isolation: 'none', missing: ['unsupported'] }] })).toBe(true)
      expect(result(m, { executors: [{ ...row, auth: 'maybe' }] })).toBe(false)
      expect(result(m, { executors: [{ ...row, isolation: 'half' }] })).toBe(false)
    }
  })
  it('executor.cancel and executor.worktree.discard need commandId, sessionId and runId', () => {
    for (const m of ['executor.cancel', 'executor.worktree.discard'] as const) {
      expect(ok(m, { commandId: 'c', sessionId: 's', runId: 'r' })).toBe(true)
      expect(ok(m, { sessionId: 's', runId: 'r' })).toBe(false)
      expect(ok(m, { commandId: 'c', runId: 'r' })).toBe(false)
      expect(ok(m, { commandId: 'c', sessionId: 's' })).toBe(false)
      expect(result(m, { ok: false })).toBe(true)
    }
  })
  it('executor.changes needs sessionId and runId', () => {
    expect(ok('executor.changes', { sessionId: 's', runId: 'r' })).toBe(true)
    expect(ok('executor.changes', { runId: 'r' })).toBe(false)
    expect(ok('executor.changes', { sessionId: 's' })).toBe(false)
    expect(result('executor.changes', { files: [{ path: 'a', status: 'M' }], source: 'git', concurrent: true })).toBe(true)
    expect(result('executor.changes', { files: [], source: 'none' })).toBe(true)
    expect(result('executor.changes', { files: [] })).toBe(false)
  })
})

describe('FrameDecoder hardening', () => {
  it('rejects top-level arrays via onError', () => {
    const errs: string[] = []
    const d = new FrameDecoder((l) => errs.push(l))
    expect(d.push('[1,2]\n' + encodeFrame({ a: 1 }))).toEqual([{ a: 1 }])
    expect(errs).toEqual(['[1,2]'])
  })
  it('drops buffer and reports when a line exceeds MAX_FRAME_BYTES', () => {
    const errs: unknown[] = []
    const d = new FrameDecoder((_l, e) => errs.push(e))
    d.push('x'.repeat(MAX_FRAME_BYTES + 1))
    expect(errs).toHaveLength(1)
    expect(d.push(encodeFrame({ ok: 1 }))).toEqual([{ ok: 1 }])
  })
})
