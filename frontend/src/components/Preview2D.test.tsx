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
            { id: 'photo', asset_id: 'safe', corners_mm: [[10, 5], [30, 5], [30, 15], [10, 15]], opacity: 0.8, blend_mode: 'multiply', z_index: 1, preserve_aspect_ratio: 'xMidYMid meet' },
            { id: 'remote-photo', asset_id: 'remote', corners_mm: [[40, 5], [50, 5], [50, 15], [40, 15]], opacity: 1, blend_mode: 'multiply', z_index: 3, preserve_aspect_ratio: 'xMidYMid meet' },
            { id: 'svg-photo', asset_id: 'svg', corners_mm: [[55, 5], [65, 5], [65, 15], [55, 15]], opacity: 1, blend_mode: 'multiply', z_index: 4, preserve_aspect_ratio: 'none' },
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
    expect(images[0]).toHaveAttribute('preserveAspectRatio', 'xMidYMid meet')
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
})
