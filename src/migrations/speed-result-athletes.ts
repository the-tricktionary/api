/**
 * Backfills who competed on every speed result recorded before groups existed:
 * its creator, and nobody else. The member arrays stay empty, no old result
 * belongs to a group.
 *
 * Until this has run a user's own scores are missing from the participant
 * driven queries, so it runs before anything reads them.
 *
 * Idempotent, so it is safe to run again after deploying to catch anything
 * written in between.
 *
 * Run with: npx tsx src/migrations/speed-result-athletes.ts [--dry-run]
 */
import '../config.js'
import { Firestore } from '@google-cloud/firestore'
import { logger } from '../services/logger.js'
import { ownParticipants } from '../helpers/speedParticipants.js'

const firestore = new Firestore()
const BATCH_SIZE = 200
const dryRun = process.argv.includes('--dry-run')

async function migrate () {
  const qSnap = await firestore.collection('speed-results').get()
  logger.info({ total: qSnap.size, dryRun }, 'Found speed results')

  let backfilled = 0
  let skipped = 0
  let batch = firestore.batch()
  let inBatch = 0

  for (const dSnap of qSnap.docs) {
    const data = dSnap.data()
    if (Array.isArray(data.athleteUserIds) || typeof data.userId !== 'string') {
      skipped++
      continue
    }

    if (!dryRun) {
      batch.update(dSnap.ref, { ...ownParticipants(data.userId) })
      inBatch++
    }
    backfilled++

    if (inBatch >= BATCH_SIZE) {
      await batch.commit()
      batch = firestore.batch()
      inBatch = 0
    }
  }
  if (inBatch > 0) await batch.commit()

  logger.info({ backfilled, skipped, dryRun }, 'Speed results backfilled with their creator as the athlete')
}

migrate()
  .then(() => {
    process.exit(0)
  })
  .catch(err => {
    logger.error(err)
    process.exit(1)
  })
