/**
 * Migration: the trick type becomes the `trick-type` tag, which
 * src/migrations/seed.ts creates.
 *
 *   1. names the tag and its values in every language `ui-messages` has a
 *      translation of `submit.trickType` and `enums.trickType.*` in, where
 *      the tag has no name in that language yet
 *   2. tags every trick without it from its `trickType` field
 *
 * Run the Algolia reindex (src/migrations/algolia-reindex.ts) after it.
 * Idempotent.
 *
 * Requirements:
 *   - GOOGLE_APPLICATION_CREDENTIALS pointing at a service account with write
 *     access to the `tags` and `tricks` collections
 *
 * Usage:
 *   npx tsx src/migrations/trick-type-tag.ts [--dry-run]
 */
import '../config.js'
import { FieldPath, Firestore } from '@google-cloud/firestore'
import { TrickType } from '../generated/graphql.js'
import { logger } from '../services/logger.js'
import { TRICK_TYPE_TAG_ID } from '../store/schema.js'

import type { TagDoc, TrickDoc, UiMessagesDoc } from '../store/schema.js'

const firestore = new Firestore()
const BATCH_SIZE = 400
const dryRun = process.argv.includes('--dry-run')

async function translateTag () {
  const tagRef = firestore.collection('tags').doc(TRICK_TYPE_TAG_ID)
  const translations = (await firestore.collection('ui-messages').get()).docs
    .map(dSnap => ({ lang: dSnap.id, messages: (dSnap.data() as UiMessagesDoc).messages ?? {} }))

  await firestore.runTransaction(async t => {
    const tag = (await t.get(tagRef)).data() as TagDoc | undefined
    if (!tag) throw new Error(`There is no ${TRICK_TYPE_TAG_ID} tag, run src/migrations/seed.ts first`)

    // the site messages that named the tag and its values
    const named = [
      { key: 'submit.trickType', path: ['names'], names: tag.names },
      ...Object.entries(TrickType).map(([member, id]) => ({ key: `enums.trickType.${member}`, path: ['values', id, 'names'], names: tag.values?.[id]?.names }))
    ]

    const updates: Array<[FieldPath, string]> = []
    for (const { key, path, names } of named) {
      if (!names) continue
      for (const { lang, messages } of translations) {
        const value = messages[key]?.value.trim()
        if (value && names[lang] == null) updates.push([new FieldPath(...path, lang), value])
      }
    }

    logger.info({ tagId: TRICK_TYPE_TAG_ID, names: updates.length, dryRun }, 'Translating the trick type tag')
    if (updates.length > 0 && !dryRun) {
      const [[field, value], ...more] = updates
      t.update(tagRef, field, value, ...more.flat())
    }
  })
}

async function migrate () {
  await translateTag()

  const qSnap = await firestore.collection('tricks').get()
  const trickTypes: unknown[] = Object.values(TrickType)
  let backfilled = 0
  let skipped = 0
  const invalid: string[] = []
  let batch = firestore.batch()
  let inBatch = 0

  for (const dSnap of qSnap.docs) {
    const trick = dSnap.data() as TrickDoc
    if (Array.isArray(trick.tags?.[TRICK_TYPE_TAG_ID])) {
      skipped++
      continue
    }
    if (!trickTypes.includes(trick.trickType)) {
      invalid.push(dSnap.id)
      continue
    }

    if (!dryRun) {
      batch.update(dSnap.ref, new FieldPath('tags', TRICK_TYPE_TAG_ID), [trick.trickType])
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

  if (invalid.length > 0) logger.warn({ trickIds: invalid }, 'Some tricks have no valid trick type and were left without the tag')
  logger.info({ total: qSnap.size, backfilled, skipped, invalid: invalid.length, dryRun }, 'Tricks tagged with their trick type')
}

migrate()
  .then(() => {
    process.exit(0)
  })
  .catch(err => {
    logger.error(err)
    process.exit(1)
  })
