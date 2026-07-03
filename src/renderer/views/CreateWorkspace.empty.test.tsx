import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { CreateWorkspace } from './CreateWorkspace'

describe('CreateWorkspace with no workflows', () => {
  it('renders without crashing when there are no workflows', () => {
    expect(() => render(
      <CreateWorkspace open onCancel={() => {}} onCreate={() => {}} projects={[]} workflows={[]} providers={[]} onOpenProjectSettings={() => {}} onNewWorkflow={() => {}} />
    )).not.toThrow()
  })
})
