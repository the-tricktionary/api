import { isTrick } from '../store/schema'

import type { Resolvers } from '../generated/graphql'
import type { TrickDoc, UserDoc } from '../store/schema'

export const trickResolvers: Resolvers = {
  Query: {
    async getTricks (_, { discipline, trickType }, { dataSources, allowUser }) {
      allowUser.getTricks.assert()
      return dataSources.tricks.findManyByFilters({ discipline, trickType }, { ttl: 3600 })
    },
    async getTrick (_, { id, }, { dataSources, allowUser }) {
      allowUser.getTricks.assert()
      return (await dataSources.tricks.findOneById(id, { ttl: 3600 })) ?? null
    },
    async getTrickBySlug (_, { slug, discipline }, { dataSources, allowUser }) {
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
