import type { Resolvers } from '../generated/graphql.js'

export const eventDefinitionResolvers: Resolvers = {
  Query: {
    async eventDefinitions (_, args, { dataSources }) {
      return await dataSources.eventDefinitions.findManyByQuery(c => c, { ttl: 3600 })
    }
  }
}
