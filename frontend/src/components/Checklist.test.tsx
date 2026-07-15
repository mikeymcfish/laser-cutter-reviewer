import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Checklist } from './Checklist'

describe('Checklist correction actions', () => {
  it('returns to All when reanalysis removes the active result category', async () => {
    const blocker = {
      rule_id: 'vectors.process_setup',
      title: 'Cut setup',
      state: 'blocker',
      message: 'Fix this stroke.',
    }
    const { rerender } = render(
      <Checklist checks={[blocker]} selectedId={null} onSelect={vi.fn()} />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Blockers 1/ }))
    expect(screen.getByRole('button', { name: /Blockers 1/ })).toHaveAttribute('aria-pressed', 'true')

    rerender(
      <Checklist
        checks={[{ ...blocker, state: 'pass', message: 'The stroke now passes.' }]}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    )

    await waitFor(() => expect(screen.getByRole('button', { name: /All 1/ })).toHaveAttribute('aria-pressed', 'true'))
    expect(screen.getByText('The stroke now passes.')).toBeInTheDocument()
    expect(screen.queryByText('No checks match this filter.')).not.toBeInTheDocument()
  })

  it('keeps finding disclosure and correction controls as separate accessible buttons', () => {
    const onSelect = vi.fn()
    const onFixAction = vi.fn()
    const action = {
      id: 'normalize-cut-strokes',
      kind: 'normalize_cut_strokes' as const,
      label: 'Fix cut stroke',
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
    const fixButton = screen.getByRole('button', { name: /Fix 1 stroke by creating through-cuts/ })
    expect(screen.getByText('Creates through-cuts: #000000 at 0.001 in')).toBeInTheDocument()
    expect(screen.getByText(/changes every highlighted stroke into a through-cut/)).toBeInTheDocument()
    expect(screen.getByText(/immediately refreshes this preview/)).toBeInTheDocument()
    fireEvent.click(fixButton)
    expect(onFixAction).toHaveBeenCalledWith(action)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('states that an artboard fix anchors the page without changing artwork', () => {
    const onFixAction = vi.fn()
    const action = {
      id: 'set-artboard',
      kind: 'set_artboard' as const,
      endpoint: '/api/v1/fix-artboard',
      label: 'Fix artboard',
      description: 'Set the page to the required assignment size.',
      object_ids: [],
      count: 1,
      target_width_in: 12,
      target_height_in: 12,
    }
    render(
      <Checklist
        checks={[{
          rule_id: 'document.size',
          title: 'Artboard size',
          state: 'blocker',
          message: 'The page is the wrong size.',
          fix_actions: [action],
        }]}
        selectedId="document.size"
        onSelect={vi.fn()}
        onFixAction={onFixAction}
      />,
    )

    expect(screen.getByText('Changes the page only to 12 × 12 in')).toBeInTheDocument()
    expect(screen.getByText(/anchored at the top-left.*not scaled or moved/)).toBeInTheDocument()
    const button = screen.getByRole('button', { name: /Fix artboard page only to 12 × 12 in/ })
    fireEvent.click(button)
    expect(onFixAction).toHaveBeenCalledWith(action)
  })
})
