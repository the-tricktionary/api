import z from 'zod'
import { isTrick, trickLocalisationId } from '../store/schema'
import { Discipline, TrickType } from '../generated/graphql'
import { AuthorizationError, CollisionError, NotFoundError, ValidationError } from '../errors'
import { tryIndexTrick, searchTricks } from '../services/algolia'
import { langSchema, slugSchema, trickLocalisationSchema } from '../validation'

import type { Resolvers } from '../generated/graphql'
import type { TrickDoc, TrickLocalisationDoc, UserDoc } from '../store/schema'

const createTrickSchema = z.object({
  discipline: z.enum(Discipline),
  trickType: z.enum(TrickType),
  slug: slugSchema,
  localisation: trickLocalisationSchema
})

const updateTrickDetailsSchema = z.object({
  discipline: z.enum(Discipline).nullish(),
  trickType: z.enum(TrickType).nullish(),
  slug: slugSchema.nullish()
})

export const trickResolvers: Resolvers = {
  Query: {
    async tricks (_, { discipline, searchQuery }, { dataSources, allowUser, user }) {
      allowUser.getTricks.assert()
      if (searchQuery) {
        const hits = await searchTricks(searchQuery, { discipline: discipline ?? undefined, lang: user?.lang, userId: user?.id })
        return await (dataSources.tricks.findManyByIds(hits.map(hit => hit.objectID)) as Promise<TrickDoc[]>)
      } else {
        return await dataSources.tricks.findManyByDiscipline(discipline, { ttl: 3600 })
      }
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
      const { discipline, trickType, slug, localisation } = createTrickSchema.parse(data)

      const collection = dataSources.tricks.collection
      const localisationCollection = dataSources.trickLocalisations.collection

      // the slug is only unique within a discipline, and there's no way to
      // express that as a document ID, so a transaction guards it instead
      const trickId = await collection.firestore.runTransaction(async t => {
        const qSnap = await t.get(collection.where('discipline', '==', discipline).where('slug', '==', slug))
        if (!qSnap.empty) {
          throw new CollisionError(`A ${discipline} trick with the slug ${slug} already exists`, { extensions: { entity: 'trick', id: qSnap.docs[0]?.id } })
        }

        const dRef = collection.doc()
        t.create(dRef.withConverter(null), {
          slug,
          discipline,
          trickType,
          submittedBy: user.id,
          updatedBy: user.id,
          videos: []
        })
        t.create(localisationCollection.doc(trickLocalisationId(dRef.id, 'en')).withConverter(null), {
          trickId: dRef.id,
          name: localisation.name,
          alternativeNames: localisation.alternativeNames,
          description: localisation.description,
          submittedBy: user.id,
          updatedBy: user.id
        })

        return dRef.id
      })

      await dataSources.tricks.deleteFromCacheById(trickId)
      await dataSources.trickLocalisations.deleteFromCacheById(trickLocalisationId(trickId, 'en'))
      const [trick] = await Promise.all([
        dataSources.tricks.findOneById(trickId),
        dataSources.trickLocalisations.findOneById(trickLocalisationId(trickId, 'en'))
      ])
      if (!trick) throw new NotFoundError(`Trick ${trickId} not found`, { extensions: { entity: 'trick', id: trickId } })

      await tryIndexTrick(trickId, { dataSources, logger })

      return trick
    },
    async updateTrickDetails (_, { trickId, data }, { dataSources, allowUser, user, logger }) {
      allowUser.editTrick.assert()
      if (!user) throw new AuthorizationError()
      const parsed = updateTrickDetailsSchema.parse(data)

      const trick = await dataSources.tricks.findOneById(trickId)
      if (!trick) throw new NotFoundError(`Trick ${trickId} not found`, { extensions: { entity: 'trick', id: trickId } })

      const discipline = parsed.discipline ?? undefined
      const trickType = parsed.trickType ?? undefined
      const slug = parsed.slug ?? undefined

      // prerequisites only ever link tricks of the same discipline, moving a
      // trick would break that, so its edges have to go first
      if (discipline != null && discipline !== trick.discipline) {
        const [prerequisites, prerequisiteFor] = await Promise.all([
          dataSources.trickPrerequisites.findManyPrerequisitesByTrick(trickId),
          dataSources.trickPrerequisites.findManyRequisitesByTrick(trickId)
        ])
        if (prerequisites.length > 0 || prerequisiteFor.length > 0) {
          throw new ValidationError('The discipline of a trick with prerequisites cannot be changed, remove its prerequisites first')
        }
      }

      const changes = {
        updatedBy: user.id,
        ...(discipline != null ? { discipline } : {}),
        ...(trickType != null ? { trickType } : {}),
        ...(slug != null ? { slug } : {})
      }

      const nextDiscipline = discipline ?? trick.discipline
      const nextSlug = slug ?? trick.slug

      if (nextDiscipline !== trick.discipline || nextSlug !== trick.slug) {
        const collection = dataSources.tricks.collection
        await collection.firestore.runTransaction(async t => {
          const qSnap = await t.get(collection.where('discipline', '==', nextDiscipline).where('slug', '==', nextSlug))
          const conflict = qSnap.docs.find(dSnap => dSnap.id !== trickId)
          if (conflict) {
            throw new CollisionError(`A ${nextDiscipline} trick with the slug ${nextSlug} already exists`, { extensions: { entity: 'trick', id: conflict.id } })
          }
          t.set(collection.doc(trickId).withConverter(null), changes, { merge: true })
        })
      } else {
        await dataSources.tricks.updateOnePartial(trickId, changes)
      }
      await dataSources.tricks.deleteFromCacheById(trickId)

      const updated = await dataSources.tricks.findOneById(trickId)
      if (!updated) throw new NotFoundError(`Trick ${trickId} not found`, { extensions: { entity: 'trick', id: trickId } })

      await tryIndexTrick(trickId, { dataSources, logger })

      return updated
    },
    async setTrickLocalisation (_, { trickId, lang, data }, { dataSources, allowUser, user, logger }) {
      const parsedLang = langSchema.parse(lang)
      allowUser.localisation(parsedLang).edit.assert()
      if (!user) throw new AuthorizationError()
      const parsed = trickLocalisationSchema.parse(data)

      const trick = await dataSources.tricks.findOneById(trickId)
      if (!trick) throw new NotFoundError(`Trick ${trickId} not found`, { extensions: { entity: 'trick', id: trickId } })

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
      await dataSources.trickLocalisations.deleteFromCacheById(localisationId)

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
    async videos (trick) {
      return trick.videos ?? []
    },
    async localisation (trick, { lang }, { dataSources }) {
      return (await dataSources.trickLocalisations.findOneById(trickLocalisationId(trick.id, lang ?? 'en'), { ttl: 3600 })) ?? null
    },
    async submitter (trick, _, { dataSources }) {
      const user = await dataSources.users.findOneById(trick.submittedBy, { ttl: 60 })
      if (!user) return null
      const cleaned: UserDoc = {
        id: user.id,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        collection: user.collection,
        username: user.username,
        profile: user.profile,
        ...(user.profile.public
          ? {
              name: user.name,
              photo: user.photo
            }
          : {})
      }
      return cleaned
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
  }
}
