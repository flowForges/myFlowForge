import type { Plugin } from '../../shared/plugin'

export type WovenStep<S> = { kind: 'stage'; stage: S } | { kind: 'hook'; plugin: Plugin }

export function weavePlugins<S extends { key: string }>(stages: S[], plugins: Plugin[]): WovenStep<S>[] {
  const at = (after: string) => plugins.filter(p => p.after === after)
  const out: WovenStep<S>[] = []
  for (const p of at('__start')) out.push({ kind: 'hook', plugin: p })
  for (const stage of stages) {
    out.push({ kind: 'stage', stage })
    for (const p of at(stage.key)) out.push({ kind: 'hook', plugin: p })
  }
  return out
}
