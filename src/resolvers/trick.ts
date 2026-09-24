import z from 'zod'
import { isTag, isTrick, trickLocalisationId } from '../store/schema.js'
import { Discipline } from '../generated/graphql.js'
import { AuthorizationError, CollisionError, NotFoundError, ValidationError } from '../errors.js'
import { createTrickWithLocalisation, mergeContributors, submitterProfile, toContributor } from '../helpers/tricks.js'
import { assertTrickTagsFit, byTagOrder, matchesTags, missingRequiredTags, parseTagQuery, tagValues, trickTagsFromInput } from '../helpers/tags.js'
import { tryIndexTrick, searchTricks } from '../services/algolia.js'
import { verificationLevelRank } from '../services/permissions.js'
import { langSchema, rulesIdSchema, slugSchema, trickLocalisationSchema, trickTagFiltersSchema, trickTagsInputSchema } from '../validation.js'

import type { Resolvers } from '../generated/graphql.js'
import type { TrickDoc, TrickLocalisationDoc } from '../store/schema.js'

const createTrickSchema = z.object({
  discipline: z.enum(Discipline),
  slug: slugSchema,
  localisation: trickLocalisationSchema,
  tags: trickTagsInputSchema
})

const updateTrickDetailsSchema = z.object({
  discipline: z.enum(Discipline).nullish(),
  slug: slugSchema.nullish(),
  tags: trickTagsInputSchema.nullish()
})

