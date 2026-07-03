import { useCallback, useEffect, useState } from 'react'
import type { ProviderInfo } from '@shared/types'
import type { Plugin } from '@shared/plugin'

export interface CfgProject { id: string; name: string; repoUrl: string; defaultBranch: string }
export interface CfgWorkflow { id: string; name: string; stages: { key: string; defaultAgent: string; defaultModel: string }[]; plugins: Plugin[]; stagePrompts?: Record<string, string> }

export function useConfig() {
  const [projects, setProjects] = useState<CfgProject[]>([])
  const [workflows, setWorkflows] = useState<CfgWorkflow[]>([])
  const [providers, setProviders] = useState<ProviderInfo[]>([])

  const reloadProjects = useCallback(async () => setProjects(await window.forge.listProjects()), [])
  useEffect(() => { void reloadProjects() }, [reloadProjects])
  useEffect(() => { void window.forge.listWorkflows().then(setWorkflows) }, [])
  useEffect(() => { void window.forge.detectProviders().then(setProviders) }, [])

  const redetect = useCallback(async () => { setProviders(await window.forge.detectProviders()) }, [])

  const addProject = useCallback(async (repoUrl: string, branch: string) => { setProjects(await window.forge.addProject({ repoUrl, branch })) }, [])
  const deleteProject = useCallback(async (id: string) => { setProjects(await window.forge.deleteProject(id)) }, [])

  const addWorkflow = useCallback(async (name: string, stageKeys: string[]) => { setWorkflows(await window.forge.addWorkflow({ name, stages: stageKeys })) }, [])
  const deleteWorkflow = useCallback(async (id: string) => { setWorkflows(await window.forge.deleteWorkflow(id)) }, [])
  const updateWorkflow = useCallback(async (id: string, plugins: Plugin[]) => { setWorkflows(await window.forge.updateWorkflow(id, plugins)) }, [])
  const updateStagePrompts = useCallback(async (id: string, stagePrompts: Record<string, string>) => { setWorkflows(await window.forge.updateStagePrompts(id, stagePrompts)) }, [])

  return { projects, workflows, providers, addProject, deleteProject, reloadProjects, addWorkflow, deleteWorkflow, updateWorkflow, updateStagePrompts, redetect }
}
