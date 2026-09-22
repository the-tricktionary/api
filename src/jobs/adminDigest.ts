/**
 * The weekly admin digest: one email per admin, with only the sections their
 * grants give them, covering only what happened since their last one.
 *
 * Runs as a Cloud Run job on a Cloud Scheduler trigger (see the infra
 * repository), under its own service account, which can read the Mailjet
 * secrets and none of the API's others.
 *
 * Each admin has their own window, `[adminDigestSentUntil, start of today UTC)`.
 * Ending it at midnight UTC rather than at the time the job runs means nothing
 * that happens while it runs, or on the day it runs, falls between two windows.
 * The cursor is moved on for everyone with a grant, whether or not they were
 * sent anything, so a missed week is caught up by the next run and running it
 * twice in a day sends nothing the second time.
 *
 * Run with: npx tsx src/jobs/adminDigest.ts [--dry-run]
 * `--dry-run` logs every email instead of sending it and moves no cursors.
 */
import * as Sentry from '@sentry/node'
import { createHash } from 'node:crypto'
import { Timestamp } from '@google-cloud/firestore'
import { ADMIN_URL, WEB_URL } from '../config.js'
import { adminDigestFor, digestInterests, isEmptyDigest } from '../helpers/adminDigest.js'
import { renderAdminDigest } from '../helpers/adminDigestEmail.js'
import { logger as baseLogger } from '../services/logger.js'
import { siteEnglishMessages } from '../services/siteMessages.js'
import { createDataSources, firestore } from '../store/firestoreDataSource.js'
import { trickLevelId, trickLocalisationId } from '../store/schema.js'

import type { DocumentReference } from 'firebase-admin/firestore'
import type { DigestTrick } from '../helpers/adminDigest.js'
import type { UserDoc } from '../store/schema.js'

const logger = baseLogger.child({ name: 'admin-digest' })
const dryRun = process.argv.includes('--dry-run')

const DAY_MS = 24 * 60 * 60 * 1000
/** How far back the first digest of someone without a cursor reaches */
const FIRST_WINDOW_DAYS = 7

