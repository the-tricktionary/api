import { ApolloError } from 'apollo-server'
import type { Resolvers } from '../generated/graphql'

export const userResolvers: Resolvers = {
  Query: {
    async me (_, args, { dataSources, user }) {
      return user ?? null
    }
  },
  User: {
    async checklist (user, _, { dataSources, allowUser }) {
      allowUser.user(user).getChecklist.assert()

      return dataSources.trickCompletions.findManyByUser(user.id)
    },
    async speedResults (user, { limit, startAfter }, { dataSources, allowUser }) {
      allowUser.user(user).getSpeedResults.assert()

      return dataSources.speedResults.findManyByUser(user.id, { ttl: 60, limit, startAfter })
    },
    async speedResult (user, { speedResultId }, { dataSources, allowUser }) {
      const speedResult = await dataSources.speedResults.findOneById(speedResultId, { ttl: 60 })
      if (!speedResult) throw new ApolloError(`Speed result with id ${speedResultId} not found`)
      allowUser.user(user).speedResult(speedResult).get.assert()

      return speedResult
    }
  }
}
