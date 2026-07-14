import { afterEach, describe, expect, it, vi } from 'vitest'
import { analyzeSvg, getProfile } from './api'

describe('API client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends the SVG and all review selections as multipart fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ report_version: '1.0' }) })
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
})
