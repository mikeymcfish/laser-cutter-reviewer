import { useMemo, useState } from 'react'
import type { AnalysisCheck, CheckStatus } from '../types'
import { checkKey, checkStatus } from '../types'
import { CheckIcon, EyeIcon, InfoIcon, WarningIcon, XIcon } from './Icons'

interface ChecklistProps {
  checks: AnalysisCheck[]
  selectedId: string | null
  onSelect: (check: AnalysisCheck) => void
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

export function Checklist({ checks, selectedId, onSelect }: ChecklistProps) {
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
                  <button
                    type="button"
                    className={`check-card status-${status}${selected ? ' is-selected' : ''}`}
                    key={checkKey(check)}
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
