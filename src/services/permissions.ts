import { AuthorizationError } from '../errors'
import { GrantType, VerificationLevel } from '../generated/graphql'
import { TRICKTIONARY_RULES_ID } from '../store/schema'
import type { Grant, SpeedResultDoc, TrickLevelDoc, UserDoc } from '../store/schema'
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
  /**
   * `reason` explains which rule a failing check breaks, it's only evaluated
   * when the check fails and is overridden by an explicit `assert` message.
   */
  function enrich (checkMethod: () => boolean, reason?: () => string) {
    const annotations = {
      assert: (message?: string) => {
        logger.trace({ user: user?.id, assertion: checkMethod.name }, 'Trying Assertion')
        if (!checkMethod()) {
          const detail = message ?? reason?.()
          logger.info({ user: user?.id, assertion: checkMethod.name }, `Assertion failed failed ${detail ? `message: ${detail}` : ''}`)
          throw new AuthorizationError(`Permission denied ${detail ? ': ' + detail : ''}`)
        }
        return true
      }
    }
    return Object.assign(checkMethod, annotations)
  }

  const isAuthenticated = enrich(function isAuthenticated () { return !!user })
  const everyone = enrich(function everyone () { return true })

  const grants: Grant[] = user?.grants ?? []
  const isSuperAdmin = enrich(function isSuperAdmin () { return grants.some(grant => grant.type === GrantType.SuperAdmin) })
  const isTrickEditor = enrich(function isTrickEditor () { return grants.some(grant => grant.type === GrantType.TrickEditor) })
  const createTrick = enrich(function createTrick () { return isSuperAdmin() || isTrickEditor() })
  const editTrick = enrich(function editTrick () { return isSuperAdmin() || isTrickEditor() })

  return {
    getTricks: everyone,
    editTrickCompletions: isAuthenticated,
    createSpeedResult: isAuthenticated,
    makePurchase: everyone,

    createTrick,
    editTrick,

    createRuleset: isSuperAdmin,
    editRuleset: isSuperAdmin,
    setPrimaryRuleset: isSuperAdmin,

    localisation (lang: string) {
      // english is the source language of the Tricktionary, trick editors are
      // its translators rather than anyone with a translator grant
      const edit = enrich(function editLocalisation () {
        return isSuperAdmin() ||
          (lang === 'en' && isTrickEditor()) ||
          grants.some(grant => grant.type === GrantType.Translator && grant.lang === lang)
      })

      return { edit }
    },

    ruleset (rulesId: string) {
      const editLevels = enrich(function editLevels () {
        return isSuperAdmin() || grants.some(grant => grant.type === GrantType.LevelEditor && grant.rulesId === rulesId)
      })

      function verificationRank (): 0 | 1 | 2 {
        if (isSuperAdmin()) return 2
        let rank: 0 | 1 | 2 = 0
        for (const grant of grants) {
          if (grant.type !== GrantType.LevelEditor || grant.rulesId !== rulesId) continue
          const grantRank = verificationLevelRank(grant.verificationLevel)
          if (grantRank > rank) rank = grantRank
        }
        return rank
      }

      // the tricktionary's own levels are part of the trick rather than of a
      // separate ruleset, so they're maintained by trick editors
      function canEditLevels () { return rulesId === TRICKTIONARY_RULES_ID ? editTrick() : editLevels() }

      /**
       * Setting a level resets its verification, so a user may only overwrite
       * a level that isn't verified above their own verification rank.
       * `existing` is the current level document, if there is one.
       */
      function setLevel (existing?: TrickLevelDoc) {
        const currentRank = verificationLevelRank(existing?.verificationLevel)
        return enrich(
          function setLevel () { return canEditLevels() && verificationRank() >= currentRank },
          () => !canEditLevels()
            ? `you may not edit the levels of the ruleset ${rulesId}`
            : `the level is verified at ${existing?.verificationLevel} and you may not overwrite it`
        )
      }

      /**
       * Verifying at a verification level requires the user to rank at least
       * as high and to actually raise the verification, recalling a
       * verification requires the user to rank at least as high as the
       * verification they recall.
       */
      function setVerification (existing: TrickLevelDoc, target: VerificationLevel | null) {
        const targetRank = verificationLevelRank(target)
        const currentRank = verificationLevelRank(existing.verificationLevel)
        return enrich(
          function setVerification () {
            if (!canEditLevels()) return false
            return targetRank > 0
              ? verificationRank() >= targetRank && targetRank > currentRank
              : currentRank > 0 && verificationRank() >= currentRank
          },
          () => {
            if (!canEditLevels()) return `you may not edit the levels of the ruleset ${rulesId}`
            if (targetRank > 0) {
              if (verificationRank() < targetRank) return `verifying a level at ${target} requires a higher verification level than you have`
              return `the level is already verified at ${existing.verificationLevel}`
            }
            if (currentRank === 0) return 'the level is not verified'
            return `recalling a ${existing.verificationLevel} verification requires a higher verification level than you have`
          }
        )
      }

      return { editLevels, verificationRank, setLevel, setVerification }
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
