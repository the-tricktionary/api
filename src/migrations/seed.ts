/**
 * Seed: the documents the API cannot work without.
 *
 *   - `languages/en`, enabled
 *   - `rulesets/tricktionary`, and a primary ruleset, the Tricktionary's when
 *     there is none
 *   - `tags/trick-type`, built in, with a value per `TrickType`
 *
 * Creates what is missing. In what exists it fixes only what the code relies
 * on, a name is only filled in where the English one is missing. More than one
 * primary ruleset is reported rather than fixed, which one stays primary is a
 * choice for an admin.
 *
 * Idempotent.
 *
 * Requirements:
 *   - GOOGLE_APPLICATION_CREDENTIALS pointing at a service account with write
 *     access to the `languages`, `rulesets` and `tags` collections
 *
 * Usage:
 *   npx tsx src/migrations/seed.ts [--dry-run]
 */
import '../config.js'
import { FieldPath, Firestore } from '@google-cloud/firestore'
import { TagValueType, TrickType } from '../generated/graphql.js'
import { logger } from '../services/logger.js'
import { TRICK_TYPE_TAG_ID, TRICKTIONARY_RULES_ID } from '../store/schema.js'

import type { DocumentData, DocumentReference } from '@google-cloud/firestore'
import type { LanguageDoc, RulesetDoc, TagDoc, TagEnumValue } from '../store/schema.js'

type Fields<T> = Omit<T, 'id' | 'collection' | 'createdAt' | 'updatedAt'>
type Update = Array<[FieldPath, unknown]>
interface Fix { reason: string, update: Update }

const firestore = new Firestore()
const dryRun = process.argv.includes('--dry-run')

const TRICKTIONARY_NAME = 'Tricktionary'
const TRICK_TYPE_TAG_NAME = 'Type of trick'
/** In the order they are offered */
const TRICK_TYPE_NAMES: Record<TrickType, string> = {
  [TrickType.Basic]: 'Basic',
  [TrickType.Manipulation]: 'Manipulation',
  [TrickType.Multiple]: 'Multiple',
  [TrickType.Power]: 'Power',
  [TrickType.Release]: 'Release',
  [TrickType.Impossible]: 'Impossible'
}

/** What an admin has to sort out, the seed does not guess */
const problems: string[] = []

function fixing (reason: string, ...update: Update): Fix {
  return { reason, update }
}

/** `fix` returns what an existing document needs, which may lack any field */
async function ensure<T extends DocumentData> (ref: DocumentReference, create: T, fix: (current: Partial<T>) => Fix[]) {
  await firestore.runTransaction(async t => {
    const dSnap = await t.get(ref)
    const current = dSnap.data() as Partial<T> | undefined
    if (!current) {
      logger.info({ path: ref.path, dryRun }, `Creating ${ref.path}`)
      if (!dryRun) t.create(ref, create)
      return
    }

    const fixes = fix(current)
    if (fixes.length === 0) {
      logger.info({ path: ref.path }, `${ref.path} is as it should be`)
      return
    }
    logger.info({ path: ref.path, reasons: fixes.map(({ reason }) => reason), dryRun }, `Fixing ${ref.path}`)
    const [[field, value], ...more] = fixes.flatMap(({ update }) => update)
    if (!dryRun) t.update(ref, field, value, ...more.flat())
  })
}

function missingEnglish (names: Record<string, string> | undefined, path: string[], en: string): Fix[] {
  return (names?.en ?? '').trim() === '' ? [fixing(`${path.join('.')} has no English`, [new FieldPath(...path, 'en'), en])] : []
}

async function seedEnglish () {
  const language: Fields<LanguageDoc> = { enabled: true }
  await ensure(firestore.collection('languages').doc('en'), language, current =>
    current.enabled === true ? [] : [fixing('English is disabled', [new FieldPath('enabled'), true])]
  )
}

async function seedRulesets () {
  const rulesets = firestore.collection('rulesets')
  const primaries = (await rulesets.where('isPrimary', '==', true).get()).docs.map(dSnap => dSnap.id)

  const ruleset: Fields<RulesetDoc> = { names: { en: TRICKTIONARY_NAME }, isPrimary: primaries.length === 0 }
  await ensure(rulesets.doc(TRICKTIONARY_RULES_ID), ruleset, current => [
    ...missingEnglish(current.names, ['names'], TRICKTIONARY_NAME),
    ...(primaries.length === 0 && current.isPrimary !== true ? [fixing('no ruleset is primary', [new FieldPath('isPrimary'), true])] : [])
  ])

  if (primaries.length > 1) problems.push(`Several rulesets are primary, pick one in the admin: ${primaries.join(', ')}`)
}

async function seedTrickTypeTag () {
  const valueIds = Object.keys(TRICK_TYPE_NAMES) as TrickType[]
  const tag: Fields<TagDoc> = {
    valueType: TagValueType.Enum,
    names: { en: TRICK_TYPE_TAG_NAME },
    disciplines: [],
    multiple: false,
    values: Object.fromEntries(valueIds.map((id, order): [string, TagEnumValue] => [id, { names: { en: TRICK_TYPE_NAMES[id] }, order }])),
    system: true
  }

  await ensure(firestore.collection('tags').doc(TRICK_TYPE_TAG_ID), tag, current => {
    const values = current.values ?? {}
    const extra = Object.keys(values).filter(id => !valueIds.includes(id as TrickType))
    if (extra.length > 0) problems.push(`The ${TRICK_TYPE_TAG_ID} tag has values that are no trick type: ${extra.join(', ')}`)

    let order = Math.max(-1, ...Object.values(values).map(value => value.order))
    return [
      ...(current.system === true ? [] : [fixing('it is not marked built in', [new FieldPath('system'), true])]),
      ...(current.valueType === TagValueType.Enum ? [] : [fixing('it is not an enum tag', [new FieldPath('valueType'), TagValueType.Enum])]),
      ...(current.multiple === false ? [] : [fixing('it allows several values', [new FieldPath('multiple'), false])]),
      ...((current.disciplines ?? []).length === 0 ? [] : [fixing('it is limited to disciplines', [new FieldPath('disciplines'), []])]),
      ...missingEnglish(current.names, ['names'], TRICK_TYPE_TAG_NAME),
      ...valueIds.flatMap(id => values[id] == null
        ? [fixing(`the value ${id} is missing`, [new FieldPath('values', id), { names: { en: TRICK_TYPE_NAMES[id] }, order: ++order }])]
        : missingEnglish(values[id].names, ['values', id, 'names'], TRICK_TYPE_NAMES[id]))
    ]
  })
}

async function seed () {
  await seedEnglish()
  await seedRulesets()
  await seedTrickTypeTag()

  if (problems.length > 0) {
    for (const problem of problems) logger.error(problem)
    throw new Error(`${problems.length} problems need an admin`)
  }
  logger.info({ dryRun }, 'Seeded')
}

seed()
  .then(() => {
    process.exit(0)
  })
  .catch(err => {
    logger.error(err)
    process.exit(1)
  })
