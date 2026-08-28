// =============================================================
// Who-Wins — corpus loading.
//
// Cursor-batched, chronological load of public_award_training. A single
// findMany over the multi-million-row corpus fails inside Prisma
// ("Failed to convert rust String into napi string"): the engine
// serializes the whole result as ONE JSON string and V8 caps string
// length — hit at ~2.5M rows. 200k-row pages stay far under the cap
// while preserving (actionDate, id) order for the incumbency and
// leakage-safe feature passes.
// =============================================================

import { prisma } from '../../config/database'

export async function loadAwardsChronologically<T extends object>(
  select: Record<string, boolean>,
  pageSize = 200_000,
): Promise<T[]> {
  const all: T[] = []
  let cursor: string | null = null
  for (;;) {
    const page: (T & { id: string })[] = await prisma.publicAwardTraining.findMany({
      select: { ...select, id: true },
      orderBy: [{ actionDate: 'asc' }, { id: 'asc' }],
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }) as (T & { id: string })[]
    if (page.length === 0) break
    // Loop-push — push(...page) passes 200k call arguments and overflows
    // the stack (V8 caps argument counts far below that).
    for (const row of page) all.push(row)
    cursor = page[page.length - 1].id
    if (page.length < pageSize) break
  }
  return all
}
