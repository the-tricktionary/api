import { AuthorizationError, CollisionError, NotFoundError, ValidationError } from '../errors.js'
import { GroupInviteKind, GroupInviteStatus, GroupRole } from '../generated/graphql.js'
import { acceptInvite, claimableMember, existingGroup, existingInvite, groupAndMembership } from '../helpers/groups.js'
import { findUserByUsernameOrId } from '../helpers/users.js'
import { groupInviteExpired, groupInviteExpiry } from '../store/schema.js'
import { joinCodeSchema } from '../validation.js'

import type { Resolvers } from '../generated/graphql.js'
import type { GroupInviteDoc } from '../store/schema.js'

export const groupInviteResolvers: Resolvers = {
  Mutation: {
    async inviteToGroup (_, { groupId, usernameOrId, role, observer, memberId }, context) {
      const { dataSources, user } = context
      const { group, membership } = await groupAndMembership(groupId, context)
      context.allowUser.group(group, membership).invite.assert()
      if (!user) throw new AuthorizationError()

      if (observer && memberId != null) {
        throw new ValidationError('An observer does not compete, so they cannot take over an athlete')
      }

      const target = await findUserByUsernameOrId(usernameOrId, dataSources)
      if (!target) {
        throw new NotFoundError(`No user matches ${usernameOrId}`, { extensions: { entity: 'user', id: usernameOrId } })
      }

      const [alreadyIn, alreadyAsked] = await Promise.all([
        dataSources.groupMembers.findOneByGroupAndUser(group.id, target.id),
        dataSources.groupInvites.findOnePendingByGroupAndUser(group.id, target.id)
      ])
      if (alreadyIn) {
        throw new CollisionError('That user is already in the group', { extensions: { entity: 'group', id: group.id } })
      }
      if (alreadyAsked) {
        if (!groupInviteExpired(alreadyAsked)) {
          throw new CollisionError('That user already has an invitation or a request waiting', { extensions: { entity: 'group-invite', id: alreadyAsked.id } })
        }
        await dataSources.groupInvites.deleteOne(alreadyAsked.id)
      }

      if (memberId != null) await claimableMember(memberId, group.id, context)

      return await (dataSources.groupInvites.createOne({
        groupId: group.id,
        userId: target.id,
        kind: GroupInviteKind.Invited,
        role,
        observer,
        ...(memberId != null ? { memberId } : {}),
        invitedBy: user.id,
        status: GroupInviteStatus.Pending,
        expiresAt: groupInviteExpiry()
      }) as Promise<GroupInviteDoc>)
    },
    async cancelGroupInvite (_, { inviteId }, context) {
      const invite = await existingInvite(inviteId, context)
      const { group, membership } = await groupAndMembership(invite.groupId, context)
      context.allowUser.group(group, membership).invite.assert()

      if (invite.status !== GroupInviteStatus.Pending) {
        throw new ValidationError('That invitation has already been answered')
      }

      await context.dataSources.groupInvites.deleteOne(invite.id)
      return invite
    },
    async respondToGroupInvite (_, { inviteId, accept }, context) {
      const { user } = context
      if (!user) throw new AuthorizationError()

      const invite = await existingInvite(inviteId, context)
      if (invite.userId !== user.id) throw new AuthorizationError('That invitation is not yours to answer')
      if (invite.kind !== GroupInviteKind.Invited) {
        throw new ValidationError('That is a request to join, which the group\'s admins answer')
      }
      if (invite.status !== GroupInviteStatus.Pending) {
        throw new ValidationError('That invitation has already been answered')
      }
      if (groupInviteExpired(invite)) throw new ValidationError('That invitation has expired')

      if (!accept) {
        return await (context.dataSources.groupInvites.updateOnePartial(invite.id, { status: GroupInviteStatus.Declined }) as Promise<GroupInviteDoc>)
      }
      return await acceptInvite(invite, invite.memberId, context)
    },

    async requestToJoinGroup (_, { joinCode }, context) {
      const { dataSources, allowUser, user } = context
      allowUser.requestToJoinGroup.assert()
      if (!user) throw new AuthorizationError()

      const code = joinCodeSchema.parse(joinCode)
      const group = await dataSources.groups.findOneByJoinCode(code)
      if (!group) throw new NotFoundError('No group has that join code', { extensions: { entity: 'group', id: code } })

      const [alreadyIn, alreadyAsked] = await Promise.all([
        dataSources.groupMembers.findOneByGroupAndUser(group.id, user.id),
        dataSources.groupInvites.findOnePendingByGroupAndUser(group.id, user.id)
      ])
      if (alreadyIn) {
        throw new CollisionError('You are already in that group', { extensions: { entity: 'group', id: group.id } })
      }
      if (alreadyAsked) {
        if (!groupInviteExpired(alreadyAsked)) {
          throw new CollisionError('You already have an invitation or a request waiting for that group', { extensions: { entity: 'group-invite', id: alreadyAsked.id } })
        }
        await dataSources.groupInvites.deleteOne(alreadyAsked.id)
      }

      return await (dataSources.groupInvites.createOne({
        groupId: group.id,
        userId: user.id,
        kind: GroupInviteKind.Requested,
        role: GroupRole.Member,
        observer: false,
        status: GroupInviteStatus.Pending,
        expiresAt: groupInviteExpiry()
      }) as Promise<GroupInviteDoc>)
    },
    async respondToGroupJoinRequest (_, { inviteId, accept, memberId }, context) {
      const invite = await existingInvite(inviteId, context)
      const { group, membership } = await groupAndMembership(invite.groupId, context)
      context.allowUser.group(group, membership).manageMembers.assert()

      if (invite.kind !== GroupInviteKind.Requested) {
        throw new ValidationError('That is an invitation, which the person invited answers')
      }
      if (invite.status !== GroupInviteStatus.Pending) {
        throw new ValidationError('That request has already been answered')
      }
      if (groupInviteExpired(invite)) throw new ValidationError('That request has expired')

      if (!accept) {
        return await (context.dataSources.groupInvites.updateOnePartial(invite.id, { status: GroupInviteStatus.Declined }) as Promise<GroupInviteDoc>)
      }

      if (memberId != null) await claimableMember(memberId, group.id, context)
      return await acceptInvite(invite, memberId ?? invite.memberId, context)
    },

  },
  GroupInvite: {
    async group (invite, _, context) {
      return await existingGroup(invite.groupId, context)
    },
    async user (invite, _, { dataSources }) {
      const user = await dataSources.users.findOneById(invite.userId, { ttl: 60 })
      if (!user) throw new NotFoundError(`User ${invite.userId} not found`, { extensions: { entity: 'user', id: invite.userId } })
      return user
    },
    async member (invite, _, { dataSources }) {
      if (invite.memberId == null) return null
      return await dataSources.groupMembers.findOneById(invite.memberId) ?? null
    },
    async invitedBy (invite, _, { dataSources }) {
      if (invite.invitedBy == null) return null
      return await dataSources.users.findOneById(invite.invitedBy, { ttl: 60 }) ?? null
    }
  }
}
