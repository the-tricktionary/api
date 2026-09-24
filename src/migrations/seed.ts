/**
 * Seed: the documents the API cannot work without.
 *
 *   - `languages/en`, enabled
 *   - `rulesets/tricktionary`, and a primary ruleset, the Tricktionary's when
 *     there is none
 *   - a built in trick type tag per discipline, `tags/trick-type-<discipline>`
 *     with the slug `trick-type`, created with the default trick types
 *
 * Creates what is missing. In what exists it fixes only what the code relies
 * on, a name is only filled in where the English one is missing, and the trick
 * types are left to the tag wranglers. More than one primary ruleset is
 * reported rather than fixed, which one stays primary is a choice for an admin,
 * and so is another tag with the slug `trick-type`.
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
import { Discipline, TagValueType } from '../generated/graphql.js'
import { disciplineSlug } from '../helpers/disciplines.js'
import { logger } from '../services/logger.js'
import { TRICK_TYPE_SLUG, TRICKTIONARY_RULES_ID } from '../store/schema.js'

import type { DocumentData, DocumentReference } from '@google-cloud/firestore'
import type { LanguageDoc, RulesetDoc, TagDoc, TagEnumValue } from '../store/schema.js'

type Fields<T> = Omit<T, 'id' | 'collection' | 'createdAt' | 'updatedAt'>
type Update = Array<[FieldPath, unknown]>
interface Fix { reason: string, update: Update }

const firestore = new Firestore()
const dryRun = process.argv.includes('--dry-run')

const TRICKTIONARY_NAME = 'Tricktionary'
const TRICK_TYPE_TAG_NAME = 'Type of trick'
/** By value ID, in order */
const DEFAULT_TRICK_TYPES = {
  basic: 'Basic',
  manipulation: 'Manipulation',
  multiple: 'Multiple',
  power: 'Power',
  release: 'Release',
  impossible: 'Impossible'
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
    if (current == null) {
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

function missingEnglish (names: Record<string, string> | undefined, en: string): Fix[] {
  return (names?.en ?? '').trim() === '' ? [fixing('it has no English name', [new FieldPath('names', 'en'), en])] : []
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
    ...missingEnglish(current.names, TRICKTIONARY_NAME),
    ...(primaries.length === 0 && current.isPrimary !== true ? [fixing('no ruleset is primary', [new FieldPath('isPrimary'), true])] : [])
  ])

  if (primaries.length > 1) problems.push(`Several rulesets are primary, pick one in the admin: ${primaries.join(', ')}`)
}

async function seedTrickTypeTags () {
  const tags = firestore.collection('tags')
  const ids: string[] = []

  for (const discipline of Object.values(Discipline)) {
    const ref = tags.doc(`${TRICK_TYPE_SLUG}-${disciplineSlug(discipline) ?? discipline}`)
    ids.push(ref.id)
    const tag: Fields<TagDoc> = {
      slug: TRICK_TYPE_SLUG,
      valueType: TagValueType.Enum,
      names: { en: TRICK_TYPE_TAG_NAME },
      disciplines: [discipline],
      multiple: false,
      values: Object.fromEntries(Object.entries(DEFAULT_TRICK_TYPES).map(([id, en], order): [string, TagEnumValue] => [id, { names: { en }, order }])),
      required: true,
      system: true
    }

    await ensure(ref, tag, current => {
      if (Object.keys(current.values ?? {}).length === 0) problems.push(`The ${ref.id} tag has no values, add trick types in the admin`)
      const onlyDiscipline = current.disciplines?.length === 1 && current.disciplines[0] === discipline
      return [
        ...(current.slug === TRICK_TYPE_SLUG ? [] : [fixing(`its slug is not ${TRICK_TYPE_SLUG}`, [new FieldPath('slug'), TRICK_TYPE_SLUG])]),
        ...(current.system === true ? [] : [fixing('it is not marked built in', [new FieldPath('system'), true])]),
        ...(current.required === true ? [] : [fixing('it is not required', [new FieldPath('required'), true])]),
        ...(current.valueType === TagValueType.Enum ? [] : [fixing('it is not an enum tag', [new FieldPath('valueType'), TagValueType.Enum])]),
        ...(current.multiple === false ? [] : [fixing('it allows several values', [new FieldPath('multiple'), false])]),
        ...(onlyDiscipline ? [] : [fixing(`it applies to more than ${discipline} tricks`, [new FieldPath('disciplines'), [discipline]])]),
        ...missingEnglish(current.names, TRICK_TYPE_TAG_NAME)
      ]
    })
  }

  const others = (await tags.where('slug', '==', TRICK_TYPE_SLUG).get()).docs.map(dSnap => dSnap.id).filter(id => !ids.includes(id))
  if (others.length > 0) problems.push(`Tags other than the built in ones have the slug ${TRICK_TYPE_SLUG}: ${others.join(', ')}`)
}

async function seed () {
  await seedEnglish()
  await seedRulesets()
  await seedTrickTypeTags()

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
