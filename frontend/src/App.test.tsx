import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import * as api from './api'
import * as pdfReport from './report'
import type { AnalysisReport, ProfileResponse } from './types'

vi.mock('./api', () => ({
  getProfile: vi.fn(),
  analyzeSvg: vi.fn(),
  sha256File: vi.fn(),
}))

vi.mock('./report', () => ({
  downloadReport: vi.fn(),
}))

const profile: ProfileResponse = {
  profile: { id: 'demo', name: 'Classroom', version: '1.0.0', demo: false },
  machine: { label: 'Epilog Fusion' },
  limits: { max_upload_bytes: 20 * 1024 * 1024 },
  assignments: [
    { id: 'intro-svg', name: 'Intro laser-cutting project', description: 'Black vector cuts.' },
    { id: 'vector-trace', name: 'Vector tracing exercise', description: 'No images.' },
  ],
  materials: [
    { id: 'birch-plywood', name: 'Baltic birch plywood', family: 'wood', thicknesses_mm: [3, 6], kerf_mm: 0.18 },
    { id: 'cast-acrylic', name: 'Cast acrylic', family: 'acrylic', thicknesses_mm: [3], kerf_mm: 0.15 },
  ],
  operator_checklist: ['Confirm approved material.', 'Turn on exhaust.'],
}

const report: AnalysisReport = {
  report_version: '1.0',
  analyzed_at: '2026-07-14T14:30:00Z',
  file: { name: 'student.svg', size_bytes: 120, sha256: 'a'.repeat(64) },
  profile: { id: 'demo', name: 'Classroom', version: '1.0.0', demo: false },
  selection: { assignment_id: 'intro-svg', material_id: 'birch-plywood', thickness_mm: 3 },
  summary: { status: 'not_ready', label: 'Fix blockers', counts: { blocker: 1, warning: 1, pass: 1, info: 0, unverified: 0 } },
  document: { width_mm: 304.8, height_mm: 203.2, units: 'in', unit_confidence: 'explicit' },
  metrics: { object_count: 2, total_cut_length_mm: 210, image_count: 0, minimum_feature_mm: 1.2 },
  checks: [
    {
      rule_id: 'geometry.open_cut',
      title: 'Cut lines are closed',
      state: 'blocker',
      message: 'One through-cut line has an open end.',
      evidence: ['Gap: 0.4 mm'],
      fix: 'Use Object > Path > Join to close the two endpoints.',
      object_ids: ['path-open'],
      bounds: [{ x_mm: 15, y_mm: 10, width_mm: 30, height_mm: 25 }],
    },
    {
      rule_id: 'images.none',
      title: 'Raster image review',
      state: 'warning',
      message: 'Review any raster artwork before cutting.',
      evidence: [],
      object_ids: [],
      bounds: [],
    },
    {
      rule_id: 'document.size',
      title: 'Document size matches',
      state: 'pass',
      message: 'The artboard is 12 × 8 inches.',
      evidence: ['304.8 × 203.2 mm'],
      object_ids: [],
      bounds: [],
    },
  ],
  geometry: {
    page: { width_mm: 304.8, height_mm: 203.2 },
    paths: [
      { id: 'path-open', operation: 'cut', closed: false, stroke: '#000000', points: [[15, 10], [45, 10], [45, 35]] },
      { id: 'path-closed', operation: 'cut', closed: true, stroke: '#000000', points: [[80, 40], [110, 40], [110, 70], [80, 70]] },
    ],
    pieces: [],
    valid_3d: false,
    invalid_reason: 'Open cut lines must be fixed before extrusion.',
  },
}

