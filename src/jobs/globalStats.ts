/**
 * Snapshots the Tricktionary's numbers into `global-stats`.
 *
 * Run with: npx tsx src/jobs/globalStats.ts [--dry-run]
 */
import { Timestamp } from '@google-cloud/firestore'
import { format } from 'date-fns'
import { utc } from '@date-fns/utc'
import { TrickSubmissionStatus } from '../generated/graphql.js'
import { tallyCompletions } from '../helpers/globalStats.js'
import { logger as baseLogger } from '../services/logger.js'
import { createDataSources } from '../store/firestoreDataSource.js'
import { TRICKTIONARY_RULES_ID } from '../store/schema.js'
import { runJob } from './runJob.js'

import type { GlobalStatsDoc } from '../store/schema.js'

const logger = baseLogger.child({ name: 'global-stats' })
const dryRun = process.argv.includes('--dry-run')

async function globalStats () {
  const dataSources = createDataSources()
  const countedAt = Timestamp.now()

  const trickLevels = await dataSources.trickLevels.findManyByRuleset(TRICKTIONARY_RULES_ID)
  const [tally, tricks, acceptedSubmissions, speed] = await Promise.all([
    tallyCompletions(dataSources.trickCompletions.streamAthletesAndTricks(), trickLevels),
    dataSources.tricks.countAll(),
    dataSources.trickSubmissions.countByStatus(TrickSubmissionStatus.Accepted),
    dataSources.speedResults.countWithSteps()
  ])

  const snapshot: Omit<GlobalStatsDoc, 'id' | 'collection' | 'createdAt' | 'updatedAt'> = {
    countedAt,
    tricks,
    ...tally,
    acceptedSubmissions,
    speedResults: speed.results,
    speedSteps: speed.steps
  }
  const id = format(countedAt.toDate(), 'yyyy-MM-dd', { in: utc })

  if (dryRun) {
    logger.info({ id, snapshot }, 'Would store the snapshot')
    return
  }

  // a rerun on the same day overwrites
  await dataSources.globalStats.collection.doc(id).withConverter(null).set(snapshot)
  logger.info({ id, snapshot }, 'Global stats done')
}

runJob('global-stats', globalStats)
