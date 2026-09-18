import { NotFoundError } from '../errors'
import { GrantType } from '../generated/graphql'

import type { Resolvers } from '../generated/graphql'
import type { Grant } from '../store/schema'

const grantTypes: Record<Grant['type'], GrantType> = {
  'super-admin': GrantType.SuperAdmin,
  'trick-editor': GrantType.TrickEditor,
  translator: GrantType.Translator,
  'level-editor': GrantType.LevelEditor
}

export const userResolvers: Resolvers = {
  Query: {
    async me (_, args, { dataSources, user }) {
      return user ?? null
    }
  },
  User: {
    grants (user, _, { allowUser }) {
      // We don't throw here, a user simply can't see anyone else's grants
      if (!allowUser.user(user).getGrants()) return []

      return (user.grants ?? []).map(grant => ({
        type: grantTypes[grant.type],
        lang: grant.type === 'translator' ? grant.lang : null,
        rulesId: grant.type === 'level-editor' ? grant.rulesId : null,
        verificationLevel: grant.type === 'level-editor' ? grant.verificationLevel : null
      }))
    },
    async checklist (user, _, { dataSources, allowUser }) {
      allowUser.user(user).getChecklist.assert()

      return await dataSources.trickCompletions.findManyByUser(user.id)
    },
    async speedResults (user, { limit, startAfter }, { dataSources, allowUser }) {
      allowUser.user(user).getSpeedResults.assert()

      return await dataSources.speedResults.findManyByUser(user.id, { ttl: 60, limit, startAfter })
    },
    async speedResult (user, { speedResultId }, { dataSources, allowUser }) {
      const speedResult = await dataSources.speedResults.findOneById(speedResultId, { ttl: 60 })
      if (!speedResult) throw new NotFoundError(`Speed result with id ${speedResultId} not found`, {})
      allowUser.user(user).speedResult(speedResult).get.assert()

      return speedResult
    }
  }
}
