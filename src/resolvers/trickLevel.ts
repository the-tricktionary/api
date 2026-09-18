import { Timestamp } from '@google-cloud/firestore'
import z from 'zod'
import { AuthorizationError, NotFoundError } from '../errors'
import { VerificationLevel } from '../generated/graphql'
import { TRICKTIONARY_RULES_ID, trickLevelId } from '../store/schema'
import { tryIndexTrick } from '../services/algolia'

import type { Resolvers } from '../generated/graphql'
import type { TrickLevelDoc } from '../store/schema'

/** e.g. `5` or `2-5` */
const levelSchema = z.string()
  .trim()
  .regex(/^\d+(-\d+)?$/, 'A level must be a whole number or a range of whole numbers, e.g. `5` or `2-5`')

/** the tricktionary's own levels are a single number from 1 to 5 */
const tricktionaryLevelSchema = levelSchema
  .regex(/^[1-5]$/, 'A tricktionary level must be a whole number between 1 and 5')

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

      if ((level?.trim() ?? '') === '') {
        if (!existing) return null
        await dataSources.trickLevels.deleteOne(id)
        // the tricktionary level feeds Algolia's custom ranking
        if (rulesId === TRICKTIONARY_RULES_ID) await tryIndexTrick(trickId, { dataSources, logger })
        return null
      }

      const parsedLevel = (rulesId === TRICKTIONARY_RULES_ID ? tricktionaryLevelSchema : levelSchema).parse(level)

      // editing a level resets its verification to the editor's own rank
      const rank = allowUser.ruleset(rulesId).verificationRank()
      const verification = rank === 0
        ? { verificationLevel: null, verifiedBy: null, verifiedAt: null }
        : {
            verificationLevel: rank === 2 ? VerificationLevel.Official : VerificationLevel.Judge,
            verifiedBy: user.id,
            verifiedAt: Timestamp.now()
          }

      const trickLevel = await (dataSources.trickLevels.createOne({
        id,
        trickId,
        rulesId,
        level: parsedLevel,
        updatedBy: user.id,
        ...verification
      }) as Promise<TrickLevelDoc>)
      await dataSources.trickLevels.deleteFromCacheById(id)

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

      const trickLevel = await (dataSources.trickLevels.updateOnePartial(id, verificationLevel != null
        ? { verificationLevel, verifiedBy: user.id, verifiedAt: Timestamp.now(), updatedBy: user.id }
        : { verificationLevel: null, verifiedBy: null, verifiedAt: null, updatedBy: user.id }
      ) as Promise<TrickLevelDoc>)
      await dataSources.trickLevels.deleteFromCacheById(id)

      return trickLevel
    }
  },
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
