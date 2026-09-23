/**
 * Migration: move trick levels from `organisation` + `rulesVersion` to a
 * reference to a document in the new `rulesets` collection.
 *
 * For every document in `trick-levels` that doesn't have a `rulesId` yet, this
 * script:
 *
 *   1. maps `organisation` (+ `rulesVersion`) to a rules ID, `tricktionary`
 *      stays `tricktionary`, `ijru` becomes `ijru@<rulesVersion>` (defaulting
 *      to `ijru@2.0.0` for documents without a rules version)
 *   2. creates a `rulesets` document for every rules ID that doesn't have one
 *      yet, one of them is marked as primary
 *   3. writes the level to its new, deterministic, document ID
 *      (`<trickId>-<rulesId>`) using the new shape and deletes the old document
 *
 * Levels that already have a `rulesId` are skipped, so the script is idempotent
 * and can be re-run after failures. If two old documents map to the same new
 * document the one with the highest verification level (and, if that's a tie,
 * the most recently updated one) wins, the other one is logged and dropped.
 *
 * An organisation that isn't `tricktionary` or `ijru` aborts the migration
 * before anything is written, it needs a rules ID mapping added here first.
 *
 * Requirements:
 *   - GOOGLE_APPLICATION_CREDENTIALS pointing at a service account with write
 *     access to the `trick-levels` and `rulesets` collections
 *
 * Usage:
 *   npx tsx src/migrations/rulesets.ts [--dry-run] [--primary <rulesId>]
 *
 * Note: the API caches trick levels for up to an hour, so the migrated levels
 * show up in the API at most an hour after the migration ran.
 */
import '../config.js'
import { parseArgs } from 'node:util'
import { Firestore } from '@google-cloud/firestore'
import { logger } from '../services/logger.js'
import { verificationLevelRank } from '../services/permissions.js'
import { trickLevelId } from '../store/schema.js'

import type { Timestamp } from '@google-cloud/firestore'
import type { VerificationLevel } from '../generated/graphql.js'
import type { RulesetDoc, TrickLevelDoc } from '../store/schema.js'

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    primary: { type: 'string' }
  }
})

const dryRun = args['dry-run']

/** the maximum is 500, leave some headroom */
const BATCH_SIZE = 400
const DEFAULT_IJRU_VERSION = '2.0.0'

const firestore = new Firestore()

/** The shape trick levels had before this migration */
interface OldTrickLevelDoc {
  trickId: string
  organisation: string
  level: string
  rulesVersion?: string
  verificationLevel?: VerificationLevel
  verifiedBy?: string
  createdAt?: Timestamp
  updatedAt?: Timestamp
  /** only set on already migrated documents */
  rulesId?: string
}

type NewTrickLevelDoc = Omit<TrickLevelDoc, 'collection' | 'id' | 'updatedAt'>

function rulesIdFor ({ organisation, rulesVersion }: OldTrickLevelDoc) {
  switch (organisation) {
    case 'tricktionary':
      return 'tricktionary'
    case 'ijru':
      return `ijru@${rulesVersion?.length ? rulesVersion : DEFAULT_IJRU_VERSION}`
    case 'wjrf':
      return 'wjrf@2019'
    case 'fisac-irsf':
      return 'fisac-irsf@2017-2018'
    default:
      return undefined
  }
}

function rulesetName (rulesId: string) {
  if (rulesId === 'tricktionary') return 'Tricktionary'
  return `IJRU ${rulesId.slice('ijru@'.length)}`
}

