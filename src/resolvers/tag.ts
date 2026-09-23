import { FieldPath, FieldValue } from 'firebase-admin/firestore'
import { AuthorizationError, CollisionError, NotFoundError, ValidationError } from '../errors.js'
import { TagValueType } from '../generated/graphql.js'
import { byTagOrder, localisedName, localisedStrings, tagAppliesTo, tagValues, trickTagProblem } from '../helpers/tags.js'
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

/** How many of the tricks in the way a refusal names */
const LISTED_TRICKS = 10

async function existingTag (tagId: string, { dataSources }: Pick<ApolloContext, 'dataSources'>) {
  const tag = await dataSources.tags.findOneById(tagId)
  if (!tag) throw new NotFoundError(`Tag ${tagId} not found`, { extensions: { entity: 'tag', id: tagId } })
  return tag
}

/**
 * The tricks carrying a tag. The trick type tag is carried by every trick,
 * including those that only have the legacy field so far.
 */
async function tricksCarrying (tag: TagDoc, { dataSources }: Pick<ApolloContext, 'dataSources'>) {
  return tag.system
    ? await dataSources.tricks.findManyByDiscipline()
    : await dataSources.tricks.findManyByTag(tag.id)
}

/**
 * The document of a tag as defined, the names in other languages carried over
 * from what it was, including those of values that are kept
 */
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
    ...(existing?.system ? { system: true as const } : {}),
    updatedBy
  }
}

/** What the search index finds a trick by through the tag in english, the other languages change through setTagLocalisation */
function englishSearchNames (tag: Pick<TagDoc, 'names' | 'values'>) {
  return [tag.names.en, ...tagValues(tag).map(value => `${value.id}=${value.names.en}`)].join('\n')
}

/** `names` with the name in `lang` set, removed when empty and left alone when absent */
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

/** The trick type tag's values are the `TrickType` enum, so only its names may change */
function assertSystemTagShape (existing: TagDoc, parsed: ParsedTag) {
  const existingIds = tagValues(existing).map(value => value.id).sort()
  const ids = (parsed.values ?? []).map(value => value.id).sort()
  if (
    parsed.valueType !== existing.valueType ||
    parsed.disciplines.length !== existing.disciplines.length ||
    (parsed.multiple ?? false) !== (existing.multiple ?? false) ||
    ids.join(',') !== existingIds.join(',')
  ) {
    throw new ValidationError(`Only the names of the ${existing.id} tag can change`)
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

      // reserved even before the migration that creates it has run
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
      const carrying = await tricksCarrying(existing, { dataSources })

      if (existing.system) {
        assertSystemTagShape(existing, parsed)
      } else {
        const next: TagDoc = { ...existing, ...tagFields(parsed, existing, user.id) }
        // the fields tagFields leaves out are ones the tag no longer has
        if (parsed.min == null) delete next.min
        if (parsed.max == null) delete next.max
        if (parsed.step == null) delete next.step
        if (parsed.valueType !== TagValueType.Enum) {
          delete next.multiple
          delete next.values
        }

        const problems = carrying.flatMap(trick => {
          const value = trick.tags?.[existing.id]
          if (value == null) return []
          const problem = trickTagProblem(next, value, trick.discipline)
          return problem ? [{ trick, problem }] : []
        })
        if (problems.length > 0) refuse(`The tag ${existing.id} cannot change like that, tricks carrying it would no longer fit it`, problems)
      }

      // in a transaction, so a translation saved meanwhile isn't lost
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

      // off the tricks first, so a failure part way leaves a tag that can be deleted again
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

      const tricks = await tricksCarrying(tag, { dataSources })
      await tryIndexTricks(tricks.map(trick => trick.id), { dataSources, logger })

      return await existingTag(tag.id, { dataSources })
    }
  },
  Tag: {
    name (tag, { lang }) {
      return localisedName(tag.names, lang)
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
    system (tag) {
      return tag.system === true
    },
    async trickCount (tag, _, { dataSources }) {
      return tag.system
        ? await dataSources.tricks.countAll()
        : await dataSources.tricks.countByTag(tag.id)
    }
  },
  TagValue: {
    name (value, { lang }) {
      return localisedName(value.names, lang)
    },
    names (value) {
      return localisedStrings(value.names)
    }
  }
}
