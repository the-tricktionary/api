import { algoliasearch } from 'algoliasearch'
import * as Sentry from '@sentry/node'
import { ALGOLIA_API_KEY, ALGOLIA_APP_ID } from '../config'
import { logger as baseLogger } from './logger'
import { TRICKTIONARY_RULES_ID, trickLocalisationLang } from '../store/schema'

import type Pino from 'pino'
import type { IndexSettings, SupportedLanguage } from 'algoliasearch'
import type { Discipline } from '../generated/graphql'
import type { TrickDoc, TrickLocalisationDoc } from '../store/schema'
import type { DataSources } from '../store/firestoreDataSource'

const client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_API_KEY)

/** How long the list of indices fetched from Algolia is trusted */
const INDEX_LIST_TTL = 60 * 60 * 1000

/** Tricks are indexed once per language, `tricktionary_en` is the source one */
export function trickIndexName (lang: string) { return `tricktionary_${lang}` }

// the indices Algolia told us about the last time we asked, plus the ones this
// process has created since
const knownIndices = new Set<string>()
let indicesFetchedAt = 0
let indicesFetch: Promise<void> | undefined

// failures are logged rather than thrown, an index we don't know about is
// simply treated as one that doesn't exist yet
async function refreshKnownIndices ({ logger = baseLogger }: { logger?: Pino.Logger } = {}) {
  if (Date.now() - indicesFetchedAt < INDEX_LIST_TTL) return
  indicesFetch ??= (async () => {
    try {
      const { items } = await client.listIndices()
      for (const index of items) knownIndices.add(index.name)
    } catch (err) {
      logger.error(err, 'Could not list the Algolia indices')
      Sentry.captureException(err)
    } finally {
      // also on failure, so a broken API key doesn't make us retry per request
      indicesFetchedAt = Date.now()
      indicesFetch = undefined
    }
  })()
  await indicesFetch
}

// managed here rather than in the Algolia dashboard so a new language only
// needs a localisation
function trickIndexSettings (lang: string): IndexSettings {
  // Algolia only knows about a fixed list of languages, a tag it doesn't know
  // (or a region subtag) is passed through and ignored by the engine
  const languages = [lang as SupportedLanguage]
  return {
    searchableAttributes: ['unordered(name,alternativeNames)', 'unordered(enName,enAlternativeNames)', 'description'],
    attributesForFaceting: ['filterOnly(discipline)', 'filterOnly(trickType)'],
    customRanking: ['asc(ttLevel)'],
    indexLanguages: languages,
    queryLanguages: languages,
    ignorePlurals: languages,
    removeStopWords: false,
    alternativesAsExact: ['ignorePlurals', 'singleWordSynonym', 'multiWordsSynonym'],
    exactOnSingleWordQuery: 'attribute',
    removeWordsIfNoResults: 'allOptional',
    attributesToHighlight: []
  }
}

/** Applies the settings, creating the index if it doesn't exist */
export async function setTrickIndexSettings (lang: string) {
  const indexName = trickIndexName(lang)
  await client.setSettings({ indexName, indexSettings: trickIndexSettings(lang) })
  knownIndices.add(indexName)
  return indexName
}

interface TrickRecordInput {
  trick: Pick<TrickDoc, 'id' | 'slug' | 'discipline' | 'trickType'>
  lang: string
  localisation: Pick<TrickLocalisationDoc, 'name' | 'alternativeNames' | 'description'>
  /** the english localisation, its names are searchable in every language */
  enLocalisation?: Pick<TrickLocalisationDoc, 'name' | 'alternativeNames'>
  /** the trick's level in the `tricktionary` ruleset, e.g. `"5"` or `"2-5"` */
  level?: string | null
}

