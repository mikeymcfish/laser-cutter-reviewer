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
  fixSvgStrokes: vi.fn(),
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
    {
      id: 'intro-svg',
      name: 'Intro laser-cutting project',
      description: 'Black vector cuts.',
      page_policy: 'exact',
      expected_width_mm: 304.8,
      expected_height_mm: 304.8,
    },
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
  document: { width_mm: 304.8, height_mm: 304.8, units: 'in', unit_confidence: 'explicit' },
  metrics: { object_count: 2, total_cut_length_mm: 210, image_count: 0, minimum_feature_mm: 1.2 },
  checks: [
    {
      rule_id: 'geometry.open_cut',
      title: 'Cut lines are closed',
      state: 'blocker',
      message: 'One through-cut line has an open end.',
      evidence: ['Gap: 0.016 in'],
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
      message: 'The artboard is 12 × 12 inches.',
      evidence: ['12 × 12 in'],
      object_ids: [],
      bounds: [],
    },
  ],
  geometry: {
    page: { width_mm: 304.8, height_mm: 304.8 },
    paths: [
      { id: 'path-open', z_index: 0, operation: 'cut', closed: false, stroke: '#000000', points: [[15, 10], [45, 10], [45, 35]] },
      { id: 'path-closed', z_index: 1, operation: 'cut', closed: true, stroke: '#000000', points: [[80, 40], [110, 40], [110, 70], [80, 70]] },
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
    vi.mocked(api.fixSvgStrokes).mockResolvedValue(new Blob(['<svg/>'], { type: 'image/svg+xml' }))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

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
    expect(screen.getByText('Gap: 0.016 in')).toBeInTheDocument()
    expect(screen.getByText(/Object > Path > Join/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /3D material/ })).toBeDisabled()
    expect(screen.getByText(/Open cut lines must be fixed/)).toBeInTheDocument()
  })

  it('presents the profile-driven artboard and analyzed measurements in inches', async () => {
    const user = userEvent.setup()
    const { container } = render(<App />)
    expect(await screen.findByText('Required artboard: 12 × 12 in')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '0.118 in' })).toBeInTheDocument()

    await user.upload(
      container.querySelector<HTMLInputElement>('input[type="file"]')!,
      new File(['<svg/>'], 'student.svg', { type: 'image/svg+xml' }),
    )
    await user.click(screen.getByRole('button', { name: 'Review my file' }))
    await screen.findByRole('heading', { name: '1 blocker to fix' })

    expect(screen.getAllByText('12 × 12 in').length).toBeGreaterThan(0)
    expect(screen.getByText('8.27 in')).toBeInTheDocument()
    expect(screen.getByText('0.047 in')).toBeInTheDocument()
    expect(screen.getByText('0.007 in')).toBeInTheDocument()
    expect(screen.queryByText(/\bmm\b/i)).not.toBeInTheDocument()
  })

  it('downloads a fingerprint-bound corrected copy without replacing the analyzed original', async () => {
    const user = userEvent.setup()
    const action = {
      id: 'normalize-cut-strokes',
      kind: 'normalize_cut_strokes' as const,
      label: 'Download corrected SVG',
      description: 'Change 2 highlighted cut strokes to RGB black (#000000) and 0.001 in.',
      object_ids: ['path-open', 'path-closed'],
      count: 2,
      target_color: '#000000' as const,
      target_stroke_width_in: 0.001 as const,
    }
    vi.mocked(api.analyzeSvg).mockResolvedValue({
      ...report,
      checks: [{
        rule_id: 'vectors.process_setup',
        title: 'Cut color and hairline width',
        state: 'blocker',
        message: 'Two cut strokes use the wrong process setup.',
        evidence: ['Expected #000000 at 0.001 in'],
        object_ids: action.object_ids,
        bounds: [],
        fix_actions: [action],
      }],
    })
    const createObjectUrl = vi.fn(() => 'blob:corrected-svg')
    const revokeObjectUrl = vi.fn()
    const previousCreateObjectUrl = URL.createObjectURL
    const previousRevokeObjectUrl = URL.revokeObjectURL
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    try {
      const { container } = render(<App />)
      await screen.findByText('Tell us what you’re making')
      const svg = new File(['<svg/>'], 'student.svg', { type: 'image/svg+xml' })
      await user.upload(container.querySelector<HTMLInputElement>('input[type="file"]')!, svg)
      await user.click(screen.getByRole('button', { name: 'Review my file' }))
      await user.click(await screen.findByRole('button', { name: /Cut color and hairline width/ }))
      expect(screen.getByText('Creates through-cuts: #000000 at 0.001 in')).toBeInTheDocument()
      expect(screen.getByText(/intentional engraving, cancel/)).toBeInTheDocument()
      expect(screen.getByText(/Your original stays unchanged/)).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: /Download corrected SVG: change 2 strokes/ }))
      expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('through-cuts (#000000 at 0.001 in)'))
      expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('intentional engraving, choose Cancel'))
      expect(await screen.findByText(/Corrected copy downloaded/)).toBeInTheDocument()
      expect(api.fixSvgStrokes).toHaveBeenCalledWith(svg, {
        assignmentId: 'intro-svg',
        expectedSha256: 'a'.repeat(64),
      })
      expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob))
      expect(revokeObjectUrl).toHaveBeenCalledWith('blob:corrected-svg')
      expect((click.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe('student-cut-strokes-fixed.svg')
      expect(screen.getAllByText('student.svg').length).toBeGreaterThan(0)
    } finally {
      click.mockRestore()
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: previousCreateObjectUrl })
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: previousRevokeObjectUrl })
    }
  })

  it('cancels automatic stroke conversion when the student declines the through-cut warning', async () => {
    const user = userEvent.setup()
    vi.mocked(window.confirm).mockReturnValue(false)
    vi.mocked(api.analyzeSvg).mockResolvedValue({
      ...report,
      checks: [{
        rule_id: 'vectors.process_setup',
        title: 'Cut color and hairline width',
        state: 'blocker',
        message: 'One stroke is not set up as a cut.',
        object_ids: ['path-open'],
        bounds: [],
        fix_actions: [{
          id: 'normalize-cut-strokes',
          kind: 'normalize_cut_strokes',
          label: 'Download corrected SVG',
          description: 'Change the highlighted stroke to RGB black and 0.001 in.',
          object_ids: ['path-open'],
          count: 1,
          target_color: '#000000',
          target_stroke_width_in: 0.001,
        }],
      }],
    })
    const { container } = render(<App />)
    await screen.findByText('Tell us what you’re making')
    await user.upload(
      container.querySelector<HTMLInputElement>('input[type="file"]')!,
      new File(['<svg/>'], 'student.svg', { type: 'image/svg+xml' }),
    )
    await user.click(screen.getByRole('button', { name: 'Review my file' }))
    await user.click(await screen.findByRole('button', { name: /Cut color and hairline width/ }))
    await user.click(screen.getByRole('button', { name: /Download corrected SVG: change 1 stroke/ }))

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('1 highlighted stroke'))
    expect(api.fixSvgStrokes).not.toHaveBeenCalled()
    expect(screen.queryByText(/Corrected copy downloaded/)).not.toBeInTheDocument()
  })

  it('announces a corrected-copy service error without clearing the report', async () => {
    const user = userEvent.setup()
    vi.mocked(api.analyzeSvg).mockResolvedValue({
      ...report,
      checks: [{
        rule_id: 'vectors.process_setup',
        title: 'Cut color and hairline width',
        state: 'blocker',
        message: 'One cut stroke is the wrong color.',
        object_ids: ['path-open'],
        bounds: [],
        fix_actions: [{
          id: 'normalize-cut-strokes',
          kind: 'normalize_cut_strokes',
          label: 'Download corrected SVG',
          description: 'Change the highlighted stroke to RGB black and 0.001 in.',
          object_ids: ['path-open'],
          count: 1,
          target_color: '#000000',
          target_stroke_width_in: 0.001,
        }],
      }],
    })
    vi.mocked(api.fixSvgStrokes).mockRejectedValue(new Error('Correction could not preserve this transformed stroke.'))
    const { container } = render(<App />)
    await screen.findByText('Tell us what you’re making')
    await user.upload(
      container.querySelector<HTMLInputElement>('input[type="file"]')!,
      new File(['<svg/>'], 'student.svg', { type: 'image/svg+xml' }),
    )
    await user.click(screen.getByRole('button', { name: 'Review my file' }))
    await user.click(await screen.findByRole('button', { name: /Cut color and hairline width/ }))
    await user.click(screen.getByRole('button', { name: /Download corrected SVG: change 1 stroke/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Correction could not preserve this transformed stroke.')
    expect(screen.getByRole('heading', { name: '1 blocker to fix' })).toBeInTheDocument()
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
