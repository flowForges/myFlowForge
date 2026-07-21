// Choose the markdown design doc among an agent's reported forge_handoff artifacts: prefer a `.md`
// path, else an artifact whose kind is md/markdown/doc. Non-doc artifacts (code, etc.) are ignored.
// Neutral home (run/) so the forge MCP bridge can pick a design doc without depending on the legacy
// orchestrator module.
export function pickDocArtifact(artifacts: { path: string; kind: string }[] | undefined): string | undefined {
  if (!artifacts?.length) return undefined
  const byExt = artifacts.find(a => /\.md$/i.test(a.path.trim()))
  if (byExt) return byExt.path.trim()
  const byKind = artifacts.find(a => /^(md|markdown|doc)$/i.test((a.kind ?? '').trim()))
  return byKind ? byKind.path.trim() : undefined
}
