import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Preview2D } from './Preview2D'

describe('Preview2D', () => {
  it('draws only normalized geometry and highlights selected object IDs', () => {
    const { container } = render(
      <Preview2D
        geometry={{
          page: { width_mm: 100, height_mm: 50 },
          paths: [
            { id: 'one', z_index: 0, operation: 'cut', closed: true, points: [[5, 5], [25, 5], [25, 20]] },
            { id: 'two', z_index: 1, operation: 'engrave', closed: false, points: [[40, 8], [80, 8]] },
          ],
          pieces: [],
          valid_3d: true,
        }}
        selectedCheck={{ rule_id: 'test', title: 'Selected path', state: 'warning', object_ids: ['one'] }}
      />,
    )
    expect(screen.getByRole('img', { name: /Normalized two-dimensional preview/ })).toBeInTheDocument()
    const polygons = container.querySelectorAll('polygon')
    expect(polygons).toHaveLength(1)
    expect(polygons[0]).toHaveAttribute('stroke', '#2d5bdb')
    expect(container.querySelector('foreignObject')).toBeNull()
  })

  it('renders only canonical PNG assets as highlighted multiply layers', () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const { container } = render(
      <Preview2D
        geometry={{
          page: { width_mm: 100, height_mm: 50 },
          paths: [
            { id: 'under', z_index: 0, operation: 'engrave', closed: false, points: [[2, 2], [8, 2]] },
            { id: 'photo', z_index: 1, operation: 'raster-engrave', closed: true, points: [[10, 5], [30, 5], [30, 15], [10, 15]] },
            { id: 'cut', z_index: 2, operation: 'cut', closed: true, points: [[5, 4], [40, 4], [40, 20], [5, 20]] },
          ],
          pieces: [],
          raster_assets: [
            { id: 'safe', data_url: png, pixel_width: 1, pixel_height: 1, preview_width_px: 1, preview_height_px: 1 },
            { id: 'remote', data_url: 'https://example.test/linked.png', pixel_width: 1, pixel_height: 1, preview_width_px: 1, preview_height_px: 1 },
            { id: 'svg', data_url: 'data:image/svg+xml;base64,PHN2Zy8+', pixel_width: 1, pixel_height: 1, preview_width_px: 1, preview_height_px: 1 },
          ],
          raster_layers: [
            { id: 'photo', asset_id: 'safe', corners_mm: [[10, 5], [30, 5], [30, 15], [10, 15]], opacity: 0.8, blend_mode: 'multiply', z_index: 1, preserve_aspect_ratio: 'xMidYMid meet', viewport_aspect_ratio: 2 },
            { id: 'remote-photo', asset_id: 'remote', corners_mm: [[40, 5], [50, 5], [50, 15], [40, 15]], opacity: 1, blend_mode: 'multiply', z_index: 3, preserve_aspect_ratio: 'xMidYMid meet', viewport_aspect_ratio: 1 },
            { id: 'svg-photo', asset_id: 'svg', corners_mm: [[55, 5], [65, 5], [65, 15], [55, 15]], opacity: 1, blend_mode: 'multiply', z_index: 4, preserve_aspect_ratio: 'none', viewport_aspect_ratio: 1 },
          ],
          valid_3d: false,
        }}
        selectedCheck={{ rule_id: 'raster', title: 'Raster image', state: 'warning', object_ids: ['photo'] }}
      />,
    )

    expect(screen.getByRole('img', { name: /with 1 embedded raster image layer/ })).toBeInTheDocument()
    const images = container.querySelectorAll('image[data-raster-layer]')
    expect(images).toHaveLength(1)
    expect(images[0]).toHaveAttribute('href', png)
    expect(images[0]).toHaveAttribute('transform', 'matrix(20 0 0 10 10 5)')
    expect(images[0]).toHaveAttribute('x', '0.25')
    expect(images[0]).toHaveAttribute('y', '0')
    expect(images[0]).toHaveAttribute('width', '0.5')
    expect(images[0]).toHaveAttribute('height', '1')
    expect(images[0]).toHaveAttribute('preserveAspectRatio', 'none')
    expect(images[0].getAttribute('style')).toContain('mix-blend-mode: multiply')
    expect([...container.querySelectorAll('[data-preview-layer]')].map((node) => node.getAttribute('data-preview-layer'))).toEqual([
      'path:under',
      'raster:photo',
      'path:cut',
    ])
    expect(container.innerHTML).not.toContain('https://example.test')
    expect(container.innerHTML).not.toContain('image/svg+xml')
    expect(screen.getByText('Embedded image (multiply)')).toBeInTheDocument()
    expect(container.querySelector('foreignObject')).toBeNull()
  })

  it('circles each localized open endpoint instead of marking an arbitrary path vertex', () => {
    const { container } = render(
      <Preview2D
        geometry={{
          page: { width_mm: 100, height_mm: 50 },
          paths: [
            { id: 'open-cut', z_index: 0, operation: 'cut', closed: false, points: [[10, 10], [40, 10], [40, 30]] },
          ],
          pieces: [],
          valid_3d: false,
        }}
        selectedCheck={{
          rule_id: 'geometry.closed_cuts',
          title: 'Through-cut paths are closed',
          state: 'blocker',
          object_ids: ['open-cut'],
          markers: [
            { id: 'open-endpoint-0001', kind: 'open_endpoint', label: 'Open endpoint 1', object_ids: ['open-cut'], location_mm: [10, 10] },
            { id: 'open-endpoint-0002', kind: 'open_endpoint', label: 'Open endpoint 2', object_ids: ['open-cut'], location_mm: [40, 30] },
          ],
        }}
      />,
    )

    expect(screen.getByRole('img', { name: /2 localized finding markers circled/ })).toBeInTheDocument()
    const markers = container.querySelectorAll('[data-finding-marker]')
    expect(markers).toHaveLength(2)
    expect(markers[0]).toHaveAttribute('transform', 'translate(10 10)')
    expect(markers[1]).toHaveAttribute('transform', 'translate(40 30)')
    expect(markers[0]).toHaveAttribute('data-finding-marker-kind', 'open_endpoint')
    expect(container.querySelector('[data-finding-marker] title')?.textContent).toBe('Open endpoint 1')
    expect(screen.getByText('Circled problem location')).toBeInTheDocument()
  })

  it('circles ordinary crossing locations and ignores non-finite marker coordinates', () => {
    const { container } = render(
      <Preview2D
        geometry={{
          page: { width_mm: 100, height_mm: 100 },
          paths: [
            { id: 'a', z_index: 0, operation: 'cut', closed: true, points: [[10, 10], [50, 10], [50, 50], [10, 50]] },
            { id: 'b', z_index: 1, operation: 'cut', closed: true, points: [[30, 30], [70, 30], [70, 70], [30, 70]] },
          ],
          pieces: [],
          valid_3d: true,
        }}
        selectedCheck={{
          rule_id: 'geometry.crossings',
          title: 'Cut crossings and touches',
          state: 'warning',
          object_ids: ['a', 'b'],
          markers: [
            { id: 'intersection-0001', kind: 'intersection', label: 'Crossing one', object_ids: ['a', 'b'], location_mm: [30, 50] },
            { id: 'intersection-0002', kind: 'intersection', label: 'Crossing two', object_ids: ['a', 'b'], location_mm: [50, 30] },
            { id: 'unsafe', kind: 'intersection', label: 'Unsafe marker', object_ids: ['a', 'b'], location_mm: [Number.NaN, 10] },
          ],
        }}
      />,
    )

    const markers = container.querySelectorAll('[data-finding-marker-kind="intersection"]')
    expect(markers).toHaveLength(2)
    expect([...markers].map((marker) => marker.getAttribute('transform'))).toEqual([
      'translate(30 50)',
      'translate(50 30)',
    ])
    expect(container.querySelector('[data-finding-marker="unsafe"]')).toBeNull()
  })

  it('circles self-intersections and coincident-overlap endpoints for topology blockers', () => {
    const { container } = render(
      <Preview2D
        geometry={{
          page: { width_mm: 100, height_mm: 100 },
          paths: [
            { id: 'bowtie', z_index: 0, operation: 'cut', closed: true, points: [[10, 10], [50, 50], [10, 50], [50, 10]] },
            { id: 'left', z_index: 1, operation: 'cut', closed: true, points: [[55, 10], [85, 10], [85, 40], [55, 40]] },
            { id: 'right', z_index: 2, operation: 'cut', closed: true, points: [[70, 10], [95, 10], [95, 30], [70, 30]] },
          ],
          pieces: [],
          valid_3d: false,
        }}
        selectedCheck={{
          rule_id: 'geometry.topology',
          title: 'Cut topology is valid',
          state: 'blocker',
          object_ids: ['bowtie', 'left', 'right'],
          markers: [
            { id: 'self-intersection-0001', kind: 'self_intersection', label: 'Self-intersection on bowtie', object_ids: ['bowtie'], location_mm: [30, 30] },
            { id: 'overlap-endpoint-0001', kind: 'overlap_endpoint', label: 'Coincident overlap endpoint', object_ids: ['left', 'right'], location_mm: [70, 10] },
            { id: 'overlap-endpoint-0002', kind: 'overlap_endpoint', label: 'Coincident overlap endpoint', object_ids: ['left', 'right'], location_mm: [85, 10] },
          ],
        }}
      />,
    )

    expect(container.querySelectorAll('[data-finding-marker-kind="self_intersection"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-finding-marker-kind="overlap_endpoint"]')).toHaveLength(2)
    expect(container.querySelector('[data-finding-marker="self-intersection-0001"]')).toHaveAttribute('transform', 'translate(30 30)')
    expect(container.querySelector('[data-finding-marker="overlap-endpoint-0002"]')).toHaveAttribute('transform', 'translate(85 10)')
    expect(screen.getByRole('img', { name: /3 localized finding markers circled/ })).toBeInTheDocument()
  })

  it('toggles finite measured weak-point spans above normalized artwork', () => {
    const geometry = {
      page: { width_mm: 100, height_mm: 50 },
      paths: [
        { id: 'part', z_index: 0, operation: 'cut', closed: true, points: [[5, 5], [45, 5], [45, 25], [5, 25]] as [number, number][] },
      ],
      pieces: [],
      weak_points: {
        status: 'complete' as const,
        message: 'One potential weak point.',
        points: [
          {
            id: 'weak-point-0001',
            kind: 'narrow_feature' as const,
            label: 'Narrow feature',
            object_ids: ['part'],
            location_mm: [20, 10] as [number, number],
            span_mm: [[20, 9], [20, 11]] as [[number, number], [number, number]],
            measurement: 2,
            threshold: 3,
            unit: 'mm' as const,
          },
          {
            id: 'invalid',
            kind: 'tiny_piece' as const,
            label: 'Invalid marker',
            object_ids: ['part'],
            location_mm: [Number.NaN, 10] as [number, number],
            measurement: 1,
            threshold: 2,
            unit: 'mm2' as const,
          },
        ],
      },
      valid_3d: true,
    }
    const hidden = render(<Preview2D geometry={geometry} />)
    expect(hidden.container.querySelector('[data-testid="weak-point-layer"]')).toBeNull()
    hidden.unmount()

    const { container } = render(<Preview2D geometry={geometry} showWeakPoints />)
    expect(screen.getByRole('img', { name: /1 potential weak point highlighted/ })).toBeInTheDocument()
    const markers = container.querySelectorAll('[data-weak-point]')
    expect(markers).toHaveLength(1)
    expect(markers[0]).toHaveAttribute('transform', 'translate(20 10)')
    expect(markers[0].querySelector('line')).toHaveAttribute('y1', '-1')
    expect(markers[0].querySelector('line')).toHaveAttribute('y2', '1')
    expect(markers[0].querySelector('title')?.textContent).toContain('guideline')
    expect(screen.getByText('Potential weak point')).toBeInTheDocument()
  })
})
