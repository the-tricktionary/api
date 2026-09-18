/**
 * Migration: create the `languages` collection from the languages that are
 * already in use.
 *
 * The API only accepts a language that has a `languages` document, so this
 * script collects every language the data already mentions:
 *
 *   1. the language suffix of every `trick-localisations` document ID
 *   2. the keys of the `names` of every ruleset
 *   3. the `lang` of every `Translator` grant on a user
 *
 * English is always included. A language that has at least one trick
 * localisation is created as `enabled: true`, every other one as
 * `enabled: false`, so that the public site keeps offering exactly the
 * languages it has content for. Languages that already have a document are
 * left alone, so the script is idempotent and can be re-run.
 *
 * Requirements:
 *   - GOOGLE_APPLICATION_CREDENTIALS pointing at a service account with write
 *     access to the `languages` collection
 *
 * Usage:
 *   npx tsx src/migrations/languages.ts [--dry-run]
 */
import '../config.js'
import { parseArgs } from 'node:util'
import { Firestore } from '@google-cloud/firestore'
import { logger } from '../services/logger.js'
import { trickLocalisationLang } from '../store/schema.js'
import { langSchema } from '../validation.js'

import { GrantType } from '../generated/graphql.js'

import type { RulesetDoc, TrickLocalisationDoc, UserDoc } from '../store/schema.js'

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false }
  }
})

const dryRun = args['dry-run']

const firestore = new Firestore()

/**
 * A localisation's document ID is `${trickId}-${lang}`, older documents don't
 * have the `trickId` field yet and both parts may contain dashes, so their
 * trick is the one prefix that we know a trick for.
 */
function localisationTrickId (id: string, trickId: string | undefined, trickIds: Set<string>) {
  if (trickId != null && trickIds.has(trickId)) return trickId
  let idx = id.indexOf('-')
  while (idx > 0) {
    const candidate = id.slice(0, idx)
    if (trickIds.has(candidate)) return candidate
    idx = id.indexOf('-', idx + 1)
  }
  return undefined
}

async function main () {
  const languagesRef = firestore.collection('languages')

  const [tQSnap, lQSnap, rQSnap, uQSnap, langQSnap] = await Promise.all([
    firestore.collection('tricks').get(),
    firestore.collection('trick-localisations').get(),
    firestore.collection('rulesets').get(),
    firestore.collection('users').get(),
    languagesRef.get()
  ])

  const trickIds = new Set(tQSnap.docs.map(dSnap => dSnap.id))

  const localised = new Set<string>()
  const mentioned = new Set<string>()
  const invalid = new Map<string, string>()
  const orphans: string[] = []

  function add (lang: string, source: string, localisation = false) {
    const parsed = langSchema.safeParse(lang)
    if (!parsed.success) {
      invalid.set(lang, source)
      return
    }
    mentioned.add(parsed.data)
    if (localisation) localised.add(parsed.data)
  }

  for (const dSnap of lQSnap.docs) {
    const localisation = dSnap.data() as TrickLocalisationDoc
    const trickId = localisationTrickId(dSnap.id, localisation.trickId, trickIds)
    const lang = trickId != null ? trickLocalisationLang(dSnap.id, trickId) : undefined
    if (lang == null) {
      orphans.push(dSnap.id)
      continue
    }
    add(lang, `trick localisation ${dSnap.id}`, true)
  }

  for (const dSnap of rQSnap.docs) {
    const ruleset = dSnap.data() as RulesetDoc
    for (const lang of Object.keys(ruleset.names ?? {})) add(lang, `ruleset ${dSnap.id}`)
  }

  for (const dSnap of uQSnap.docs) {
    const user = dSnap.data() as UserDoc
    for (const grant of user.grants ?? []) {
      if (grant.type === GrantType.Translator) add(grant.lang, `user ${dSnap.id}`)
    }
  }

  mentioned.add('en')
  localised.add('en')

  const existing = new Set(langQSnap.docs.map(dSnap => dSnap.id))
  const toCreate = [...mentioned]
    .filter(lang => !existing.has(lang))
    .sort((a, b) => a.localeCompare(b))
    .map(lang => ({ id: lang, enabled: localised.has(lang) }))

  logger.info({
    localisations: lQSnap.size,
    languages: mentioned.size,
    existing: [...existing].sort((a, b) => a.localeCompare(b)),
    toCreate: toCreate.map(language => language.id),
    dryRun
  }, 'Found languages to create')
  if (orphans.length > 0) {
    logger.warn({ orphans }, 'Some trick localisations do not belong to a known trick and are skipped')
  }
  for (const [lang, source] of invalid) {
    logger.warn({ lang, source }, `${lang} from ${source} is not a valid language tag and is skipped`)
  }

  if (dryRun) {
    for (const language of toCreate) {
      logger.info({ lang: language.id, enabled: language.enabled }, `[dry-run] would create language ${language.id} (enabled: ${language.enabled})`)
    }
    return
  }

  const batch = firestore.batch()
  for (const { id, ...data } of toCreate) batch.create(languagesRef.doc(id), data)
  if (toCreate.length > 0) await batch.commit()

  logger.info({ created: toCreate.map(language => language.id), skipped: existing.size }, 'Migration finished')
}

main()
  .then(() => {
    process.exit()
  })
  .catch(err => {
    logger.fatal(err)
    process.exit(1)
  })
