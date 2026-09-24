import { FieldPath, FieldValue } from 'firebase-admin/firestore'
import { AuthorizationError, CollisionError, NotFoundError, ValidationError } from '../errors.js'
import { TagValueType } from '../generated/graphql.js'
import { localised, localisedStrings } from '../helpers/localised.js'
import { byTagOrder, tagAppliesTo, tagValues, trickTagProblem } from '../helpers/tags.js'
import { tryIndexTricks } from '../services/algolia.js'
import { writeInChunks } from '../store/firestoreDataSource.js'
import { TRICK_TYPE_TAG_ID } from '../store/schema.js'
import { langSchema, tagIdSchema, tagInputSchema, tagLocalisationSchema } from '../validation.js'

import type z from 'zod'
import type { ApolloContext } from '../apollo.js'
import type { Resolvers } from '../generated/graphql.js'
import type { TagDoc, TagEnumValue, TrickDoc } from '../store/schema.js'

type ParsedTag = z.output<typeof tagInputSchema>
type TagFields = Omit<TagDoc, 'id' | 'collection' | 'createdAt' | 'updatedAt'>

/** How many offending tricks a refusal lists */
const LISTED_TRICKS = 10

async function existingTag (tagId: string, { dataSources }: Pick<ApolloContext, 'dataSources'>) {
  const tag = await dataSources.tags.findOneById(tagId)
  if (!tag) throw new NotFoundError(`Tag ${tagId} not found`, { extensions: { entity: 'tag', id: tagId } })
  return tag
}

/** Keeps the existing translations of the tag and of the values it keeps */
function tagFields (parsed: ParsedTag, existing: TagDoc | undefined, updatedBy: string): TagFields {
  return {
    valueType: parsed.valueType,
    names: { ...existing?.names, en: parsed.name },
    disciplines: parsed.disciplines,
    ...(parsed.min != null ? { min: parsed.min } : {}),
    ...(parsed.max != null ? { max: parsed.max } : {}),
    ...(parsed.step != null ? { step: parsed.step } : {}),
    ...(parsed.valueType === TagValueType.Enum
      ? {
          multiple: parsed.multiple ?? false,
          values: Object.fromEntries((parsed.values ?? []).map((value, order): [string, TagEnumValue] => [value.id, {
            names: { ...existing?.values?.[value.id]?.names, en: value.name },
            order
          }]))
        }
      : {}),
    ...(parsed.required === true ? { required: true as const } : {}),
    ...(existing?.system ? { system: true as const } : {}),
    updatedBy
  }
}

/** Changes when the tag's English search names change */
function englishSearchNames (tag: Pick<TagDoc, 'names' | 'values'>) {
  return [tag.names.en, ...tagValues(tag).map(value => `${value.id}=${value.names.en}`)].join('\n')
}

/** Removes the name when empty, leaves it alone when absent */
function withName (names: Record<string, string>, lang: string, name: string | null | undefined) {
  if (name == null) return names
  const others = Object.fromEntries(Object.entries(names).filter(([key]) => key !== lang))
  return name === '' ? others : { ...others, [lang]: name }
}

function refuse (message: string, problems: Array<{ trick: TrickDoc, problem: string }>): never {
  const listed = problems.slice(0, LISTED_TRICKS).map(({ trick, problem }) => `${trick.slug} (${trick.discipline}): ${problem}`)
  const more = problems.length > LISTED_TRICKS ? `, and ${problems.length - LISTED_TRICKS} more` : ''
  throw new ValidationError(`${message}: ${listed.join('; ')}${more}`)
}

/** Every trick holds one of the trick type tag's values */
function assertSystemTagShape (existing: TagDoc, parsed: ParsedTag) {
  if (parsed.valueType !== TagValueType.Enum || parsed.disciplines.length > 0 || parsed.multiple === true || parsed.required !== true) {
    throw new ValidationError(`Only the values and names of the ${existing.id} tag can change, it is a required enum tag holding one value on tricks of every discipline`)
  }
}

