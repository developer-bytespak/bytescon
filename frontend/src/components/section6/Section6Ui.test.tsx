// =============================================================
// §6 — Presentation honesty tests.
//
// These pin the user-visible rules the specification is explicit about:
//   - a forecast is always badged as a forecast, never as a solicitation
//   - an unavailable interval renders the exact backend label
//   - an absent dimension renders as "not assessable", never 0%
//   - award share is never rendered as a win rate
//   - a rate is always shown with its denominator
// =============================================================
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import {
  ConfidenceInterval, DimensionRow, EligibilityBadge, ExpiryBadge,
  FreshnessBadge, RateWithBasis, RecordKindBadge, SourceErrorPanel,
  PartialDataNotice, formatDate, formatMoney,
} from './Section6Ui'

describe('RecordKindBadge — a forecast never looks like a solicitation', () => {
  it('renders FORECAST for a forecast record', () => {
    render(<RecordKindBadge kind="FORECAST" />)
    expect(screen.getByText('FORECAST')).toBeInTheDocument()
  })

  it('explains what a forecast is on hover', () => {
    render(<RecordKindBadge kind="FORECAST" />)
    expect(screen.getByText('FORECAST').getAttribute('title')).toMatch(/before any solicitation exists/i)
  })

  it('distinguishes pre-solicitation notices from solicitations', () => {
    const { rerender } = render(<RecordKindBadge kind="PRE_SOLICITATION" />)
    expect(screen.getByText('PRE-SOLICITATION')).toBeInTheDocument()
    rerender(<RecordKindBadge kind="SOLICITATION" />)
    expect(screen.getByText('SOLICITATION')).toBeInTheDocument()
  })
})

describe('ConfidenceInterval — never fabricates certainty', () => {
  it('renders the exact unavailable label when no interval exists', () => {
    render(
      <ConfidenceInterval
        interval={{
          lower: null, point: 0.42, upper: null, available: false,
          confidence: 'INSUFFICIENT_DATA',
          reason: 'Only 2 verified outcomes fall in this band.',
          unavailableLabel: 'INSUFFICIENT DATA — INTERVAL NOT AVAILABLE',
        }}
      />,
    )
    expect(screen.getByText('INSUFFICIENT DATA — INTERVAL NOT AVAILABLE')).toBeInTheDocument()
    expect(screen.getByText(/Only 2 verified outcomes/)).toBeInTheDocument()
    // No numeric range may be shown when none is available.
    expect(screen.queryByText(/%\s*–\s*\d+%/)).not.toBeInTheDocument()
  })

  it('renders the range and confidence when an interval exists', () => {
    render(
      <ConfidenceInterval
        interval={{
          lower: 0.31, point: 0.42, upper: 0.55, available: true,
          confidence: 'MEDIUM', reason: 'Wilson 95% interval from 40 outcomes.', unavailableLabel: null,
        }}
      />,
    )
    expect(screen.getByText('31% – 55%')).toBeInTheDocument()
    expect(screen.getByText('MEDIUM confidence')).toBeInTheDocument()
  })
})

describe('DimensionRow — absent is not zero', () => {
  it('renders "Not assessable" for a null score', () => {
    render(<DimensionRow label="PSC fit" score={null} weight={0.1} absentReason="The notice has no PSC." />)
    expect(screen.getByText('Not assessable')).toBeInTheDocument()
    expect(screen.queryByText('0%')).not.toBeInTheDocument()
    expect(screen.getByText('The notice has no PSC.')).toBeInTheDocument()
  })

  it('renders a real zero as 0%', () => {
    render(<DimensionRow label="Geography fit" score={0} weight={0.06} evidence="No recorded coverage." />)
    expect(screen.getByText('0%')).toBeInTheDocument()
    expect(screen.queryByText('Not assessable')).not.toBeInTheDocument()
  })

  it('renders a scored dimension as a percentage', () => {
    render(<DimensionRow label="NAICS fit" score={0.5} weight={0.18} evidence="Half prefix overlap." />)
    expect(screen.getByText('50%')).toBeInTheDocument()
  })
})

