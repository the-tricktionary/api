import { FieldValue, Timestamp } from '@google-cloud/firestore'
import type z from 'zod'

import type { ApolloContext } from '../apollo.js'
import type { Resolvers } from '../generated/graphql.js'
import type { EventDefinitionDoc, SpeedMark, SpeedResultDoc } from '../store/schema.js'
import { AuthorizationError, NotFoundError, ValidationError } from '../errors.js'
import type { speedMarkSchema, speedParticipantSchema } from '../validation.js'
import { speedResultCreateSchema, speedResultGroupSchema, speedResultUpdateSchema } from '../validation.js'
import { analysisOf, assertValidMarkStream, countSteps, marksOf, segmentBounds } from '../helpers/speedMarks.js'
import { existingGroup, existingMember, groupAndMembership, membershipOf } from '../helpers/groups.js'
import type { DerivedParticipants } from '../helpers/speedParticipants.js'
import { assertValidParticipants, deriveParticipants, ownParticipants, participantUpdate } from '../helpers/speedParticipants.js'

function toMark (mark: z.infer<typeof speedMarkSchema>): SpeedMark {
  return {
    sequence: mark.sequence,
    timestamp: mark.timestamp.toMillis(),
    schema: mark.schema,
    ...(mark.value != null ? { value: mark.value } : {}),
    ...(mark.target != null ? { target: mark.target } : {})
  }
}

/**
 * A stable id for the client cache, since a custom definition has no document.
 *
 * The switches are part of it: two custom events sharing a name and duration
 * but splitting at different times are different events, and results against
 * them must not be compared as if they were the same one. An event without
 * switches keeps the id it has always had.
 */
function customEventDefinitionId (eventDefinition: NonNullable<SpeedResultDoc['eventDefinition']>): string {
  const switches = (eventDefinition.cues ?? []).map(cue => cue.offset).join(',')
  const key = `${eventDefinition.name}-${eventDefinition.totalDuration}${switches ? `-${switches}` : ''}`
  return Buffer.from(key, 'utf-8').toString('base64')
}

function customEventDefinition (eventDefinition: NonNullable<SpeedResultDoc['eventDefinition']>): EventDefinitionDoc {
  const { name, totalDuration, cues } = eventDefinition
  return {
    name,
    totalDuration,
    collection: 'event-definitions',
    ...(cues?.length ? { timingTrack: { cues } } : {}),
    id: customEventDefinitionId(eventDefinition)
  } as EventDefinitionDoc
}

async function eventDefinitionOf (speedResult: Pick<SpeedResultDoc, 'id' | 'eventDefinitionId' | 'eventDefinition'>, { dataSources }: Pick<ApolloContext, 'dataSources'>): Promise<EventDefinitionDoc> {
  if (speedResult.eventDefinitionId) {
    const eventDefinition = await dataSources.eventDefinitions.findOneById(speedResult.eventDefinitionId, { ttl: 3600 })
    if (!eventDefinition) throw new NotFoundError('Event definition not found', { extensions: { entity: 'event-definition', id: speedResult.eventDefinitionId } })
    return eventDefinition
  } else if (speedResult.eventDefinition) {
    return customEventDefinition(speedResult.eventDefinition)
  } else {
    throw new NotFoundError('Event definition not found', { extensions: { entity: 'event-definition', id: speedResult.id } })
  }
}

type ParticipantInput = z.infer<typeof speedParticipantSchema>

interface EventDefinitionInput {
  eventDefinitionId?: string | null
  eventDefinition?: NonNullable<SpeedResultDoc['eventDefinition']> | null
}

/**
 * Validates the event definition part of an input, returning the fields to
 * write on the result document alongside the event they resolve to. On create
 * omitting both is an error and the unused field is simply left out; on update
 * omitting both means "leave as is" and the field the result no longer uses is
 * deleted, which Firestore only allows in an update.
 */
