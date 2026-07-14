import { useId, useMemo } from 'react'
import type {
  AnalysisCheck,
  Point,
  PreviewGeometry,
  PreviewPath,
  PreviewRasterAsset,
  PreviewRasterLayer,
} from '../types'

interface Preview2DProps {
  geometry: PreviewGeometry
  selectedCheck?: AnalysisCheck
}

interface RenderableRasterLayer {
  layer: PreviewRasterLayer
  asset: PreviewRasterAsset
}

type RenderLayer =
  | { kind: 'path'; path: PreviewPath; zIndex: number; sequence: number }
  | { kind: 'raster'; raster: RenderableRasterLayer; zIndex: number; sequence: number }

const operationColor = (path: PreviewPath) => {
  const operation = String(path.operation ?? '').toLowerCase()
  if (operation.includes('engrave') || operation.includes('raster')) return '#b26a56'
  if (operation.includes('score')) return '#2a67b7'
  return path.color || path.stroke || '#171a1f'
}

const pointString = (points: Point[]) => points.map(([x, y]) => `${x},${y}`).join(' ')

const canonicalPng = (value: string) => (
  /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  && value.length <= 8 * 1024 * 1024
)

const finiteCorners = (corners: Point[]) => (
  corners.length >= 4
  && corners.slice(0, 4).every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
)

const affineTransform = (corners: Point[]) => {
  const [topLeft, topRight, , bottomLeft] = corners
  return `matrix(${topRight[0] - topLeft[0]} ${topRight[1] - topLeft[1]} ${bottomLeft[0] - topLeft[0]} ${bottomLeft[1] - topLeft[1]} ${topLeft[0]} ${topLeft[1]})`
}

const preserveAspectRatio = (value: string) => (
  /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max) (?:meet|slice))$/.test(value)
    ? value
    : 'xMidYMid meet'
)

