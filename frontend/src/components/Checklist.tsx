import { useMemo, useState } from 'react'
import type { AnalysisCheck, CheckStatus, FixAction } from '../types'
import { checkKey, checkStatus } from '../types'
import { CheckIcon, DownloadIcon, EyeIcon, InfoIcon, WarningIcon, XIcon } from './Icons'

interface ChecklistProps {
  checks: AnalysisCheck[]
  selectedId: string | null
  onSelect: (check: AnalysisCheck) => void
  onFixAction?: (action: FixAction) => void | Promise<void>
  fixingActionId?: string | null
}

const labels: Record<CheckStatus | 'all', string> = {
  all: 'All',
  blocker: 'Blockers',
  warning: 'Warnings',
  pass: 'Passed',
  unverified: 'Unverified',
  info: 'Info',
}

const StatusIcon = ({ status }: { status: CheckStatus }) => {
  if (status === 'pass') return <CheckIcon />
  if (status === 'blocker') return <XIcon />
  if (status === 'warning' || status === 'unverified') return <WarningIcon />
  return <InfoIcon />
}

const evidenceText = (evidence: AnalysisCheck['evidence']) => {
  if (!evidence) return ''
  if (typeof evidence === 'string') return evidence
  if (Array.isArray(evidence)) return evidence.join(' · ')
  return Object.entries(evidence)
    .map(([key, value]) => `${key.replaceAll('_', ' ')}: ${String(value)}`)
    .join(' · ')
}

const fixPresentation = (action: FixAction) => {
  if (action.kind === 'set_artboard') {
    const width = Number.isInteger(action.target_width_in) ? action.target_width_in : Number(action.target_width_in.toFixed(3))
    const height = Number.isInteger(action.target_height_in) ? action.target_height_in : Number(action.target_height_in.toFixed(3))
    const dimensions = `${width} × ${height} in`
    return {
      heading: `Changes the page only to ${dimensions}`,
      caution: 'The new artboard is anchored at the top-left. Artwork is not scaled or moved.',
      button: 'Fix page only & re-review',
      busy: 'Fixing page & reviewing…',
      ariaLabel: `Fix artboard page only to ${dimensions}; anchor top-left without scaling or moving artwork; download and re-review`,
    }
  }
  const countLabel = `${action.count} ${action.count === 1 ? 'stroke' : 'strokes'}`
  return {
    heading: 'Creates through-cuts: #000000 at 0.001 in',
    caution: 'Use this only for intended cuts. It changes every highlighted stroke into a through-cut, including any that was meant to engrave.',
    button: 'Fix as through-cuts & re-review',
    busy: 'Fixing through-cuts & reviewing…',
    ariaLabel: `Fix ${countLabel} by creating through-cuts in RGB black at 0.001 inches; download and re-review`,
  }
}

export function Checklist({ checks, selectedId, onSelect, onFixAction, fixingActionId }: ChecklistProps) {
  const [filter, setFilter] = useState<CheckStatus | 'all'>('all')
  const counts = useMemo(() => {
    const values = { blocker: 0, warning: 0, pass: 0, unverified: 0, info: 0 }
    checks.forEach((check) => values[checkStatus(check)]++)
    return values
  }, [checks])

  const visible = checks.filter((check) => filter === 'all' || checkStatus(check) === filter)
  const grouped = visible.reduce<Record<string, AnalysisCheck[]>>((groups, check) => {
    const category = check.category?.trim() || 'File review'
    groups[category] = [...(groups[category] ?? []), check]
    return groups
  }, {})

  const filterOrder: Array<CheckStatus | 'all'> = ['all', 'blocker', 'warning', 'unverified', 'pass', 'info']

  return (
    <section className="checklist-panel" aria-labelledby="checklist-title">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Preflight checklist</span>
          <h2 id="checklist-title">What we found</h2>
        </div>
        <span className="result-total">{checks.length} checks</span>
      </div>

      <div className="filter-row" aria-label="Filter checks">
        {filterOrder.map((value) => {
          const count = value === 'all' ? checks.length : counts[value]
          if (value !== 'all' && count === 0) return null
          return (
            <button
              type="button"
              key={value}
              className={filter === value ? 'is-active' : ''}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {labels[value]} <span>{count}</span>
            </button>
          )
        })}
      </div>

      <div className="check-groups">
        {Object.entries(grouped).map(([category, items]) => (
          <div className="check-group" key={category}>
            <h3>{category}</h3>
            <div className="check-list">
              {items.map((check) => {
                const status = checkStatus(check)
                const selected = selectedId === checkKey(check)
                const evidence = evidenceText(check.evidence)
                return (
                  <article
                    className={`check-card status-${status}${selected ? ' is-selected' : ''}`}
                    key={checkKey(check)}
                  >
                    <button
                      type="button"
                      className="check-card-main"
                      onClick={() => onSelect(check)}
                      aria-expanded={selected}
                    >
                      <span className="status-icon"><StatusIcon status={status} /></span>
                      <span className="check-content">
                        <span className="check-title-row">
                          <strong>{check.title}</strong>
                          <span className={`status-label ${status}`}>{labels[status]}</span>
                        </span>
                        <span className="check-summary">{check.summary ?? check.message ?? 'Review completed.'}</span>
                        {selected ? (
                          <span className="check-details">
                            {evidence ? <span><b>Evidence</b>{evidence}</span> : null}
                            {check.correction || check.fix || check.help ? (
                              <span><b>How to fix it in Illustrator</b>{check.correction ?? check.fix ?? check.help}</span>
                            ) : status === 'pass' ? (
                              <span><b>Good to go</b>No changes are needed for this check.</span>
                            ) : null}
                          </span>
                        ) : null}
                      </span>
                      <span className="inspect-icon" aria-hidden="true"><EyeIcon size={17} /></span>
                    </button>
                    {selected && onFixAction && check.fix_actions?.length ? (
                      <div className="fix-actions" aria-label="Available corrections">
                        {check.fix_actions.map((action) => {
                          const fixing = fixingActionId === action.id
                          const presentation = fixPresentation(action)
                          return (
                            <div className="fix-action" key={action.id}>
                              <p>
                                <strong>{presentation.heading}</strong>
                                <span>{action.description}</span>
                                <span>{presentation.caution}</span>
                                <span>One click downloads a separate corrected SVG and immediately refreshes this preview. Your original file stays unchanged.</span>
                              </p>
                              <button
                                type="button"
                                className="fix-button"
                                onClick={() => void onFixAction(action)}
                                disabled={Boolean(fixingActionId)}
                                aria-busy={fixing}
                                aria-label={presentation.ariaLabel}
                              >
                                {fixing ? <span className="button-spinner" aria-hidden="true" /> : <DownloadIcon size={16} />}
                                {fixing ? presentation.busy : presentation.button}
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    ) : null}
                  </article>
                )
              })}
            </div>
          </div>
        ))}
        {visible.length === 0 ? <p className="empty-filter">No checks match this filter.</p> : null}
      </div>
    </section>
  )
}
