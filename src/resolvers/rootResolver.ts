import { mergeResolvers } from '@graphql-tools/merge'
import { TimestampScalar } from '../scalars'

import { userResolvers } from './user'
import { trickResolvers } from './trick'
import { trickCompletionResolvers } from './trickCompletion'
import { trickVideoResolvers } from './trickVideo'
import { speedResultResolvers } from './speedResult'
import { productResolvers } from './products'
import { eventDefinitionResolvers } from './eventDefinitions'
import { rulesetResolvers } from './ruleset'
import { trickLevelResolvers } from './trickLevel'

import type { Resolvers } from '../generated/graphql'

export const commonResolvers: Resolvers = {
  Timestamp: TimestampScalar
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
  trickLevelResolvers
]) as Resolvers
