import { FieldValue, Timestamp } from '@google-cloud/firestore'
import type z from 'zod'

import type { ApolloContext } from '../apollo.js'
import type { Resolvers } from '../generated/graphql.js'
import type { EventDefinitionDoc, SpeedMark, SpeedResultDoc } from '../store/schema.js'
import { AuthorizationError, NotFoundError, ValidationError } from '../errors.js'
import type { speedMarkSchema } from '../validation.js'
import { speedResultCreateSchema, speedResultUpdateSchema } from '../validation.js'
import { analyseMarks, assertValidMarkStream, countSteps, marksOf } from '../helpers/speedMarks.js'

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

/**
 * Resolves the event definition of a result, either the linked document or
 * the custom one embedded in the result. A custom event's switches become a
 * track of cues without audio, so everything downstream can treat the two
 * kinds of event alike.
 */
async function eventDefinitionOf (speedResult: SpeedResultDoc, { dataSources }: Pick<ApolloContext, 'dataSources'>): Promise<EventDefinitionDoc> {
  if (speedResult.eventDefinitionId) {
    const eventDefinition = await dataSources.eventDefinitions.findOneById(speedResult.eventDefinitionId, { ttl: 3600 })
    if (!eventDefinition) throw new NotFoundError('Event definition not found', { extensions: { entity: 'event-definition', id: speedResult.eventDefinitionId } })
    return eventDefinition
  } else if (speedResult.eventDefinition) {
    const { name, totalDuration, cues } = speedResult.eventDefinition
    return {
      name,
      totalDuration,
      collection: 'event-definitions',
      ...(cues?.length ? { timingTrack: { cues } } : {}),
      id: customEventDefinitionId(speedResult.eventDefinition)
    } as EventDefinitionDoc
  } else {
    throw new NotFoundError('Event definition not found', { extensions: { entity: 'event-definition', id: speedResult.id } })
  }
}

/**
 * Validates the event definition part of an input, returning the fields to
 * write on the result document. On create omitting both is an error and the
 * unused field is simply left out; on update omitting both means "leave as
 * is" and the field the result no longer uses is deleted, which Firestore
 * only allows in an update.
 */
async function eventDefinitionFields (data: { eventDefinitionId?: string | null, eventDefinition?: { name: string, totalDuration: number } | null }, { dataSources }: Pick<ApolloContext, 'dataSources'>, { mode }: { mode: 'create' | 'update' }) {
  if (data.eventDefinitionId) {
    const eventDefinition = await dataSources.eventDefinitions.findOneById(data.eventDefinitionId, { ttl: 3600 })
    if (!eventDefinition) throw new NotFoundError('Event definition not found', { extensions: { entity: 'event-definition', id: data.eventDefinitionId } })
    return {
      eventDefinitionId: eventDefinition.id,
      ...(mode === 'update' ? { eventDefinition: FieldValue.delete() as unknown as undefined } : {})
    }
  } else if (data.eventDefinition) {
    return {
      ...(mode === 'update' ? { eventDefinitionId: FieldValue.delete() as unknown as undefined } : {}),
      eventDefinition: data.eventDefinition
    }
  } else if (mode === 'create') {
    throw new ValidationError('No event definition or event definition id specified')
  }
  return {}
}

async function ownedSpeedResult (speedResultId: string, { dataSources, allowUser }: Pick<ApolloContext, 'dataSources' | 'allowUser'>, action: 'edit' | 'delete') {
  const speedResult = await dataSources.speedResults.findOneById(speedResultId)
  if (!speedResult) throw new NotFoundError('Speed result not found', { extensions: { entity: 'speed-result', id: speedResultId } })
  const speedResultUser = await dataSources.users.findOneById(speedResult.userId, { ttl: 3600 })
  if (!speedResultUser) throw new NotFoundError('Speed result user not found', { extensions: { entity: 'user', id: speedResult.userId } })
  allowUser.user(speedResultUser).speedResult(speedResult)[action].assert()
  return speedResult
}

export const speedResultResolvers: Resolvers = {
  Query: {},
  Mutation: {
    async createSpeedResult (_, { data: rawData }, { dataSources, allowUser, user }) {
      allowUser.createSpeedResult.assert()
      if (!user) throw new AuthorizationError()

      const data = speedResultCreateSchema.parse(rawData)
      const eventFields = await eventDefinitionFields(data, { dataSources }, { mode: 'create' })

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

      return await (dataSources.speedResults.createOne({
        ...(data.name ? { name: data.name } : {}),
        userId: user.id,
        createdAt: Timestamp.now(),
        count,
        ...eventFields,
        ...(marks ? { marks } : {}),
        ...timingTrack
      }, { ttl: 60 }) as Promise<SpeedResultDoc>)
    },
    async updateSpeedResult (_, { speedResultId, data: rawData }, context) {
      const speedResult = await ownedSpeedResult(speedResultId, context, 'edit')
      const data = speedResultUpdateSchema.parse(rawData)
      const eventFields = await eventDefinitionFields(data, context, { mode: 'update' })

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
    async deleteSpeedResult (_, { speedResultId }, context) {
      const speedResult = await ownedSpeedResult(speedResultId, context, 'delete')
      await context.dataSources.speedResults.deleteOne(speedResult.id)
      return speedResult
    }
  },
  SpeedResult: {
    async creator (speedResult, _, { dataSources, allowUser }) {
      const creator = await dataSources.users.findOneById(speedResult.userId, { ttl: 60 })
      if (!creator) throw new NotFoundError('User not found', { extensions: { entity: 'user', id: speedResult.userId } })
      allowUser.user(creator).speedResult(speedResult).getCreator.assert()
      return creator
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
      const marks = marksOf(speedResult)
      if (!marks.length) return null
      const eventDefinition = await eventDefinitionOf(speedResult, context)
      // The snapshot taken when the result was recorded wins. Falling back to
      // the event's own cues is only safe for a custom event, whose cues are
      // stored on the result itself: a known event's track can be edited
      // later, and that must not rewrite how an old result was segmented.
      const timing = speedResult.timingTrack ?? (speedResult.eventDefinitionId ? null : eventDefinition.timingTrack)
      return analyseMarks(marks, eventDefinition.totalDuration, timing)
    }
  }
}
