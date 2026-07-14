import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { UploadPanel } from './UploadPanel'

const baseProps = {
  assignments: [{
    id: 'intro',
    name: 'Intro',
    description: 'Use the classroom square artboard.',
    page_policy: 'exact',
    expected_width_mm: 304.8,
    expected_height_mm: 304.8,
  }],
  materials: [{ id: 'wood', name: 'Wood', thicknesses_mm: [3] }],
  assignmentId: 'intro',
  materialId: 'wood',
  thicknessMm: 3,
  file: null,
  fileHash: '',
  maxUploadBytes: 1024,
  busy: false,
  onAssignmentChange: vi.fn(),
  onMaterialChange: vi.fn(),
  onThicknessChange: vi.fn(),
  onFileChange: vi.fn(),
  onAnalyze: vi.fn(),
}

describe('UploadPanel', () => {
  it('shows the upload ceiling supplied by the lab profile', () => {
    render(<UploadPanel {...baseProps} />)
    expect(screen.getByText(/1.0 KB maximum/)).toBeInTheDocument()
  })

  it('shows profile-driven artboard and thickness requirements in inches', () => {
    render(<UploadPanel {...baseProps} />)
    expect(screen.getByText('Required artboard: 12 × 12 in')).toBeInTheDocument()
    expect(screen.getByText('Use the classroom square artboard.')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '0.118 in' })).toBeInTheDocument()
  })

  it('does not replace the selected file by click or drop while analysis is busy', () => {
    const onFileChange = vi.fn()
    const selected = new File(['<svg/>'], 'selected.svg', { type: 'image/svg+xml' })
    render(<UploadPanel {...baseProps} file={selected} busy onFileChange={onFileChange} />)
    const dropZone = screen.getByRole('button', { name: /Selected file selected.svg/ })
    fireEvent.drop(dropZone, {
      dataTransfer: { files: [new File(['<svg/>'], 'replacement.svg', { type: 'image/svg+xml' })] },
    })
    fireEvent.click(dropZone)
    expect(onFileChange).not.toHaveBeenCalled()
    expect(screen.getByText('selected.svg')).toBeInTheDocument()
    expect(document.querySelector<HTMLInputElement>('input[type="file"]')).toBeDisabled()
  })
})
