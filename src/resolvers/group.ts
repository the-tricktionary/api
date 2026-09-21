import { FieldValue, Timestamp } from '@google-cloud/firestore'

import { AuthorizationError, CollisionError } from '../errors.js'
import { GroupRole } from '../generated/graphql.js'
import { byMemberOrder, byNewest, existingGroup, groupAndMembership, membershipOf, uniqueJoinCode } from '../helpers/groups.js'
import { constellationKey } from '../helpers/speedParticipants.js'
import { groupConstellations } from '../helpers/speedResults.js'
import { deleteInChunks, firestore } from '../store/firestoreDataSource.js'
import { groupInviteExpired } from '../store/schema.js'
import { groupNameSchema, joinCodeSchema } from '../validation.js'

import type { Resolvers } from '../generated/graphql.js'
import type { GroupDoc } from '../store/schema.js'

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
      return invites.filter(invite => !groupInviteExpired(invite)).sort(byNewest)
    },
    async joinCode (group, _, context) {
      const membership = await membershipOf(group.id, context)
      if (!context.allowUser.group(group, membership).manageJoinCode()) return null
      return group.joinCode ?? null
    },
    async speedResults (group, { limit, startAfter, eventDefinitionId, constellation }, context) {
      const membership = await membershipOf(group.id, context)
      context.allowUser.group(group, membership).get.assert()

      return await context.dataSources.speedResults.findManyByGroup(group.id, {
        ttl: 60,
        limit,
        startAfter,
        eventDefinitionId,
        ...(constellation ? { constellationKey: constellationKey(constellation) } : {})
      })
    },
    async constellations (group, _, context) {
      const membership = await membershipOf(group.id, context)
      context.allowUser.group(group, membership).get.assert()

      const [results, members] = await Promise.all([
        context.dataSources.speedResults.findManyByGroup(group.id, { ttl: 60 }),
        context.dataSources.groupMembers.findManyByGroup(group.id, { ttl: 60 })
      ])
      return groupConstellations(results, members.sort(byMemberOrder))
    }
  },
}
