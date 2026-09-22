import { Discipline, GrantType } from '../generated/graphql.js'

import type { Timestamp } from '@google-cloud/firestore'
import type { RulesetDoc, TrickDoc, TrickSubmissionDoc, UserDoc } from '../store/schema.js'

/**
 * What goes into one admin's weekly digest, picked by their grants from what
 * happened in their own window, see jobs/adminDigest.ts for how it's sent.
 */

export const disciplineNames: Record<Discipline, string> = {
  [Discipline.SingleRope]: 'Single Rope',
  [Discipline.DoubleDutch]: 'Double Dutch',
  [Discipline.Wheel]: 'Wheel'
}

/** A trick added in the digest's window, by its english name */
export interface DigestTrick {
  id: TrickDoc['id']
  name: string
  discipline: Discipline
  addedAt: Timestamp
}

/** Everything the job found, for every admin at once */
export interface DigestSources {
  /** Still pending, submitted since the earliest window began */
  submissions: readonly TrickSubmissionDoc[]
  /** Added since the earliest window began */
  tricks: readonly DigestTrick[]
  /** Per trick, the languages a translator has a grant for that it has no localisation in */
  missingLangs: ReadonlyMap<TrickDoc['id'], ReadonlySet<string>>
  /** Per trick, the rulesets a level editor has a grant for that it has no level in */
  missingRulesIds: ReadonlyMap<TrickDoc['id'], ReadonlySet<RulesetDoc['id']>>
  rulesets: ReadonlyMap<RulesetDoc['id'], RulesetDoc>
}

export interface AdminDigest {
  submissions: Array<Pick<TrickSubmissionDoc, 'id' | 'name' | 'discipline' | 'attributionName'>>
  /** The tricks missing in one or more of the admin's languages, with those languages */
  toTranslate: Array<{ trick: DigestTrick, langs: string[] }>
  /** The tricks missing a level in one or more of the admin's rulesets, with their names */
  toLevel: Array<{ trick: DigestTrick, rulesets: string[] }>
  siteMessagesChanged: boolean
}

/** What the digest has to say to the user at all, by their grants */
export function digestInterests (user: Pick<UserDoc, 'grants'>) {
  const grants = user.grants ?? []
  const isSuperAdmin = grants.some(grant => grant.type === GrantType.SuperAdmin)
  // super admins may translate and level everything, but only hear about the
  // languages and rulesets they have a grant for
  const langs = new Set(grants.flatMap(grant => grant.type === GrantType.Translator ? [grant.lang] : []))
  const rulesIds = new Set(grants.flatMap(grant => grant.type === GrantType.LevelEditor ? [grant.rulesId] : []))

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

/**
 * The user's digest for `[from, until)`. `siteMessagesChanged` is worked out
 * per user by the caller, from the hash their last digest saw.
 */
export function adminDigestFor (
  user: Pick<UserDoc, 'grants'>,
  { from, until, siteMessagesChanged }: { from: Timestamp, until: Timestamp, siteMessagesChanged: boolean },
  sources: DigestSources
): AdminDigest {
  const interests = digestInterests(user)
  const tricks = sources.tricks.filter(trick => inWindow(trick.addedAt, from, until)).sort(byName)

  const submissions = interests.submissions
    ? sources.submissions
      .filter(submission => inWindow(submission.submittedAt, from, until))
      .map(({ id, name, discipline, attributionName }) => ({ id, name, discipline, attributionName }))
      .sort(byName)
    : []

  const toTranslate = tricks.flatMap(trick => {
    const langs = [...sources.missingLangs.get(trick.id) ?? []].filter(lang => interests.langs.has(lang)).sort()
    return langs.length > 0 ? [{ trick, langs }] : []
  })

  const toLevel = tricks.flatMap(trick => {
    const rulesets = [...sources.missingRulesIds.get(trick.id) ?? []]
      .filter(rulesId => interests.rulesIds.has(rulesId))
      .map(rulesId => sources.rulesets.get(rulesId)?.names.en ?? rulesId)
      .sort()
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
