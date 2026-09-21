import { usernameSchema } from '../validation.js'

import type { DataSources } from '../store/firestoreDataSource.js'
import type { UserDoc } from '../store/schema.js'

/** Finds a user whether or not their profile is public */
export async function findUserByUsernameOrId (usernameOrId: string, dataSources: DataSources): Promise<UserDoc | undefined> {
  const query = usernameOrId.trim()
  if (!query) return undefined

  const username = usernameSchema.safeParse(query)
  const [byId, byUsername] = await Promise.all([
    dataSources.users.findOneById(query, { ttl: 60 }),
    username.success ? dataSources.users.findOneByUsername(username.data, { ttl: 60 }) : undefined
  ])
  // the id wins, so a lowercase uid cannot be claimed as somebody's username
  return byId ?? byUsername
}
