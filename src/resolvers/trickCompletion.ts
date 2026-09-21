import type { Resolvers } from '../generated/graphql.js'
import { existingMember, groupAndMembership } from '../helpers/groups.js'
import type { TrickCompletionDoc, TrickDoc } from '../store/schema.js'
import { AuthorizationError, NotFoundError } from '../errors.js'
import { checklistAthlete } from '../store/schema.js'

export const trickCompletionResolvers: Resolvers = {
  Mutation: {
    async createTrickCompletion (_, { trickId }, { dataSources, allowUser, user }) {
      allowUser.editTrickCompletions.assert()
      if (!user) throw new AuthorizationError()
      const existing = await dataSources.trickCompletions.findOneByAthleteAndTrick({ userId: user.id }, trickId)

      if (!existing) return await (dataSources.trickCompletions.createOne({ trickId, userId: user.id }) as Promise<TrickCompletionDoc>)
      else return existing
    },
    async deleteTrickCompletion (_, { trickId }, { dataSources, allowUser, user }) {
      allowUser.editTrickCompletions.assert()
      if (!user) throw new AuthorizationError()
      const existing = await dataSources.trickCompletions.findOneByAthleteAndTrick({ userId: user.id }, trickId)

      if (existing) {
        await dataSources.trickCompletions.deleteOne(existing.id)
        return existing
      } else {
        return null
      }
    },
    async setGroupMemberTrickCompletion (_, { memberId, trickId, completed }, context) {
      const { dataSources, user } = context
      const member = await existingMember(memberId, context)
      const { group, membership } = await groupAndMembership(member.groupId, context)
      context.allowUser.group(group, membership).editMemberChecklist.assert()
      if (!user) throw new AuthorizationError()

      const trick = await dataSources.tricks.findOneById(trickId, { ttl: 3600 })
      if (!trick) throw new NotFoundError(`Trick ${trickId} not found`, { extensions: { entity: 'trick', id: trickId } })

      const existing = await dataSources.trickCompletions.findOneByAthleteAndTrick(checklistAthlete(member), trickId)

      if (!completed) {
        if (existing) await dataSources.trickCompletions.deleteOne(existing.id)
        return null
      }
      if (existing) return existing

      return await (dataSources.trickCompletions.createOne({
        ...(member.userId != null ? { userId: member.userId } : { memberId: member.id }),
        trickId,
        recordedBy: user.id
      }) as Promise<TrickCompletionDoc>)
    }
  },
  TrickCompletion: {
    async trick (trickCompletion, _, { dataSources }) {
      return await (dataSources.tricks.findOneById(trickCompletion.trickId) as Promise<TrickDoc>)
    },
    async recordedBy (trickCompletion, _, { dataSources }) {
      if (trickCompletion.recordedBy == null) return null
      return await dataSources.users.findOneById(trickCompletion.recordedBy, { ttl: 60 }) ?? null
    }
  }
}
