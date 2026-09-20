import { FieldValue } from '@google-cloud/firestore'
import * as Sentry from '@sentry/node'

import { AuthorizationError, CollisionError, NotFoundError, ValidationError } from '../errors.js'
import { canonicalTimingTrackContentType, createTimingTrackUpload, deleteTimingTrackObject, timingTrackObjectName, TIMING_TRACK_CONTENT_TYPES } from '../services/storage.js'
import { eventDefinitionCreateSchema, eventDefinitionUpdateSchema } from '../validation.js'

import type { ApolloContext } from '../apollo.js'
import type { Resolvers } from '../generated/graphql.js'
import type { EventDefinitionDoc, TimingTrack } from '../store/schema.js'

/** Rulesets competition event lookup codes look like e.ijru.sp.sr.srss.1.30 */
const lookupCodePattern = /^e\.[a-z0-9-]+\.(fs|sp|oa)\.(sr|dd|wh|ts|xd)\.[a-z0-9-]+\.\d+\.(\d+x)?\d+$/

async function existingEventDefinition (eventDefinitionId: string, { dataSources }: Pick<ApolloContext, 'dataSources'>) {
  const eventDefinition = await dataSources.eventDefinitions.findOneById(eventDefinitionId)
  if (!eventDefinition) throw new NotFoundError(`Event definition ${eventDefinitionId} not found`, { extensions: { entity: 'event-definition', id: eventDefinitionId } })
  return eventDefinition
}

/**
 * An admin can only ever save an audio URL that createTimingTrackUpload handed
 * out for this very event definition, anything else is rejected here. A track
 * of cues alone carries no URL to check.
 */
function validatedTimingTrack (track: TimingTrack, eventDefinitionId: string): TimingTrack {
  if (track.audioUrl != null && timingTrackObjectName(track.audioUrl, eventDefinitionId) == null) {
    throw new ValidationError('The audio URL is not one createTimingTrackUpload handed out for this event definition')
  }
  return track
}

/**
 * The definition no longer refers to the file either way, so a failed
 * deletion leaves an orphan in the bucket rather than failing the mutation.
 */
async function discardAudio (audioUrl: string | undefined, eventDefinitionId: string, { logger }: Pick<ApolloContext, 'logger'>) {
  if (audioUrl == null) return
  const objectName = timingTrackObjectName(audioUrl, eventDefinitionId)
  if (objectName == null) return
  try {
    await deleteTimingTrackObject(objectName)
  } catch (err) {
    logger.error(err, `Failed to delete the timing track audio ${objectName}`)
    Sentry.captureException(err)
  }
}

/** Shortest first, then by name */
export function byEventOrder (a: EventDefinitionDoc, b: EventDefinitionDoc) {
  return a.totalDuration - b.totalDuration || a.name.localeCompare(b.name)
}

export const eventDefinitionResolvers: Resolvers = {
  Query: {
    async eventDefinitions (_, args, { dataSources }) {
      const eventDefinitions = await dataSources.eventDefinitions.findManyByQuery(c => c, { ttl: 3600 })
      return eventDefinitions.sort(byEventOrder)
    }
  },
  Mutation: {
    async createEventDefinition (_, { data: rawData }, { dataSources, allowUser, user }) {
      allowUser.editEventDefinitions.assert()
      if (!user) throw new AuthorizationError()
      const data = eventDefinitionCreateSchema.parse(rawData)

      return await (dataSources.eventDefinitions.createOne({
        name: data.name,
        totalDuration: data.totalDuration,
        ...(data.lookupCode ? { lookupCode: data.lookupCode } : {}),
        updatedBy: user.id
      }) as Promise<EventDefinitionDoc>)
    },
    async updateEventDefinition (_, { eventDefinitionId, data: rawData }, context) {
      const { dataSources, allowUser, user } = context
      allowUser.editEventDefinitions.assert()
      if (!user) throw new AuthorizationError()
      const data = eventDefinitionUpdateSchema.parse(rawData)
      const existing = await existingEventDefinition(eventDefinitionId, context)

      let trackFields = {}
      if (data.timingTrack === null) {
        trackFields = { timingTrack: FieldValue.delete() as unknown as undefined }
      } else if (data.timingTrack !== undefined) {
        trackFields = { timingTrack: validatedTimingTrack(data.timingTrack, existing.id) }
      }

      let lookupCodeFields = {}
      if (data.lookupCode === null) lookupCodeFields = { lookupCode: FieldValue.delete() as unknown as undefined }
      else if (data.lookupCode !== undefined) lookupCodeFields = { lookupCode: data.lookupCode }

      const updated = await (dataSources.eventDefinitions.updateOnePartial(existing.id, {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.totalDuration !== undefined ? { totalDuration: data.totalDuration } : {}),
        ...lookupCodeFields,
        ...trackFields,
        updatedBy: user.id
      }) as Promise<EventDefinitionDoc>)

      // the old audio file is no longer referenced once it has been replaced or removed
      if (data.timingTrack !== undefined && existing.timingTrack && existing.timingTrack.audioUrl !== data.timingTrack?.audioUrl) {
        await discardAudio(existing.timingTrack.audioUrl, existing.id, context)
      }

      return updated
    },
    async deleteEventDefinition (_, { eventDefinitionId }, context) {
      const { dataSources, allowUser } = context
      allowUser.editEventDefinitions.assert()
      const existing = await existingEventDefinition(eventDefinitionId, context)

      const [inUse] = await dataSources.speedResults.findManyByQuery(c => c.where('eventDefinitionId', '==', existing.id).limit(1))
      if (inUse) throw new CollisionError('Speed results refer to this event definition, it cannot be deleted', { extensions: { entity: 'event-definition', id: existing.id } })

      await dataSources.eventDefinitions.deleteOne(existing.id)
      await discardAudio(existing.timingTrack?.audioUrl, existing.id, context)
      return existing
    },
    async createTimingTrackUpload (_, { eventDefinitionId, contentType }, context) {
      context.allowUser.editEventDefinitions.assert()
      const existing = await existingEventDefinition(eventDefinitionId, context)
      if (canonicalTimingTrackContentType(contentType) == null) {
        throw new ValidationError(`Unsupported audio type ${contentType}, use one of ${Object.keys(TIMING_TRACK_CONTENT_TYPES).join(', ')}`)
      }
      return await createTimingTrackUpload(existing.id, contentType)
    }
  },
  EventDefinition: {
    eventDefinitionLookupCode (eventDefinition) {
      if (eventDefinition.lookupCode) return eventDefinition.lookupCode
      // The seeded competition events use their lookup code as document id
      return lookupCodePattern.test(eventDefinition.id) ? eventDefinition.id : null
    },
    timingTrack (eventDefinition) {
      return eventDefinition.timingTrack ?? null
    }
  }
}
