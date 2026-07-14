import type { AnalysisCheck, PreviewGeometry, PreviewPath } from '../types'

interface Preview2DProps {
  geometry: PreviewGeometry
  selectedCheck?: AnalysisCheck
}

const operationColor = (path: PreviewPath) => {
  const operation = String(path.operation ?? '').toLowerCase()
  if (operation.includes('engrave') || operation.includes('raster')) return '#b26a56'
  if (operation.includes('score')) return '#2a67b7'
  return path.color || path.stroke || '#171a1f'
}

const pointString = (points: Array<[number, number]>) => points.map(([x, y]) => `${x},${y}`).join(' ')

export function Preview2D({ geometry, selectedCheck }: Preview2DProps) {
  const width = Number(geometry.page?.width_mm) || 1
  const height = Number(geometry.page?.height_mm) || 1
  const selectedIds = new Set(selectedCheck?.object_ids ?? [])
  const markedPaths = geometry.paths.filter((path) => selectedIds.has(path.id))

  return (
    <div className="preview-2d" role="img" aria-label="Normalized two-dimensional preview of the submitted cut file">
      <svg viewBox={`${-width * 0.035} ${-height * 0.035} ${width * 1.07} ${height * 1.07}`} preserveAspectRatio="xMidYMid meet">
        <defs>
          <pattern id="preview-grid" width="10" height="10" patternUnits="userSpaceOnUse">
            <path d="M 10 0 L 0 0 0 10" fill="none" stroke="#d9dce2" strokeWidth="0.18" />
          </pattern>
          <filter id="paper-shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="1.2" stdDeviation="1.6" floodColor="#192133" floodOpacity="0.16" />
          </filter>
        </defs>
        <rect x="0" y="0" width={width} height={height} rx="1.2" fill="#fff" filter="url(#paper-shadow)" />
        <rect x="0" y="0" width={width} height={height} rx="1.2" fill="url(#preview-grid)" />
        {geometry.paths.map((path) => {
          if (!path.points?.length) return null
          const selected = selectedIds.has(path.id)
          const common = {
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
        {markedPaths.map((path, index) => {
          const point = path.points[0]
          if (!point) return null
          const radius = Math.max(width, height) * 0.014
          return (
            <g key={`marker-${path.id}`} transform={`translate(${point[0]} ${point[1]})`}>
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
        {selectedIds.size > 0 && markedPaths.length === 0 && selectedCheck?.bounds && !Array.isArray(selectedCheck.bounds) ? (
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
        {selectedIds.size > 0 && markedPaths.length === 0 && Array.isArray(selectedCheck?.bounds)
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
        {selectedCheck ? <span><i className="legend-selected" />Selected finding</span> : null}
      </div>
    </div>
  )
}
