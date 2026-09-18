import { NotFoundError, ValidationError } from '../errors.js'
import { GrantType } from '../generated/graphql.js'
import { grantsSchema } from '../validation.js'

import type { Resolvers } from '../generated/graphql.js'
import type { UserDoc } from '../store/schema.js'

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

      const users = new Map<string, UserDoc>()
      for (const found of [...byEmail, ...byUsername, ...(byId ? [byId] : [])]) users.set(found.id, found)

      return [...users.values()]
    },
    async usersWithGrants (_, args, { dataSources, allowUser }) {
      allowUser.getUsersWithGrants.assert()
      return await dataSources.users.findManyWithGrants()
    }
  },
  Mutation: {
    async setUserGrants (_, { userId, grants }, { dataSources, allowUser, user }) {
      allowUser.setUserGrants.assert()

      const target = await dataSources.users.findOneById(userId)
      if (!target) throw new NotFoundError(`User ${userId} not found`, { extensions: { entity: 'user', id: userId } })

      const parsedGrants = grantsSchema.parse(grants)
      if (user?.id === userId && !parsedGrants.some(grant => grant.type === GrantType.SuperAdmin)) {
        throw new ValidationError('You cannot remove your own super admin grant')
      }

      const rulesIds = new Set(parsedGrants.flatMap(grant => grant.type === GrantType.LevelEditor ? [grant.rulesId] : []))
      await Promise.all([...rulesIds].map(async rulesId => {
        const ruleset = await dataSources.rulesets.findOneById(rulesId)
        if (!ruleset) throw new NotFoundError(`Ruleset ${rulesId} not found`, { extensions: { entity: 'ruleset', id: rulesId } })
      }))

      const langs = new Set(parsedGrants.flatMap(grant => grant.type === GrantType.Translator ? [grant.lang] : []))
      await Promise.all([...langs].map(async lang => {
        const language = await dataSources.languages.findOneById(lang)
        if (!language) throw new NotFoundError(`Language ${lang} not found`, { extensions: { entity: 'language', id: lang } })
      }))

      return await (dataSources.users.updateOnePartial(userId, { grants: parsedGrants }) as Promise<UserDoc>)
    }
  },
  User: {
    // neither field throws, other users simply don't get to see them
    grants (user, _, { allowUser }) {
      if (!allowUser.user(user).getGrants()) return []
      return user.grants ?? []
    },
    email (user, _, { allowUser }) {
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
