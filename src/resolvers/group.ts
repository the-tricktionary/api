import { FieldValue, Timestamp } from '@google-cloud/firestore'

import { AuthorizationError, CollisionError, NotFoundError, UnexpectedError, ValidationError } from '../errors.js'
import { GroupInviteKind, GroupInviteStatus, GroupRole } from '../generated/graphql.js'
import { generateJoinCode } from '../services/joinCode.js'
import { deleteInChunks, firestore } from '../store/firestoreDataSource.js'
import { groupAthleteNameSchema, groupMemberInputSchema, groupNameSchema, joinCodeSchema, usernameSchema } from '../validation.js'

import type { ApolloContext } from '../apollo.js'
import type { Resolvers } from '../generated/graphql.js'
import type { DataSources } from '../store/firestoreDataSource.js'
import type { GroupDoc, GroupInviteDoc, GroupMemberDoc } from '../store/schema.js'

type Context = Pick<ApolloContext, 'dataSources' | 'user'>

function byNewest (a: { createdAt: Timestamp }, b: { createdAt: Timestamp }) {
  return b.createdAt.toMillis() - a.createdAt.toMillis()
}

function byMemberOrder (a: GroupMemberDoc, b: GroupMemberDoc) {
  if (a.observer !== b.observer) return a.observer ? 1 : -1
  return a.createdAt.toMillis() - b.createdAt.toMillis()
}

async function existingGroup (groupId: string, { dataSources }: Pick<Context, 'dataSources'>) {
  const group = await dataSources.groups.findOneById(groupId, { ttl: 60 })
  if (!group) throw new NotFoundError(`Group ${groupId} not found`, { extensions: { entity: 'group', id: groupId } })
  return group
}

async function existingMember (memberId: string, { dataSources }: Pick<Context, 'dataSources'>) {
  const member = await dataSources.groupMembers.findOneById(memberId)
  if (!member) throw new NotFoundError(`Group member ${memberId} not found`, { extensions: { entity: 'group-member', id: memberId } })
  return member
}

async function existingInvite (inviteId: string, { dataSources }: Pick<Context, 'dataSources'>) {
  const invite = await dataSources.groupInvites.findOneById(inviteId)
  if (!invite) throw new NotFoundError(`Group invite ${inviteId} not found`, { extensions: { entity: 'group-invite', id: inviteId } })
  return invite
}

async function membershipOf (groupId: string, { dataSources, user }: Context) {
  if (!user) return undefined
  return await dataSources.groupMembers.findOneByGroupAndUser(groupId, user.id)
}

async function groupAndMembership (groupId: string, context: Context) {
  const group = await existingGroup(groupId, context)
  const membership = await membershipOf(group.id, context)
  return { group, membership }
}

async function reloadInvite (inviteId: string, { dataSources }: Pick<Context, 'dataSources'>) {
  await dataSources.groupInvites.deleteFromCacheById(inviteId)
  return await existingInvite(inviteId, { dataSources })
}

/** Unlike `Query.user`, finds a user whether or not their profile is public */
async function findUserToInvite (usernameOrId: string, dataSources: DataSources) {
  const query = usernameOrId.trim()
  if (!query) return undefined

  const username = usernameSchema.safeParse(query)
  const [byId, byUsername] = await Promise.all([
    dataSources.users.findOneById(query, { ttl: 60 }),
    username.success ? dataSources.users.findOneByUsername(username.data, { ttl: 60 }) : undefined
  ])
  // the id wins, so a lowercase uid cannot be claimed as somebody's username
  return byId ?? byUsername
}

/** An athlete row an invite may hand over: in this group, and not already somebody's */
async function claimableMember (memberId: string, groupId: string, { dataSources }: Pick<Context, 'dataSources'>) {
  const member = await existingMember(memberId, { dataSources })
  if (member.groupId !== groupId) {
    throw new NotFoundError(`Group member ${memberId} not found`, { extensions: { entity: 'group-member', id: memberId } })
  }
  if (member.userId != null) {
    throw new CollisionError('That athlete already has an account of their own', { extensions: { entity: 'group-member', id: memberId } })
  }
  return member
}

/** `athleteMemberIds` arrives with the group speed work, so this matches nothing yet */
async function hasCompeted (memberId: string, dataSources: DataSources) {
  const [result] = await dataSources.speedResults.findManyByQuery(c => c
    .where('athleteMemberIds', 'array-contains', memberId)
    .limit(1))
  return result != null
}

async function assertNotLastAdmin (member: GroupMemberDoc, dataSources: DataSources) {
  if (member.role !== GroupRole.Admin || member.userId == null) return
  const admins = await dataSources.groupMembers.findManyAdminsByGroup(member.groupId)
  const others = admins.filter(other => other.id !== member.id && other.userId != null)
  if (!others.length) {
    throw new ValidationError('A group needs an admin, so the last one cannot be removed, demoted or leave')
  }
}

