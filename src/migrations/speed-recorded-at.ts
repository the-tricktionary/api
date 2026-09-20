/**
 * Backfills `recordedAt` on every speed result, so Firestore has a stored
 * timestamp to order the list by. See the notes on `SpeedResultDoc`.
 *
 * The value comes from the stored `createdAt` where there is one, which is the
 * original jump time on the scores the functions repo imported from v2, and
 * from the document's own create time otherwise. This reads the collection
 * without the data source's converter, which is the only way to see that
 * stored `createdAt`: on the converted path it is shadowed by the create time.
 *
 * Idempotent, so it is safe to run again after deploying to catch anything
 * written in between.
 *
 * Run with: npx tsx src/migrations/speed-recorded-at.ts [--dry-run]
 */
import '../config.js'
import { Firestore, Timestamp } from '@google-cloud/firestore'
import { logger } from '../services/logger.js'

const firestore = new Firestore()
const BATCH_SIZE = 200
const dryRun = process.argv.includes('--dry-run')

async function migrate () {
  const qSnap = await firestore.collection('speed-results').get()
  logger.info({ total: qSnap.size, dryRun }, 'Found speed results')

  let backfilled = 0
  let fromStored = 0
  let skipped = 0
  let batch = firestore.batch()
  let inBatch = 0

  for (const dSnap of qSnap.docs) {
    const data = dSnap.data()
    if (data.recordedAt instanceof Timestamp) {
      skipped++
      continue
    }

    const stored: unknown = data.createdAt
    const recordedAt = stored instanceof Timestamp ? stored : dSnap.createTime
    if (stored instanceof Timestamp) fromStored++

    if (!dryRun) {
      batch.update(dSnap.ref, { recordedAt })
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
    { backfilled, fromStored, fromCreateTime: backfilled - fromStored, skipped, dryRun },
    'Speed results backfilled with recordedAt'
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
