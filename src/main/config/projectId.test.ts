import { describe, it, expect } from 'vitest'
import { deriveProjectName, deriveProjectId } from './projectId'

describe('project id/name derivation', () => {
  it('derives a name from a git URL or path, stripping .git', () => {
    expect(deriveProjectName('git@github.com:acme/design-system-v3.git')).toBe('design-system-v3')
    expect(deriveProjectName('https://github.com/acme/api-gateway.git')).toBe('api-gateway')
    expect(deriveProjectName('~/code/design-system-v3/')).toBe('design-system-v3')
  })
  it('derives a filesystem-safe id (lowercase, dashes) from the name', () => {
    expect(deriveProjectId('Design System V3')).toBe('design-system-v3')
    expect(deriveProjectId('api_gateway')).toBe('api-gateway')
  })
})
