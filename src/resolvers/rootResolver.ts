import { mergeResolvers } from '@graphql-tools/merge'
import { TimestampScalar } from '../scalars.js'
import { isDetailedSpeedResult } from '../store/schema.js'

import { userResolvers } from './user.js'
import { trickResolvers } from './trick.js'
import { trickCompletionResolvers } from './trickCompletion.js'
import { trickVideoResolvers } from './trickVideo.js'
import { speedResultResolvers } from './speedResult.js'
import { productResolvers } from './products.js'
import { eventDefinitionResolvers } from './eventDefinitions.js'
import { rulesetResolvers } from './ruleset.js'
import { languageResolvers } from './language.js'
import { trickLevelResolvers } from './trickLevel.js'

import type { Resolvers } from '../generated/graphql.js'

export const commonResolvers: Resolvers = {
  Timestamp: TimestampScalar,
  SpeedResult: {
    __resolveType (obj) {
      if (isDetailedSpeedResult(obj)) {
        return 'DetailedSpeedResult'
      } else {
        return 'SimpleSpeedResult'
      }
    }
  }
}

export const rootResolver = mergeResolvers([
  commonResolvers,
  productResolvers,
  speedResultResolvers,
  trickResolvers,
  trickCompletionResolvers,
  trickVideoResolvers,
  userResolvers,
  eventDefinitionResolvers,
  rulesetResolvers,
  languageResolvers,
  trickLevelResolvers
]) as Resolvers
