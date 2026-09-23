import { GrantType } from '../generated/graphql.js'
import { verificationLevelRank } from '../services/permissions.js'

import type { Timestamp } from '@google-cloud/firestore'
import type { Discipline, VerificationLevel } from '../generated/graphql.js'
import type { RulesetDoc, TrickDoc, TrickSubmissionDoc, UserDoc } from '../store/schema.js'

export interface DigestTrick {
  id: TrickDoc['id']
  /** English */
  name: string
  discipline: Discipline
  addedAt: Timestamp
}

export interface DigestSources {
  /** Pending ones */
  submissions: readonly TrickSubmissionDoc[]
  /** The ones added in any window, and those with a level changed in one */
  tricks: readonly DigestTrick[]
  missingLangs: ReadonlyMap<TrickDoc['id'], ReadonlySet<string>>
  /** Per trick and ruleset, absent where there is no level */
  levels: ReadonlyMap<TrickDoc['id'], ReadonlyMap<RulesetDoc['id'], DigestLevel>>
  rulesets: ReadonlyMap<RulesetDoc['id'], RulesetDoc>
}

export interface DigestLevel {
  verificationLevel?: VerificationLevel
  changedAt?: Timestamp
}

export interface AdminDigest {
  submissions: Array<Pick<TrickSubmissionDoc, 'id' | 'name' | 'discipline' | 'attributionName'>>
  toTranslate: Array<{ trick: DigestTrick, langs: string[] }>
  toLevel: Array<{ trick: DigestTrick, rulesets: Array<{ name: string, verify: boolean }> }>
  siteMessagesChanged: boolean
}

export function digestInterests (user: Pick<UserDoc, 'grants'>) {
  const grants = user.grants ?? []
  const isSuperAdmin = grants.some(grant => grant.type === GrantType.SuperAdmin)
  // super admins only hear about the languages and rulesets they have a grant for
  const langs = new Set(grants.flatMap(grant => grant.type === GrantType.Translator ? [grant.lang] : []))
  /** The highest rank the user may verify at, per ruleset */
  const rulesIds = new Map<RulesetDoc['id'], number>()
  for (const grant of grants) {
    if (grant.type !== GrantType.LevelEditor) continue
    rulesIds.set(grant.rulesId, Math.max(rulesIds.get(grant.rulesId) ?? 0, verificationLevelRank(grant.verificationLevel)))
  }

  return {
    submissions: isSuperAdmin || grants.some(grant => grant.type === GrantType.TrickEditor),
    langs,
    rulesIds,
    siteMessages: isSuperAdmin || langs.size > 0
  }
}

function inWindow (at: Timestamp, from: Timestamp, until: Timestamp) {
  return at.toMillis() >= from.toMillis() && at.toMillis() < until.toMillis()
}

function byName (a: { name: string }, b: { name: string }) {
  return a.name.localeCompare(b.name)
}

/** The user's digest for `[from, until)` */
export function adminDigestFor (
  user: Pick<UserDoc, 'grants'>,
  { from, until, siteMessagesChanged }: { from: Timestamp, until: Timestamp, siteMessagesChanged: boolean },
  sources: DigestSources
): AdminDigest {
  const interests = digestInterests(user)
  const tricks = [...sources.tricks].sort(byName)
  const isNew = (trick: DigestTrick) => inWindow(trick.addedAt, from, until)

  const submissions = interests.submissions
    ? sources.submissions
      .filter(submission => inWindow(submission.submittedAt, from, until))
      .map(({ id, name, discipline, attributionName }) => ({ id, name, discipline, attributionName }))
      .sort(byName)
    : []

  const toTranslate = tricks.filter(isNew).flatMap(trick => {
    const langs = [...sources.missingLangs.get(trick.id) ?? []].filter(lang => interests.langs.has(lang)).sort()
    return langs.length > 0 ? [{ trick, langs }] : []
  })

  // a new trick without a level, or a new or changed level the user could verify higher
  const toLevel = tricks.flatMap(trick => {
    const levels = sources.levels.get(trick.id)
    const rulesets = [...interests.rulesIds].flatMap(([rulesId, rank]) => {
      const level = levels?.get(rulesId)
      const name = sources.rulesets.get(rulesId)?.names.en ?? rulesId
      if (!level) return isNew(trick) ? [{ name, verify: false }] : []
      const changed = isNew(trick) || (level.changedAt != null && inWindow(level.changedAt, from, until))
      return changed && verificationLevelRank(level.verificationLevel) < rank ? [{ name, verify: true }] : []
    }).sort((a, b) => a.name.localeCompare(b.name))
    return rulesets.length > 0 ? [{ trick, rulesets }] : []
  })

  return {
    submissions,
    toTranslate,
    toLevel,
    siteMessagesChanged: interests.siteMessages && siteMessagesChanged
  }
}

export function isEmptyDigest (digest: AdminDigest) {
  return digest.submissions.length === 0 &&
    digest.toTranslate.length === 0 &&
    digest.toLevel.length === 0 &&
    !digest.siteMessagesChanged
}
