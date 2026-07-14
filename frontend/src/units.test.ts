import { describe, expect, it } from 'vitest'
import {
  formatCutDensityInches,
  formatDimensionsInches,
  formatInches,
  formatSquareInches,
  mmToInches,
} from './units'

describe('inch-first formatting', () => {
  it('converts canonical millimeter geometry to concise inch labels', () => {
    expect(mmToInches(25.4)).toBe(1)
    expect(formatInches(0.0254)).toBe('0.001 in')
    expect(formatInches(3)).toBe('0.118 in')
    expect(formatDimensionsInches(304.8, 304.8)).toBe('12 × 12 in')
  })

  it('converts area and line-density units rather than relabeling them', () => {
    expect(formatSquareInches(645.16)).toBe('1 in²')
    expect(formatCutDensityInches(1 / 25.4)).toBe('1 in/in²')
  })

  it('uses a stable fallback for unresolved measurements', () => {
    expect(formatInches(undefined)).toBe('—')
    expect(formatDimensionsInches(null, 304.8)).toBe('—')
  })
})
