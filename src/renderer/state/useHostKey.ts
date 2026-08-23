import { useEffect, useState } from 'react'

/**
 * 当前正在看哪台机器。本机是 `'local'`。
 *
 * 用来给「跟设备但按 host 分键」的设置做键(Q3 的 lastActiveWorkspace) ——
 * 手机和电脑的「上次看的工作区」必然不同,连不同的 host 也必然不同,存成一个值会互相覆盖。
 */
export function useHostKey(): string {
  const [key, setKey] = useState('local')
  useEffect(() => {
    let pushed = false
    const off = window.forge.onHostStatus?.((s) => { pushed = true; setKey(s.hostId ?? 'local') })
    void window.forge.hostsStatus?.().then((s) => { if (!pushed) setKey(s.hostId ?? 'local') })
    return off
  }, [])
  return key
}
