import { allGlobalStats, averagePerAthlete } from '../helpers/globalStats.js'

import type { Resolvers } from '../generated/graphql.js'

export const globalStatsResolvers: Resolvers = {
  Query: {
    async globalStats (_, args, { dataSources }) {
      return (await allGlobalStats(dataSources)).at(-1) ?? null
    },
    async globalStatsHistory (_, { from, until }, { dataSources }) {
      return (await allGlobalStats(dataSources)).filter(stats =>
        (from == null || stats.countedAt.toMillis() >= from.toMillis()) &&
        (until == null || stats.countedAt.toMillis() < until.toMillis())
      )
    }
  },
  GlobalStats: {
    averageCompletions (stats) {
      return averagePerAthlete(stats.completions, stats.athletes)
    },
    levels (stats) {
      return stats.levels.map(level => ({ ...level, averageCompletions: averagePerAthlete(level.completions, stats.athletes) }))
    }
  }
}
