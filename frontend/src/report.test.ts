import { describe, expect, it } from 'vitest'
import { findingEvidenceText, reportFileFacts } from './report'
import type { AnalysisReport } from './types'

const report: AnalysisReport = {
  report_version: '1.0',
  analyzed_at: '2026-07-14T14:30:00Z',
  file: { name: 'student.svg', size_bytes: 512, sha256: 'a'.repeat(64) },
  profile: { id: 'classroom', name: 'Classroom', version: '1.0.0', demo: false },
  selection: { assignment_id: 'intro-svg', material_id: 'birch', thickness_mm: 3, kerf_mm: 0.18 },
  summary: { status: 'not_ready', label: 'Fix blockers', counts: { blocker: 1 } },
  document: { width_mm: 304.8, height_mm: 203.2, units: 'in', unit_confidence: 'explicit' },
  metrics: {
    object_count: 4,
    vector_path_count: 3,
    total_cut_length_mm: 125.4,
    image_count: 1,
    smallest_estimated_feature_mm: 0.62,
  },
  checks: [],
  geometry: {
    page: { width_mm: null, height_mm: null },
    paths: [],
    pieces: [],
    valid_3d: false,
    invalid_reason: 'No pieces',
  },
}

describe('PDF report content', () => {
  it('builds concise facts with nullable preview geometry and the legacy feature fallback', () => {
    expect(reportFileFacts(report)).toEqual(expect.arrayContaining([
      { label: 'Document', value: '12 × 8 in' },
      { label: 'Smallest feature', value: '0.024 in' },
      { label: 'Kerf estimate', value: '0.007 in' },
    ]))
  })

  it('formats all measured evidence for inclusion under a finding', () => {
    expect(findingEvidenceText(['Stroke: 0.04 mm', 'Expected: 0.0254 mm'])).toBe(
      'Stroke: 0.04 mm · Expected: 0.0254 mm',
    )
    expect(findingEvidenceText([])).toBe('No measured evidence was reported.')
  })
})
