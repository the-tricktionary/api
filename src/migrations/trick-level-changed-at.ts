/**
 * Backfills `changedAt` on every trick level, from the later of a stored
 * `updatedAt` (which the rulesets migration carried over) and `verifiedAt`,
 * and the document's update time for levels with neither. Reads without the
 * data source's converter, which hides a stored `updatedAt`.
 *
 * Idempotent. Run with: npx tsx src/migrations/trick-level-changed-at.ts [--dry-run]
 */
import '../config.js'
import { Firestore, Timestamp } from '@google-cloud/firestore'
import { logger } from '../services/logger.js'

const firestore = new Firestore()
const BATCH_SIZE = 200
const dryRun = process.argv.includes('--dry-run')

async function migrate () {
  const qSnap = await firestore.collection('trick-levels').get()
  logger.info({ total: qSnap.size, dryRun }, 'Found trick levels')

  let backfilled = 0
  let fromStored = 0
  let skipped = 0
  let batch = firestore.batch()
  let inBatch = 0

  for (const dSnap of qSnap.docs) {
    const data = dSnap.data()
    if (data.changedAt instanceof Timestamp) {
      skipped++
      continue
    }

    const stored = [data.updatedAt, data.verifiedAt].filter((at: unknown): at is Timestamp => at instanceof Timestamp)
    const changedAt = stored.length > 0
      ? stored.reduce((latest, at) => at.toMillis() > latest.toMillis() ? at : latest)
      : dSnap.updateTime
    if (stored.length > 0) fromStored++

    if (!dryRun) {
      batch.update(dSnap.ref, { changedAt })
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

  logger.info(
    { backfilled, fromStored, fromUpdateTime: backfilled - fromStored, skipped, dryRun },
    'Trick levels backfilled with changedAt'
  )
}

migrate()
  .then(() => {
    process.exit(0)
  })
  .catch(err => {
    logger.error(err)
    process.exit(1)
  })