describe('RateWithBasis — a rate always carries its denominator and basis', () => {
  it('renders the observed-award-share wording, not a win rate', () => {
    render(<RateWithBasis rate={0.3} basisLabel="Observed award share" sampleSize={20} />)
    expect(screen.getByText('30%')).toBeInTheDocument()
    expect(screen.getByText('Observed award share')).toBeInTheDocument()
    expect(screen.getByText(/n = 20/)).toBeInTheDocument()
    expect(screen.queryByText(/win rate/i)).not.toBeInTheDocument()
  })

  it('renders confirmed win rate only when the backend says so', () => {
    render(<RateWithBasis rate={0.4} basisLabel="Confirmed win rate" sampleSize={10} />)
    expect(screen.getByText('Confirmed win rate')).toBeInTheDocument()
  })

  it('says the sample is too small instead of showing a misleading percentage', () => {
    render(<RateWithBasis rate={null} basisLabel="Bid-participation data unavailable" sampleSize={1} />)
    expect(screen.getByText('No rate — sample too small')).toBeInTheDocument()
    expect(screen.getByText('Bid-participation data unavailable')).toBeInTheDocument()
  })
})

describe('EligibilityBadge', () => {
  it.each([
    ['ELIGIBLE', 'Eligible'],
    ['POSSIBLY_ELIGIBLE', 'Possibly eligible'],
    ['NOT_ELIGIBLE', 'Not eligible'],
    ['EXPIRING_BEFORE_DEADLINE', 'Expires before deadline'],
    ['INSUFFICIENT_DATA', 'Insufficient data'],
  ] as const)('renders %s as "%s"', (state, label) => {
    render(<EligibilityBadge state={state} reason="because" />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('exposes the reason on hover', () => {
    render(<EligibilityBadge state="NOT_ELIGIBLE" reason="Your certification expired." />)
    expect(screen.getByText('Not eligible').getAttribute('title')).toBe('Your certification expired.')
  })
})

describe('ExpiryBadge', () => {
  it('renders the backend-supplied label verbatim', () => {
    render(<ExpiryBadge state="EXPIRES_BEFORE_SUBMISSION" label="Expires before submission" message="Renew it first." />)
    expect(screen.getByText('Expires before submission')).toBeInTheDocument()
    expect(screen.getByText('Expires before submission').getAttribute('title')).toBe('Renew it first.')
  })
})

describe('FreshnessBadge — stale data is labelled stale', () => {
  it('shows the stale label when the source has not synced recently', () => {
    render(<FreshnessBadge freshness={{ isStale: true, ageHours: 96, label: 'Stale — last successful sync 96h ago' }} dataQuality="PARTIAL" />)
    expect(screen.getByText('Stale — last successful sync 96h ago')).toBeInTheDocument()
    expect(screen.getByText('PARTIAL')).toBeInTheDocument()
  })

  it('does not show a quality badge when the data is OK', () => {
    render(<FreshnessBadge freshness={{ isStale: false, ageHours: 1, label: 'Synced 1h ago' }} dataQuality="OK" />)
    expect(screen.getByText('Synced 1h ago')).toBeInTheDocument()
    expect(screen.queryByText('OK')).not.toBeInTheDocument()
  })
})

describe('SourceErrorPanel — a failing source never looks current', () => {
  it('says data may be out of date when a prior sync exists', () => {
    render(<SourceErrorPanel sourceName="Grants.gov" message="HTTP 500" lastSuccessfulSync="2026-05-01T00:00:00Z" />)
    expect(screen.getByText('Grants.gov is not syncing')).toBeInTheDocument()
    expect(screen.getByText(/may be out of date/i)).toBeInTheDocument()
  })

  it('says no data is shown when the source has never synced', () => {
    render(<SourceErrorPanel sourceName="State feed" message="Not configured" lastSuccessfulSync={null} />)
    expect(screen.getByText(/never synced successfully/i)).toBeInTheDocument()
  })
})

describe('PartialDataNotice', () => {
  it('lists every limitation', () => {
    render(<PartialDataNotice limitations={['No capabilities recorded.', 'NAICS fit could not be assessed.']} />)
    expect(screen.getByText('Based on incomplete data')).toBeInTheDocument()
    expect(screen.getByText('• No capabilities recorded.')).toBeInTheDocument()
    expect(screen.getByText('• NAICS fit could not be assessed.')).toBeInTheDocument()
  })

  it('renders nothing when there are no limitations', () => {
    const { container } = render(<PartialDataNotice limitations={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('formatters', () => {
  it('renders an em dash rather than a misleading zero for missing values', () => {
    expect(formatDate(null)).toBe('—')
    expect(formatDate('not a date')).toBe('—')
    expect(formatMoney(null)).toBe('—')
    expect(formatMoney('')).toBe('—')
  })

  it('formats dates and money', () => {
    expect(formatDate('2027-03-15T12:00:00Z')).toBe('2027-03-15')
    expect(formatMoney(1_500_000)).toBe('$1.50M')
    expect(formatMoney('2500')).toBe('$3K')
  })
})
