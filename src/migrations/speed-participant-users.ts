/**
 * Backfills `participants[].userId` on speed results, the index that finds an
 * athlete's own leg by their account rather than by the group member they
 * competed as.
 *
 * A participant whose member has no account of their own gets none, and
 * claiming that member later fills it in, see helpers/groups.ts
 * claimSpeedResults.
 *
 * Idempotent. Run with: npx tsx src/migrations/speed-participant-users.ts [--dry-run]
 */
import '../config.js'
import { Firestore } from '@google-cloud/firestore'
import { logger } from '../services/logger.js'

const firestore = new Firestore()
const BATCH_SIZE = 200
const dryRun = process.argv.includes('--dry-run')

async function migrate () {
  const memberSnap = await firestore.collection('group-members').get()
  const userOf = new Map<string, string>()
  for (const dSnap of memberSnap.docs) {
    const userId: unknown = dSnap.get('userId')
    if (typeof userId === 'string') userOf.set(dSnap.id, userId)
  }
  logger.info({ members: memberSnap.size, withAccount: userOf.size, dryRun }, 'Found group members')

  const qSnap = await firestore.collection('speed-results').get()
  logger.info({ total: qSnap.size, dryRun }, 'Found speed results')

  let backfilled = 0
  let participantsFilled = 0
  let skipped = 0
  let batch = firestore.batch()
  let inBatch = 0

  for (const dSnap of qSnap.docs) {
    const stored: unknown = dSnap.get('participants')
    if (!Array.isArray(stored)) {
      skipped++
      continue
    }

    let filled = 0
    const participants = stored.map((participant: Record<string, unknown>) => {
      const userId = typeof participant.memberId === 'string' ? userOf.get(participant.memberId) : undefined
      if (userId == null || participant.userId === userId) return participant
      filled++
      return { ...participant, userId }
    })
    if (filled === 0) {
      skipped++
      continue
    }

    if (!dryRun) {
      batch.update(dSnap.ref, { participants })
      inBatch++
    }
    backfilled++
    participantsFilled += filled

    if (inBatch >= BATCH_SIZE) {
      await batch.commit()
      batch = firestore.batch()
      inBatch = 0
    }
  }
  if (inBatch > 0) await batch.commit()

  logger.info({ backfilled, participantsFilled, skipped, dryRun }, 'Speed result participants backfilled with their accounts')
}

migrate()
  .then(() => {
    process.exit(0)
  })
  .catch(err => {
    logger.error(err)
    process.exit(1)
  })
