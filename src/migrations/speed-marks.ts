/**
 * Converts the legacy speed result formats into rulesets-compatible mark
 * streams, see src/services/speedMarks.ts for the conversions.
 *
 * - `clicks`: absolute click timestamps written by the first v4 API
 * - `graphData`: pairwise averaged step offsets mirrored from the v2 app
 *
 * The legacy fields are left in place, the API prefers `marks` once it is set.
 * Run with: npx tsx src/migrations/speed-marks.ts
 */
import '../config.js'
import { Firestore } from '@google-cloud/firestore'
import { logger } from '../services/logger.js'
import { marksOf } from '../services/speedMarks.js'
import type { SpeedResultDoc } from '../store/schema.js'

const firestore = new Firestore()
const BATCH_SIZE = 200

async function migrate () {
  const collection = firestore.collection('speed-results')
  let converted = 0

  for (const field of ['clicks', 'graphData'] as const) {
    const qSnap = await collection.where(field, '!=', null).get()
    logger.info({ field, candidates: qSnap.size }, 'Found legacy speed results')

    let batch = firestore.batch()
    let inBatch = 0
    for (const dSnap of qSnap.docs) {
      const data = { ...dSnap.data(), id: dSnap.id, collection: 'speed-results' } as SpeedResultDoc
      if (Array.isArray(data.marks)) continue

      const marks = marksOf(data)
      if (!marks.length) continue

      batch.update(dSnap.ref, { marks })
      converted++
      inBatch++

      if (inBatch >= BATCH_SIZE) {
        await batch.commit()
        batch = firestore.batch()
        inBatch = 0
      }
    }
    if (inBatch > 0) await batch.commit()
  }

  logger.info({ converted }, 'Speed results converted to mark streams')
}

migrate()
  .then(() => {
    process.exit(0)
  })
  .catch(err => {
    logger.error(err)
    process.exit(1)
  })
