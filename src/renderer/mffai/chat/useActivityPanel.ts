// 活动面板怎么显示(08b §4.4、R4):偏好 open 且主区 ≥ 1280 → 停靠;主区窄于 1280(或量不到)时用户点开 → 抽屉;其余 → 卡片在对话流里。
// 偏好只在宽窗下点「活动」或 › 时写;窄窗只开关抽屉。拉宽后抽屉状态清掉。
import { useCallback, useEffect, useState } from 'react'
import { activityPref, LIST_NARROW_BELOW, PANEL_MIN_MAIN, type PanelPref } from '../layout'
import { useMainWidth } from '../useMainWidth'

export type PanelMode = 'docked' | 'inline' | 'drawer'

export function useActivityPanel(): { mode: PanelMode; pref: PanelPref; narrow: boolean; toggle(): void; close(): void } {
  const width = useMainWidth()
  const [pref, setPref] = useState<PanelPref>(() => activityPref.get())
  const [drawer, setDrawer] = useState(false)
  useEffect(() => activityPref.subscribe(setPref), [])
  const wide = width !== undefined && width >= PANEL_MIN_MAIN
  useEffect(() => { if (wide) setDrawer(false) }, [wide])

  const mode: PanelMode = wide ? (pref === 'open' ? 'docked' : 'inline') : drawer ? 'drawer' : 'inline'
  const toggle = useCallback(() => {
    if (wide) activityPref.set(pref === 'open' ? 'closed' : 'open')
    else setDrawer((d) => !d)
  }, [wide, pref])
  const close = useCallback(() => {
    if (wide) activityPref.set('closed')
    else setDrawer(false)
  }, [wide])
  return { mode, pref, narrow: width !== undefined && width < LIST_NARROW_BELOW, toggle, close }
}
