import type { PointerEvent } from 'react'

interface ResizeHandleProps {
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void
  className?: string
}

export function ResizeHandle({ onPointerDown, className }: ResizeHandleProps) {
  return (
    <div
      className={'resize-handle' + (className ? ' ' + className : '')}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="vertical"
    />
  )
}
