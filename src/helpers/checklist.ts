import { TRICKTIONARY_RULES_ID } from '../store/schema.js'

import type { DataSources } from '../store/firestoreDataSource.js'
import type { TrickCompletionDoc, TrickLevelDoc } from '../store/schema.js'

/** Each trick's Tricktionary level, and the number of tricks per level, lowest level first */
export function tricktionaryLevels (trickLevels: readonly TrickLevelDoc[]) {
  const levelOfTrick = new Map(trickLevels.map(trickLevel => [trickLevel.trickId, trickLevel.level]))

  const totals = new Map<string, number>()
  for (const level of levelOfTrick.values()) totals.set(level, (totals.get(level) ?? 0) + 1)

  return {
    levelOfTrick,
    totals: [...totals.entries()].sort(([a], [b]) => Number(a) - Number(b))
  }
}

/** Completed tricks in total and per Tricktionary level, lowest level first */
export async function checklistStats (completions: readonly TrickCompletionDoc[], dataSources: DataSources) {
  const { levelOfTrick, totals } = tricktionaryLevels(await dataSources.trickLevels.findManyByRuleset(TRICKTIONARY_RULES_ID, { ttl: 3600 }))

  const completedPerLevel = new Map<string, number>()
  for (const completion of completions) {
    const level = levelOfTrick.get(completion.trickId)
    // unlevelled tricks only count towards completed
    if (level == null) continue
    completedPerLevel.set(level, (completedPerLevel.get(level) ?? 0) + 1)
  }

  return {
    // completions of deleted tricks still count
    completed: completions.length,
    levels: totals.map(([level, total]) => ({ level, completed: completedPerLevel.get(level) ?? 0, total }))
  }
}
