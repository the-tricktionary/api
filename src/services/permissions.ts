import { AuthorizationError } from '../errors'
import { VerificationLevel } from '../generated/graphql'
import type { Grant, SpeedResultDoc, UserDoc } from '../store/schema'
import type Pino from 'pino'

interface AllowUserContext { logger: Pino.Logger }

/**
 * The verification levels are ranked, a user may verify a trick level at their
 * own rank or lower. Rank 0 (`null`) means the user may edit levels but not
 * verify them.
 */
export function verificationLevelRank (level: VerificationLevel | null | undefined): 0 | 1 | 2 {
  switch (level) {
    case VerificationLevel.Official:
      return 2
    case VerificationLevel.Judge:
      return 1
    default:
      return 0
  }
}

export function allowUser (user: UserDoc | undefined, { logger }: AllowUserContext) {
  function enrich (checkMethod: () => boolean) {
    const annotations = {
      assert: (message?: string) => {
        logger.trace({ user: user?.id, assertion: checkMethod.name }, 'Trying Assertion')
        if (!checkMethod()) {
          logger.info({ user: user?.id, assertion: checkMethod.name }, `Assertion failed failed ${message ? `message: ${message}` : ''}`)
          throw new AuthorizationError(`Permission denied ${message ? ': ' + message : ''}`)
        }
        return true
      }
    }
    return Object.assign(checkMethod, annotations)
  }

  const isAuthenticated = enrich(function isAuthenticated () { return !!user })
  const everyone = enrich(function everyone () { return true })

  const grants: Grant[] = user?.grants ?? []
  const isSuperAdmin = enrich(function isSuperAdmin () { return grants.some(grant => grant.type === 'super-admin') })
  const isTrickEditor = enrich(function isTrickEditor () { return grants.some(grant => grant.type === 'trick-editor') })
  const editTricks = enrich(function editTricks () { return isSuperAdmin() || isTrickEditor() })

  return {
    getTricks: everyone,
    editTrickCompletions: isAuthenticated,
    createSpeedResult: isAuthenticated,
    makePurchase: everyone,

    isSuperAdmin,
    editTricks,

    localisation (lang: string) {
      // english is the source language of the Tricktionary, trick editors are
      // its translators rather than anyone with a translator grant
      const edit = enrich(function editLocalisation () {
        return isSuperAdmin() ||
          (lang === 'en' && isTrickEditor()) ||
          grants.some(grant => grant.type === 'translator' && grant.lang === lang)
      })

      return { edit }
    },

    ruleset (rulesId: string) {
      const editLevels = enrich(function editLevels () {
        return isSuperAdmin() || grants.some(grant => grant.type === 'level-editor' && grant.rulesId === rulesId)
      })

      function verificationRank (): 0 | 1 | 2 {
        if (isSuperAdmin()) return 2
        let rank: 0 | 1 | 2 = 0
        for (const grant of grants) {
          if (grant.type !== 'level-editor' || grant.rulesId !== rulesId) continue
          const grantRank = verificationLevelRank(grant.verificationLevel)
          if (grantRank > rank) rank = grantRank
        }
        return rank
      }

      return { editLevels, verificationRank }
    },

    user (subUser: UserDoc) {
      const isMe = enrich(function isMe () { return !!user && user.id === subUser.id })
      const hasPublicProfile = enrich(function hasPublicProfile () { return subUser.profile.public })
      const hasPublicChecklist = enrich(function hasPublicProfile () { return subUser.profile.checklist })
      const hasPublicSpeed = enrich(function hasPublicProfile () { return subUser.profile.speed })

      const isMeOrHasPublicChecklist = enrich(function isMeAndHasPublicChecklist () { return isMe() || (hasPublicProfile() && hasPublicChecklist()) })
      const isMeOrHasPublicSpeed = enrich(function isMeAndHasPublicChecklist () { return isMe() || (hasPublicProfile() && hasPublicSpeed()) })
      const isMeOrIsSuperAdmin = enrich(function isMeOrIsSuperAdmin () { return isMe() || isSuperAdmin() })
      return {
        getChecklist: isMeOrHasPublicChecklist,
        getSpeedResults: isMeOrHasPublicSpeed,
        getGrants: isMeOrIsSuperAdmin,

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
