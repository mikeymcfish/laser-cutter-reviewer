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
            { id: 'one', operation: 'cut', closed: true, points: [[5, 5], [25, 5], [25, 20]] },
            { id: 'two', operation: 'engrave', closed: false, points: [[40, 8], [80, 8]] },
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
})
