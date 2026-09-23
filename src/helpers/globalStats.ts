import type { GlobalLevelStats, GlobalStatsDoc, TrickCompletionDoc, TrickLevelDoc } from '../store/schema.js'

type Completion = Pick<TrickCompletionDoc, 'userId' | 'memberId' | 'trickId'>

/**
 * Completions in total, per Tricktionary level and per athlete, counting an
 * athlete with an account by their user and one a group manages by their
 * member. Unlevelled tricks, deleted ones included, count only towards the
 * total, like on a profile.
 */
export async function tallyCompletions (completions: AsyncIterable<Completion>, trickLevels: readonly TrickLevelDoc[]) {
  const levelOfTrick = new Map(trickLevels.map(trickLevel => [trickLevel.trickId, trickLevel.level]))

  const tricksPerLevel = new Map<string, number>()
  for (const level of levelOfTrick.values()) tricksPerLevel.set(level, (tricksPerLevel.get(level) ?? 0) + 1)

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

  const levels: GlobalLevelStats[] = [...tricksPerLevel.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([level, tricks]) => ({ level, tricks, completions: perLevel.get(level) ?? 0 }))

  return { completions: total, athletes: perAthlete.size, maxCompletions, levels } satisfies Partial<GlobalStatsDoc>
}

/** Per athlete with at least one completed trick, 0 before anyone completed one */
export function averagePerAthlete (completions: number, athletes: number) {
  return athletes > 0 ? completions / athletes : 0
}
