// =============================================================
// §8.2 — Resource allocation and remaining capacity.
//
// TimeEntry records what happened. ResourceAllocation records what is planned.
// Capacity needs both, and neither substitutes for the other.
//
// The honesty rule that shapes this: with no allocations recorded, capacity is
// INSUFFICIENT_DATA — never "100% available". Reporting a firm as fully
// available because nobody has entered a plan is the single most damaging thing
// this service could do, because it invites bidding work the team cannot staff.
//
// This is NOT the qualification-capacity engine. It answers an operational
// staffing question and exposes a read-only view a later slice can consult; it
// never writes a recommendation, decision or pursuit stage.
// =============================================================
import { AllocationStatus, Prisma } from '@prisma/client'
import { prisma } from '../../config/database'

type Dec = Prisma.Decimal
const ZERO = new Prisma.Decimal(0)
const D = (v: Prisma.Decimal | number | string | null | undefined): Dec => new Prisma.Decimal(v ?? 0)

/** One person is 100%. Allocation above this across overlapping work is a conflict. */
export const FULL_CAPACITY_PERCENT = 100

export type CapacityState = 'INSUFFICIENT_DATA' | 'AVAILABLE' | 'NEAR_CAPACITY' | 'OVER_ALLOCATED'

export interface PersonCapacity {
  userId: string
  name: string
  allocatedPercent: number
  remainingPercent: number
  state: CapacityState
  allocations: Array<{
    id: string
    contractId: string
    contractNumber: string | null
    allocationPercent: number
    startDate: string
    endDate: string | null
    laborCategory: string | null
    status: AllocationStatus
  }>
  conflict: boolean
}

export interface CapacitySnapshot {
  windowStart: string
  windowEnd: string | null
  state: CapacityState
  dataNote: string
  peopleWithPlans: number
  totalAllocationPercent: number
  people: PersonCapacity[]
  conflicts: Array<{ userId: string; name: string; allocatedPercent: number }>
  /** Approved hours in the trailing window — evidence, never a substitute for a plan. */
  recentActualHours: string | null
}

const ACTIVE_STATUSES: AllocationStatus[] = [AllocationStatus.PLANNED, AllocationStatus.ACTIVE]

/** Half-open overlap: an allocation ending the day another starts is not a conflict. */
export function allocationOverlaps(
  aStart: Date, aEnd: Date | null,
  bStart: Date, bEnd: Date | null,
): boolean {
  if (aEnd && aEnd <= bStart) return false
  if (bEnd && bEnd <= aStart) return false
  return true
}

function stateFor(allocated: Dec): CapacityState {
  if (allocated.greaterThan(FULL_CAPACITY_PERCENT)) return 'OVER_ALLOCATED'
  if (allocated.greaterThanOrEqualTo(85)) return 'NEAR_CAPACITY'
  return 'AVAILABLE'
}

/**
 * Firm-wide capacity across a window.
 *
 * `windowEnd` null means open-ended, in which case every allocation that has not
 * already finished counts.
 */
