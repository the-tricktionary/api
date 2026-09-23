/**
 * The weekly admin digest, see the README.
 *
 * Run with: npx tsx src/jobs/adminDigest.ts [--dry-run]
 */
import * as Sentry from '@sentry/node'
import { createHash } from 'node:crypto'
import { Timestamp } from '@google-cloud/firestore'
import { format, startOfDay, subDays } from 'date-fns'
import { utc } from '@date-fns/utc'
import { ADMIN_URL, WEB_URL } from '../config.js'
import { adminDigestFor, digestInterests, isEmptyDigest } from '../helpers/adminDigest.js'
import { renderAdminDigest } from '../helpers/adminDigestEmail.js'
import { logger as baseLogger } from '../services/logger.js'
import { siteEnglishMessages } from '../services/siteMessages.js'
import { createDataSources, firestore, writeInChunks } from '../store/firestoreDataSource.js'
import { trickLevelId, trickLocalisationId } from '../store/schema.js'
import { runJob } from './runJob.js'

import type { DocumentData, DocumentReference } from 'firebase-admin/firestore'
import type { VerificationLevel } from '../generated/graphql.js'
import type { DigestTrick } from '../helpers/adminDigest.js'
import type { Email } from '../services/mail.js'
import type { UserDoc } from '../store/schema.js'

const logger = baseLogger.child({ name: 'admin-digest' })
const dryRun = process.argv.includes('--dry-run')

/** How far back the digest reaches for someone without a cursor */
const FIRST_WINDOW_DAYS = 7

/** Undefined without messages, which is what an unreachable site gives */
function hashMessages (messages: Record<string, string>) {
  const entries = Object.entries(messages).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) return undefined
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

/** The existing ones, by ID */
async function existingDocs (refs: readonly DocumentReference[]) {
  if (refs.length === 0) return new Map<string, DocumentData>()
  const snaps = await firestore.getAll(...refs)
  return new Map(snaps.flatMap(dSnap => dSnap.exists ? [[dSnap.id, dSnap.data() ?? {}] as const] : []))
}

async function adminDigest () {
  const dataSources = createDataSources()
  const until = Timestamp.fromDate(startOfDay(new Date(), { in: utc }))
  const firstFrom = Timestamp.fromDate(subDays(until.toDate(), FIRST_WINDOW_DAYS))

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
    for (const rulesId of interests.rulesIds.keys()) rulesIds.add(rulesId)
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
    existingDocs(tricks.flatMap(trick => [...langs].map(lang => localisations.doc(trickLocalisationId(trick.id, lang))))),
    existingDocs(tricks.flatMap(trick => [...rulesIds].map(rulesId => levels.doc(trickLevelId(trick.id, rulesId)))))
  ])
  const sources = {
    submissions,
    tricks,
    missingLangs: new Map(tricks.map(trick => [trick.id, new Set([...langs].filter(lang => !translated.has(trickLocalisationId(trick.id, lang))))])),
    levels: new Map(tricks.map(trick => [trick.id, new Map([...rulesIds].flatMap(rulesId => {
      const level = levelled.get(trickLevelId(trick.id, rulesId))
      return level ? [[rulesId, (level.verificationLevel as VerificationLevel | undefined) ?? null] as const] : []
    }))])),
    rulesets: new Map(rulesets.map(ruleset => [ruleset.id, ruleset]))
  }

  const outgoing: Array<{ user: UserDoc, email: Email }> = []
  const done: UserDoc[] = []
  for (const { user, from } of admins) {
    const seenHash = user.notifications?.siteMessagesHash
    // a first digest records the hash rather than reporting every string as changed
    const siteMessagesChanged = hash != null && seenHash != null && seenHash !== hash
    const digest = adminDigestFor(user, { from, until, siteMessagesChanged }, sources)

    if (user.notifications?.adminDigest === false || isEmptyDigest(digest)) {
      done.push(user)
    } else if (!user.email) {
      logger.warn({ userId: user.id }, 'No verified email address to send the digest to')
      done.push(user)
    } else {
      outgoing.push({
        user,
        email: {
          to: { email: user.email, ...(user.name ? { name: user.name } : {}) },
          ...renderAdminDigest(digest, { adminUrl: ADMIN_URL, name: user.name, messages, from, until }),
          customId: `admin-digest:${user.id}:${format(until.toDate(), 'yyyy-MM-dd', { in: utc })}`
        }
      })
    }
  }

  if (dryRun) {
    for (const { user, email } of outgoing) logger.info({ userId: user.id, to: email.to.email, subject: email.subject }, `Would send:\n${email.text}`)
    return
  }

  // imported here so a dry run needs no Mailjet credentials
  const { sendEmails } = await import('../services/mail.js')
  const errors = await sendEmails(outgoing.map(({ email }) => email))
  let failed = 0
  for (const [idx, { user }] of outgoing.entries()) {
    const err = errors[idx]
    if (!err) {
      done.push(user)
      continue
    }
    failed++
    logger.error({ err, userId: user.id }, 'Could not send the digest')
    Sentry.captureException(err, { user: { id: user.id } })
  }

  await writeInChunks(done, (batch, user) => {
    batch.set(dataSources.users.collection.doc(user.id).withConverter(null), {
      notifications: {
        adminDigestSentUntil: until,
        ...(hash != null ? { siteMessagesHash: hash } : {})
      }
    }, { merge: true })
  })

  logger.info({ admins: admins.length, sent: outgoing.length - failed, failed, until: until.toDate() }, 'Admin digest done')
  // their cursors stayed put, so a retry only reaches them
  if (failed > 0) throw new Error(`${failed} of ${admins.length} admin digests failed`)
}

runJob('admin-digest', adminDigest)
