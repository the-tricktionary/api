import { averagePerAthlete, cachedGlobalStats } from '../helpers/globalStats.js'

import type { Resolvers } from '../generated/graphql.js'

export const globalStatsResolvers: Resolvers = {
  Query: {
    async globalStats (_, args, { dataSources }) {
      const [latest] = await cachedGlobalStats('latest', async () => {
        const stats = await dataSources.globalStats.findLatest()
        return stats ? [stats] : []
      })
      return latest ?? null
    },
    async globalStatsHistory (_, { from, until }, { dataSources }) {
      return await cachedGlobalStats(
        `history:${from?.toMillis() ?? ''}:${until?.toMillis() ?? ''}`,
        async () => await dataSources.globalStats.findManyCountedBetween({ from, until })
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