async function eventDefinitionFields (data: EventDefinitionInput, context: Pick<ApolloContext, 'dataSources'>, options: { mode: 'create' }): Promise<{ fields: Partial<SpeedResultDoc>, event: EventDefinitionDoc }>
async function eventDefinitionFields (data: EventDefinitionInput, context: Pick<ApolloContext, 'dataSources'>, options: { mode: 'update' }): Promise<{ fields: Partial<SpeedResultDoc>, event?: EventDefinitionDoc }>
async function eventDefinitionFields (data: EventDefinitionInput, { dataSources }: Pick<ApolloContext, 'dataSources'>, { mode }: { mode: 'create' | 'update' }): Promise<{ fields: Partial<SpeedResultDoc>, event?: EventDefinitionDoc }> {
  if (data.eventDefinitionId) {
    const eventDefinition = await dataSources.eventDefinitions.findOneById(data.eventDefinitionId, { ttl: 3600 })
    if (!eventDefinition) throw new NotFoundError('Event definition not found', { extensions: { entity: 'event-definition', id: data.eventDefinitionId } })
    return {
      event: eventDefinition,
      fields: {
        eventDefinitionId: eventDefinition.id,
        ...(mode === 'update' ? { eventDefinition: FieldValue.delete() as unknown as undefined } : {})
      }
    }
  } else if (data.eventDefinition) {
    return {
      event: customEventDefinition(data.eventDefinition),
      fields: {
        ...(mode === 'update' ? { eventDefinitionId: FieldValue.delete() as unknown as undefined } : {}),
        eventDefinition: data.eventDefinition
      }
    }
  } else if (mode === 'create') {
    throw new ValidationError('No event definition or event definition id specified')
  }
  return { fields: {} }
}

/** The event's own switches decide, the snapshot on the result stands in when it has none */
function segmentCountOf (eventDefinition: EventDefinitionDoc, timingTrack?: SpeedResultDoc['timingTrack']) {
  return segmentBounds(eventDefinition.totalDuration, eventDefinition.timingTrack ?? timingTrack).length
}

async function derivedParticipants (
  data: { groupId?: string | null, participants?: readonly ParticipantInput[] | null },
  { creatorId, segmentCount }: { creatorId: string, segmentCount: number },
  context: Pick<ApolloContext, 'dataSources' | 'user' | 'allowUser'>
): Promise<DerivedParticipants> {
  if (!data.groupId) {
    if (data.participants?.length) throw new ValidationError('Only a score shared with a group can name who competed')
    return ownParticipants(creatorId)
  }

  const { group, membership } = await groupAndMembership(data.groupId, context)
  context.allowUser.group(group, membership).get.assert('You can only share a score with a group you are in')

  const members = new Map((await context.dataSources.groupMembers.findManyByGroup(group.id, { ttl: 60 })).map(member => [member.id, member]))
  const participants = (data.participants ?? []).map(participant => ({
    ...(participant.segmentIndex != null ? { segmentIndex: participant.segmentIndex } : {}),
    memberId: participant.memberId
  }))
  assertValidParticipants(participants, members, segmentCount)
  return deriveParticipants(participants, members)
}

async function sharedWithCaller (speedResult: SpeedResultDoc, { dataSources, allowUser, user }: Pick<ApolloContext, 'dataSources' | 'allowUser' | 'user'>) {
  if (!speedResult.groupId) return false
  const creator = await dataSources.users.findOneById(speedResult.userId, { ttl: 60 })
  if (!creator) return false
  const membership = await membershipOf(speedResult.groupId, { dataSources, user })
  return allowUser.user(creator).speedResult(speedResult, membership).getGroup()
}

async function manageableSpeedResult (speedResultId: string, { dataSources, allowUser, user }: Pick<ApolloContext, 'dataSources' | 'allowUser' | 'user'>, action: 'edit' | 'delete') {
  const speedResult = await dataSources.speedResults.findOneById(speedResultId)
  if (!speedResult) throw new NotFoundError('Speed result not found', { extensions: { entity: 'speed-result', id: speedResultId } })
  const speedResultUser = await dataSources.users.findOneById(speedResult.userId, { ttl: 3600 })
  if (!speedResultUser) throw new NotFoundError('Speed result user not found', { extensions: { entity: 'user', id: speedResult.userId } })
  const membership = speedResult.groupId ? await membershipOf(speedResult.groupId, { dataSources, user }) : undefined
  allowUser.user(speedResultUser).speedResult(speedResult, membership)[action].assert()
  return speedResult
}

