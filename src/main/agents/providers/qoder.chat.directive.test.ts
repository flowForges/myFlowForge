import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeQoderProvider } from './qoder'
import type { ChatCallbacks } from '../types'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'qoder-directive-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// Fake qodercli: dumps argv to ARGV_OUT so the test can inspect the prompt actually passed.
const ARGV_DUMP = `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)))
process.exit(0)
`

const NOOP_CB: ChatCallbacks = {
  onSession: () => {},
  onAssistantDelta: () => {},
  onThinkDelta: () => {},
  onDone: () => {},
  onError: () => {},
}

// qoder passes the prompt as the value of `-p` (claude-compatible CLI shape).
async function promptArg(env: Record<string, string> = {}): Promise<string> {
  const bin = join(dir, 'qoderdump.js'); writeFileSync(bin, ARGV_DUMP); chmodSync(bin, 0o755)
  const argvOut = join(dir, 'argv.json')
  const provider = makeQoderProvider({ bin, defaultModels: [] })
  const s = provider.chat!(
    { id: 'a1', prompt: 'PROMPT_BODY', model: 'default', cwd: dir },
    NOOP_CB,
    { ...process.env, ARGV_OUT: argvOut, ...env }
  )
  await s.done
  const args = JSON.parse(readFileSync(argvOut, 'utf8')) as string[]
  const i = args.indexOf('-p')
  expect(i).toBeGreaterThanOrEqual(0)
  return args[i + 1]
}

// qoder reads .qoder/skills, never the workspace's .claude/skills/forge-workflow skill, so —
// like codex — it must get the forge_propose_plan guidance inlined into the chat prompt when
// the chat bridge exposes that tool (env.FORGE_TOOLS). Fail-open: no FORGE_TOOLS → unchanged.
describe('qoder chat() forge workflow directive', () => {
  it('prepends the forge_propose_plan directive when FORGE_TOOLS exposes it', async () => {
    const prompt = await promptArg({ FORGE_TOOLS: 'forge_propose_plan' })
    expect(prompt).toContain('forge_propose_plan')
    expect(prompt).toContain('PROMPT_BODY')   // user text preserved at the end
  })

  it('does NOT inject the directive when FORGE_TOOLS is absent', async () => {
    expect(await promptArg({})).toBe('PROMPT_BODY')
  })

  it('does NOT inject the directive when FORGE_TOOLS lacks forge_propose_plan', async () => {
    expect(await promptArg({ FORGE_TOOLS: 'forge_read_context' })).toBe('PROMPT_BODY')
  })
})
