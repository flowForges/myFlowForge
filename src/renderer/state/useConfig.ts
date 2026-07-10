import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ProviderInfo, ReviewConfig, StageCustomFields, Settings } from '@shared/types'
import type { Plugin } from '@shared/plugin'

export interface CfgProject { id: string; name: string; repoUrl: string; defaultBranch: string }
// A workflow-template stage: identity + default agent/model + optional custom fields (#3). `libId`, when
// present, references a global custom-stage-library definition (设置 → 自定义阶段) — resolved for display.
export interface CfgStage extends StageCustomFields { key: string; defaultAgent: string; defaultModel: string; prompt?: string; review?: ReviewConfig; libId?: string }
export interface CfgWorkflow { id: string; name: string; stages: CfgStage[]; plugins: Plugin[]; stagePrompts?: Record<string, string> }
// A global custom-stage-library entry: a full stage config with a stable id + required name.
export interface CfgCustomStage extends CfgStage { id: string; name: string }

export function useConfig() {
  const [projects, setProjects] = useState<CfgProject[]>([])
  const [workflows, setWorkflows] = useState<CfgWorkflow[]>([])
  const [customStages, setCustomStages] = useState<CfgCustomStage[]>([])
  // Raw detection result (every installed provider). The public `providers` below strips out the
  // ones the user disabled in 设置, so all "选择编码代理" lists hide them — the CLIs stay installed.
  const [rawProviders, setRawProviders] = useState<ProviderInfo[]>([])
  const [disabled, setDisabled] = useState<string[]>([])

  const reloadProjects = useCallback(async () => setProjects(await window.forge.listProjects()), [])
  useEffect(() => { void reloadProjects() }, [reloadProjects])
  useEffect(() => { void window.forge.listWorkflows().then(setWorkflows) }, [])
  useEffect(() => { void window.forge.detectProviders().then(setRawProviders) }, [])
  // Global custom-stage library: load once + stay live so editing a definition (or another window's
  // edit) reflects everywhere it's referenced. Guarded against a partial window.forge (test harnesses).
  useEffect(() => {
    void window.forge.listCustomStages?.().then(l => setCustomStages(l as CfgCustomStage[]))
    const off = window.forge.onCustomStagesChanged?.((l) => setCustomStages(l as CfgCustomStage[]))
    return () => { off?.() }
  }, [])

  // Track the disabled-provider list and keep it live across windows so toggling a provider off in
  // 设置 immediately drops it from every selection list without a restart.
  useEffect(() => {
    void window.forge.getSettings().then((s: Partial<Settings>) => setDisabled(s?.disabledProviders ?? []))
    const off = window.forge.onSettingsChanged((s) => {
      setDisabled(((s ?? {}) as Partial<Settings>).disabledProviders ?? [])
    })
    return () => { off() }
  }, [])

  const providers = useMemo(
    () => rawProviders.filter(p => !disabled.includes(p.id)),
    [rawProviders, disabled],
  )

  const redetect = useCallback(async () => { setRawProviders(await window.forge.detectProviders()) }, [])

  const addProject = useCallback(async (repoUrl: string, branch: string) => { const list = await window.forge.addProject({ repoUrl, branch }); setProjects(list); return list }, [])
  const deleteProject = useCallback(async (id: string) => { setProjects(await window.forge.deleteProject(id)) }, [])
  const updateProjectBranch = useCallback(async (id: string, branch: string) => { setProjects(await window.forge.updateProjectBranch({ id, branch })) }, [])

  // stages: bare built-in keys OR full CfgStage configs (custom stages), order preserved.
  const addWorkflow = useCallback(async (name: string, stages: (string | CfgStage)[]) => { const list = await window.forge.addWorkflow({ name, stages }); setWorkflows(list); return list }, [])
  const deleteWorkflow = useCallback(async (id: string) => { setWorkflows(await window.forge.deleteWorkflow(id)) }, [])
  const updateWorkflow = useCallback(async (id: string, plugins: Plugin[]) => { setWorkflows(await window.forge.updateWorkflow(id, plugins)) }, [])
  const updateStagePrompts = useCallback(async (id: string, stagePrompts: Record<string, string>) => { setWorkflows(await window.forge.updateStagePrompts(id, stagePrompts)) }, [])
  const updateStages = useCallback(async (id: string, stages: CfgStage[]) => { setWorkflows(await window.forge.updateWorkflowStages(id, stages)) }, [])

  // Global custom-stage library CRUD. upsert merges a patch onto the current def (or seeds a minimal one
  // for a brand-new id), returning the resolved def so callers (WorkflowPane「新建」) know the libId to
  // reference. delete removes it — references then fall back to their cached key/name.
  const upsertCustomStage = useCallback(async (id: string, patch: Partial<CfgCustomStage>): Promise<CfgCustomStage> => {
    const cur = customStages.find(s => s.id === id)
    const def: CfgCustomStage = { key: id, name: '新阶段', defaultAgent: 'claude', defaultModel: '', ...(cur ?? {}), ...patch, id }
    const list = await window.forge.upsertCustomStage?.(def)
    if (list) setCustomStages(list as CfgCustomStage[])
    return def
  }, [customStages])
  const deleteCustomStage = useCallback(async (id: string) => {
    const list = await window.forge.deleteCustomStage?.(id)
    if (list) setCustomStages(list as CfgCustomStage[])
  }, [])

  return { projects, workflows, customStages, providers, addProject, deleteProject, updateProjectBranch, reloadProjects, addWorkflow, deleteWorkflow, updateWorkflow, updateStagePrompts, updateStages, upsertCustomStage, deleteCustomStage, redetect }
}
