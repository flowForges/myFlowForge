export function deriveProjectName(repoUrlOrPath: string): string {
  let s = repoUrlOrPath.trim().replace(/\/+$/, '')
  s = s.replace(/\.git$/, '')
  const seg = s.split(/[/:\\]/).filter(Boolean).pop() ?? s
  return seg
}

export function deriveProjectId(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
