/**
 * Migration: the trick type becomes the `trick-type` tag.
 *
 *   1. creates the `trick-type` tag unless it exists: an enum tag with a value
 *      per `TrickType`, that every trick carries. Its names come from the
 *      site's messages, english from its en.json and the other languages from
 *      the translations in `ui-messages`: the tag is named like the submission
 *      form's `submit.trickType` label, its values like `enums.trickType.*`
 *   2. sets `tags['trick-type']` on every trick that doesn't have it yet, from
 *      its legacy `trickType` field
 *
 * The API reads the legacy field for a trick without the tag, so this can run
 * any time after the API that writes the tag is deployed. Run the Algolia
 * reindex (src/migrations/algolia-reindex.ts) after it, which applies the
 * index settings that make the names of tags searchable.
 *
 * Idempotent, an existing tag is left as it is.
 *
 * Requirements:
 *   - GOOGLE_APPLICATION_CREDENTIALS pointing at a service account with write
 *     access to the `tags` and `tricks` collections
 *   - WEB_URL in the environment when the site isn't the production one
 *
 * Usage:
 *   npx tsx src/migrations/trick-type-tag.ts [--dry-run]
 */
import { WEB_URL } from '../config.js'
import { FieldPath, Firestore } from '@google-cloud/firestore'
import { TagValueType, TrickType } from '../generated/graphql.js'
import { logger } from '../services/logger.js'
import { siteEnglishMessages } from '../services/siteMessages.js'
import { TRICK_TYPE_TAG_ID } from '../store/schema.js'

import type { TagDoc, TagEnumValue, TrickDoc, UiMessagesDoc } from '../store/schema.js'

const firestore = new Firestore()
const BATCH_SIZE = 400
const dryRun = process.argv.includes('--dry-run')

const TAG_NAME_KEY = 'submit.trickType'

function valueKey (member: string) { return `enums.trickType.${member}` }

async function tagDocument (): Promise<Omit<TagDoc, 'id' | 'collection' | 'createdAt' | 'updatedAt'>> {
  const english = await siteEnglishMessages({ webUrl: WEB_URL, logger })
  const members = Object.entries(TrickType)
  const missing = [TAG_NAME_KEY, ...members.map(([member]) => valueKey(member))].filter(key => english[key] == null)
  if (missing.length > 0) throw new Error(`The site's en.json at ${WEB_URL} lacks ${missing.join(', ')}`)

  const translations = (await firestore.collection('ui-messages').get()).docs
    .map(dSnap => ({ lang: dSnap.id, messages: (dSnap.data() as UiMessagesDoc).messages ?? {} }))

  function names (key: string) {
    const localised: Record<string, string> = { en: english[key] }
    for (const { lang, messages } of translations) {
      const value = messages[key]?.value?.trim()
      if (value) localised[lang] = value
    }
    return localised
  }

  return {
    valueType: TagValueType.Enum,
    names: names(TAG_NAME_KEY),
    disciplines: [],
    multiple: false,
    values: Object.fromEntries(members.map(([member, value], order): [string, TagEnumValue] => [value, { names: names(valueKey(member)), order }])),
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
