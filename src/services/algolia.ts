import { algoliasearch } from 'algoliasearch'
import * as Sentry from '@sentry/node'
import { ALGOLIA_APP_ID } from '../config.js'
import { getSecret } from './secrets.js'
import { logger as baseLogger } from './logger.js'
import { TRICKTIONARY_RULES_ID, trickLocalisationLang } from '../store/schema.js'
import { tagSearchNames, trickTagValues } from '../helpers/tags.js'

import type Pino from 'pino'
import type { IndexSettings, SupportedLanguage } from 'algoliasearch'
import type { Discipline } from '../generated/graphql.js'
import type { TagDoc, TrickDoc, TrickLevelDoc, TrickLocalisationDoc } from '../store/schema.js'
import type { DataSources } from '../store/firestoreDataSource.js'

const client = algoliasearch(ALGOLIA_APP_ID, await getSecret('tricktionary-api-algolia-api-key'))

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
    searchableAttributes: ['unordered(name,alternativeNames)', 'unordered(enName,enAlternativeNames)', 'description', 'unordered(tagNames)'],
    // tag filters are applied by the API, see the tricks query
    attributesForFaceting: ['filterOnly(discipline)'],
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
  trick: Pick<TrickDoc, 'id' | 'slug' | 'discipline' | 'trickType' | 'tags'>
  lang: string
  localisation: Pick<TrickLocalisationDoc, 'name' | 'alternativeNames' | 'description'>
  /** the english localisation, its names are searchable in every language */
  enLocalisation?: Pick<TrickLocalisationDoc, 'name' | 'alternativeNames'>
  /** the trick's level in the `tricktionary` ruleset, e.g. `"5"` or `"2-5"` */
  level?: string | null
  /** at least the tags the trick carries */
  tags: ReadonlyMap<string, TagDoc>
}

