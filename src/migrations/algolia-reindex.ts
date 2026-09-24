/**
 * Migration: backfill `trickId` on trick localisations and rebuild the Algolia
 * search indices from Firestore.
 *
 * The API indexes a trick by looking up its localisations through their
 * `trickId` field, which older documents don't have (their trick is only
 * encoded in the document ID, and Firestore can't query a document ID prefix).
 * This script:
 *
 *   1. recovers the trick and the language of every localisation from its
 *      document ID and writes the missing `trickId` fields
 *   2. applies the current index settings to `tricktionary_<lang>` for every
 *      language that has at least one localisation, creating the indices that
 *      don't exist yet
 *   3. indexes every trick like the API does, see `indexTricks`
 *
 * Nothing is ever deleted from Algolia, records for tricks that have since
 * been removed from Firestore have to be cleaned up by hand.
 *
 * Requirements:
 *   - GOOGLE_APPLICATION_CREDENTIALS pointing at a service account with write
 *     access to the `trick-localisations` collection
 *   - ALGOLIA_APP_ID in the environment, and a tricktionary-api-algolia-api-key
 *     secret with write access, or GSM_<name> for it in the environment
 *
 * Usage:
 *   npx tsx src/migrations/algolia-reindex.ts [--dry-run]
 */
import '../config.js'
import { parseArgs } from 'node:util'
import { Firestore } from '@google-cloud/firestore'
import { logger } from '../services/logger.js'
import { indexTricks, setTrickIndexSettings, trickIndexName } from '../services/algolia.js'
import { createDataSources } from '../store/firestoreDataSource.js'

import type { TrickLocalisationDoc } from '../store/schema.js'

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false }
  }
})

const dryRun = args['dry-run']

/** the maximum is 500, leave some headroom */
const BATCH_SIZE = 400

const firestore = new Firestore()

/**
 * A localisation's document ID is `${trickId}-${lang}`, and both a trick ID and
 * a language tag may contain dashes, so the only reliable split is the one that
 * leaves a trick we know about on the left.
 */
function splitLocalisationId (id: string, trickIds: Set<string>) {
  let idx = id.indexOf('-')
  while (idx > 0) {
    const trickId = id.slice(0, idx)
    if (trickIds.has(trickId)) return { trickId, lang: id.slice(idx + 1) }
    idx = id.indexOf('-', idx + 1)
  }
  return undefined
}

async function main () {
  const localisationsRef = firestore.collection('trick-localisations')

  const tQSnap = await firestore.collection('tricks').get()
  const lQSnap = await localisationsRef.get()

  /** trickId -> lang -> localisation */
  const localisations = new Map<string, Map<string, TrickLocalisationDoc>>()
  /** the localisation documents that still need a `trickId` */
  const backfill: Array<{ id: string, trickId: string }> = []
  const orphans: string[] = []
  const trickIds = new Set(tQSnap.docs.map(dSnap => dSnap.id))

  for (const dSnap of lQSnap.docs) {
    const localisation = dSnap.data() as TrickLocalisationDoc
    const split = splitLocalisationId(dSnap.id, trickIds)
    if (!split) {
      orphans.push(dSnap.id)
      continue
    }

    if (localisation.trickId !== split.trickId) backfill.push({ id: dSnap.id, trickId: split.trickId })

    let byLang = localisations.get(split.trickId)
    if (!byLang) {
      byLang = new Map()
      localisations.set(split.trickId, byLang)
    }
    byLang.set(split.lang, localisation)
  }

  const langs = [...new Set([...localisations.values()].flatMap(byLang => [...byLang.keys()]))].sort((a, b) => a.localeCompare(b))

  logger.info({
    tricks: trickIds.size,
    localisations: lQSnap.size,
    backfill: backfill.length,
    orphans: orphans.length,
    langs,
    dryRun
  }, 'Found tricks to reindex')
  if (orphans.length > 0) {
    logger.warn({ orphans }, 'Some trick localisations do not belong to a known trick and are skipped')
  }

  if (!dryRun) {
    let batch = firestore.batch()
    let operations = 0
    for (const { id, trickId } of backfill) {
      if (operations >= BATCH_SIZE) {
        await batch.commit()
        batch = firestore.batch()
        operations = 0
      }
      batch.update(localisationsRef.doc(id), { trickId })
      operations++
    }
    if (operations > 0) await batch.commit()
    logger.info({ backfilled: backfill.length }, 'Backfilled the trickId of trick localisations')
  }

  for (const lang of langs) {
    if (dryRun) {
      logger.info({ lang, indexName: trickIndexName(lang) }, `[dry-run] would apply the index settings to ${trickIndexName(lang)}`)
      continue
    }
    await setTrickIndexSettings(lang)
    logger.info({ lang, indexName: trickIndexName(lang) }, `Applied the index settings to ${trickIndexName(lang)}`)
  }

  if (dryRun) {
    logger.info({ tricks: localisations.size }, `[dry-run] would index ${localisations.size} tricks`)
  } else {
    await indexTricks([...localisations.keys()], { dataSources: createDataSources(), logger })
  }

  logger.info({ tricks: localisations.size, langs, dryRun }, 'Reindex finished')
}

main()
  .then(() => {
    process.exit()
  })
  .catch(err => {
    logger.fatal(err)
    process.exit(1)
  })
