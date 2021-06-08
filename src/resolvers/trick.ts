import { $$lang, isTrick } from '../store/schema'

import type { Resolvers } from '../generated/graphql'
import type { TrickDoc, UserDoc } from '../store/schema'

export const trickResolvers: Resolvers = {
  Query: {
    async getTricks (_, { lang, discipline, trickType }, { dataSources, allowUser }) {
      allowUser.getTricks.assert()

      const tricks = await dataSources.tricks.findManyByFilters({ discipline, trickType }, { ttl: 3600 })
      for (const trick of tricks) {
        trick[$$lang] = lang ?? 'en'
      }

      return tricks
    },
    async getTrick (_, { id, lang }, { dataSources, allowUser }) {
      allowUser.getTricks.assert()

      const base = await dataSources.tricks.findOneById(id, { ttl: 3600 })
      if (base) base[$$lang] = lang ?? 'en'
      return base ?? null
    },
    async getTrickBySlug (_, { slug, discipline, lang }, { dataSources, allowUser }) {
      allowUser.getTricks.assert()

      const base = await dataSources.tricks.findOneBySlug({ slug, discipline }, { ttl: 3600 })
      if (base) base[$$lang] = lang ?? 'en'
      return base ?? null
    }
  },
  Trick: {
    async videos (trick) {
      return trick.videos ?? []
    },
    async name (trick, _, { dataSources }) {
      const [local, en] = await dataSources.trickLocalisations.findManyByIds([`${trick.id}-${trick[$$lang]}`, `${trick.id}-en`], { ttl: 3600 })
      return local?.name ?? en?.name ?? ''
    },
    async description (trick, _, { dataSources }) {
      const [local, en] = await dataSources.trickLocalisations.findManyByIds([`${trick.id}-${trick[$$lang]}`, `${trick.id}-en`], { ttl: 3600 })
      return local?.description ?? en?.description ?? ''
    },
    async alternativeNames (trick, _, { dataSources }) {
      const [local, en] = await dataSources.trickLocalisations.findManyByIds([`${trick.id}-${trick[$$lang]}`, `${trick.id}-en`], { ttl: 3600 })
      return local?.alternativeNames ?? en?.alternativeNames ?? null
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
      for (const prereq of tricks) {
        prereq[$$lang] = trick[$$lang] ?? 'en'
      }
      return tricks
    },
    async prerequisiteFor (trick, _, { dataSources }) {
      const prereqs = await dataSources.trickPrerequisites.findManyRequisitesByTrick(trick.id)
      const tricks: TrickDoc[] = (await dataSources.tricks.findManyByIds(prereqs.map(p => p.parentId), { ttl: 3600 }))
        .filter(((t) => isTrick(t)) as (t: any) => t is TrickDoc)
      for (const req of tricks) {
        req[$$lang] = trick[$$lang] ?? 'en'
      }
      return tricks
    },
    async levels (trick, { organisation, rulesVersion }, { dataSources }) {
      return dataSources.trickLevels.findManyByFilters({ trickId: trick.id, organisation, rulesVersion })
    }
  }
}
