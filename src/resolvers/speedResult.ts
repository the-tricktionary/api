import { FieldValue, Timestamp } from '@google-cloud/firestore'
import z from 'zod'

import type { ApolloContext } from '../apollo.js'
import type { Resolvers } from '../generated/graphql.js'
import type { EventDefinitionDoc, SpeedMarkDoc, SpeedResultDoc } from '../store/schema.js'
import { AuthorizationError, NotFoundError, ValidationError } from '../errors.js'
import { analyseMarks, assertValidMarkStream, countSteps, marksOf } from '../services/speedMarks.js'

const MAX_MARKS = 20_000

const nameSchema = z.string().trim().max(120)
const countSchema = z.number().int().min(0).max(1_000_000)
const eventDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // 24 hours ought to be enough for anybody
  totalDuration: z.number().int().min(0).max(86_400)
})
const markSchema = z.object({
  sequence: z.number().int().min(0),
  timestamp: z.instanceof(Timestamp),
  schema: z.string().trim().min(1).max(32),
  value: z.number().nullish(),
  target: z.number().int().min(0).nullish()
})

const createSchema = z.object({
  name: nameSchema.nullish(),
  count: countSchema.nullish(),
  marks: z.array(markSchema).max(MAX_MARKS).nullish(),
  eventDefinitionId: z.string().min(1).nullish(),
  eventDefinition: eventDefinitionSchema.nullish()
})

const updateSchema = z.object({
  name: nameSchema.nullish(),
  count: countSchema.nullish(),
  eventDefinitionId: z.string().min(1).nullish(),
  eventDefinition: eventDefinitionSchema.nullish()
})

function toMarkDoc (mark: z.infer<typeof markSchema>): SpeedMarkDoc {
  return {
    sequence: mark.sequence,
    timestamp: mark.timestamp.toMillis(),
    schema: mark.schema,
    ...(mark.value != null ? { value: mark.value } : {}),
    ...(mark.target != null ? { target: mark.target } : {})
  }
}

/**
 * Resolves the event definition of a result, either the linked document or
 * the custom one embedded in the result.
 */
async function eventDefinitionOf (speedResult: SpeedResultDoc, { dataSources }: Pick<ApolloContext, 'dataSources'>): Promise<EventDefinitionDoc> {
  if (speedResult.eventDefinitionId) {
    const eventDefinition = await dataSources.eventDefinitions.findOneById(speedResult.eventDefinitionId, { ttl: 3600 })
    if (!eventDefinition) throw new NotFoundError('Event definition not found', { extensions: { entity: 'event-definition', id: speedResult.eventDefinitionId } })
    return eventDefinition
  } else if (speedResult.eventDefinition) {
    return {
      ...speedResult.eventDefinition,
      collection: 'event-definitions',
      // A stable id for the client cache, custom definitions have no document
      id: Buffer.from(`${speedResult.eventDefinition.name}-${speedResult.eventDefinition.totalDuration}`, 'utf-8').toString('base64')
    } as EventDefinitionDoc
  } else {
    throw new NotFoundError('Event definition not found', { extensions: { entity: 'event-definition', id: speedResult.id } })
  }
}

/**
 * Validates the event definition part of an input, returning the fields to
 * write on the result document. `required` decides whether omitting both is
 * an error (create) or means "leave as is" (update).
 */
async function eventDefinitionFields (data: { eventDefinitionId?: string | null, eventDefinition?: { name: string, totalDuration: number } | null }, { dataSources }: Pick<ApolloContext, 'dataSources'>, { required }: { required: boolean }) {
  if (data.eventDefinitionId) {
    const eventDefinition = await dataSources.eventDefinitions.findOneById(data.eventDefinitionId, { ttl: 3600 })
    if (!eventDefinition) throw new NotFoundError('Event definition not found', { extensions: { entity: 'event-definition', id: data.eventDefinitionId } })
    return {
      eventDefinitionId: eventDefinition.id,
      eventDefinition: FieldValue.delete() as unknown as undefined
    }
  } else if (data.eventDefinition) {
    return {
      eventDefinitionId: FieldValue.delete() as unknown as undefined,
      eventDefinition: data.eventDefinition
    }
  } else if (required) {
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

      const data = createSchema.parse(rawData)
      const eventFields = await eventDefinitionFields(data, { dataSources }, { required: true })

      let count: number
      let marks: SpeedMarkDoc[] | undefined
      if (data.marks?.length) {
        marks = data.marks.map(toMarkDoc)
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
        ...(marks ? { marks } : {})
      }, { ttl: 60 }) as Promise<SpeedResultDoc>)
    },
    async updateSpeedResult (_, { speedResultId, data: rawData }, context) {
      const speedResult = await ownedSpeedResult(speedResultId, context, 'edit')
      const data = updateSchema.parse(rawData)
      const eventFields = await eventDefinitionFields(data, context, { required: false })

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
    async analysis (speedResult, _, context) {
      const marks = marksOf(speedResult)
      if (!marks.length) return null
      const eventDefinition = await eventDefinitionOf(speedResult, context)
      return analyseMarks(marks, eventDefinition.totalDuration)
    }
  }
}
