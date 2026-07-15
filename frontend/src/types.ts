import { formatInches } from './units'

export type CheckStatus = 'pass' | 'blocker' | 'warning' | 'info' | 'unverified'

export type Point = [number, number]

export interface ProfileSummary {
  id?: string
  name?: string
  version?: string
  profile_version?: string
  machine_label?: string
  demo?: boolean
  [key: string]: unknown
}

export interface Assignment {
  id: string
  label?: string
  name?: string
  description?: string
  image_policy?: string
  page_policy?: string
  expected_width_mm?: number
  expected_height_mm?: number
  [key: string]: unknown
}

export interface ThicknessChoice {
  value_mm?: number
  thickness_mm?: number
  label?: string
  [key: string]: unknown
}

export interface Material {
  id: string
  label?: string
  name?: string
  type?: 'wood' | 'acrylic' | string
  family?: 'wood' | 'acrylic' | string
  kerf_mm?: number
  thicknesses_mm?: number[]
  thicknesses?: Array<number | ThicknessChoice>
  preview?: {
    color?: string
    opacity?: number
    roughness?: number
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface ProfileResponse {
  profile: ProfileSummary
  machine?: {
    label?: string
    name?: string
    usable_width_mm?: number
    usable_height_mm?: number
    [key: string]: unknown
  }
  limits?: {
    max_upload_bytes?: number
    [key: string]: unknown
  }
  assignments: Assignment[]
  materials: Material[]
  operator_checklist?: Array<string | { id?: string; label?: string; text?: string }>
}

export interface FileSummary {
  name?: string
  filename?: string
  size_bytes?: number
  sha256?: string
  [key: string]: unknown
}

export interface SelectionSummary {
  assignment_id?: string
  assignment_label?: string
  material_id?: string
  material_label?: string
  material_type?: string
  thickness_mm?: number
  kerf_mm?: number
  [key: string]: unknown
}

export interface ReadinessSummary {
  ready?: boolean
  status?: string
  headline?: string
  blocker_count?: number
  warning_count?: number
  pass_count?: number
  unverified_count?: number
  label?: string
  counts?: {
    blocker?: number
    warning?: number
    pass?: number
    info?: number
    unverified?: number
  }
  [key: string]: unknown
}

export interface DocumentSummary {
  width_mm?: number
  height_mm?: number
  units?: string
  unit_confidence?: string
  [key: string]: unknown
}

export interface Metrics {
  object_count?: number
  cut_path_count?: number
  engrave_path_count?: number
  image_count?: number
  font_count?: number
  total_cut_length_mm?: number
  minimum_feature_mm?: number
  smallest_estimated_feature_mm?: number
  minimum_raster_dpi?: number
  [key: string]: unknown
}

export interface AnalysisCheck {
  id?: string
  rule_id?: string
  title: string
  state?: string
  status?: string
  severity?: string
  category?: string
  summary?: string
  message?: string
  evidence?: string | string[] | Record<string, unknown>
  correction?: string
  fix?: string | null
  help?: string
  object_ids?: string[]
  markers?: FindingMarker[]
  fix_actions?: FixAction[]
  bounds?: Array<{
    x_mm?: number
    y_mm?: number
    width_mm?: number
    height_mm?: number
  }> | {
    x?: number
    y?: number
    width?: number
    height?: number
    min_x?: number
    min_y?: number
    max_x?: number
    max_y?: number
  }
  [key: string]: unknown
}

export interface FindingMarker {
  id: string
  kind: 'open_endpoint' | 'intersection' | 'self_intersection' | 'overlap_endpoint'
  label: string
  object_ids: string[]
  location_mm: Point
}

interface FixActionBase {
  id: string
  label: string
  description: string
  endpoint?: string
  object_ids: string[]
  count: number
}

export interface NormalizeCutStrokesFixAction extends FixActionBase {
  kind: 'normalize_cut_strokes'
  target_color: '#000000'
  target_stroke_width_in: 0.001
}

export interface SetArtboardFixAction extends FixActionBase {
  kind: 'set_artboard'
  target_width_in: number
  target_height_in: number
}

export type FixAction = NormalizeCutStrokesFixAction | SetArtboardFixAction

export interface PreviewPath {
  id: string
  z_index: number
  operation?: string
  closed?: boolean
  stroke?: string
  stroke_width_mm?: number | null
  color?: string
  points: Point[]
}

export interface PreviewRasterAsset {
  id: string
  data_url: string
  pixel_width: number
  pixel_height: number
  preview_width_px: number
  preview_height_px: number
}

export interface PreviewRasterLayer {
  id: string
  asset_id: string
  corners_mm: Point[]
  opacity: number
  blend_mode: 'multiply'
  z_index: number
  preserve_aspect_ratio: string
  viewport_aspect_ratio: number
}

export type PreviewWeakPointKind = 'narrow_feature' | 'close_cut_spacing' | 'tiny_piece'

export interface PreviewWeakPoint {
  id: string
  kind: PreviewWeakPointKind
  label: string
  object_ids: string[]
  location_mm: Point
  span_mm?: [Point, Point] | null
  measurement: number
  threshold: number
  unit: 'mm' | 'mm2'
}

export interface PreviewWeakPoints {
  status: 'complete' | 'partial' | 'unavailable'
  message: string
  points: PreviewWeakPoint[]
}

export interface PreviewPiece {
  id: string
  outer: Point[]
  holes?: Point[][]
}

export interface PreviewGeometry {
  page: {
    width_mm: number | null
    height_mm: number | null
  }
  paths: PreviewPath[]
  pieces: PreviewPiece[]
  raster_assets?: PreviewRasterAsset[]
  raster_layers?: PreviewRasterLayer[]
  weak_points?: PreviewWeakPoints
  valid_3d: boolean
  invalid_reason?: string | null
}

export interface AnalysisReport {
  report_version: string
  analyzed_at: string
  file: FileSummary
  profile: ProfileSummary
  selection: SelectionSummary
  summary: ReadinessSummary
  document: DocumentSummary
  metrics: Metrics
  checks: AnalysisCheck[]
  geometry: PreviewGeometry
}

export interface AnalyzeSelection {
  assignmentId: string
  materialId: string
  thicknessMm: number
}

export interface FixSelection {
  assignmentId: string
  expectedSha256: string
}

export const checkStatus = (check: AnalysisCheck): CheckStatus => {
  const value = String(check.state ?? check.status ?? check.severity ?? '').trim().toLowerCase()
  if (['fail', 'failed', 'error', 'critical', 'block', 'blocked', 'blocker'].includes(value)) return 'blocker'
  if (['warn', 'warning'].includes(value)) return 'warning'
  if (['pass', 'passed', 'ok', 'success'].includes(value)) return 'pass'
  if (['unknown', 'manual', 'unverified', 'not_checked'].includes(value)) return 'unverified'
  return 'info'
}

export const checkKey = (check: AnalysisCheck): string => check.id ?? check.rule_id ?? check.title

export const materialThicknesses = (material?: Material): Array<{ value: number; label: string }> => {
  if (!material) return []
  const source = material.thicknesses_mm ?? material.thicknesses ?? []
  return source
    .map((item) => {
      if (typeof item === 'number') return { value: item, label: formatInches(item) }
      const value = Number(item.value_mm ?? item.thickness_mm)
      return { value, label: formatInches(value) }
    })
    .filter((item) => Number.isFinite(item.value) && item.value > 0)
}

export const displayName = (item: { label?: string; name?: string; id: string }) => item.label ?? item.name ?? item.id