function startOfUtcDay (millis: number) {
  const date = new Date(millis)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

/**
 * The site's English messages, hashed so a change can be told apart without
 * storing them. Hashed as sorted entries rather than as the file, so only a
 * change to a key or a string counts. Undefined when the site couldn't be
 * reached, which must not look like every string changing.
 */
async function siteMessagesHash () {
  const messages = await siteEnglishMessages({ webUrl: WEB_URL, logger })
  const entries = Object.entries(messages).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) return undefined
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

/** Which of `refs` exist, by document path, read in one round trip */
async function existing (refs: readonly DocumentReference[]) {
  if (refs.length === 0) return new Set<string>()
  const snaps = await firestore.getAll(...refs)
  return new Set(snaps.filter(dSnap => dSnap.exists).map(dSnap => dSnap.ref.path))
}

async function run () {
  const dataSources = createDataSources()
  const until = Timestamp.fromMillis(startOfUtcDay(Date.now()))
  const firstFrom = Timestamp.fromMillis(until.toMillis() - (FIRST_WINDOW_DAYS * DAY_MS))

  const admins = (await dataSources.users.findManyWithGrants())
    .map(user => ({ user, from: user.notifications?.adminDigestSentUntil ?? firstFrom }))
    .filter(({ from }) => from.toMillis() < until.toMillis())
  if (admins.length === 0) {
    logger.info({ until: until.toDate() }, 'Every admin has had their digest up to today')
    return { failed: 0 }
  }

  const earliest = Timestamp.fromMillis(Math.min(...admins.map(({ from }) => from.toMillis())))
  const langs = new Set<string>()
  const rulesIds = new Set<string>()
  for (const { user } of admins) {
    const interests = digestInterests(user)
    for (const lang of interests.langs) langs.add(lang)
    for (const rulesId of interests.rulesIds) rulesIds.add(rulesId)
  }

  const [submissions, trickDocs, rulesets, hash] = await Promise.all([
    dataSources.trickSubmissions.findManyPendingSubmittedBetween(earliest, until),
    dataSources.tricks.findManyAddedBetween(earliest, until),
    dataSources.rulesets.findAll(),
    siteMessagesHash()
  ])
  if (hash == null) logger.warn('Could not hash the site\'s English messages, leaving them out of this digest')

  const localisations = dataSources.trickLocalisations.collection
  const levels = dataSources.trickLevels.collection
  const englishSnaps = trickDocs.length > 0 ? await firestore.getAll(...trickDocs.map(trick => localisations.doc(trickLocalisationId(trick.id, 'en')))) : []
  // getAll answers in the order it was asked
  const tricks: DigestTrick[] = trickDocs.map((trick, idx) => ({
    id: trick.id,
    name: (englishSnaps[idx]?.get('name') as string | undefined) ?? trick.slug,
    discipline: trick.discipline,
    addedAt: trick.addedAt
  }))

  // only what somebody gets told about is looked up, a document read each
  const [translated, levelled] = await Promise.all([
    existing(tricks.flatMap(trick => [...langs].map(lang => localisations.doc(trickLocalisationId(trick.id, lang))))),
    existing(tricks.flatMap(trick => [...rulesIds].map(rulesId => levels.doc(trickLevelId(trick.id, rulesId)))))
  ])
  const missingLangs = new Map(tricks.map(trick => [trick.id, new Set([...langs].filter(lang => !translated.has(localisations.doc(trickLocalisationId(trick.id, lang)).path)))]))
  const missingRulesIds = new Map(tricks.map(trick => [trick.id, new Set([...rulesIds].filter(rulesId => !levelled.has(levels.doc(trickLevelId(trick.id, rulesId)).path)))]))

  const sources = {
    submissions,
    tricks,
    missingLangs,
    missingRulesIds,
    rulesets: new Map(rulesets.map(ruleset => [ruleset.id, ruleset]))
  }

  let sent = 0
  let failed = 0
  for (const { user, from } of admins) {
    const userLogger = logger.child({ userId: user.id })
    try {
      const seenHash = user.notifications?.siteMessagesHash
      // someone without a hash has never been told about the strings, so their
      // first digest records it rather than reporting every string as new
      const siteMessagesChanged = hash != null && seenHash != null && seenHash !== hash
      const digest = adminDigestFor(user, { from, until, siteMessagesChanged }, sources)

      if (user.notifications?.adminDigest === false) {
        userLogger.debug('Opted out of the digest')
      } else if (isEmptyDigest(digest)) {
        userLogger.debug('Nothing to tell')
      } else if (!user.email) {
        userLogger.warn('Has something in their digest but no verified email address')
      } else {
        await send(user, user.email, digest, { from, until }, userLogger)
        sent++
      }

      if (!dryRun) {
        await dataSources.users.updateOnePartial(user.id, {
          notifications: {
            adminDigestSentUntil: until,
            ...(hash != null ? { siteMessagesHash: hash } : {})
          }
        } satisfies Partial<UserDoc>)
      }
    } catch (err) {
      // everyone else still gets theirs, and this one is retried by the next
      // run since their cursor stayed where it was
      failed++
      userLogger.error(err, 'Could not send the digest')
      Sentry.captureException(err, { user: { id: user.id } })
    }
  }

  logger.info({ admins: admins.length, sent, failed, dryRun, until: until.toDate() }, 'Admin digest done')
  return { failed }
}

async function send (user: UserDoc, email: string, digest: ReturnType<typeof adminDigestFor>, window: { from: Timestamp, until: Timestamp }, userLogger: typeof logger) {
  const rendered = renderAdminDigest(digest, { adminUrl: ADMIN_URL, name: user.name, ...window })

  if (dryRun) {
    userLogger.info({ to: email, subject: rendered.subject }, `Would send:\n${rendered.text}`)
    return
  }

  // imported here so a dry run needs no Mailjet credentials
  const { sendEmail } = await import('../services/mail.js')
  await sendEmail({
    to: { email, ...(user.name ? { name: user.name } : {}) },
    ...rendered,
    customId: `admin-digest:${user.id}:${window.until.toDate().toISOString().slice(0, 10)}`
  })
  userLogger.info({ subject: rendered.subject }, 'Sent the digest')
}

run()
  .then(async ({ failed }) => {
    await Sentry.flush(2000)
    // a failed execution is retried by Cloud Run, which only reaches the
    // admins whose cursor did not move
    process.exit(failed > 0 ? 1 : 0)
  })
  .catch(async err => {
    logger.error(err)
    Sentry.captureException(err)
    await Sentry.flush(2000)
    process.exit(1)
  })
