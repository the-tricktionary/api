import { averagePerAthlete } from '../helpers/globalStats.js'

import type { Resolvers } from '../generated/graphql.js'

export const globalStatsResolvers: Resolvers = {
  Query: {
    async globalStats (_, args, { dataSources }) {
      return await dataSources.globalStats.findLatest() ?? null
    },
    async globalStatsHistory (_, { from, until }, { dataSources }) {
      return await dataSources.globalStats.findManyCountedBetween({ from, until })
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
