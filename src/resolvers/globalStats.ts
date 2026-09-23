import { averagePerAthlete, recentGlobalStats } from '../helpers/globalStats.js'

import type { Resolvers } from '../generated/graphql.js'

export const globalStatsResolvers: Resolvers = {
  Query: {
    async globalStats (_, args, { dataSources }) {
      return (await recentGlobalStats(dataSources)).at(-1) ?? null
    },
    async globalStatsHistory (_, args, { dataSources }) {
      return await recentGlobalStats(dataSources)
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
