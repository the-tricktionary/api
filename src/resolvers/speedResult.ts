import { FieldValue, Timestamp } from '@google-cloud/firestore'
import { ApolloContext } from '../apollo'

import type { EventDefinition, Resolvers } from '../generated/graphql'
import type { DetailedSpeedResultDoc, SpeedResultDoc } from '../store/schema'
import { NotFoundError, ValidationError } from '../errors'

const sharedResolvers: Resolvers['SimpleSpeedResult'] = {
  async creator (speedResult, _, { dataSources, allowUser }) {
    const creator = await dataSources.users.findOneById(speedResult.userId, { ttl: 60 })
    if (!creator) throw new NotFoundError('User not found', { extensions: { entity: 'user', id: speedResult.userId } })
    allowUser.user(creator).speedResult(speedResult).getCreator.assert()
    return creator
  },
  async eventDefinition (speedResult, _, { dataSources }) {
    if (speedResult.eventDefinitionId) return dataSources.eventDefinitions.findOneById(speedResult.eventDefinitionId, { ttl: 3600 }) as Promise<EventDefinition>
    else if (speedResult.eventDefinition) {
      return {
        ...speedResult.eventDefinition,
        collection: 'event-definitions',
        id: Buffer.from(`${speedResult.eventDefinition.name}-${speedResult.eventDefinition.totalDuration}`, 'utf-8').toString('base64')
      }
    } else throw new NotFoundError('Event definition not found', { extensions: { entity: 'event-definition', id: speedResult.eventDefinition } })
  }
}

async function clicksPerSecond ({ clicks, eventDefinitionId, eventDefinition }: DetailedSpeedResultDoc, _: {}, { dataSources }: ApolloContext) {
  const eDef = eventDefinitionId
    ? await dataSources.eventDefinitions.findOneById(eventDefinitionId, { ttl: 3600 })
    : eventDefinition
  if (!eDef) throw new NotFoundError('Event definition not found', { extensions: { entity: 'event-definition', id: eventDefinitionId } })
  return Math.round(clicks.length / eDef.totalDuration * 100) / 100
}

async function misses (speedResult: DetailedSpeedResultDoc, _: {}, context: ApolloContext) {
  const average = await clicksPerSecond(speedResult, _, context)

  let misses = 0
  let currAvg = 0
  for (let i = 1; i < speedResult.clicks.length; i++) {
    const prev = Timestamp.prototype.toMillis.call(speedResult.clicks[i - 1])
    const curr = Timestamp.prototype.toMillis.call(speedResult.clicks[i])
    currAvg = 100 * (1 / (curr - prev))
    if ((average / currAvg) > 1.5) {
      misses++
    }
  }
  return misses
}

export const speedResultResolvers: Resolvers = {
  Query: {},
  Mutation: {
    // TODO prevent XSS on name
    async createSpeedResult (_, { data }, { dataSources, allowUser, user }) {
      allowUser.createSpeedResult.assert()

      let eObj
      if (data.eventDefinitionId) {
        const eventDefinition = await dataSources.eventDefinitions.findOneById(data.eventDefinitionId, { ttl: 3600 })
        if (!eventDefinition) throw new NotFoundError('Event definition not found', { extensions: { entity: 'event-definition', id: data.eventDefinitionId } })
        eObj = { eventDefinitionId: eventDefinition.id }
      } else if (data.eventDefinition) {
        eObj = { eventDefinition: data.eventDefinition }
      } else {
        throw new ValidationError('No event definition or event definition id specified', {})
      }

      return dataSources.speedResults.createOne({
        ...(data.name ? { name: data.name } : {}),
        userId: user?.id as string,
        createdAt: Timestamp.now(),
        count: data.count,
        ...eObj,
        ...(Array.isArray(data.clicks) && data.clicks.length ? { clicks: data.clicks } : {})
      }, { ttl: 60 }) as Promise<SpeedResultDoc>
    },
    async updateSpeedResult (_, { speedResultId, data }, { allowUser, dataSources }) {
      const speedResult = await dataSources.speedResults.findOneById(speedResultId)
      if (!speedResult) throw new NotFoundError('Speed result not found', { extensions: { entity: 'speed-result', id: speedResultId } })
      const speedResultUser = await dataSources.users.findOneById(speedResult.userId, { ttl: 3600 })
      if (!speedResultUser) throw new NotFoundError('Speed result user not found', { extensions: { entity: 'speed-result-user', id: speedResult.userId } })
      allowUser.user(speedResultUser).speedResult(speedResult).edit.assert()

      let eObj = {}
      if (data.eventDefinitionId) {
        const eventDefinition = await dataSources.eventDefinitions.findOneById(data.eventDefinitionId, { ttl: 3600 })
        if (!eventDefinition) throw new NotFoundError('Event definition not found', { extensions: { entity: 'event-definition', id: data.eventDefinitionId } })
        eObj = {
          eventDefinitionId: eventDefinition.id,
          eventDefinition: FieldValue.delete() as any as undefined
        }
      } else if (data.eventDefinition) {
        eObj = {
          eventDefinitionId: FieldValue.delete() as any as undefined,
          eventDefinition: data.eventDefinition
        }
      }

      return dataSources.speedResults.updateOnePartial(speedResult.id, {
        name: data.name ?? (FieldValue.delete() as any as undefined),
        ...eObj
      }) as Promise<SpeedResultDoc>
    },
    async deleteSpeedResult (_, { speedResultId }, { allowUser, dataSources }) {
      const speedResult = await dataSources.speedResults.findOneById(speedResultId)
      if (!speedResult) throw new NotFoundError('Speed result not found', { extensions: { entity: 'speed-result', id: speedResultId } })
      const speedResultUser = await dataSources.users.findOneById(speedResult.userId, { ttl: 3600 })
      if (!speedResultUser) throw new NotFoundError('Speed result user not found', { extensions: { entity: 'speed-result-user', id: speedResult.userId } })
      allowUser.user(speedResultUser).speedResult(speedResult).delete.assert()
      await dataSources.speedResults.deleteOne(speedResult.id)
      return speedResult
    }
  },
  SimpleSpeedResult: sharedResolvers,
  DetailedSpeedResult: {
    ...sharedResolvers,
    // TODO prevent having to run clicksPerSecond three times...
    clicksPerSecond,
    misses,
    async jumpsLost (speedResult, _, context) {
      const average = await clicksPerSecond(speedResult, _, context)
      const numMisses = await misses(speedResult, _, context)

      return Math.ceil(numMisses * average)
    },
    maxClicksPerSecond ({ clicks }) {
      let max = 0
      for (let i = 1; i < clicks.length; i++) {
        const prev = Timestamp.prototype.toMillis.call(clicks[i - 1])
        const curr = Timestamp.prototype.toMillis.call(clicks[i])
        const cps = 100 * (1 / (curr - prev))
        if (cps >= max) max = cps
      }
      return Math.round(max * 100) / 100
    }
  }
}
