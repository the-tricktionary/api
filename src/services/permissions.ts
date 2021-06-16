import { AuthenticationError } from 'apollo-server'

import type { UserDoc } from '../store/schema'
import type { Logger } from 'pino'

interface AllowUserContext { logger: Logger }

export function allowUser (user: UserDoc | undefined, { logger }: AllowUserContext) {
  function enrich (checkMethod: () => boolean) {
    const annotations = {
      assert: (message?: string) => {
        logger.trace({ user: user?.id, assertion: checkMethod.name }, 'Trying Assertion')
        if (!checkMethod()) {
          logger.info({ user: user?.id, assertion: checkMethod.name }, `Assertion failed failed ${message ? `message: ${message}` : ''}`)
          throw new AuthenticationError(`Permission denied ${message ? ': ' + message : ''}`)
        }
        return true
      }
    }
    return Object.assign(checkMethod, annotations)
  }

  const isAuthenticated = enrich(function isAuthenticated () { return !!user })

  return {
    getTricks: enrich(() => true),
    editTrickCompletions: isAuthenticated
  }
}
