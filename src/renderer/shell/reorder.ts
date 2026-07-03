// Move `dragId` so it takes `dropId`'s slot in the list (HTML5 drag-and-drop reorder).
// Returns a new array; a no-op (fresh copy) when either id is unknown or they're identical.
export function reorder(ids: string[], dragId: string, dropId: string): string[] {
  if (dragId === dropId) return ids.slice()
  if (!ids.includes(dragId) || !ids.includes(dropId)) return ids.slice()
  const without = ids.filter(id => id !== dragId)
  const at = without.indexOf(dropId)
  without.splice(at, 0, dragId)
  return without
}
