import { describe, it, expect } from 'vitest'
import { vibrancyMaterial, windowsBackgroundMaterial, windowEffect } from './vibrancy'

describe('vibrancyMaterial (macOS)', () => {
  it('0 / undefined → no material (opaque window)', () => {
    expect(vibrancyMaterial(0)).toBeUndefined()
    expect(vibrancyMaterial(undefined)).toBeUndefined()
  })
  it('maps the slider into three buckets', () => {
    expect(vibrancyMaterial(0.2)).toBe('sidebar')
    expect(vibrancyMaterial(0.5)).toBe('under-window')
    expect(vibrancyMaterial(0.9)).toBe('fullscreen-ui')
  })
})

describe('windowsBackgroundMaterial', () => {
  it('0 / undefined → no material', () => {
    expect(windowsBackgroundMaterial(0)).toBeUndefined()
    expect(windowsBackgroundMaterial(undefined)).toBeUndefined()
  })
  it('subtle blur → mica, heavy blur → acrylic', () => {
    expect(windowsBackgroundMaterial(0.2)).toBe('mica')
    expect(windowsBackgroundMaterial(0.5)).toBe('mica')
    expect(windowsBackgroundMaterial(0.9)).toBe('acrylic')
  })
  it('only ever returns materials Electron accepts on Windows', () => {
    for (const a of [0.1, 0.3, 0.5, 0.74, 0.75, 1]) {
      expect(['mica', 'acrylic']).toContain(windowsBackgroundMaterial(a))
    }
  })
})

describe('windowEffect — the platform-neutral bucket both sides compare', () => {
  it('picks the native effect for the platform', () => {
    expect(windowEffect(0.9, 'darwin')).toBe('fullscreen-ui')
    expect(windowEffect(0.9, 'win32')).toBe('acrylic')
  })
  it('no native window material on other platforms (Linux)', () => {
    expect(windowEffect(0.9, 'linux')).toBeUndefined()
    expect(windowEffect(0, 'linux')).toBeUndefined()
  })
  // The settings pane compares launch-time vs current bucket to decide whether the "需要重启" hint
  // shows. Two levels inside one bucket must NOT ask for a restart; crossing one must.
  it('same bucket → no rebuild needed; crossing a bucket → rebuild needed', () => {
    expect(windowEffect(0.1, 'win32')).toBe(windowEffect(0.5, 'win32'))
    expect(windowEffect(0.5, 'win32')).not.toBe(windowEffect(0.9, 'win32'))
    expect(windowEffect(0.1, 'darwin')).not.toBe(windowEffect(0.5, 'darwin'))
  })
  it('turning the effect off is itself a bucket change', () => {
    expect(windowEffect(0, 'win32')).toBeUndefined()
    expect(windowEffect(0.1, 'win32')).toBeDefined()
  })
})
