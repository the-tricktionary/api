import * as deepmerge from 'deepmerge'
import { TimestampScalar } from '../scalars'
import { isDetailedSpeedResult } from '../store/schema'

import { userResolvers } from './user'
import { trickResolvers } from './trick'
import { trickCompletionResolvers } from './trickCompletion'
import { speedResultResolvers } from './speedResultResolver'
import { productResolvers } from './products'

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

export const rootResolver = deepmerge.all<Resolvers>([
  commonResolvers,
  productResolvers,
  speedResultResolvers,
  trickResolvers,
  trickCompletionResolvers,
  userResolvers
])