/** Compares two dot separated versions numerically, component by component */
function compareVersions (a: string, b: string) {
  const aParts = a.split('.')
  const bParts = b.split('.')
  for (let idx = 0; idx < Math.max(aParts.length, bParts.length); idx++) {
    const diff = (parseInt(aParts[idx] ?? '0', 10) || 0) - (parseInt(bParts[idx] ?? '0', 10) || 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** The most recent IJRU ruleset, which is the best default primary ruleset */
function newestIjruRulesId (rulesIds: string[]) {
  return rulesIds
    .filter(rulesId => rulesId.startsWith('ijru@'))
    .sort((a, b) => compareVersions(a.slice('ijru@'.length), b.slice('ijru@'.length)))
    .pop()
}

/**
 * Of two levels for the same trick and ruleset, the one that's verified at the
 * highest level wins, ties are broken by the most recent update.
 */
function isBetterLevel (candidate: NewTrickLevelDoc, current: NewTrickLevelDoc) {
  const rankDiff = verificationLevelRank(candidate.verificationLevel) - verificationLevelRank(current.verificationLevel)
  if (rankDiff !== 0) return rankDiff > 0
  return candidate.changedAt.toMillis() > current.changedAt.toMillis()
}

async function main () {
  const levelsRef = firestore.collection('trick-levels')
  const rulesetsRef = firestore.collection('rulesets')

  const qSnap = await levelsRef.get()

  const migrated = new Map<string, { data: NewTrickLevelDoc, oldIds: string[] }>()
  const unknownOrganisations = new Map<string, number>()
  let skipped = 0
  let dropped = 0

  for (const dSnap of qSnap.docs) {
    const level = dSnap.data() as OldTrickLevelDoc
    if (level.rulesId) {
      skipped++
      continue
    }

    const rulesId = rulesIdFor(level)
    if (!rulesId) {
      unknownOrganisations.set(level.organisation, (unknownOrganisations.get(level.organisation) ?? 0) + 1)
      continue
    }

    const createdAt = level.createdAt ?? dSnap.createTime
    const updatedAt = level.updatedAt ?? dSnap.updateTime
    const data: NewTrickLevelDoc = {
      trickId: level.trickId,
      rulesId,
      level: level.level,
      ...(level.verificationLevel
        ? { verificationLevel: level.verificationLevel, verifiedBy: level.verifiedBy, verifiedAt: updatedAt }
        : {}),
      ...(level.verifiedBy ? { updatedBy: level.verifiedBy } : {}),
      createdAt,
      changedAt: updatedAt
    }

    const newId = trickLevelId(level.trickId, rulesId)
    const existing = migrated.get(newId)
    if (!existing) {
      migrated.set(newId, { data, oldIds: [dSnap.id] })
      continue
    }

    dropped++
    const loser = isBetterLevel(data, existing.data) ? existing.data : data
    logger.warn({
      newId,
      trickId: loser.trickId,
      rulesId: loser.rulesId,
      level: loser.level,
      verificationLevel: loser.verificationLevel
    }, `Multiple levels map to ${newId}, dropping the one with level ${loser.level}`)
    if (loser === existing.data) existing.data = data
    existing.oldIds.push(dSnap.id)
  }

  if (unknownOrganisations.size > 0) {
    for (const [organisation, count] of unknownOrganisations) {
      logger.error({ organisation, levels: count }, `No rules ID mapping for organisation ${organisation}`)
    }
    throw new Error('Unknown organisation(s), add a rules ID mapping for them before running the migration')
  }

  // The rulesets that are needed, and the ones that already exist
  const rulesIds = [...new Set([...migrated.values()].map(({ data }) => data.rulesId))].sort((a, b) => a.localeCompare(b))
  const rQSnap = await rulesetsRef.get()
  const existingRulesets = new Map(rQSnap.docs.map(dSnap => [dSnap.id, dSnap.data() as Pick<RulesetDoc, 'isPrimary'>]))
  const hasPrimary = [...existingRulesets.values()].some(ruleset => ruleset.isPrimary)

  if (args.primary && !rulesIds.includes(args.primary) && !existingRulesets.has(args.primary)) {
    throw new Error(`The ruleset ${args.primary} given as --primary is neither an existing ruleset nor one of the rulesets this migration would create`)
  }
  const allRulesIds = [...new Set([...rulesIds, ...existingRulesets.keys()])]
  // no IJRU ruleset at all is unlikely, but we'd still rather have a primary
  // ruleset than none
  const primary = hasPrimary ? undefined : args.primary ?? newestIjruRulesId(allRulesIds) ?? allRulesIds[0]

  const newRulesets = rulesIds
    .filter(rulesId => !existingRulesets.has(rulesId))
    .map(rulesId => ({
      id: rulesId,
      names: { en: rulesetName(rulesId) },
      isPrimary: rulesId === primary
    }))
  // the primary ruleset may be one that already exists, in that case we only
  // flip its isPrimary flag and leave the rest of it alone
  const primaryUpdate = primary != null && existingRulesets.has(primary) ? primary : undefined

  logger.info({
    levels: qSnap.size,
    toMigrate: migrated.size,
    skipped,
    dropped,
    rulesets: rulesIds,
    newRulesets: newRulesets.map(ruleset => ruleset.id),
    primary,
    dryRun
  }, 'Found trick levels to migrate')

  if (dryRun) {
    for (const ruleset of newRulesets) {
      logger.info({ rulesId: ruleset.id, ...ruleset }, `[dry-run] would create ruleset ${ruleset.id}`)
    }
    if (primaryUpdate) logger.info({ rulesId: primaryUpdate }, `[dry-run] would make the existing ruleset ${primaryUpdate} primary`)
    for (const [newId, { data, oldIds }] of migrated) {
      logger.info({ newId, oldIds, ...data }, `[dry-run] would migrate ${oldIds.join(', ')} to ${newId}`)
    }
    return
  }

  let batch = firestore.batch()
  let operations = 0
  const commit = async () => {
    if (operations === 0) return
    await batch.commit()
    batch = firestore.batch()
    operations = 0
  }

  for (const ruleset of newRulesets) {
    const { id, ...data } = ruleset
    if (operations + 1 > BATCH_SIZE) await commit()
    batch.create(rulesetsRef.doc(id), data)
    operations++
  }
  if (primaryUpdate) {
    batch.update(rulesetsRef.doc(primaryUpdate), { isPrimary: true })
    operations++
  }
  await commit()
  logger.info({ rulesets: newRulesets.length, primary }, 'Created rulesets')

  let written = 0
  let deleted = 0
  for (const [newId, { data, oldIds }] of migrated) {
    // the new document ID could, in theory, be one of the old ones
    const staleIds = oldIds.filter(oldId => oldId !== newId)
    if (operations + 1 + staleIds.length > BATCH_SIZE) await commit()
    batch.set(levelsRef.doc(newId), data)
    written++
    operations++
    for (const oldId of staleIds) {
      batch.delete(levelsRef.doc(oldId))
      deleted++
      operations++
    }
  }
  await commit()

  logger.info({ written, deleted, skipped, dropped, rulesets: newRulesets.length }, 'Migration finished')
}

main()
  .then(() => {
    process.exit()
  })
  .catch(err => {
    logger.fatal(err)
    process.exit(1)
  })