/** Somebody who has competed is kept as an athlete the group manages, so its scores still name them */
async function detachMember (member: GroupMemberDoc, { dataSources }: Pick<Context, 'dataSources'>) {
  await assertNotLastAdmin(member, dataSources)

  if (await hasCompeted(member.id, dataSources)) {
    if (member.userId == null) {
      throw new CollisionError(
        'That athlete competed in scores the group holds, so they cannot be removed',
        { extensions: { entity: 'group-member', id: member.id } }
      )
    }

    const detached = await dataSources.users.findOneById(member.userId, { ttl: 60 })
    const name = member.name ?? detached?.name ?? detached?.username

    return await (dataSources.groupMembers.updateOnePartial(member.id, {
      userId: FieldValue.delete(),
      ...(name != null ? { name } : {}),
      role: GroupRole.Member,
      observer: false
    }) as Promise<GroupMemberDoc>)
  }

  await dataSources.groupMembers.deleteOne(member.id)
  return member
}

/** The transaction is what keeps two invitations answered at once from leaving a user with two rows */
async function acceptInvite (invite: GroupInviteDoc, memberId: string | null | undefined, { dataSources }: Pick<Context, 'dataSources'>) {
  const members = dataSources.groupMembers.collection
  const invites = dataSources.groupInvites.collection
  const now = Timestamp.now()
  let claimedId = memberId ?? ''

  await firestore.runTransaction(async tx => {
    const held = await tx.get(members
      .where('groupId', '==', invite.groupId)
      .where('userId', '==', invite.userId)
      .limit(1))
    const claimSnap = memberId != null ? await tx.get(members.doc(memberId)) : undefined

    if (!held.empty) {
      throw new CollisionError('That user is already in the group', { extensions: { entity: 'group', id: invite.groupId } })
    }

    if (claimSnap != null) {
      const claimed = claimSnap.data()
      if (claimed?.groupId !== invite.groupId) {
        throw new NotFoundError(`Group member ${memberId} not found`, { extensions: { entity: 'group-member', id: memberId } })
      }
      if (claimed.userId != null) {
        throw new CollisionError('That athlete has already been claimed', { extensions: { entity: 'group-member', id: memberId } })
      }
      tx.update(claimSnap.ref, { userId: invite.userId, role: invite.role, observer: invite.observer })
    } else {
      const memberRef = members.doc()
      claimedId = memberRef.id
      tx.create(memberRef, {
        id: memberRef.id,
        collection: 'group-members',
        createdAt: now,
        updatedAt: now,
        groupId: invite.groupId,
        userId: invite.userId,
        role: invite.role,
        observer: invite.observer
      })
    }

    tx.update(invites.doc(invite.id), { status: GroupInviteStatus.Accepted })
  })

  // the transaction bypassed the data source cache
  if (claimedId) await dataSources.groupMembers.deleteFromCacheById(claimedId)
  return await reloadInvite(invite.id, { dataSources })
}

async function uniqueJoinCode (dataSources: DataSources) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateJoinCode()
    const taken = await dataSources.groups.findOneByJoinCode(code)
    if (!taken) return code
  }
  throw new UnexpectedError('Could not generate a join code that was not already taken')
}

