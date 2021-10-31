import { mergeResolvers } from '@graphql-tools/merge'
import { TimestampScalar } from '../scalars'
import { isDetailedSpeedResult } from '../store/schema'

import { userResolvers } from './user'
import { trickResolvers } from './trick'
import { trickCompletionResolvers } from './trickCompletion'
import { speedResultResolvers } from './speedResult'
import { productResolvers } from './products'
import { eventDefinitionResolvers } from './eventDefinitions'

import type { Resolvers } from '../generated/graphql'

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
  userResolvers,
  eventDefinitionResolvers
]) as Resolvers
