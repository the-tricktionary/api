import { CollisionError, NotFoundError } from '../errors.js'
import { localised, localisedStrings } from '../helpers/localised.js'
import { localisedStringsSchema, rulesIdSchema } from '../validation.js'

import type { Resolvers } from '../generated/graphql.js'
import type { RulesetDoc } from '../store/schema.js'

export const rulesetResolvers: Resolvers = {
  Query: {
    async rulesets (_, args, { dataSources }) {
      return await dataSources.rulesets.findAll({ ttl: 3600 })
    }
  },
  Mutation: {
    async createRuleset (_, { rulesId, names }, { dataSources, allowUser }) {
      allowUser.createRuleset.assert()
      const id = rulesIdSchema.parse(rulesId)
      const parsedNames = localisedStringsSchema.parse(names)

      await Promise.all(Object.keys(parsedNames).map(async lang => {
        const language = await dataSources.languages.findOneById(lang)
        if (!language) throw new NotFoundError(`Language ${lang} not found`, { extensions: { entity: 'language', id: lang } })
      }))

      const existing = await dataSources.rulesets.findOneById(id)
      if (existing) throw new CollisionError(`A ruleset with the id ${id} already exists`, { extensions: { entity: 'ruleset', id } })

      return await (dataSources.rulesets.createOne({
        id,
        names: parsedNames,
        isPrimary: false
      }) as Promise<RulesetDoc>)
    },
    async updateRuleset (_, { rulesId, names }, { dataSources, allowUser }) {
      allowUser.editRuleset.assert()
      const id = rulesIdSchema.parse(rulesId)
      const parsedNames = localisedStringsSchema.parse(names)

      await Promise.all(Object.keys(parsedNames).map(async lang => {
        const language = await dataSources.languages.findOneById(lang)
        if (!language) throw new NotFoundError(`Language ${lang} not found`, { extensions: { entity: 'language', id: lang } })
      }))

      const existing = await dataSources.rulesets.findOneById(id)
      if (!existing) throw new NotFoundError(`Ruleset ${id} not found`, { extensions: { entity: 'ruleset', id } })

      return await (dataSources.rulesets.updateOne({
        id,
        names: parsedNames,
        isPrimary: existing.isPrimary
      }) as Promise<RulesetDoc>)
    },
    async setPrimaryRuleset (_, { rulesId }, { dataSources, allowUser }) {
      allowUser.setPrimaryRuleset.assert()
      const id = rulesIdSchema.parse(rulesId)

      const collection = dataSources.rulesets.collection
      const evict: string[] = []
      const ruleset = await collection.firestore.runTransaction(async t => {
        const dSnap = await t.get(collection.doc(id))
        const target = dSnap.data()
        if (!target) throw new NotFoundError(`Ruleset ${id} not found`, { extensions: { entity: 'ruleset', id } })
        const qSnap = await t.get(collection.where('isPrimary', '==', true))

        for (const primary of qSnap.docs) {
          if (primary.id === id) continue
          t.update(primary.ref, { isPrimary: false })
          evict.push(primary.id)
        }
        if (!target.isPrimary) {
          t.update(dSnap.ref, { isPrimary: true })
          evict.push(id)
        }

        return { ...target, isPrimary: true }
      })
      for (const evictId of evict) await dataSources.rulesets.deleteFromCacheById(evictId)

      return ruleset
    }
  },
  Ruleset: {
    name (ruleset, { lang }) {
      return localised(ruleset.names, lang)
    },
    names (ruleset) {
      return localisedStrings(ruleset.names)
    }
  }
}
