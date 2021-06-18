import { AuthenticationError } from 'apollo-server'

import type { SpeedResultDoc, UserDoc } from '../store/schema'
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
  const everyone = enrich(function everyone () { return true })

  return {
    getTricks: everyone,
    editTrickCompletions: isAuthenticated,
    createSpeedResult: isAuthenticated,
    makePurchase: everyone,

    user (subUser: UserDoc) {
      const isMe = enrich(function isMe () { return !!user && user.id === subUser.id })
      const hasPublicProfile = enrich(function hasPublicProfile () { return subUser.profile.public })
      const hasPublicChecklist = enrich(function hasPublicProfile () { return subUser.profile.checklist })
      const hasPublicSpeed = enrich(function hasPublicProfile () { return subUser.profile.speed })

      const isMeOrHasPublicChecklist = enrich(function isMeAndHasPublicChecklist () { return isMe() || (hasPublicProfile() && hasPublicChecklist()) })
      const isMeOrHasPublicSpeed = enrich(function isMeAndHasPublicChecklist () { return isMe() || (hasPublicProfile() && hasPublicSpeed()) })
      return {
        getChecklist: isMeOrHasPublicChecklist,
        getSpeedResults: isMeOrHasPublicSpeed,

        speedResult (speedResult: SpeedResultDoc) {
          const isMine = enrich(function isMine () { return !!user && speedResult.userId === user.id })

          const isMineOrHasPublicSpeed = enrich(function isMineOrHasPublicSpeed () { return isMine() || (hasPublicProfile() && hasPublicSpeed()) })
          return {
            get: isMineOrHasPublicSpeed,
            edit: isMine,
            delete: isMine,
            getCreator: isMineOrHasPublicSpeed
          }
        }
      }
    }
  }
}