export const tagResolvers: Resolvers = {
  Query: {
    async tags (_, { discipline }, { dataSources }) {
      const tags = await dataSources.tags.findAll({ ttl: 3600 })
      return tags
        .filter(tag => discipline == null || tagAppliesTo(tag, discipline))
        .sort(byTagOrder)
    },
    async tag (_, { id }, { dataSources }) {
      return (await dataSources.tags.findOneById(id, { ttl: 3600 })) ?? null
    }
  },
  Mutation: {
    async createTag (_, { tagId, data }, { dataSources, allowUser, user }) {
      allowUser.createTag.assert()
      if (!user) throw new AuthorizationError()
      const id = tagIdSchema.parse(tagId)
      const parsed = tagInputSchema.parse(data)

      if (id === TRICK_TYPE_TAG_ID) throw new CollisionError(`The tag ${id} is built in`, { extensions: { entity: 'tag', id } })

      const collection = dataSources.tags.collection
      await collection.firestore.runTransaction(async t => {
        const dSnap = await t.get(collection.doc(id))
        if (dSnap.exists) throw new CollisionError(`A tag with the id ${id} already exists`, { extensions: { entity: 'tag', id } })
        t.create(collection.doc(id).withConverter(null), tagFields(parsed, undefined, user.id))
      })
      await dataSources.tags.deleteFromCacheById(id)

      return await existingTag(id, { dataSources })
    },
    async updateTag (_, { tagId, data }, { dataSources, allowUser, user, logger }) {
      allowUser.editTag.assert()
      if (!user) throw new AuthorizationError()
      const parsed = tagInputSchema.parse(data)
      const existing = await existingTag(tagId, { dataSources })
      if (existing.system) assertSystemTagShape(existing, parsed)

      const carrying = await dataSources.tricks.findManyByTag(existing.id)
      const next: TagDoc = { id: existing.id, collection: existing.collection, createdAt: existing.createdAt, updatedAt: existing.updatedAt, ...tagFields(parsed, existing, user.id) }
      const problems = carrying.flatMap(trick => {
        const problem = trickTagProblem(next, trick.tags[existing.id], trick.discipline)
        return problem ? [{ trick, problem }] : []
      })
      if (problems.length > 0) refuse(`The tag ${existing.id} cannot change like that, tricks carrying it would no longer fit it`, problems)

      // a transaction keeps a concurrent translation
      const collection = dataSources.tags.collection
      const updated = await collection.firestore.runTransaction(async t => {
        const current = (await t.get(collection.doc(existing.id))).data()
        if (!current) throw new NotFoundError(`Tag ${existing.id} not found`, { extensions: { entity: 'tag', id: existing.id } })
        const fields = tagFields(parsed, current, user.id)
        t.set(collection.doc(existing.id).withConverter(null), fields)
        return { current, fields }
      })
      await dataSources.tags.deleteFromCacheById(existing.id)

      if (englishSearchNames(updated.current) !== englishSearchNames(updated.fields)) {
        await tryIndexTricks(carrying.map(trick => trick.id), { dataSources, logger })
      }

      return await existingTag(existing.id, { dataSources })
    },
    async deleteTag (_, { tagId }, { dataSources, allowUser, user, logger }) {
      allowUser.deleteTag.assert()
      if (!user) throw new AuthorizationError()
      const tag = await existingTag(tagId, { dataSources })
      if (tag.system) throw new ValidationError(`The ${tag.id} tag is built in and cannot be deleted`)

      // tricks first, so a failed delete can be retried
      const tricks = await dataSources.tricks.findManyByTag(tag.id)
      await writeInChunks(tricks, (batch, trick) => {
        batch.update(dataSources.tricks.collection.doc(trick.id).withConverter(null), new FieldPath('tags', tag.id), FieldValue.delete(), 'updatedBy', user.id)
      })
      await dataSources.tags.deleteOne(tag.id)
      for (const trick of tricks) await dataSources.tricks.deleteFromCacheById(trick.id)

      await tryIndexTricks(tricks.map(trick => trick.id), { dataSources, logger })

      return tag
    },
    async setTagLocalisation (_, { tagId, lang, data }, { dataSources, allowUser, user, logger }) {
      const parsedLang = langSchema.parse(lang)
      if (parsedLang === 'en') throw new ValidationError('The english names are part of the tag, set them with updateTag')
      allowUser.tagLocalisation(parsedLang).edit.assert()
      if (!user) throw new AuthorizationError()
      const parsed = tagLocalisationSchema.parse(data)

      const [tag, language] = await Promise.all([
        existingTag(tagId, { dataSources }),
        dataSources.languages.findOneById(parsedLang)
      ])
      if (!language) throw new NotFoundError(`Language ${parsedLang} not found`, { extensions: { entity: 'language', id: parsedLang } })

      const collection = dataSources.tags.collection
      await collection.firestore.runTransaction(async t => {
        const current = (await t.get(collection.doc(tag.id))).data()
        if (!current) throw new NotFoundError(`Tag ${tag.id} not found`, { extensions: { entity: 'tag', id: tag.id } })

        const values = { ...current.values }
        for (const value of parsed.values ?? []) {
          const existingValue = values[value.id]
          if (!existingValue) throw new ValidationError(`The tag ${tag.id} has no value ${value.id}`)
          values[value.id] = { ...existingValue, names: withName(existingValue.names, parsedLang, value.name) }
        }

        t.update(collection.doc(tag.id).withConverter(null), {
          names: withName(current.names, parsedLang, parsed.name),
          ...(current.values != null ? { values } : {}),
          updatedBy: user.id
        })
      })
      await dataSources.tags.deleteFromCacheById(tag.id)

      const tricks = await dataSources.tricks.findManyByTag(tag.id)
      await tryIndexTricks(tricks.map(trick => trick.id), { dataSources, logger })

      return await existingTag(tag.id, { dataSources })
    }
  },
  Tag: {
    name (tag, { lang }) {
      return localised(tag.names, lang)
    },
    names (tag) {
      return localisedStrings(tag.names)
    },
    min (tag) {
      return tag.min ?? null
    },
    max (tag) {
      return tag.max ?? null
    },
    step (tag) {
      return tag.step ?? null
    },
    multiple (tag) {
      return tag.multiple ?? false
    },
    values (tag) {
      return tagValues(tag)
    },
    required (tag) {
      return tag.required === true
    },
    system (tag) {
      return tag.system === true
    },
    async trickCount (tag, _, { dataSources }) {
      return await dataSources.tricks.countByTag(tag.id)
    }
  },
  TagValue: {
    name (value, { lang }) {
      return localised(value.names, lang)
    },
    names (value) {
      return localisedStrings(value.names)
    }
  }
}