export function trickRecord ({ trick, lang, localisation, enLocalisation, level }: TrickRecordInput) {
  const ttLevel = level != null ? parseInt(level, 10) : NaN
  return {
    objectID: trick.id,
    slug: trick.slug,
    discipline: trick.discipline,
    trickType: trick.trickType,
    name: localisation.name,
    alternativeNames: localisation.alternativeNames ?? [],
    description: localisation.description ?? '',
    // the english index has the english names in `name` already
    ...(lang === 'en' || !enLocalisation
      ? {}
      : {
          enName: enLocalisation.name,
          enAlternativeNames: enLocalisation.alternativeNames ?? []
        }),
    ...(Number.isNaN(ttLevel) ? {} : { ttLevel })
  }
}

/** Writes records to a language index, creating and configuring it if needed */
export async function saveTrickRecords (lang: string, records: Array<ReturnType<typeof trickRecord>>, { logger = baseLogger }: { logger?: Pino.Logger } = {}) {
  if (records.length === 0) return
  await refreshKnownIndices({ logger })
  const indexName = knownIndices.has(trickIndexName(lang)) ? trickIndexName(lang) : await setTrickIndexSettings(lang)
  await client.saveObjects({ indexName, objects: records })
  logger.debug({ indexName, records: records.length }, 'Saved trick records to Algolia')
}

/** Reindexes a single trick in every language it has a localisation for */
async function indexTrick (trickId: string, { dataSources, logger = baseLogger }: { dataSources: DataSources, logger?: Pino.Logger }) {
  const [trick, localisations, levels] = await Promise.all([
    dataSources.tricks.findOneById(trickId),
    dataSources.trickLocalisations.findManyByQuery(c => c.where('trickId', '==', trickId)),
    dataSources.trickLevels.findManyByTrick({ trickId, rulesId: TRICKTIONARY_RULES_ID })
  ])

  if (!trick) {
    logger.warn({ trickId }, 'Not indexing a trick that does not exist')
    return
  }

  const level = levels[0]?.level
  const langs = new Map<string, TrickLocalisationDoc>()
  for (const localisation of localisations) {
    const lang = trickLocalisationLang(localisation.id, trickId)
    if (!lang) {
      logger.warn({ trickId, localisationId: localisation.id }, 'Could not determine the language of a trick localisation')
      continue
    }
    langs.set(lang, localisation)
  }

  const enLocalisation = langs.get('en')

  for (const [lang, localisation] of langs) {
    await saveTrickRecords(lang, [trickRecord({ trick, lang, localisation, enLocalisation, level })], { logger })
  }

  logger.info({ trickId, langs: [...langs.keys()] }, 'Indexed trick')
}

/**
 * Best effort: keeping the search index up to date must never fail the
 * mutation that changed the trick, so failures are logged and reported to
 * Sentry instead of thrown.
 */
export async function tryIndexTrick (trickId: string, { dataSources, logger = baseLogger }: { dataSources: DataSources, logger?: Pino.Logger }) {
  try {
    await indexTrick(trickId, { dataSources, logger })
  } catch (err) {
    logger.error(err, `Failed to index trick ${trickId} in Algolia`)
    Sentry.captureException(err)
  }
}

export async function searchTricks (query: string, { discipline, lang, userId }: { discipline?: Discipline, lang?: string, userId?: string } = {}, { logger = baseLogger }: { logger?: Pino.Logger } = {}) {
  return await Sentry.startSpan({
    op: 'search',
    name: 'AlgoliaSearchTricks'
  }, async () => {
    // tricks that aren't translated yet are missing from a language index, so
    // we only use one we know exists and fall back to the source language
    let indexName = trickIndexName('en')
    if (lang) {
      const langIndexName = trickIndexName(lang.toLowerCase())
      await refreshKnownIndices({ logger })
      if (knownIndices.has(langIndexName)) indexName = langIndexName
    }

    const { results } = await client.searchForHits<{ objectID: string }>({
      requests: [{
        indexName,
        query,
        facetFilters: discipline ? [`discipline:${discipline}`] : undefined,
        hitsPerPage: 500,
        attributesToRetrieve: ['objectID'],
        userToken: userId
      }]
    })

    return results[0]?.hits ?? []
  })
}
