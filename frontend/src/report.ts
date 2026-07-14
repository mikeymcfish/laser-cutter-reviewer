import { jsPDF } from 'jspdf'
import type { AnalysisCheck, AnalysisReport, CheckStatus } from './types'
import { checkStatus } from './types'

interface ManualCheck {
  label: string
  checked: boolean
}

const statusLabel: Record<CheckStatus, string> = {
  blocker: 'BLOCKER',
  warning: 'WARNING',
  pass: 'PASS',
  info: 'INFO',
  unverified: 'UNVERIFIED',
}

const pathColor = (operation?: string) => {
  const value = String(operation ?? '').toLowerCase()
  if (value.includes('engrave') || value.includes('raster')) return '#b26a56'
  if (value.includes('score')) return '#2a67b7'
  return '#171a1f'
}

const previewDataUrl = (report: AnalysisReport): string | null => {
  const canvas = document.createElement('canvas')
  canvas.width = 1000
  canvas.height = 620
  const context = canvas.getContext('2d')
  if (!context) return null
  const width = Number(report.geometry.page.width_mm ?? report.document.width_mm) || 1
  const height = Number(report.geometry.page.height_mm ?? report.document.height_mm) || 1
  const scale = Math.min(900 / Math.max(width, 1), 520 / Math.max(height, 1))
  const left = (canvas.width - width * scale) / 2
  const top = (canvas.height - height * scale) / 2
  context.fillStyle = '#eef0f3'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.shadowColor = 'rgba(20,30,50,.2)'
  context.shadowBlur = 18
  context.fillStyle = '#ffffff'
  context.fillRect(left, top, width * scale, height * scale)
  context.shadowColor = 'transparent'
  context.lineCap = 'round'
  context.lineJoin = 'round'
  report.geometry.paths.forEach((path) => {
    if (path.points.length < 2) return
    context.beginPath()
    context.moveTo(left + path.points[0][0] * scale, top + path.points[0][1] * scale)
    path.points.slice(1).forEach(([x, y]) => context.lineTo(left + x * scale, top + y * scale))
    if (path.closed) context.closePath()
    context.strokeStyle = pathColor(path.operation)
    context.lineWidth = Math.max(1.4, scale * 0.12)
    context.stroke()
  })
  return canvas.toDataURL('image/png')
}

const safeFilename = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'laser-file'

const reportNumber = (value: unknown, suffix = '') => {
  const number = Number(value)
  if (!Number.isFinite(number)) return 'Not reported'
  return `${Number.isInteger(number) ? number : number.toFixed(2)}${suffix}`
}

