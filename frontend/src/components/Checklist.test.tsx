import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Checklist } from './Checklist'

describe('Checklist correction actions', () => {
  it('keeps finding disclosure and correction controls as separate accessible buttons', () => {
    const onSelect = vi.fn()
    const onFixAction = vi.fn()
    const action = {
      id: 'normalize-cut-strokes',
      kind: 'normalize_cut_strokes' as const,
      label: 'Download corrected SVG',
      description: 'Change the highlighted stroke to RGB black (#000000) and 0.001 in.',
      object_ids: ['wrong-stroke'],
      count: 1,
      target_color: '#000000' as const,
      target_stroke_width_in: 0.001 as const,
    }
    const { container } = render(
      <Checklist
        checks={[{
          rule_id: 'vectors.process_setup',
          title: 'Cut color and hairline width',
          state: 'blocker',
          message: 'One stroke is not set up as a cut.',
          fix_actions: [action],
        }]}
        selectedId="vectors.process_setup"
        onSelect={onSelect}
        onFixAction={onFixAction}
      />,
    )

    expect(container.querySelector('button button')).toBeNull()
    expect(screen.getByRole('button', { name: /Cut color and hairline width/ })).toHaveAttribute('aria-expanded', 'true')
    const fixButton = screen.getByRole('button', { name: /Download corrected SVG: change 1 stroke/ })
    expect(screen.getByText('Creates through-cuts: #000000 at 0.001 in')).toBeInTheDocument()
    expect(screen.getByText(/intentional engraving, cancel/)).toBeInTheDocument()
    expect(screen.getByText(/Your original stays unchanged/)).toBeInTheDocument()
    fireEvent.click(fixButton)
    expect(onFixAction).toHaveBeenCalledWith(action)
    expect(onSelect).not.toHaveBeenCalled()
  })
})