export function Preview2D({ geometry, selectedCheck }: Preview2DProps) {
  const patternId = useId().replaceAll(':', '')
  const width = Number(geometry.page?.width_mm) || 1
  const height = Number(geometry.page?.height_mm) || 1
  const selectedIds = new Set(selectedCheck?.object_ids ?? [])
  const rasterLayers = useMemo<RenderableRasterLayer[]>(() => {
    const assets = new Map(
      (geometry.raster_assets ?? [])
        .filter((asset) => canonicalPng(asset.data_url))
        .map((asset) => [asset.id, asset]),
    )
    return (geometry.raster_layers ?? [])
      .filter((layer) => layer.blend_mode === 'multiply' && finiteCorners(layer.corners_mm) && assets.has(layer.asset_id))
      .map((layer) => ({ layer, asset: assets.get(layer.asset_id)! }))
      .sort((left, right) => (left.layer.z_index ?? 0) - (right.layer.z_index ?? 0))
  }, [geometry.raster_assets, geometry.raster_layers])
  const rasterLayerIds = new Set(rasterLayers.map(({ layer }) => layer.id))
  const paths = geometry.paths.filter((path) => !(path.operation?.includes('raster') && rasterLayerIds.has(path.id)))
  const renderLayers: RenderLayer[] = [
    ...paths.map((path, index) => ({
      kind: 'path' as const,
      path,
      zIndex: Number.isFinite(path.z_index) ? path.z_index : index,
      sequence: index,
    })),
    ...rasterLayers.map((raster, index) => ({
      kind: 'raster' as const,
      raster,
      zIndex: Number.isFinite(raster.layer.z_index) ? raster.layer.z_index : geometry.paths.length + index,
      sequence: geometry.paths.length + index,
    })),
  ].sort((left, right) => left.zIndex - right.zIndex || left.sequence - right.sequence)
  const markedPaths = paths.filter((path) => selectedIds.has(path.id))
  const markedRasters = rasterLayers.filter(({ layer }) => selectedIds.has(layer.id))
  const markedItems = [
    ...markedPaths.map((path) => ({ id: path.id, point: path.points[0] })),
    ...markedRasters.map(({ layer }) => ({ id: layer.id, point: layer.corners_mm[0] })),
  ].filter((item): item is { id: string; point: Point } => Boolean(item.point))
  const hasMarkedObject = markedItems.length > 0

  return (
    <div
      className="preview-2d"
      role="img"
      aria-label={`Normalized two-dimensional preview of the submitted cut file${rasterLayers.length ? ` with ${rasterLayers.length} embedded raster image ${rasterLayers.length === 1 ? 'layer' : 'layers'}` : ''}`}
    >
      <svg viewBox={`${-width * 0.035} ${-height * 0.035} ${width * 1.07} ${height * 1.07}`} preserveAspectRatio="xMidYMid meet">
        <defs>
          <pattern id={`preview-grid-${patternId}`} width="10" height="10" patternUnits="userSpaceOnUse">
            <path d="M 10 0 L 0 0 0 10" fill="none" stroke="#d9dce2" strokeWidth="0.18" />
          </pattern>
          <filter id={`paper-shadow-${patternId}`} x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="1.2" stdDeviation="1.6" floodColor="#192133" floodOpacity="0.16" />
          </filter>
        </defs>
        <rect x="0" y="0" width={width} height={height} rx="1.2" fill="#fff" filter={`url(#paper-shadow-${patternId})`} />
        <rect x="0" y="0" width={width} height={height} rx="1.2" fill={`url(#preview-grid-${patternId})`} />
        <g style={{ isolation: 'isolate' }}>
          {renderLayers.map((renderLayer) => {
            if (renderLayer.kind === 'raster') {
              const { layer, asset } = renderLayer.raster
              const selected = selectedIds.has(layer.id)
              const configuredOpacity = Number.isFinite(layer.opacity) ? Math.min(1, Math.max(0, layer.opacity)) : 1
              return (
                <image
                  key={`raster-${layer.id}`}
                  data-raster-layer={layer.id}
                  data-preview-layer={`raster:${layer.id}`}
                  href={asset.data_url}
                  x="0"
                  y="0"
                  width="1"
                  height="1"
                  preserveAspectRatio={preserveAspectRatio(layer.preserve_aspect_ratio)}
                  transform={affineTransform(layer.corners_mm)}
                  opacity={selectedIds.size > 0 && !selected ? configuredOpacity * 0.2 : configuredOpacity}
                  style={{ mixBlendMode: 'multiply' }}
                  aria-hidden="true"
                />
              )
            }
            const path = renderLayer.path
            if (!path.points?.length) return null
            const selected = selectedIds.has(path.id)
            const common = {
              'data-preview-layer': `path:${path.id}`,
              points: pointString(path.points),
              fill: 'none',
              stroke: selected ? '#2d5bdb' : operationColor(path),
              strokeWidth: selected ? Math.max(width, height) * 0.006 : Math.max(width, height) * 0.0016,
              vectorEffect: 'non-scaling-stroke' as const,
              strokeLinecap: 'round' as const,
              strokeLinejoin: 'round' as const,
              opacity: selectedIds.size > 0 && !selected ? 0.22 : 0.92,
            }
            return path.closed ? <polygon key={path.id} {...common} /> : <polyline key={path.id} {...common} />
          })}
        </g>
        {markedRasters.map(({ layer }) => (
          <polygon
            key={`raster-highlight-${layer.id}`}
            points={pointString(layer.corners_mm.slice(0, 4))}
            fill="#2d5bdb14"
            stroke="#2d5bdb"
            strokeWidth={Math.max(width, height) * 0.006}
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
        ))}
        {markedItems.map((item, index) => {
          const radius = Math.max(width, height) * 0.014
          return (
            <g key={`marker-${item.id}`} transform={`translate(${item.point[0]} ${item.point[1]})`}>
              <circle r={radius} fill="#2d5bdb" stroke="#fff" strokeWidth={radius * 0.2} />
              <text
                x="0"
                y={radius * 0.35}
                textAnchor="middle"
                fontSize={radius * 1.05}
                fontWeight="700"
                fill="#fff"
              >
                {index + 1}
              </text>
            </g>
          )
        })}
        {selectedIds.size > 0 && !hasMarkedObject && selectedCheck?.bounds && !Array.isArray(selectedCheck.bounds) ? (
          <rect
            x={selectedCheck.bounds.x ?? selectedCheck.bounds.min_x ?? 0}
            y={selectedCheck.bounds.y ?? selectedCheck.bounds.min_y ?? 0}
            width={selectedCheck.bounds.width ?? ((selectedCheck.bounds.max_x ?? 0) - (selectedCheck.bounds.min_x ?? 0))}
            height={selectedCheck.bounds.height ?? ((selectedCheck.bounds.max_y ?? 0) - (selectedCheck.bounds.min_y ?? 0))}
            fill="#2d5bdb1f"
            stroke="#2d5bdb"
            strokeDasharray="3 2"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {selectedIds.size > 0 && !hasMarkedObject && Array.isArray(selectedCheck?.bounds)
          ? selectedCheck.bounds.map((item, index) => (
              <rect
                key={`finding-bound-${index}`}
                x={item.x_mm ?? 0}
                y={item.y_mm ?? 0}
                width={item.width_mm ?? 0}
                height={item.height_mm ?? 0}
                fill="#2d5bdb1f"
                stroke="#2d5bdb"
                strokeDasharray="3 2"
                vectorEffect="non-scaling-stroke"
              />
            ))
          : null}
      </svg>
      <div className="preview-legend" aria-hidden="true">
        <span><i className="legend-cut" />Cut</span>
        <span><i className="legend-score" />Score</span>
        <span><i className="legend-engrave" />Engrave</span>
        {rasterLayers.length ? <span><i className="legend-raster" />Embedded image (multiply)</span> : null}
        {selectedCheck ? <span><i className="legend-selected" />Selected finding</span> : null}
      </div>
    </div>
  )
}
