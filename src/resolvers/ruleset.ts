import z from 'zod'
import { CollisionError, NotFoundError } from '../errors'

import type { Resolvers } from '../generated/graphql'
import type { RulesetDoc } from '../store/schema'

/** e.g. `tricktionary`, `ijru@5.0.0` */
const rulesIdSchema = z.string().regex(/^[a-z0-9-]+(@[0-9]+(\.[0-9]+)*)?$/, 'A rules ID may only contain lowercase letters, numbers and dashes, optionally followed by a version (e.g. `ijru@5.0.0`)')

const namesSchema = z.array(z.object({
  lang: z.string().trim().min(1, 'A language tag is required'),
  value: z.string().trim().min(1, 'A name is required')
}))
  .min(1, 'At least one name is required')
  .refine(names => new Set(names.map(name => name.lang)).size === names.length, 'Each language may only be specified once')
  .refine(names => names.some(name => name.lang === 'en'), 'An english (`en`) name is required')
  .transform(names => Object.fromEntries(names.map(name => [name.lang, name.value])))

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
      const parsedNames = namesSchema.parse(names)

      const existing = await dataSources.rulesets.findOneById(id)
      if (existing) throw new CollisionError(`A ruleset with the id ${id} already exists`, { extensions: { entity: 'ruleset', id } })

      const ruleset = await (dataSources.rulesets.createOne({
        id,
        names: parsedNames,
        isPrimary: false
      }) as Promise<RulesetDoc>)
      await dataSources.rulesets.deleteFromCacheById(id)

      return ruleset
    },
    async updateRuleset (_, { rulesId, names }, { dataSources, allowUser }) {
      allowUser.editRuleset.assert()
      const id = rulesIdSchema.parse(rulesId)
      const parsedNames = namesSchema.parse(names)

      const existing = await dataSources.rulesets.findOneById(id)
      if (!existing) throw new NotFoundError(`Ruleset ${id} not found`, { extensions: { entity: 'ruleset', id } })

      const ruleset = await (dataSources.rulesets.updateOne({
        id,
        names: parsedNames,
        isPrimary: existing.isPrimary
      }) as Promise<RulesetDoc>)
      await dataSources.rulesets.deleteFromCacheById(id)

      return ruleset
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
      return ruleset.names[lang ?? 'en'] ?? ruleset.names.en
    },
    names (ruleset) {
      return Object.entries(ruleset.names)
        .map(([lang, value]) => ({ lang, value }))
        .sort((a, b) => a.lang.localeCompare(b.lang))
    }
  }
}
