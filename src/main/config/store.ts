import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { sysFile, wsConfigFile, wsForgeDir, expandTilde } from './paths'
import { deriveProjectName, deriveProjectId } from './projectId'
import { writeJsonAtomic } from '../util/atomicWrite'
import {
  SettingsSchema, defaultSettings, ProjectsSchema, defaultProjects,
  WorkflowsSchema, defaultWorkflows, AgentsConfigSchema, defaultAgentsConfig,
  HookLibrarySchema, defaultHookLibrary,
  CustomStagesFileSchema, defaultCustomStages,
  WorkspaceSchema, WorkspaceRegistrySchema, defaultWorkspaceRegistry, ensureWorkspaceWorkflows,
  type Settings, type Workspace, type WorkspaceRegistryEntry, type CustomStage
} from './schema'
import { randomUUID } from 'node:crypto'

export function readJson<T>(file: string, schema: z.ZodType<T>, fallback: () => T): T {
  try {
    if (!existsSync(file)) return fallback()
    // 剥掉 UTF-8 BOM 再解析。Node 的 readFileSync('utf8') 不剥,JSON.parse 遇到 BOM 直接抛,
    // 然后被下面的 catch 吞成「回落默认值」——【用户全部设置被静默重置】,而不是一次读失败。
    // Windows 上太容易触发:PowerShell 5.1 的 `Set-Content -Encoding UTF8` 就写 BOM,老记事本
    // 和不少编辑器也是。用户拿记事本改一下 settings.json,主题/壁纸/凭据就全没了;要是
    // workspaces.json 中招,整个工作区列表都会消失。
    return schema.parse(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')))
  } catch { return fallback() }
}
export function writeJson(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  writeJsonAtomic(file, data)
}

export const readSettings = () => readJson(sysFile('settings.json'), SettingsSchema, defaultSettings)
export const writeSettings = (s: Settings) => writeJson(sysFile('settings.json'), SettingsSchema.parse(s))

// One-time per-(workspace, provider) full-access consent (see runTurn's pre-run gate). Providers that
// ignore the permission档 (no sandbox dimension) run unrestricted; we ask once per workspace, then remember.
export function isFullAccessAcked(workspacePath: string, providerId: string): boolean {
  return (readSettings().fullAccessAck[workspacePath] ?? []).includes(providerId)
}
export function ackFullAccess(workspacePath: string, providerId: string): void {
  const s = readSettings()
  const cur = s.fullAccessAck[workspacePath] ?? []
  if (cur.includes(providerId)) return
  writeSettings({ ...s, fullAccessAck: { ...s.fullAccessAck, [workspacePath]: [...cur, providerId] } })
}

export const readProjects = () => readJson(sysFile('projects.json'), ProjectsSchema, defaultProjects)
export const writeProjects = (data: { projects: import('./schema').Project[] }) => writeJson(sysFile('projects.json'), ProjectsSchema.parse(data))
// Add a project to the system-wide library, deduped by derived id (same repo name → same id).
// Returns the full list. Shared by the IPC configAddProject handler and the SP-B wizard add-project.
export function upsertProject(input: { repoUrl: string; branch: string; alias?: string }): import('./schema').Project[] {
  const list = readProjects().projects
  const name = deriveProjectName(input.repoUrl)
  const id = deriveProjectId(name)
  const repoUrl = input.repoUrl.trim()
  const defaultBranch = input.branch.trim() || 'main'
  const alias = input.alias?.trim()   // optional; carried through by 导入 so aliases survive the round-trip
  const existing = list.find(p => p.id === id)
  if (existing) {
    // Re-adding the same repo is a correction, not a no-op: update branch+url so a mistyped
    // default branch (e.g. master → main) can be fixed by just adding it again. id/name stay stable.
    // Only overwrite the alias when one was supplied, so a plain re-add doesn't wipe an existing nickname.
    writeProjects({ projects: list.map(p => p.id === id ? { ...p, repoUrl, defaultBranch, ...(alias ? { alias } : {}) } : p) })
  } else {
    writeProjects({ projects: [...list, { id, name, repoUrl, defaultBranch, alias: alias ?? '' }] })
  }
  return readProjects().projects
}
// Change only a project's default branch (inline edit in ProjectPane / auto-heal write-back).
// No-op for an unknown id or a blank branch so callers can call it unconditionally.
export function setProjectDefaultBranch(id: string, branch: string): import('./schema').Project[] {
  const b = branch.trim()
  const list = readProjects().projects
  if (b && list.some(p => p.id === id)) {
    writeProjects({ projects: list.map(p => p.id === id ? { ...p, defaultBranch: b } : p) })
  }
  return readProjects().projects
}
// Change only a project's alias (inline edit in ProjectPane). Unlike branch, a BLANK alias is a valid
// value (clearing the nickname), so this only guards the id — trimmed, empty allowed.
export function setProjectAlias(id: string, alias: string): import('./schema').Project[] {
  const a = alias.trim()
  const list = readProjects().projects
  if (list.some(p => p.id === id)) {
    writeProjects({ projects: list.map(p => p.id === id ? { ...p, alias: a } : p) })
  }
  return readProjects().projects
}
export const readWorkflows = () => readJson(sysFile('workflows.json'), WorkflowsSchema, defaultWorkflows)
export const writeWorkflows = (data: { workflows: import('./schema').Workflow[] }) => writeJson(sysFile('workflows.json'), WorkflowsSchema.parse(data))
// Global reusable hook library (slot-agnostic). Copied-from at workspace-create time; never referenced live.
export const readHookLibrary = () => readJson(sysFile('hookLibrary.json'), HookLibrarySchema, defaultHookLibrary)
export const writeHookLibrary = (data: { hooks: import('./schema').LibraryHook[] }) => writeJson(sysFile('hookLibrary.json'), HookLibrarySchema.parse(data))
// Global custom-stage library (设置 → 自定义阶段). Workflow templates reference entries by libId; a
// resolver (shared/customStages.ts) resolves the reference at materialization / display time so editing
// one definition updates every template that uses it. Same atomic safeParse+write pattern as projects.
export const readCustomStages = () => readJson(sysFile('customStages.json'), CustomStagesFileSchema, defaultCustomStages)
export const writeCustomStages = (data: { stages: CustomStage[] }) => writeJson(sysFile('customStages.json'), CustomStagesFileSchema.parse(data))
// Insert a new library definition or replace an existing one (matched by id). A def with no id gets a
// fresh crypto.randomUUID() — the id is the stable reference key templates point at via libId.
export function upsertCustomStage(input: Partial<CustomStage> & { name: string }): CustomStage[] {
  const list = readCustomStages().stages
  const id = (input.id && input.id.trim()) || randomUUID()
  const def: CustomStage = {
    id,
    key: input.key || id,
    name: input.name,
    defaultAgent: input.defaultAgent || 'claude',
    defaultModel: input.defaultModel ?? '',
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.gate !== undefined ? { gate: input.gate } : {}),
    ...(input.review !== undefined ? { review: input.review } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.projectAgent !== undefined ? { projectAgent: input.projectAgent } : {}),
    ...(input.producesDoc !== undefined ? { producesDoc: input.producesDoc } : {}),
  }
  const next = list.some(s => s.id === id) ? list.map(s => s.id === id ? def : s) : [...list, def]
  writeCustomStages({ stages: next })
  return readCustomStages().stages
}
export function deleteCustomStage(id: string): CustomStage[] {
  writeCustomStages({ stages: readCustomStages().stages.filter(s => s.id !== id) })
  return readCustomStages().stages
}
export const readAgentsConfig = () => readJson(sysFile('agents.json'), AgentsConfigSchema, defaultAgentsConfig)
export const writeAgentsConfig = (data: import('./schema').AgentsConfig) => writeJson(sysFile('agents.json'), AgentsConfigSchema.parse(data))