export const groupResolvers: Resolvers = {
  Query: {
    async group (_, { groupId }, context) {
      const group = await context.dataSources.groups.findOneById(groupId, { ttl: 60 })
      if (!group) return null
      const membership = await membershipOf(group.id, context)
      if (!context.allowUser.group(group, membership).get()) return null
      return group
    },
    async groupByJoinCode (_, { joinCode }, { dataSources, allowUser }) {
      allowUser.requestToJoinGroup.assert()
      const code = joinCodeSchema.parse(joinCode)
      return await dataSources.groups.findOneByJoinCode(code) ?? null
    }
  },
  Mutation: {
    async createGroup (_, { name: rawName }, context) {
      const { dataSources, allowUser, user } = context
      allowUser.createGroup.assert()
      if (!user) throw new AuthorizationError()

      const name = groupNameSchema.parse(rawName)
      const groups = dataSources.groups.collection
      const members = dataSources.groupMembers.collection
      const groupRef = groups.doc()
      const memberRef = members.doc()
      const now = Timestamp.now()

      const batch = firestore.batch()
      batch.create(groupRef, {
        id: groupRef.id,
        collection: 'groups',
        createdAt: now,
        updatedAt: now,
        name,
        createdBy: user.id
      })
      batch.create(memberRef, {
        id: memberRef.id,
        collection: 'group-members',
        createdAt: now,
        updatedAt: now,
        groupId: groupRef.id,
        userId: user.id,
        role: GroupRole.Admin,
        observer: false
      })
      await batch.commit()

      return await existingGroup(groupRef.id, context)
    },
    async updateGroup (_, { groupId, name: rawName }, context) {
      const { group, membership } = await groupAndMembership(groupId, context)
      context.allowUser.group(group, membership).edit.assert()

      const name = groupNameSchema.parse(rawName)
      return await (context.dataSources.groups.updateOnePartial(group.id, { name }) as Promise<GroupDoc>)
    },
    async deleteGroup (_, { groupId }, context) {
      const { dataSources } = context
      const { group, membership } = await groupAndMembership(groupId, context)
      context.allowUser.group(group, membership).delete.assert()

      const [inUse] = await dataSources.speedResults.findManyByQuery(c => c.where('groupId', '==', group.id).limit(1))
      if (inUse) {
        throw new CollisionError(
          'Speed scores are shared with this group, so it cannot be deleted',
          { extensions: { entity: 'group', id: group.id } }
        )
      }

      const [members, invites] = await Promise.all([
        dataSources.groupMembers.findManyByGroup(group.id),
        dataSources.groupInvites.findManyByQuery(c => c.where('groupId', '==', group.id))
      ])

      await deleteInChunks([
        ...members.map(member => dataSources.groupMembers.collection.doc(member.id)),
        ...invites.map(invite => dataSources.groupInvites.collection.doc(invite.id)),
        dataSources.groups.collection.doc(group.id)
      ])

      await Promise.all([
        ...members.map(async member => { await dataSources.groupMembers.deleteFromCacheById(member.id) }),
        ...invites.map(async invite => { await dataSources.groupInvites.deleteFromCacheById(invite.id) }),
        dataSources.groups.deleteFromCacheById(group.id)
      ])

      return group
    },

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

      const observer = data.observer ?? member.observer
      if (observer && member.userId == null) {
        throw new ValidationError('An athlete with no account of their own cannot be an observer')
      }
      if (data.role != null && data.role !== member.role && member.role === GroupRole.Admin) {
        await assertNotLastAdmin(member, context.dataSources)
      }
      if (data.name != null && member.userId != null) {
        throw new ValidationError('That member has an account, so their name is theirs to set')
      }

      return await (context.dataSources.groupMembers.updateOnePartial(member.id, {
        ...(data.name != null ? { name: data.name } : {}),
        ...(data.role != null ? { role: data.role } : {}),
        ...(data.observer != null ? { observer: data.observer } : {})
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

    async inviteToGroup (_, { groupId, usernameOrId, role, observer, memberId }, context) {
      const { dataSources, user } = context
      const { group, membership } = await groupAndMembership(groupId, context)
      context.allowUser.group(group, membership).invite.assert()
      if (!user) throw new AuthorizationError()

      if (observer && memberId != null) {
        throw new ValidationError('An observer does not compete, so they cannot take over an athlete')
      }

      const target = await findUserToInvite(usernameOrId, dataSources)
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
        throw new CollisionError('That user already has an invitation or a request waiting', { extensions: { entity: 'group-invite', id: alreadyAsked.id } })
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
        status: GroupInviteStatus.Pending
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

      if (!accept) {
        return await (context.dataSources.groupInvites.updateOnePartial(invite.id, { status: GroupInviteStatus.Declined }) as Promise<GroupInviteDoc>)
      }
      return await acceptInvite(invite, invite.memberId, context)
    },

    async setGroupJoinCode (_, { groupId }, context) {
      const { group, membership } = await groupAndMembership(groupId, context)
      context.allowUser.group(group, membership).manageJoinCode.assert()

      const joinCode = await uniqueJoinCode(context.dataSources)
      return await (context.dataSources.groups.updateOnePartial(group.id, { joinCode }) as Promise<GroupDoc>)
    },
    async clearGroupJoinCode (_, { groupId }, context) {
      const { group, membership } = await groupAndMembership(groupId, context)
      context.allowUser.group(group, membership).manageJoinCode.assert()

      return await (context.dataSources.groups.updateOnePartial(group.id, { joinCode: FieldValue.delete() }) as Promise<GroupDoc>)
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
        throw new CollisionError('You already have an invitation or a request waiting for that group', { extensions: { entity: 'group-invite', id: alreadyAsked.id } })
      }

      return await (dataSources.groupInvites.createOne({
        groupId: group.id,
        userId: user.id,
        kind: GroupInviteKind.Requested,
        role: GroupRole.Member,
        observer: false,
        status: GroupInviteStatus.Pending
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

      if (!accept) {
        return await (context.dataSources.groupInvites.updateOnePartial(invite.id, { status: GroupInviteStatus.Declined }) as Promise<GroupInviteDoc>)
      }

      if (memberId != null) await claimableMember(memberId, group.id, context)
      return await acceptInvite(invite, memberId ?? invite.memberId, context)
    }
  },
  Group: {
    async members (group, _, context) {
      const membership = await membershipOf(group.id, context)
      context.allowUser.group(group, membership).get.assert()

      const members = await context.dataSources.groupMembers.findManyByGroup(group.id, { ttl: 60 })
      return members.sort(byMemberOrder)
    },
    async myMembership (group, _, context) {
      return await membershipOf(group.id, context) ?? null
    },
    async invites (group, _, context) {
      const membership = await membershipOf(group.id, context)
      if (!context.allowUser.group(group, membership).manageMembers()) return []

      const invites = await context.dataSources.groupInvites.findManyPendingByGroup(group.id)
      return invites.sort(byNewest)
    },
    async joinCode (group, _, context) {
      const membership = await membershipOf(group.id, context)
      if (!context.allowUser.group(group, membership).manageJoinCode()) return null
      return group.joinCode ?? null
    }
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
    }
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
