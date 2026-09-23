/**
 * Migration: the trick type becomes the `trick-type` tag.
 *
 *   1. creates the `trick-type` tag unless it exists, with the site's English
 *      names and the translations of `submit.trickType` and
 *      `enums.trickType.*` from `ui-messages`
 *   2. tags every trick without it from its `trickType` field
 *
 * Run the Algolia reindex (src/migrations/algolia-reindex.ts) after it.
 * Idempotent, an existing tag is left as it is.
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
import { TagValueType, TrickType } from '../generated/graphql.js'
import { logger } from '../services/logger.js'
import { TRICK_TYPE_TAG_ID } from '../store/schema.js'

import type { TagDoc, TagEnumValue, TrickDoc, UiMessagesDoc } from '../store/schema.js'

const firestore = new Firestore()
const BATCH_SIZE = 400
const dryRun = process.argv.includes('--dry-run')

/** The site's messages the names come from, with their English */
const TAG_NAME = { key: 'submit.trickType', en: 'Type of trick' }
const VALUES = [
  { id: TrickType.Basic, key: 'enums.trickType.Basic', en: 'Basic' },
  { id: TrickType.Manipulation, key: 'enums.trickType.Manipulation', en: 'Manipulation' },
  { id: TrickType.Multiple, key: 'enums.trickType.Multiple', en: 'Multiple' },
  { id: TrickType.Power, key: 'enums.trickType.Power', en: 'Power' },
  { id: TrickType.Release, key: 'enums.trickType.Release', en: 'Release' },
  { id: TrickType.Impossible, key: 'enums.trickType.Impossible', en: 'Impossible' }
]

async function tagDocument (): Promise<Omit<TagDoc, 'id' | 'collection' | 'createdAt' | 'updatedAt'>> {
  const translations = (await firestore.collection('ui-messages').get()).docs
    .map(dSnap => ({ lang: dSnap.id, messages: (dSnap.data() as UiMessagesDoc).messages ?? {} }))

  function names ({ key, en }: { key: string, en: string }) {
    const localised: Record<string, string> = { en }
    for (const { lang, messages } of translations) {
      const value = messages[key]?.value.trim()
      if (value) localised[lang] = value
    }
    return localised
  }

  return {
    valueType: TagValueType.Enum,
    names: names(TAG_NAME),
    disciplines: [],
    multiple: false,
    values: Object.fromEntries(VALUES.map((value, order): [string, TagEnumValue] => [value.id, { names: names(value), order }])),
    system: true
  }
}

async function migrate () {
  const tagRef = firestore.collection('tags').doc(TRICK_TYPE_TAG_ID)
  const tagSnap = await tagRef.get()
  if (tagSnap.exists) {
    logger.info({ tagId: TRICK_TYPE_TAG_ID }, 'The trick type tag exists, leaving it as it is')
  } else {
    const tag = await tagDocument()
    logger.info({ tagId: TRICK_TYPE_TAG_ID, tag, dryRun }, 'Creating the trick type tag')
    if (!dryRun) await tagRef.create(tag)
  }

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
