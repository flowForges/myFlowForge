import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ChangesPane } from './ChangesPane'
import type { ChangeItem } from '@shared/types'

const changes: ChangeItem[] = [
  { path: 'src/a.ts', type: 'M', add: 4, del: 2 },
  { path: 'src/new.ts', type: 'A', add: 10, del: 0 },
  { path: 'old.ts', type: 'D', add: 0, del: 7 }
]

describe('ChangesPane', () => {
  it('shows A/M/D summary counts and a row per change; clicking opens it', () => {
    const onOpen = vi.fn()
    render(<ChangesPane changes={changes} onOpen={onOpen} />)
    // path renders as a faint dir prefix + filename text node, so match the basename
    expect(screen.getByText('a.ts')).toBeInTheDocument()
    expect(screen.getByText('old.ts')).toBeInTheDocument()
    fireEvent.click(screen.getByText('new.ts'))
    expect(onOpen).toHaveBeenCalledWith('src/new.ts', 'A', undefined)
  })
  it('shows an empty state when there are no changes', () => {
    render(<ChangesPane changes={[]} onOpen={() => {}} />)
    expect(screen.queryByText('a.ts')).not.toBeInTheDocument()
  })

  it('highlights the row matching activePath (selected state for the browser sidebar)', () => {
    render(<ChangesPane changes={changes} onOpen={() => {}} activePath="src/a.ts" />)
    const on = document.querySelector('.chg-item.on')
    expect(on).not.toBeNull()
    expect(on!.getAttribute('data-file')).toBe('src/a.ts')
    // the others are not highlighted
    expect(document.querySelectorAll('.chg-item.on').length).toBe(1)
  })

  it('renders grouped changes per project and opens with the group cwd', () => {
    const onOpen = vi.fn()
    const groups = [
      { name: 'web', cwd: '/w/web', changes: [{ path: 'app.tsx', type: 'M', add: 1, del: 1 } as ChangeItem] },
      { name: 'api', cwd: '/w/api', changes: [{ path: 'main.go', type: 'A', add: 5, del: 0 } as ChangeItem] },
    ]
    render(<ChangesPane changes={[]} groups={groups} onOpen={onOpen} />)
    expect(screen.getByText('web')).toBeInTheDocument()
    expect(screen.getByText('api')).toBeInTheDocument()
    expect(screen.getByText('app.tsx')).toBeInTheDocument()
    fireEvent.click(screen.getByText('main.go'))
    expect(onOpen).toHaveBeenCalledWith('main.go', 'A', '/w/api')
  })
})
