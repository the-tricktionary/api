import type { Resolvers } from '../generated/graphql'

export const userResolvers: Resolvers = {
  Query: {
    async me (_, args, { dataSources, user }) {
      return user ?? null
    }
  },
  User: {
    async checklist (user, _, { dataSources, allowUser }) {
      allowUser.user(user).getChecklist.assert()

      return dataSources.trickCompletions.findManyByUser(user.id)
    }
  }
}
