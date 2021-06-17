import { AuthenticationError } from 'apollo-server'
import { auth } from 'firebase-admin'
import { userDataSource } from '../store/firestoreDataSource'

import type { Logger } from 'pino'
import type { UserDoc } from '../store/schema'

interface HeaderParserOptions {
  logger: Logger
}

export async function userFromAuthorizationHeader (header: string | undefined, { logger }: HeaderParserOptions): Promise<UserDoc | undefined> {
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
    throw new AuthenticationError('Malformed Authorization header')
  }

  let decoded
  try {
    decoded = await auth().verifyIdToken(split[1])
  } catch (err) {
    throw new AuthenticationError(err.message)
  }

  logger.debug(decoded, 'Finding user or device')
  let user = await userDataSource.findOneById(decoded.uid, { ttl: 60 })

  if (!user) {
    user = await userDataSource.createOne({
      id: decoded.uid,
      ...(decoded.name ? { name: decoded.name } : {}),
      ...(decoded.photo ? { photo: decoded.picture } : {}),
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

    if (update) await userDataSource.updateOne(user)
  }

  return user
}
