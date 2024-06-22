import algoliasearch from 'algoliasearch/lite'
import * as Sentry from '@sentry/node'
import { ALGOLIA_API_KEY, ALGOLIA_APP_ID, SENTRY_DSN } from '../config'
import { logger as baseLogger } from './logger'

import type Pino from 'pino'
import type { Discipline } from '../generated/graphql'

const client = algoliasearch(ALGOLIA_APP_ID as string, ALGOLIA_API_KEY as string)

export async function searchTricks (query: string, { discipline, lang = 'en', userId }: { discipline?: Discipline, lang?: string, userId?: string } = {}, { logger = baseLogger }: { logger?: Pino.Logger } = {}) {
  let transaction: any
  return await Sentry.startSpan({
    op: 'search',
    name: 'AlgoliaSearchTricks'
  }, async span => {
    const result = await client.initIndex(`tricktionary_${lang}`).search(query, {
      facetFilters: discipline ? `discipline:${discipline}` : undefined,
      hitsPerPage: 500,
      userToken: userId
    })

    if (transaction) transaction.finish()

    return result.hits
  })
}
