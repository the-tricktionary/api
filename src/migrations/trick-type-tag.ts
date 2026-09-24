/**
 * Migration: the trick type moves from the `trickType` field to the
 * `trick-type` tag, which src/migrations/seed.ts creates.
 *
 *   1. names the tag and its values in every language `ui-messages` has a
 *      translation of `submit.trickType` and `enums.trickType.*` in, where
 *      the tag has no name in that language yet
 *   2. tags every trick without it from its `trickType` field, and deletes the
 *      field
 *   3. deletes the `trickType` field of trick submissions
 *
 * Nothing is written while a trick has neither the tag nor a `trickType` that
 * is a value of it, those tricks are listed instead. Run the Algolia reindex
 * (src/migrations/algolia-reindex.ts) after it. Idempotent.
 *
 * Requirements:
 *   - GOOGLE_APPLICATION_CREDENTIALS pointing at a service account with write
 *     access to the `tags`, `tricks` and `trick-submissions` collections
 *
 * Usage:
 *   npx tsx src/migrations/trick-type-tag.ts [--dry-run]
 */
import '../config.js'
import { FieldPath, FieldValue } from 'firebase-admin/firestore'
import { logger } from '../services/logger.js'
import { firestore, writeInChunks } from '../store/firestoreDataSource.js'
import { TRICK_TYPE_TAG_ID } from '../store/schema.js'

import type { TagDoc, TrickDoc, UiMessagesDoc } from '../store/schema.js'

const dryRun = process.argv.includes('--dry-run')

/** The site message that named each legacy trick type */
const TRICK_TYPE_MESSAGES: Record<string, string> = {
  basic: 'enums.trickType.Basic',
  manipulation: 'enums.trickType.Manipulation',
  multiple: 'enums.trickType.Multiple',
  power: 'enums.trickType.Power',
  release: 'enums.trickType.Release',
  impossible: 'enums.trickType.Impossible'
}

type LegacyTrick = Omit<TrickDoc, 'tags'> & { tags?: TrickDoc['tags'], trickType?: unknown }

const tagRef = firestore.collection('tags').doc(TRICK_TYPE_TAG_ID)

/** The tricks to migrate, refused while one has no trick type the tag knows */
async function legacyTricks (tag: TagDoc) {
  const tricks = (await firestore.collection('tricks').get()).docs
    .map(dSnap => ({ ref: dSnap.ref, trick: dSnap.data() as LegacyTrick }))

  const untyped = tricks.filter(({ trick }) => trick.tags?.[TRICK_TYPE_TAG_ID] == null && (typeof trick.trickType !== 'string' || tag.values?.[trick.trickType] == null))
  if (untyped.length > 0) {
    for (const { ref, trick } of untyped) logger.error({ trickId: ref.id, slug: trick.slug, trickType: trick.trickType }, `The trick ${trick.slug} has no trick type the tag knows`)
    throw new Error(`${untyped.length} tricks have no trick type, give them one of the ${TRICK_TYPE_TAG_ID} tag's values first`)
  }

  const legacy = tricks.filter(({ trick }) => trick.trickType !== undefined || trick.tags?.[TRICK_TYPE_TAG_ID] == null)
  logger.info({ total: tricks.length, migrating: legacy.length, dryRun }, 'Moving the trick type of tricks to the tag')
  return legacy
}

async function translateTag () {
  const translations = (await firestore.collection('ui-messages').get()).docs
    .map(dSnap => ({ lang: dSnap.id, messages: (dSnap.data() as UiMessagesDoc).messages ?? {} }))

  await firestore.runTransaction(async t => {
    const tag = (await t.get(tagRef)).data() as TagDoc

    const named = [
      { key: 'submit.trickType', path: ['names'], names: tag.names },
      ...Object.entries(TRICK_TYPE_MESSAGES).map(([id, key]) => ({ key, path: ['values', id, 'names'], names: tag.values?.[id]?.names }))
    ]

    const updates: Array<[FieldPath, string]> = []
    for (const { key, path, names } of named) {
      if (names == null) continue
      for (const { lang, messages } of translations) {
        const value = messages[key]?.value.trim()
        if ((value ?? '') !== '' && names[lang] == null) updates.push([new FieldPath(...path, lang), value])
      }
    }

    logger.info({ tagId: TRICK_TYPE_TAG_ID, names: updates.length, dryRun }, 'Translating the trick type tag')
    if (updates.length > 0 && !dryRun) {
      const [[field, value], ...more] = updates
      t.update(tagRef, field, value, ...more.flat())
    }
  })
}

async function migrateSubmissions () {
  const submissions = (await firestore.collection('trick-submissions').orderBy('trickType').get()).docs
  logger.info({ migrating: submissions.length, dryRun }, 'Deleting the trick type of trick submissions')
  if (dryRun) return

  await writeInChunks(submissions, (batch, dSnap) => {
    batch.update(dSnap.ref, 'trickType', FieldValue.delete())
  })
}

async function migrate () {
  const tag = (await tagRef.get()).data() as TagDoc | undefined
  if (tag == null) throw new Error(`There is no ${TRICK_TYPE_TAG_ID} tag, run src/migrations/seed.ts first`)
  const tricks = await legacyTricks(tag)

  await translateTag()
  if (!dryRun) {
    await writeInChunks(tricks, (batch, { ref, trick }) => {
      batch.update(
        ref,
        new FieldPath('tags', TRICK_TYPE_TAG_ID), trick.tags?.[TRICK_TYPE_TAG_ID] ?? [trick.trickType],
        'trickType', FieldValue.delete()
      )
    })
  }
  await migrateSubmissions()
}

migrate()
  .then(() => {
    process.exit(0)
  })
  .catch(err => {
    logger.error(err)
    process.exit(1)
  })
