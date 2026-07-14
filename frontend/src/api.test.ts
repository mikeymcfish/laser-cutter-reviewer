import { afterEach, describe, expect, it, vi } from 'vitest'
import { analyzeSvg, fixSvg, getProfile } from './api'
import type { FixAction } from './types'

describe('API client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends the SVG and all review selections as multipart fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ report_version: '1.2' }) })
    vi.stubGlobal('fetch', fetchMock)
    const file = new File(['<svg/>'], 'part.svg', { type: 'image/svg+xml' })

    await analyzeSvg(file, { assignmentId: 'intro-svg', materialId: 'cast-acrylic', thicknessMm: 6 })

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/v1/analyze')
    expect(options.method).toBe('POST')
    const body = options.body as FormData
    expect((body.get('file') as File).name).toBe(file.name)
    expect(body.get('assignment_id')).toBe('intro-svg')
    expect(body.get('material_id')).toBe('cast-acrylic')
    expect(body.get('thickness_mm')).toBe('6')
    expect((options.headers as Record<string, string>)['Content-Type']).toBeUndefined()
  })

  it('surfaces a useful profile service error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ detail: 'Profile is unavailable.' }),
    }))
    await expect(getProfile()).rejects.toThrow('Profile is unavailable.')
  })

  it('requests a corrected SVG with the assignment and source fingerprint', async () => {
    const corrected = new Blob(['<svg data-corrected="true"/>'], { type: 'image/svg+xml' })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => corrected })
    vi.stubGlobal('fetch', fetchMock)
    const file = new File(['<svg/>'], 'part.svg', { type: 'image/svg+xml' })

    const action: FixAction = {
      id: 'normalize-cut-strokes',
      kind: 'normalize_cut_strokes',
      endpoint: 'https://attacker.example/steal',
      label: 'Fix cut strokes',
      description: 'Normalize intended cut strokes.',
      object_ids: ['cut-1'],
      count: 1,
      target_color: '#000000',
      target_stroke_width_in: 0.001,
    }
    await expect(fixSvg(file, action, {
      assignmentId: 'intro-svg',
      expectedSha256: 'a'.repeat(64),
    })).resolves.toBe(corrected)

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/v1/fix-strokes')
    expect(options.method).toBe('POST')
    expect((options.headers as Record<string, string>).Accept).toBe('image/svg+xml')
    const body = options.body as FormData
    expect((body.get('file') as File).name).toBe('part.svg')
    expect(body.get('assignment_id')).toBe('intro-svg')
    expect(body.get('expected_sha256')).toBe('a'.repeat(64))
  })

  it('dispatches an artboard fix only to its allowlisted same-origin endpoint', async () => {
    const corrected = new Blob(['<svg width="12in" height="12in"/>'], { type: 'image/svg+xml' })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => corrected })
    vi.stubGlobal('fetch', fetchMock)
    const action: FixAction = {
      id: 'set-artboard',
      kind: 'set_artboard',
      endpoint: '//attacker.example/steal',
      label: 'Fix artboard',
      description: 'Set page size.',
      object_ids: [],
      count: 1,
      target_width_in: 12,
      target_height_in: 12,
    }

    await fixSvg(new File(['<svg/>'], 'part.svg'), action, {
      assignmentId: 'intro-svg',
      expectedSha256: 'b'.repeat(64),
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/fix-artboard', expect.objectContaining({ method: 'POST' }))
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('attacker.example'), expect.anything())
  })

  it.each(['open_redirect', 'constructor', 'toString', '__proto__'])(
    'rejects the runtime correction kind %s without making a request',
    async (kind) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const unsupported = { kind, endpoint: 'https://attacker.example' } as unknown as FixAction

    await expect(fixSvg(new File(['<svg/>'], 'part.svg'), unsupported, {
      assignmentId: 'intro-svg',
      expectedSha256: 'c'.repeat(64),
    })).rejects.toThrow('not supported')
    expect(fetchMock).not.toHaveBeenCalled()
    },
  )
})
