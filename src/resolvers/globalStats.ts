import { Timestamp } from '@google-cloud/firestore'
import { subMonths } from 'date-fns'
import { averagePerAthlete } from '../helpers/globalStats.js'

import type { Resolvers } from '../generated/graphql.js'

export const globalStatsResolvers: Resolvers = {
  Query: {
    async globalStats (_, args, { dataSources }) {
      return await dataSources.globalStats.findLatest({ ttl: 3600 }) ?? null
    },
    async globalStatsHistory (_, args, { dataSources }) {
      return await dataSources.globalStats.findManyCountedSince(Timestamp.fromDate(subMonths(new Date(), 12)), { ttl: 3600 })
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
