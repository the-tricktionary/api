import { Timestamp } from '@google-cloud/firestore'
import { ApolloError } from 'apollo-server'
import type { Resolvers } from '../generated/graphql'
import type { TrickCompletionDoc, TrickDoc } from '../store/schema'

export const trickCompletionResolvers: Resolvers = {
  Mutation: {
    async setTrickCompletion (_, { trickId, completed }, { dataSources, allowUser, user }) {
      allowUser.editTrickCompletions.assert()
      if (!user) throw new ApolloError('You need to be logged in to perform this action')
      const existing = (await dataSources.trickCompletions.findManyByQuery(c => c.where('userId', '==', user?.id).where('trickId', '==', trickId)))[0]
      if (completed && existing) return existing ?? null
      else if (completed && !existing) return dataSources.trickCompletions.createOne({ trickId, userId: user.id, createdAt: Timestamp.now() }) as Promise<TrickCompletionDoc>
      else if (!completed && existing) {
        await dataSources.trickCompletions.deleteOne(existing.id)
        return existing ?? null
      } else return null
    }
  },
  TrickCompletion: {
    async trick (trickCompletion, _, { dataSources }) {
      return dataSources.tricks.findOneById(trickCompletion.trickId) as Promise<TrickDoc>
    }
  }
}
