import type { Plugin } from './plugin'

export function movePluginBefore(
  plugins: Plugin[],
  dragId: string,
  targetId: string
): Plugin[] {
  // Find drag and target plugins
  const drag = plugins.find(p => p.id === dragId)
  const target = plugins.find(p => p.id === targetId)

  // No-op cases
  if (!drag || !target || dragId === targetId || drag.after !== target.after) {
    return plugins
  }

  // Make a copy of the array
  const result = [...plugins]

  // Remove drag from the copy
  const dragIndex = result.findIndex(p => p.id === dragId)
  result.splice(dragIndex, 1)

  // Find target's new index in the copy
  const targetNewIndex = result.findIndex(p => p.id === targetId)

  // Insert drag immediately before target
  result.splice(targetNewIndex, 0, drag)

  return result
}