export const speedResultResolvers: Resolvers = {
  Query: {},
  Mutation: {
    async createSpeedResult (_, { data: rawData }, { dataSources, allowUser, user }) {
      allowUser.createSpeedResult.assert()
      if (!user) throw new AuthorizationError()

      const data = speedResultCreateSchema.parse(rawData)
      const { fields: eventFields, event } = await eventDefinitionFields(data, { dataSources }, { mode: 'create' })

      let timingTrack = {}
      if (data.withTimingTrack) {
        if (!data.eventDefinitionId) throw new ValidationError('Only a known event definition can have a timing track')
        const eventDefinition = await dataSources.eventDefinitions.findOneById(data.eventDefinitionId, { ttl: 3600 })
        if (!eventDefinition?.timingTrack) throw new ValidationError('The event definition has no timing track')
        timingTrack = { timingTrack: eventDefinition.timingTrack }
      }

      let count: number
      let marks: SpeedMark[] | undefined
      if (data.marks?.length) {
        marks = data.marks.map(toMark)
        try {
          assertValidMarkStream(marks)
        } catch (err) {
          throw new ValidationError(err as Error)
        }
        count = countSteps(marks)
      } else if (typeof data.count === 'number') {
        count = data.count
      } else {
        throw new ValidationError('A count is required when no marks are provided')
      }

      const derived = await derivedParticipants(data, { creatorId: user.id, segmentCount: segmentCountOf(event) }, { dataSources, allowUser, user })

      return await (dataSources.speedResults.createOne({
        ...(data.name ? { name: data.name } : {}),
        userId: user.id,
        recordedAt: Timestamp.now(),
        count,
        ...eventFields,
        ...(marks ? { marks } : {}),
        ...timingTrack,
        ...(data.groupId ? { groupId: data.groupId } : {}),
        ...derived
      }, { ttl: 60 }) as Promise<SpeedResultDoc>)
    },
    async updateSpeedResult (_, { speedResultId, data: rawData }, context) {
      const speedResult = await manageableSpeedResult(speedResultId, context, 'edit')
      const data = speedResultUpdateSchema.parse(rawData)
      const { fields: eventFields } = await eventDefinitionFields(data, context, { mode: 'update' })

      let countFields = {}
      if (typeof data.count === 'number') {
        if (marksOf(speedResult).length) throw new ValidationError('The count of a result recorded from marks is derived from the marks and cannot be changed')
        countFields = { count: data.count }
      }

      // undefined leaves the name alone, null or an empty string clears it
      let nameFields = {}
      if (data.name !== undefined) {
        const name = data.name ?? ''
        nameFields = { name: name.length > 0 ? name : (FieldValue.delete() as unknown as undefined) }
      }

      return await (context.dataSources.speedResults.updateOnePartial(speedResult.id, {
        ...nameFields,
        ...countFields,
        ...eventFields
      }) as Promise<SpeedResultDoc>)
    },
    async setSpeedResultGroup (_, { speedResultId, data: rawData }, context) {
      const speedResult = await manageableSpeedResult(speedResultId, context, 'edit')
      const data = speedResultGroupSchema.parse(rawData)
      const eventDefinition = await eventDefinitionOf(speedResult, context)
      const derived = await derivedParticipants(
        data,
        { creatorId: speedResult.userId, segmentCount: segmentCountOf(eventDefinition, speedResult.timingTrack) },
        context
      )

      return await (context.dataSources.speedResults.updateOnePartial(speedResult.id, {
        groupId: data.groupId ?? FieldValue.delete(),
        ...participantUpdate(derived)
      }) as Promise<SpeedResultDoc>)
    },
    async deleteSpeedResult (_, { speedResultId }, context) {
      const speedResult = await manageableSpeedResult(speedResultId, context, 'delete')
      await context.dataSources.speedResults.deleteOne(speedResult.id)
      return speedResult
    }
  },
  SpeedResult: {
    createdAt (speedResult) {
      return speedResult.recordedAt ?? speedResult.createdAt
    },
    async creator (speedResult, _, { dataSources, allowUser, user }) {
      const creator = await dataSources.users.findOneById(speedResult.userId, { ttl: 60 })
      if (!creator) throw new NotFoundError('User not found', { extensions: { entity: 'user', id: speedResult.userId } })
      const membership = speedResult.groupId ? await membershipOf(speedResult.groupId, { dataSources, user }) : undefined
      allowUser.user(creator).speedResult(speedResult, membership).getCreator.assert()
      return creator
    },
    async group (speedResult, _, context) {
      if (!speedResult.groupId || !await sharedWithCaller(speedResult, context)) return null
      return await existingGroup(speedResult.groupId, context)
    },
    async participants (speedResult, _, context) {
      if (!speedResult.participants?.length || !await sharedWithCaller(speedResult, context)) return []
      return speedResult.participants
    },
    async eventDefinition (speedResult, _, context) {
      return await eventDefinitionOf(speedResult, context)
    },
    marks (speedResult) {
      return marksOf(speedResult)
    },
    timingTrack (speedResult) {
      return speedResult.timingTrack ?? null
    },
    counted (speedResult) {
      // Scanning the stream the document already carries, rather than running
      // the analysis, so a list of results stays cheap. A stream with no step
      // in it has nothing to analyse either, so the two agree.
      return marksOf(speedResult).some(mark => mark.schema === 'step')
    },
    async analysis (speedResult, _, context) {
      if (!marksOf(speedResult).length) return null
      return analysisOf(speedResult, await eventDefinitionOf(speedResult, context))
    }
  },
  SpeedParticipant: {
    segmentIndex (participant) {
      return participant.segmentIndex ?? null
    },
    async member (participant, _, { dataSources }) {
      return await existingMember(participant.memberId, { dataSources })
    }
  }
}
