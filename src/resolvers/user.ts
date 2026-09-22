import { FieldValue, Timestamp } from '@google-cloud/firestore'
import { AuthorizationError, NotFoundError, ValidationError } from '../errors.js'
import { GrantType } from '../generated/graphql.js'
import { firestore } from '../store/firestoreDataSource.js'
import { checklistStats } from '../helpers/checklist.js'
import { membershipOf } from '../helpers/groups.js'
import { grantsSchema, langSchema, profileOptionsSchema, userProfileInputSchema } from '../validation.js'

import type { Resolvers } from '../generated/graphql.js'
import type { DataSources } from '../store/firestoreDataSource.js'
import type { UserDoc } from '../store/schema.js'

/**
 * Claims `username` (null releases the current one) and sets the name in one
 * transaction, the `usernames` documents being what keeps a handle unique.
 */
async function moveUsername (user: UserDoc, username: string | null, name: string, dataSources: DataSources): Promise<UserDoc> {
  const usernames = dataSources.usernames.collection
  const users = dataSources.users.collection

  await firestore.runTransaction(async tx => {
    const claim = username != null ? await tx.get(usernames.doc(username)) : undefined
    if (claim?.exists && claim.data()?.userId !== user.id) {
      throw new ValidationError('That username is taken', { extensions: { field: 'username', reason: 'taken' } })
    }

    const now = Timestamp.now()
    if (username != null && !claim?.exists) {
      tx.create(usernames.doc(username), { id: username, collection: 'usernames', userId: user.id, createdAt: now, updatedAt: now })
    }
    if (user.username != null && user.username !== username) tx.delete(usernames.doc(user.username))

    tx.update(users.doc(user.id), {
      name,
      username: username ?? FieldValue.delete()
    })
  })

  // the transaction bypassed the data source cache
  await dataSources.users.deleteFromCacheById(user.id)
  const updated = await dataSources.users.findOneById(user.id)
  if (!updated) throw new NotFoundError(`User ${user.id} not found`, { extensions: { entity: 'user', id: user.id } })
  return updated
}

export const userResolvers: Resolvers = {
  Query: {
    async me (_, args, { dataSources, user }) {
      return user ?? null
    },
    async user (_, { usernameOrId }, { dataSources, allowUser }) {
      const found = await dataSources.users.findOneByUsernameOrId(usernameOrId, { ttl: 60 })

      // private reads the same as missing
      if (!found || !allowUser.user(found).getProfile()) return null

      return found
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
    async setUserLang (_, { lang }, { dataSources, allowUser, user }) {
      allowUser.setUserLang.assert()
      if (!user) throw new AuthorizationError()

      if (lang == null) {
        return await (dataSources.users.updateOnePartial(user.id, { lang: FieldValue.delete() }) as Promise<UserDoc>)
      }

      const parsedLang = langSchema.parse(lang)
      const language = await dataSources.languages.findOneById(parsedLang)
      if (!language?.enabled) throw new NotFoundError(`Language ${parsedLang} not found`, { extensions: { entity: 'language', id: parsedLang } })

      return await (dataSources.users.updateOnePartial(user.id, { lang: parsedLang }) as Promise<UserDoc>)
    },
    async setUserTheme (_, { theme }, { dataSources, allowUser, user }) {
      allowUser.setUserTheme.assert()
      if (!user) throw new AuthorizationError()

      if (theme == null) {
        return await (dataSources.users.updateOnePartial(user.id, { theme: FieldValue.delete() }) as Promise<UserDoc>)
      }

      return await (dataSources.users.updateOnePartial(user.id, { theme }) as Promise<UserDoc>)
    },
    async updateUserProfile (_, { data: rawData }, { dataSources, allowUser, user }) {
      allowUser.editProfile.assert()
      if (!user) throw new AuthorizationError()

      const data = userProfileInputSchema.parse(rawData)

      if (data.username === (user.username ?? null)) {
        return await (dataSources.users.updateOnePartial(user.id, { name: data.name }) as Promise<UserDoc>)
      }

      return await moveUsername(user, data.username, data.name, dataSources)
    },
    async setProfileOptions (_, { data: rawData }, { dataSources, allowUser, user }) {
      allowUser.editProfile.assert()
      if (!user) throw new AuthorizationError()

      const profile = profileOptionsSchema.parse(rawData)

      return await (dataSources.users.updateOnePartial(user.id, { profile }) as Promise<UserDoc>)
    },
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
    async checklistStats (user, _, { dataSources, allowUser }) {
      allowUser.user(user).getChecklistStats.assert()

      const completions = await dataSources.trickCompletions.findManyByUser(user.id, { ttl: 60 })
      return await checklistStats(completions, dataSources)
    },
    async groups (user, _, { dataSources, allowUser }) {
      allowUser.user(user).getGroups.assert()

      const memberships = await dataSources.groupMembers.findManyByUser(user.id, { ttl: 60 })
      const groups = await dataSources.groups.findManyByIds(memberships.map(membership => membership.groupId), { ttl: 60 })

      return groups
        .filter(group => group != null)
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    async groupInvites (user, _, { dataSources, allowUser }) {
      allowUser.user(user).getGroupInvites.assert()

      return await dataSources.groupInvites.findManyPendingByUser(user.id, { ttl: 60 })
    },
    async speedResults (user, { limit, startAfter, eventDefinitionId, groupId }, { dataSources, allowUser }) {
      allowUser.user(user).getSpeedResults.assert()

      return await dataSources.speedResults.findManyFeedByUser(user.id, { ttl: 60, limit, startAfter, eventDefinitionId, groupId })
    },
    async speedResult (parent, { speedResultId }, { dataSources, allowUser, user }) {
      const speedResult = await dataSources.speedResults.findOneById(speedResultId, { ttl: 60 })
      if (!speedResult) throw new NotFoundError(`Speed result with id ${speedResultId} not found`, {})
      const membership = speedResult.groupId ? await membershipOf(speedResult.groupId, { dataSources, user }) : undefined
      allowUser.user(parent).speedResult(speedResult, membership).get.assert()

      return speedResult
    },
    async speedBests (user, _, { dataSources, allowUser }) {
      allowUser.user(user).getSpeedPersonalBests.assert()

      const eventDefinitions = await dataSources.eventDefinitions.findAllOrdered({ ttl: 3600 })
      return await dataSources.speedResults.findBestsByAthleteUser(user.id, eventDefinitions, { ttl: 60 })
    }
  }
}
