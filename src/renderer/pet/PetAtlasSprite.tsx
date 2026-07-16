import type { ReactElement, CSSProperties } from 'react'
import { ROW_OF, cellBackgroundPosition, lookCellForAngle, type PetAction } from '@shared/petAtlas'
import { petImageUrl } from '@shared/petImageUrl'
import { useAtlasAnimation } from './useAtlasAnimation'

interface Props {
  atlasPath: string                 // forge-pet relpath, e.g. "p1/spritesheet.webp"
  action: PetAction
  lookDeg?: number | null           // when a number, render the static look cell (rows 9-10) instead
  reducedMotion?: boolean
}

// Renders ONE atlas cell as a div background. No shell chrome here — PetWidget wraps it. background-size
// 800%×1100% blows the 8×11 grid up so each cell exactly fills the box; background-position selects the
// cell. When looking at the cursor, we freeze on the direction cell instead of running the row.
export function PetAtlasSprite({ atlasPath, action, lookDeg, reducedMotion }: Props): ReactElement {
  const frame = useAtlasAnimation(action, { reducedMotion })
  const cell = typeof lookDeg === 'number'
    ? lookCellForAngle(lookDeg)
    : { col: frame, row: ROW_OF[action] }
  const pos = cellBackgroundPosition(cell.col, cell.row)
  const style: CSSProperties = {
    backgroundImage: `url(${petImageUrl(atlasPath)})`,
    backgroundSize: '800% 1100%',
    backgroundPosition: `${pos.x} ${pos.y}`,
    backgroundRepeat: 'no-repeat',
  }
  return <div className="pet-atlas" data-action={action} style={style} />
}