export const trickResolvers: Resolvers = {
  Query: {
    async tricks (_, { discipline, searchQuery, filter }, { dataSources, allowUser, user }) {
      allowUser.getTricks.assert()
      let tricks: TrickDoc[]
      const { text, tokens } = parseTagQuery(searchQuery ?? '')
      if (text !== '') {
        const hits = await searchTricks(text, { discipline: discipline ?? undefined, lang: user?.lang, userId: user?.id })
        tricks = (await dataSources.tricks.findManyByIds(hits.map(hit => hit.objectID)))
          .filter((trick): trick is TrickDoc => trick != null)
      } else {
        tricks = await dataSources.tricks.findManyByDiscipline(discipline, { ttl: 3600 })
      }

      const tagFilters = filter?.tags != null ? trickTagFiltersSchema.parse(filter.tags) : []
      if (tokens.length > 0 || tagFilters.length > 0) {
        const tags = await dataSources.tags.findAll({ ttl: 3600 })
        tricks = tricks.filter(trick => matchesTags(trick, tokens, tagFilters, tags))
      }

      if (filter?.withoutVideos === true) {
        tricks = tricks.filter(trick => (trick.videos?.length ?? 0) === 0)
      }

      if (filter?.missingRequiredTags === true) {
        const tags = await dataSources.tags.findAll({ ttl: 3600 })
        tricks = tricks.filter(trick => missingRequiredTags(trick.tags, trick.discipline, tags).length > 0)
      }

      if (filter?.level) {
        const rulesId = rulesIdSchema.parse(filter.level.rulesId)
        const ruleset = await dataSources.rulesets.findOneById(rulesId, { ttl: 3600 })
        if (!ruleset) throw new NotFoundError(`Ruleset ${rulesId} not found`, { extensions: { entity: 'ruleset', id: rulesId } })

        const verifiedBelow = filter.level.verifiedBelow
        const levels = await dataSources.trickLevels.findManyByRuleset(rulesId)
        const levelByTrick = new Map(levels.map(level => [level.trickId, level]))

        tricks = tricks.filter(trick => {
          const level = levelByTrick.get(trick.id)
          if (!level) return true
          return verifiedBelow != null && verificationLevelRank(level.verificationLevel) < verificationLevelRank(verifiedBelow)
        })
      }

      if (filter?.missingLocalisation != null) {
        const lang = langSchema.parse(filter.missingLocalisation)
        const language = await dataSources.languages.findOneById(lang, { ttl: 3600 })
        if (!language) throw new NotFoundError(`Language ${lang} not found`, { extensions: { entity: 'language', id: lang } })

        const localisations = await dataSources.trickLocalisations.findManyByIds(tricks.map(trick => trickLocalisationId(trick.id, lang)), { ttl: 3600 })

        tricks = tricks.filter((_, idx) => {
          const localisation = localisations[idx]
          return (localisation?.name.trim() ?? '') === '' || (localisation?.description?.trim() ?? '') === ''
        })
      }

      return tricks
    },
    async trick (_, { id }, { dataSources, allowUser }) {
      allowUser.getTricks.assert()
      return (await dataSources.tricks.findOneById(id, { ttl: 3600 })) ?? null
    },
    async trickBySlug (_, { slug, discipline }, { dataSources, allowUser }) {
      allowUser.getTricks.assert()
      return (await dataSources.tricks.findOneBySlug({ slug, discipline }, { ttl: 3600 })) ?? null
    }
  },
  Mutation: {
    async createTrick (_, { data }, { dataSources, allowUser, user, logger }) {
      allowUser.createTrick.assert()
      if (!user) throw new AuthorizationError()
      const { discipline, slug, localisation, tags } = createTrickSchema.parse(data)

      return await createTrickWithLocalisation({
        discipline,
        tags: await trickTagsFromInput(tags, discipline, { dataSources }),
        slug,
        localisation: { ...localisation, submittedBy: user.id },
        submittedBy: user.id,
        updatedBy: user.id
      }, { dataSources, logger })
    },
    async updateTrickDetails (_, { trickId, data }, { dataSources, allowUser, user, logger }) {
      allowUser.editTrick.assert()
      if (!user) throw new AuthorizationError()
      const parsed = updateTrickDetailsSchema.parse(data)

      const trick = await dataSources.tricks.findOneById(trickId)
      if (!trick) throw new NotFoundError(`Trick ${trickId} not found`, { extensions: { entity: 'trick', id: trickId } })

      const discipline = parsed.discipline ?? undefined
      const slug = parsed.slug ?? undefined
      const nextDiscipline = discipline ?? trick.discipline
      const nextSlug = slug ?? trick.slug

      // prerequisites only ever link tricks of the same discipline, moving a
      // trick would break that, so its edges have to go first
      if (nextDiscipline !== trick.discipline) {
        const [prerequisites, prerequisiteFor] = await Promise.all([
          dataSources.trickPrerequisites.findManyPrerequisitesByTrick(trickId),
          dataSources.trickPrerequisites.findManyRequisitesByTrick(trickId)
        ])
        if (prerequisites.length > 0 || prerequisiteFor.length > 0) {
          throw new ValidationError('The discipline of a trick with prerequisites cannot be changed, remove its prerequisites first')
        }
      }

      const tags = parsed.tags != null ? await trickTagsFromInput(parsed.tags, nextDiscipline, { dataSources }) : undefined
      if (tags == null && nextDiscipline !== trick.discipline) await assertTrickTagsFit(trick.tags, nextDiscipline, { dataSources })

      // an update replaces the whole map, so removed tags go
      const changes = {
        updatedBy: user.id,
        ...(discipline != null ? { discipline } : {}),
        ...(slug != null ? { slug } : {}),
        ...(tags != null ? { tags } : {})
      }
      const trickRef = dataSources.tricks.collection.doc(trickId).withConverter(null)

      if (nextDiscipline !== trick.discipline || nextSlug !== trick.slug) {
        const collection = dataSources.tricks.collection
        await collection.firestore.runTransaction(async t => {
          const qSnap = await t.get(collection.where('discipline', '==', nextDiscipline).where('slug', '==', nextSlug))
          const conflict = qSnap.docs.find(dSnap => dSnap.id !== trickId)
          if (conflict) {
            throw new CollisionError(`A ${nextDiscipline} trick with the slug ${nextSlug} already exists`, { extensions: { entity: 'trick', id: conflict.id } })
          }
          t.update(trickRef, changes)
        })
      } else {
        await trickRef.update(changes)
      }
      // priming never replaces the trick already loaded above, and tryIndexTrick reads it through the loader
      await dataSources.tricks.deleteFromCacheById(trickId)

      const updated = await (dataSources.tricks.findOneById(trickId) as Promise<TrickDoc>)

      await tryIndexTrick(trickId, { dataSources, logger })

      return updated
    },
    async setTrickLocalisation (_, { trickId, lang, data }, { dataSources, allowUser, user, logger }) {
      const parsedLang = langSchema.parse(lang)
      allowUser.localisation(parsedLang).edit.assert()
      if (!user) throw new AuthorizationError()
      const parsed = trickLocalisationSchema.parse(data)

      const [trick, language] = await Promise.all([
        dataSources.tricks.findOneById(trickId),
        dataSources.languages.findOneById(parsedLang)
      ])
      if (!trick) throw new NotFoundError(`Trick ${trickId} not found`, { extensions: { entity: 'trick', id: trickId } })
      if (!language) throw new NotFoundError(`Language ${parsedLang} not found`, { extensions: { entity: 'language', id: parsedLang } })

      const localisationId = trickLocalisationId(trickId, parsedLang)
      const existing = await dataSources.trickLocalisations.findOneById(localisationId)

      const localisation = await (dataSources.trickLocalisations.updateOne({
        id: localisationId,
        trickId,
        name: parsed.name,
        alternativeNames: parsed.alternativeNames,
        description: parsed.description,
        // whoever wrote the first version of a localisation stays its submitter
        submittedBy: existing?.submittedBy ?? user.id,
        updatedBy: user.id
      }) as Promise<TrickLocalisationDoc>)

      await tryIndexTrick(trickId, { dataSources, logger })

      return localisation
    },
    async addTrickPrerequisite (_, { trickId, prerequisiteId }, { dataSources, allowUser, user }) {
      allowUser.editTrick.assert()
      if (!user) throw new AuthorizationError()

      const [trick, prerequisite] = await Promise.all([
        dataSources.tricks.findOneById(trickId),
        dataSources.tricks.findOneById(prerequisiteId)
      ])
      if (!trick) throw new NotFoundError(`Trick ${trickId} not found`, { extensions: { entity: 'trick', id: trickId } })
      if (!prerequisite) throw new NotFoundError(`Trick ${prerequisiteId} not found`, { extensions: { entity: 'trick', id: prerequisiteId } })
      if (trickId === prerequisiteId) throw new ValidationError('A trick cannot be its own prerequisite')
      if (trick.discipline !== prerequisite.discipline) throw new ValidationError('A prerequisite must be a trick of the same discipline')

      const existing = await dataSources.trickPrerequisites.findManyByQuery(c => c.where('parentId', '==', trickId).where('childId', '==', prerequisiteId))
      if (existing.length > 0) return trick

      await dataSources.trickPrerequisites.createOne({ parentId: trickId, childId: prerequisiteId })

      return trick
    },
    async removeTrickPrerequisite (_, { trickId, prerequisiteId }, { dataSources, allowUser, user }) {
      allowUser.editTrick.assert()
      if (!user) throw new AuthorizationError()

      const trick = await dataSources.tricks.findOneById(trickId)
      if (!trick) throw new NotFoundError(`Trick ${trickId} not found`, { extensions: { entity: 'trick', id: trickId } })

      const existing = await dataSources.trickPrerequisites.findManyByQuery(c => c.where('parentId', '==', trickId).where('childId', '==', prerequisiteId))
      for (const edge of existing) await dataSources.trickPrerequisites.deleteOne(edge.id)

      return trick
    }
  },
  Trick: {
    async tags (trick, _, { dataSources }) {
      const tags = (await dataSources.tags.findManyByIds(Object.keys(trick.tags), { ttl: 3600 })).filter(isTag)
      return tags.sort(byTagOrder).map(tag => ({ tag, value: trick.tags[tag.id] }))
    },
    async videos (trick) {
      return trick.videos ?? []
    },
    async localisation (trick, { lang }, { dataSources }) {
      return (await dataSources.trickLocalisations.findOneById(trickLocalisationId(trick.id, lang ?? 'en'), { ttl: 3600 })) ?? null
    },
    async submitter (trick, _, { dataSources }) {
      const user = await dataSources.users.findOneById(trick.submittedBy, { ttl: 60 })
      if (!user) return null
      return submitterProfile(user)
    },
    async contributors (trick, _, { dataSources }) {
      const localisations = await dataSources.trickLocalisations.findManyByTrick(trick.id, { ttl: 3600 })
      return mergeContributors([
        ...(trick.videos ?? []).map(video => video.attribution),
        ...localisations.map(localisation => localisation.attribution)
      ])
    },
    async prerequisites (trick, _, { dataSources }) {
      const prereqs = await dataSources.trickPrerequisites.findManyPrerequisitesByTrick(trick.id)
      const tricks: TrickDoc[] = (await dataSources.tricks.findManyByIds(prereqs.map(p => p.childId), { ttl: 3600 }))
        .filter(((t) => isTrick(t)) as (t: any) => t is TrickDoc)
      return tricks
    },
    async prerequisiteFor (trick, _, { dataSources }) {
      const prereqs = await dataSources.trickPrerequisites.findManyRequisitesByTrick(trick.id)
      const tricks: TrickDoc[] = (await dataSources.tricks.findManyByIds(prereqs.map(p => p.parentId), { ttl: 3600 }))
        .filter(((t) => isTrick(t)) as (t: any) => t is TrickDoc)
      return tricks
    },
    async levels (trick, { rulesId }, { dataSources }) {
      return await dataSources.trickLevels.findManyByTrick({ trickId: trick.id, rulesId })
    }
  },
  TrickTag: {
    number ({ value }) {
      return typeof value === 'number' ? value : null
    },
    values ({ tag, value }) {
      if (!Array.isArray(value)) return []
      return tagValues(tag).filter(tagValue => value.includes(tagValue.id))
    }
  },
  TrickLocalisation: {
    attribution (localisation) {
      return localisation.attribution ? toContributor(localisation.attribution) : null
    }
  },
  Video: {
    attribution (video) {
      return video.attribution ? toContributor(video.attribution) : null
    }
  }
}
