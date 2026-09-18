import { NotFoundError, ValidationError } from '../errors'
import { GrantType } from '../generated/graphql'
import { grantsSchema } from '../validation'

import type { Resolvers } from '../generated/graphql'
import type { UserDoc } from '../store/schema'

export const userResolvers: Resolvers = {
  Query: {
    async me (_, args, { dataSources, user }) {
      return user ?? null
    },
    async findUsers (_, { query }, { dataSources, allowUser }) {
      allowUser.findUsers.assert()

      const q = query.trim()
      if (!q) return []

      const [byEmail, byUsername, byId] = await Promise.all([
        dataSources.users.findManyByQuery(c => c.where('email', '==', q)),
        dataSources.users.findManyByQuery(c => c.where('username', '==', q)),
        dataSources.users.findOneById(q)
      ])

      const byIdList: UserDoc[] = byId ? [byId] : []
      const users = new Map<string, UserDoc>()
      for (const found of [...byEmail, ...byUsername, ...byIdList]) users.set(found.id, found)

      return [...users.values()].slice(0, 10)
    }
  },
  Mutation: {
    async setUserGrants (_, { userId, grants }, { dataSources, allowUser, user }) {
      allowUser.setUserGrants.assert()

      const target = await dataSources.users.findOneById(userId)
      if (!target) throw new NotFoundError(`User ${userId} not found`, { extensions: { entity: 'user', id: userId } })

      const parsedGrants = grantsSchema.parse(grants)

      const rulesIds = [...new Set(parsedGrants.flatMap(grant => grant.type === GrantType.LevelEditor ? [grant.rulesId] : []))]
      const rulesets = await Promise.all(rulesIds.map(async rulesId => [rulesId, await dataSources.rulesets.findOneById(rulesId)] as const))
      for (const [rulesId, ruleset] of rulesets) {
        if (!ruleset) throw new NotFoundError(`Ruleset ${rulesId} not found`, { extensions: { entity: 'ruleset', id: rulesId } })
      }

      if (user?.id === userId && !parsedGrants.some(grant => grant.type === GrantType.SuperAdmin)) {
        throw new ValidationError('You cannot remove your own super admin grant')
      }

      await dataSources.users.updateOnePartial(userId, { grants: parsedGrants })
      await dataSources.users.deleteFromCacheById(userId)

      const updated = await dataSources.users.findOneById(userId)
      if (!updated) throw new NotFoundError(`User ${userId} not found`, { extensions: { entity: 'user', id: userId } })

      return updated
    }
  },
  User: {
    grants (user, _, { allowUser }) {
      // We don't throw here, a user simply can't see anyone else's grants
      if (!allowUser.user(user).getGrants()) return []

      return user.grants ?? []
    },
    email (user, _, { allowUser }) {
      // We don't throw here, a user simply can't see anyone else's email
      if (!allowUser.user(user).getEmail()) return null

      return user.email ?? null
    },
    async checklist (user, _, { dataSources, allowUser }) {
      allowUser.user(user).getChecklist.assert()

      return await dataSources.trickCompletions.findManyByUser(user.id)
    },
    async speedResults (user, { limit, startAfter }, { dataSources, allowUser }) {
      allowUser.user(user).getSpeedResults.assert()

      return await dataSources.speedResults.findManyByUser(user.id, { ttl: 60, limit, startAfter })
    },
    async speedResult (user, { speedResultId }, { dataSources, allowUser }) {
      const speedResult = await dataSources.speedResults.findOneById(speedResultId, { ttl: 60 })
      if (!speedResult) throw new NotFoundError(`Speed result with id ${speedResultId} not found`, {})
      allowUser.user(user).speedResult(speedResult).get.assert()

      return speedResult
    }
  }
}
