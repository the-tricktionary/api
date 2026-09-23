import { FieldValue, Timestamp } from '@google-cloud/firestore'
import { AuthorizationError, NotFoundError } from '../errors.js'
import { VerificationLevel } from '../generated/graphql.js'
import { TRICKTIONARY_RULES_ID, trickLevelId } from '../store/schema.js'
import { tryIndexTrick } from '../services/algolia.js'
import { levelSchema, tricktionaryLevelSchema } from '../validation.js'

import type { Resolvers } from '../generated/graphql.js'
import type { TrickLevelDoc } from '../store/schema.js'

export const trickLevelResolvers: Resolvers = {
  Mutation: {
    async setTrickLevel (_, { trickId, rulesId, level }, { dataSources, allowUser, user, logger }) {
      const [trick, ruleset] = await Promise.all([
        dataSources.tricks.findOneById(trickId, { ttl: 3600 }),
        dataSources.rulesets.findOneById(rulesId, { ttl: 3600 })
      ])
      if (!trick) throw new NotFoundError('Trick not found', { extensions: { entity: 'trick', id: trickId } })
      if (!ruleset) throw new NotFoundError('Ruleset not found', { extensions: { entity: 'ruleset', id: rulesId } })

      const id = trickLevelId(trickId, rulesId)
      const existing = await dataSources.trickLevels.findOneById(id)
      allowUser.ruleset(rulesId).setLevel(existing).assert()
      if (!user) throw new AuthorizationError()

      let trickLevel: TrickLevelDoc | null = null
      if ((level?.trim() ?? '') === '') {
        if (!existing) return null
        await dataSources.trickLevels.deleteOne(id)
      } else {
        const parsedLevel = (rulesId === TRICKTIONARY_RULES_ID ? tricktionaryLevelSchema : levelSchema).parse(level)

        // editing a level resets its verification to the editor's own rank
        const rank = allowUser.ruleset(rulesId).verificationRank()
        const verification = rank === 0
          ? {}
          : {
              verificationLevel: rank === 2 ? VerificationLevel.Official : VerificationLevel.Judge,
              verifiedBy: user.id,
              verifiedAt: Timestamp.now()
            }

        trickLevel = await (dataSources.trickLevels.createOne({
          id,
          trickId,
          rulesId,
          level: parsedLevel,
          updatedBy: user.id,
          changedAt: Timestamp.now(),
          ...verification
        }) as Promise<TrickLevelDoc>)
      }

      // the tricktionary level feeds Algolia's custom ranking
      if (rulesId === TRICKTIONARY_RULES_ID) await tryIndexTrick(trickId, { dataSources, logger })

      return trickLevel
    },
    async setTrickLevelVerification (_, { trickId, rulesId, verificationLevel }, { dataSources, allowUser, user }) {
      const id = trickLevelId(trickId, rulesId)
      const existing = await dataSources.trickLevels.findOneById(id)
      if (!existing) throw new NotFoundError('Trick level not found', { extensions: { entity: 'trick-level', id } })

      allowUser.ruleset(rulesId).setVerification(existing, verificationLevel ?? null).assert()
      if (!user) throw new AuthorizationError()

      return await (dataSources.trickLevels.updateOnePartial(id, verificationLevel != null
        ? { verificationLevel, verifiedBy: user.id, verifiedAt: Timestamp.now(), updatedBy: user.id, changedAt: Timestamp.now() }
        : {
            verificationLevel: FieldValue.delete(),
            verifiedBy: FieldValue.delete(),
            verifiedAt: FieldValue.delete(),
            updatedBy: user.id,
            changedAt: Timestamp.now()
          }
      ) as Promise<TrickLevelDoc>)
    }
  },
  TrickLevel: {
    updatedAt (trickLevel) {
      return trickLevel.changedAt
    },
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
