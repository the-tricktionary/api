import { InMemoryLRUCache } from '@apollo/utils.keyvaluecache'
import { tricktionaryLevels } from './checklist.js'

import type { GlobalStatsDoc, TrickCompletionDoc, TrickLevelDoc } from '../store/schema.js'

type Completion = Pick<TrickCompletionDoc, 'userId' | 'memberId' | 'trickId'>

/**
 * An athlete is their user, or their group member when they have no account.
 * Completions of unlevelled or deleted tricks count only towards the total.
 */
export async function tallyCompletions (completions: AsyncIterable<Completion>, trickLevels: readonly TrickLevelDoc[]) {
  const { levelOfTrick, totals } = tricktionaryLevels(trickLevels)

  let total = 0
  const perLevel = new Map<string, number>()
  const perAthlete = new Map<string, number>()
  for await (const completion of completions) {
    total++

    const athlete = completion.userId != null ? `user:${completion.userId}` : `member:${completion.memberId}`
    perAthlete.set(athlete, (perAthlete.get(athlete) ?? 0) + 1)

    const level = levelOfTrick.get(completion.trickId)
    if (level != null) perLevel.set(level, (perLevel.get(level) ?? 0) + 1)
  }

  let maxCompletions = 0
  for (const count of perAthlete.values()) maxCompletions = Math.max(maxCompletions, count)

  return {
    completions: total,
    athletes: perAthlete.size,
    maxCompletions,
    levels: totals.map(([level, tricks]) => ({ level, tricks, completions: perLevel.get(level) ?? 0 }))
  } satisfies Partial<GlobalStatsDoc>
}

export function averagePerAthlete (completions: number, athletes: number) {
  return athletes > 0 ? completions / athletes : 0
}

/** Query results for an hour, the snapshots change once a week */
const cache = new InMemoryLRUCache<GlobalStatsDoc[]>({ maxSize: 5 * 2 ** 20 })
const TTL_SECONDS = 3600

export async function cachedGlobalStats (key: string, find: () => Promise<GlobalStatsDoc[]>) {
  const hit = await cache.get(key)
  if (hit) return hit
  const snapshots = await find()
  await cache.set(key, snapshots, { ttl: TTL_SECONDS })
  return snapshots
}
