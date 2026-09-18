import { NotFoundError } from '../errors'

import type { Resolvers } from '../generated/graphql'

export const trickLevelResolvers: Resolvers = {
  TrickLevel: {
    async trick (trickLevel, _, { dataSources }) {
      const trick = await dataSources.tricks.findOneById(trickLevel.trickId, { ttl: 3600 })
      if (!trick) throw new NotFoundError('Trick not found', { extensions: { entity: 'trick', id: trickLevel.trickId } })
      return trick
    },
    async ruleset (trickLevel, _, { dataSources }) {
      const ruleset = await dataSources.rulesets.findOneById(trickLevel.rulesId, { ttl: 3600 })
      if (!ruleset) throw new NotFoundError('Ruleset not found', { extensions: { entity: 'ruleset', id: trickLevel.rulesId } })
      return ruleset
    }
  }
}
