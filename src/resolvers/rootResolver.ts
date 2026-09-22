import { mergeResolvers } from '@graphql-tools/merge'
import { JSONObjectScalar, TimestampScalar } from '../scalars.js'

import { userResolvers } from './user.js'
import { trickResolvers } from './trick.js'
import { trickCompletionResolvers } from './trickCompletion.js'
import { trickVideoResolvers } from './trickVideo.js'
import { trickSubmissionResolvers } from './trickSubmission.js'
import { speedResultResolvers } from './speedResult.js'
import { groupResolvers } from './group.js'
import { groupMemberResolvers } from './groupMember.js'
import { groupInviteResolvers } from './groupInvite.js'
import { productResolvers } from './products.js'
import { eventDefinitionResolvers } from './eventDefinitions.js'
import { rulesetResolvers } from './ruleset.js'
import { languageResolvers } from './language.js'
import { trickLevelResolvers } from './trickLevel.js'
import { uiMessageResolvers } from './uiMessages.js'
import { noticeResolvers } from './notices.js'

import type { Resolvers } from '../generated/graphql.js'

export const commonResolvers: Resolvers = {
  Timestamp: TimestampScalar,
  JSONObject: JSONObjectScalar
}

export const rootResolver = mergeResolvers([
  commonResolvers,
  productResolvers,
  speedResultResolvers,
  groupResolvers,
  groupMemberResolvers,
  groupInviteResolvers,
  trickResolvers,
  trickCompletionResolvers,
  trickVideoResolvers,
  trickSubmissionResolvers,
  userResolvers,
  eventDefinitionResolvers,
  rulesetResolvers,
  languageResolvers,
  trickLevelResolvers,
  uiMessageResolvers,
  noticeResolvers
]) as Resolvers
