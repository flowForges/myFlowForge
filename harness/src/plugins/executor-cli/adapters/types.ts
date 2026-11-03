// 适配器接口与共用的小函数(04 spec §4):纯函数,不碰进程
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { EnvSnapshot } from '../../../lib/fs/paths'
import { redact } from '../../../lib/tools/redact'
import type { ExecutorIsolation, ExecutorRunReason, ExecutorRunStatus } from '../../../protocol/tools'

export type RunEvent =
  | { kind: 'native'; id: string }
  | { kind: 'progress'; progress: 'tool' | 'file' | 'text' | 'think'; text: string }
  | { kind: 'files'; files: string[] }
  | { kind: 'final'; text: string }
  | { kind: 'usage'; usage: { input: number; output: number; cached?: number } }
  /** fatal:这一轮确实失败了(Codex 的 turn.failed),后面就算有 turn.completed 也不算成功 */
  | { kind: 'error'; message: string; auth?: boolean; fatal?: boolean }
  /** Qoder 每条 assistant 消息一个;只有最后一条算数 */
  | { kind: 'assistant'; failed: boolean }
  /** Codex 的 turn.completed;Qoder 明确成功的 result */
  | { kind: 'completed' }

export interface BuildInput {
  prompt: string
  cwd: string
  model?: string
  readOnly: boolean
  isolation: ExecutorIsolation
  denyRead: string[]
  readOnlyPaths: string[]
  network: boolean
}

export interface RunState {
  code: number | null
  signal: string | null
  completed: boolean
  sawResult: boolean
  errors: { message: string; auth?: boolean; fatal?: boolean }[]
  /** 最后一条 assistant 消息带了 error */
  assistantError?: boolean
  timedOut: boolean
  stalled: boolean
  cancelled: boolean
}

export interface Outcome {
  status: ExecutorRunStatus
  reason?: ExecutorRunReason
}

export interface Adapter {
  id: 'codex' | 'qoder'
  bin: string
  toolName: string
  label: string
  isolationKind: 'translate' | 'wrap'
  passEnv: string[]
  allowRead(home: string, env: EnvSnapshot): string[]
  allowWrite(home: string, env: EnvSnapshot): string[]
  hosts: string[]
  /**
   * unenforceable:这组路径下隔离落实不了的原因(与 profileGaps 相同)。
   * 这时 isolation 必须已经是 none,否则抛:不能声称隔离却悄悄失效
   */
  buildArgs(i: BuildInput): { args: string[]; stdin?: string; unenforceable?: string[] }
  /** 同步、纯函数,权限门判定隔离时用;非空 → 这次运行 isolation:'none',内容进 missing */
  profileGaps?(i: Pick<BuildInput, 'cwd' | 'denyRead' | 'readOnlyPaths'>): string[]
  /** 读不懂的行 → [] */
  parseLine(line: string): RunEvent[]
  classify(s: RunState): Outcome
  loginArgs: string[]
  parseLogin(out: string): 'ok' | 'missing' | 'unknown'
  /**
   * args 停在 `--`,调用方接上 `/bin/sh -c <脚本>`(脚本在 detect.ts)。
   * denyRead 是这台机器真实的黑名单,跑的就是真实运行那一份;flags 接在共用的 -c 之后。
   * parse 返回没过的行,没出现的行也算没过
   */
  selfTest?(i: { dir: string; secret: string; flags: string[]; denyRead?: string[] }): { args: string[]; parse(out: string): string[] }
}

/** 写模式运行的提示词结尾 */
export const WRITE_RUN_SUFFIX = 'Leave your changes in the working tree. Do not commit or push.'

/** 工具参数(Task 10)与 buildArgs 共用:开头不能是 `-`,否则进 argv 就是一个旗标 */
export const ModelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/)

/** 打码在拼接之前:没有 END 的 PEM 会一直盖到结尾,不能把结尾那句也盖掉 */
export function promptStdin(i: Pick<BuildInput, 'prompt' | 'readOnly'>): string {
  const prompt = redact(i.prompt)
  return i.readOnly ? prompt : `${prompt}\n\n${WRITE_RUN_SUFFIX}`
}

export function modelArgs(model: string | undefined): string[] {
  return model === undefined ? [] : ['-m', ModelSchema.parse(model)]
}

export function requireAbsolute(p: string, what: string): string {
  if (!isAbsolute(p)) throw new Error(`${what} must be an absolute path`)
  return p
}

export function parseObject(line: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(line)
    return record(v)
  } catch {
    return undefined
  }
}

export function record(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/** 非空字符串,否则 undefined */
export function text(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

export function usageEvents(v: unknown, cachedKey: string): RunEvent[] {
  const u = record(v)
  if (!u) return []
  const num = (k: string) => (Number.isSafeInteger(u[k]) && (u[k] as number) >= 0 ? (u[k] as number) : undefined)
  const input = num('input_tokens')
  const output = num('output_tokens')
  if (input === undefined && output === undefined) return []
  const cached = num(cachedKey)
  return [{ kind: 'usage', usage: { input: input ?? 0, output: output ?? 0, ...(cached === undefined ? {} : { cached }) } }]
}

/** 把一个事件折进 classify 的输入。运行管理器必须走这里,旗标才不会漏 */
export function foldEvent(s: RunState, e: RunEvent): RunState {
  if (e.kind === 'completed') return { ...s, completed: true, sawResult: true }
  if (e.kind === 'assistant') return { ...s, assistantError: e.failed }
  if (e.kind !== 'error') return s
  const { kind: _kind, ...error } = e
  return { ...s, errors: [...s.errors, error] }
}

const AUTH_ERROR = /\b401\b|unauthorized|not logged in/i
const QUOTA_ERROR = /usage limit|quota|rate limit|\b429\b|too many requests/i

/**
 * 取消、超时、卡死,然后是干净的完成:重试过的 429、401 不影响它。
 * 认证和额度只解释没有完成的运行
 */
export function classifyOutcome(s: RunState, succeeded: boolean): Outcome {
  if (s.cancelled) return { status: 'cancelled', reason: 'cancelled' }
  if (s.timedOut) return { status: 'timeout', reason: 'timeout' }
  if (s.stalled) return { status: 'stalled', reason: 'stalled' }
  if (s.code === 0 && succeeded) return { status: 'ok' }
  if (s.errors.some(e => e.auth || AUTH_ERROR.test(e.message))) return { status: 'failed', reason: 'auth_missing' }
  if (s.errors.some(e => QUOTA_ERROR.test(e.message))) return { status: 'failed', reason: 'quota' }
  if (s.errors.length > 0) return { status: 'failed', reason: 'cli_error' }
  return { status: 'failed', reason: s.code === 0 ? 'no_result' : 'exit_nonzero' }
}
