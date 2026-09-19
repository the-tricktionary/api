import { FieldValue, Timestamp } from '@google-cloud/firestore'
import { AuthorizationError, NotFoundError, ValidationError } from '../errors.js'
import { GrantType } from '../generated/graphql.js'
import { firestore } from '../store/firestoreDataSource.js'
import { TRICKTIONARY_RULES_ID } from '../store/schema.js'
import { grantsSchema, langSchema, profileOptionsSchema, userProfileInputSchema, usernameSchema } from '../validation.js'
import { byEventOrder } from './eventDefinitions.js'

import type { Resolvers } from '../generated/graphql.js'
import type { DataSources } from '../store/firestoreDataSource.js'
import type { UserDoc } from '../store/schema.js'

/**
 * Moves the user to a username, or off one when it's null, and returns the
 * user as they are afterwards. Firestore can only keep a field unique through
 * a document per value, so a claim is a document in `usernames` named after
 * the handle: claiming the new one, releasing the old one and updating the
 * user happen in one transaction, so a handle is never held by two users and
 * never left reserved by a user who gave it up.
 */
async function moveUsername (user: UserDoc, username: string | null, name: string, dataSources: DataSources): Promise<UserDoc> {
  const usernames = dataSources.usernames.collection
  const users = dataSources.users.collection

  await firestore.runTransaction(async tx => {
    // a transaction reads everything it needs before it writes anything
    const claim = username != null ? await tx.get(usernames.doc(username)) : undefined
    if (claim?.exists && claim.data()?.userId !== user.id) {
      throw new ValidationError('That username is taken', { extensions: { field: 'username', reason: 'taken' } })
    }

    const now = Timestamp.now()
    if (username != null && !claim?.exists) {
      tx.create(usernames.doc(username), { id: username, collection: 'usernames', userId: user.id, createdAt: now, updatedAt: now })
    }
    // the handle the user is leaving is free for anyone else to take
    if (user.username != null && user.username !== username) tx.delete(usernames.doc(user.username))

    // update skips the converter, so the timestamps stay Firestore's own
    tx.update(users.doc(user.id), {
      name,
      username: username ?? FieldValue.delete()
    })
  })

  // the transaction wrote past the data source, so its copy is stale
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
      const query = usernameOrId.trim()
      if (!query) return null

      // usernames are lowercase while uids are case sensitive, so only the
      // username lookup gets the lowercased argument, and only when the
      // argument could be a username at all. Both are looked up and the id
      // wins, so nobody can claim an all-lowercase uid as their username and
      // sit in front of its owner's profile.
      const username = usernameSchema.safeParse(query)
      const [byId, byUsername] = await Promise.all([
        dataSources.users.findOneById(query, { ttl: 60 }),
        username.success ? dataSources.users.findOneByUsername(username.data, { ttl: 60 }) : undefined
      ])
      const found = byId ?? byUsername

      // a profile that isn't public reads the same as a user that isn't there
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
    async updateUserProfile (_, { data: rawData }, { dataSources, allowUser, user }) {
      allowUser.editProfile.assert()
      if (!user) throw new AuthorizationError()

      const data = userProfileInputSchema.parse(rawData)

      // only a change of username needs the reservations, and with them a
      // transaction
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

      // both carry the trick id, so the tricks themselves are never read; a
      // completion of a trick that has since been deleted still counts, which
      // is a fair reflection of what the user did
      const [completions, trickLevels] = await Promise.all([
        dataSources.trickCompletions.findManyByUser(user.id, { ttl: 60 }),
        dataSources.trickLevels.findManyByRuleset(TRICKTIONARY_RULES_ID, { ttl: 3600 })
      ])

      const levelOfTrick = new Map(trickLevels.map(trickLevel => [trickLevel.trickId, trickLevel.level]))

      const totals = new Map<string, number>()
      for (const level of levelOfTrick.values()) totals.set(level, (totals.get(level) ?? 0) + 1)

      const completedPerLevel = new Map<string, number>()
      for (const completion of completions) {
        const level = levelOfTrick.get(completion.trickId)
        // tricks without a tricktionary level only count towards the total
        if (level == null) continue
        completedPerLevel.set(level, (completedPerLevel.get(level) ?? 0) + 1)
      }

      return {
        completed: completions.length,
        levels: [...totals.entries()]
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([level, total]) => ({ level, completed: completedPerLevel.get(level) ?? 0, total }))
      }
    },
    async speedResults (user, { limit, startAfter, eventDefinitionId }, { dataSources, allowUser }) {
      allowUser.user(user).getSpeedResults.assert()

      return await dataSources.speedResults.findManyByUser(user.id, { ttl: 60, limit, startAfter, eventDefinitionId })
    },
    async speedResult (user, { speedResultId }, { dataSources, allowUser }) {
      const speedResult = await dataSources.speedResults.findOneById(speedResultId, { ttl: 60 })
      if (!speedResult) throw new NotFoundError(`Speed result with id ${speedResultId} not found`, {})
      allowUser.user(user).speedResult(speedResult).get.assert()

      return speedResult
    },
    async speedPersonalBests (user, _, { dataSources, allowUser }) {
      allowUser.user(user).getSpeedPersonalBests.assert()

      // a custom event is one result's own, only the predefined events are
      // comparable enough to have a personal best
      const eventDefinitions = (await dataSources.eventDefinitions.findManyByQuery(c => c, { ttl: 3600 }))
        .sort(byEventOrder)

      const bests = await Promise.all(eventDefinitions.map(async eventDefinition =>
        await dataSources.speedResults.findBestByUserAndEvent(user.id, eventDefinition.id, { ttl: 60 })
      ))

      return bests.filter(best => best != null)
    }
  }
}
