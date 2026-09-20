import { AuthorizationError, ValidationError } from '../errors.js'
import { GroupRole } from '../generated/graphql.js'
import { assertNotLastAdmin, detachMember, existingGroup, existingMember, groupAndMembership } from '../helpers/groups.js'
import { checklistStats } from '../helpers/checklist.js'
import { checklistAthlete } from '../store/schema.js'
import { groupAthleteNameSchema, groupMemberInputSchema } from '../validation.js'

import type { Resolvers } from '../generated/graphql.js'
import type { GroupMemberDoc } from '../store/schema.js'

export const groupMemberResolvers: Resolvers = {
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
    }
  },
}
