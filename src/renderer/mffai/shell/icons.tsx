// 图标:路径抄自设计稿 _src/lib.py 的 P;装饰用,aria-hidden
import type { ReactNode } from 'react'

export type IconName = 'chat' | 'tasks' | 'brain' | 'puzzle' | 'link' | 'shield' | 'shieldok' | 'shieldx' | 'bug' | 'power' | 'plus' | 'check' | 'x' | 'chevr' | 'chevd' | 'chevu' | 'term' | 'file' | 'edit' | 'search' | 'folder' | 'copy' | 'undo' | 'merge' | 'trash' | 'sparkle' | 'lock' | 'key' | 'globe' | 'alert' | 'eye' | 'refresh' | 'bot' | 'up' | 'more' | 'play' | 'users' | 'ext' | 'zap' | 'pause' | 'pkg' | 'server' | 'ban' | 'branch' | 'user' | 'cal' | 'star' | 'qr' | 'hash' | 'layers' | 'quote' | 'dl' | 'filter' | 'grip' | 'home' | 'sidebar' | 'msg2' | 'cpu' | 'monitor' | 'send' | 'clock' | 'code'

const SHAPES: Record<IconName, ReactNode> = {
  chat: <><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></>,
  tasks: <><path d="m3 7 2 2 4-4M3 17l2 2 4-4M13 6h8M13 12h8M13 18h8" /></>,
  brain: <><path d="M12 4a3.5 3.5 0 0 0-6.5 1.5A3.5 3.5 0 0 0 4 12a3.5 3.5 0 0 0 2 6.3A3.5 3.5 0 0 0 12 20z" /><path d="M12 4a3.5 3.5 0 0 1 6.5 1.5A3.5 3.5 0 0 1 20 12a3.5 3.5 0 0 1-2 6.3A3.5 3.5 0 0 1 12 20" /></>,
  puzzle: <><path d="M9 3h4v2.5a1.8 1.8 0 1 0 3.6 0V3H20v5h-2.5a1.8 1.8 0 1 0 0 3.6H20V21h-5v-2.5a1.8 1.8 0 1 0-3.6 0V21H4v-5.5h2.5a1.8 1.8 0 1 0 0-3.6H4V3z" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></>,
  shield: <><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" /></>,
  shieldok: <><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" /><path d="m9 12 2 2 4-4" /></>,
  shieldx: <><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" /><path d="M12 8v4M12 16h.01" /></>,
  bug: <><rect x="8" y="6" width="8" height="14" rx="4" /><path d="M12 20v-9M8 10H4M8 15H4M16 10h4M16 15h4M9 6 8 3M15 6l1-3" /></>,
  power: <><path d="M12 3v9" /><path d="M6.4 6.4a8 8 0 1 0 11.2 0" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  check: <><path d="M20 6 9 17l-5-5" /></>,
  x: <><path d="M18 6 6 18M6 6l12 12" /></>,
  chevr: <><path d="m9 18 6-6-6-6" /></>,
  chevd: <><path d="m6 9 6 6 6-6" /></>,
  chevu: <><path d="m18 15-6-6-6 6" /></>,
  term: <><path d="m4 17 6-5-6-5M12 19h8" /></>,
  file: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /></>,
  edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>,
  folder: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>,
  copy: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>,
  undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></>,
  merge: <><circle cx="18" cy="18" r="2.5" /><circle cx="6" cy="6" r="2.5" /><path d="M6 21V8.5M6 9a9 9 0 0 0 9.5 9" /></>,
  trash: <><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></>,
  sparkle: <><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /></>,
  lock: <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  key: <><circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 9.3-9.3M16 7l3 3M14 9l2 2" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
  alert: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  refresh: <><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></>,
  bot: <><rect x="5" y="7" width="14" height="12" rx="3" /><path d="M12 3v4M9.5 12h.01M14.5 12h.01M9.5 16h5" /></>,
  up: <><path d="M12 19V5M5 12l7-7 7 7" /></>,
  more: <><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></>,
  play: <><path d="M7 4l13 8-13 8z" /></>,
  users: <><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M16 5a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.6" /></>,
  ext: <><path d="M14 3h7v7M21 3l-9 9" /><path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" /></>,
  zap: <><path d="M13 2 3 14h9l-1 8 10-12h-9z" /></>,
  pause: <><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></>,
  pkg: <><path d="M21 8 12 3 3 8v8l9 5 9-5z" /><path d="M3 8l9 5 9-5M12 13v8" /></>,
  server: <><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>,
  ban: <><circle cx="12" cy="12" r="9" /><path d="m5.7 5.7 12.6 12.6" /></>,
  branch: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" /><path d="M6 7v10M18 9a6 6 0 0 1-6 6H6" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  cal: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  star: <><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" /></>,
  qr: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3" /></>,
  hash: <><path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></>,
  quote: <><path d="M7 7h4v4c0 3-2 5-4 6M15 7h4v4c0 3-2 5-4 6" /></>,
  dl: <><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></>,
  filter: <><path d="M3 5h18l-7 8v6l-4 2v-8z" /></>,
  grip: <><circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" /></>,
  home: <><path d="M3 11 12 4l9 7" /><path d="M5 10v10h14V10" /></>,
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  msg2: <><path d="M4 5h16v11H8l-4 4z" /></>,
  cpu: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></>,
  monitor: <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  send: <><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4z" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  code: <><path d="m16 18 6-6-6-6M8 6l-6 6 6 6" /></>,
}

export function Icon({ name, size }: { name: IconName; size?: 12 | 13 | 14 | 15 | 16 | 18 | 20 | 24 | 28 }) {
  return (
    <svg className="mffai-i" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      {SHAPES[name]}
    </svg>
  )
}
