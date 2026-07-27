import { homedir } from 'os'
import { join } from 'path'
import { readdir, rm, stat } from 'fs/promises'

// 背景记忆蒸馏(见 chat/memory/distiller)会用【用户正在对话的那个 provider CLI】跑一次性摘要。这些 CLI 把每一
// 轮都持久化成一条原生会话/rollout,于是每次蒸馏都会在 provider 自己的会话列表里留下一条「你是 workspace 记忆蒸
// 馏器…」的线程 —— 用户在 Codex / Claude / qoder 的原生历史里就会看到它们。蒸馏一次性调用结束后,我们把它【刚
// 创建的那一条】删掉:靠 provider 通过 onSession 上报的原生 id 精确定位,所以只删我们自己的丢弃线程,绝不碰真实
// 对话。尽最大努力:未知 provider / 文件不存在 / 任何 fs 错误 → 静默 no-op(蒸馏绝不能影响对话本身)。

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}

// rm only if the target exists; force swallows a race-lost ENOENT. Returns whether something was removed.
async function rmIfExists(p: string): Promise<boolean> {
  if (!(await exists(p))) return false
  try { await rm(p, { recursive: true, force: true }); return true } catch { return false }
}

// claude / qoder: <root>/<encoded-cwd>/<sessionId>.jsonl (claude) or <root>/<encoded-cwd>/<sessionId>
// (qoder). The id is a globally-unique uuid, so we skip reconstructing the cwd encoding and just probe
// every project dir for the id, stopping at the first hit.
async function rmProjectScoped(root: string, id: string): Promise<void> {
  let dirs: string[]
  try { dirs = (await readdir(root, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name) }
  catch { return }
  for (const d of dirs) {
    const base = join(root, d)
    if (await rmIfExists(join(base, `${id}.jsonl`))) return
    if (await rmIfExists(join(base, id))) return
  }
}

// codex: <home>/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl (global store, not cwd-scoped). The
// distill rollout was just written, so descend newest-first (dir names sort chronologically) and return
// at the first filename that carries the id.
async function findNewestFirst(dir: string, id: string): Promise<string | null> {
  let ents
  try { ents = await readdir(dir, { withFileTypes: true }) } catch { return null }
  for (const e of ents) if (e.isFile() && e.name.includes(id)) return join(dir, e.name)
  const subdirs = ents.filter(e => e.isDirectory()).map(e => e.name).sort((a, b) => (a < b ? 1 : -1))
  for (const s of subdirs) {
    const hit = await findNewestFirst(join(dir, s), id)
    if (hit) return hit
  }
  return null
}
async function rmCodex(home: string, id: string): Promise<void> {
  const hit = await findNewestFirst(join(home, '.codex', 'sessions'), id)
  if (hit) await rmIfExists(hit)
}

// opencode: state is sharded across <home>/.local/share/opencode/storage/<kind>/... keyed by the session
// id (ses_…). Remove any file/dir named <id> or <id>.* one or two levels deep. Best-effort — the exact
// layout varies across opencode versions, so a miss is fine (it stays a no-op).
async function rmOpencode(home: string, id: string): Promise<void> {
  const storage = join(home, '.local', 'share', 'opencode', 'storage')
  let subs: string[]
  try { subs = (await readdir(storage, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name) }
  catch { return }
  for (const sub of subs) {
    const base = join(storage, sub)
    await rmIfExists(join(base, `${id}.json`))
    await rmIfExists(join(base, id))
    let inner: string[]
    try { inner = (await readdir(base, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name) }
    catch { continue }
    for (const d of inner) {
      await rmIfExists(join(base, d, `${id}.json`))
      await rmIfExists(join(base, d, id))
    }
  }
}

// Delete the native session a distill one-shot created on `providerId`. `id` is the value the provider
// emitted via onSession. `home` is injectable for tests; defaults to the real home dir.
export async function removeNativeSession(providerId: string, id: string, home: string = homedir()): Promise<void> {
  if (!id) return
  try {
    switch (providerId) {
      case 'codex': await rmCodex(home, id); break
      case 'claude': await rmProjectScoped(join(home, '.claude', 'projects'), id); break
      case 'qoder': await rmProjectScoped(join(home, '.qoder', 'projects'), id); break
      case 'opencode': await rmOpencode(home, id); break
      // cursor: onSession 是未验证的 best-effort no-op(未登录时形状未知),没有可靠的原生会话可删。
      default: break
    }
  } catch { /* best-effort: never surface to the chat turn */ }
}
