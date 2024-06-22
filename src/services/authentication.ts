import { auth } from 'firebase-admin'
import { userDataSource } from '../store/firestoreDataSource'

import type Pino from 'pino'
import type { UserDoc } from '../store/schema'
import { AuthenticationError } from '../errors'
import { DataSources } from '../apollo'

interface HeaderParserOptions {
  logger: Pino.Logger
  dataSources: DataSources
}

export async function userFromAuthorizationHeader (header: string | undefined, { logger, dataSources }: HeaderParserOptions): Promise<UserDoc | undefined> {
  if (!header) {
    logger.debug('Unauthenticated request')
    return
  }
  const split = header.split(' ')
  if (
    split.length !== 2 ||
    split[0] !== 'Bearer' ||
    !split[1].length
  ) {
    throw new AuthenticationError('Malformed authorization header')
  }

  let decoded
  try {
    decoded = await auth().verifyIdToken(split[1])
  } catch (err) {
    throw new AuthenticationError((err as Error).message)
  }

  logger.debug({ uid: decoded.uid }, 'Finding user')
  let user = await dataSources.users.findOneById(decoded.uid, { ttl: 3600 })

  if (!user) {
    user = await dataSources.users.createOne({
      id: decoded.uid,
      ...(decoded.name ? { name: decoded.name } : {}),
      ...(decoded.photo ? { photo: decoded.picture } : {}),
      ...(decoded.email && decoded.email_verified ? { email: decoded.email } : {}),
      profile: {
        public: false,
        checklist: false,
        speed: false
      }
    })
  } else {
    let update = false
    if (!user.name && decoded.name) {
      user.name = decoded.name
      update = true
    }
    if (!user.photo && decoded.picture) {
      user.photo = decoded.picture
      update = true
    }
    if (!user.email && decoded.email && decoded.email_verified) {
      user.email = decoded.email
      update = true
    }

    if (update) await dataSources.users.updateOne(user)
  }

  return user
}
