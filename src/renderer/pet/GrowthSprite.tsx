import type { ReactElement, CSSProperties } from 'react'
import type { GrowthPack } from '@shared/growthPet'
import { growthRowCount } from '@shared/growthPet'
import type { PetState } from '@shared/types'
import { pickGrowthSprite } from '@shared/growthProgress'
import { gridBackgroundPosition } from '@shared/petAtlas'
import { petImageUrl } from '@shared/petImageUrl'
import { useAtlasAnimation } from './useAtlasAnimation'

interface Props {
  growth: GrowthPack
  /** 0~1,来自主进程广播的成长信号。 */
  progress: number
  state: PetState
  reducedMotion?: boolean
}

// 成长宠物的渲染。与 codex 的 PetAtlasSprite 刻意分开:那个还要负责 look-at-cursor 的 16 向姿势
// (第 9/10 行),成长包没有这套;合成一个组件只会多出永远为假的分支,还把 codex 宠物暴露在回归风险里。
// 共享的只有 gridBackgroundPosition 这点纯网格数学和 useAtlasAnimation 的逐帧驱动。
export function GrowthSprite({ growth, progress, state, reducedMotion }: Props): ReactElement {
  // 网格行数由动作里最大的 row 推出(见 growthRowCount);设置页的缩略图共用同一份计算。
  const rows = growthRowCount(growth.actions)
  const pick = pickGrowthSprite({ id: '', name: '', ...growth }, progress, state)
  const frame = useAtlasAnimation(pick.action, { reducedMotion, durations: pick.durations })
  const pos = gridBackgroundPosition(Math.min(frame, growth.atlas.cols - 1), pick.row, growth.atlas.cols, rows)

  const style: CSSProperties & Record<'--growth-sub', string> = {
    backgroundImage: `url(${petImageUrl(pick.sheet)})`,
    backgroundSize: `${growth.atlas.cols * 100}% ${rows * 100}%`,
    backgroundPosition: `${pos.x} ${pos.y}`,
    backgroundRepeat: 'no-repeat',
    // 阶段内的子进度。CSS 用它做 scale 0.94→1.0 —— token 是连续量,画面就该连续长,
    // 而不是一天只跳几次。零素材成本。
    '--growth-sub': String(pick.subProgress),
  }

  return (
    <>
      {/* 阶段一跳就要立刻有图,现拉会闪空白 —— 所有阶段图开屏就预加载。 */}
      {growth.stages.map((s) => (
        <link key={s.sheet} rel="preload" as="image" href={petImageUrl(s.sheet)} />
      ))}
      <div className="pet-growth" data-action={pick.action} data-stage={pick.stageIndex} style={style} />
    </>
  )
}
