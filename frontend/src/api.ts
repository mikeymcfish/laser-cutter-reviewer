import type { AnalysisReport, AnalyzeSelection, FixAction, FixSelection, ProfileResponse } from './types'

const errorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as { detail?: string | Array<{ msg?: string }>; message?: string }
    if (typeof payload.detail === 'string') return payload.detail
    if (Array.isArray(payload.detail)) return payload.detail.map((item) => item.msg).filter(Boolean).join('. ')
    if (payload.message) return payload.message
  } catch {
    // The service may return an empty or plain-text error response.
  }
  if (response.status === 413) return "This file is larger than the lab's configured upload limit."
  if (response.status === 422) return 'The file or review choices could not be validated.'
  return `The review service returned an error (${response.status}).`
}

export class ApiError extends Error {
  status: number

  constructor(message: string, status = 0) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export const getProfile = async (signal?: AbortSignal): Promise<ProfileResponse> => {
  let response: Response
  try {
    response = await fetch('/api/v1/profile', { signal, headers: { Accept: 'application/json' } })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError('The reviewer could not connect to the local analysis service.')
  }
  if (!response.ok) throw new ApiError(await errorMessage(response), response.status)
  return (await response.json()) as ProfileResponse
}

export const analyzeSvg = async (
  file: File,
  selection: AnalyzeSelection,
  signal?: AbortSignal,
): Promise<AnalysisReport> => {
  const body = new FormData()
  body.append('file', file, file.name)
  body.append('assignment_id', selection.assignmentId)
  body.append('material_id', selection.materialId)
  body.append('thickness_mm', String(selection.thicknessMm))

  let response: Response
  try {
    response = await fetch('/api/v1/analyze', { method: 'POST', body, signal, headers: { Accept: 'application/json' } })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError('The analysis service could not be reached. Check that it is running, then try again.')
  }
  if (!response.ok) throw new ApiError(await errorMessage(response), response.status)
  return (await response.json()) as AnalysisReport
}

const fixEndpoint = (kind: unknown): string | null => {
  if (kind === 'normalize_cut_strokes') return '/api/v1/fix-strokes'
  if (kind === 'set_artboard') return '/api/v1/fix-artboard'
  return null
}

export const fixSvg = async (
  file: File,
  action: FixAction,
  selection: FixSelection,
  signal?: AbortSignal,
): Promise<Blob> => {
  // Dispatch from the known action kind. Never request a URL supplied in report JSON.
  const endpoint = fixEndpoint(action.kind)
  if (!endpoint) throw new ApiError('This correction action is not supported by this version of the reviewer.')

  const body = new FormData()
  body.append('file', file, file.name)
  body.append('assignment_id', selection.assignmentId)
  body.append('expected_sha256', selection.expectedSha256)

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      body,
      signal,
      headers: { Accept: 'image/svg+xml' },
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError('The corrected SVG service could not be reached. Try again, or make the changes in Illustrator.')
  }
  if (!response.ok) throw new ApiError(await errorMessage(response), response.status)
  const corrected = await response.blob()
  const contentType = response.headers?.get('content-type') ?? corrected.type
  if (contentType && !contentType.toLowerCase().startsWith('image/svg+xml')) {
    throw new ApiError('The correction service did not return an SVG. The original file and review were kept.', response.status)
  }
  const originalHash = response.headers?.get('x-original-sha256')?.toLowerCase()
  if (originalHash && originalHash !== selection.expectedSha256.toLowerCase()) {
    throw new ApiError('The correction response did not match the selected source file. The original file and review were kept.', response.status)
  }
  return corrected
}

export const sha256File = async (file: File): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}
