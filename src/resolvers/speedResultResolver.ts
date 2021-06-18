import { FieldValue, Timestamp } from '@google-cloud/firestore'
import { ApolloError } from 'apollo-server'
import { ApolloContext } from '../apollo'

import type { EventDefinition, Resolvers } from '../generated/graphql'
import type { DetailedSpeedResultDoc, SpeedResultDoc } from '../store/schema'

const sharedResolvers: Resolvers['SimpleSpeedResult'] = {
  async creator (speedResult, _, { dataSources, allowUser }) {
    const creator = await dataSources.users.findOneById(speedResult.userId, { ttl: 60 })
    if (!creator) throw new ApolloError('User not found')
    allowUser.user(creator).speedResult(speedResult).getCreator.assert()
    return creator
  },
  async event (speedResult, _, { dataSources }) {
    return dataSources.eventDefinitions.findOneById(speedResult.eventDefinitionId, { ttl: 3600 }) as Promise<EventDefinition>
  }
}

async function clicksPerSecond ({ clicks, eventDefinitionId }: DetailedSpeedResultDoc, _: {}, { dataSources }: ApolloContext) {
  const eventDefinition = await dataSources.eventDefinitions.findOneById(eventDefinitionId, { ttl: 3600 })
  if (!eventDefinition) throw new ApolloError(`Event with id ${eventDefinitionId} not found`)
  return Math.round(clicks.length / eventDefinition.totalDuration * 100) / 100
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
    async createSpeedResult (_, { eventDefinitionId, name, data }, { dataSources, allowUser, user }) {
      allowUser.createSpeedResult.assert()
      const eventDefinition = await dataSources.eventDefinitions.findOneById(eventDefinitionId, { ttl: 3600 })
      if (!eventDefinition) throw new ApolloError(`Event with id ${eventDefinitionId} not found`)
      return dataSources.speedResults.createOne({
        ...(name ? { name } : {}),
        userId: user?.id as string,
        createdAt: Timestamp.now(),
        eventDefinitionId: eventDefinition.id,
        count: data.count,
        ...(Array.isArray(data.clicks) && data.clicks.length ? { clicks: data.clicks } : {})
      }, { ttl: 60 }) as Promise<SpeedResultDoc>
    },
    async updateSpeedResult (_, { speedResultId, name }, { allowUser, dataSources }) {
      const speedResult = await dataSources.speedResults.findOneById(speedResultId)
      if (!speedResult) throw new ApolloError(`Speed Result with id ${speedResultId} not found`)
      const speedResultUser = await dataSources.users.findOneById(speedResult.userId, { ttl: 3600 })
      if (!speedResultUser) throw new ApolloError(`Speed Result with id ${speedResultId} does not have an owning user`)
      allowUser.user(speedResultUser).speedResult(speedResult).edit.assert()

      return dataSources.speedResults.updateOnePartial(speedResult.id, { name: name ?? (FieldValue.delete() as any as undefined) }) as Promise<SpeedResultDoc>
    },
    async deleteSpeedResult (_, { speedResultId }, { allowUser, dataSources }) {
      const speedResult = await dataSources.speedResults.findOneById(speedResultId)
      if (!speedResult) throw new ApolloError(`Speed Result with id ${speedResultId} not found`)
      const speedResultUser = await dataSources.users.findOneById(speedResult.userId, { ttl: 3600 })
      if (!speedResultUser) throw new ApolloError(`Speed Result with id ${speedResultId} does not have an owning user`)
      allowUser.user(speedResultUser).speedResult(speedResult).delete.assert()
      await dataSources.speedResults.deleteOne(speedResult.id)
      return true
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
