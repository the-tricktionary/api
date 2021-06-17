import * as deepmerge from 'deepmerge'
import { TimestampScalar } from '../scalars'

import { userResolvers } from './user'
import { trickResolvers } from './trick'
import { trickCompletionResolvers } from './trickCompletion'

import type { Resolvers } from '../generated/graphql'
import { productResolvers } from './products'

export const commonResolvers: Resolvers = {
  Timestamp: TimestampScalar
}

export const rootResolver = deepmerge.all<Resolvers>([
  commonResolvers,
  userResolvers,
  trickResolvers,
  trickCompletionResolvers,
  productResolvers
])
