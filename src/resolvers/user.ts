import type { Resolvers } from '../generated/graphql'

export const userResolvers: Resolvers = {
  Query: {
    async me (_, args, { dataSources, user }) {
      return user ?? null
    }
  }
}
