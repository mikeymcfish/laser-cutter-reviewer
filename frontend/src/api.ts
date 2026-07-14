import type { AnalysisReport, AnalyzeSelection, ProfileResponse } from './types'

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

export const sha256File = async (file: File): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}