export const findingEvidenceText = (evidence: AnalysisCheck['evidence']): string => {
  if (typeof evidence === 'string' && evidence.trim()) return evidence.trim()
  if (Array.isArray(evidence) && evidence.length) return evidence.map(String).join(' · ')
  if (evidence && typeof evidence === 'object') {
    const values = Object.entries(evidence).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${String(value)}`)
    if (values.length) return values.join(' · ')
  }
  return 'No measured evidence was reported.'
}

export const reportFileFacts = (report: AnalysisReport): Array<{ label: string; value: string }> => {
  const width = report.document.width_mm ?? report.geometry.page.width_mm
  const height = report.document.height_mm ?? report.geometry.page.height_mm
  const dimensions = width != null && height != null
    ? `${reportNumber(width)} × ${reportNumber(height)} mm`
    : 'Physical size unresolved'
  const smallestFeature = report.metrics.minimum_feature_mm ?? report.metrics.smallest_estimated_feature_mm
  const operations = report.metrics.operation_inventory
  const operationSummary = operations && typeof operations === 'object'
    ? Object.entries(operations as Record<string, unknown>)
        .map(([name, count]) => `${name}: ${reportNumber(count)}`)
        .join(', ') || 'None reported'
    : 'None reported'
  const embeddedFamilies = Array.isArray(report.metrics.embedded_font_families)
    ? report.metrics.embedded_font_families.map(String).join(', ')
    : ''
  const fontSummary = `${reportNumber(report.metrics.live_text_count ?? 0)} live / ${reportNumber(report.metrics.embedded_font_count ?? 0)} embedded${embeddedFamilies ? ` (${embeddedFamilies})` : ''}`
  return [
    { label: 'Document', value: dimensions },
    { label: 'Units', value: `${report.document.units || 'Unknown'} (${report.document.unit_confidence || 'unverified'})` },
    { label: 'Objects', value: reportNumber(report.metrics.object_count) },
    { label: 'Vector paths', value: reportNumber(report.metrics.vector_path_count ?? report.geometry.paths.length) },
    { label: 'Operations', value: operationSummary },
    { label: 'Cut length', value: reportNumber(report.metrics.total_cut_length_mm, ' mm') },
    { label: 'Raster images', value: reportNumber(report.metrics.image_count ?? 0) },
    { label: 'Raster DPI', value: reportNumber(report.metrics.minimum_raster_dpi, ' DPI') },
    { label: 'Raster DPI guideline', value: reportNumber(report.metrics.required_raster_dpi, ' DPI') },
    { label: 'Fonts', value: fontSummary },
    { label: 'Smallest feature', value: reportNumber(smallestFeature, ' mm') },
    { label: 'Minimum cut spacing', value: reportNumber(report.metrics.minimum_cut_spacing_mm, ' mm') },
    { label: 'Cut density', value: reportNumber(report.metrics.cut_density_mm_per_mm2, ' mm/mm²') },
    { label: 'Heat-density guideline', value: reportNumber(report.metrics.heat_density_threshold_mm_per_mm2, ' mm/mm²') },
    { label: 'Kerf estimate', value: reportNumber(report.selection.kerf_mm ?? report.metrics.kerf_mm, ' mm') },
  ]
}

export const downloadReport = (
  report: AnalysisReport,
  fingerprint: string,
  manualChecks: ManualCheck[],
  ready: boolean,
) => {
  const pdf = new jsPDF({ unit: 'mm', format: 'letter', compress: true })
  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  const margin = 16
  const contentWidth = pageWidth - margin * 2
  let y = 18

  const ensureSpace = (height: number) => {
    if (y + height <= pageHeight - 15) return
    pdf.addPage()
    y = 18
  }
  const wrapped = (text: string, x: number, maxWidth: number, options?: { bold?: boolean; size?: number; color?: string }) => {
    const size = options?.size ?? 9
    pdf.setFont('helvetica', options?.bold ? 'bold' : 'normal')
    pdf.setFontSize(size)
    pdf.setTextColor(options?.color ?? '#252b36')
    const lines = pdf.splitTextToSize(text, maxWidth) as string[]
    ensureSpace(lines.length * (size * 0.42) + 2)
    pdf.text(lines, x, y)
    y += lines.length * (size * 0.42) + 2
  }

  pdf.setFillColor(31, 55, 119)
  pdf.roundedRect(margin, y, contentWidth, 27, 3, 3, 'F')
  pdf.setTextColor('#ffffff')
  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(19)
  pdf.text('Laser Ready · SVG Preflight', margin + 7, y + 10)
  pdf.setFont('helvetica', 'normal')
  pdf.setFontSize(9)
  pdf.text(ready ? 'READY FOR TEACHER REVIEW' : 'CHANGES NEEDED BEFORE TEACHER REVIEW', margin + 7, y + 19)
  y += 35

  const fileName = report.file.name ?? report.file.filename ?? 'Submitted SVG'
  wrapped(fileName, margin, contentWidth, { bold: true, size: 13 })
  wrapped(`SHA-256  ${fingerprint || report.file.sha256 || 'Unavailable'}`, margin, contentWidth, { size: 7, color: '#596273' })
  const analyzed = new Date(report.analyzed_at)
  wrapped(
    `Analyzed ${Number.isNaN(analyzed.getTime()) ? report.analyzed_at : analyzed.toLocaleString()} · Profile ${report.profile.version ?? report.profile.profile_version ?? 'unknown'} · Report ${report.report_version}`,
    margin,
    contentWidth,
    { size: 8, color: '#596273' },
  )
  wrapped(
    `${report.selection.assignment_label ?? report.selection.assignment_id ?? 'Assignment'} · ${report.selection.material_label ?? report.selection.material_id ?? 'Material'} · ${report.selection.thickness_mm ?? '—'} mm`,
    margin,
    contentWidth,
    { size: 9 },
  )

  wrapped('FILE FACTS & METRICS', margin, contentWidth, { bold: true, size: 9, color: '#1f3777' })
  wrapped(
    reportFileFacts(report).map(({ label, value }) => `${label}: ${value}`).join('  |  '),
    margin,
    contentWidth,
    { size: 8, color: '#45516a' },
  )

  const preview = previewDataUrl(report)
  if (preview) {
    ensureSpace(69)
    pdf.addImage(preview, 'PNG', margin, y, contentWidth, 63, undefined, 'FAST')
    y += 69
  }

  wrapped('RESULTS', margin, contentWidth, { bold: true, size: 9, color: '#1f3777' })
  const order: CheckStatus[] = ['blocker', 'warning', 'unverified', 'pass', 'info']
  order.forEach((status) => {
    report.checks.filter((check) => checkStatus(check) === status).forEach((check) => {
      ensureSpace(16)
      wrapped(`${statusLabel[status]}  ${check.title}`, margin, contentWidth, { bold: true, size: 9 })
      wrapped(check.summary ?? check.message ?? 'Review completed.', margin + 4, contentWidth - 4, { size: 8 })
      wrapped(`Evidence: ${findingEvidenceText(check.evidence)}`, margin + 4, contentWidth - 4, { size: 8, color: '#45516a' })
      if (check.correction || check.fix || check.help) wrapped(`Fix: ${check.correction ?? check.fix ?? check.help}`, margin + 4, contentWidth - 4, { size: 8, color: '#45516a' })
      y += 1
    })
  })

  ensureSpace(25)
  wrapped('MANUAL OPERATOR CHECKLIST', margin, contentWidth, { bold: true, size: 9, color: '#1f3777' })
  manualChecks.forEach((item) => wrapped(`${item.checked ? '[x]' : '[ ]'}  ${item.label}`, margin + 2, contentWidth - 2, { size: 8 }))

  ensureSpace(28)
  pdf.setDrawColor('#c9ced8')
  pdf.line(margin, y, pageWidth - margin, y)
  y += 6
  wrapped(
    'This automated review is a preflight aid, not permission to operate the laser. It cannot verify material composition, machine settings, focus, ventilation, supervision, charring, assembly, or physical strength. A trained instructor must approve every job.',
    margin,
    contentWidth,
    { size: 8, color: '#596273' },
  )

  const totalPages = pdf.getNumberOfPages()
  for (let page = 1; page <= totalPages; page += 1) {
    pdf.setPage(page)
    pdf.setFont('helvetica', 'normal')
    pdf.setFontSize(7)
    pdf.setTextColor('#7a8290')
    pdf.text(`Laser Ready · ${fileName}`, margin, pageHeight - 7)
    pdf.text(`${page} / ${totalPages}`, pageWidth - margin, pageHeight - 7, { align: 'right' })
  }
  pdf.save(`${safeFilename(fileName)}-preflight.pdf`)
}
