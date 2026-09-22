/**
 * The weekly admin digest, see the README.
 *
 * Run with: npx tsx src/jobs/adminDigest.ts [--dry-run]
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
import { runJob } from './runJob.js'

import type { DocumentReference } from 'firebase-admin/firestore'
import type { AdminDigest, DigestTrick } from '../helpers/adminDigest.js'
import type { FlatMessages } from '../services/siteMessages.js'
import type { UserDoc } from '../store/schema.js'

const logger = baseLogger.child({ name: 'admin-digest' })
const dryRun = process.argv.includes('--dry-run')

const DAY_MS = 24 * 60 * 60 * 1000
/** How far back the digest reaches for someone without a cursor */
const FIRST_WINDOW_DAYS = 7

function startOfUtcDay (millis: number) {
  const date = new Date(millis)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

/** Undefined without messages, which is what an unreachable site gives */
function hashMessages (messages: FlatMessages) {
  const entries = Object.entries(messages).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) return undefined
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

async function existingIds (refs: readonly DocumentReference[]) {
  if (refs.length === 0) return new Set<string>()
  const snaps = await firestore.getAll(...refs)
  return new Set(snaps.filter(dSnap => dSnap.exists).map(dSnap => dSnap.id))
}

async function send (user: UserDoc, email: string, digest: AdminDigest, window: { from: Timestamp, until: Timestamp }, messages: FlatMessages) {
  const rendered = renderAdminDigest(digest, { adminUrl: ADMIN_URL, name: user.name, messages, ...window })

  if (dryRun) {
    logger.info({ userId: user.id, to: email, subject: rendered.subject }, `Would send:\n${rendered.text}`)
    return
  }

  // a dry run needs no Mailjet credentials
  const { sendEmail } = await import('../services/mail.js')
  await sendEmail({
    to: { email, ...(user.name ? { name: user.name } : {}) },
    ...rendered,
    customId: `admin-digest:${user.id}:${window.until.toDate().toISOString().slice(0, 10)}`
  })
}

async function adminDigest () {
  const dataSources = createDataSources()
  const until = Timestamp.fromMillis(startOfUtcDay(Date.now()))
  const firstFrom = Timestamp.fromMillis(until.toMillis() - (FIRST_WINDOW_DAYS * DAY_MS))

  const admins = (await dataSources.users.findManyWithGrants())
    .map(user => ({ user, from: user.notifications?.adminDigestSentUntil ?? firstFrom }))
    .filter(({ from }) => from.toMillis() < until.toMillis())
  if (admins.length === 0) return

  const earliest = Timestamp.fromMillis(Math.min(...admins.map(({ from }) => from.toMillis())))
  const langs = new Set<string>()
  const rulesIds = new Set<string>()
  for (const { user } of admins) {
    const interests = digestInterests(user)
    for (const lang of interests.langs) langs.add(lang)
    for (const rulesId of interests.rulesIds) rulesIds.add(rulesId)
  }

  const [submissions, trickDocs, rulesets, messages] = await Promise.all([
    dataSources.trickSubmissions.findManyPendingSubmittedBetween(earliest, until),
    dataSources.tricks.findManyAddedBetween(earliest, until),
    dataSources.rulesets.findAll(),
    siteEnglishMessages({ webUrl: WEB_URL, logger })
  ])
  const hash = hashMessages(messages)
  if (hash == null) logger.warn('Could not hash the site\'s English messages, leaving them out')

  const localisations = dataSources.trickLocalisations.collection
  const levels = dataSources.trickLevels.collection
  // getAll answers in the order it was asked
  const englishSnaps = trickDocs.length > 0 ? await firestore.getAll(...trickDocs.map(trick => localisations.doc(trickLocalisationId(trick.id, 'en')))) : []
  const tricks: DigestTrick[] = trickDocs.map((trick, idx) => ({
    id: trick.id,
    name: (englishSnaps[idx]?.get('name') as string | undefined) ?? trick.slug,
    discipline: trick.discipline,
    addedAt: trick.addedAt
  }))

  const [translated, levelled] = await Promise.all([
    existingIds(tricks.flatMap(trick => [...langs].map(lang => localisations.doc(trickLocalisationId(trick.id, lang))))),
    existingIds(tricks.flatMap(trick => [...rulesIds].map(rulesId => levels.doc(trickLevelId(trick.id, rulesId)))))
  ])
  const sources = {
    submissions,
    tricks,
    missingLangs: new Map(tricks.map(trick => [trick.id, new Set([...langs].filter(lang => !translated.has(trickLocalisationId(trick.id, lang))))])),
    missingRulesIds: new Map(tricks.map(trick => [trick.id, new Set([...rulesIds].filter(rulesId => !levelled.has(trickLevelId(trick.id, rulesId))))])),
    rulesets: new Map(rulesets.map(ruleset => [ruleset.id, ruleset]))
  }

  let sent = 0
  let failed = 0
  for (const { user, from } of admins) {
    try {
      const seenHash = user.notifications?.siteMessagesHash
      // a first digest records the hash rather than reporting every string as changed
      const siteMessagesChanged = hash != null && seenHash != null && seenHash !== hash
      const digest = adminDigestFor(user, { from, until, siteMessagesChanged }, sources)

      if (user.notifications?.adminDigest !== false && !isEmptyDigest(digest)) {
        if (user.email) {
          await send(user, user.email, digest, { from, until }, messages)
          sent++
        } else {
          logger.warn({ userId: user.id }, 'No verified email address to send the digest to')
        }
      }

      if (!dryRun) {
        await dataSources.users.updateOnePartial(user.id, {
          notifications: {
            adminDigestSentUntil: until,
            ...(hash != null ? { siteMessagesHash: hash } : {})
          }
        })
      }
    } catch (err) {
      failed++
      logger.error({ err, userId: user.id }, 'Could not send the digest')
      Sentry.captureException(err, { user: { id: user.id } })
    }
  }

  logger.info({ admins: admins.length, sent, failed, dryRun, until: until.toDate() }, 'Admin digest done')
  // their cursors stayed put, so a retry only reaches them
  if (failed > 0) throw new Error(`${failed} of ${admins.length} admin digests failed`)
}

runJob('admin-digest', adminDigest)
