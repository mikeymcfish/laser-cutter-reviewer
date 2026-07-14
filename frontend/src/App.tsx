import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { analyzeSvg, fixSvg, getProfile, sha256File } from './api'
import { Checklist } from './components/Checklist'
import { CubeIcon, DownloadIcon, InfoIcon, ResetIcon, SparkIcon, WarningIcon } from './components/Icons'
import { Preview2D } from './components/Preview2D'
import { UploadPanel } from './components/UploadPanel'
import type { AnalysisCheck, AnalysisReport, CheckStatus, FixAction, Material, PreviewWeakPoint, ProfileResponse } from './types'
import { checkKey, checkStatus, displayName, materialThicknesses } from './types'
import { formatDimensionsInches, formatInches, formatSquareInches } from './units'

const defaultOperatorChecks = [
  'Material is instructor-approved and its SDS has been reviewed.',
  'Power, speed, and frequency settings match the approved material chart.',
  'Focus and job origin have been checked at the machine.',
  'Exhaust and Air Assist are on and working.',
  'Material placement is flat, secure, and within the usable bed area.',
  'A trained operator will supervise the entire job.',
]

type ViewMode = '2d' | '3d'

const Preview3D = lazy(() => import('./components/Preview3D').then((module) => ({ default: module.Preview3D })))

const asOperatorLabels = (profile: ProfileResponse | null) => {
  const values = profile?.operator_checklist ?? []
  const labels = values
    .map((item) => (typeof item === 'string' ? item : item.label ?? item.text ?? ''))
    .filter(Boolean)
  return labels.length ? labels : defaultOperatorChecks
}

const countChecks = (checks: AnalysisCheck[]) => {
  const counts: Record<CheckStatus, number> = { blocker: 0, warning: 0, pass: 0, info: 0, unverified: 0 }
  checks.forEach((check) => counts[checkStatus(check)]++)
  return counts
}

const fileName = (report: AnalysisReport) => report.file.name ?? report.file.filename ?? 'SVG file'

const correctedFileName = (name: string, action: FixAction) => {
  const stem = name.replace(/\.svg$/i, '').replace(/[^a-z0-9._-]+/gi, '-') || 'laser-file'
  const suffix = action.kind === 'set_artboard' ? 'artboard-fixed' : 'cut-strokes-fixed'
  if (stem.toLowerCase().endsWith(`-${suffix}`)) return `${stem}.svg`
  return `${stem}-${suffix}.svg`
}

const metricValue = (value: unknown, suffix = '') => {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'number') return `${Number.isInteger(value) ? value : value.toFixed(2)}${suffix}`
  return `${String(value)}${suffix}`
}

const weakPointEvidence = (point: PreviewWeakPoint) => (
  point.unit === 'mm2'
    ? `${formatSquareInches(point.measurement)} area · guideline ${formatSquareInches(point.threshold)}`
    : `${formatInches(point.measurement, 4)} · guideline ${formatInches(point.threshold, 4)}`
)

