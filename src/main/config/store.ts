import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { sysFile, wsConfigFile, wsForgeDir, expandTilde } from './paths'
import { deriveProjectName, deriveProjectId } from './projectId'
import { writeJsonAtomic } from '../util/atomicWrite'
import {
  SettingsSchema, defaultSettings, ProjectsSchema, defaultProjects,
  WorkflowsSchema, defaultWorkflows, AgentsConfigSchema, defaultAgentsConfig,
  WorkspaceSchema, WorkspaceRegistrySchema, defaultWorkspaceRegistry,
  type Settings, type Workspace, type WorkspaceRegistryEntry
} from './schema'

export function readJson<T>(file: string, schema: z.ZodType<T>, fallback: () => T): T {
  try {
    if (!existsSync(file)) return fallback()
    return schema.parse(JSON.parse(readFileSync(file, 'utf8')))
  } catch { return fallback() }
}
export function writeJson(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  writeJsonAtomic(file, data)
}

export const readSettings = () => readJson(sysFile('settings.json'), SettingsSchema, defaultSettings)
export const writeSettings = (s: Settings) => writeJson(sysFile('settings.json'), SettingsSchema.parse(s))

export const readProjects = () => readJson(sysFile('projects.json'), ProjectsSchema, defaultProjects)
export const writeProjects = (data: { projects: import('./schema').Project[] }) => writeJson(sysFile('projects.json'), ProjectsSchema.parse(data))
// Add a project to the system-wide library, deduped by derived id (same repo name → same id).
// Returns the full list. Shared by the IPC configAddProject handler and the SP-B wizard add-project.
export function upsertProject(input: { repoUrl: string; branch: string }): import('./schema').Project[] {
  const list = readProjects().projects
  const name = deriveProjectName(input.repoUrl)
  const id = deriveProjectId(name)
  const repoUrl = input.repoUrl.trim()
  const defaultBranch = input.branch.trim() || 'main'
  const existing = list.find(p => p.id === id)
  if (existing) {
    // Re-adding the same repo is a correction, not a no-op: update branch+url so a mistyped
    // default branch (e.g. master → main) can be fixed by just adding it again. id/name stay stable.
    writeProjects({ projects: list.map(p => p.id === id ? { ...p, repoUrl, defaultBranch } : p) })
  } else {
    writeProjects({ projects: [...list, { id, name, repoUrl, defaultBranch }] })
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
export const readWorkflows = () => readJson(sysFile('workflows.json'), WorkflowsSchema, defaultWorkflows)
export const writeWorkflows = (data: { workflows: import('./schema').Workflow[] }) => writeJson(sysFile('workflows.json'), WorkflowsSchema.parse(data))
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

export function readWorkspace(wsPath: string): Workspace | null {
  const file = wsConfigFile(wsPath)
  if (!existsSync(file)) return null
  try { return WorkspaceSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) } catch { return null }
}
export function writeWorkspace(ws: Workspace) {
  mkdirSync(wsForgeDir(ws.path), { recursive: true })
  writeJson(wsConfigFile(ws.path), WorkspaceSchema.parse(ws))
}

// 仅改某个阶段的 provider+model 并原子写回（概览编码代理切换的轻量回写，避免走重的 editWorkspace）。
export function setStageModel(path: string, stageKey: string, provider: string, model: string): void {
  const ws = readWorkspace(path)
  if (!ws) return
  const stage = ws.stages.find(s => s.key === stageKey)
  if (!stage) return
  stage.provider = provider
  stage.model = model
  writeWorkspace(ws)
}
