import { isTrick } from '../store/schema'

import type { Resolvers } from '../generated/graphql'
import type { TrickDoc, UserDoc } from '../store/schema'
import { searchTricks } from '../services/algolia'

export const trickResolvers: Resolvers = {
  Query: {
    async tricks (_, { discipline, searchQuery }, { dataSources, allowUser }) {
      allowUser.getTricks.assert()
      if (searchQuery) {
        const hits = await searchTricks(searchQuery, { discipline: discipline ?? undefined })
        return dataSources.tricks.findManyByIds(hits.map(hit => hit.objectID)) as Promise<TrickDoc[]>
      } else {
        return dataSources.tricks.findManyByDiscipline(discipline, { ttl: 3600 })
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
  Trick: {
    async videos (trick) {
      return trick.videos ?? []
    },
    async localisation (trick, { lang }, { dataSources }) {
      return (await dataSources.trickLocalisations.findOneById(`${trick.id}-${lang ?? 'en'}`, { ttl: 3600 })) ?? null
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
    async levels (trick, { organisation, rulesVersion }, { dataSources }) {
      return dataSources.trickLevels.findManyByFilters({ trickId: trick.id, organisation, rulesVersion })
    }
  }
}
