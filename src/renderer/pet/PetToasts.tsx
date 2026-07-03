import type { Pet } from '@shared/types'
import type { Toast } from './usePetToasts'
import { PetToast } from './PetToast'

export function PetToasts({ toasts, corner, onView, onDismiss }: {
  toasts: Toast[]
  corner: Pet['corner']
  onView: (id: string) => void
  onDismiss: (id: string) => void
}) {
  return (
    <div className="pet-toasts" data-corner={corner} aria-live="polite">
      {toasts.map(t => <PetToast key={t.id} toast={t} onView={onView} onDismiss={onDismiss} />)}
    </div>
  )
}