export function readWorkspaceRegistry(): WorkspaceRegistryEntry[] {
  return readJson(sysFile('workspaces.json'), WorkspaceRegistrySchema, defaultWorkspaceRegistry).workspaces
}
function writeRegistry(list: WorkspaceRegistryEntry[]) {
  writeJson(sysFile('workspaces.json'), WorkspaceRegistrySchema.parse({ workspaces: list }))
}
export function registerWorkspace(name: string, rawPath: string) {
  const path = expandTilde(rawPath)
  const list = readWorkspaceRegistry()
  const existing = list.find(w => w.path === path)
  const rest = list.filter(w => w.path !== path)
  const entry: WorkspaceRegistryEntry = existing
    ? { ...existing, name, createdAt: existing.createdAt || Date.now() }
    : { name, path, createdAt: Date.now(), archived: false, archivedAt: null, description: '' }
  writeRegistry([...rest, entry])
}
export function setWorkspaceLifecycle(path: string, patch: Partial<Pick<WorkspaceRegistryEntry, 'archived' | 'archivedAt' | 'description' | 'createdAt'>>) {
  writeRegistry(readWorkspaceRegistry().map(w => w.path === path ? { ...w, ...patch } : w))
}
export function unregisterWorkspace(path: string) {
  writeRegistry(readWorkspaceRegistry().filter(w => w.path !== path))
}

