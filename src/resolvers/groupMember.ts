import { AuthorizationError, NotFoundError, ValidationError } from '../errors.js'
import { GroupRole } from '../generated/graphql.js'
import { assertNotLastAdmin, detachMember, existingGroup, existingMember, groupAndMembership } from '../helpers/groups.js'
import { checklistStats } from '../helpers/checklist.js'
import { segmentResultOf } from '../helpers/speedResults.js'
import { checklistAthlete } from '../store/schema.js'
import { groupAthleteNameSchema, groupMemberInputSchema } from '../validation.js'

import type { Resolvers } from '../generated/graphql.js'
import type { GroupMemberDoc } from '../store/schema.js'

export const groupMemberResolvers: Resolvers = {
  Query: {
    async groupMember (_, { memberId }, context) {
      const member = await context.dataSources.groupMembers.findOneById(memberId)
      if (!member) return null
      const { group, membership } = await groupAndMembership(member.groupId, context)
      if (!context.allowUser.group(group, membership).get()) return null
      return member
    }
  },
  Mutation: {
    async addGroupAthlete (_, { groupId, name: rawName }, context) {
      const { group, membership } = await groupAndMembership(groupId, context)
      context.allowUser.group(group, membership).manageMembers.assert()

      const name = groupAthleteNameSchema.parse(rawName)
      return await (context.dataSources.groupMembers.createOne({
        groupId: group.id,
        name,
        role: GroupRole.Member,
        observer: false
      }) as Promise<GroupMemberDoc>)
    },
    async updateGroupMember (_, { memberId, data: rawData }, context) {
      const member = await existingMember(memberId, context)
      const { group, membership } = await groupAndMembership(member.groupId, context)
      context.allowUser.group(group, membership).manageMembers.assert()

      const data = groupMemberInputSchema.parse(rawData)

      if (member.userId == null) {
        if (data.observer) throw new ValidationError('An athlete with no account of their own cannot be an observer')
        if (data.role !== GroupRole.Member) throw new ValidationError('An athlete with no account of their own cannot be an admin')
        if (data.name == null) throw new ValidationError('An athlete with no account of their own needs a name')
      } else if (data.name != null) {
        throw new ValidationError('That member has an account, so their name is theirs to set')
      }

      if (member.role === GroupRole.Admin && data.role !== GroupRole.Admin) {
        await assertNotLastAdmin(member, context.dataSources)
      }

      return await (context.dataSources.groupMembers.updateOnePartial(member.id, {
        ...(data.name != null ? { name: data.name } : {}),
        role: data.role,
        observer: data.observer
      }) as Promise<GroupMemberDoc>)
    },
    async removeGroupMember (_, { memberId }, context) {
      const member = await existingMember(memberId, context)
      const { group, membership } = await groupAndMembership(member.groupId, context)
      context.allowUser.group(group, membership).manageMembers.assert()

      return await detachMember(member, context)
    },
    async leaveGroup (_, { groupId }, context) {
      const { group, membership } = await groupAndMembership(groupId, context)
      context.allowUser.group(group, membership).get.assert()
      if (!membership) throw new AuthorizationError()

      await detachMember(membership, context)
      return group
    },

  },
  GroupMember: {
    async group (member, _, context) {
      return await existingGroup(member.groupId, context)
    },
    async user (member, _, { dataSources }) {
      if (member.userId == null) return null
      return await dataSources.users.findOneById(member.userId, { ttl: 60 }) ?? null
    },
    async name (member, _, { dataSources }) {
      if (member.userId == null) return member.name ?? ''
      const user = await dataSources.users.findOneById(member.userId, { ttl: 60 })
      return user?.name ?? member.name ?? user?.username ?? ''
    },
    async checklist (member, _, context) {
      const { group, membership } = await groupAndMembership(member.groupId, context)
      context.allowUser.group(group, membership).get.assert()

      return await context.dataSources.trickCompletions.findManyByAthlete(checklistAthlete(member), { ttl: 60 })
    },
    async checklistStats (member, _, context) {
      const { group, membership } = await groupAndMembership(member.groupId, context)
      context.allowUser.group(group, membership).get.assert()

      const completions = await context.dataSources.trickCompletions.findManyByAthlete(checklistAthlete(member), { ttl: 60 })
      return await checklistStats(completions, context.dataSources)
    },
    async speedPersonalBests (member, _, context) {
      const { group, membership } = await groupAndMembership(member.groupId, context)
      context.allowUser.group(group, membership).get.assert()

      const eventDefinitions = await context.dataSources.eventDefinitions.findAllOrdered({ ttl: 3600 })
      return await context.dataSources.speedResults.findBestsByMember(member.id, eventDefinitions.map(eventDefinition => eventDefinition.id), { ttl: 60 })
    },
    async speedBests (member, _, context) {
      const { group, membership } = await groupAndMembership(member.groupId, context)
      context.allowUser.group(group, membership).get.assert()

      const eventDefinitions = await context.dataSources.eventDefinitions.findAllOrdered({ ttl: 3600 })
      // an athlete with an account is ranked on everything they competed in, not just this group's scores
      return member.userId != null
        ? await context.dataSources.speedResults.findBestsByAthleteUser(member.userId, eventDefinitions, { ttl: 60 })
        : await context.dataSources.speedResults.findBestsByAthleteMember(member.id, eventDefinitions, { ttl: 60 })
    },
    async speedProgression (member, { eventDefinitionId }, context) {
      const { group, membership } = await groupAndMembership(member.groupId, context)
      context.allowUser.group(group, membership).get.assert()

      const eventDefinition = await context.dataSources.eventDefinitions.findOneById(eventDefinitionId, { ttl: 3600 })
      if (!eventDefinition) throw new NotFoundError(`Event definition ${eventDefinitionId} not found`, { extensions: { entity: 'event-definition', id: eventDefinitionId } })

      const results = await context.dataSources.speedResults.findManyByAthleteMemberAndEvent(member.id, eventDefinition.id, { ttl: 60 })
      return results.map(result => segmentResultOf(result, { memberId: member.id }, eventDefinition))
    }
  },
}