function trickRecord ({ trick, lang, localisation, enLocalisation, level, tags }: TrickRecordInput) {
  const ttLevel = level != null ? parseInt(level, 10) : NaN
  return {
    objectID: trick.id,
    slug: trick.slug,
    discipline: trick.discipline,
    name: localisation.name,
    alternativeNames: localisation.alternativeNames ?? [],
    description: localisation.description ?? '',
    tagNames: tagSearchNames(trickTagValues(trick), tags, lang),
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
async function saveTrickRecords (lang: string, records: Array<ReturnType<typeof trickRecord>>, { logger = baseLogger }: { logger?: Pino.Logger } = {}) {
  if (records.length === 0) return
  await refreshKnownIndices({ logger })
  const indexName = knownIndices.has(trickIndexName(lang)) ? trickIndexName(lang) : await setTrickIndexSettings(lang)
  await client.saveObjects({ indexName, objects: records })
  logger.debug({ indexName, records: records.length }, 'Saved trick records to Algolia')
}

/** Firestore takes at most 30 values in an `in` filter */
const IN_CHUNK = 30

async function findLocalisations (trickIds: readonly string[], dataSources: DataSources) {
  const chunks: string[][] = []
  for (let idx = 0; idx < trickIds.length; idx += IN_CHUNK) chunks.push(trickIds.slice(idx, idx + IN_CHUNK))
  return (await Promise.all(chunks.map(async chunk => await dataSources.trickLocalisations.findManyByQuery(c => c.where('trickId', 'in', chunk))))).flat()
}

/** In every language the tricks have a localisation in, one write per language */
export async function indexTricks (trickIds: readonly string[], { dataSources, logger = baseLogger }: { dataSources: DataSources, logger?: Pino.Logger }) {
  const ids = [...new Set(trickIds)]
  if (ids.length === 0) return

  const [tricks, localisations, levels, tags] = await Promise.all([
    dataSources.tricks.findManyByIds(ids),
    findLocalisations(ids, dataSources),
    ids.length === 1
      ? dataSources.trickLevels.findManyByTrick({ trickId: ids[0], rulesId: TRICKTIONARY_RULES_ID })
      : dataSources.trickLevels.findManyByRuleset(TRICKTIONARY_RULES_ID),
    dataSources.tags.findAll({ ttl: 3600 })
  ])

  const tagsById = new Map(tags.map(tag => [tag.id, tag]))
  const levelByTrick = new Map<string, TrickLevelDoc>(levels.map(level => [level.trickId, level]))
  const localisationsByTrick = new Map<string, Map<string, TrickLocalisationDoc>>()
  for (const localisation of localisations) {
    const lang = trickLocalisationLang(localisation.id, localisation.trickId)
    if (!lang) {
      logger.warn({ trickId: localisation.trickId, localisationId: localisation.id }, 'Could not determine the language of a trick localisation')
      continue
    }
    let langs = localisationsByTrick.get(localisation.trickId)
    if (!langs) {
      langs = new Map()
      localisationsByTrick.set(localisation.trickId, langs)
    }
    langs.set(lang, localisation)
  }

  const recordsByLang = new Map<string, Array<ReturnType<typeof trickRecord>>>()
  for (const [idx, trick] of tricks.entries()) {
    if (!trick) {
      logger.warn({ trickId: ids[idx] }, 'Not indexing a trick that does not exist')
      continue
    }
    const langs = localisationsByTrick.get(trick.id) ?? new Map<string, TrickLocalisationDoc>()
    const enLocalisation = langs.get('en')
    const level = levelByTrick.get(trick.id)?.level
    for (const [lang, localisation] of langs) {
      let records = recordsByLang.get(lang)
      if (!records) {
        records = []
        recordsByLang.set(lang, records)
      }
      records.push(trickRecord({ trick, lang, localisation, enLocalisation, level, tags: tagsById }))
    }
  }

  for (const [lang, records] of recordsByLang) {
    await saveTrickRecords(lang, records, { logger })
  }

  logger.info({ trickIds: ids.length === 1 ? ids : undefined, tricks: ids.length, langs: [...recordsByLang.keys()] }, 'Indexed tricks')
}

/**
 * Best effort: keeping the search index up to date must never fail the
 * mutation that changed the trick, so failures are logged and reported to
 * Sentry instead of thrown.
 */
export async function tryIndexTrick (trickId: string, { dataSources, logger = baseLogger }: { dataSources: DataSources, logger?: Pino.Logger }) {
  try {
    await indexTricks([trickId], { dataSources, logger })
  } catch (err) {
    logger.error(err, `Failed to index trick ${trickId} in Algolia`)
    Sentry.captureException(err)
  }
}

/** Best effort, see `tryIndexTrick` */
export async function tryIndexTricks (trickIds: readonly string[], { dataSources, logger = baseLogger }: { dataSources: DataSources, logger?: Pino.Logger }) {
  try {
    await indexTricks(trickIds, { dataSources, logger })
  } catch (err) {
    logger.error(err, `Failed to index ${trickIds.length} tricks in Algolia`)
    Sentry.captureException(err)
  }
}

export async function searchTricks (query: string, { discipline, lang, userId }: { discipline?: Discipline, lang?: string, userId?: string } = {}, { logger = baseLogger }: { logger?: Pino.Logger } = {}) {
  return await Sentry.startSpan({
    op: 'search',
    name: 'AlgoliaSearchTricks'
  }, async () => {
    // a language index only holds the tricks translated into it, so the
    // english index is searched alongside it to cover the rest
    const indexNames = [trickIndexName('en')]
    if (lang) {
      const langIndexName = trickIndexName(lang.toLowerCase())
      await refreshKnownIndices({ logger })
      if (langIndexName !== indexNames[0] && knownIndices.has(langIndexName)) indexNames.unshift(langIndexName)
    }

    const { results } = await client.searchForHits<{ objectID: string }>({
      requests: indexNames.map(indexName => ({
        indexName,
        query,
        facetFilters: discipline ? [`discipline:${discipline}`] : undefined,
        hitsPerPage: 500,
        attributesToRetrieve: ['objectID'],
        userToken: userId
      }))
    })

    // language hits first, the english index fills in the rest
    return [...new Map(results.flatMap(result => result.hits).map(hit => [hit.objectID, hit])).values()]
  })
}
