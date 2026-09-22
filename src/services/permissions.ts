import { AuthorizationError } from '../errors.js'
import { GrantType, GroupRole, VerificationLevel } from '../generated/graphql.js'
import { TRICKTIONARY_RULES_ID } from '../store/schema.js'
import type { Grant, GroupDoc, GroupMemberDoc, SpeedResultDoc, TrickLevelDoc, UserDoc } from '../store/schema.js'
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
  // `reason` explains which rule a failing check breaks, an explicit `assert`
  // message overrides it
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
  const editTricks = enrich(function editTricks () { return isSuperAdmin() || grants.some(grant => grant.type === GrantType.TrickEditor) })
  const editEventDefinitions = enrich(function editEventDefinitions () { return isSuperAdmin() || grants.some(grant => grant.type === GrantType.SpeedEditor) })

  return {
    getTricks: everyone,
    editTrickCompletions: isAuthenticated,
    createSpeedResult: isAuthenticated,
    createGroup: isAuthenticated,
    requestToJoinGroup: isAuthenticated,
    setUserLang: isAuthenticated,
    editProfile: isAuthenticated,
    createTrickSubmission: isAuthenticated,
    editEventDefinitions,
    makePurchase: everyone,

    createTrick: editTricks,
    editTrick: editTricks,
    editTrickVideos: editTricks,
    getTrickVideoUploads: editTricks,
    reviewTrickSubmissions: editTricks,

    createLanguage: isSuperAdmin,
    setLanguageEnabled: isSuperAdmin,

    manageNotices: isSuperAdmin,

    createRuleset: isSuperAdmin,
    editRuleset: isSuperAdmin,
    setPrimaryRuleset: isSuperAdmin,

    findUsers: isSuperAdmin,
    getUsersWithGrants: isSuperAdmin,
    setUserGrants: isSuperAdmin,

    localisation (lang: string) {
      // english is the source language of the Tricktionary, trick editors are
      // its translators rather than anyone with a translator grant
      const edit = enrich(function editLocalisation () {
        return isSuperAdmin() ||
          (lang === 'en' && editTricks()) ||
          grants.some(grant => grant.type === GrantType.Translator && grant.lang === lang)
      })

      return { edit }
    },

    uiMessages (lang: string) {
      // the site's english interface strings live in the site's own repository,
      // so unlike trick localisations english is never edited through the API
      const edit = enrich(function editUiMessages () {
        return isSuperAdmin() || grants.some(grant => grant.type === GrantType.Translator && grant.lang === lang)
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
      function canEditLevels () { return rulesId === TRICKTIONARY_RULES_ID ? editTricks() : editLevels() }

      // setting a level resets its verification, so a user may only overwrite
      // a level that isn't verified above their own verification rank
      function setLevel (existing?: TrickLevelDoc) {
        const currentRank = verificationLevelRank(existing?.verificationLevel)
        return enrich(
          function setLevel () { return canEditLevels() && verificationRank() >= currentRank },
          () => !canEditLevels()
            ? `you may not edit the levels of the ruleset ${rulesId}`
            : `the level is verified at ${existing?.verificationLevel} and you may not overwrite it`
        )
      }

      // verifying requires the user to rank at least as high as the target
      // and to actually raise the verification, recalling requires the user to
      // rank at least as high as the verification they recall
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

      return { verificationRank, setLevel, setVerification }
    },

    group (group: GroupDoc, membership?: GroupMemberDoc) {
      const isMember = enrich(function isGroupMember () {
        return !!user && !!membership && membership.groupId === group.id && membership.userId === user.id
      })
      const isAdmin = enrich(function isGroupAdmin () {
        return isMember() && membership?.role === GroupRole.Admin
      })

      return {
        get: isMember,
        edit: isAdmin,
        delete: isAdmin,
        manageMembers: isAdmin,
        invite: isAdmin,
        manageJoinCode: isAdmin,
        editMemberChecklist: isAdmin
      }
    },

    user (subUser: UserDoc) {
      const isMe = enrich(function isMe () { return !!user && user.id === subUser.id })
      const hasPublicProfile = enrich(function hasPublicProfile () { return subUser.profile.public })
      const hasPublicChecklist = enrich(function hasPublicChecklist () { return subUser.profile.checklist })
      const hasPublicSpeed = enrich(function hasPublicSpeed () { return subUser.profile.speed })

      const isMeOrHasPublicProfile = enrich(function isMeOrHasPublicProfile () { return isMe() || hasPublicProfile() })
      const isMeOrHasPublicChecklist = enrich(function isMeOrHasPublicChecklist () { return isMe() || (hasPublicProfile() && hasPublicChecklist()) })
      const isMeOrHasPublicSpeed = enrich(function isMeOrHasPublicSpeed () { return isMe() || (hasPublicProfile() && hasPublicSpeed()) })
      const isMeOrIsSuperAdmin = enrich(function isMeOrIsSuperAdmin () { return isMe() || isSuperAdmin() })
      const isMeOrEditsTricks = enrich(function isMeOrEditsTricks () { return isMe() || editTricks() })
      return {
        getProfile: isMeOrHasPublicProfile,
        getChecklist: isMeOrHasPublicChecklist,
        getChecklistStats: isMeOrHasPublicProfile,
        getSpeedResults: isMe,
        getSpeedPersonalBests: isMeOrHasPublicSpeed,
        getGrants: isMeOrIsSuperAdmin,
        getEmail: isMeOrIsSuperAdmin,
        getGroups: isMe,
        getGroupInvites: isMe,
        getTrickSubmissions: isMeOrEditsTricks,

        speedResult (speedResult: SpeedResultDoc, membership?: GroupMemberDoc) {
          const isMine = enrich(function isMine () { return !!user && speedResult.userId === user.id })
          const isSharedWithMe = enrich(function isSharedWithMe () {
            return !!user && !!membership && !!speedResult.groupId && membership.groupId === speedResult.groupId && membership.userId === user.id
          })
          const isGroupAdmin = enrich(function isSpeedResultGroupAdmin () {
            return isSharedWithMe() && membership?.role === GroupRole.Admin
          })

          const isMineOrSharedWithMe = enrich(function isMineOrSharedWithMe () { return isMine() || isSharedWithMe() })
          const canRead = enrich(function canReadSpeedResult () { return isMineOrSharedWithMe() || (hasPublicProfile() && hasPublicSpeed()) })
          const canManage = enrich(function canManageSpeedResult () { return isMine() || isGroupAdmin() })
          return {
            get: canRead,
            getGroup: isMineOrSharedWithMe,
            edit: canManage,
            delete: canManage,
            getCreator: canRead
          }
        }
      }
    }
  }
}