/**
 * 老工作区文件里没有 per-project 的 repoUrl(那是后加的字段)。趁全局注册表**还在**的时候,把地址
 * 回填进工作区自己的记录 —— 等注册表被删了再想补就晚了(那正是它要防的事故)。
 *
 * 纯内存回填 + 命中才写盘,所以:老工作区第一次被读到就自动获得这层保护;新工作区本来就带着地址,
 * 一次也不会写。拿不到地址(inPlace / 注册表里已无此项)就保持空,不做任何猜测。
 */
export function backfillRepoUrls(ws: Workspace): { ws: Workspace; changed: boolean } {
  const missing = ws.projects.some(p => !p.repoUrl && !p.inPlace)
  if (!missing) return { ws, changed: false }
  const known = new Map(readProjects().projects.map(p => [p.id, p]))
  let changed = false
  const projects = ws.projects.map(p => {
    if (p.repoUrl || p.inPlace) return p
    const url = known.get(p.repoId)?.repoUrl
    if (!url) return p
    changed = true
    return { ...p, repoUrl: url }
  })
  return changed ? { ws: { ...ws, projects }, changed } : { ws, changed: false }
}

export function readWorkspace(wsPath: string): Workspace | null {
  const file = wsConfigFile(wsPath)
  if (!existsSync(file)) return null
  try {
    const parsed = ensureWorkspaceWorkflows(WorkspaceSchema.parse(JSON.parse(readFileSync(file, 'utf8'))))
    const { ws, changed } = backfillRepoUrls(parsed)
    // 回写是尽力而为:只读挂载、只读工作区等场景不该因为写不进去就读不出来。
    if (changed) { try { writeWorkspace(ws) } catch { /* best-effort */ } }
    return ws
  } catch { return null }
}
export function writeWorkspace(ws: Workspace) {
  mkdirSync(wsForgeDir(ws.path), { recursive: true })
  writeJson(wsConfigFile(ws.path), WorkspaceSchema.parse(ws))
}

// 仅改某个阶段的 provider+model 并原子写回（概览编码代理切换的轻量回写，避免走重的 editWorkspace）。
// Multi-workflow: stages now live in ws.workflows[].stages (ws.stages is a legacy migration seed
// that's permanently [] for any workspace created/edited under the multi-workflow model — see
// readWorkspace/ensureWorkspaceWorkflows). The caller (chat composer's develop-agent picker) has no
// per-workflow context — it's one global selection — so the least-surprising behavior matching the
// old single-stages-array semantics is to update the matching stage in EVERY workflow that has one.
export function setStageModel(path: string, stageKey: string, provider: string, model: string): void {
  const ws = readWorkspace(path)
  if (!ws) return
  let touched = false
  for (const wf of ws.workflows) {
    const stage = wf.stages.find(s => s.key === stageKey)
    if (stage) { stage.provider = provider; stage.model = model; touched = true }
  }
  if (!touched) return
  writeWorkspace(ws)
}
