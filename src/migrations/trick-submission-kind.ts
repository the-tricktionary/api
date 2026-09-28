/**
 * Migration: every trick submission gets a `kind`. The ones from before videos
 * could be submitted on their own have none, and are all new tricks, so they
 * get `Trick`.
 *
 * Firestore cannot query for a missing field, so the whole collection is read.
 * Run it before deploying the API that requires the field, which the API
 * running until then ignores, and once more after, for the submissions that
 * API created in between. Idempotent.
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