const fileSizeLabel = (bytes: number) => {
  if (!Number.isFinite(bytes)) return 'the configured limit'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) {
    const kilobytes = bytes / 1024
    return `${Number.isInteger(kilobytes) ? kilobytes : kilobytes.toFixed(1)} KB`
  }
  const megabytes = bytes / 1024 / 1024
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`
}

export default function App() {
  const [profileData, setProfileData] = useState<ProfileResponse | null>(null)
  const [profileLoading, setProfileLoading] = useState(true)
  const [profileError, setProfileError] = useState('')
  const [assignmentId, setAssignmentId] = useState('')
  const [materialId, setMaterialId] = useState('')
  const [thicknessMm, setThicknessMm] = useState(Number.NaN)
  const [file, setFile] = useState<File | null>(null)
  const [fileHash, setFileHash] = useState('')
  const [fileError, setFileError] = useState('')
  const [busy, setBusy] = useState(false)
  const [analysisError, setAnalysisError] = useState('')
  const [report, setReport] = useState<AnalysisReport | null>(null)
  const [selectedCheck, setSelectedCheck] = useState<AnalysisCheck | undefined>()
  const [viewMode, setViewMode] = useState<ViewMode>('2d')
  const [showWeakPoints, setShowWeakPoints] = useState(false)
  const [manualState, setManualState] = useState<Record<number, boolean>>({})
  const [fixingActionId, setFixingActionId] = useState<string | null>(null)
  const [fixError, setFixError] = useState('')
  const [fixMessage, setFixMessage] = useState('')
  const fileSelectionToken = useRef(0)
  const fixOperationToken = useRef(0)
  const fixInFlight = useRef(false)
  const currentReviewContext = useRef({ file, assignmentId, materialId, thicknessMm })
  currentReviewContext.current = { file, assignmentId, materialId, thicknessMm }

  const loadProfile = () => {
    setProfileLoading(true)
    setProfileError('')
    const controller = new AbortController()
    getProfile(controller.signal)
      .then((payload) => {
        setProfileData(payload)
        const firstAssignment = payload.assignments?.[0]
        const firstMaterial = payload.materials?.[0]
        setAssignmentId((current) => current || firstAssignment?.id || '')
        setMaterialId((current) => current || firstMaterial?.id || '')
        const firstThickness = materialThicknesses(firstMaterial)[0]?.value
        setThicknessMm((current) => (Number.isFinite(current) ? current : (firstThickness ?? Number.NaN)))
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setProfileError(error instanceof Error ? error.message : 'The lab profile could not be loaded.')
      })
      .finally(() => setProfileLoading(false))
    return controller
  }

  useEffect(() => {
    const controller = loadProfile()
    return () => controller.abort()
  }, [])

  const selectedMaterial = profileData?.materials.find((item) => item.id === materialId)
  const selectedAssignment = profileData?.assignments.find((item) => item.id === assignmentId)
  const manualLabels = useMemo(() => asOperatorLabels(profileData), [profileData])
  const maxUploadBytes = profileData?.limits?.max_upload_bytes ?? Number.POSITIVE_INFINITY
  const correctionBusy = fixingActionId !== null

  const onMaterialChange = (id: string) => {
    fixOperationToken.current += 1
    setMaterialId(id)
    const next = profileData?.materials.find((item) => item.id === id)
    setThicknessMm(materialThicknesses(next)[0]?.value ?? Number.NaN)
    clearResult()
  }

  const onAssignmentChange = (id: string) => {
    fixOperationToken.current += 1
    setAssignmentId(id)
    clearResult()
  }

  const onThicknessChange = (value: number) => {
    fixOperationToken.current += 1
    setThicknessMm(value)
    clearResult()
  }

  const clearResult = () => {
    setReport(null)
    setSelectedCheck(undefined)
    setAnalysisError('')
    setManualState({})
    setViewMode('2d')
    setShowWeakPoints(false)
    setFixingActionId(null)
    setFixError('')
    setFixMessage('')
  }

  const onFileChange = async (candidate: File | null) => {
    fixOperationToken.current += 1
    const selectionToken = ++fileSelectionToken.current
    setFileError('')
    setFileHash('')
    clearResult()
    if (!candidate) {
      setFile(null)
      return
    }
    if (candidate.size > maxUploadBytes) {
      setFile(null)
      setFileError(`That file is larger than ${fileSizeLabel(maxUploadBytes)}. Simplify the SVG or remove large embedded images, then try again.`)
      return
    }
    if (!candidate.name.toLowerCase().endsWith('.svg')) {
      setFile(null)
      setFileError('Choose an SVG exported from Adobe Illustrator. PDF, AI, and DXF files are not supported yet.')
      return
    }
    setFile(candidate)
    try {
      const hash = await sha256File(candidate)
      if (fileSelectionToken.current === selectionToken) setFileHash(hash)
    } catch {
      if (fileSelectionToken.current === selectionToken) {
        setFileError('This browser could not calculate a secure file fingerprint.')
        setFile(null)
      }
    }
  }

  const onAnalyze = async () => {
    if (!file || !assignmentId || !materialId || !Number.isFinite(thicknessMm)) return
    setBusy(true)
    setAnalysisError('')
    setReport(null)
    setSelectedCheck(undefined)
    try {
      const [result, localHash] = await Promise.all([
        analyzeSvg(file, { assignmentId, materialId, thicknessMm }),
        fileHash ? Promise.resolve(fileHash) : sha256File(file),
      ])
      const serviceHash = result.file.sha256?.toLowerCase()
      if (serviceHash && serviceHash !== localHash.toLowerCase()) {
        throw new Error('The analysis fingerprint did not match the selected file. Please choose the file again and retry.')
      }
      setFileHash(localHash)
      setReport(result)
      setManualState({})
      setViewMode('2d')
      setShowWeakPoints(false)
      window.requestAnimationFrame(() => document.getElementById('review-results')?.focus())
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setAnalysisError(error instanceof Error ? error.message : 'The SVG could not be reviewed.')
    } finally {
      setBusy(false)
    }
  }

  const counts = report ? countChecks(report.checks) : null
  const weakPoints = report?.geometry.weak_points?.points ?? []
  const weakPointStatus = report?.geometry.weak_points?.status ?? 'complete'
  const weakPointMessage = report?.geometry.weak_points?.message
  const demoProfile = Boolean(report?.profile.demo ?? profileData?.profile.demo)
  const hasBlockers = Boolean(counts && counts.blocker > 0)
  const reportReady = Boolean(
    report
      && !demoProfile
      && counts?.blocker === 0
      && (report.summary.status ? report.summary.status === 'ready' : report.summary.ready !== false),
  )
  const materialType = String(report?.selection.material_type ?? selectedMaterial?.type ?? selectedMaterial?.family ?? 'wood')
  const kerfMm = Number(report?.selection.kerf_mm ?? selectedMaterial?.kerf_mm ?? 0.15)
  const reportThickness = Number(report?.selection.thickness_mm ?? thicknessMm ?? 3)
  const machineLabel = profileData?.machine?.label ?? profileData?.machine?.name ?? profileData?.profile.machine_label ?? 'Epilog laser cutter'

  const reset = () => {
    fileSelectionToken.current += 1
    fixOperationToken.current += 1
    setFile(null)
    setFileHash('')
    setFileError('')
    clearResult()
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const onDownloadReport = async () => {
    if (!report) return
    const { downloadReport } = await import('./report')
    const printableReport: AnalysisReport = {
      ...report,
      selection: {
        ...report.selection,
        assignment_label: selectedAssignment ? displayName(selectedAssignment) : report.selection.assignment_id,
        material_label: selectedMaterial ? displayName(selectedMaterial) : report.selection.material_id,
        material_type: selectedMaterial?.family ?? selectedMaterial?.type,
        kerf_mm: kerfMm,
      },
    }
    await downloadReport(
      printableReport,
      fileHash,
      manualLabels.map((label, index) => ({ label, checked: Boolean(manualState[index]) })),
      reportReady,
    )
  }

  const onSelectCheck = (check: AnalysisCheck) => {
    setSelectedCheck(check)
    if (check.rule_id === 'material.fragility' && weakPoints.length > 0) setShowWeakPoints(true)
  }

  const onFixAction = async (action: FixAction) => {
    if (fixInFlight.current || !file || !report || !assignmentId || !materialId || !Number.isFinite(thicknessMm)) return
    const sourceFile = file
    const sourceAssignmentId = assignmentId
    const sourceMaterialId = materialId
    const sourceThicknessMm = thicknessMm
    const operationToken = ++fixOperationToken.current
    const contextIsCurrent = () => {
      const current = currentReviewContext.current
      return fixOperationToken.current === operationToken
        && current.file === sourceFile
        && current.assignmentId === sourceAssignmentId
        && current.materialId === sourceMaterialId
        && current.thicknessMm === sourceThicknessMm
    }
    const expectedSha256 = (report.file.sha256 || fileHash).toLowerCase()
    if (!expectedSha256) {
      setFixError('The source fingerprint is unavailable. Choose the SVG again before requesting a corrected copy.')
      return
    }
    fixInFlight.current = true
    setFixingActionId(action.id)
    setFixError('')
    setFixMessage('')
    try {
      const corrected = await fixSvg(sourceFile, action, { assignmentId: sourceAssignmentId, expectedSha256 })
      if (!contextIsCurrent()) return
      if (!corrected.size) throw new Error('The correction service returned an empty file. Make the changes in Illustrator instead.')
      if (corrected.size > maxUploadBytes) throw new Error('The corrected SVG is larger than the lab upload limit. Make the change in Illustrator instead.')

      const nextName = correctedFileName(sourceFile.name, action)
      const correctedFile = new File([corrected], nextName, {
        type: 'image/svg+xml',
        lastModified: Date.now(),
      })
      const url = URL.createObjectURL(correctedFile)
      try {
        const link = document.createElement('a')
        link.href = url
        link.download = nextName
        document.body.appendChild(link)
        link.click()
        link.remove()
      } finally {
        URL.revokeObjectURL(url)
      }

      const correctedHash = await sha256File(correctedFile)
      if (!contextIsCurrent()) return
      const refreshedReport = await analyzeSvg(correctedFile, {
        assignmentId: sourceAssignmentId,
        materialId: sourceMaterialId,
        thicknessMm: sourceThicknessMm,
      })
      if (!contextIsCurrent()) return
      const serviceHash = refreshedReport.file.sha256?.toLowerCase()
      if (serviceHash && serviceHash !== correctedHash.toLowerCase()) {
        throw new Error('The refreshed review fingerprint did not match the corrected copy. The previous review is still shown; choose the downloaded SVG to try again.')
      }

      fileSelectionToken.current += 1
      setFile(correctedFile)
      setFileHash(correctedHash)
      setReport(refreshedReport)
      setSelectedCheck(undefined)
      setManualState({})
      setViewMode('2d')
      setShowWeakPoints(false)
      setAnalysisError('')
      const changeLabel = action.kind === 'set_artboard' ? 'Artboard fixed' : 'Through-cut strokes fixed'
      setFixMessage(`${changeLabel}. ${nextName} was downloaded and the corrected copy is now shown in the preview.`)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (contextIsCurrent()) {
        const message = error instanceof Error ? error.message : 'The corrected SVG could not be prepared and reviewed.'
        setFixError(`${message} The previous file and review are still shown.`)
      }
    } finally {
      fixInFlight.current = false
      if (fixOperationToken.current === operationToken) setFixingActionId(null)
    }
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="#main-content" aria-label="Laser Ready home">
          <span className="brand-mark" aria-hidden="true"><SparkIcon size={21} /></span>
          <span><b>Laser</b> Ready</span>
        </a>
        <div className="machine-chip" title="Current lab machine">
          <span className="machine-dot" />
          {machineLabel}
        </div>
      </header>

      <main id="main-content">
        <section className="hero">
          <div className="hero-copy">
            <span className="hero-kicker"><SparkIcon size={15} /> SVG preflight for students</span>
            <h1>Know your file is ready<br />before it reaches the laser.</h1>
            <p>Upload an Illustrator SVG for a clear, visual check of cut lines, geometry, images, type, and fragile details.</p>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="material-card card-back"><span /></div>
            <div className="material-card card-front">
              <svg viewBox="0 0 180 120">
                <path d="M36 82 57 41h29l15 22 17-30h29l17 49Z" />
                <circle cx="69" cy="68" r="10" />
                <path d="M122 52v31M107 68h30" className="engrave" />
              </svg>
            </div>
            <span className="laser-line" />
            <span className="laser-glow" />
          </div>
        </section>

        {profileLoading ? (
          <section className="setup-card loading-card" aria-live="polite">
            <span className="large-spinner" aria-hidden="true" />
            <div><strong>Loading the lab profile…</strong><p>Getting assignments, materials, and machine rules.</p></div>
          </section>
        ) : profileError ? (
          <section className="error-card" role="alert">
            <WarningIcon size={24} />
            <div><strong>The reviewer is not available yet.</strong><p>{profileError}</p></div>
            <button type="button" className="secondary-button" onClick={loadProfile}>Try again</button>
          </section>
        ) : profileData ? (
          <UploadPanel
            assignments={profileData.assignments}
            materials={profileData.materials}
            assignmentId={assignmentId}
            materialId={materialId}
            thicknessMm={thicknessMm}
            file={file}
            fileHash={fileHash}
            maxUploadBytes={maxUploadBytes}
            busy={busy || correctionBusy}
            onAssignmentChange={onAssignmentChange}
            onMaterialChange={onMaterialChange}
            onThicknessChange={onThicknessChange}
            onFileChange={onFileChange}
            onAnalyze={onAnalyze}
          />
        ) : null}

        {fileError || analysisError ? (
          <div className="inline-error" role="alert">
            <WarningIcon size={20} />
            <div><strong>We couldn’t review that file.</strong><span>{fileError || analysisError}</span></div>
          </div>
        ) : null}

        {report && counts ? (
          <section className="results" id="review-results" tabIndex={-1} aria-label="File review results" aria-busy={correctionBusy}>
            <div className={`readiness-banner ${reportReady ? 'is-ready' : hasBlockers ? 'needs-work' : demoProfile ? 'is-demo' : 'needs-work'}`}>
              <span className="readiness-icon" aria-hidden="true">
                {reportReady ? <SparkIcon size={27} /> : <WarningIcon size={27} />}
              </span>
              <div className="readiness-copy">
                <span className="eyebrow">Review complete</span>
                <h2>
                  {reportReady
                    ? 'Ready for teacher review'
                    : hasBlockers
                      ? `${counts.blocker} ${counts.blocker === 1 ? 'blocker' : 'blockers'} to fix`
                      : demoProfile
                        ? 'Review complete — teacher setup required'
                        : 'Teacher review is still required'}
                </h2>
                <p>
                  {hasBlockers
                    ? `${report.summary.headline ?? report.summary.label ?? 'Fix the blockers below, export a fresh SVG, and review it again.'}${demoProfile ? ' This installation also uses demonstration machine values.' : ''}`
                    : reportReady
                      ? 'The automated checks passed. Download your report and ask your teacher to complete the machine checks.'
                      : demoProfile
                        ? 'This reviewer is using demonstration machine values. Your teacher must configure the real lab profile before any file can be marked ready.'
                        : report.summary.headline ?? report.summary.label ?? 'Teacher review is still required.'}
                </p>
              </div>
              <div className="readiness-counts" aria-label="Result counts">
                <span className="count-blocker"><b>{counts.blocker}</b> blockers</span>
                <span className="count-warning"><b>{counts.warning}</b> warnings</span>
                <span className="count-pass"><b>{counts.pass}</b> passed</span>
              </div>
            </div>

            <div className="result-toolbar">
              <div>
                <strong>{fileName(report)}</strong>
                <span>{formatDimensionsInches(report.geometry.page.width_mm, report.geometry.page.height_mm)} · {displayName(selectedAssignment ?? { id: assignmentId })}</span>
              </div>
              <div className="toolbar-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void onDownloadReport()}
                  disabled={correctionBusy}
                >
                  <DownloadIcon size={17} /> Download PDF report
                </button>
                <button type="button" className="icon-button" onClick={reset} disabled={correctionBusy} title="Review another file" aria-label="Review another file">
                  <ResetIcon size={18} />
                </button>
              </div>
            </div>

            <div className="fix-live" aria-live="polite" aria-atomic="true">
              {fixMessage ? <div className="fix-success" role="status"><SparkIcon size={17} /><span>{fixMessage}</span></div> : null}
              {fixError ? <div className="fix-error" role="alert"><WarningIcon size={17} /><span>{fixError}</span></div> : null}
            </div>

            <div className="review-layout">
              <div className="preview-column">
                <section className="preview-panel" aria-labelledby="preview-title">
                  <div className="panel-heading preview-heading">
                    <div>
                      <span className="eyebrow">Visual inspection</span>
                      <h2 id="preview-title">Your file</h2>
                    </div>
                    <div className="view-toggle" aria-label="Preview and overlay controls">
                      <button type="button" className={viewMode === '2d' ? 'is-active' : ''} aria-pressed={viewMode === '2d'} onClick={() => setViewMode('2d')}>2D paths</button>
                      <button
                        type="button"
                        className={showWeakPoints ? 'is-active weak-view-button' : 'weak-view-button'}
                        aria-pressed={showWeakPoints}
                        onClick={() => setShowWeakPoints((current) => !current)}
                        disabled={weakPoints.length === 0}
                        title={
                          weakPoints.length
                            ? `Show ${weakPoints.length} material-dependent weak-point estimate${weakPoints.length === 1 ? '' : 's'}`
                            : weakPointStatus === 'partial' || weakPointStatus === 'unavailable'
                              ? weakPointMessage || 'Weak-point locations could not be fully verified.'
                              : 'No localized weak points fall below the selected material guidelines.'
                        }
                      ><WarningIcon size={14} /> Weak points{weakPoints.length ? ` (${weakPoints.length})` : ''}</button>
                      <button
                        type="button"
                        className={viewMode === '3d' ? 'is-active' : ''}
                        aria-pressed={viewMode === '3d'}
                        onClick={() => setViewMode('3d')}
                        disabled={!report.geometry.valid_3d}
                        title={!report.geometry.valid_3d ? report.geometry.invalid_reason ?? '3D needs valid closed geometry' : 'Show material preview'}
                      ><CubeIcon size={15} /> 3D material</button>
                    </div>
                  </div>
                  {viewMode === '3d' ? (
                    <Suspense fallback={<div className="preview-unavailable"><p>Preparing the 3D material preview…</p></div>}>
                      <Preview3D
                        geometry={report.geometry}
                        materialType={materialType}
                        thicknessMm={reportThickness}
                        kerfMm={kerfMm}
                        previewAppearance={selectedMaterial?.preview}
                        showWeakPoints={showWeakPoints}
                      />
                    </Suspense>
                  ) : <Preview2D geometry={report.geometry} selectedCheck={selectedCheck} showWeakPoints={showWeakPoints} />}
                  {showWeakPoints && weakPoints.length ? (
                    <div className="weak-point-summary" role="status">
                      <div><WarningIcon size={16} /><span><b>Potential weak points</b>{weakPointMessage}</span></div>
                      <ol>
                        {weakPoints.slice(0, 8).map((point, index) => (
                          <li key={point.id}>
                            <i style={{ background: point.kind === 'tiny_piece' ? '#8b4ac7' : point.kind === 'close_cut_spacing' ? '#db7a16' : '#d44d38' }}>{index + 1}</i>
                            <span><b>{point.label}</b>{weakPointEvidence(point)}</span>
                          </li>
                        ))}
                      </ol>
                      {weakPoints.length > 8 ? <p>Showing measurements for 8 of {weakPoints.length} markers. The viewer displays all returned locations.</p> : null}
                      <p>Marker numbers match the 2D view; localized markers remain visible in both views.</p>
                    </div>
                  ) : null}
                  {!report.geometry.valid_3d ? (
                    <div className="three-disabled-note"><InfoIcon size={16} /><span><b>3D preview unavailable:</b> {report.geometry.invalid_reason || 'Fix invalid cut topology first.'}</span></div>
                  ) : null}
                  {report.geometry.weak_points && weakPointStatus !== 'complete' ? (
                    <div className="three-disabled-note"><WarningIcon size={16} /><span><b>Weak-point scan {weakPointStatus}:</b> {weakPointMessage}</span></div>
                  ) : null}
                  <p className="preview-disclaimer">Preview is approximate. Embedded images are sanitized and shown as multiply layers; weak-point markers are material-guideline estimates, not strength predictions. Keep vs. scrap, assembly, and charring cannot be inferred.</p>
                </section>

                <section className="metrics-panel" aria-labelledby="metrics-title">
                  <div className="panel-heading compact">
                    <div><span className="eyebrow">File facts</span><h2 id="metrics-title">At a glance</h2></div>
                  </div>
                  <dl className="metric-grid">
                    <div><dt>Document</dt><dd>{formatDimensionsInches(report.document.width_mm ?? report.geometry.page.width_mm, report.document.height_mm ?? report.geometry.page.height_mm)}</dd></div>
                    <div><dt>Display / source scale</dt><dd>Inches · {String(report.document.unit_confidence ?? 'unverified')}</dd></div>
                    <div><dt>Objects</dt><dd>{metricValue(report.metrics.object_count ?? report.geometry.paths.length)}</dd></div>
                    <div><dt>Cut length</dt><dd>{formatInches(report.metrics.total_cut_length_mm, 2)}</dd></div>
                    <div><dt>Raster images</dt><dd>{metricValue(report.metrics.image_count ?? 0)}</dd></div>
                    <div><dt>Weak points</dt><dd>{weakPoints.length ? `${weakPoints.length} flagged · ${formatInches(report.metrics.minimum_feature_mm ?? report.metrics.smallest_estimated_feature_mm)} minimum` : weakPointStatus === 'complete' ? `None flagged · ${formatInches(report.metrics.minimum_feature_mm ?? report.metrics.smallest_estimated_feature_mm)} minimum` : 'Not fully verified'}</dd></div>
                    <div><dt>Material</dt><dd>{report.selection.material_label ?? displayName(selectedMaterial ?? { id: materialId })}</dd></div>
                    <div><dt>Kerf estimate</dt><dd>{formatInches(kerfMm)}</dd></div>
                  </dl>
                </section>

                <section className="operator-panel" aria-labelledby="operator-title">
                  <div className="panel-heading compact">
                    <div><span className="eyebrow">At the machine</span><h2 id="operator-title">Teacher/operator checklist</h2></div>
                  </div>
                  <p>These conditions cannot be verified from an SVG. Complete them with a trained operator before cutting.</p>
                  <div className="manual-list">
                    {manualLabels.map((label, index) => (
                      <label key={label}>
                        <input
                          type="checkbox"
                          checked={Boolean(manualState[index])}
                          onChange={(event) => setManualState((current) => ({ ...current, [index]: event.target.checked }))}
                        />
                        <span className="custom-checkbox" aria-hidden="true" />
                        {label}
                      </label>
                    ))}
                  </div>
                </section>
              </div>

              <Checklist
                checks={report.checks}
                selectedId={selectedCheck ? checkKey(selectedCheck) : null}
                onSelect={onSelectCheck}
                onFixAction={onFixAction}
                fixingActionId={fixingActionId}
              />
            </div>
          </section>
        ) : null}

        <section className="safety-note">
          <InfoIcon size={21} />
          <div><strong>A preflight, not an operating permit.</strong><p>Laser Ready checks the file—not the actual material, machine setup, ventilation, focus, or supervision. Your instructor makes the final call.</p></div>
        </section>
      </main>

      <footer>
        <span><b>Laser Ready</b> · SVG preflight</span>
        <span>Files are analyzed in memory and are not retained.</span>
      </footer>
    </div>
  )
}
