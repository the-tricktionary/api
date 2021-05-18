import * as deepmerge from 'deepmerge'
import { TimestampScalar } from '../scalars'
import { userResolvers } from './user'
import type { Resolvers } from '../generated/graphql'
import { trickResolvers } from './trick'

export const commonResolvers: Resolvers = {
  Timestamp: TimestampScalar
}

export const rootResolver = deepmerge.all<Resolvers>([
  commonResolvers,
  userResolvers,
  trickResolvers
])
