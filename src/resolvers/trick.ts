import type { Resolvers } from '../generated/graphql'
import { $$lang } from '../store/schema'

export const trickResolvers: Resolvers = {
  Query: {
    async getTrick (_, { id, lang }, { dataSources, allowUser }) {
      allowUser.getTricks.assert()
      const base = await dataSources.tricks.findOneById(id, { ttl: 3600 })

      if (base) base[$$lang] = lang ?? 'en'

      return base ?? null
    },
    async getTricks (_, { lang, discipline, trickType }, { dataSources, allowUser }) {
      allowUser.getTricks.assert()
      const tricks = await dataSources.tricks.findManyByFilters({ discipline, trickType }, { ttl: 3600 })

      for (const trick of tricks) {
        trick[$$lang] = lang ?? 'en'
      }

      return tricks
    }
  },
  Trick: {
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
    }
  }
}