export async function computeCapacity(
  consultingFirmId: string,
  windowStart: Date,
  windowEnd: Date | null,
  options: { trailingActualDays?: number } = {},
): Promise<CapacitySnapshot> {
  const trailingDays = options.trailingActualDays ?? 30

  const [allocations, recentTime] = await Promise.all([
    prisma.resourceAllocation.findMany({
      where: { consultingFirmId, status: { in: ACTIVE_STATUSES } },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
        contract: { select: { id: true, contractNumber: true } },
      },
    }),
    prisma.timeEntry.aggregate({
      where: {
        consultingFirmId,
        status: 'APPROVED',
        workDate: { gte: new Date(windowStart.getTime() - trailingDays * 86_400_000) },
      },
      _sum: { hours: true },
    }),
  ])

  const inWindow = allocations.filter((a) => allocationOverlaps(a.startDate, a.endDate, windowStart, windowEnd))

  if (inWindow.length === 0) {
    return {
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd ? windowEnd.toISOString() : null,
      state: 'INSUFFICIENT_DATA',
      dataNote:
        'No resource allocations cover this window, so remaining capacity cannot be assessed. This is not a statement that the team is available.',
      peopleWithPlans: 0,
      totalAllocationPercent: 0,
      people: [],
      conflicts: [],
      recentActualHours: recentTime._sum.hours ? D(recentTime._sum.hours).toFixed(2) : null,
    }
  }

  const byUser = new Map<string, typeof inWindow>()
  for (const a of inWindow) {
    const list = byUser.get(a.userId) ?? []
    list.push(a)
    byUser.set(a.userId, list)
  }

  const people: PersonCapacity[] = [...byUser.entries()].map(([userId, rows]) => {
    const allocated = rows.reduce((s, r) => s.plus(D(r.allocationPercent)), ZERO)
    const remaining = D(FULL_CAPACITY_PERCENT).minus(allocated)
    const u = rows[0].user
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email
    return {
      userId,
      name,
      allocatedPercent: Number(allocated.toDecimalPlaces(2)),
      remainingPercent: Number(remaining.toDecimalPlaces(2)),
      state: stateFor(allocated),
      conflict: allocated.greaterThan(FULL_CAPACITY_PERCENT),
      allocations: rows.map((r) => ({
        id: r.id,
        contractId: r.contractId,
        contractNumber: r.contract?.contractNumber ?? null,
        allocationPercent: Number(D(r.allocationPercent).toDecimalPlaces(2)),
        startDate: r.startDate.toISOString(),
        endDate: r.endDate ? r.endDate.toISOString() : null,
        laborCategory: r.laborCategory,
        status: r.status,
      })),
    }
  }).sort((a, b) => b.allocatedPercent - a.allocatedPercent)

  const conflicts = people.filter((p) => p.conflict).map((p) => ({ userId: p.userId, name: p.name, allocatedPercent: p.allocatedPercent }))
  const total = people.reduce((s, p) => s + p.allocatedPercent, 0)

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd ? windowEnd.toISOString() : null,
    state: conflicts.length > 0 ? 'OVER_ALLOCATED' : stateFor(D(total / people.length)),
    dataNote:
      'Capacity covers only people with a recorded allocation. Anyone without a plan is absent from this view rather than counted as available.',
    peopleWithPlans: people.length,
    totalAllocationPercent: Number(total.toFixed(2)),
    people,
    conflicts,
    recentActualHours: recentTime._sum.hours ? D(recentTime._sum.hours).toFixed(2) : null,
  }
}

export interface PursuitCapacityRead {
  state: CapacityState
  peopleWithPlans: number
  freeCapacityPercent: number | null
  conflicts: number
  note: string
}

/**
 * Read-only capacity signal for a pursuit period.
 *
 * Deliberately advisory. It returns a state and evidence and nothing else — it
 * does not touch QualificationRecommendation, BidDecision or pipeline stage,
 * and no autonomous decision is made anywhere from this value.
 */
export async function readCapacityForPursuitWindow(
  consultingFirmId: string,
  start: Date,
  end: Date | null,
): Promise<PursuitCapacityRead> {
  const snap = await computeCapacity(consultingFirmId, start, end)
  if (snap.state === 'INSUFFICIENT_DATA') {
    return {
      state: 'INSUFFICIENT_DATA',
      peopleWithPlans: 0,
      freeCapacityPercent: null,
      conflicts: 0,
      note: 'No staffing plan covers this period, so capacity for this pursuit cannot be assessed.',
    }
  }
  const free = snap.people.reduce((s, p) => s + Math.max(0, p.remainingPercent), 0)
  return {
    state: snap.state,
    peopleWithPlans: snap.peopleWithPlans,
    freeCapacityPercent: Number(free.toFixed(2)),
    conflicts: snap.conflicts.length,
    note: 'Advisory only. Capacity is reported as evidence and never changes a qualification or bid decision.',
  }
}
