import type { ChatSession } from '@shared/types'

/**
 * canContinue — whether a "基于此历史继续" button should be shown.
 *
 * Conditions (all must hold):
 *   1. session.readonly === true   (it is a read-only imported session)
 *   2. session.external exists     (has source metadata)
 *   3. msgCount > 0                (there is actual body to inherit)
 *
 * The msgCount guard also satisfies the Global Constraint:
 *   hasBody=false (qoder with no body) → sessionImportRead returns [] → msgCount=0 → false.
 */
export function canContinue(session: ChatSession, msgCount: number): boolean {
  return !!session.readonly && !!session.external && msgCount > 0
}
