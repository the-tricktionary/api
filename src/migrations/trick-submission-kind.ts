/**
 * Migration: gives every trick submission without a `kind` the `Trick` kind.
 *
 * Firestore cannot query for a missing field, so it reads the whole collection.
 * Run it before deploying the API that requires `kind`, and again after, for
 * submissions created in between. Idempotent.
 *
 * Requirements:
 *   - GOOGLE_APPLICATION_CREDENTIALS pointing at a service account with write
 *     access to the `trick-submissions` collection
 *
 * Usage:
 *   npx tsx src/migrations/trick-submission-kind.ts [--dry-run]
 */
import '../config.js'
import { TrickSubmissionKind } from '../generated/graphql.js'
import { logger } from '../services/logger.js'
import { firestore, writeInChunks } from '../store/firestoreDataSource.js'

const dryRun = process.argv.includes('--dry-run')

async function migrate () {
  const submissions = (await firestore.collection('trick-submissions').get()).docs
  const kindless = submissions.filter(dSnap => dSnap.get('kind') === undefined)
  logger.info({ total: submissions.length, migrating: kindless.length, dryRun }, 'Giving trick submissions without a kind the Trick kind')
  if (dryRun) return

  await writeInChunks(kindless, (batch, dSnap) => {
    batch.update(dSnap.ref, 'kind', TrickSubmissionKind.Trick)
  })
}

migrate()
  .then(() => {
    process.exit(0)
  })
  .catch(err => {
    logger.error(err)
    process.exit(1)
  })
