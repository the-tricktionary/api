import { FieldValue, Timestamp } from '@google-cloud/firestore'

import { CollisionError, NotFoundError, UnexpectedError, ValidationError } from '../errors.js'
import { GroupInviteStatus, GroupRole } from '../generated/graphql.js'
import { generateJoinCode } from './joinCode.js'
import { firestore, writeInChunks } from '../store/firestoreDataSource.js'
import { usernameSchema } from '../validation.js'

import type { ApolloContext } from '../apollo.js'
import type { DataSources } from '../store/firestoreDataSource.js'
import type { GroupInviteDoc, GroupMemberDoc } from '../store/schema.js'

export type Context = Pick<ApolloContext, 'dataSources' | 'user'>

export function byNewest (a: { createdAt: Timestamp }, b: { createdAt: Timestamp }) {
  return b.createdAt.toMillis() - a.createdAt.toMillis()
}

export function byMemberOrder (a: GroupMemberDoc, b: GroupMemberDoc) {
  if (a.observer !== b.observer) return a.observer ? 1 : -1
  return a.createdAt.toMillis() - b.createdAt.toMillis()
}

export async function existingGroup (groupId: string, { dataSources }: Pick<Context, 'dataSources'>) {
  const group = await dataSources.groups.findOneById(groupId, { ttl: 60 })
  if (!group) throw new NotFoundError(`Group ${groupId} not found`, { extensions: { entity: 'group', id: groupId } })
  return group
}

export async function existingMember (memberId: string, { dataSources }: Pick<Context, 'dataSources'>) {
  const member = await dataSources.groupMembers.findOneById(memberId)
  if (!member) throw new NotFoundError(`Group member ${memberId} not found`, { extensions: { entity: 'group-member', id: memberId } })
  return member
}

export async function existingInvite (inviteId: string, { dataSources }: Pick<Context, 'dataSources'>) {
  const invite = await dataSources.groupInvites.findOneById(inviteId)
  if (!invite) throw new NotFoundError(`Group invite ${inviteId} not found`, { extensions: { entity: 'group-invite', id: inviteId } })
  return invite
}

export async function membershipOf (groupId: string, { dataSources, user }: Context) {
  if (!user) return undefined
  return await dataSources.groupMembers.findOneByGroupAndUser(groupId, user.id)
}

export async function groupAndMembership (groupId: string, context: Context) {
  const group = await existingGroup(groupId, context)
  const membership = await membershipOf(group.id, context)
  return { group, membership }
}

export async function reloadInvite (inviteId: string, { dataSources }: Pick<Context, 'dataSources'>) {
  await dataSources.groupInvites.deleteFromCacheById(inviteId)
  return await existingInvite(inviteId, { dataSources })
}

/** Unlike `Query.user`, finds a user whether or not their profile is public */
export async function findUserToInvite (usernameOrId: string, dataSources: DataSources) {
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
export async function claimableMember (memberId: string, groupId: string, { dataSources }: Pick<Context, 'dataSources'>) {
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
export async function hasCompeted (memberId: string, dataSources: DataSources) {
  const [result] = await dataSources.speedResults.findManyByQuery(c => c
    .where('athleteMemberIds', 'array-contains', memberId)
    .limit(1))
  return result != null
}

export async function assertNotLastAdmin (member: GroupMemberDoc, dataSources: DataSources) {
  if (member.role !== GroupRole.Admin || member.userId == null) return
  const admins = await dataSources.groupMembers.findManyAdminsByGroup(member.groupId)
  const others = admins.filter(other => other.id !== member.id && other.userId != null)
  if (!others.length) {
    throw new ValidationError('A group needs an admin, so the last one cannot be removed, demoted or leave')
  }
}

/** Somebody who has competed is kept as an athlete the group manages, so its scores still name them */
export async function detachMember (member: GroupMemberDoc, { dataSources }: Pick<Context, 'dataSources'>) {
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

export async function claimChecklist (memberId: string, userId: string, dataSources: DataSources) {
  const recorded = await dataSources.trickCompletions.findManyByMember(memberId)
  if (!recorded.length) return

  const own = await dataSources.trickCompletions.findManyByUser(userId)
  const ownTricks = new Set(own.map(completion => completion.trickId))
  const collection = dataSources.trickCompletions.collection

  await writeInChunks(recorded, (batch, completion) => {
    const ref = collection.doc(completion.id)
    // a trick they had already ticked themselves would otherwise be counted twice
    if (ownTricks.has(completion.trickId)) batch.delete(ref)
    else batch.update(ref, { userId, memberId: FieldValue.delete() })
  })

  await Promise.all(recorded.map(async completion => {
    await dataSources.trickCompletions.deleteFromCacheById(completion.id)
  }))
}

/** The transaction is what keeps two invitations answered at once from leaving a user with two rows */
export async function acceptInvite (invite: GroupInviteDoc, memberId: string | null | undefined, { dataSources }: Pick<Context, 'dataSources'>) {
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
  if (claimedId) {
    await dataSources.groupMembers.deleteFromCacheById(claimedId)
    await claimChecklist(claimedId, invite.userId, dataSources)
  }
  return await reloadInvite(invite.id, { dataSources })
}

export async function uniqueJoinCode (dataSources: DataSources) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateJoinCode()
    const taken = await dataSources.groups.findOneByJoinCode(code)
    if (!taken) return code
  }
  throw new UnexpectedError('Could not generate a join code that was not already taken')
}
