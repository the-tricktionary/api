import { Timestamp } from '@google-cloud/firestore'
import type { Resolvers } from '../generated/graphql'
import type { TrickCompletionDoc, TrickDoc } from '../store/schema'
import { AuthorizationError } from '../errors'

export const trickCompletionResolvers: Resolvers = {
  Mutation: {
    async createTrickCompletion (_, { trickId }, { dataSources, allowUser, user }) {
      allowUser.editTrickCompletions.assert()
      if (!user) throw new AuthorizationError()
      const existing = (await dataSources.trickCompletions.findManyByQuery(c => c.where('userId', '==', user.id).where('trickId', '==', trickId)))[0]

      if (!existing) return dataSources.trickCompletions.createOne({ trickId, userId: user.id, createdAt: Timestamp.now() }) as Promise<TrickCompletionDoc>
      else return existing
    },
    async deleteTrickCompletion (_, { trickId }, { dataSources, allowUser, user }) {
      allowUser.editTrickCompletions.assert()
      if (!user) throw new AuthorizationError()
      const existing = (await dataSources.trickCompletions.findManyByQuery(c => c.where('userId', '==', user.id).where('trickId', '==', trickId)))[0]

      if (existing) {
        await dataSources.trickCompletions.deleteOne(existing.id)
        return existing
      } else {
        return null
      }
    }
  },
  TrickCompletion: {
    async trick (trickCompletion, _, { dataSources }) {
      return dataSources.tricks.findOneById(trickCompletion.trickId) as Promise<TrickDoc>
    }
  }
}
