import { TRICKTIONARY_RULES_ID } from '../store/schema.js'

import type { DataSources } from '../store/firestoreDataSource.js'
import type { TrickCompletionDoc } from '../store/schema.js'

/** Completed tricks in total and per Tricktionary level, lowest level first */
export async function checklistStats (completions: readonly TrickCompletionDoc[], dataSources: DataSources) {
  const trickLevels = await dataSources.trickLevels.findManyByRuleset(TRICKTIONARY_RULES_ID, { ttl: 3600 })
  const levelOfTrick = new Map(trickLevels.map(trickLevel => [trickLevel.trickId, trickLevel.level]))

  const totals = new Map<string, number>()
  for (const level of levelOfTrick.values()) totals.set(level, (totals.get(level) ?? 0) + 1)

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
    levels: [...totals.entries()]
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([level, total]) => ({ level, completed: completedPerLevel.get(level) ?? 0, total }))
  }
}