describe('Laser Ready app', () => {
  beforeEach(() => {
    vi.mocked(api.getProfile).mockResolvedValue(profile)
    vi.mocked(api.sha256File).mockResolvedValue('a'.repeat(64))
    vi.mocked(api.analyzeSvg).mockResolvedValue(report)
  })

  afterEach(() => vi.clearAllMocks())

  it('uploads an SVG, submits the selected profile choices, and explains a blocker', async () => {
    const user = userEvent.setup()
    const { container } = render(<App />)

    expect(await screen.findByText('Tell us what you’re making')).toBeInTheDocument()
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    const svg = new File(['<svg><script>bad()</script></svg>'], 'student.svg', { type: 'image/svg+xml' })
    await user.upload(input, svg)
    expect(await screen.findByText('student.svg')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Review my file' }))

    expect(await screen.findByRole('heading', { name: '1 blocker to fix' })).toBeInTheDocument()
    expect(api.analyzeSvg).toHaveBeenCalledWith(
      svg,
      { assignmentId: 'intro-svg', materialId: 'birch-plywood', thicknessMm: 3 },
    )
    expect(container.querySelector('script')).toBeNull()

    await user.click(screen.getByRole('button', { name: /Cut lines are closed/ }))
    expect(screen.getByText('Gap: 0.4 mm')).toBeInTheDocument()
    expect(screen.getByText(/Object > Path > Join/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /3D material/ })).toBeDisabled()
    expect(screen.getByText(/Open cut lines must be fixed/)).toBeInTheDocument()
  })

  it('never marks a demo profile ready even with no blockers', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getProfile).mockResolvedValue({ ...profile, profile: { ...profile.profile, demo: true } })
    vi.mocked(api.analyzeSvg).mockResolvedValue({
      ...report,
      profile: { ...report.profile, demo: true },
      summary: { status: 'ready', label: 'Ready', counts: { blocker: 0, warning: 0, pass: 1, info: 0, unverified: 0 } },
      checks: [report.checks[2]],
    })
    const { container } = render(<App />)
    await screen.findByText('Tell us what you’re making')
    const svg = new File(['<svg/>'], 'ready.svg', { type: 'image/svg+xml' })
    await user.upload(container.querySelector<HTMLInputElement>('input[type="file"]')!, svg)
    await user.click(screen.getByRole('button', { name: 'Review my file' }))
    expect(await screen.findByRole('heading', { name: 'Review complete — teacher setup required' })).toBeInTheDocument()
  })

  it('keeps blockers prominent when the active profile is also a demo', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getProfile).mockResolvedValue({ ...profile, profile: { ...profile.profile, demo: true } })
    vi.mocked(api.analyzeSvg).mockResolvedValue({
      ...report,
      profile: { ...report.profile, demo: true },
    })
    const { container } = render(<App />)
    await screen.findByText('Tell us what you’re making')
    await user.upload(
      container.querySelector<HTMLInputElement>('input[type="file"]')!,
      new File(['<svg/>'], 'blocked.svg', { type: 'image/svg+xml' }),
    )
    await user.click(screen.getByRole('button', { name: 'Review my file' }))
    expect(await screen.findByRole('heading', { name: '1 blocker to fix' })).toBeInTheDocument()
    expect(screen.getByText(/also uses demonstration machine values/)).toBeInTheDocument()
  })

  it('passes the fingerprint and manual checklist state to PDF generation', async () => {
    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText('Tell us what you’re making')
    await user.upload(
      container.querySelector<HTMLInputElement>('input[type="file"]')!,
      new File(['<svg/>'], 'student.svg', { type: 'image/svg+xml' }),
    )
    await user.click(screen.getByRole('button', { name: 'Review my file' }))
    await screen.findByText('Teacher/operator checklist')
    await user.click(screen.getByRole('checkbox', { name: 'Confirm approved material.' }))
    await user.click(screen.getByRole('button', { name: 'Download PDF report' }))
    await waitFor(() => expect(pdfReport.downloadReport).toHaveBeenCalled())
    expect(pdfReport.downloadReport).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: expect.objectContaining({
          assignment_label: 'Intro laser-cutting project',
          material_label: 'Baltic birch plywood',
          material_type: 'wood',
          kerf_mm: 0.18,
        }),
      }),
      'a'.repeat(64),
      [
        { label: 'Confirm approved material.', checked: true },
        { label: 'Turn on exhaust.', checked: false },
      ],
      false,
    )
  })

  it('rejects non-SVG uploads before calling the analyzer', async () => {
    const user = userEvent.setup({ applyAccept: false })
    const { container } = render(<App />)
    await screen.findByText('Tell us what you’re making')
    await user.upload(
      container.querySelector<HTMLInputElement>('input[type="file"]')!,
      new File(['not svg'], 'drawing.pdf', { type: 'application/pdf' }),
    )
    expect(await screen.findByText(/PDF, AI, and DXF files are not supported/)).toBeInTheDocument()
    expect(api.analyzeSvg).not.toHaveBeenCalled()
  })

  it('enforces the upload ceiling from the active lab profile', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getProfile).mockResolvedValue({
      ...profile,
      limits: { max_upload_bytes: 8 },
    })
    const { container } = render(<App />)
    await screen.findByText('Tell us what you’re making')
    expect(screen.getByText(/8 B maximum/)).toBeInTheDocument()
    await user.upload(
      container.querySelector<HTMLInputElement>('input[type="file"]')!,
      new File(['123456789'], 'too-large.svg', { type: 'image/svg+xml' }),
    )
    expect(await screen.findByText(/larger than 8 B/)).toBeInTheDocument()
    expect(api.sha256File).not.toHaveBeenCalled()
  })
})
