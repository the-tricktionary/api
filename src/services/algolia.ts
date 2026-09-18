import { liteClient } from 'algoliasearch/lite'
import * as Sentry from '@sentry/node'
import { ALGOLIA_API_KEY, ALGOLIA_APP_ID } from '../config'
import { logger as baseLogger } from './logger'

import type Pino from 'pino'
import type { Discipline } from '../generated/graphql'

const client = liteClient(ALGOLIA_APP_ID, ALGOLIA_API_KEY)

export async function searchTricks (query: string, { discipline, lang = 'en', userId }: { discipline?: Discipline, lang?: string, userId?: string } = {}, { logger = baseLogger }: { logger?: Pino.Logger } = {}) {
  return await Sentry.startSpan({
    op: 'search',
    name: 'AlgoliaSearchTricks'
  }, async () => {
    const { results } = await client.searchForHits<{ objectID: string }>({
      requests: [{
        indexName: `tricktionary_${lang}`,
        query,
        facetFilters: discipline ? [`discipline:${discipline}`] : undefined,
        hitsPerPage: 500,
        userToken: userId
      }]
    })

    return results[0]?.hits ?? []
  })
}
