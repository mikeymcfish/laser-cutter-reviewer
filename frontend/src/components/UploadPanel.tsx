import { useId, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import type { Assignment, Material } from '../types'
import { displayName, materialThicknesses } from '../types'
import { formatDimensionsInches } from '../units'
import { FileIcon, UploadIcon } from './Icons'

interface UploadPanelProps {
  assignments: Assignment[]
  materials: Material[]
  assignmentId: string
  materialId: string
  thicknessMm: number
  file: File | null
  fileHash?: string
  maxUploadBytes: number
  busy: boolean
  onAssignmentChange: (id: string) => void
  onMaterialChange: (id: string) => void
  onThicknessChange: (value: number) => void
  onFileChange: (file: File | null) => void
  onAnalyze: () => void
}

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function UploadPanel({
  assignments,
  materials,
  assignmentId,
  materialId,
  thicknessMm,
  file,
  fileHash,
  maxUploadBytes,
  busy,
  onAssignmentChange,
  onMaterialChange,
  onThicknessChange,
  onFileChange,
  onAnalyze,
}: UploadPanelProps) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const assignment = assignments.find((item) => item.id === assignmentId)
  const material = materials.find((item) => item.id === materialId)
  const thicknesses = materialThicknesses(material)
  const exactArtboard = assignment?.page_policy === 'exact'
    && assignment.expected_width_mm != null
    && assignment.expected_height_mm != null

  const acceptFile = (candidate?: File) => {
    setDragging(false)
    if (busy) return
    if (candidate) onFileChange(candidate)
  }

  const onInput = (event: ChangeEvent<HTMLInputElement>) => acceptFile(event.target.files?.[0])
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (busy) return
    acceptFile(event.dataTransfer.files?.[0])
  }

  return (
    <section className="setup-card" aria-labelledby="setup-title">
      <div className="section-heading">
        <span className="eyebrow">Project setup</span>
        <h2 id="setup-title">Tell us what you’re making</h2>
        <p>The material and assignment help us apply the right classroom rules.</p>
      </div>

      <div className="form-grid">
        <label className="field">
          <span>Assignment</span>
          <select value={assignmentId} onChange={(event) => onAssignmentChange(event.target.value)} disabled={busy}>
            {assignments.map((assignment) => (
              <option key={assignment.id} value={assignment.id}>
                {displayName(assignment)}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Material</span>
          <select value={materialId} onChange={(event) => onMaterialChange(event.target.value)} disabled={busy}>
            {materials.map((item) => (
              <option key={item.id} value={item.id}>
                {displayName(item)}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Thickness</span>
          <select
            value={Number.isFinite(thicknessMm) ? String(thicknessMm) : ''}
            onChange={(event) => onThicknessChange(Number(event.target.value))}
            disabled={busy || thicknesses.length === 0}
          >
            {thicknesses.length === 0 ? <option value="">No options</option> : null}
            {thicknesses.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {assignment?.description || exactArtboard ? (
        <div className="assignment-note" aria-live="polite">
          <div>
            <strong>{exactArtboard ? `Required artboard: ${formatDimensionsInches(assignment.expected_width_mm, assignment.expected_height_mm)}` : 'Assignment note'}</strong>
            {assignment.description ? <span>{assignment.description}</span> : null}
          </div>
        </div>
      ) : null}

      <div
        className={`drop-zone${dragging ? ' is-dragging' : ''}${file ? ' has-file' : ''}`}
        onDragEnter={(event) => {
          event.preventDefault()
          if (!busy) setDragging(true)
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false)
        }}
        onDrop={onDrop}
        onClick={() => {
          if (!busy) inputRef.current?.click()
        }}
        onKeyDown={(event) => {
          if (!busy && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
            inputRef.current?.click()
          }
        }}
        role="button"
        tabIndex={busy ? -1 : 0}
        aria-disabled={busy}
        aria-label={file ? `Selected file ${file.name}. Choose a different SVG` : 'Choose or drop an SVG file'}
      >
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept=".svg,image/svg+xml"
          onChange={onInput}
          disabled={busy}
          tabIndex={-1}
        />
        {file ? (
          <>
            <span className="drop-icon file-selected"><FileIcon size={25} /></span>
            <div className="drop-copy">
              <strong>{file.name}</strong>
              <span>
                {formatBytes(file.size)} · {fileHash ? `${fileHash.slice(0, 10)}…` : 'Calculating fingerprint…'}
              </span>
            </div>
            <span className="text-link">Change file</span>
          </>
        ) : (
          <>
            <span className="drop-icon"><UploadIcon size={25} /></span>
            <div className="drop-copy">
              <strong>Drop your Illustrator SVG here</strong>
              <span>or click to browse · SVG only · {Number.isFinite(maxUploadBytes) ? `${formatBytes(maxUploadBytes)} maximum` : 'lab upload limit applies'}</span>
            </div>
          </>
        )}
      </div>

      <button
        type="button"
        className="primary-button analyze-button"
        disabled={!file || busy || !assignmentId || !materialId || !Number.isFinite(thicknessMm)}
        onClick={onAnalyze}
      >
        {busy ? <span className="button-spinner" aria-hidden="true" /> : <UploadIcon size={18} />}
        {busy ? 'Reviewing your file…' : 'Review my file'}
      </button>
    </section>
  )
}
